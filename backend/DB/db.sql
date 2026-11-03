-- OpenDM schema
-- Run this in the Supabase SQL editor (or via `supabase db push`)
-- Safe to run multiple times (idempotent)

-- ───────────────────────────────────────────
-- Extensions
-- ───────────────────────────────────────────
create extension if not exists "pgcrypto"; -- for gen_random_uuid()

-- ───────────────────────────────────────────
-- workspaces: one row per client (the tenant boundary)
-- ───────────────────────────────────────────
create table if not exists workspaces (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  status      text not null default 'active' check (status in ('active', 'suspended', 'banned')),
  invited_by  uuid references auth.users(id),
  created_at  timestamptz not null default now()
);

-- ───────────────────────────────────────────
-- workspace_members: who can log into which workspace
-- ───────────────────────────────────────────
create table if not exists workspace_members (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  user_id       uuid not null references auth.users(id) on delete cascade,
  role          text not null default 'owner' check (role in ('owner', 'member', 'admin')),
  created_at    timestamptz not null default now(),
  unique (workspace_id, user_id)
);

-- ───────────────────────────────────────────
-- connected_accounts: the client's connected IG account + token
-- ───────────────────────────────────────────
create table if not exists connected_accounts (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid not null references workspaces(id) on delete cascade,
  platform           text not null default 'instagram' check (platform in ('instagram')),
  ig_account_id      text not null,
  page_id            text not null,
  long_lived_token   text not null,
  token_expires_at   timestamptz not null,
  connected_at       timestamptz not null default now(),
  unique (workspace_id, ig_account_id)
);

-- ───────────────────────────────────────────
-- monitored_posts: posts the client has chosen to automate
-- ───────────────────────────────────────────
create table if not exists monitored_posts (
  id                     uuid primary key default gen_random_uuid(),
  connected_account_id   uuid not null references connected_accounts(id) on delete cascade,
  meta_post_id           text not null,
  thumbnail_url          text,
  created_at             timestamptz not null default now(),
  unique (connected_account_id, meta_post_id)
);

