# Open DM Handbook

Open DM is an invite-only client portal for connecting Instagram accounts and configuring comment-to-DM automations. The project has three main pieces: a Vercel-hosted website/API, Supabase for authentication and data, and a Cloudflare Worker for Meta webhook events.

## Project map

```text
admin/
  backend/api/       Admin-only Vercel handlers (invites, accounts, status)
  frontend/          Admin login and workspace management UI
api/                 Vercel API entry-point wrappers
backend/
  auth/              Meta webhook signature verification
  DB/db.sql          Supabase schema, indexes, and row-level security policies
  serverless/        Cloudflare Worker for Instagram comment webhooks
frontend/
  public/            Landing page and invitee magic-link sign-in
  app/dashboard/     Signed-in client workspace page
vercel.json          Vercel route rewrites
```

Canonical client dashboard files are `frontend/app/dashboard/dashboard.html`, `dashboard.js`, and `dashboard.css`. `frontend/public/auth.js` is the canonical client sign-in script. The similarly named `frontend/app/dashboard/dashaboard.html`, `dashabord.js`, and `admin/backend/api/supabse.js ` (the last filename has a trailing space) are empty, unreferenced legacy files; they are not loaded or used by Vercel routes. They are retained for now. The canonical server-side Supabase client/auth helpers are in `admin/backend/api/_auth.js`; never expose its service-role client to the browser.

## Sign-in and invitation flow

1. An administrator signs in and submits a client's email and workspace name.
2. `/api/invite` creates a workspace, asks Supabase Auth to invite the user, and adds a `workspace_members` row.
3. The invitee opens the email link. For later sign-ins, they request a fresh magic link on `/auth.html` using the same invited email.
4. Supabase redirects to `/app/dashboard/dashboard.html` with a session.
5. `dashboard.js` calls `/api/client-session`; the server verifies the session and checks for an active workspace membership.
6. The dashboard requests an Instagram connection URL from `/api/instagram-connect`. The server verifies the session, creates signed one-use state bound to the workspace, and returns Instagram's authorization URL.
7. `/api/instagram-callback` validates and consumes the state, exchanges the OAuth authorization code, discovers the Instagram professional account using a multi-strategy lookup (Unified Login system user token, `debug_token` granular scopes, or Facebook Page linkage), and securely stores the per-account long-lived access token server-side. The dashboard never receives the token.
8. `/api/instagram-media` returns recent media using the per-account token (checking both Facebook Graph and Instagram Graph hosts) and existing flow settings for the signed-in workspace. If an invalid or corrupted account node is detected, it automatically purges the row and resets the workspace.
9. `/api/instagram-flow` creates/reuses a monitored post and saves or updates its flow. The Cloudflare Worker (`cw_web_hook.js`) verifies Meta's signature, dedupes events, filters out the account's own comments, and dispatches the public reply and private reply DM via the matching account's token. `/api/instagram-flow-status` aggregates real-time delivery metrics. Each handler validates the user and workspace server-side.

Email delivery uses the SMTP provider configured in Supabase Auth (currently set up with Resend). DNS records authorize sending; they do not create a mailbox. Inbound email/receiving is separate and is not required for portal sign-in.

## Environment and secrets

Do not put secrets in this handbook or commit them. The root `.env` is ignored by Git, but Vercel production functions use environment variables configured in the Vercel project settings. `.env.example` is a template, not a source of real credentials.

### Vercel server-side variables

Set these in Vercel (and in a private local env file only if running the API locally):

```dotenv
SUPABASE_URL=https://<your-project>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<server-only-service-role-secret>
ADMIN_EMAIL=<administrator-email>
APP_URL=https://<production-app-domain>
META_APP_ID=<Meta-app-id>
META_APP_SECRET=<Meta-app-secret>
META_LOGIN_CONFIG_ID=<Facebook-Login-for-Business-configuration-id>
GRAPH_API_VERSION=v25.0
```

Never expose `SUPABASE_SERVICE_ROLE_KEY` in browser code, `frontend/public/config.js`, or a committed file. The browser needs only the Supabase project URL and public anon/publishable key; these are currently set in `frontend/public/config.js` and are intentionally public.

`APP_URL` must be the origin only (no path or trailing slash). For the current production domain, the exact OAuth redirect URI to register in the Facebook Login for Business configuration is:

