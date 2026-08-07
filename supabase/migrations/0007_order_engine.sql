-- Ghostfill 0007 — the atomic order write.
--
-- Pricing happens in TypeScript (packages/core walkBook) against a stored book
-- snapshot, so a fill is reproducible from its snapshot_id forever. The LEDGER
-- MUTATION happens here, in one transaction under a row lock, because that is
-- the only place it can be made safe: two orders submitted in the same
-- millisecond must not both spend the same ghost cash, and a sequence of REST
-- calls from an Edge Function cannot promise that.
--
-- The function re-validates everything that depends on concurrent state —
-- balance, position size, quote consumption, idempotency — after taking the
-- lock. Checks the Edge Function already did against immutable data (tick grid,
-- market status, depth cap) are not repeated.

create or replace function public.record_order_fill(
  p_user_id         uuid,
  p_market_id       uuid,
  p_quote_id        uuid,
  p_idempotency_key text,
  p_side            order_side,
  p_outcome         outcome_side,
  p_realism         sim_realism,
  p_qty_requested   numeric,
  p_qty             numeric,
  p_avg_price       numeric,
  p_cost            numeric,
  p_fee             numeric,
  p_snapshot_id     bigint,
  p_book_mid        numeric,
  p_slippage_bps    numeric,
  p_latency_ms      int,
  p_fills           jsonb,
  p_scoring_eligible boolean default true
) returns jsonb language plpgsql volatile
security definer set search_path = public, pg_temp
as $$
declare
  v_portfolio      public.portfolios%rowtype;
  v_order_id       uuid;
  v_existing       public.orders%rowtype;
  v_position       public.positions%rowtype;
  v_fill           jsonb;
  v_fill_id        bigint;
  v_first_fill_id  bigint;
  v_total          numeric;
  v_new_balance    numeric;
  v_new_qty        numeric;
  v_new_cost       numeric;
  v_realized       numeric := 0;
  v_basis_out      numeric;
  v_proceeds       numeric;
  v_status         order_status;
  v_exposure       numeric;
  v_equity         numeric;
