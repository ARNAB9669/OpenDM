import { adminClient, activeWorkspaceForUser, requireUser } from './_auth.js';
import { createInstagramState, hashInstagramState, instagramRedirectUri } from './_instagram.js';

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const user = await requireUser(req, res);
    if (!user) return;

    try {
        const appId = process.env.META_APP_ID;
        if (!appId) throw new Error('Missing required server environment variable: META_APP_ID');
        const membership = await activeWorkspaceForUser(user.id);
        if (!membership) return res.status(403).json({ error: 'No active invited workspace.' });

        const { value: state, expiresAt } = createInstagramState(membership.workspace_id, user.id);
        const client = adminClient();
        const { error: cleanupError } = await client.from('instagram_oauth_states').delete().lt('expires_at', new Date().toISOString());
        if (cleanupError) throw cleanupError;
        const { error } = await client.from('instagram_oauth_states').insert({
            state_hash: hashInstagramState(state),
            workspace_id: membership.workspace_id,
            user_id: user.id,
            expires_at: expiresAt
        });
        if (error) throw error;

        const authorizeUrl = new URL('https://www.instagram.com/oauth/authorize');
        authorizeUrl.search = new URLSearchParams({
            client_id: appId,
            redirect_uri: instagramRedirectUri(),
            response_type: 'code',
            scope: 'instagram_business_basic,instagram_business_manage_messages,instagram_business_manage_comments',
            state
        }).toString();
        return res.status(200).json({ authorizeUrl: authorizeUrl.toString() });
    } catch (error) {
        console.error('Instagram connect setup failed:', error.message);
        return res.status(500).json({ error: 'Could not start Instagram connection. Check server configuration.' });
    }
}
