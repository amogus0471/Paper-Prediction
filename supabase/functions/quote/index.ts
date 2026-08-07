// quote — price an order against the live book and hand back a signed,
// single-use, 10-second quote.
//
// The client never computes a price. It sends intent (market, side, size) and
// renders whatever comes back. Everything here derives from a stored
// book_snapshot row, so any quote can be reconstructed later from its
// snapshot_id.

import { ApiError, handler, json, rateLimit, requireDevice } from '../_shared/api.ts';
import {
  assertFresh,
  assertTradeable,
  priceOrder,
  type MarketRow,
  type Outcome,
  type Realism,
  type Side,
  type SnapshotRow,
} from '../_shared/fill.ts';
import { ticketMath, REALISM } from '../_shared/polyfill.js';

Deno.serve(
  handler('quote', async (req, body, db) => {
    const userId = await requireDevice(db, req, body);
    await rateLimit(db, userId, 'quote', 120, '1 minute');

    const marketId = String(body.market_id ?? '');
    const side = (body.side === 'sell' ? 'sell' : 'buy') as Side;
    const outcome = (body.outcome === 'no' ? 'no' : 'yes') as Outcome;
    const notional = body.notional != null ? Number(body.notional) : null;
    const qty = body.qty != null ? Number(body.qty) : null;

    if (!marketId) throw new ApiError('bad_request', 'market_id is required.', 400);
    if ((notional == null || !(notional > 0)) && (qty == null || !(qty > 0))) {
      throw new ApiError('bad_request', 'Provide a notional or a qty.', 400);
    }

    const { data: profile } = await db
      .from('profiles')
      .select('sim_realism')
      .eq('id', userId)
      .single();
    const realism = (profile?.sim_realism ?? 'realistic') as Realism;

    const { data: market, error: mErr } = await db
      .from('markets')
      .select(
        'id, venue, venue_market_id, question, status, close_time, tick_cents, min_order_size, book_ref',
      )
      .eq('id', marketId)
      .single();
    if (mErr || !market) throw new ApiError('not_found', 'Market not found.', 404);

    assertTradeable(market as MarketRow);

    const { data: snap, error: sErr } = await db
      .from('book_snapshots')
      .select('id, market_id, captured_at, yes_bids, yes_asks, no_bids, no_asks, yes_mid')
      .eq('market_id', marketId)
      .order('captured_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (sErr || !snap) {
      throw new ApiError(
        'stale_book',
        "We've lost the live book for this market. Try again shortly.",
        409,
        'No book snapshot has been captured for this market yet.',
      );
    }
    assertFresh(snap as SnapshotRow);

    const { data: venue } = await db
      .from('venues')
      .select('fee_model, unit_noun')
      .eq('code', market.venue)
      .single();

    const priced = priceOrder({
      snap: snap as SnapshotRow,
      market: market as MarketRow,
      side,
      outcome,
      realism,
      feeModel: venue?.fee_model,
      target: qty != null && qty > 0 ? { kind: 'qty', qty } : { kind: 'notional', usd: notional! },
      // Selling is always allowed out — the depth cap exists to stop oversized
      // entries, not to trap somebody in a position.
      enforceDepthCap: side === 'buy',
    });

    const { data: quote, error: qErr } = await db
      .from('quotes')
      .insert({
        user_id: userId,
        market_id: marketId,
        snapshot_id: snap.id,
        side,
        outcome,
        requested_notional: notional,
        requested_qty: qty,
        quoted_avg_price: priced.avgPrice,
        quoted_qty: priced.qty,
        quoted_cost: priced.cost,
        quoted_fee: priced.fee,
        book_mid: priced.bookMid,
        slippage_bps: priced.slippage,
        realism,
      })
      .select('id, expires_at')
      .single();
    if (qErr) throw new ApiError('quote_failed', qErr.message, 500);

    const math = ticketMath(priced.qty, priced.avgPrice, priced.fee);

    return json({
      ok: true,
      quote_id: quote.id,
      expires_at: quote.expires_at,
      snapshot_id: snap.id,
      book_captured_at: snap.captured_at,
      side,
      outcome,
      realism,
      unit_noun: venue?.unit_noun ?? 'contracts',
      avg_price: priced.avgPrice,
      qty: priced.qty,
      cost: math.cost,
      fee: math.fee,
      total_cost: math.totalCost,
      max_payout: math.maxPayout,
      max_profit: math.maxProfit,
      breakeven: math.breakevenCents,
      roi_pct: math.roiPct,
      slippage_bps: priced.slippage,
      book_mid: priced.bookMid,
      visible_depth: priced.depth,
      levels_consumed: priced.walk.levelsConsumed,
      partial: priced.walk.partial,
      latency_ms: REALISM[realism].latencyMs,
      scoring_eligible: REALISM[realism].scoringEligible,
      disclaimer: 'SIMULATED · NO REAL MONEY',
    });
  }),
);
