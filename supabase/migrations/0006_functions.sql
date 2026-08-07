-- Ghostfill 0006 — server-side functions.
-- Every function is SECURITY DEFINER with a pinned search_path and is callable
-- only by service_role, i.e. only from an Edge Function.

-- ── Identity ────────────────────────────────────────────────────────────────

-- Handles are generated, not chosen: there is no sign-up form to choose one in.
create or replace function public.generate_handle()
returns text language plpgsql volatile
set search_path = public, pg_temp
as $$
declare
  adjectives text[] := array['calm','sharp','quiet','brisk','lucid','stoic','wry','keen','sly','bold',
                             'apt','deft','grim','vast','odd','fair','cool','warm','dry','clear'];
  nouns      text[] := array['otter','heron','lynx','raven','moth','fox','ibis','wren','shrew','marten',
                             'tern','vole','stoat','finch','crane','adder','hare','newt','pike','owl'];
  candidate  text;
begin
  for i in 1..40 loop
    candidate := adjectives[1 + floor(random() * array_length(adjectives,1))::int]
              || '_' || nouns[1 + floor(random() * array_length(nouns,1))::int]
              || '_' || lpad(floor(random() * 1000)::text, 3, '0');
    if not exists (select 1 from public.profiles where handle = candidate) then
      return candidate;
    end if;
  end loop;
  -- Fall back to something guaranteed unique rather than looping forever.
  return 'ghost_' || substr(replace(gen_random_uuid()::text,'-',''), 1, 12);
end;
$$;

-- Idempotent: the same device always resolves to the same profile, and a first
-- call also creates the lifetime portfolio and its opening ledger entry.
create or replace function public.ensure_profile(p_device_hash text)
returns uuid language plpgsql volatile
security definer set search_path = public, pg_temp
as $$
declare
  v_user_id      uuid;
  v_portfolio_id uuid;
begin
  select id into v_user_id from public.profiles where device_hash = p_device_hash;

  if v_user_id is null then
    insert into public.profiles (device_hash, handle, display_name, avatar_seed, onboarded_at)
    values (
      p_device_hash,
      public.generate_handle(),
      'Ghost Trader',
      substr(md5(p_device_hash), 1, 12),
      now()
    )
    returning id into v_user_id;

    update public.profiles
       set display_name = initcap(replace(handle, '_', ' '))
     where id = v_user_id;
  else
    update public.profiles set last_seen_at = now() where id = v_user_id;
  end if;

  select id into v_portfolio_id
    from public.portfolios where user_id = v_user_id and season_id is null;

  if v_portfolio_id is null then
    insert into public.portfolios (user_id, season_id)
    values (v_user_id, null)
    returning id into v_portfolio_id;

    insert into public.transactions (portfolio_id, kind, amount, balance_after, memo)
    values (v_portfolio_id, 'grant', 10000, 10000, 'Opening ghost balance');
  end if;

  return v_user_id;
end;
$$;

-- ── Rate limiting ───────────────────────────────────────────────────────────

-- Records the event and reports whether the user is over budget in one call, so
-- there is no window between checking and acting.
create or replace function public.check_rate_limit(
  p_user_id uuid,
  p_kind    text,
  p_limit   int,
  p_window  interval
) returns boolean language plpgsql volatile
security definer set search_path = public, pg_temp
as $$
declare
  v_count int;
begin
  delete from public.rate_events
   where user_id = p_user_id and created_at < now() - interval '2 hours';

  select count(*) into v_count
    from public.rate_events
   where user_id = p_user_id and kind = p_kind and created_at > now() - p_window;

  if v_count >= p_limit then
    return false;
  end if;

  insert into public.rate_events (user_id, kind) values (p_user_id, p_kind);
  return true;
end;
$$;

-- ── Calibration ─────────────────────────────────────────────────────────────

