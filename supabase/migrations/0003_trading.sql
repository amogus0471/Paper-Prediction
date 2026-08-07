-- Ghostfill 0003 — portfolios, quotes, orders, fills, positions, ledger.
--
-- Nothing in this file is writable from a client. There are no INSERT/UPDATE/
-- DELETE policies anywhere on these tables (see 0005_rls.sql); every write goes
-- through an Edge Function holding service_role. That is the entire security
-- model, and it is what makes the leaderboard mean anything.

create table if not exists public.portfolios (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.profiles(id) on delete cascade,
  season_id         uuid references public.seasons(id),  -- null = lifetime book
  starting_balance  numeric(20,6) not null default 10000,
  cash_balance      numeric(20,6) not null default 10000,
  reserved_balance  numeric(20,6) not null default 0,
  realized_pnl      numeric(20,6) not null default 0,
  unrealized_pnl    numeric(20,6) not null default 0,
  equity            numeric(20,6) generated always as
                      (cash_balance + reserved_balance + unrealized_pnl) stored,
  peak_equity       numeric(20,6) not null default 10000,
  max_drawdown_pct  numeric(8,4) not null default 0,
  reset_count       int not null default 0,
  last_reset_at     timestamptz,
  created_at        timestamptz not null default now()
);
-- A user gets exactly one lifetime book and one book per season.
create unique index if not exists portfolios_user_season_idx
  on public.portfolios (user_id, season_id) where season_id is not null;
create unique index if not exists portfolios_user_lifetime_idx
  on public.portfolios (user_id) where season_id is null;

-- Server-signed quotes. An order MUST reference a live, unconsumed quote, which
-- is what stops a client from ever naming its own price.
create table if not exists public.quotes (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references public.profiles(id) on delete cascade,
  market_id          uuid not null references public.markets(id) on delete cascade,
  snapshot_id        bigint not null references public.book_snapshots(id),
  side               order_side not null,
  outcome            outcome_side not null,
  requested_notional numeric(20,6),
  requested_qty      numeric(20,2),
  quoted_avg_price   numeric(8,4) not null,
  quoted_qty         numeric(20,2) not null,
  quoted_cost        numeric(20,6) not null,
  quoted_fee         numeric(20,6) not null default 0,
  book_mid           numeric(8,4),
  slippage_bps       numeric(12,4),
  realism            sim_realism not null,
  created_at         timestamptz not null default now(),
  expires_at         timestamptz not null default (now() + interval '10 seconds'),
  consumed_at        timestamptz
);
create index if not exists quotes_user_idx on public.quotes (user_id, created_at desc);
create index if not exists quotes_live_idx on public.quotes (expires_at) where consumed_at is null;

create table if not exists public.orders (
  id              uuid primary key default gen_random_uuid(),
  portfolio_id    uuid not null references public.portfolios(id) on delete cascade,
  user_id         uuid not null references public.profiles(id) on delete cascade,
  market_id       uuid not null references public.markets(id),
  quote_id        uuid references public.quotes(id),
  idempotency_key text not null,

  side            order_side not null,
  outcome         outcome_side not null,
  type            order_type not null default 'market',
  limit_price     numeric(8,4),
  qty_requested   numeric(20,2) not null,
  qty_filled      numeric(20,2) not null default 0,
  avg_fill_price  numeric(8,4),
  fee_paid        numeric(20,6) not null default 0,
  status          order_status not null default 'pending',
  reject_reason   text,
  reject_detail   text,
  realism         sim_realism not null default 'realistic',

  time_in_force   text not null default 'gtc',
  expires_at      timestamptz,

  -- Recorded for forensics only. Never trusted for anything.
  client_ts       timestamptz,
  server_ts       timestamptz not null default now(),
  filled_at       timestamptz,
  cancelled_at    timestamptz,

  unique (user_id, idempotency_key),
  constraint limit_orders_need_a_price check (type <> 'limit' or limit_price is not null)
);
create index if not exists orders_portfolio_idx on public.orders (portfolio_id, server_ts desc);
create index if not exists orders_resting_idx on public.orders (market_id, status)
  where status in ('open','partial');

