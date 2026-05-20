-- ═══════════════════════════════════════════════════════════════════════════
-- Noctis University — Supabase Schema
-- Run this in the Supabase SQL editor (https://app.supabase.com → SQL Editor)
-- IMPORTANT: Also go to Authentication → Settings and DISABLE email confirmations
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Profiles ─────────────────────────────────────────────────────────────────
create table if not exists public.profiles (
  id            text primary key,
  username      text unique not null,
  pic           text default '🌑',
  bio           text default '',
  cov           text default 'silk',
  tier          text default 'commoner',
  major         text default 'Undeclared',
  year          text default 'Freshman',
  wealth        text default 'Self-Made',
  rep           text default 'New Arrival',
  followers     int  default 0,
  following     int  default 0,
  traits        jsonb default '[]',
  trent_memory  text default '',
  can_see_auction  boolean default false,
  can_see_relief   boolean default false,
  created_at    timestamptz default now()
);

-- ── Posts ─────────────────────────────────────────────────────────────────────
create table if not exists public.posts (
  id        text primary key,
  user_id   text not null,
  username  text not null,
  content   text not null,
  image     text,
  pic       text default '🌑',
  covenant  text default 'silk',
  tier      text default 'commoner',
  likes     int  default 0,
  skulls    int  default 0,
  flames    int  default 0,
  is_npc    boolean default false,
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
  id             text primary key,
  from_id        text not null,
  from_username  text not null,
  from_pic       text default '🌑',
  to_id          text not null,
  to_username    text not null,
  text           text not null,
  created_at     timestamptz default now()
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
  id           text primary key,
  auction_id   text references public.auctions(id),
  bidder_id    text not null,
  bidder_name  text not null,
  amount       int  not null,
  created_at   timestamptz default now()
);

-- ── Row Level Security ────────────────────────────────────────────────────────
alter table public.profiles  enable row level security;
alter table public.posts     enable row level security;
alter table public.comments  enable row level security;
alter table public.messages  enable row level security;
alter table public.wallets   enable row level security;
alter table public.auctions  enable row level security;
alter table public.bids      enable row level security;

-- Profiles: public read, open write (app manages access logic)
create policy "profiles_select" on public.profiles for select using (true);
create policy "profiles_insert" on public.profiles for insert with check (true);
create policy "profiles_update" on public.profiles for update using (true);

-- Posts: public read/write
create policy "posts_select" on public.posts for select using (true);
create policy "posts_insert" on public.posts for insert with check (true);
create policy "posts_update" on public.posts for update using (true);
create policy "posts_delete" on public.posts for delete using (true);

-- Comments: public read/write
create policy "comments_select" on public.comments for select using (true);
create policy "comments_insert" on public.comments for insert with check (true);
create policy "comments_delete" on public.comments for delete using (true);

-- Messages: public (app-level access control)
create policy "messages_select" on public.messages for select using (true);
create policy "messages_insert" on public.messages for insert with check (true);

-- Wallets: public read, open upsert
create policy "wallets_select" on public.wallets for select using (true);
create policy "wallets_insert" on public.wallets for insert with check (true);
create policy "wallets_update" on public.wallets for update using (true);

-- Auctions: public
create policy "auctions_select" on public.auctions for select using (true);
create policy "auctions_insert" on public.auctions for insert with check (true);
create policy "auctions_update" on public.auctions for update using (true);

-- Bids: public
create policy "bids_select" on public.bids for select using (true);
create policy "bids_insert" on public.bids for insert with check (true);

-- ── Indexes for common queries ────────────────────────────────────────────────
create index if not exists posts_created_at_idx on public.posts(created_at desc);
create index if not exists messages_from_id_idx on public.messages(from_id);
create index if not exists messages_to_id_idx   on public.messages(to_id);
create index if not exists comments_post_id_idx on public.comments(post_id);
