/**
 * The local fill engine.
 *
 * This is the same `walkBook` that the server path uses — imported from
 * @polyfill/core, property-tested at 99% coverage, not a second
 * implementation. The four honesty rules hold identically here:
 *
 *   1. Never fill beyond visible depth.
 *   2. Cap an order at 5% of visible depth.
 *   3. Replay latency: fill against a book fetched AFTER the quote.
 *   4. No market impact modelling, and Settings says so.
 *
 * A simulator that quotes with one engine and fills with another is how you
 * end up with a leaderboard nobody can trust, so there is only ever one.
 */

import {
  appendLink,
  applyAdverseTicks,
  checkBookInvariants,
  computeFee,
  depthNotional,
  midPrice,
  parseFeeModel,
  REALISM,
  slippageBps,
  takerLevels,
  ticketMath,
  walkBook,
  type FeeModel,
  type Ladder,
  type Level,
  type NormalizedBook,
  type OrderSide,
  type OutcomeSide,
  type SimRealism,
} from '@polyfill/core';
import {
  findPosition,
  marketKey,
  mutate,
  pushTxn,
  round2,
  round6,
  type LocalState,
  type StoredOrder,
  type StoredPosition,
} from './store';

export const MAX_DEPTH_FRACTION = 0.05;
export const PRICE_MOVE_TOLERANCE = 0.02;
export const MAX_BOOK_AGE_MS = 30_000;
export const POSITION_LIMIT_FRACTION = 0.2;
/** Quotes are single-use and short-lived, matching the server's `quotes` TTL. */
export const QUOTE_TTL_MS = 10_000;

/**
 * Quote IDs already spent.
 *
 * The service worker is a single context, so a module-level set is enough to
 * make a quote single-use — which is what stops a double-click on Place from
 * booking the same fill twice. Not persisted: a worker restart invalidates
 * every outstanding quote anyway, since they expire in ten seconds.
 */
const consumedQuotes = new Set<string>();

export const FEE_MODELS: Record<string, FeeModel> = {
  polymarket: {
    kind: 'none',
    note: 'No explicit trading fee. Your cost is the spread; gas is not simulated.',
  },
  kalshi: {
    kind: 'kalshi_quadratic',
    rate: 0.07,
    note: 'ceil(0.07 x contracts x price x (1 - price)), rounded up to the next cent.',
  },
};

export interface MarketMeta {
  venue: string;
  venueMarketId: string;
  question: string;
  yesLabel: string;
  noLabel: string;
  tickCents: number;
  minOrderSize: number;
  closeTime?: string;
  category?: string;
  /** Venue artwork, when the venue supplies any. Optional by design. */
  imageUrl?: string;
  /** Venue slug, kept for deep-linking back to the market page. */
  slug?: string;
}

export class OrderError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
  }
}

export interface QuoteResult {
  quoteId: string;
  quotedAt: string;
  side: OrderSide;
  outcome: OutcomeSide;
  realism: SimRealism;
  avgPrice: number;
  qty: number;
  cost: number;
  fee: number;
  totalCost: number;
  maxPayout: number;
  maxProfit: number;
  breakeven: number;
  roiPct: number;
  slippageBps: number;
  bookMid: number | null;
  visibleDepth: number;
  levelsConsumed: number;
  partial: boolean;
  latencyMs: number;
  scoringEligible: boolean;
  unitNoun: string;
}

function ladderFor(book: NormalizedBook, outcome: OutcomeSide): Ladder {
  return outcome === 'yes' ? book.yes : book.no;
}

/**
 * Resolution front-running guard. A game ends at 22:14 and the venue settles at
 * 22:31; in between the price is 99c and the result is already public. Buying
 * there is collecting, not forecasting.
 */
function assertNotResolved(ladder: Ladder): void {
  const bid = ladder.bids[0]?.[0] ?? null;
  const ask = ladder.asks[0]?.[0] ?? null;
  if (bid == null || ask == null) return;
  if (ask - bid < 2 && (bid >= 97 || ask <= 3)) {
    throw new OrderError(
      'resolution_lockout',
      'This market is already priced as a near-certainty.',
      'Trading it now would be front-running the result, not forecasting it.',
    );
  }
}

