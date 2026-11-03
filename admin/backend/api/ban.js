// admin/backend/api/ban.js
// POST { workspaceId, status } where status is 'active' | 'suspended' | 'banned'
// Same env vars as invite.js.

import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

const VALID_STATUSES = ['active', 'suspended', 'banned'];

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { workspaceId, status } = req.body || {};

  if (!workspaceId || !VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: 'workspaceId and a valid status are required' });
  }

  const { data, error } = await supabaseAdmin
    .from('workspaces')
    .update({ status })
    .eq('id', workspaceId)
    .select()
    .single();

  if (error) {
    console.error('ban/status error:', error);
    return res.status(500).json({ error: error.message });
  }

  return res.status(200).json({ ok: true, workspace: data });
}