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

        // Use Instagram API Unified Login through the saved Login for Business
        // configuration. Ad accounts are optional; no ad account is requested here.
        const authorizeUrl = new URL(`https://www.facebook.com/${graphVersion()}/dialog/oauth`);
        authorizeUrl.search = new URLSearchParams({
            client_id: appId,
            redirect_uri: instagramRedirectUri(),
            config_id: configId,
            response_type: 'code',
            override_default_response_type: 'true',
            // Require a fresh Meta login so the person connecting can choose
            // the Instagram account and its owning business portfolio again.
            prompt: 'login',
            state
        }).toString();
        return res.status(200).json({ authorizeUrl: authorizeUrl.toString() });
    } catch (error) {
        console.error('Instagram connect setup failed:', error.message);
        return res.status(500).json({ error: 'Could not start Instagram connection. Check server configuration.' });
    }
}
