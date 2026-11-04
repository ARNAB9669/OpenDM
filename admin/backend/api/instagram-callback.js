import { adminClient, activeWorkspaceForUser } from './_auth.js';
import { graphUrl, hashInstagramState, instagramRedirectUri, parseInstagramState } from './_instagram.js';

function dashboardRedirect(res, result, reason = '') {
    const base = process.env.APP_URL?.replace(/\/+$/, '') || '';
    const query = new URLSearchParams({ instagram: result });
    if (reason) query.set('reason', reason.slice(0, 180));
    res.statusCode = 302;
    res.setHeader('Location', `${base}/app/dashboard/dashboard.html?${query}`);
    return res.end();
}

async function readJson(response) {
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        const message = data.error?.message || data.error_description || `Instagram returned HTTP ${response.status}`;
        throw new Error(message);
    }
    return data;
}

async function graphGet(path, params) {
    const url = new URL(graphUrl(path));
    url.search = new URLSearchParams(params).toString();
    return readJson(await fetch(url, { signal: AbortSignal.timeout(15000) }));
}

async function authorizedInstagramAccounts(accessToken) {
    const assigned = await graphGet('me/assigned_instagram_accounts', {
        fields: 'id,username',
        access_token: accessToken
    });
    return assigned.data || [];
}

export default async function handler(req, res) {
    if (req.method !== 'GET') return res.status(405).send('Method not allowed');
    const { code, state: stateValue, error: oauthError } = req.query || {};
    if (oauthError) return dashboardRedirect(res, 'error', 'Instagram authorization was cancelled.');

    try {
        if (typeof code !== 'string') throw new Error('Instagram did not return an authorization code.');
        const state = parseInstagramState(stateValue);
        if (!state) throw new Error('Instagram connection state is invalid or expired. Start again from your workspace.');

        const supabase = adminClient();
        const now = new Date().toISOString();
        const { data: consumed, error: consumeError } = await supabase
            .from('instagram_oauth_states')
            .update({ consumed_at: now })
            .eq('state_hash', hashInstagramState(stateValue))
            .eq('workspace_id', state.workspaceId)
            .eq('user_id', state.userId)
            .is('consumed_at', null)
            .gt('expires_at', now)
            .select('state_hash')
            .maybeSingle();
        if (consumeError) throw consumeError;
        if (!consumed) throw new Error('This Instagram connection link has already been used or expired. Start again.');

        const membership = await activeWorkspaceForUser(state.userId);
        if (!membership || membership.workspace_id !== state.workspaceId) {
            throw new Error('The account no longer has access to this workspace.');
        }

        const tokenUrl = new URL(graphUrl('oauth/access_token'));
        tokenUrl.search = new URLSearchParams({
            client_id: process.env.META_APP_ID || '',
            client_secret: process.env.META_APP_SECRET || '',
            redirect_uri: instagramRedirectUri(),
            code
        });
        const token = await readJson(await fetch(tokenUrl, { signal: AbortSignal.timeout(15000) }));
        if (!token.access_token) throw new Error('Meta did not return an access token.');

        // Unified Login returns a Business Integration System User token. The
        // authorized Instagram asset is discovered through the assigned-account edge.
        const availableAccounts = await authorizedInstagramAccounts(token.access_token);
        if (availableAccounts.length !== 1) {
            throw new Error(availableAccounts.length
                ? 'More than one Instagram account was authorized. Configure one account and reconnect.'
                : 'Meta did not expose the Instagram account to this Unified Login token. Reconnect and select the portfolio that owns the professional account. If it remains empty, this is a Meta Unified Login issue; do not create another ad account.');
        }
        const profile = availableAccounts[0];
        const instagramUserId = String(profile.id || '');
        if (!instagramUserId || !profile.username) throw new Error('Meta did not return an Instagram account ID and username.');

        const { error: saveError } = await supabase.from('connected_accounts').upsert({
            workspace_id: state.workspaceId,
            platform: 'instagram',
            ig_account_id: instagramUserId,
            ig_username: profile.username,
            long_lived_token: token.access_token,
            // Unified Login can issue never-expiring system-user tokens. Null means no scheduled expiry (revocation is still possible).
            token_expires_at: Number(token.expires_in) > 0
                ? new Date(Date.now() + Number(token.expires_in) * 1000).toISOString()
                : null
        }, { onConflict: 'workspace_id,ig_account_id' });
        if (saveError) throw saveError;

        // Subscribe this account to comment webhooks. The app-level webhook URL
        // and the `comments` field still need to be configured in Meta.
        const subscribeUrl = new URL(graphUrl(`${instagramUserId}/subscribed_apps`));
        subscribeUrl.search = new URLSearchParams({ access_token: token.access_token }).toString();
        const subscribeBody = new URLSearchParams({ subscribed_fields: 'comments' });
        let webhookWarning = '';
        try {
            await readJson(await fetch(subscribeUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: subscribeBody,
                signal: AbortSignal.timeout(15000)
            }));
        } catch (error) {
            console.error('Instagram account webhook subscription failed:', error.message);
            webhookWarning = 'webhook';
        }

        return dashboardRedirect(res, webhookWarning ? 'connected-warning' : 'connected');
    } catch (error) {
        console.error('Instagram OAuth callback failed:', error.message);
        return dashboardRedirect(res, 'error', error.message || 'Instagram connection failed.');
    }
}
