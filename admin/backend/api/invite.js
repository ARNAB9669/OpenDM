// admin/backend/api/invite.js
// POST { email, workspaceName } -> creates workspace, invites the user, emails them a magic link.
// Requires env vars (set in Vercel project settings, NOT committed):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY   <- admin key, server-only, NEVER exposed to frontend
//
// npm install @supabase/supabase-js   (run inside admin/backend)

import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } }
);

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { email, workspaceName } = req.body || {};

    if (!email || !workspaceName) {
        return res.status(400).json({ error: 'email and workspaceName are required' });
    }

    try {
        // 1. Create the workspace
        const { data: workspace, error: wsError } = await supabaseAdmin
            .from('workspaces')
            .insert({ name: workspaceName, status: 'active' })
            .select()
            .single();

        if (wsError) throw wsError;

        // 2. Invite the user by email — Supabase sends the magic-link email automatically
        const { data: invite, error: inviteError } = await supabaseAdmin.auth.admin.inviteUserByEmail(
            email,
            {
                data: { workspace_id: workspace.id }, // stashed in user metadata, read after they accept
                redirectTo: process.env.INVITE_REDIRECT_URL // e.g. https://yourapp.com/auth/callback
            }
        );

        if (inviteError) throw inviteError;

        // 3. Link the invited user to the workspace as owner
        const { error: memberError } = await supabaseAdmin
            .from('workspace_members')
            .insert({
                workspace_id: workspace.id,
                user_id: invite.user.id,
                role: 'owner'
            });

        if (memberError) throw memberError;

        return res.status(200).json({
            ok: true,
            workspaceId: workspace.id,
            userId: invite.user.id,
            message: `Invite emailed to ${email}`
        });
    } catch (err) {
        console.error('invite error:', err);
        return res.status(500).json({ error: err.message || 'Invite failed' });
    }
}