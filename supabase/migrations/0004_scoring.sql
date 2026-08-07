-- Ghostfill 0004 — seasons, ladder, calibration, badges, integrity.

create table if not exists public.divisions (
  id           uuid primary key default gen_random_uuid(),
  season_id    uuid not null references public.seasons(id) on delete cascade,
  tier         division_tier not null,
  pod_number   int not null,
  member_count int not null default 0,
  unique (season_id, tier, pod_number)
);

create table if not exists public.ladder_entries (
  id                uuid primary key default gen_random_uuid(),
  season_id         uuid not null references public.seasons(id) on delete cascade,
  division_id       uuid references public.divisions(id) on delete set null,
  user_id           uuid not null references public.profiles(id) on delete cascade,
  portfolio_id      uuid not null references public.portfolios(id) on delete cascade,

  ladder_points     numeric(12,4) not null default 0,
  normalized_return numeric(12,6),
  brier_skill       numeric(12,6),
  discipline_score  numeric(12,6),
  activity_score    numeric(12,6),

  rank_in_pod       int,
  rank_in_tier      int,
  rank_global       int,

  trades_count      int not null default 0,
  markets_count     int not null default 0,
  categories_count  int not null default 0,
  is_eligible       boolean not null default false,
  ineligible_reason text,

  final_tier        division_tier,
  promoted          boolean,
  relegated         boolean,
  updated_at        timestamptz not null default now(),
  unique (season_id, user_id)
);
create index if not exists ladder_division_idx on public.ladder_entries (division_id, ladder_points desc);
create index if not exists ladder_season_idx on public.ladder_entries (season_id, ladder_points desc)
  where is_eligible;

-- One row per resolved position: the calibration corpus.
-- Voids are deliberately absent — a void is not a forecast error.
create table if not exists public.calibration_records (
  id             bigserial primary key,
  user_id        uuid not null references public.profiles(id) on delete cascade,
  position_id    uuid not null references public.positions(id) on delete cascade unique,
  market_id      uuid not null references public.markets(id),
  season_id      uuid references public.seasons(id),
  category       text not null default 'other',

  p_user         numeric(8,6) not null check (p_user >= 0 and p_user <= 1),
  p_market       numeric(8,6) not null check (p_market >= 0 and p_market <= 1),
  outcome        int not null check (outcome in (0,1)),

  brier_user     numeric(12,8) not null,
  brier_market   numeric(12,8) not null,
  log_score_user numeric(14,8),
  edge_bps       numeric(14,4),
  notional       numeric(20,6) not null default 0,

  entered_at     timestamptz not null,
  resolved_at    timestamptz not null
);
create index if not exists calibration_user_idx on public.calibration_records (user_id, resolved_at desc);
create index if not exists calibration_category_idx on public.calibration_records (user_id, category);

create table if not exists public.badges (
  id          text primary key,
  name        text not null,
  description text not null,
  icon        text not null,
  rarity      text not null default 'common'
);

create table if not exists public.user_badges (
  user_id   uuid not null references public.profiles(id) on delete cascade,
  badge_id  text not null references public.badges(id),
  season_id uuid references public.seasons(id),
  earned_at timestamptz not null default now(),
  primary key (user_id, badge_id, season_id)
);

create table if not exists public.watchlist (
  user_id    uuid not null references public.profiles(id) on delete cascade,
  market_id  uuid not null references public.markets(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, market_id)
);

create table if not exists public.integrity_events (
  id           bigserial primary key,
  user_id      uuid not null references public.profiles(id) on delete cascade,
  kind         integrity_kind not null,
  severity     int not null check (severity between 1 and 5),
  detail       jsonb not null default '{}'::jsonb,
  action_taken text not null default 'flagged',
  created_at   timestamptz not null default now()
);
create index if not exists integrity_user_idx on public.integrity_events (user_id, created_at desc);

insert into public.badges (id, name, description, icon, rarity) values
  ('first_fill',      'First Ghost',      'Placed your first simulated order.',                  '01', 'common'),
  ('beat_the_market', 'Beat the Market',  'Positive Brier Skill Score over 30+ resolved positions.', '02', 'rare'),
  ('calibrated',      'Calibrated',       'Reliability under 0.01 over 50+ resolved positions.',  '03', 'epic'),
  ('diamond_hands',   'Diamond Division', 'Finished a season in the Diamond division.',           '04', 'legendary')
on conflict (id) do nothing;
