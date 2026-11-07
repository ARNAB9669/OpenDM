import { adminClient, activeWorkspaceForUser } from './_auth.js';
import { graphUrl, graphVersion, hashInstagramState, instagramRedirectUri, parseInstagramState } from './_instagram.js';

function dashboardRedirect(res, result, reason = '') {
    const base = process.env.APP_URL?.replace(/\/+$/, '') || '';
    const query = new URLSearchParams({ instagram: result });
    if (reason) query.set('reason', reason.slice(0, 500));
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

async function authorizedInstagramAccounts(accessToken, debugLogs = []) {
    const accounts = [];
    const seenIds = new Set();

    function addAccount(id, username, token, pageId = null, tokenType = 'system_user') {
        const strId = String(id || '');
        if (!strId || seenIds.has(strId)) return;
        seenIds.add(strId);
        accounts.push({
            id: strId,
            username: username || `ig_${strId.slice(-4)}`,
            accessToken: token,
            pageId,
            tokenType
        });
    }

    // ── Strategy 1: debug_token granular_scopes inspection ──
    try {
        const debugUrl = new URL(graphUrl('debug_token'));
        debugUrl.search = new URLSearchParams({
            input_token: accessToken,
            access_token: `${process.env.META_APP_ID || ''}|${process.env.META_APP_SECRET || ''}`
        });
        const debugRes = await readJson(await fetch(debugUrl, { signal: AbortSignal.timeout(15000) }));
        const dData = debugRes.data || {};
        const granular = dData.granular_scopes || [];
        debugLogs.push(`dbg: valid=${dData.is_valid} type=${dData.type} scopes=${(dData.scopes || []).join(',')}`);

        const targetIds = new Set();
        for (const gs of granular) {
            if (Array.isArray(gs.target_ids)) {
                for (const tid of gs.target_ids) if (tid) targetIds.add(String(tid));
            }
        }

        debugLogs.push(`targets:[${Array.from(targetIds).join(',')}]`);

        for (const targetId of targetIds) {
            let foundUsername = null;

            // 1. Try Facebook Graph API for name (avoids cannot_access_user_username error on Facebook host)
            try {
                const fbNameRes = await graphGet(targetId, { fields: 'id,name', access_token: accessToken });
                if (fbNameRes.name) foundUsername = fbNameRes.name;
            } catch (e) {
                debugLogs.push(`t_${targetId}_name_err:${e.message.slice(0, 35)}`);
            }

            // 2. Try Instagram Graph API endpoint for username
            if (!foundUsername) {
                try {
                    const igUrl = new URL(`https://graph.instagram.com/${graphVersion()}/${targetId}`);
                    igUrl.search = new URLSearchParams({ fields: 'id,username', access_token: accessToken }).toString();
                    const igRes = await readJson(await fetch(igUrl, { signal: AbortSignal.timeout(10000) }));
                    if (igRes.username) foundUsername = igRes.username;
                } catch (e) {
                    debugLogs.push(`t_${targetId}_ig_err:${e.message.slice(0, 35)}`);
                }
            }

            // Always register the authorized target_id even if name/username lookup had an issue
            if (targetId) {
                addAccount(targetId, foundUsername || 'instagram_account', accessToken, null, 'system_user');
            }
        }

        if (accounts.length > 0) return accounts;
    } catch (error) {
        debugLogs.push(`dbg_err:${error.message.slice(0, 45)}`);
    }

    // ── Strategy 2: graph.instagram.com/me ──
    try {
        const igMeUrl = new URL(`https://graph.instagram.com/${graphVersion()}/me`);
        igMeUrl.search = new URLSearchParams({ fields: 'id,username,user_id', access_token: accessToken }).toString();
        const igMe = await readJson(await fetch(igMeUrl, { signal: AbortSignal.timeout(10000) }));
        const igId = igMe.user_id || igMe.id;
        if (igId) {
            addAccount(igId, igMe.username, accessToken, null, 'instagram_user');
            return accounts;
        }
    } catch (error) {
        debugLogs.push(`ig_me_err:${error.message.slice(0, 35)}`);
    }

    // ── Strategy 3: me/assigned_instagram_accounts ──
    try {
        const assigned = await graphGet('me/assigned_instagram_accounts', {
            fields: 'id,username',
            access_token: accessToken
        });
        if (Array.isArray(assigned.data) && assigned.data.length > 0) {
            for (const acc of assigned.data) {
                if (acc.id) addAccount(acc.id, acc.username, accessToken, null, 'system_user');
            }
            if (accounts.length > 0) return accounts;
        }
        debugLogs.push(`assigned_cnt:${assigned.data?.length ?? 0}`);
    } catch (error) {
        debugLogs.push(`assigned_err:${error.message.slice(0, 35)}`);
    }

    // ── Strategy 4: client_business_id ──
    try {
        const me = await graphGet('me', { fields: 'id,client_business_id', access_token: accessToken });
        if (me.client_business_id) {
            debugLogs.push(`biz:${me.client_business_id}`);
            const endpoints = [
                `${me.client_business_id}/instagram_accounts`,
                `${me.client_business_id}/instagram_business_accounts`,
                `${me.client_business_id}/assigned_instagram_accounts`,
                `${me.client_business_id}/owned_instagram_accounts`
            ];
            for (const ep of endpoints) {
                try {
                    const res = await graphGet(ep, { fields: 'id,username', access_token: accessToken });
                    if (Array.isArray(res.data) && res.data.length > 0) {
                        for (const acc of res.data) {
                            if (acc.id) addAccount(acc.id, acc.username, accessToken, null, 'system_user');
                        }
                    }
                    if (accounts.length > 0) return accounts;
                } catch (e) {
                    debugLogs.push(`${ep}_err:${e.message.slice(0, 25)}`);
                }
            }
        }
    } catch (error) {
        debugLogs.push(`me_err:${error.message.slice(0, 35)}`);
    }

    // ── Strategy 5: Facebook Pages (/me/accounts) ──
    try {
        const longLivedUserToken = await getLongLivedUserToken(accessToken);
        const pages = await graphGet('me/accounts', {
            fields: 'id,name,access_token,instagram_business_account{id,username}',
            access_token: longLivedUserToken
        });
        debugLogs.push(`pages_cnt:${pages.data?.length ?? 0}`);
        for (const page of pages.data || []) {
            let igAccount = page.instagram_business_account;
            if (!igAccount?.id && page.id && page.access_token) {
                try {
                    const pageDetail = await graphGet(page.id, {
                        fields: 'instagram_business_account{id,username}',
                        access_token: page.access_token
                    });
                    igAccount = pageDetail.instagram_business_account;
                } catch {}
            }
            if (igAccount?.id) {
                addAccount(igAccount.id, igAccount.username || page.name, page.access_token, String(page.id), 'page');
            }
        }
        if (accounts.length > 0) return accounts;
    } catch (error) {
        debugLogs.push(`pages_err:${error.message.slice(0, 35)}`);
    }

    // ── Strategy 6: Direct /me check ──
    try {
        const directMe = await graphGet('me', { fields: 'id,username', access_token: accessToken });
        if (directMe.id && directMe.username) {
            addAccount(directMe.id, directMe.username, accessToken, null, 'instagram_user');
            if (accounts.length > 0) return accounts;
        }
    } catch (error) {
        debugLogs.push(`direct_me_err:${error.message.slice(0, 35)}`);
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
        const debugLogs = [];
        const availableAccounts = await authorizedInstagramAccounts(token.access_token, debugLogs);
        if (!availableAccounts.length) {
            const needsBiz = debugLogs.some(l => l.includes('Requires business_management'));
            if (needsBiz) {
                throw new Error('Meta requires the "business_management" permission on your configuration to read portfolio Instagram accounts. Please add "business_management" to your Login for Business configuration in the Meta App Dashboard.');
            }
            throw new Error(`Diagnostic info: ${debugLogs.join(' | ').slice(0, 450)}`);
        }

        const profile = availableAccounts[0];
        const instagramUserId = String(profile.id || '');
        if (!instagramUserId || !profile.username) throw new Error('Meta did not return an Instagram account ID and username.');

        // Token expiry:
        // System user and page access tokens do not expire, but legacy database schema
        // may have a NOT NULL constraint on token_expires_at. Default to 10 years if no expiry given.
        const expiresInSec = Number(token.expires_in);
        const expiresAt = Number.isFinite(expiresInSec) && expiresInSec > 0
            ? new Date(Date.now() + expiresInSec * 1000).toISOString()
            : new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000).toISOString();

        const { error: saveError } = await supabase.from('connected_accounts').upsert({
            workspace_id: state.workspaceId,
            platform: 'instagram',
            ig_account_id: instagramUserId,
            ig_username: profile.username,
            // Fall back to instagramUserId in case the live database table still has a NOT NULL constraint on page_id
            page_id: profile.pageId || instagramUserId,
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
