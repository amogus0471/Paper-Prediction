-- Ghostfill 0009 — market tiering and settlement.

/**
 * Hot / warm / cold tiering.
 *
 * A market is HOT the instant someone holds a position in it or has it on a
 * watchlist — those books must stay fresh enough to quote from. WARM is the
 * top of the volume ranking, so a market someone opens for the first time
 * already has a recent book instead of a stale-book rejection.
 */
create or replace function public.retier_markets(p_warm_count int default 250)
returns table (hot int, warm int, cold int)
language plpgsql volatile
security definer set search_path = public, pg_temp
as $$
declare
  v_hot int; v_warm int; v_cold int;
begin
  update public.markets set data_tier = 'cold'
   where status = 'open' and data_tier <> 'cold';

  with warm as (
    select id from public.markets
     where status = 'open'
     order by volume_24h desc
     limit p_warm_count
  )
  update public.markets m set data_tier = 'warm'
    from warm w where m.id = w.id;

  with hot as (
    select distinct market_id from public.positions where is_open
    union
    select distinct market_id from public.watchlist
    union
    select distinct market_id from public.quotes where created_at > now() - interval '10 minutes'
  )
  update public.markets m set data_tier = 'hot'
    from hot h where m.id = h.market_id and m.status = 'open';

  select count(*) filter (where data_tier = 'hot'),
         count(*) filter (where data_tier = 'warm'),
         count(*) filter (where data_tier = 'cold')
    into v_hot, v_warm, v_cold
    from public.markets where status = 'open';

  return query select v_hot, v_warm, v_cold;
end;
$$;

/**
 * Settle one position: pay $1 per winning contract, $0 per losing one, write
 * the ledger entry, close the position, and record the calibration row.
 *
 * A VOID (p_resolution is null) refunds cost basis and writes NO calibration
 * record — a void is not a forecast error and must never move a skill score.
 */
create or replace function public.settle_position(
  p_position_id uuid,
  p_resolution  outcome_side,   -- null = void / refund
  p_category    text default 'other'
) returns jsonb language plpgsql volatile
security definer set search_path = public, pg_temp
as $$
declare
  v_pos       public.positions%rowtype;
  v_portfolio public.portfolios%rowtype;
  v_won       boolean;
  v_payout    numeric;
  v_realized  numeric;
  v_balance   numeric;
  v_outcome   int;
begin
  select * into v_pos from public.positions where id = p_position_id for update;
  if not found or v_pos.settled_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'already_settled');
  end if;

  select * into v_portfolio from public.portfolios where id = v_pos.portfolio_id for update;

  if p_resolution is null then
    -- Void: hand back exactly what was paid.
    v_payout   := v_pos.cost_basis;
    v_realized := 0;
    v_won      := null;
  else
    v_won      := (v_pos.outcome = p_resolution);
    v_payout   := case when v_won then round(v_pos.qty * 1, 6) else 0 end;
    v_realized := round(v_payout - v_pos.cost_basis, 6);
  end if;

  v_balance := round(v_portfolio.cash_balance + v_payout, 6);

  insert into public.transactions (portfolio_id, kind, amount, balance_after, position_id, memo)
  values (
    v_pos.portfolio_id,
    case when p_resolution is null then 'adjustment' else 'settlement' end,
    round(v_payout, 6), v_balance, v_pos.id,
    case when p_resolution is null
         then 'Market voided - cost refunded'
         else format('Settled %s: %s', v_pos.outcome, case when v_won then 'won' else 'lost' end) end
  );

  update public.portfolios
     set cash_balance   = v_balance,
         realized_pnl   = round(realized_pnl + v_realized, 6),
         unrealized_pnl = round(unrealized_pnl - v_pos.unrealized_pnl, 6),
         peak_equity    = greatest(peak_equity, v_balance)
   where id = v_pos.portfolio_id;

  update public.positions
     set is_open        = false,
         qty            = 0,
         market_value   = 0,
         unrealized_pnl = 0,
         realized_pnl   = round(realized_pnl + v_realized, 6),
         outcome_result = v_won,
         settled_at     = now(),
         closed_at      = coalesce(closed_at, now()),
         updated_at     = now()
   where id = v_pos.id;

  -- The calibration record. Only for genuine resolutions, only when the trade
  -- was placed in a scoring-eligible realism mode.
  if p_resolution is not null and v_pos.scoring_eligible and v_pos.entry_p_user is not null then
    v_outcome := case when v_won then 1 else 0 end;

    insert into public.calibration_records (
      user_id, position_id, market_id, category,
      p_user, p_market, outcome,
      brier_user, brier_market, log_score_user, edge_bps, notional,
      entered_at, resolved_at
    ) values (
      v_pos.user_id, v_pos.id, v_pos.market_id, p_category,
      v_pos.entry_p_user, coalesce(v_pos.entry_p_market, v_pos.entry_p_user), v_outcome,
      power(v_pos.entry_p_user - v_outcome, 2)::numeric,
      power(coalesce(v_pos.entry_p_market, v_pos.entry_p_user) - v_outcome, 2)::numeric,
      (-ln(greatest(1e-9, case when v_outcome = 1 then v_pos.entry_p_user
                               else 1 - v_pos.entry_p_user end)))::numeric,
      ((coalesce(v_pos.entry_p_market, v_pos.entry_p_user) - v_pos.entry_p_user) * 10000)::numeric,
      v_pos.cost_basis,
      coalesce(v_pos.entry_at, v_pos.created_at), now()
    )
    on conflict (position_id) do nothing;
  end if;

  return jsonb_build_object(
    'ok', true, 'payout', v_payout, 'realized', v_realized,
    'won', v_won, 'cash_balance', v_balance
  );
end;
$$;

do $$
declare fn record;
begin
  for fn in
    select p.oid::regprocedure as sig from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('retier_markets','settle_position')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', fn.sig);
    execute format('grant execute on function %s to service_role', fn.sig);
  end loop;
end $$;