```text
https://open-dm.covelly.com/api/instagram-callback
```

Use Meta's **Instagram API with Unified Login** setup. Register the exact callback URI above in the Login for Business configuration, then set its configuration ID as `META_LOGIN_CONFIG_ID` in Vercel. Unified Login uses the Meta app's App ID/secret, a `config_id` rather than OAuth `scope` values, Business Integration System User tokens, and `graph.facebook.com`. Ad accounts are optional for this Instagram use case. The secret is also used by the Worker for webhook signature verification, but Vercel and Cloudflare have separate secret stores. `GRAPH_API_VERSION` is optional in Vercel (defaults to `v25.0`) and set to `v25.0` in the Worker config.

### Cloudflare Worker secrets

Set these as Cloudflare Worker secrets from `backend/serverless/` using `wrangler secret put <NAME>`; do not put their real values in `wrangler.toml`:

```text
META_APP_SECRET
META_VERIFY_TOKEN
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
```

`GRAPH_API_VERSION` is a non-secret setting in `backend/serverless/wrangler.toml`.

### Email and Supabase Auth settings

Configure the Resend SMTP credentials in Supabase Auth's SMTP settings. In Supabase Auth URL settings, allow the production redirect URL used by the app:

```text
https://<production-app-domain>/app/dashboard/dashboard.html
```

Keep the invite email and magic-link email templates pointing to Supabase's generated confirmation link so the one-time token is verified before redirecting back to Open DM.

## Database

`backend/DB/db.sql` defines workspaces, memberships, connected Instagram accounts, monitored posts, automation flows, comment-event logs, OAuth state storage, and row-level security. Run the updated SQL in Supabase before deploying these handlers; it adds `connected_accounts.ig_username`, creates the one-use OAuth-state table, makes Page ID and token expiry nullable, removes browser RLS access to `connected_accounts` so tokens cannot be selected by a client session, and removes direct client write policies for monitored posts and flows. Those operations now go through the authorized server handlers. Review the SQL and back it up before applying schema or policy changes to production.

The API uses the service-role key on the server, so every server-side handler must enforce authorization and workspace scoping itself. Do not treat RLS as protection for server code that bypasses RLS.

## Deploy and verify

- Website and API: deploy the repository through Vercel. API wrappers in `api/` forward to implementations in `admin/backend/api/`.
- Webhook: from `backend/serverless/`, authenticate with Wrangler and deploy the Worker. In Meta's Instagram Webhooks settings, set the callback URL to the deployed Worker URL, set the verify token to the same value as the `META_VERIFY_TOKEN` Worker secret, and enable the `comments` field. The OAuth callback attempts the per-account `comments` subscription after connecting; the Meta app-level webhook callback and field must still be configured. Meta app permissions/review may be required before connecting accounts that are not app testers.
- After a deployment, test an admin invite, the received invite email, a fresh magic-link sign-in, and the client workspace page. Connect a real test Instagram professional account, select one of its recent posts, save an active flow, then add a test comment matching the keyword. Confirm a `comment_events` row is created in Supabase, check the Worker logs for any Meta API error, and verify the private reply arrives in the commenter's Instagram inbox/Requests. Test with accounts that have the required app roles/permissions before enabling it for other users.
- Check the browser console and Network panel if sign-in stalls; `/api/client-session` should return a successful response for a member of an active workspace.

## Current scope note

Portal sign-in and workspace membership have been exercised. Instagram OAuth, multi-strategy account discovery (Unified Login / Facebook Page fallback), media loading, the flow builder, and webhook delivery are fully implemented in the code. OAuth and Graph API requests support both `graph.facebook.com` and `graph.instagram.com` with per-account tokens.

## Instagram Connection & Pipeline Incident & Fix Log

This section documents all issues encountered during the implementation and testing of the Instagram integration, their root causes, and the concrete code and architectural fixes applied.

