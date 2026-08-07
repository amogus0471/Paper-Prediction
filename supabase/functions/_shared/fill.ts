// The server side of the fill engine.
//
// Everything here operates on a STORED book snapshot, never on a price the
// client sent. That is the whole architectural rule: the extension is a
// renderer, this is the exchange.

import {
  applyAdverseTicks,
  checkBookInvariants,
  computeFee,
  depthNotional,
  midPrice,
  parseFeeModel,
  REALISM,
  slippageBps,
  takerLevels,
  walkBook,
  type Ladder,
  type Level,
  type WalkResult,
} from './ghostfill.js';
import { ApiError } from './api.ts';

export type Realism = 'instant' | 'realistic' | 'brutal';
export type Side = 'buy' | 'sell';
export type Outcome = 'yes' | 'no';

export interface SnapshotRow {
  id: number;
  market_id: string;
  captured_at: string;
  yes_bids: Level[];
  yes_asks: Level[];
  no_bids: Level[];
  no_asks: Level[];
  yes_mid: number | null;
}

export interface MarketRow {
  id: string;
  venue: string;
  venue_market_id: string;
  question: string;
  status: string;
  close_time: string | null;
  tick_cents: number;
  min_order_size: number;
  book_ref: unknown;
}

/** How old a book may be before we refuse to quote from it at all. */
export const MAX_BOOK_AGE_MS = 30_000;
/** No single order may take more than this share of visible depth. */
export const MAX_DEPTH_FRACTION = 0.05;
/** How far the price may move against the user between quote and fill. */
export const PRICE_MOVE_TOLERANCE = 0.02;

export function laddersOf(snap: SnapshotRow): { yes: Ladder; no: Ladder } {
  return {
    yes: { bids: snap.yes_bids ?? [], asks: snap.yes_asks ?? [] },
    no: { bids: snap.no_bids ?? [], asks: snap.no_asks ?? [] },
  };
}

export function ladderFor(snap: SnapshotRow, outcome: Outcome): Ladder {
  const { yes, no } = laddersOf(snap);
  return outcome === 'yes' ? yes : no;
}

export function assertTradeable(market: MarketRow): void {
  if (market.status !== 'open') {
    throw new ApiError('market_closed', 'This market has closed.', 409);
  }
  if (market.close_time && new Date(market.close_time).getTime() <= Date.now()) {
    throw new ApiError('market_closed', 'This market has closed.', 409);
  }
}

export function assertFresh(snap: SnapshotRow): void {
  const age = Date.now() - new Date(snap.captured_at).getTime();
  if (age > MAX_BOOK_AGE_MS) {
    throw new ApiError(
      'stale_book',
      "We've lost the live book for this market. Try again shortly.",
      409,
      `Book is ${Math.round(age / 1000)}s old.`,
    );
  }
}

/**
 * Resolution front-running guard.
 *
 * A game ends at 22:14 and the venue settles at 22:31. In between, the price is
 * 99c and the outcome is already public. Buying there is not forecasting, it is
 * collecting — so trading is frozen once the book has effectively resolved.
 */
export function assertNotResolved(ladder: Ladder): void {
  const bid = ladder.bids[0]?.[0] ?? null;
  const ask = ladder.asks[0]?.[0] ?? null;
  if (bid == null || ask == null) return;
  const spread = ask - bid;
  if (spread < 2 && (bid >= 97 || ask <= 3)) {
    throw new ApiError(
      'resolution_lockout',
      'This market is already priced as a near-certainty. Trading it now would be front-running the result, not forecasting it.',
      409,
    );
  }
}

export interface PricedFill {
  walk: WalkResult;
  avgPrice: number;
  qty: number;
  cost: number;
  fee: number;
  totalCost: number;
  bookMid: number | null;
  slippage: number;
  depth: number;
}

/**
 * Price an order against one snapshot. Used identically by `quote` and by
 * `order-submit` — the only difference is which snapshot gets passed in.
 */
