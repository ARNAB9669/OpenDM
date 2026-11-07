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
    const accounts = [];
    const seenIds = new Set();

    function addAccount(id, username, token, pageId = null, tokenType = 'system_user') {
        const strId = String(id || '');
        if (!strId || seenIds.has(strId)) return;
        seenIds.add(strId);
        accounts.push({
            id: strId,
            username: username || strId,
            accessToken: token,
            pageId,
            tokenType
        });
    }

    // Strategy 1: Extract authorized target_ids from debug_token granular_scopes.
    // In Unified Login, Meta frequently returns empty for /me/assigned_instagram_accounts,
    // but the selected Instagram Account ID is guaranteed to be in the token's granular_scopes target_ids!
    try {
        const debugUrl = new URL(graphUrl('debug_token'));
        debugUrl.search = new URLSearchParams({
            input_token: accessToken,
            access_token: `${process.env.META_APP_ID || ''}|${process.env.META_APP_SECRET || ''}`
        });
        const debugRes = await readJson(await fetch(debugUrl, { signal: AbortSignal.timeout(15000) }));
        const granularScopes = debugRes.data?.granular_scopes || [];
        const targetIds = new Set();

        for (const gs of granularScopes) {
            if (Array.isArray(gs.target_ids)) {
                for (const tid of gs.target_ids) {
                    if (tid) targetIds.add(String(tid));
                }
            }
        }

        for (const targetId of targetIds) {
            try {
                const igUser = await graphGet(targetId, {
                    fields: 'id,username',
                    access_token: accessToken
                });
                if (igUser && igUser.id && igUser.username) {
                    addAccount(igUser.id, igUser.username, accessToken, null, 'system_user');
                }
            } catch (err) {
                console.warn(`Target ID ${targetId} inspection failed:`, err.message);
            }
        }

        if (accounts.length > 0) return accounts;
    } catch (error) {
        console.warn('debug_token granular_scopes check failed:', error.message);
    }

    // Strategy 2: Primary Unified Login endpoint (me/assigned_instagram_accounts)
    try {
        const assigned = await graphGet('me/assigned_instagram_accounts', {
            fields: 'id,username',
            access_token: accessToken
        });
        if (Array.isArray(assigned.data)) {
            for (const acc of assigned.data) {
                if (acc.id) {
                    addAccount(acc.id, acc.username, accessToken, null, 'system_user');
                }
            }
            if (accounts.length > 0) return accounts;
        }
    } catch (error) {
        console.warn('assigned_instagram_accounts check failed or skipped:', error.message);
    }

    // Strategy 3: Check business portfolio owned/assigned assets via client_business_id
    try {
        const me = await graphGet('me', {
            fields: 'id,client_business_id',
            access_token: accessToken
        });
        const businessId = me.client_business_id;
        if (businessId) {
            const endpoints = [
                `${businessId}/instagram_accounts`,
                `${businessId}/assigned_instagram_accounts`,
                `${businessId}/owned_instagram_accounts`
            ];
            for (const ep of endpoints) {
                try {
                    const res = await graphGet(ep, {
                        fields: 'id,username',
                        access_token: accessToken
                    });
                    if (Array.isArray(res.data)) {
                        for (const acc of res.data) {
                            if (acc.id) addAccount(acc.id, acc.username, accessToken, null, 'system_user');
                        }
                    }
                    if (accounts.length > 0) return accounts;
                } catch {
                    // Try next endpoint
                }
            }
        }
    } catch (error) {
        console.warn('client_business_id asset inspection failed:', error.message);
    }

    // Strategy 4: Fallback to Facebook Pages connection (/me/accounts)
    // Exchange for long-lived user token so the retrieved page access tokens are permanent
    const longLivedUserToken = await getLongLivedUserToken(accessToken);

    try {
        const pages = await graphGet('me/accounts', {
            fields: 'id,name,access_token,instagram_business_account{id,username}',
            access_token: longLivedUserToken
        });

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
                addAccount(
                    igAccount.id,
                    igAccount.username || page.name,
                    page.access_token,
                    String(page.id),
                    'page'
                );
            }
        }

        if (accounts.length > 0) return accounts;
    } catch (error) {
        console.warn('me/accounts fallback check failed:', error.message);
    }

    // Strategy 5: Direct /me check (if it was an Instagram-scoped user token)
    try {
        const directMe = await graphGet('me', {
            fields: 'id,username',
            access_token: accessToken
        });
        if (directMe && directMe.id && directMe.username) {
            addAccount(directMe.id, directMe.username, accessToken, null, 'instagram_user');
            if (accounts.length > 0) return accounts;
        }
    } catch (error) {
        console.warn('direct /me check failed:', error.message);
    }

    return accounts;
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