### 1. Unified Login Asset Enumeration Failure
* **Symptom**: `Meta did not expose the Instagram account to this Unified Login token. Reconnect and select the portfolio that owns the professional account...`
* **Root Cause**: `instagram-callback.js` exclusively queried `GET /me/assigned_instagram_accounts`. When accounts are linked via a Facebook Page (or when Meta's Unified Login asset propagation experiences delays in Dev Mode), this endpoint returns an empty array (`{"data": []}`).
* **Code Fix**:
  * Implemented a multi-strategy account resolution in `authorizedInstagramAccounts()`:
    1. Check `GET /me/assigned_instagram_accounts` for direct system user assets.
    2. Fallback: Exchange code for long-lived user token via `fb_exchange_token` and query `GET /me/accounts?fields=id,name,access_token,instagram_business_account{id,username}`.
    3. Added secondary check on `/{page_id}?fields=instagram_business_account` with `page.access_token` in case nested expansion was omitted.
  * Standardized the returned account shape across all paths: `{ id, username, accessToken, pageId, tokenType }`.
  * Saved the per-account token (`profile.accessToken`) rather than the global OAuth response token.

### 2. OAuth Flexibility (Configuration ID vs. Scopes)
* **Symptom**: Missing `META_LOGIN_CONFIG_ID` threw an unhandled 500 error preventing connection.
* **Root Cause**: `metaLoginConfigId()` threw an error when the environment variable was omitted, preventing standard Facebook Login fallback.
* **Code Fix**:
  * Updated `admin/backend/api/_instagram.js` to return `process.env.META_LOGIN_CONFIG_ID || ''`.
  * Updated `admin/backend/api/instagram-connect.js`: If `config_id` is set, it uses Login for Business. If omitted, it automatically falls back to standard Facebook Login with explicit scopes: `pages_show_list,pages_read_engagement,instagram_basic,instagram_manage_comments,instagram_manage_messages`.

### 3. Webhook Delivery Timeouts, Infinite Loops, & DM Target Routing
* **Symptom**: Risk of Meta webhook retry storms, duplicate message delivery, and private reply failures.
* **Root Cause**:
  * `cw_web_hook.js` was awaiting downstream database and Graph API calls before returning HTTP 200, risking Meta's 5-second webhook delivery timeout.
  * No check existed for whether an incoming comment was posted by the bot account itself, creating an infinite comment-reply loop.
  * Private replies (`POST /{id}/messages`) only targeted `ig_account_id`, which fails for Page-backed Instagram accounts requiring the Page ID.
* **Code Fix**:
  * Added Cloudflare Worker execution context support (`ctx.waitUntil(...)`): acknowledges Meta with HTTP 200 `EVENT_RECEIVED` immediately while processing the automation in the background.
  * Added self-reply guard: skips any comment where `commenterIgsid` equals `entry.id` or `post.connected_accounts.ig_account_id`.
  * Added inner join lookup with `.maybeSingle()` to route webhook events strictly to the matching account.
  * Multi-target private reply fallback: tries `[post.connected_accounts.page_id, post.connected_accounts.ig_account_id, 'me']` sequentially until successful.

### 4. Graph API Error #12 & Missing Graph Version Import
* **Symptom**: `(#12) cannot_access_user_username_f` and `ReferenceError: graphVersion is not defined`.
* **Root Cause**:
  * In Graph API v2.0+, querying `fields=username` on a Facebook User node throws Error 12 (`cannot_access_user_username_field is deprecated`).
  * `graphVersion` was missing from the import list in `instagram-callback.js`.
* **Code Fix**:
  * Imported `graphVersion` from `./_instagram.js`.
  * Changed the Facebook node lookup to query `fields: 'id,name'`.
  * Added secondary lookup for username on `https://graph.instagram.com/${graphVersion()}/${targetId}?fields=id,username`.

### 5. Supabase NOT NULL Database Constraint Violations
* **Symptom**: `null value in column "token_expires_at" of relation "connected_accounts" violates not-null constraint`.
* **Root Cause**: In production, `connected_accounts.token_expires_at` retained a legacy `NOT NULL` constraint. Because Unified Login system user tokens and Page access tokens do not expire, `null` was passed, violating the constraint. `page_id` could also trigger the same issue on unmigrated schemas.
* **Code Fix**:
  * In `instagram-callback.js`: if `token.expires_in` is not provided or zero, `token_expires_at` defaults to a 10-year future timestamp (`new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000).toISOString()`).
  * `page_id` defaults to `instagramUserId` if `pageId` is null, satisfying any legacy `NOT NULL` constraint.

### 6. System User Node ID vs. Instagram Account Node Confusion
* **Symptom**: `Could not load Instagram posts: (#100) Tried accessing nonexisting field (media)`.
* **Root Cause**:
  * In `debug_token`, `dData.user_id` was mistakenly added to the candidate `targetIds` set. For `SYSTEM_USER` tokens, `dData.user_id` is the internal System User ID (`122096643231542100`), not an Instagram account.
  * When saved as `ig_account_id`, querying `GET /122096643231542100/media` resulted in Meta Error 100 because User nodes do not have a `/media` edge.
* **Code Fix**:
  * Removed `dData.user_id` from the candidate Instagram targets in `instagram-callback.js`. Only genuine asset target IDs from `granular_scopes` or connected Pages are accepted.
  * Enhanced `instagram-media.js` with dual-host resolution (tries `graph.facebook.com` then `graph.instagram.com`).
  * Added auto-cleanup in `instagram-media.js`: if Meta returns Error Code 100 (nonexisting field/node) or 190 (expired/invalid), the server automatically purges the corrupted `connected_accounts` row and cleanly returns `{ connected: false, media: [] }` so the workspace can re-link without manual database intervention.

### 7. Portfolio Instagram Account Resolution Blocked (#200 Requires business_management)
* **Symptom**: `Diagnostic info: ... biz:4033576273445567 | 4033576273445567/instagram_accounts_err:(#200) Requires business_management`.
* **Root Cause**:
  * In Meta Login for Business (Unified Login), when a user authenticates via "Continue with Instagram", Meta creates a `SYSTEM_USER` token tied to the user's Meta Business Portfolio (`4033576273445567`).
  * In Development Mode, Meta's `GET /me/assigned_instagram_accounts` and `debug_token.granular_scopes.target_ids` often return empty arrays (`[]`).
  * When our resolver attempts to query the business portfolio's owned/assigned Instagram accounts via `GET /4033576273445567/instagram_accounts`, Meta rejects the query with `(#200) Requires business_management` because the Meta Login for Business configuration was created with only `instagram_basic, instagram_manage_comments, instagram_manage_messages, public_profile`.
* **Fix**:
  * In Meta App Dashboard -> **Facebook Login for Business** -> **Configurations** -> Edit the configuration:
    1. Add `business_management` to the requested permissions list.
    2. Add `pages_show_list` and `pages_read_engagement`.
    3. Ensure **Instagram Accounts** and **Pages** are checked under Assets.
  * Alternatively, connect using **Continue with Facebook** if the Instagram account is linked to a Facebook Page, which resolves via `me/accounts`.

### 8. System User Limitation & Transition to Standard Scopes
* **Symptom**: `Meta portfolio access blocked (#200 Requires business_management)`. All System User endpoints return 0 assets (`asgn_pgs_cnt:0, pages_cnt:0, assigned_cnt:0, targets:[]`).
* **Root Cause**:
  * Unified Login (`config_id`) generates a `SYSTEM_USER` token.
  * In Development Mode, Meta strictly blocks System User tokens from enumerating portfolio assets unless the app has completed Business Verification and Advanced Access review for `business_management`.
  * External System User tokens cannot resolve client assets without explicit manual portfolio assignment in Meta Business Suite.
* **Fix**:
  * Transitioned `instagram-connect.js` to standard Facebook Login with explicit scopes (`pages_show_list,instagram_basic,instagram_manage_comments,instagram_manage_messages`, omitting the deprecated `pages_read_engagement` scope).
  * Generates a standard `USER` access token, prompting the user directly to select their Page (e.g. `OD`) and linked Instagram account (e.g. `nope_not_gonna_tell`).
  * Resolved cleanly via `/me/accounts` without hitting Meta Error 200 `Requires business_management`.

### 9. Recommended Production Connection Paths
1. **Facebook Page Linkage (Standard User Token - Active)**:
   * Connect the Instagram Professional account to a Facebook Page.
   * Prompts user for Page and Instagram account selection in OAuth dialog.
   * Exposes the linked Page and its `instagram_business_account` object reliably via `/me/accounts`.
2. **Instagram Credentials (Unified Login System User)**:
   * Requires Advanced Access and Meta Business Verification for `business_management`.