export interface PriceOpts {
  book: NormalizedBook;
  meta: MarketMeta;
  side: OrderSide;
  outcome: OutcomeSide;
  realism: SimRealism;
  target: { kind: 'qty'; qty: number } | { kind: 'notional'; usd: number };
  enforceDepthCap?: boolean;
}

export function priceOrder(opts: PriceOpts) {
  const cfg = REALISM[opts.realism];
  const ladder = ladderFor(opts.book, opts.outcome);
  const bookMid = midPrice(ladder);

  // A closed market still has a book hanging around on both venues, so without
  // this check the engine would happily fill an order on a question that has
  // already been decided.
  if (opts.meta.closeTime) {
    const closesAt = new Date(opts.meta.closeTime).getTime();
    if (Number.isFinite(closesAt) && closesAt <= Date.now()) {
      const mins = Math.round((Date.now() - closesAt) / 60000);
      throw new OrderError(
        'market_closed',
        'This market has closed.',
        mins < 60
          ? `It closed ${mins} minute${mins === 1 ? '' : 's'} ago.`
          : `It closed ${Math.round(mins / 60)} hour${Math.round(mins / 60) === 1 ? '' : 's'} ago.`,
      );
    }
  }

  assertNotResolved(ladder);

  // A book whose mirror invariants fail means the adapter mis-parsed the venue
  // payload. Refusing to price is the only safe response.
  if (!checkBookInvariants(opts.book.yes, opts.book.no).ok) {
    throw new OrderError(
      'stale_book',
      "We've lost the live book for this market.",
      'The book failed its mirror invariants, so no price from it can be trusted.',
    );
  }

  const age = Date.now() - new Date(opts.book.capturedAt).getTime();
  if (age > MAX_BOOK_AGE_MS) {
    throw new OrderError(
      'stale_book',
      "We've lost the live book for this market. Try again shortly.",
      `Book is ${Math.round(age / 1000)}s old.`,
    );
  }

  let levels: Level[] = takerLevels(ladder, opts.side);
  if (levels.length === 0) {
    throw new OrderError(
      'no_liquidity',
      'There is no visible liquidity on that side of the book right now.',
    );
  }

  const depth = depthNotional(levels);

  if (cfg.adverseTicks > 0) {
    levels = applyAdverseTicks(levels, opts.side, cfg.adverseTicks, opts.meta.tickCents);
  }
  // Instant mode is the tutorial: one bottomless level at the mid, never scores.
  if (cfg.usesMid && bookMid != null) {
    levels = [[bookMid, Number.MAX_SAFE_INTEGER]];
  }

  // walkBook snaps prices onto the venue's tick grid, which is right for a real
  // fill and wrong for instant mode: a 40/41 book has a 40.5c mid that would
  // snap straight back to the 41c ask, quietly making Instant identical to
  // Realistic. Instant is already the admittedly-unrealistic mode, so it prices
  // off-grid on purpose.
  const tickForWalk = cfg.usesMid ? 0 : opts.meta.tickCents;
  const walk = walkBook(levels, opts.target, tickForWalk);

  if (walk.totalQty <= 0) {
    throw new OrderError(
      'no_liquidity',
      'There is no visible liquidity on that side of the book right now.',
    );
  }
  if (walk.totalQty < opts.meta.minOrderSize) {
    throw new OrderError(
      'below_min_size',
      `Minimum order on this market is ${opts.meta.minOrderSize}.`,
    );
  }
  if (opts.enforceDepthCap !== false && depth > 0 && walk.cost > depth * MAX_DEPTH_FRACTION) {
    throw new OrderError(
      'size_exceeds_depth',
      "Larger than this market can absorb — in reality you'd move the price against yourself.",
      `P$${walk.cost.toFixed(2)} against P$${depth.toFixed(2)} of visible depth. Cap is 5%.`,
    );
  }

  const fee = computeFee(
    parseFeeModel(FEE_MODELS[opts.meta.venue] ?? { kind: 'none' }),
    walk.totalQty,
    walk.avgPrice,
    opts.side,
    cfg.feeMultiplier,
  );

  return {
    walk,
    fee,
    bookMid,
    depth,
    slippage: bookMid != null ? slippageBps(walk.avgPrice, bookMid, opts.side) : 0,
  };
}

