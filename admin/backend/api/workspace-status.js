import { adminClient, requireAdmin } from './_auth.js';

const allowedStatuses = new Set(['active', 'suspended', 'banned']);

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const admin = await requireAdmin(req, res);
    if (!admin) return;

    const { workspaceId, status } = req.body || {};
    if (typeof workspaceId !== 'string' || !/^[0-9a-f-]{36}$/i.test(workspaceId) || !allowedStatuses.has(status)) {
        return res.status(400).json({ error: 'A valid workspaceId and status are required.' });
    }

    try {
        const { data, error } = await adminClient()
            .from('workspaces')
            .update({ status })
            .eq('id', workspaceId)
            .select('id, status')
            .single();
        if (error) throw error;
        return res.status(200).json({ ok: true, workspace: data });
    } catch (error) {
        console.error('workspace status update error:', error);
        return res.status(500).json({ error: 'Could not update workspace status.' });
    }
}
