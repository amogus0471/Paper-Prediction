// portfolio — everything the Dashboard, Positions and Record screens render.
//
// The trading tables are deny-all to clients, so this is the only read path to
// them. One round trip, because a side panel that fires six requests on open
// feels slow no matter how fast each one is.

import { ApiError, handler, json, requireDevice } from '../_shared/api.ts';

Deno.serve(
  handler('portfolio', async (req, body, db) => {
    const userId = await requireDevice(db, req, body);

    const { data: portfolio, error: pErr } = await db
      .from('portfolios')
      .select(
        'id, starting_balance, cash_balance, reserved_balance, realized_pnl, ' +
          'unrealized_pnl, equity, peak_equity, created_at',
      )
      .eq('user_id', userId)
      .is('season_id', null)
      .single();
    if (pErr) throw new ApiError('portfolio_read_failed', pErr.message, 500);

    const [positions, orders, transactions, calibration, bins, byCategory] = await Promise.all([
      db
        .from('positions')
        .select(
          'id, market_id, outcome, qty, avg_entry_price, cost_basis, mark_price, market_value, ' +
            'unrealized_pnl, realized_pnl, fees_paid, entry_p_user, entry_p_market, entry_at, ' +
            'is_open, settled_at, outcome_result, scoring_eligible, ' +
            'markets(id, question, venue, yes_label, no_label, status, close_time, mid_price, ' +
            'yes_bid, yes_ask, no_bid, no_ask, events(category, title, image_url))',
        )
        .eq('portfolio_id', portfolio.id)
        .order('updated_at', { ascending: false })
        .limit(200),

      db
        .from('orders')
        .select(
          'id, market_id, side, outcome, type, qty_requested, qty_filled, avg_fill_price, ' +
            'fee_paid, status, reject_reason, reject_detail, realism, server_ts, filled_at, ' +
            'markets(question, venue, yes_label, no_label)',
        )
        .eq('portfolio_id', portfolio.id)
        .order('server_ts', { ascending: false })
        .limit(100),

      db
        .from('transactions')
        .select('id, kind, amount, balance_after, memo, created_at')
        .eq('portfolio_id', portfolio.id)
        .order('created_at', { ascending: false })
        .limit(200),

      db.rpc('compute_calibration', { p_user_id: userId }),
      db.rpc('calibration_bins', { p_user_id: userId }),
      db.rpc('calibration_by_category', { p_user_id: userId }),
    ]);

    const open = (positions.data ?? []).filter((p) => p.is_open);
    const settled = (positions.data ?? []).filter((p) => p.settled_at != null);

    // The equity curve is rebuilt from the ledger rather than stored, so it can
    // never disagree with the balance it is drawn beside.
    const ledger = [...(transactions.data ?? [])].reverse();
    const curve = ledger.map((t) => ({
      ts: t.created_at,
      equity: Number(t.balance_after),
    }));

    const filled = (orders.data ?? []).filter((o) => o.status === 'filled' || o.status === 'partial');
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const todayPnl = ledger
      .filter((t) => new Date(t.created_at) >= todayStart)
      .filter((t) => t.kind === 'settlement' || t.kind === 'fill_credit' || t.kind === 'fee')
      .reduce((s, t) => s + Number(t.amount), 0);

    const cal = Array.isArray(calibration.data) ? calibration.data[0] : calibration.data;

    return json({
      ok: true,
      portfolio,
      stats: {
        equity: Number(portfolio.equity),
        return_pct:
          Number(portfolio.starting_balance) > 0
            ? ((Number(portfolio.equity) - Number(portfolio.starting_balance)) /
                Number(portfolio.starting_balance)) *
              100
            : 0,
        today_pnl: Math.round(todayPnl * 1e6) / 1e6,
        open_positions: open.length,
        settled_positions: settled.length,
        total_trades: filled.length,
        total_fees: filled.reduce((s, o) => s + Number(o.fee_paid ?? 0), 0),
        win_rate:
          settled.length > 0
            ? settled.filter((p) => p.outcome_result === true).length / settled.length
            : null,
        markets_traded: new Set(filled.map((o) => o.market_id)).size,
      },
      positions: positions.data ?? [],
      orders: orders.data ?? [],
      transactions: transactions.data ?? [],
      equity_curve: curve,
      calibration: cal ?? null,
      calibration_bins: bins.data ?? [],
      calibration_by_category: byCategory.data ?? [],
      disclaimer: 'SIMULATED · NO REAL MONEY',
    });
  }),
);
