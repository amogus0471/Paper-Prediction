// order-submit — turn a live quote into an auditable paper fill.
//
// The important thing this function does is REFUSE to fill against the book the
// user quoted from. It selects a snapshot taken at least `latency_ms` after the
// quote, re-walks that book, and rejects if the price moved more than 2%
// against them. That is the single most expensive lesson in trading and the
// whole reason this simulator is worth anything: your quote is not your fill.
//
// The ledger write itself happens inside record_order_fill(), one transaction
// under a row lock, because two orders in the same millisecond must not spend
// the same cash.

import { ApiError, handler, json, rateLimit, requireDevice } from '../_shared/api.ts';
import {
  assertTradeable,
  priceMovedAgainstUser,
  priceOrder,
  type MarketRow,
  type Outcome,
  type Realism,
  type Side,
  type SnapshotRow,
} from '../_shared/fill.ts';
import { REALISM, checkBookInvariants, createAdapters, midPrice } from '../_shared/polyfill.js';

const SNAPSHOT_COLS =
  'id, market_id, captured_at, yes_bids, yes_asks, no_bids, no_asks, yes_mid';

Deno.serve(
  handler('order-submit', async (req, body, db) => {
    const userId = await requireDevice(db, req, body);
    await rateLimit(db, userId, 'order', 30, '1 minute');
    await rateLimit(db, userId, 'order_hourly', 300, '1 hour');

    const quoteId = String(body.quote_id ?? '');
    const idempotencyKey = String(body.idempotency_key ?? '');
    if (!quoteId || !idempotencyKey) {
      throw new ApiError('bad_request', 'quote_id and idempotency_key are required.', 400);
    }

    const { data: quote, error: qErr } = await db
      .from('quotes')
      .select('*')
      .eq('id', quoteId)
      .eq('user_id', userId)
      .single();
    if (qErr || !quote) throw new ApiError('not_found', 'Quote not found.', 404);

    if (quote.consumed_at) {
      throw new ApiError('quote_expired', 'That quote was already used.', 409);
    }
    if (new Date(quote.expires_at).getTime() <= Date.now()) {
      throw new ApiError('quote_expired', 'Your quote expired. Refreshing…', 409);
    }

    const { data: market, error: mErr } = await db
      .from('markets')
      .select(
        'id, venue, venue_market_id, question, status, close_time, tick_cents, min_order_size, book_ref',
      )
      .eq('id', quote.market_id)
      .single();
    if (mErr || !market) throw new ApiError('not_found', 'Market not found.', 404);
    assertTradeable(market as MarketRow);

    const realism = quote.realism as Realism;
    const side = quote.side as Side;
    const outcome = quote.outcome as Outcome;
    const cfg = REALISM[realism];

    // ── Rule 3: latency replay ──────────────────────────────────────────────
    // Find the first snapshot captured at least latency_ms after the quote. If
    // ingestion has not produced one yet, capture a fresh book right now — by
    // definition it is later than the quote, and it is a real book, not a
    // simulated delay.
    const notBefore = new Date(new Date(quote.created_at).getTime() + cfg.latencyMs).toISOString();

    let fillSnap: SnapshotRow | null = null;
    const { data: existing } = await db
      .from('book_snapshots')
      .select(SNAPSHOT_COLS)
      .eq('market_id', quote.market_id)
      .gte('captured_at', notBefore)
      .order('captured_at', { ascending: true })
      .limit(1)
      .maybeSingle();

    if (existing) {
      fillSnap = existing as SnapshotRow;
    } else {
      fillSnap = await captureSnapshot(db, market as MarketRow, cfg.latencyMs, quote.created_at);
    }

    if (!fillSnap) {
      throw new ApiError(
        'stale_book',
        "We've lost the live book for this market. Try again shortly.",
        409,
      );
    }

    const { data: venue } = await db
      .from('venues')
      .select('fee_model')
      .eq('code', market.venue)
      .single();

    // Re-walk on the LATER book. Whatever comes out is the fill.
    const priced = priceOrder({
      snap: fillSnap,
      market: market as MarketRow,
      side,
      outcome,
      realism,
      feeModel: venue?.fee_model,
      target:
        quote.requested_qty != null && Number(quote.requested_qty) > 0
          ? { kind: 'qty', qty: Number(quote.requested_qty) }
          : { kind: 'notional', usd: Number(quote.requested_notional) },
      enforceDepthCap: side === 'buy',
    });

    if (priceMovedAgainstUser(Number(quote.quoted_avg_price), priced.avgPrice, side)) {
      // Burn the quote so the same stale price cannot be retried.
      await db.from('quotes').update({ consumed_at: new Date().toISOString() }).eq('id', quoteId);
      throw new ApiError(
        'price_moved',
        `Price moved from ${Number(quote.quoted_avg_price).toFixed(1)}¢ to ${priced.avgPrice.toFixed(1)}¢. Requote?`,
        409,
        'Your quote is not your fill — this is what latency costs on a real venue.',
      );
    }

    const latencyMs = Math.max(
      0,
      new Date(fillSnap.captured_at).getTime() - new Date(quote.created_at).getTime(),
    );

    // ── The atomic write ────────────────────────────────────────────────────
    const { data: result, error: rErr } = await db.rpc('record_order_fill', {
      p_user_id: userId,
      p_market_id: quote.market_id,
      p_quote_id: quoteId,
      p_idempotency_key: idempotencyKey,
      p_side: side,
      p_outcome: outcome,
      p_realism: realism,
      p_qty_requested:
        quote.requested_qty != null ? Number(quote.requested_qty) : priced.qty,
      p_qty: priced.qty,
      p_avg_price: priced.avgPrice,
      p_cost: priced.cost,
      p_fee: priced.fee,
      p_snapshot_id: fillSnap.id,
      p_book_mid: priced.bookMid,
      p_slippage_bps: priced.slippage,
      p_latency_ms: latencyMs,
      p_fills: priced.walk.fills,
      p_scoring_eligible: cfg.scoringEligible,
    });
    if (rErr) throw new ApiError('order_failed', rErr.message, 500);

    if (!result?.ok) {
      throw new ApiError(
        String(result?.reason ?? 'order_failed'),
        String(result?.detail ?? 'Order rejected.'),
        409,
        result?.detail ? String(result.detail) : undefined,
      );
    }

    const { data: portfolio } = await db
      .from('portfolios')
      .select('cash_balance, equity, realized_pnl, unrealized_pnl')
      .eq('user_id', userId)
      .is('season_id', null)
      .single();

    return json({
      ok: true,
      replayed: result.replayed ?? false,
      order_id: result.order_id,
      status: result.status,
      qty_filled: priced.qty,
      avg_fill_price: priced.avgPrice,
      cost: priced.cost,
      fee: priced.fee,
      realized: result.realized ?? 0,
      slippage_bps: priced.slippage,
      // The audit trail: this fill is reconstructible from this snapshot.
      snapshot_id: fillSnap.id,
      book_captured_at: fillSnap.captured_at,
      latency_ms: latencyMs,
      quoted_avg_price: Number(quote.quoted_avg_price),
      fills: priced.walk.fills,
      partial: priced.walk.partial,
      portfolio,
      disclaimer: 'SIMULATED · NO REAL MONEY',
    });
  }),
);

