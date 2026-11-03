import { adminClient, requireUser } from './_auth.js';

export default async function handler(req, res) {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const user = await requireUser(req, res);
    if (!user) return;

    const { data: membership, error } = await adminClient()
        .from('workspace_members')
        .select('workspaces(name, status)')
        .eq('user_id', user.id)
        .limit(1)
        .maybeSingle();
    if (error || !membership || membership.workspaces?.status !== 'active') {
        return res.status(403).json({ error: 'No active invited workspace.' });
    }
    return res.status(200).json({ workspaceName: membership.workspaces.name });
}
