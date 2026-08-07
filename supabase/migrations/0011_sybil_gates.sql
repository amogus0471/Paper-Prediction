-- Polyfill 0011 — raise the cost of a fake identity.
--
-- Device-key identity is deliberately frictionless: solo play should never ask
-- anyone to sign up. But `ensure_profile()` mints a fresh P$10,000 profile for
-- any string >= 16 chars, which is fine for solo play and an unmitigated Sybil
-- vector the moment a leaderboard exists: script 500 keys, take anti-correlated
-- positions across them, and one of them finishes top of the ladder by
-- arithmetic rather than by forecasting.
--
-- The master plan solved this with OAuth. The device-key pivot removed that
-- gate, so this restores the cost in two cheaper layers:
--
--   1. a per-IP cap on NEW profile creation (returning users are never blocked)
--   2. an eligibility gate that a fresh account cannot satisfy quickly:
--      >= 72h old, >= 10 trades, >= 5 markets, >= 2 categories
--
-- Neither stops a determined attacker outright. Together they turn "run a
-- script" into "run a script, wait three days, and generate real trading
-- activity across five markets on each of 500 accounts", which is a different
-- proposition. Ladder integrity also leans on winsorised returns and the 35%
-- calibration weight, which blunt the payoff even if someone pays that cost.

create table if not exists public.bootstrap_attempts (
  id         bigserial primary key,
  -- Salted hash, never a raw IP. We need to count, not to identify.
  ip_hash    text not null,
  created_at timestamptz not null default now()
);
create index if not exists bootstrap_attempts_lookup
  on public.bootstrap_attempts (ip_hash, created_at desc);

alter table public.bootstrap_attempts enable row level security;
revoke all on public.bootstrap_attempts from anon, authenticated;

/**
 * Create-or-return a profile, rate-limiting only CREATION.
 *
 * A returning device always resolves, no matter how busy its IP is — otherwise
 * one office, campus or carrier NAT would lock out every legitimate user behind
 * it. Only minting a brand-new identity is capped.
 */
create or replace function public.ensure_profile_guarded(
  p_device_hash text,
  p_ip_hash     text default null,
  p_daily_cap   int default 5
) returns jsonb language plpgsql volatile
security definer set search_path = public, pg_temp
as $$
declare
  v_user_id  uuid;
  v_recent   int;
  v_created  boolean := false;
begin
  select id into v_user_id from public.profiles where device_hash = p_device_hash;

  if v_user_id is null then
    if p_ip_hash is not null then
      delete from public.bootstrap_attempts where created_at < now() - interval '7 days';

      select count(*) into v_recent
        from public.bootstrap_attempts
       where ip_hash = p_ip_hash and created_at > now() - interval '24 hours';

      if v_recent >= p_daily_cap then
        return jsonb_build_object(
          'ok', false,
          'reason', 'bootstrap_rate_limited',
          'detail', 'Too many new profiles from this network today. Try again tomorrow.'
        );
      end if;

      insert into public.bootstrap_attempts (ip_hash) values (p_ip_hash);
    end if;

    v_created := true;
  end if;

  -- Delegate the actual create-or-return so there is one definition of what a
  -- new profile looks like.
  v_user_id := public.ensure_profile(p_device_hash);

  return jsonb_build_object('ok', true, 'user_id', v_user_id, 'created', v_created);
end;
$$;

/**
 * Is this profile allowed on the ladder?
 *
 * Returns the verdict plus every unmet requirement, so the UI can show
 * "4 more trades, 2 more categories" instead of a flat "not eligible" — a gate
 * you cannot see the far side of just reads as broken.
 */
create or replace function public.leaderboard_eligibility(p_user_id uuid)
returns jsonb language plpgsql stable
security definer set search_path = public, pg_temp
as $$
declare
  v_profile     public.profiles%rowtype;
  v_age_hours   numeric;
  v_trades      int;
  v_markets     int;
  v_categories  int;
  v_instant     int;
  v_flags       int;
  v_missing     text[] := '{}';
begin
  select * into v_profile from public.profiles where id = p_user_id;
  if not found then
    return jsonb_build_object('eligible', false, 'missing', array['no_profile']);
  end if;

  v_age_hours := extract(epoch from (now() - v_profile.created_at)) / 3600;

  select count(*), count(distinct o.market_id)
    into v_trades, v_markets
    from public.orders o
   where o.user_id = p_user_id
     and o.status in ('filled', 'partial')
     -- Instant mode never scores, so it never counts toward eligibility either.
     and o.realism <> 'instant';

  select count(distinct e.category) into v_categories
    from public.orders o
    join public.markets m on m.id = o.market_id
    join public.events  e on e.id = m.event_id
   where o.user_id = p_user_id
     and o.status in ('filled', 'partial')
     and o.realism <> 'instant';

  select count(*) into v_instant
    from public.orders o
   where o.user_id = p_user_id and o.realism = 'instant'
     and o.status in ('filled', 'partial');

  select count(*) into v_flags
    from public.integrity_events
   where user_id = p_user_id and severity >= 3;

  if v_age_hours < 72        then v_missing := v_missing || 'account_age_72h'; end if;
  if v_trades     < 10       then v_missing := v_missing || 'trades_10';        end if;
  if v_markets    < 5        then v_missing := v_missing || 'markets_5';        end if;
  if v_categories < 2        then v_missing := v_missing || 'categories_2';     end if;
  if v_flags      > 0        then v_missing := v_missing || 'integrity_flag';   end if;
  if v_profile.shadow_banned then v_missing := v_missing || 'shadow_banned';    end if;

  return jsonb_build_object(
    'eligible', cardinality(v_missing) = 0,
    'missing',  v_missing,
    'progress', jsonb_build_object(
      'account_age_hours', round(v_age_hours, 1),
      'trades',            v_trades,
      'markets',           v_markets,
      'categories',        v_categories,
      'instant_trades_excluded', v_instant
    )
  );
end;
$$;

/** Keep `profiles.is_leaderboard_eligible` in step with the computed verdict. */
create or replace function public.refresh_leaderboard_eligibility(p_user_id uuid)
returns boolean language plpgsql volatile
security definer set search_path = public, pg_temp
as $$
declare v_eligible boolean;
begin
  v_eligible := (public.leaderboard_eligibility(p_user_id) ->> 'eligible')::boolean;
  update public.profiles set is_leaderboard_eligible = v_eligible where id = p_user_id;
  return v_eligible;
end;
$$;

-- Same lockdown pattern as migration 0008: Postgres grants EXECUTE to PUBLIC by
-- default, so revoking from anon/authenticated alone would leave these callable
-- straight off the anon key via /rest/v1/rpc.
do $$
declare fn record;
begin
  for fn in
    select p.oid::regprocedure as sig from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'ensure_profile_guarded', 'leaderboard_eligibility', 'refresh_leaderboard_eligibility'
      )
  loop
    execute format('revoke all on function %s from public, anon, authenticated', fn.sig);
    execute format('grant execute on function %s to service_role', fn.sig);
  end loop;
end $$;
