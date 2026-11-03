import { requireAdmin } from './_auth.js';

export default async function handler(req, res) {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const user = await requireAdmin(req, res);
    if (!user) return;
    return res.status(200).json({ email: user.email });
}