begin
  -- Idempotency first: a replay must return the original order untouched,
  -- never a second fill.
  select * into v_existing
    from public.orders
   where user_id = p_user_id and idempotency_key = p_idempotency_key;

  if found then
    return jsonb_build_object(
      'ok', true, 'replayed', true, 'order_id', v_existing.id,
      'status', v_existing.status, 'qty_filled', v_existing.qty_filled,
      'avg_fill_price', v_existing.avg_fill_price
    );
  end if;

  -- The lock. Everything after this is serialized per portfolio.
  select * into v_portfolio
    from public.portfolios
   where user_id = p_user_id and season_id is null
   for update;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_portfolio');
  end if;

  -- The quote must still be live and unconsumed. Consuming it here, inside the
  -- lock, is what makes a quote single-use under concurrency.
  if p_quote_id is not null then
    update public.quotes
       set consumed_at = now()
     where id = p_quote_id
       and user_id = p_user_id
       and consumed_at is null
       and expires_at > now();

    if not found then
      return jsonb_build_object('ok', false, 'reason', 'quote_expired');
    end if;
  end if;

  v_total := round(p_cost + p_fee, 6);

  if p_side = 'buy' then
    if v_total > v_portfolio.cash_balance then
      return jsonb_build_object(
        'ok', false, 'reason', 'insufficient_funds',
        'detail', format('Not enough ghost cash. You have G$%s; this costs G$%s.',
                         to_char(v_portfolio.cash_balance, 'FM999999990.00'),
                         to_char(v_total, 'FM999999990.00'))
      );
    end if;

    -- Position limit: no more than 20% of the bankroll in a single market.
    -- Position sizing is the point of the product, so this one is a hard stop.
    v_equity := v_portfolio.cash_balance + v_portfolio.reserved_balance + v_portfolio.unrealized_pnl;
    select coalesce(sum(cost_basis), 0) into v_exposure
      from public.positions
     where portfolio_id = v_portfolio.id and market_id = p_market_id and is_open;

    if v_equity > 0 and (v_exposure + v_total) > (v_equity * 0.20) then
      return jsonb_build_object(
        'ok', false, 'reason', 'position_limit',
        'detail', format(
          'This would put G$%s in one market — more than 20%% of your G$%s bankroll.',
          to_char(v_exposure + v_total, 'FM999999990.00'),
          to_char(v_equity, 'FM999999990.00'))
      );
    end if;
  else
    select * into v_position
      from public.positions
     where portfolio_id = v_portfolio.id and market_id = p_market_id and outcome = p_outcome;

    if not found or v_position.qty < p_qty then
      return jsonb_build_object(
        'ok', false, 'reason', 'insufficient_position',
        'detail', 'You do not hold enough of this outcome to sell.'
      );
    end if;
  end if;

  v_status := case when p_qty >= p_qty_requested then 'filled' else 'partial' end;

  insert into public.orders (
    portfolio_id, user_id, market_id, quote_id, idempotency_key,
    side, outcome, type, qty_requested, qty_filled, avg_fill_price,
    fee_paid, status, realism, filled_at
  ) values (
    v_portfolio.id, p_user_id, p_market_id, p_quote_id, p_idempotency_key,
    p_side, p_outcome, 'market', p_qty_requested, p_qty, p_avg_price,
    p_fee, v_status, p_realism, now()
  ) returning id into v_order_id;

  -- One row per book level consumed. This is the audit trail: each fill names
  -- the snapshot it was priced against.
  for v_fill in select * from jsonb_array_elements(p_fills) loop
    insert into public.fills (
      order_id, portfolio_id, market_id, snapshot_id,
      side, outcome, qty, price, notional, fee,
      book_mid_at_fill, slippage_bps, latency_ms
    ) values (
      v_order_id, v_portfolio.id, p_market_id, p_snapshot_id,
      p_side, p_outcome,
      (v_fill->>'qty')::numeric,
      (v_fill->>'price')::numeric,
      (v_fill->>'notional')::numeric,
      0,
      p_book_mid, p_slippage_bps, p_latency_ms
    ) returning id into v_fill_id;

    if v_first_fill_id is null then v_first_fill_id := v_fill_id; end if;
  end loop;

  if p_side = 'buy' then
    select * into v_position
      from public.positions
     where portfolio_id = v_portfolio.id and market_id = p_market_id and outcome = p_outcome;

    if found then
      v_new_qty  := round(v_position.qty + p_qty, 2);
      v_new_cost := round(v_position.cost_basis + p_cost, 6);
      update public.positions
         set qty             = v_new_qty,
             cost_basis      = v_new_cost,
             avg_entry_price = round((v_new_cost / nullif(v_new_qty, 0)) * 100, 4),
             fees_paid       = round(fees_paid + p_fee, 6),
             mark_price      = p_book_mid,
             is_open         = true,
             updated_at      = now()
       where id = v_position.id;
    else
      -- First entry freezes the forecast pair being scored: the price you paid
      -- (p_user) against the price the market was showing (p_market).
      insert into public.positions (
        portfolio_id, user_id, market_id, outcome, qty, avg_entry_price,
        cost_basis, fees_paid, mark_price,
        entry_p_user, entry_p_market, entry_at, scoring_eligible
      ) values (
        v_portfolio.id, p_user_id, p_market_id, p_outcome, p_qty, p_avg_price,
        p_cost, p_fee, p_book_mid,
        round(p_avg_price / 100, 6),
        round(coalesce(p_book_mid, p_avg_price) / 100, 6),
        now(), p_scoring_eligible
      ) returning * into v_position;
    end if;

    v_new_balance := round(v_portfolio.cash_balance - v_total, 6);

    insert into public.transactions (portfolio_id, kind, amount, balance_after, order_id, fill_id, position_id, memo)
    values (v_portfolio.id, 'fill_debit', round(-p_cost, 6),
            round(v_portfolio.cash_balance - p_cost, 6),
            v_order_id, v_first_fill_id, v_position.id,
            format('Buy %s %s @ %s c', p_qty, p_outcome, p_avg_price));

    if p_fee > 0 then
      insert into public.transactions (portfolio_id, kind, amount, balance_after, order_id, fill_id, position_id, memo)
      values (v_portfolio.id, 'fee', round(-p_fee, 6), v_new_balance,
              v_order_id, v_first_fill_id, v_position.id, 'Trading fee');
    end if;

  else
    -- Sell: realized P&L on a weighted average cost basis, fees deducted from
    -- realized so the number shown is the true one.
    v_proceeds  := p_cost;
    v_basis_out := round(p_qty * v_position.avg_entry_price / 100, 6);
    v_realized  := round(v_proceeds - v_basis_out - p_fee, 6);
    v_new_qty   := round(v_position.qty - p_qty, 2);
    v_new_cost  := round(greatest(0, v_position.cost_basis - v_basis_out), 6);

    update public.positions
       set qty          = v_new_qty,
           cost_basis   = case when v_new_qty > 0 then v_new_cost else 0 end,
           realized_pnl = round(realized_pnl + v_realized, 6),
           fees_paid    = round(fees_paid + p_fee, 6),
           mark_price   = p_book_mid,
           is_open      = v_new_qty > 0,
           closed_at    = case when v_new_qty > 0 then null else now() end,
           updated_at   = now()
     where id = v_position.id;

    v_new_balance := round(v_portfolio.cash_balance + v_proceeds - p_fee, 6);

    insert into public.transactions (portfolio_id, kind, amount, balance_after, order_id, fill_id, position_id, memo)
    values (v_portfolio.id, 'fill_credit', round(v_proceeds, 6),
            round(v_portfolio.cash_balance + v_proceeds, 6),
            v_order_id, v_first_fill_id, v_position.id,
            format('Sell %s %s @ %s c', p_qty, p_outcome, p_avg_price));

    if p_fee > 0 then
      insert into public.transactions (portfolio_id, kind, amount, balance_after, order_id, fill_id, position_id, memo)
      values (v_portfolio.id, 'fee', round(-p_fee, 6), v_new_balance,
              v_order_id, v_first_fill_id, v_position.id, 'Trading fee');
    end if;

    update public.portfolios
       set realized_pnl = round(realized_pnl + v_realized, 6)
     where id = v_portfolio.id;
  end if;

  update public.portfolios
     set cash_balance = v_new_balance,
         peak_equity  = greatest(peak_equity, v_new_balance + reserved_balance + unrealized_pnl)
   where id = v_portfolio.id;

  return jsonb_build_object(
    'ok', true,
    'replayed', false,
    'order_id', v_order_id,
    'status', v_status,
    'qty_filled', p_qty,
    'avg_fill_price', p_avg_price,
    'cost', p_cost,
    'fee', p_fee,
    'realized', v_realized,
    'cash_balance', v_new_balance,
    'position_id', v_position.id
  );