export function buildQuote(opts: PriceOpts): QuoteResult {
  const priced = priceOrder(opts);
  const math = ticketMath(priced.walk.totalQty, priced.walk.avgPrice, priced.fee);
  const cfg = REALISM[opts.realism];

  return {
    quoteId: crypto.randomUUID(),
    quotedAt: new Date().toISOString(),
    side: opts.side,
    outcome: opts.outcome,
    realism: opts.realism,
    avgPrice: priced.walk.avgPrice,
    qty: priced.walk.totalQty,
    cost: math.cost,
    fee: math.fee,
    totalCost: math.totalCost,
    maxPayout: math.maxPayout,
    maxProfit: math.maxProfit,
    breakeven: math.breakevenCents,
    roiPct: math.roiPct,
    slippageBps: priced.slippage,
    bookMid: priced.bookMid,
    visibleDepth: priced.depth,
    levelsConsumed: priced.walk.levelsConsumed,
    partial: priced.walk.partial,
    latencyMs: cfg.latencyMs,
    scoringEligible: cfg.scoringEligible,
    unitNoun: opts.meta.venue === 'polymarket' ? 'shares' : 'contracts',
  };
}

/** Did the price move against the user beyond tolerance between quote and fill? */
export function priceMovedAgainstUser(
  quoted: number,
  filled: number,
  side: OrderSide,
): boolean {
  if (!(quoted > 0)) return false;
  const delta = side === 'buy' ? filled - quoted : quoted - filled;
  return delta / quoted > PRICE_MOVE_TOLERANCE;
}

export interface SubmitOpts {
  meta: MarketMeta;
  quote: QuoteResult;
  /** A book fetched AFTER the quote — this is rule 3, and the caller enforces it. */
  fillBook: NormalizedBook;
}

/**
 * Commit a fill to local state.
 *
 * Mirrors record_order_fill() in Postgres line for line: validate under the
 * lock, insert the order, insert the fills, upsert the position freezing the
 * forecast pair, write the ledger, move the cash.
 */
