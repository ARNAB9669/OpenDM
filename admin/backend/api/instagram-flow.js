import { activeWorkspaceForUser, adminClient, requireUser } from './_auth.js';
import { graphVersion } from './_instagram.js';

async function getContext(userId) {
    const membership = await activeWorkspaceForUser(userId);
    if (!membership) return { error: 'No active invited workspace.' };
    const { data: account, error } = await adminClient()
        .from('connected_accounts')
        .select('id, long_lived_token')
        .eq('workspace_id', membership.workspace_id)
        .limit(1)
        .maybeSingle();
    if (error) throw error;
    if (!account) return { error: 'Connect an Instagram account first.' };
    return { workspaceId: membership.workspace_id, account };
}

async function ensureOwnedMedia(account, mediaId) {
    const url = new URL(`https://graph.instagram.com/${graphVersion()}/${encodeURIComponent(mediaId)}`);
    url.search = new URLSearchParams({ fields: 'id', access_token: account.long_lived_token }).toString();
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || String(data.id) !== mediaId) {
        const error = new Error('That post is not available on the connected Instagram account.');
        error.statusCode = 400;
        throw error;
    }
}

async function getOrCreateMonitoredPost(client, accountId, mediaId) {
    const { data, error } = await client.from('monitored_posts').upsert({
        connected_account_id: accountId,
        meta_post_id: mediaId
    }, { onConflict: 'connected_account_id,meta_post_id' }).select('id').single();
    if (error) throw error;
    return data;
}

export default async function handler(req, res) {
    if (!['POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
    const user = await requireUser(req, res);
    if (!user) return;

    try {
        const context = await getContext(user.id);
        if (context.error) return res.status(403).json({ error: context.error });
        const { action, mediaId } = req.body || {};
        if (typeof mediaId !== 'string' || !/^\d{5,30}$/.test(mediaId)) {
            return res.status(400).json({ error: 'A valid Instagram post is required.' });
        }

        await ensureOwnedMedia(context.account, mediaId);
        const client = adminClient();
        const monitoredPost = await getOrCreateMonitoredPost(client, context.account.id, mediaId);

        if (action === 'select') {
            const { data: flow, error } = await client.from('flows')
                .select('id, keyword_filter, reply_template, dm_template, dm_link, is_active')
                .eq('monitored_post_id', monitoredPost.id)
                .limit(1)
                .maybeSingle();
            if (error) throw error;
            return res.status(200).json({ monitoredPostId: monitoredPost.id, flow: flow || null });
        }

        if (action !== 'save') return res.status(400).json({ error: 'Unsupported flow action.' });
        const { keywordFilter, replyTemplate, dmTemplate, dmLink, isActive } = req.body || {};
        if (typeof replyTemplate !== 'string' || !replyTemplate.trim() || replyTemplate.length > 1000) {
            return res.status(400).json({ error: 'Public reply text is required (max 1,000 characters).' });
        }
        if (typeof dmTemplate !== 'string' || !dmTemplate.trim() || dmTemplate.length > 900) {
            return res.status(400).json({ error: 'DM text is required (max 900 characters).' });
        }
        let link;
        try { link = new URL(dmLink); } catch { /* handled below */ }
        if (!link || link.protocol !== 'https:') return res.status(400).json({ error: 'DM link must be a valid HTTPS URL.' });
        if (dmTemplate.trim().length + link.toString().length + 1 > 1000) {
            return res.status(400).json({ error: 'DM text and link together must be 1,000 characters or fewer.' });
        }
        if (keywordFilter !== undefined && typeof keywordFilter !== 'string') return res.status(400).json({ error: 'Keyword filter must be text.' });
        if (typeof isActive !== 'boolean') return res.status(400).json({ error: 'Choose whether this flow is active.' });

        const values = {
            monitored_post_id: monitoredPost.id,
            keyword_filter: keywordFilter?.trim() || null,
            reply_template: replyTemplate.trim(),
            dm_template: dmTemplate.trim(),
            dm_link: link.toString(),
            is_active: isActive,
            updated_at: new Date().toISOString()
        };
        const { data: existing, error: lookupError } = await client.from('flows')
            .select('id')
            .eq('monitored_post_id', monitoredPost.id)
            .limit(1)
            .maybeSingle();
        if (lookupError) throw lookupError;

        const result = existing
            ? await client.from('flows').update(values).eq('id', existing.id).select('id, is_active').single()
            : await client.from('flows').insert(values).select('id, is_active').single();
        if (result.error) throw result.error;
        return res.status(200).json({ ok: true, flow: result.data });
    } catch (error) {
        console.error('Instagram flow handler failed:', error.message);
        return res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Could not save this automation.' });
    }
}