-- Mirrors summarizeCalibration() in packages/core. The CI is a normal
-- approximation on the paired Brier difference and is labelled "approximate"
-- wherever it is displayed; it is withheld entirely below n = 30.
create or replace function public.compute_calibration(
  p_user_id uuid,
  p_since   timestamptz default null
) returns table (
  n int, brier_user numeric, brier_market numeric, brier_skill numeric,
  reliability numeric, resolution numeric, uncertainty numeric,
  ci_low numeric, ci_high numeric, mean_edge_bps numeric
) language sql stable
security definer set search_path = public, pg_temp
as $$
  with recs as (
    select * from public.calibration_records
     where user_id = p_user_id
       and (p_since is null or resolved_at >= p_since)
  ),
  agg as (
    select count(*)::int                     as n,
           avg(brier_user)                   as bu,
           avg(brier_market)                 as bm,
           avg(outcome::numeric)             as base_rate,
           stddev_samp(brier_user - brier_market) as sd_diff,
           avg(edge_bps)                     as edge
      from recs
  ),
  bins as (
    select least(9, floor(p_user * 10)::int) as bin,
           count(*)                          as nk,
           avg(p_user)                       as pk,
           avg(outcome::numeric)             as ok
      from recs group by 1
  ),
  murphy as (
    -- power() and sqrt() return double precision, so every value that reaches
    -- round(numeric, int) is cast back explicitly.
    select (sum(nk * power(pk - ok, 2))::numeric) / nullif((select n from agg), 0) as reliability,
           (sum(nk * power(ok - (select base_rate from agg), 2))::numeric)
             / nullif((select n from agg), 0)                                     as resolution
      from bins
  ),
  ci as (
    select case when a.n >= 30 and a.bm > 0
             then (1.96 * (a.sd_diff / sqrt(a.n)::numeric) / a.bm) end as half_width
      from agg a
  )
  select
    a.n,
    round(a.bu, 6),
    round(a.bm, 6),
    case when a.bm > 0 then round(1 - (a.bu / a.bm), 6) end,
    round(m.reliability, 6),
    round(m.resolution, 6),
    round(a.base_rate * (1 - a.base_rate), 6),
    case when c.half_width is not null then round(1 - (a.bu / a.bm) - c.half_width, 6) end,
    case when c.half_width is not null then round(1 - (a.bu / a.bm) + c.half_width, 6) end,
    round(coalesce(a.edge, 0), 4)
  from agg a cross join murphy m cross join ci c;
$$;

create or replace function public.calibration_bins(p_user_id uuid)
returns table (bin int, n int, mean_predicted numeric, observed_frequency numeric)
language sql stable
security definer set search_path = public, pg_temp
as $$
  select least(9, floor(p_user * 10)::int) as bin,
         count(*)::int,
         round(avg(p_user), 6),
         round(avg(outcome::numeric), 6)
    from public.calibration_records
   where user_id = p_user_id
   group by 1 order by 1;
$$;

create or replace function public.calibration_by_category(p_user_id uuid)
returns table (category text, n int, brier_user numeric, brier_market numeric, brier_skill numeric)
language sql stable
security definer set search_path = public, pg_temp
as $$
  select category,
         count(*)::int,
         round(avg(brier_user), 6),
         round(avg(brier_market), 6),
         case when avg(brier_market) > 0
              then round(1 - avg(brier_user) / avg(brier_market), 6) end
    from public.calibration_records
   where user_id = p_user_id
   group by category
   order by count(*) desc;
$$;

-- ── Ledger integrity ────────────────────────────────────────────────────────

-- The nightly assertion: every portfolio's cash balance is exactly its opening
-- balance plus the sum of its ledger. A non-empty result is a real incident.
create or replace function public.check_ledger_integrity()
returns table (portfolio_id uuid, expected numeric, actual numeric, drift numeric)
language sql stable
security definer set search_path = public, pg_temp
as $$
  select p.id,
         round(coalesce(sum(t.amount), 0), 6) as expected,
         round(p.cash_balance, 6)             as actual,
         round(p.cash_balance - coalesce(sum(t.amount), 0), 6) as drift
    from public.portfolios p
    left join public.transactions t on t.portfolio_id = p.id
   group by p.id, p.cash_balance
  having abs(p.cash_balance - coalesce(sum(t.amount), 0)) > 0.000001;
$$;

-- Functions are server-only. An Edge Function holding service_role may call
-- them; a client holding the anon key may not.
revoke all on function public.ensure_profile(text)               from anon, authenticated;
revoke all on function public.check_rate_limit(uuid,text,int,interval) from anon, authenticated;
revoke all on function public.compute_calibration(uuid,timestamptz)   from anon, authenticated;
revoke all on function public.calibration_bins(uuid)             from anon, authenticated;
revoke all on function public.calibration_by_category(uuid)      from anon, authenticated;
revoke all on function public.check_ledger_integrity()           from anon, authenticated;
revoke all on function public.generate_handle()                  from anon, authenticated;