export function priceOrder(opts: {
  snap: SnapshotRow;
  market: MarketRow;
  side: Side;
  outcome: Outcome;
  realism: Realism;
  feeModel: unknown;
  target: { kind: 'qty'; qty: number } | { kind: 'notional'; usd: number };
  /** Skip the depth cap when closing a position — you can always exit. */
  enforceDepthCap?: boolean;
}): PricedFill {
  const cfg = REALISM[opts.realism];
  const ladder = ladderFor(opts.snap, opts.outcome);
  const bookMid = midPrice(ladder);

  assertNotResolved(ladder);

  // A snapshot whose mirror invariants failed means the adapter mis-parsed the
  // venue payload. Refusing to quote is the only safe response.
  const { yes, no } = laddersOf(opts.snap);
  if (!checkBookInvariants(yes, no).ok) {
    throw new ApiError(
      'stale_book',
      "We've lost the live book for this market. Try again shortly.",
      409,
      'Book snapshot failed its mirror invariants.',
    );
  }

  let levels: Level[] = takerLevels(ladder, opts.side);
  if (levels.length === 0) {
    throw new ApiError(
      'no_liquidity',
      'There is no visible liquidity on that side of the book right now.',
      409,
    );
  }

  const depth = depthNotional(levels);

  // Brutal mode fills one tick worse than the book showed.
  if (cfg.adverseTicks > 0) {
    levels = applyAdverseTicks(levels, opts.side, cfg.adverseTicks, opts.market.tick_cents);
  }

  // Instant mode is the tutorial: one bottomless level at the mid of whichever
  // side is being traded, so nothing ever partials and nothing ever scores.
  // `bookMid` is already this outcome's mid, since `ladder` is this outcome's.
  if (cfg.usesMid && bookMid != null) {
    levels = [[bookMid, Number.MAX_SAFE_INTEGER]];
  }

  const walk = walkBook(levels, opts.target, opts.market.tick_cents);

  if (walk.totalQty <= 0) {
    throw new ApiError(
      'no_liquidity',
      'There is no visible liquidity on that side of the book right now.',
      409,
    );
  }

  if (walk.totalQty < opts.market.min_order_size) {
    throw new ApiError(
      'below_min_size',
      `Minimum order on this market is ${opts.market.min_order_size}.`,
      400,
    );
  }

  // Rule 2: cap size against visible depth. This is the single most important
  // anti-exploit in the product — without it the leaderboard belongs to whoever
  // finds the thinnest book.
  if (opts.enforceDepthCap !== false && depth > 0 && walk.cost > depth * MAX_DEPTH_FRACTION) {
    throw new ApiError(
      'size_exceeds_depth',
      "Larger than this market can absorb — in reality you'd move the price against yourself.",
      400,
      `That is G$${walk.cost.toFixed(2)} against G$${depth.toFixed(2)} of visible depth. Cap is 5%.`,
    );
  }

  const fee = computeFee(
    parseFeeModel(opts.feeModel),
    walk.totalQty,
    walk.avgPrice,
    opts.side,
    cfg.feeMultiplier,
  );

  return {
    walk,
    avgPrice: walk.avgPrice,
    qty: walk.totalQty,
    cost: walk.cost,
    fee,
    totalCost: Math.round((walk.cost + fee) * 1e6) / 1e6,
    bookMid,
    slippage: bookMid != null ? slippageBps(walk.avgPrice, bookMid, opts.side) : 0,
    depth,
  };
}

/**
 * Rule 3: your quote is not your fill.
 *
 * Returns true when the price moved against the user beyond tolerance between
 * quoting and submitting. Buys care about paying more; sells about receiving
 * less. A move in the user's favour is never a rejection.
 */
export function priceMovedAgainstUser(
  quotedPrice: number,
  filledPrice: number,
  side: Side,
): boolean {
  if (!(quotedPrice > 0)) return false;
  const delta = side === 'buy' ? filledPrice - quotedPrice : quotedPrice - filledPrice;
  return delta / quotedPrice > PRICE_MOVE_TOLERANCE;
}
