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

async function getLongLivedUserToken(accessToken) {
    try {
        const exchangeUrl = new URL(graphUrl('oauth/access_token'));
        exchangeUrl.search = new URLSearchParams({
            grant_type: 'fb_exchange_token',
            client_id: process.env.META_APP_ID || '',
            client_secret: process.env.META_APP_SECRET || '',
            fb_exchange_token: accessToken
        });
        const data = await readJson(await fetch(exchangeUrl, { signal: AbortSignal.timeout(15000) }));
        return data.access_token || accessToken;
    } catch {
        return accessToken;
    }
}

async function authorizedInstagramAccounts(accessToken) {
    // 1. Primary path: Instagram API with Unified Login / Business Integration System User asset check
    try {
        const assigned = await graphGet('me/assigned_instagram_accounts', {
            fields: 'id,username',
            access_token: accessToken
        });
        if (Array.isArray(assigned.data) && assigned.data.length > 0) {
            return assigned.data.map((acc) => ({
                id: String(acc.id),
                username: acc.username,
                accessToken, // Unified Login System-User token is authorized across all assigned assets
                pageId: null,
                tokenType: 'system_user'
            }));
        }
    } catch (error) {
        console.warn('assigned_instagram_accounts check failed or skipped:', error.message);
    }

    // 2. Fallback path: Classic Facebook Pages connection (/me/accounts)
    // Exchange for long-lived user token so the retrieved page access tokens are permanent
    const longLivedUserToken = await getLongLivedUserToken(accessToken);

    try {
        const pages = await graphGet('me/accounts', {
            fields: 'id,name,access_token,instagram_business_account{id,username}',
            access_token: longLivedUserToken
        });

        const accounts = [];
        for (const page of pages.data || []) {
            let igAccount = page.instagram_business_account;

            // If instagram_business_account was not expanded on /me/accounts, try checking the page directly
            if (!igAccount?.id && page.id && page.access_token) {
                try {
                    const pageDetail = await graphGet(page.id, {
                        fields: 'instagram_business_account{id,username}',
                        access_token: page.access_token
                    });
                    igAccount = pageDetail.instagram_business_account;
                } catch {
                    // Ignore page-level lookup error and continue
                }
            }

            if (igAccount?.id) {
                accounts.push({
                    id: String(igAccount.id),
                    username: igAccount.username || page.name,
                    accessToken: page.access_token, // Crucial: per-page access token for Graph API calls
                    pageId: String(page.id),
                    tokenType: 'page'
                });
            }
        }

        if (accounts.length > 0) {
            return accounts;
        }
    } catch (error) {
        console.warn('me/accounts fallback check failed:', error.message);
    }

    return [];
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

        // Discovers authorized Instagram account via Unified Login or Facebook Page link
        const availableAccounts = await authorizedInstagramAccounts(token.access_token);
        if (!availableAccounts.length) {
            throw new Error('Meta did not return any connected Instagram Professional Account. Ensure your Instagram account is a Professional (Business or Creator) account, connected to a Facebook Page or claimed in your Meta Business Portfolio, and authorized during login.');
        }

        const profile = availableAccounts[0];
        const instagramUserId = String(profile.id || '');
        if (!instagramUserId || !profile.username) throw new Error('Meta did not return an Instagram account ID and username.');

        // Token expiry:
        // Page access tokens obtained from long-lived user tokens do not expire (expires_at is null).
        // System user tokens from Unified Login also have no expiry or long expiry.
        // If a finite expires_in was returned on the token exchange, calculate expiry.
        let expiresAt = null;
        if (profile.tokenType !== 'page' && Number(token.expires_in) > 0) {
            expiresAt = new Date(Date.now() + Number(token.expires_in) * 1000).toISOString();
        }

        const { error: saveError } = await supabase.from('connected_accounts').upsert({
            workspace_id: state.workspaceId,
            platform: 'instagram',
            ig_account_id: instagramUserId,
            ig_username: profile.username,
            page_id: profile.pageId || null,
            long_lived_token: profile.accessToken,
            token_expires_at: expiresAt
        }, { onConflict: 'workspace_id,ig_account_id' });
        if (saveError) throw saveError;

        // Subscribe this account to comment webhooks using the per-account token.
        const subscribeUrl = new URL(graphUrl(`${instagramUserId}/subscribed_apps`));
        subscribeUrl.search = new URLSearchParams({ access_token: profile.accessToken }).toString();
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
            // If page-backed, also try subscribing the Page for feed/comment updates
            if (profile.pageId) {
                try {
                    const pageSubUrl = new URL(graphUrl(`${profile.pageId}/subscribed_apps`));
                    pageSubUrl.search = new URLSearchParams({ access_token: profile.accessToken }).toString();
                    await readJson(await fetch(pageSubUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                        body: new URLSearchParams({ subscribed_fields: 'feed' }),
                        signal: AbortSignal.timeout(15000)
                    }));
                } catch (pageError) {
                    console.error('Page webhook subscription also failed:', pageError.message);
                    webhookWarning = 'webhook';
                }
            } else {
                webhookWarning = 'webhook';
            }
        }

        return dashboardRedirect(res, webhookWarning ? 'connected-warning' : 'connected');
    } catch (error) {
        console.error('Instagram OAuth callback failed:', error.message);
        return dashboardRedirect(res, 'error', error.message || 'Instagram connection failed.');
    }
}