/**
 * Fetch a fresh book from the venue and store it as a snapshot.
 *
 * Waits out any remaining latency budget first so the captured book is
 * genuinely later than quote_time + latency_ms rather than merely newer than
 * the quote.
 */
async function captureSnapshot(
  db: ReturnType<typeof import('../_shared/api.ts').admin>,
  market: MarketRow,
  latencyMs: number,
  quotedAt: string,
): Promise<SnapshotRow | null> {
  const elapsed = Date.now() - new Date(quotedAt).getTime();
  const remaining = latencyMs - elapsed;
  if (remaining > 0) await new Promise((r) => setTimeout(r, Math.min(remaining, 1000)));

  const adapters = createAdapters();
  const adapter = adapters[market.venue as 'polymarket' | 'kalshi'];
  if (!adapter) return null;

  let book;
  try {
    book = await adapter.getOrderBook(market.book_ref);
  } catch {
    return null;
  }

  const ok = checkBookInvariants(book.yes, book.no).ok;
  const yesMid = midPrice(book.yes);

  const { data, error } = await db
    .from('book_snapshots')
    .insert({
      market_id: market.id,
      captured_at: new Date().toISOString(),
      yes_bids: book.yes.bids,
      yes_asks: book.yes.asks,
      no_bids: book.no.bids,
      no_asks: book.no.asks,
      yes_mid: yesMid,
      invariant_ok: ok,
    })
    .select(SNAPSHOT_COLS)
    .single();

  if (error) return null;

  await db
    .from('markets')
    .update({ book_updated_at: new Date().toISOString() })
    .eq('id', market.id);

  return data as SnapshotRow;
}