export async function submitOrder(opts: SubmitOpts): Promise<StoredOrder> {
  const { meta, quote, fillBook } = opts;
  const key = marketKey(meta.venue, meta.venueMarketId);

  // Single-use, before the mutation queue, so a double-click cannot slip a
  // second submission in behind the first one's await.
  if (consumedQuotes.has(quote.quoteId)) {
    throw new OrderError('duplicate', 'That order was already placed.');
  }
  const age = Date.now() - new Date(quote.quotedAt).getTime();
  if (age > QUOTE_TTL_MS) {
    throw new OrderError(
      'quote_expired',
      'Your quote expired. Refreshing…',
      `Quotes are good for ${QUOTE_TTL_MS / 1000} seconds; this one was ${Math.round(age / 1000)}s old.`,
    );
  }
  consumedQuotes.add(quote.quoteId);
  // Bound the set: anything this old is expired by definition.
  if (consumedQuotes.size > 200) consumedQuotes.clear();

  return mutate<StoredOrder>(async (state) => {
    // Re-walk on the LATER book. Whatever comes out is the fill.
    const priced = priceOrder({
      book: fillBook,
      meta,
      side: quote.side,
      outcome: quote.outcome,
      realism: quote.realism,
      target:
        quote.side === 'sell'
          ? { kind: 'qty', qty: quote.qty }
          : { kind: 'notional', usd: quote.cost },
      enforceDepthCap: quote.side === 'buy',
    });

    if (priceMovedAgainstUser(quote.avgPrice, priced.walk.avgPrice, quote.side)) {
      throw new OrderError(
        'price_moved',
        `Price moved from ${quote.avgPrice.toFixed(1)}¢ to ${priced.walk.avgPrice.toFixed(1)}¢. Requote?`,
        'Your quote is not your fill — this is what latency costs on a real venue.',
      );
    }

    const cost = priced.walk.cost;
    const fee = priced.fee;
    const total = round6(cost + fee);
    const existing = findPosition(state, key, quote.outcome);

    if (quote.side === 'buy') {
      if (total > state.cash) {
        throw new OrderError(
          'insufficient_funds',
          `Not enough sim cash. You have P$${state.cash.toFixed(2)}; this costs P$${total.toFixed(2)}.`,
        );
      }
      // No more than 20% of the bankroll in a single market. Position sizing is
      // the point of the product, so this one is a hard stop rather than a nag.
      const openCost = state.positions
        .filter((p) => p.isOpen)
        .reduce((s, p) => s + p.costBasis, 0);
      const equity = state.cash + openCost;
      const exposure = state.positions
        .filter((p) => p.isOpen && p.marketKey === key)
        .reduce((s, p) => s + p.costBasis, 0);
      if (equity > 0 && exposure + total > equity * POSITION_LIMIT_FRACTION) {
        throw new OrderError(
          'position_limit',
          `This would put more than 20% of your bankroll in one market.`,
          `P$${(exposure + total).toFixed(2)} of a P$${equity.toFixed(2)} bankroll. Position sizing is the point.`,
        );
      }
    } else if (!existing || existing.qty < priced.walk.totalQty) {
      throw new OrderError(
        'insufficient_position',
        'You do not hold enough of this outcome to sell.',
      );
    }

    const now = new Date().toISOString();
    let realized = 0;

    if (quote.side === 'buy') {
      if (existing) {
        const newQty = round2(existing.qty + priced.walk.totalQty);
        const newCost = round6(existing.costBasis + cost);
        existing.qty = newQty;
        existing.costBasis = newCost;
        existing.avgEntryPrice = round2((newCost / newQty) * 100);
        existing.feesPaid = round6(existing.feesPaid + fee);
        existing.markPrice = priced.bookMid;
      } else {
        state.positions.unshift({
          marketKey: key,
          venue: meta.venue,
          question: meta.question,
          // Frozen at entry: the Record screen splits calibration by category,
          // and re-deriving it later would depend on the venue still saying
          // the same thing about a market that has since resolved.
          category: meta.category ?? meta.venue,
          outcome: quote.outcome,
          qty: priced.walk.totalQty,
          avgEntryPrice: priced.walk.avgPrice,
          costBasis: cost,
          markPrice: priced.bookMid,
          realizedPnl: 0,
          feesPaid: fee,
          // Frozen at first entry: what you believed vs what the market did.
          entryPUser: round6(priced.walk.avgPrice / 100),
          entryPMarket: round6((priced.bookMid ?? priced.walk.avgPrice) / 100),
          entryAt: now,
          scoringEligible: REALISM[quote.realism].scoringEligible,
          isOpen: true,
          closeTime: meta.closeTime,
        });
      }

      pushTxn(state, 'fill_debit', -cost, `Buy ${priced.walk.totalQty} ${quote.outcome.toUpperCase()} @ ${priced.walk.avgPrice}¢`);
      if (fee > 0) pushTxn(state, 'fee', -fee, 'Trading fee');
    } else {
      const pos = existing!;
      const basisOut = round6((priced.walk.totalQty * pos.avgEntryPrice) / 100);
      realized = round6(cost - basisOut - fee);
      pos.qty = round2(pos.qty - priced.walk.totalQty);
      pos.costBasis = pos.qty > 0 ? round6(Math.max(0, pos.costBasis - basisOut)) : 0;
      pos.realizedPnl = round6(pos.realizedPnl + realized);
      pos.feesPaid = round6(pos.feesPaid + fee);
      pos.markPrice = priced.bookMid;
      if (pos.qty <= 0) {
        pos.isOpen = false;
        pos.closedAt = now;
      }

      pushTxn(state, 'fill_credit', cost, `Sell ${priced.walk.totalQty} ${quote.outcome.toUpperCase()} @ ${priced.walk.avgPrice}¢`);
      if (fee > 0) pushTxn(state, 'fee', -fee, 'Trading fee');
    }

    const ladder = ladderFor(fillBook, quote.outcome);
    const order: StoredOrder = {
      id: crypto.randomUUID(),
      ts: now,
      venue: meta.venue,
      marketKey: key,
      question: meta.question,
      side: quote.side,
      outcome: quote.outcome,
      status: priced.walk.partial ? 'partial' : 'filled',
      qtyRequested: quote.qty,
      qtyFilled: priced.walk.totalQty,
      avgPrice: priced.walk.avgPrice,
      quotedPrice: quote.avgPrice,
      cost,
      fee,
      realized: quote.side === 'sell' ? realized : undefined,
      slippageBps: priced.slippage,
      latencyMs: Math.max(
        0,
        new Date(fillBook.capturedAt).getTime() - new Date(quote.quotedAt).getTime(),
      ),
      realism: quote.realism,
      fills: priced.walk.fills,
      // The audit trail. Keep the top of the book so any fill price can be
      // reconstructed later without trusting the stored average.
      bookSnapshot: {
        capturedAt: new Date(fillBook.capturedAt).toISOString(),
        bids: ladder.bids.slice(0, 12) as [number, number][],
        asks: ladder.asks.slice(0, 12) as [number, number][],
        mid: priced.bookMid,
      },
    };

    // Commit the fill to the tamper-evident chain before it is visible.
    state.chain ??= [];
    state.chain.push(
      await appendLink(state.chain[state.chain.length - 1] ?? null, {
        kind: 'fill',
        orderId: order.id,
        marketKey: key,
        side: order.side,
        outcome: order.outcome,
        qty: order.qtyFilled,
        price: order.avgPrice,
        cost: order.cost,
        fee: order.fee,
        bookCapturedAt: order.bookSnapshot.capturedAt,
        balanceAfter: state.cash,
        ts: now,
      }),
    );

    state.orders.unshift(order);
    if (state.orders.length > 500) state.orders.length = 500;

    const openCost = state.positions.filter((p) => p.isOpen).reduce((s, p) => s + p.costBasis, 0);
    state.peakEquity = Math.max(state.peakEquity, round6(state.cash + openCost));

    return order;
  });
}

