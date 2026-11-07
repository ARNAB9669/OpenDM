import { adminClient, activeWorkspaceForUser, requireUser } from './_auth.js';
import { createInstagramState, graphVersion, hashInstagramState, instagramRedirectUri, metaLoginConfigId } from './_instagram.js';

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

        const configId = metaLoginConfigId();

        const authorizeUrl = new URL(`https://www.facebook.com/${graphVersion()}/dialog/oauth`);
        const searchParams = {
            client_id: appId,
            redirect_uri: instagramRedirectUri(),
            response_type: 'code',
            // Require a fresh Meta login so the person connecting can choose
            // the Instagram account and its owning business portfolio again.
            prompt: 'login',
            state
        };

        // Use standard Facebook Login with explicit scopes.
        // This returns a USER access token (not a System User token), which cleanly
        // resolves the user's Facebook Page and linked Instagram account via /me/accounts
        // without hitting Meta Error 200 "Requires business_management".
        searchParams.scope = 'pages_show_list,pages_read_engagement,instagram_basic,instagram_manage_comments,instagram_manage_messages';

        authorizeUrl.search = new URLSearchParams(searchParams).toString();
        return res.status(200).json({ authorizeUrl: authorizeUrl.toString() });
    } catch (error) {
        console.error('Instagram connect setup failed:', error.message);
        return res.status(500).json({ error: 'Could not start Instagram connection. Check server configuration.' });
    }
}
