-- Ghostfill 0005 — Row Level Security.
--
-- The anon key ships inside the extension bundle and is therefore public. RLS
-- is the only real access control, so it is on for every table without
-- exception.
--
-- The rule: reference data (what the venues publish) is world-readable. Every
-- table that holds a balance, an order, a position or a score is DENY-ALL to
-- clients — no select, no insert, no update, no delete, no policies at all.
-- Those tables are reachable only through Edge Functions using service_role,
-- which bypasses RLS. There is deliberately no client-side path to create an
-- order or move a balance.

alter table public.venues            enable row level security;
alter table public.seasons           enable row level security;
alter table public.profiles          enable row level security;
alter table public.events            enable row level security;
alter table public.markets           enable row level security;
alter table public.book_snapshots    enable row level security;
alter table public.price_candles     enable row level security;
alter table public.ingest_runs       enable row level security;
alter table public.portfolios        enable row level security;
alter table public.quotes            enable row level security;
alter table public.orders            enable row level security;
alter table public.fills             enable row level security;
alter table public.positions         enable row level security;
alter table public.transactions      enable row level security;
alter table public.rate_events       enable row level security;
alter table public.divisions         enable row level security;
alter table public.ladder_entries    enable row level security;
alter table public.calibration_records enable row level security;
alter table public.badges            enable row level security;
alter table public.user_badges       enable row level security;
alter table public.watchlist         enable row level security;
alter table public.integrity_events  enable row level security;

-- ── Public reference data: readable by anyone, writable by no one ────────────

drop policy if exists "venues readable" on public.venues;
create policy "venues readable" on public.venues
  for select to anon, authenticated using (true);

drop policy if exists "seasons readable" on public.seasons;
create policy "seasons readable" on public.seasons
  for select to anon, authenticated using (true);

drop policy if exists "events readable" on public.events;
create policy "events readable" on public.events
  for select to anon, authenticated using (true);

drop policy if exists "markets readable" on public.markets;
create policy "markets readable" on public.markets
  for select to anon, authenticated using (true);

drop policy if exists "books readable" on public.book_snapshots;
create policy "books readable" on public.book_snapshots
  for select to anon, authenticated using (true);

drop policy if exists "candles readable" on public.price_candles;
create policy "candles readable" on public.price_candles
  for select to anon, authenticated using (true);

drop policy if exists "badges readable" on public.badges;
create policy "badges readable" on public.badges
  for select to anon, authenticated using (true);

drop policy if exists "divisions readable" on public.divisions;
create policy "divisions readable" on public.divisions
  for select to anon, authenticated using (true);

-- ── Profiles: the public card only ──────────────────────────────────────────
--
-- RLS filters rows; column grants filter columns. Both are needed here — the
-- device hash is the closest thing to a credential in this system and must
-- never leave the server, even for a profile that is otherwise public.

drop policy if exists "public profiles readable" on public.profiles;
create policy "public profiles readable" on public.profiles
  for select to anon, authenticated
  using (is_public and not shadow_banned);

revoke all on public.profiles from anon, authenticated;
grant select (
  id, handle, display_name, avatar_seed, bio,
  is_public, shadow_banned, created_at
) on public.profiles to anon, authenticated;

-- ── Ladder: public standings only ───────────────────────────────────────────

drop policy if exists "ladder readable" on public.ladder_entries;
create policy "ladder readable" on public.ladder_entries
  for select to anon, authenticated
  using (
    is_eligible
    and exists (
      select 1 from public.profiles p
      where p.id = ladder_entries.user_id and p.is_public and not p.shadow_banned
    )
  );

-- ── DENY-ALL. No policies, by design. ───────────────────────────────────────
--
-- portfolios, quotes, orders, fills, positions, transactions, rate_events,
-- calibration_records, user_badges, watchlist, integrity_events, ingest_runs
--
-- RLS is enabled on each with zero policies, so every client read and write is
-- refused. Revoking the grants as well means a future policy added by mistake
-- still cannot expose them without someone also re-granting explicitly.

revoke all on public.portfolios         from anon, authenticated;
revoke all on public.quotes             from anon, authenticated;
revoke all on public.orders             from anon, authenticated;
revoke all on public.fills              from anon, authenticated;
revoke all on public.positions          from anon, authenticated;
revoke all on public.transactions       from anon, authenticated;
revoke all on public.rate_events        from anon, authenticated;
revoke all on public.calibration_records from anon, authenticated;
revoke all on public.user_badges        from anon, authenticated;
revoke all on public.watchlist          from anon, authenticated;
revoke all on public.integrity_events   from anon, authenticated;
revoke all on public.ingest_runs        from anon, authenticated;

-- Reference data stays select-only even at the grant layer.
revoke all on public.venues         from anon, authenticated;
revoke all on public.seasons        from anon, authenticated;
revoke all on public.events         from anon, authenticated;
revoke all on public.markets        from anon, authenticated;
revoke all on public.book_snapshots from anon, authenticated;
revoke all on public.price_candles  from anon, authenticated;
revoke all on public.badges         from anon, authenticated;
revoke all on public.divisions      from anon, authenticated;
revoke all on public.ladder_entries from anon, authenticated;

grant select on public.venues         to anon, authenticated;
grant select on public.seasons        to anon, authenticated;
grant select on public.events         to anon, authenticated;
grant select on public.markets        to anon, authenticated;
grant select on public.book_snapshots to anon, authenticated;
grant select on public.price_candles  to anon, authenticated;
grant select on public.badges         to anon, authenticated;
grant select on public.divisions      to anon, authenticated;
grant select on public.ladder_entries to anon, authenticated;
