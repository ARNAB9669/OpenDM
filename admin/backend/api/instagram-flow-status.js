import { activeWorkspaceForUser, adminClient, requireUser } from './_auth.js';

export default async function handler(req, res) {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const user = await requireUser(req, res);
    if (!user) return;

    try {
        const membership = await activeWorkspaceForUser(user.id);
        if (!membership) return res.status(403).json({ error: 'No active invited workspace.' });
        const flowId = typeof req.query?.flowId === 'string' ? req.query.flowId : '';
        if (!/^[0-9a-f-]{36}$/i.test(flowId)) return res.status(400).json({ error: 'A valid flowId is required.' });

        const client = adminClient();
        const { data: flow, error: flowError } = await client.from('flows')
            .select('id, is_active, monitored_post_id')
            .eq('id', flowId)
            .maybeSingle();
        if (flowError) throw flowError;
        if (!flow) return res.status(404).json({ error: 'Automation not found.' });
        const { data: post, error: postError } = await client.from('monitored_posts')
            .select('connected_account_id')
            .eq('id', flow.monitored_post_id)
            .single();
        if (postError) throw postError;
        const { data: account, error: accountError } = await client.from('connected_accounts')
            .select('workspace_id')
            .eq('id', post.connected_account_id)
            .single();
        if (accountError) throw accountError;
        if (account.workspace_id !== membership.workspace_id) return res.status(404).json({ error: 'Automation not found.' });

        const events = [];
        for (let from = 0; ; from += 500) {
            const { data, error } = await client.from('comment_events')
                .select('dm_status, reply_status, error_detail')
                .eq('flow_id', flowId)
                .range(from, from + 499);
            if (error) throw error;
            events.push(...(data || []));
            if (!data || data.length < 500) break;
        }
        const delivered = events.filter((event) => event.dm_status === 'sent').length;
        const failed = events.filter((event) => event.dm_status === 'failed');
        const restricted = failed.filter((event) => /restrict|not allowed|permission|messaging window/i.test(event.error_detail || '')).length;
        const otherFailures = failed.length - restricted;
        const parts = [`${delivered} ${delivered === 1 ? 'person got' : 'people got'} their DM`];
        if (failed.length) {
            const reasons = [];
            if (restricted) reasons.push(`${restricted} failed: account restricts messages or permission`);
            if (otherFailures) reasons.push(`${otherFailures} failed for another reason`);
            parts.push(`${failed.length} failed (${reasons.join('; ')})`);
        } else {
            parts.push('no DM failures');
        }
        return res.status(200).json({
            flowId,
            isActive: flow.is_active,
            delivered,
            failed: failed.length,
            publicRepliesSent: events.filter((event) => event.reply_status === 'sent').length,
            summary: parts.join('. ') + '.'
        });
    } catch (error) {
        console.error('Instagram flow status handler failed:', error.message);
        return res.status(500).json({ error: 'Could not load automation status.' });
    }
}
