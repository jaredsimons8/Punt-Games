-- ============================================================
-- PUNT GAME TRACKER — Supabase Schema
-- Paste this entire file into: Supabase > SQL Editor > New Query > Run
-- ============================================================

-- Enable UUID extension
create extension if not exists "uuid-ossp";

-- ── USER PREFERENCES ──────────────────────────────────────
-- Stores each user's starred teams and UI preferences
create table if not exists user_preferences (
  id          uuid primary key default uuid_generate_v4(),
  user_id     uuid references auth.users(id) on delete cascade not null unique,
  starred_teams text[] default '{}',
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

-- ── GAME LOG ──────────────────────────────────────────────
-- Every game the user has analyzed and logged
create table if not exists game_log (
  id            uuid primary key default uuid_generate_v4(),
  user_id       uuid references auth.users(id) on delete cascade not null,
  game_id       text not null,           -- e.g. "2026-04-15_NYY_BOS"
  game_date     date not null,
  away_team     text not null,
  home_team     text not null,
  punt_team     text,
  punt_side     text,                    -- 'home' | 'away'
  series_game   int,
  series_length int,
  away_sp       text,
  away_sp_era   numeric(5,2),
  away_sp_fip   numeric(5,2),
  home_sp       text,
  home_sp_era   numeric(5,2),
  home_sp_fip   numeric(5,2),
  eff_benched   numeric(4,1),
  punt_score    numeric(4,1),
  flag          text,                    -- 'punt' | 'review' | 'clean'
  result        text,                    -- 'W' | 'L' | null
  override      boolean,                 -- manual override on/off
  notes         text default '',
  breakdown     jsonb,                   -- absence breakdown array
  created_at    timestamptz default now(),
  updated_at    timestamptz default now(),
  unique(user_id, game_id)
);

-- ── ROW LEVEL SECURITY ────────────────────────────────────
-- Users can only see and modify their own data

alter table user_preferences enable row level security;
alter table game_log enable row level security;

-- Preferences policies
create policy "Users can view own preferences"
  on user_preferences for select using (auth.uid() = user_id);

create policy "Users can insert own preferences"
  on user_preferences for insert with check (auth.uid() = user_id);

create policy "Users can update own preferences"
  on user_preferences for update using (auth.uid() = user_id);

-- Game log policies
create policy "Users can view own game log"
  on game_log for select using (auth.uid() = user_id);

create policy "Users can insert own game log"
  on game_log for insert with check (auth.uid() = user_id);

create policy "Users can update own game log"
  on game_log for update using (auth.uid() = user_id);

create policy "Users can delete own game log"
  on game_log for delete using (auth.uid() = user_id);

-- ── INDEXES ───────────────────────────────────────────────
create index if not exists game_log_user_date on game_log(user_id, game_date desc);
create index if not exists game_log_flag on game_log(user_id, flag);

-- ── AUTO-UPDATE TIMESTAMPS ────────────────────────────────
create or replace function update_updated_at()
returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

create trigger update_game_log_ts
  before update on game_log
  for each row execute function update_updated_at();

create trigger update_prefs_ts
  before update on user_preferences
  for each row execute function update_updated_at();

-- Done! Your database is ready.