create table if not exists public.fills (
  id            bigserial primary key,
  order_id      uuid not null references public.orders(id) on delete cascade,
  portfolio_id  uuid not null references public.portfolios(id) on delete cascade,
  market_id     uuid not null references public.markets(id),
  -- The snapshot this fill was priced against. Drop this and the whole
  -- auditability claim collapses.
  snapshot_id   bigint not null references public.book_snapshots(id),

  side          order_side not null,
  outcome       outcome_side not null,
  qty           numeric(20,2) not null check (qty > 0),
  price         numeric(8,4) not null check (price > 0 and price < 100),
  notional      numeric(20,6) not null,
  fee           numeric(20,6) not null default 0,

  book_mid_at_fill numeric(8,4),   -- p_market for the calibration record
  slippage_bps     numeric(12,4),
  latency_ms       int,
  filled_at        timestamptz not null default now()
);
create index if not exists fills_portfolio_idx on public.fills (portfolio_id, filled_at desc);
create index if not exists fills_market_idx on public.fills (market_id, filled_at desc);

create table if not exists public.positions (
  id              uuid primary key default gen_random_uuid(),
  portfolio_id    uuid not null references public.portfolios(id) on delete cascade,
  user_id         uuid not null references public.profiles(id) on delete cascade,
  market_id       uuid not null references public.markets(id),
  outcome         outcome_side not null,

  qty             numeric(20,2) not null default 0,
  avg_entry_price numeric(8,4) not null default 0,
  cost_basis      numeric(20,6) not null default 0,
  mark_price      numeric(8,4),
  market_value    numeric(20,6),
  unrealized_pnl  numeric(20,6) not null default 0,
  realized_pnl    numeric(20,6) not null default 0,
  fees_paid       numeric(20,6) not null default 0,

  -- Frozen at first entry. This pair is the forecast being scored: what you
  -- believed, versus what the market believed at that instant.
  entry_p_user    numeric(8,6),
  entry_p_market  numeric(8,6),
  entry_at        timestamptz,
  -- Instant mode never scores, so the flag rides along with the position.
  scoring_eligible boolean not null default true,

  is_open         boolean not null default true,
  closed_at       timestamptz,
  settled_at      timestamptz,
  outcome_result  boolean,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (portfolio_id, market_id, outcome)
);
create index if not exists positions_open_idx on public.positions (portfolio_id) where is_open;
create index if not exists positions_market_open_idx on public.positions (market_id) where is_open;
create index if not exists positions_settled_idx on public.positions (user_id, settled_at desc)
  where settled_at is not null;

-- Append-only ledger. Every balance change gets a row, and the nightly
-- integrity check asserts sum(amount) + starting_balance = cash_balance.
create table if not exists public.transactions (
  id            bigserial primary key,
  portfolio_id  uuid not null references public.portfolios(id) on delete cascade,
  kind          txn_kind not null,
  amount        numeric(20,6) not null,
  balance_after numeric(20,6) not null,
  order_id      uuid references public.orders(id) on delete set null,
  fill_id       bigint references public.fills(id) on delete set null,
  position_id   uuid references public.positions(id) on delete set null,
  memo          text,
  created_at    timestamptz not null default now()
);
create index if not exists transactions_portfolio_idx
  on public.transactions (portfolio_id, created_at desc);

-- Rate limiting lives in the database, not in memory: Edge Functions are
-- stateless and an in-process counter would reset on every cold start.
create table if not exists public.rate_events (
  id         bigserial primary key,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  kind       text not null,
  created_at timestamptz not null default now()
);
create index if not exists rate_events_lookup_idx on public.rate_events (user_id, kind, created_at desc);
