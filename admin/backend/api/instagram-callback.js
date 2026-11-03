import { adminClient, activeWorkspaceForUser } from './_auth.js';
import { graphVersion, hashInstagramState, instagramRedirectUri, parseInstagramState } from './_instagram.js';

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

        const form = new URLSearchParams({
            client_id: process.env.META_APP_ID || '',
            client_secret: process.env.META_APP_SECRET || '',
            grant_type: 'authorization_code',
            redirect_uri: instagramRedirectUri(),
            code
        });
        const shortToken = await readJson(await fetch('https://api.instagram.com/oauth/access_token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: form,
            signal: AbortSignal.timeout(15000)
        }));
        if (!shortToken.access_token) throw new Error('Instagram did not return an access token.');

        const longUrl = new URL('https://graph.instagram.com/access_token');
        longUrl.search = new URLSearchParams({
            grant_type: 'ig_exchange_token',
            client_secret: process.env.META_APP_SECRET || '',
            access_token: shortToken.access_token
        }).toString();
        const longToken = await readJson(await fetch(longUrl, { signal: AbortSignal.timeout(15000) }));
        if (!longToken.access_token) throw new Error('Instagram did not return a long-lived access token.');

        const profileUrl = new URL(`https://graph.instagram.com/${graphVersion()}/me`);
        profileUrl.search = new URLSearchParams({ fields: 'user_id,username', access_token: longToken.access_token }).toString();
        let profile;
        try {
            profile = await readJson(await fetch(profileUrl, { signal: AbortSignal.timeout(15000) }));
        } catch {
            profileUrl.searchParams.set('fields', 'id,username');
            profile = await readJson(await fetch(profileUrl, { signal: AbortSignal.timeout(15000) }));
        }
        const instagramUserId = String(profile.user_id || profile.id || longToken.user_id || shortToken.user_id || '');
        if (!instagramUserId || !profile.username) throw new Error('Instagram profile response did not include an account ID and username.');

        const expiresIn = Number(longToken.expires_in) || 60 * 24 * 60 * 60;
        const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
        const { error: saveError } = await supabase.from('connected_accounts').upsert({
            workspace_id: state.workspaceId,
            platform: 'instagram',
            ig_account_id: instagramUserId,
            ig_username: profile.username,
            long_lived_token: longToken.access_token,
            token_expires_at: expiresAt
        }, { onConflict: 'workspace_id,ig_account_id' });
        if (saveError) throw saveError;

        // Subscribe this account to comment webhooks. The app-level webhook URL
        // and the `comments` field still need to be configured in Meta.
        const subscribeUrl = new URL(`https://graph.instagram.com/${graphVersion()}/me/subscribed_apps`);
        subscribeUrl.search = new URLSearchParams({ access_token: longToken.access_token }).toString();
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
