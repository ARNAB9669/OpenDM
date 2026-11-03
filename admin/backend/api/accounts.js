import { adminClient, requireAdmin } from './_auth.js';

const PAGE_SIZE = 500;

async function getAllWorkspaces(client) {
    const rows = [];
    for (let from = 0; ; from += PAGE_SIZE) {
        const { data, error } = await client
            .from('workspaces')
            .select(`
                id, name, status, created_at,
                workspace_members(user_id, role),
                connected_accounts(id, platform, ig_account_id, connected_at, monitored_posts(id))
            `)
            .order('created_at', { ascending: false })
            .range(from, from + PAGE_SIZE - 1);
        if (error) throw error;
        rows.push(...(data || []));
        if (!data || data.length < PAGE_SIZE) return rows;
    }
}

async function getAllRows(client, table, columns) {
    const rows = [];
    for (let from = 0; ; from += PAGE_SIZE) {
        const { data, error } = await client.from(table).select(columns).range(from, from + PAGE_SIZE - 1);
        if (error) throw error;
        rows.push(...(data || []));
        if (!data || data.length < PAGE_SIZE) return rows;
    }
}

async function getUserEmails(client, userIds) {
    const users = new Map();
    const pageSize = 1000;
    for (let page = 1; ; page++) {
        const { data, error } = await client.auth.admin.listUsers({ page, perPage: pageSize });
        if (error) throw error;
        for (const user of data.users) {
            if (userIds.has(user.id)) users.set(user.id, user.email || '');
        }
        if (data.users.length < pageSize || users.size === userIds.size) return users;
    }
}

export default async function handler(req, res) {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const admin = await requireAdmin(req, res);
    if (!admin) return;

    try {
        const client = adminClient();
        const [workspaces, flows] = await Promise.all([
            getAllWorkspaces(client),
            getAllRows(client, 'flows', 'id, is_active, monitored_posts!inner(id, connected_account_id)')
        ]);
        const workspaceByAccount = new Map();
        for (const workspace of workspaces) {
            for (const account of workspace.connected_accounts || []) workspaceByAccount.set(account.id, workspace.id);
        }
        const flowWorkspace = new Map();
        for (const flow of flows) {
            const accountId = flow.monitored_posts?.connected_account_id;
            const workspaceId = workspaceByAccount.get(accountId);
            if (workspaceId) flowWorkspace.set(flow.id, { workspaceId, isActive: flow.is_active });
        }
        const events = await getAllRows(client, 'comment_events', 'id, flow_id, reply_status, dm_status');
        const activityByWorkspace = new Map();
        for (const event of events) {
            const flow = flowWorkspace.get(event.flow_id);
            if (!flow) continue;
            const activity = activityByWorkspace.get(flow.workspaceId) || { comments: 0, activeFlows: 0, failedReplies: 0, failedDms: 0 };
            activity.comments++;
            if (event.reply_status === 'failed') activity.failedReplies++;
            if (event.dm_status === 'failed') activity.failedDms++;
            activityByWorkspace.set(flow.workspaceId, activity);
        }
        for (const flow of flows) {
            if (!flow.is_active) continue;
            const workspaceId = workspaceByAccount.get(flow.monitored_posts?.connected_account_id);
            if (!workspaceId) continue;
            const activity = activityByWorkspace.get(workspaceId) || { comments: 0, activeFlows: 0, failedReplies: 0, failedDms: 0 };
            activity.activeFlows++;
            activityByWorkspace.set(workspaceId, activity);
        }

        const userIds = new Set(workspaces.flatMap((workspace) =>
            (workspace.workspace_members || []).map((member) => member.user_id)
        ));
        const emails = await getUserEmails(client, userIds);
        const accounts = workspaces.map((workspace) => {
            const connectedAccounts = (workspace.connected_accounts || []).map((account) => ({
                id: account.id,
                platform: account.platform,
                igAccountId: account.ig_account_id,
                connectedAt: account.connected_at,
                monitoredPostCount: (account.monitored_posts || []).length
            }));
            return {
                id: workspace.id,
                name: workspace.name,
                status: workspace.status,
                createdAt: workspace.created_at,
                activity: activityByWorkspace.get(workspace.id) || { comments: 0, activeFlows: 0, failedReplies: 0, failedDms: 0 },
                members: (workspace.workspace_members || []).map((member) => ({
                    email: emails.get(member.user_id) || 'Email unavailable',
                    role: member.role
                })),
                connectedAccounts
            };
        });

        return res.status(200).json({
            workspaces: accounts,
            stats: {
                totalWorkspaces: accounts.length,
                activeWorkspaces: accounts.filter((item) => item.status === 'active').length,
                connectedAccounts: accounts.reduce((sum, item) => sum + item.connectedAccounts.length, 0),
                commentsProcessed: events.length
            }
        });
    } catch (error) {
        console.error('admin accounts error:', error);
        return res.status(500).json({ error: 'Could not load workspace data.' });
    }
}
