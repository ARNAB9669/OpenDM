import { activeWorkspaceForUser, adminClient, requireUser } from './_auth.js';
import { graphVersion } from './_instagram.js';

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

        const url = new URL(`https://graph.instagram.com/${graphVersion()}/me/media`);
        url.search = new URLSearchParams({
            fields: 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp',
            limit: '24',
            access_token: account.long_lived_token
        }).toString();
        const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            console.error('Instagram media request failed:', data.error?.message || response.status);
            return res.status(502).json({ error: 'Could not load Instagram posts. The connection may need to be renewed.' });
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
