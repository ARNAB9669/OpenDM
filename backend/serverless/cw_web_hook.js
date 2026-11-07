// backend/serverless/cw_web_hook.js
// Cloudflare Worker — receives Meta's comment webhook, verifies it, dedupes it,
// sends the public reply + private-reply DM, and logs the result to Supabase.
//
// npm install @supabase/supabase-js   (run inside backend/serverless)
//
// Set these as Worker secrets (not in wrangler.toml, use `wrangler secret put <NAME>`):
//   META_APP_SECRET
//   META_VERIFY_TOKEN       (you choose this string; also enter it in Meta's webhook setup)
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//
// GRAPH_API_VERSION can be a plain var in wrangler.toml (default: v25.0).

import { createClient } from '@supabase/supabase-js';
import { verifyMetaSignature } from '../auth/verify_meta_signature.js';

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        // ── Meta's one-time webhook verification (GET) ──
        if (request.method === 'GET') {
            const mode = url.searchParams.get('hub.mode');
            const token = url.searchParams.get('hub.verify_token');
            const challenge = url.searchParams.get('hub.challenge');

            if (mode === 'subscribe' && token === env.META_VERIFY_TOKEN) {
                return new Response(challenge, {
                    status: 200,
                    headers: { 'Content-Type': 'text/plain' }
                });
            }
            return new Response('Forbidden', { status: 403 });
        }

        // ── Actual webhook events (POST) ──
        if (request.method === 'POST') {
            const rawBody = await request.text();
            const signature = request.headers.get('x-hub-signature-256');

            const valid = await verifyMetaSignature(rawBody, signature, env.META_APP_SECRET);
            if (!valid) {
                return new Response('Invalid signature', { status: 401 });
            }

            let payload;
            try {
                payload = JSON.parse(rawBody);
            } catch {
                return new Response('Bad request payload', { status: 400 });
            }

            // Immediately ACK Meta to avoid webhook timeouts and retry storms.
            // If the Cloudflare Worker execution context is available, process in background.
            if (ctx && typeof ctx.waitUntil === 'function') {
                ctx.waitUntil(handleWebhookPayload(payload, env).catch((err) => {
                    console.error('Background webhook handling error:', err);
                }));
                return new Response('EVENT_RECEIVED', { status: 200 });
            }

            try {
                await handleWebhookPayload(payload, env);
            } catch (err) {
                console.error('Webhook handling error:', err);
            }
            return new Response('EVENT_RECEIVED', { status: 200 });
        }

        return new Response('Not found', { status: 404 });
    }
};

async function handleWebhookPayload(payload, env) {
    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

    for (const entry of payload.entry || []) {
        const entryIgId = String(entry.id || '');

        for (const change of entry.changes || []) {
            if (change.field !== 'comments') continue;

            const comment = change.value;
            if (!comment) continue;

            const metaCommentId = comment.id || comment.comment_id;
            const metaPostId = comment.media?.id || comment.post_id;
            const commenterIgsid = String(comment.from?.id || '');
            const commenterName = comment.from?.username || comment.from?.name || '';
            const commentText = comment.text || '';

            if (!metaCommentId || !metaPostId) continue;

            // Self-reply prevention: Don't trigger automations on the account's own comments/replies
            if (commenterIgsid && entryIgId && commenterIgsid === entryIgId) {
                continue;
            }

            // 1. Find the monitored post -> flow -> workspace/connected account
            let query = supabase
                .from('monitored_posts')
                .select('id, connected_account_id, connected_accounts!inner(id, workspace_id, ig_account_id, page_id, long_lived_token)')
                .eq('meta_post_id', metaPostId);

            if (entryIgId) {
                query = query.eq('connected_accounts.ig_account_id', entryIgId);
            }

            const { data: post, error: postError } = await query.maybeSingle();
            if (postError) {
                console.error('Monitored post lookup failed:', postError.message);
                continue;
            }
            if (!post || !post.connected_accounts) continue;

            // Additional self-reply guard against the connected account ID
            if (commenterIgsid && commenterIgsid === String(post.connected_accounts.ig_account_id)) {
                continue;
            }

            const { data: flow } = await supabase
                .from('flows')
                .select('*')
                .eq('monitored_post_id', post.id)
                .eq('is_active', true)
                .maybeSingle();

            if (!flow) continue; // no active flow for this post

            // 2. Confirm the workspace is still active
            const { data: workspace } = await supabase
                .from('workspaces')
                .select('status')
                .eq('id', post.connected_accounts.workspace_id)
                .maybeSingle();

            if (!workspace || workspace.status !== 'active') continue;

            // 3. Keyword filter, if set
            if (flow.keyword_filter && !commentText.toLowerCase().includes(flow.keyword_filter.toLowerCase())) {
                continue;
            }

            // 4. Dedup insert — if meta_comment_id already exists, this fails and we skip
            const { data: event, error: insertError } = await supabase
                .from('comment_events')
                .insert({
                    flow_id: flow.id,
                    meta_comment_id: metaCommentId,
                    commenter_name: commenterName,
                    commenter_igsid: commenterIgsid
                })
                .select()
                .single();

            if (insertError) {
                // duplicate comment event — already handled, skip silently
                continue;
            }

            const accessToken = post.connected_accounts.long_lived_token;
            const graphVersion = env.GRAPH_API_VERSION || 'v25.0';

            // 5. Public reply to the comment
            let replyStatus = 'failed';
            let replyError = null;
            try {
                const replyRes = await fetch(
                    `https://graph.facebook.com/${graphVersion}/${metaCommentId}/replies`,
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            message: flow.reply_template,
                            access_token: accessToken
                        })
                    }
                );
                const replyJson = await replyRes.json().catch(() => ({}));
                if (replyRes.ok) {
                    replyStatus = 'sent';
                } else {
                    replyError = JSON.stringify(replyJson.error || replyJson);
                }
            } catch (err) {
                replyError = err.message;
            }

            // 6. Private reply DM
            // For Page-connected Instagram accounts, routing through the page ID is supported;
            // for Unified Login System Users, routing through ig_account_id or 'me' is used.
            let dmStatus = 'failed';
            let dmError = null;
            const messageTargets = [
                post.connected_accounts.page_id,
                post.connected_accounts.ig_account_id,
                'me'
            ].filter(Boolean);

            for (const targetId of messageTargets) {
                try {
                    const dmRes = await fetch(
                        `https://graph.facebook.com/${graphVersion}/${targetId}/messages`,
                        {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                recipient: { comment_id: metaCommentId },
                                message: { text: `${flow.dm_template}\n${flow.dm_link}`.trim() },
                                access_token: accessToken
                            })
                        }
                    );
                    const dmJson = await dmRes.json().catch(() => ({}));
                    if (dmRes.ok) {
                        dmStatus = 'sent';
                        dmError = null;
                        break;
                    } else {
                        dmError = JSON.stringify(dmJson.error || dmJson);
                    }
                } catch (err) {
                    dmError = err.message;
                }
            }

            // 7. Log the outcome
            await supabase
                .from('comment_events')
                .update({
                    reply_status: replyStatus,
                    dm_status: dmStatus,
                    error_detail: [replyError, dmError].filter(Boolean).join(' | ') || null
                })
                .eq('id', event.id);
        }
    }
}