-- ───────────────────────────────────────────
-- flows: the rule — trigger + reply text + DM text + link
-- ───────────────────────────────────────────
create table if not exists flows (
  id                  uuid primary key default gen_random_uuid(),
  monitored_post_id   uuid not null references monitored_posts(id) on delete cascade,
  keyword_filter      text,                 -- null = trigger on any comment
  reply_template      text not null,
  dm_template         text not null,
  dm_link             text not null,
  is_active           boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- ───────────────────────────────────────────
-- comment_events: one row per comment seen — audit trail + dedup guard
-- ───────────────────────────────────────────
create table if not exists comment_events (
  id               uuid primary key default gen_random_uuid(),
  flow_id          uuid not null references flows(id) on delete cascade,
  meta_comment_id  text not null unique,     -- the dedup guard against webhook retries
  commenter_name   text,
  commenter_igsid  text,                     -- Instagram-scoped id, needed to send the private reply
  reply_status     text not null default 'pending' check (reply_status in ('pending', 'sent', 'failed')),
  dm_status        text not null default 'pending' check (dm_status in ('pending', 'sent', 'failed')),
  error_detail     text,
  created_at       timestamptz not null default now()
);

-- ───────────────────────────────────────────
-- Indexes for common lookups
-- ───────────────────────────────────────────
create index if not exists idx_workspace_members_user on workspace_members(user_id);
create index if not exists idx_connected_accounts_workspace on connected_accounts(workspace_id);
create index if not exists idx_monitored_posts_account on monitored_posts(connected_account_id);
create index if not exists idx_flows_post on flows(monitored_post_id);
create index if not exists idx_comment_events_flow on comment_events(flow_id);
create index if not exists idx_workspaces_status on workspaces(status);

-- ───────────────────────────────────────────
-- Row-Level Security
-- ───────────────────────────────────────────
alter table workspaces           enable row level security;
alter table workspace_members    enable row level security;
alter table connected_accounts   enable row level security;
alter table monitored_posts      enable row level security;
alter table flows                enable row level security;
alter table comment_events       enable row level security;

-- Helper: is the current user an ACTIVE member of a given workspace?
-- A suspended/banned workspace fails this for every member, which is what
-- actually locks them out — not just a status label the UI happens to show.
create or replace function is_workspace_member(ws_id uuid)
returns boolean
language sql
security definer
stable
as $$
  select exists (
    select 1 from workspace_members wm
    join workspaces w on w.id = wm.workspace_id
    where wm.workspace_id = ws_id
    and wm.user_id = auth.uid()
    and w.status = 'active'
  );
$$;

-- ───────────────────────────────────────────
-- Client Workspace Policies
-- ───────────────────────────────────────────

-- workspaces: visible only to active members
drop policy if exists "members can view their workspace" on workspaces;
create policy "members can view their workspace"
  on workspaces for select
  using (is_workspace_member(id));

-- workspace_members: visible only to members of the same workspace
drop policy if exists "members can view workspace membership" on workspace_members;
create policy "members can view workspace membership"
  on workspace_members for select
  using (is_workspace_member(workspace_id));

-- connected_accounts: visible/editable only to members of that workspace
drop policy if exists "members can view their connected accounts" on connected_accounts;
create policy "members can view their connected accounts"
  on connected_accounts for select
  using (is_workspace_member(workspace_id));

drop policy if exists "members can manage their connected accounts" on connected_accounts;
create policy "members can manage their connected accounts"
  on connected_accounts for all
  using (is_workspace_member(workspace_id))
  with check (is_workspace_member(workspace_id));

-- monitored_posts: scoped via connected_accounts → workspace
drop policy if exists "members can view their monitored posts" on monitored_posts;
create policy "members can view their monitored posts"
  on monitored_posts for select
  using (
    exists (
      select 1 from connected_accounts ca
      where ca.id = monitored_posts.connected_account_id
      and is_workspace_member(ca.workspace_id)
    )
  );

drop policy if exists "members can manage their monitored posts" on monitored_posts;
create policy "members can manage their monitored posts"
  on monitored_posts for all
  using (
    exists (
      select 1 from connected_accounts ca
      where ca.id = monitored_posts.connected_account_id
      and is_workspace_member(ca.workspace_id)
    )
  )
  with check (
    exists (
      select 1 from connected_accounts ca
      where ca.id = monitored_posts.connected_account_id
      and is_workspace_member(ca.workspace_id)
    )
  );

-- flows: scoped via monitored_posts → connected_accounts → workspace
drop policy if exists "members can view their flows" on flows;
create policy "members can view their flows"
  on flows for select
  using (
    exists (
      select 1 from monitored_posts mp
      join connected_accounts ca on ca.id = mp.connected_account_id
      where mp.id = flows.monitored_post_id
      and is_workspace_member(ca.workspace_id)
    )
  );

drop policy if exists "members can manage their flows" on flows;
create policy "members can manage their flows"
  on flows for all
  using (
    exists (
      select 1 from monitored_posts mp
      join connected_accounts ca on ca.id = mp.connected_account_id
      where mp.id = flows.monitored_post_id
      and is_workspace_member(ca.workspace_id)
    )
  )
  with check (
    exists (
      select 1 from monitored_posts mp
      join connected_accounts ca on ca.id = mp.connected_account_id
      where mp.id = flows.monitored_post_id
      and is_workspace_member(ca.workspace_id)
    )
  );

-- comment_events: read-only for clients, scoped via flows → ... → workspace
drop policy if exists "members can view their comment events" on comment_events;
create policy "members can view their comment events"
  on comment_events for select
  using (
    exists (
      select 1 from flows f
      join monitored_posts mp on mp.id = f.monitored_post_id
      join connected_accounts ca on ca.id = mp.connected_account_id
      where f.id = comment_events.flow_id
      and is_workspace_member(ca.workspace_id)
    )
  );

-- ───────────────────────────────────────────
-- Admin Policies (Replace 'your-admin-email@example.com' with your actual admin email)
-- ───────────────────────────────────────────

-- 1. Full access to view, update, manage and ban workspaces
drop policy if exists "Admin full access workspaces" on workspaces;
create policy "Admin full access workspaces"
  on workspaces for all
  using (auth.jwt() ->> 'email' = 'your-admin-email@example.com')
  with check (auth.jwt() ->> 'email' = 'your-admin-email@example.com');

-- 2. Full access to workspace members
drop policy if exists "Admin full access workspace_members" on workspace_members;
create policy "Admin full access workspace_members"
  on workspace_members for all
  using (auth.jwt() ->> 'email' = 'your-admin-email@example.com')
  with check (auth.jwt() ->> 'email' = 'your-admin-email@example.com');

-- 3. Read access to connected accounts (needed for admin dashboard stats)
drop policy if exists "Admin full access connected_accounts" on connected_accounts;
create policy "Admin full access connected_accounts"
  on connected_accounts for select
  using (auth.jwt() ->> 'email' = 'your-admin-email@example.com');

-- 4. Read access to comment events (needed to show total comments processed)
drop policy if exists "Admin full access comment_events" on comment_events;
create policy "Admin full access comment_events"
  on comment_events for select
  using (auth.jwt() ->> 'email' = 'your-admin-email@example.com');
