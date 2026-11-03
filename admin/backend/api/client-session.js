import { activeWorkspaceForUser, requireUser } from './_auth.js';

export default async function handler(req, res) {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const user = await requireUser(req, res);
    if (!user) return;

    try {
        const membership = await activeWorkspaceForUser(user.id);
        if (!membership) return res.status(403).json({ error: 'No active invited workspace.' });
        return res.status(200).json({
            workspaceId: membership.workspace_id,
            workspaceName: membership.workspaces.name
        });
    } catch (error) {
        console.error('client session lookup error:', error);
        return res.status(500).json({ error: 'Could not load your workspace.' });
    }
}
