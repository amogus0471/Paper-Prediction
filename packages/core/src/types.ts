/** Shared vocabulary. Everything downstream of a venue adapter speaks only this. */

export type VenueCode = 'polymarket' | 'kalshi';
export type OutcomeSide = 'yes' | 'no';
export type OrderSide = 'buy' | 'sell';
export type OrderType = 'market' | 'limit';
export type SimRealism = 'instant' | 'realistic' | 'brutal';

/**
 * One order book level: [price in CENTS (0..100), size in units].
 * Always sorted BEST FIRST — highest bid first, lowest ask first.
 * Venue adapters are responsible for the reordering; both Polymarket and Kalshi
 * hand back worst-first ladders and normalizing that is their job, not yours.
 */
export type Level = [priceCents: number, size: number];

export interface Ladder {
  bids: Level[];
  asks: Level[];
}

export interface NormalizedBook {
  marketId: string;
  capturedAt: Date;
  yes: Ladder;
  no: Ladder;
  sourceSeq?: number;
}

/** What the user is asking for: a share count, or a dollar budget. */
export type WalkTarget = { kind: 'qty'; qty: number } | { kind: 'notional'; usd: number };

export interface WalkFill {
  price: number; // cents
  qty: number;
  notional: number; // dollars, rounded
}

export interface WalkResult {
  fills: WalkFill[];
  /** Volume-weighted average price in cents. 0 when nothing filled. */
  avgPrice: number;
  totalQty: number;
  /** Dollars, exactly equal to the sum of fill notionals. */
  cost: number;
  /** True when the book ran out before the target was met. */
  partial: boolean;
  /** Units the book could not supply (qty targets only). */
  unfilledQty: number;
  /** Levels consumed. Useful for "you ate 4 levels of the book" copy. */
  levelsConsumed: number;
}

/** Realism mode parameters. Instant is tutorial-only and never scores. */
export interface RealismConfig {
  latencyMs: number;
  feeMultiplier: number;
  /** Extra adverse ticks applied to the fill price. Brutal charges 1. */
  adverseTicks: number;
  allowPartial: boolean;
  /** Instant mode prices at the mid and is excluded from the ladder + calibration. */
  usesMid: boolean;
  scoringEligible: boolean;
}

export const REALISM: Record<SimRealism, RealismConfig> = {
  instant: {
    latencyMs: 0,
    feeMultiplier: 0,
    adverseTicks: 0,
    allowPartial: false,
    usesMid: true,
    scoringEligible: false,
  },
  realistic: {
    latencyMs: 250,
    feeMultiplier: 1,
    adverseTicks: 0,
    allowPartial: true,
    usesMid: false,
    scoringEligible: true,
  },
  brutal: {
    latencyMs: 750,
    feeMultiplier: 1.5,
    adverseTicks: 1,
    allowPartial: true,
    usesMid: false,
    scoringEligible: true,
  },
};

/** Fee models are data, loaded from `venues.fee_model`, so they change without a deploy. */
export type FeeModel =
  | { kind: 'none'; note?: string }
  | { kind: 'bps'; takerBps: number; makerBps: number; note?: string }
  | { kind: 'kalshi_quadratic'; rate: number; note?: string };

export interface MarketRules {
  tickCents: number;
  minOrderSize: number;
  /** Ghostfill's own guardrail: max share of visible depth a single order may take. */
  maxDepthFraction: number;
}

export const DEFAULT_MARKET_RULES: MarketRules = {
  tickCents: 1,
  minOrderSize: 1,
  maxDepthFraction: 0.05,
};

/** Every rejection is a teaching moment, so every rejection has a code and copy. */
export type RejectCode =
  | 'insufficient_funds'
  | 'market_closed'
  | 'stale_book'
  | 'quote_expired'
  | 'price_moved'
  | 'size_exceeds_depth'
  | 'below_min_size'
  | 'invalid_tick'
  | 'rate_limited'
  | 'position_limit'
  | 'no_liquidity'
  | 'resolution_lockout'
  | 'duplicate';
