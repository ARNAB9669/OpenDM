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
// GRAPH_API_VERSION can be a plain var in wrangler.toml, e.g. "v21.0"

import { createClient } from '@supabase/supabase-js';
import { verifyMetaSignature } from '../auth/verify_meta_signature.js';

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        // ── Meta's one-time webhook verification (GET) ──
        if (request.method === 'GET') {
            const mode = url.searchParams.get('hub.mode');
            const token = url.searchParams.get('hub.verify_token');
            const challenge = url.searchParams.get('hub.challenge');

            if (mode === 'subscribe' && token === env.META_VERIFY_TOKEN) {
                return new Response(challenge, { status: 200 });
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

            // Acknowledge Meta immediately; do the work, but don't let a slow
            // downstream call risk Meta's delivery timeout/retry storm.
            const payload = JSON.parse(rawBody);
            const ack = new Response('EVENT_RECEIVED', { status: 200 });

            // Fire-and-handle in the background (Workers support this via waitUntil
            // if you have access to the execution context; simplest here is to just
            // await it since Instagram comment volume at this scale is low).
            try {
                await handleWebhookPayload(payload, env);
            } catch (err) {
                console.error('webhook handling error:', err);
                // Still return 200 to Meta — the error is already logged to Supabase
                // inside handleWebhookPayload where possible.
            }

            return ack;
        }

        return new Response('Not found', { status: 404 });
    }
};

async function handleWebhookPayload(payload, env) {
    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

    for (const entry of payload.entry || []) {
        for (const change of entry.changes || []) {
            if (change.field !== 'comments') continue;

            const comment = change.value;
            const metaCommentId = comment.id;
            const metaPostId = comment.media?.id || comment.post_id;
            const commenterIgsid = comment.from?.id;
            const commenterName = comment.from?.username || comment.from?.name;
            const commentText = comment.text || '';

            if (!metaCommentId || !metaPostId) continue;

            // 1. Find the monitored post -> flow -> workspace/connected account
            const { data: post } = await supabase
                .from('monitored_posts')
                .select('id, connected_account_id, connected_accounts(workspace_id, long_lived_token)')
                .eq('meta_post_id', metaPostId)
                .single();

            if (!post) continue; // not a monitored post, ignore

            const { data: flow } = await supabase
                .from('flows')
                .select('*')
                .eq('monitored_post_id', post.id)
                .eq('is_active', true)
                .single();

            if (!flow) continue; // no active flow for this post

            // 2. Confirm the workspace is still active — the Worker uses the
            // service role key (bypasses RLS), so this check is NOT optional.
            const { data: workspace } = await supabase
                .from('workspaces')
                .select('status')
                .eq('id', post.connected_accounts.workspace_id)
                .single();

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
                // likely a duplicate (unique constraint) — already handled, skip silently
                continue;
            }

            const accessToken = post.connected_accounts.long_lived_token;
            const graphVersion = env.GRAPH_API_VERSION || 'v21.0';

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
                const replyJson = await replyRes.json();
                if (replyRes.ok) {
                    replyStatus = 'sent';
                } else {
                    replyError = JSON.stringify(replyJson.error || replyJson);
                }
            } catch (err) {
                replyError = err.message;
            }

            // 6. Private reply DM
            let dmStatus = 'failed';
            let dmError = null;
            try {
                const dmRes = await fetch(
                    `https://graph.facebook.com/${graphVersion}/me/messages`,
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            recipient: { comment_id: metaCommentId },
                            message: { text: `${flow.dm_template}\n${flow.dm_link}` },
                            access_token: accessToken
                        })
                    }
                );
                const dmJson = await dmRes.json();
                if (dmRes.ok) {
                    dmStatus = 'sent';
                } else {
                    dmError = JSON.stringify(dmJson.error || dmJson);
                }
            } catch (err) {
                dmError = err.message;
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