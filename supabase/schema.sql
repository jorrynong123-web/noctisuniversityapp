-- ═══════════════════════════════════════════════════════════════════════════
-- Noctis University — Supabase Schema v3
-- Run this in the Supabase SQL editor (https://app.supabase.com → SQL Editor)
--
-- BEFORE RUNNING:
--   Authentication → Settings → disable "Enable email confirmations"
--   Authentication → Settings → disable "Enable phone confirmations"
--
-- This script is idempotent — safe to run multiple times.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Profiles ──────────────────────────────────────────────────────────────────
create table if not exists public.profiles (
  id               text primary key,
  username         text unique not null,
  pic              text default '🌑',
  bio              text default '',
  cov              text default 'silk',
  tier             text default 'commoner',
  major            text default 'Undeclared',
  year             text default 'Freshman',
  wealth           text default 'Self-Made',
  rep              text default 'New Arrival',
  followers        int  default 0,
  following        int  default 0,
  xp               bigint default 0,
  traits           jsonb default '[]',
  trent_memory     text default '',
  can_see_auction  boolean default false,
  can_see_relief   boolean default false,
  created_at       timestamptz default now()
);

alter table public.profiles add column if not exists xp bigint default 0;

-- ── Posts ─────────────────────────────────────────────────────────────────────
create table if not exists public.posts (
  id         text primary key,
  user_id    text not null,
  username   text not null,
  content    text not null,
  image      text,
  pic        text default '🌑',
  covenant   text default 'silk',
  tier       text default 'commoner',
  likes      int  default 0,
  skulls     int  default 0,
  flames     int  default 0,
  is_npc     boolean default false,
  created_at timestamptz default now()
);

-- ── Comments ──────────────────────────────────────────────────────────────────
create table if not exists public.comments (
  id         text primary key,
  post_id    text references public.posts(id) on delete cascade,
  user_id    text not null,
  username   text not null,
  text       text not null,
  parent_id  text,
  created_at timestamptz default now()
);

-- ── Messages (DMs) ────────────────────────────────────────────────────────────
create table if not exists public.messages (
  id            text primary key,
  from_id       text not null,
  from_username text not null,
  from_pic      text default '🌑',
  to_id         text not null,
  to_username   text not null,
  text          text not null,
  created_at    timestamptz default now()
);

-- ── Wallets ───────────────────────────────────────────────────────────────────
create table if not exists public.wallets (
  user_id    text primary key,
  balance    bigint default 5000,
  updated_at timestamptz default now()
);

-- ── Auctions ──────────────────────────────────────────────────────────────────
create table if not exists public.auctions (
  id             text primary key,
  subject_id     text not null,
  subject_type   text default 'user',
  subject_name   text not null,
  subject_avatar text default '🌑',
  subject_data   jsonb default '{}',
  reason         text,
  starting_bid   int  default 500,
  top_bid        int  default 500,
  top_bidder     text,
  bids           jsonb default '[]',
  is_active      boolean default true,
  created_at     timestamptz default now()
);

-- ── Bids ──────────────────────────────────────────────────────────────────────
create table if not exists public.bids (
  id          text primary key,
  auction_id  text references public.auctions(id),
  bidder_id   text not null,
  bidder_name text not null,
  amount      int  not null,
  created_at  timestamptz default now()
);

-- ── Row Level Security ────────────────────────────────────────────────────────
alter table public.profiles  enable row level security;
alter table public.posts     enable row level security;
alter table public.comments  enable row level security;
alter table public.messages  enable row level security;
alter table public.wallets   enable row level security;
alter table public.auctions  enable row level security;
alter table public.bids      enable row level security;

-- ── Policies (drop + recreate for idempotency) ────────────────────────────────
drop policy if exists "profiles_select" on public.profiles;
drop policy if exists "profiles_insert" on public.profiles;
drop policy if exists "profiles_update" on public.profiles;
drop policy if exists "posts_select"    on public.posts;
drop policy if exists "posts_insert"    on public.posts;
drop policy if exists "posts_update"    on public.posts;
drop policy if exists "posts_delete"    on public.posts;
drop policy if exists "comments_select" on public.comments;
drop policy if exists "comments_insert" on public.comments;
drop policy if exists "comments_delete" on public.comments;
drop policy if exists "messages_select" on public.messages;
drop policy if exists "messages_insert" on public.messages;
drop policy if exists "wallets_select"  on public.wallets;
drop policy if exists "wallets_insert"  on public.wallets;
drop policy if exists "wallets_update"  on public.wallets;
drop policy if exists "auctions_select" on public.auctions;
drop policy if exists "auctions_insert" on public.auctions;
drop policy if exists "auctions_update" on public.auctions;
drop policy if exists "bids_select"     on public.bids;
drop policy if exists "bids_insert"     on public.bids;

create policy "profiles_select" on public.profiles for select using (true);
create policy "profiles_insert" on public.profiles for insert with check (true);
create policy "profiles_update" on public.profiles for update using (true);

create policy "posts_select" on public.posts for select using (true);
create policy "posts_insert" on public.posts for insert with check (true);
create policy "posts_update" on public.posts for update using (true);
create policy "posts_delete" on public.posts for delete using (true);

create policy "comments_select" on public.comments for select using (true);
create policy "comments_insert" on public.comments for insert with check (true);
create policy "comments_delete" on public.comments for delete using (true);

create policy "messages_select" on public.messages for select using (true);
create policy "messages_insert" on public.messages for insert with check (true);

create policy "wallets_select" on public.wallets for select using (true);
create policy "wallets_insert" on public.wallets for insert with check (true);
create policy "wallets_update" on public.wallets for update using (true);

create policy "auctions_select" on public.auctions for select using (true);
create policy "auctions_insert" on public.auctions for insert with check (true);
create policy "auctions_update" on public.auctions for update using (true);

create policy "bids_select" on public.bids for select using (true);
create policy "bids_insert" on public.bids for insert with check (true);

-- ── Indexes ───────────────────────────────────────────────────────────────────
create index if not exists posts_created_at_idx  on public.posts(created_at desc);
create index if not exists posts_user_id_idx     on public.posts(user_id);
create index if not exists messages_from_id_idx  on public.messages(from_id);
create index if not exists messages_to_id_idx    on public.messages(to_id);
create index if not exists comments_post_id_idx  on public.comments(post_id);
create index if not exists profiles_username_idx on public.profiles(lower(username));

-- ── Clean up old broken triggers/functions from previous schema runs ──────────
-- The original schema created an AFTER INSERT trigger named on_auth_user_created
-- that called auto_confirm_user() which tried to UPDATE auth.users SET confirmed_at.
-- confirmed_at is a generated column — the UPDATE crashed every signUp() call.
-- These must be dropped before creating the new BEFORE INSERT trigger below.
drop trigger if exists on_auth_user_created on auth.users;
drop function if exists public.auto_confirm_user();

-- ── Auto-confirm trigger ──────────────────────────────────────────────────────
-- Uses BEFORE INSERT so we set email_confirmed_at on the NEW row directly.
-- This never touches confirmed_at (it is generated by Supabase automatically).
-- No UPDATE on auth.users is needed — avoids the generated-column error entirely.
create or replace function public.handle_auto_confirm()
returns trigger
language plpgsql
security definer
as $$
begin
  if new.email_confirmed_at is null then
    new.email_confirmed_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists auto_confirm_on_signup on auth.users;
create trigger auto_confirm_on_signup
  before insert on auth.users
  for each row execute function public.handle_auto_confirm();

-- ── RPC stub (called by app signup handler, safe to be a no-op) ──────────────
-- The BEFORE INSERT trigger above handles confirmation.
-- This function exists so the app's .rpc("confirm_user_by_id") call doesn't error.
create or replace function public.confirm_user_by_id(uid uuid)
returns void
language plpgsql
security definer
as $$
begin
  -- Confirmation is handled by the handle_auto_confirm trigger at INSERT time.
  -- Nothing to do here.
  return;
end;
$$;

grant execute on function public.confirm_user_by_id(uuid) to anon, authenticated;

-- ── Fix existing stuck accounts ───────────────────────────────────────────────
-- Only updates email_confirmed_at (confirmed_at is generated — do NOT set it).
update auth.users
  set email_confirmed_at = now()
  where email_confirmed_at is null;