/** Mark open positions on a market against a fresh book. */
export async function markPositions(key: string, book: NormalizedBook): Promise<void> {
  const yesMid = midPrice(book.yes);
  if (yesMid == null) return;
  await mutate((state) => {
    for (const p of state.positions) {
      if (p.marketKey !== key || !p.isOpen) continue;
      p.markPrice = p.outcome === 'yes' ? yesMid : round2(100 - yesMid);
    }
  });
}

/**
 * Settle a position at $1 or $0.
 *
 * A void refunds cost basis and writes no forecast record — a market that never
 * resolved is not a forecast you got wrong.
 */
export async function settleLocal(
  key: string,
  outcome: OutcomeSide | null,
): Promise<number> {
  return mutate((state) => {
    let settled = 0;
    for (const p of state.positions) {
      if (p.marketKey !== key || !p.isOpen) continue;
      const isVoid = outcome == null;
      const won = isVoid ? undefined : p.outcome === outcome;
      const payout = isVoid ? p.costBasis : won ? round6(p.qty * 1) : 0;

      pushTxn(
        state,
        isVoid ? 'reset' : 'settlement',
        payout,
        isVoid ? 'Market voided — cost refunded' : `Settled ${p.outcome.toUpperCase()}: ${won ? 'won' : 'lost'}`,
      );

      p.realizedPnl = round6(p.realizedPnl + (isVoid ? 0 : payout - p.costBasis));
      p.qty = 0;
      p.costBasis = 0;
      p.markPrice = isVoid ? null : won ? 100 : 0;
      p.isOpen = false;
      p.settledAt = new Date().toISOString();
      p.closedAt = p.closedAt ?? p.settledAt;
      p.outcomeResult = won;
      settled++;
    }
    return settled;
  });
}
