-- Ghostfill 0002 — venues, seasons, profiles, events, markets, books.
--
-- Numeric precision contract, matching packages/core/src/decimal.ts:
--   price  numeric(8,4)   cents, 0..100 exclusive
--   qty    numeric(20,2)  units — the finest size either venue quotes
--   money  numeric(20,6)  dollars, micro-dollar precision like USDC
-- qty(2) x cents(2) / 100 lands exactly in 6 decimal places, so the fill
-- invariant `cost = sum(qty * price)` holds with no residue.

create table if not exists public.venues (
  code          venue_code primary key,
  display_name  text not null,
  base_url      text not null,
  unit_noun     text not null default 'contracts',
  fee_model     jsonb not null default '{}'::jsonb,
  is_enabled    boolean not null default true
);

create table if not exists public.seasons (
  id            uuid primary key default gen_random_uuid(),
  number        int unique not null,
  name          text not null,
  starts_at     timestamptz not null,
  ends_at       timestamptz not null,
  is_active     boolean not null default false,
  finalized_at  timestamptz
);
create unique index if not exists seasons_one_active on public.seasons (is_active) where is_active;

-- Identity without login.
--
-- There is no auth.users row and no sign-up. The extension generates a random
-- device secret on first run, keeps it in chrome.storage.local, and sends it as
-- a bearer token. We store only its SHA-256 so a database leak cannot be
-- replayed as a session. `auth_user_id` is reserved for the day real accounts
-- land — a profile can be adopted by a login without migrating any trades.
create table if not exists public.profiles (
  id                    uuid primary key default gen_random_uuid(),
  device_hash           text unique not null,
  auth_user_id          uuid unique,
  handle                text unique not null check (handle ~ '^[a-z0-9_]{3,20}$'),
  display_name          text not null,
  avatar_seed           text,
  bio                   text check (char_length(bio) <= 200),

  sim_realism           sim_realism not null default 'realistic',
  theme                 text not null default 'dark',
  colorblind_mode       boolean not null default false,
  layout_pref           text not null default 'grid',
  default_order_size    numeric(20,6) not null default 100,
  confirm_before_order  boolean not null default true,
  timezone              text not null default 'UTC',

  is_public                boolean not null default true,
  is_leaderboard_eligible  boolean not null default true,
  shadow_banned            boolean not null default false,

  onboarded_at  timestamptz,
  last_seen_at  timestamptz not null default now(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists profiles_created_idx on public.profiles (created_at desc);

create table if not exists public.events (
  id             uuid primary key default gen_random_uuid(),
  venue          venue_code not null references public.venues(code),
  venue_event_id text not null,
  series_key     text,
  title          text not null,
  slug           text,
  description    text,
  category       text not null default 'other',
  subcategory    text,
  image_url      text,
  open_time      timestamptz,
  close_time     timestamptz,
  is_active      boolean not null default true,
  raw            jsonb,
  synced_at      timestamptz not null default now(),
  unique (venue, venue_event_id)
);
create index if not exists events_category_close_idx on public.events (category, close_time);
create index if not exists events_venue_active_idx on public.events (venue, is_active);

create table if not exists public.markets (
  id               uuid primary key default gen_random_uuid(),
  event_id         uuid not null references public.events(id) on delete cascade,
  venue            venue_code not null references public.venues(code),
  venue_market_id  text not null,
  question         text not null,
  slug             text,
  yes_label        text not null default 'Yes',
  no_label         text not null default 'No',
  resolution_source text,
  resolution_rules text,
  status           market_status not null default 'open',

  yes_bid          numeric(8,4),
  yes_ask          numeric(8,4),
  no_bid           numeric(8,4),
  no_ask           numeric(8,4),
  last_price       numeric(8,4),
  mid_price        numeric(8,4),
  price_24h_ago    numeric(8,4),

  volume_24h       numeric(20,2) not null default 0,
  volume_total     numeric(20,2) not null default 0,
  open_interest    numeric(20,2) not null default 0,
  liquidity        numeric(20,2) not null default 0,

  tick_cents       numeric(8,4) not null default 1,
  min_order_size   numeric(20,2) not null default 1,

  -- Everything the adapter needs to fetch this market's book again.
  book_ref         jsonb not null,

  open_time        timestamptz,
  close_time       timestamptz,
  resolved_at      timestamptz,
  resolution       outcome_side,
  resolution_note  text,

  data_tier        text not null default 'cold' check (data_tier in ('hot','warm','cold')),
  book_updated_at  timestamptz,
  meta_updated_at  timestamptz not null default now(),
  raw              jsonb,
  unique (venue, venue_market_id)
);
create index if not exists markets_status_close_idx on public.markets (status, close_time);
create index if not exists markets_tier_idx on public.markets (data_tier) where status = 'open';
create index if not exists markets_volume_idx on public.markets (volume_24h desc) where status = 'open';
create index if not exists markets_event_idx on public.markets (event_id);
create index if not exists markets_question_trgm on public.markets using gin (question gin_trgm_ops);

-- Immutable book snapshots. Every fill points at exactly one of these, which is
-- what makes a fill price reconstructible months later.
create table if not exists public.book_snapshots (
  id           bigserial primary key,
  market_id    uuid not null references public.markets(id) on delete cascade,
  captured_at  timestamptz not null default now(),
  yes_bids     jsonb not null,
  yes_asks     jsonb not null,
  no_bids      jsonb not null,
  no_asks      jsonb not null,
  yes_mid      numeric(8,4),
  source_seq   bigint,
  -- Set when checkBookInvariants failed on capture. A snapshot that violates
  -- the mirror is kept for forensics but must never be quoted from.
  invariant_ok boolean not null default true
);
create index if not exists book_snapshots_market_time_idx
  on public.book_snapshots (market_id, captured_at desc);

create table if not exists public.price_candles (
  market_id  uuid not null references public.markets(id) on delete cascade,
  bucket     text not null,
  ts         timestamptz not null,
  o numeric(8,4), h numeric(8,4), l numeric(8,4), c numeric(8,4),
  v numeric(20,2) not null default 0,
  primary key (market_id, bucket, ts)
);

create table if not exists public.ingest_runs (
  id          bigserial primary key,
  job         text not null,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  duration_ms int,
  rows_written int not null default 0,
  errors      int not null default 0,
  detail      jsonb
);
create index if not exists ingest_runs_job_idx on public.ingest_runs (job, started_at desc);

insert into public.venues (code, display_name, base_url, unit_noun, fee_model) values
  ('polymarket','Polymarket','https://polymarket.com','shares',
   '{"kind":"none","note":"No explicit trading fee. Your cost is the spread; gas is not simulated."}'::jsonb),
  ('kalshi','Kalshi','https://kalshi.com','contracts',
   '{"kind":"kalshi_quadratic","rate":0.07,"note":"ceil(0.07 x contracts x price x (1 - price)), rounded up to the next cent."}'::jsonb)
on conflict (code) do update
  set fee_model = excluded.fee_model,
      unit_noun = excluded.unit_noun;