end;
$$;

-- Mark-to-market for every open position on a market whose book just moved.
create or replace function public.mark_positions(p_market_id uuid, p_yes_mid numeric)
returns int language plpgsql volatile
security definer set search_path = public, pg_temp
as $$
declare
  v_updated int;
begin
  update public.positions p
     set mark_price     = case when p.outcome = 'yes' then p_yes_mid else 100 - p_yes_mid end,
         market_value   = round(p.qty * (case when p.outcome = 'yes' then p_yes_mid else 100 - p_yes_mid end) / 100, 6),
         unrealized_pnl = round(
           p.qty * (case when p.outcome = 'yes' then p_yes_mid else 100 - p_yes_mid end) / 100 - p.cost_basis, 6),
         updated_at     = now()
   where p.market_id = p_market_id and p.is_open;

  get diagnostics v_updated = row_count;

  -- Roll the position-level marks up to the portfolio.
  update public.portfolios pf
     set unrealized_pnl = coalesce(agg.total, 0)
    from (
      select portfolio_id, round(sum(unrealized_pnl), 6) as total
        from public.positions where is_open group by portfolio_id
    ) agg
   where pf.id = agg.portfolio_id;

  return v_updated;
end;
$$;

revoke all on function public.record_order_fill(
  uuid,uuid,uuid,text,order_side,outcome_side,sim_realism,
  numeric,numeric,numeric,numeric,numeric,bigint,numeric,numeric,int,jsonb,boolean
) from anon, authenticated;
revoke all on function public.mark_positions(uuid, numeric) from anon, authenticated;
