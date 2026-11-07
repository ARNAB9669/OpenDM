import { activeWorkspaceForUser, adminClient, requireUser } from './_auth.js';
import { graphUrl, graphVersion } from './_instagram.js';

export default async function handler(req, res) {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const user = await requireUser(req, res);
    if (!user) return;

    try {
        const membership = await activeWorkspaceForUser(user.id);
        if (!membership) return res.status(403).json({ error: 'No active invited workspace.' });
        const { data: account, error: accountError } = await adminClient()
            .from('connected_accounts')
            .select('id, ig_account_id, ig_username, token_expires_at, long_lived_token, monitored_posts(id, meta_post_id, flows(id, keyword_filter, reply_template, dm_template, dm_link, is_active))')
            .eq('workspace_id', membership.workspace_id)
            .limit(1)
            .maybeSingle();
        if (accountError) throw accountError;
        if (!account) return res.status(200).json({ connected: false, media: [] });

        const searchParams = new URLSearchParams({
            fields: 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp',
            limit: '24',
            access_token: account.long_lived_token
        }).toString();

        // 1. Try Facebook Graph API host
        let response = await fetch(`${graphUrl(`${account.ig_account_id}/media`)}?${searchParams}`, { signal: AbortSignal.timeout(15000) });
        let data = await response.json().catch(() => ({}));

        // 2. Try Instagram Graph API host if Facebook host failed
        if (!response.ok) {
            try {
                const igUrl = `https://graph.instagram.com/${graphVersion()}/${account.ig_account_id}/media?${searchParams}`;
                const igRes = await fetch(igUrl, { signal: AbortSignal.timeout(15000) });
                if (igRes.ok) {
                    response = igRes;
                    data = await igRes.json().catch(() => ({}));
                }
            } catch {}
        }

        if (!response.ok) {
            console.error('Instagram media request failed:', data.error?.message || response.status);
            // If the saved account ID is invalid (e.g. was a System User ID instead of an Instagram account node),
            // clean up the invalid row so the workspace returns to an unlinked state ready to connect cleanly.
            if (data.error?.code === 100 || data.error?.code === 190) {
                await adminClient().from('connected_accounts').delete().eq('id', account.id);
                return res.status(200).json({ connected: false, media: [] });
            }
            return res.status(502).json({ error: `Could not load Instagram posts: ${data.error?.message || response.status}` });
        }

        const configured = new Map((account.monitored_posts || []).map((post) => [
            post.meta_post_id,
            { monitoredPostId: post.id, flow: post.flows?.[0] || null }
        ]));
        return res.status(200).json({
            connected: true,
            account: {
                id: account.id,
                instagramUserId: account.ig_account_id,
                username: account.ig_username,
                expiresAt: account.token_expires_at
            },
            media: (data.data || []).map((item) => ({
                id: item.id,
                caption: item.caption || '',
                mediaType: item.media_type,
                imageUrl: item.media_type === 'VIDEO' ? (item.thumbnail_url || item.media_url) : item.media_url,
                permalink: item.permalink,
                timestamp: item.timestamp,
                configured: configured.get(item.id) || null
            }))
        });
    } catch (error) {
        console.error('Instagram media handler failed:', error.message);
        return res.status(500).json({ error: 'Could not load Instagram posts.' });
    }
}
