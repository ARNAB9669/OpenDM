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
7. `/api/instagram-callback` validates and consumes the state, exchanges the Unified Login code for a Business Integration System User token, discovers the shared Instagram professional account, and stores the token server-side. The dashboard never receives the token.
8. `/api/instagram-media` returns recent media and existing flow settings for the signed-in workspace. `/api/instagram-flow` creates/reuses a monitored post and saves or updates its flow. `/api/instagram-flow-status` aggregates that flow's comment-event results. Each handler validates the user and workspace server-side.

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

Portal sign-in and workspace membership have been exercised. Instagram OAuth, server-side account storage/media loading, the flow builder, and per-flow status feed are implemented for Unified Login but still require the updated SQL, a Meta configuration ID in Vercel, webhook setup, deployment, and a real Instagram test before they can be called live-working. OAuth and Graph API requests use `graph.facebook.com` with Unified Login system-user tokens. End-to-end webhook delivery and DM delivery remain unverified until the manual test above succeeds.
