import { ceilCents, roundMoney } from './decimal';
import type { FeeModel, OrderSide } from './types';

/**
 * Fee models are data, not code. They live in `venues.fee_model` as jsonb so a
 * venue changing its schedule is a row update, not a deploy. This function is
 * the only place that interprets them.
 *
 * @param qty        contracts / shares
 * @param priceCents average fill price in cents
 * @param side       buy or sell
 * @param multiplier realism multiplier (Brutal charges 1.5x, Instant 0x)
 * @returns fee in DOLLARS
 */
export function computeFee(
  model: FeeModel,
  qty: number,
  priceCents: number,
  side: OrderSide,
  multiplier = 1,
): number {
  if (!(qty > 0) || !(priceCents > 0) || multiplier === 0) return 0;

  const p = priceCents / 100; // probability / price in dollars
  let fee = 0;

  switch (model.kind) {
    case 'none':
      fee = 0;
      break;

    case 'bps': {
      // Both venues currently charge takers only, but the model carries maker
      // separately so resting limit fills can be priced correctly later.
      const bps = side === 'buy' ? model.takerBps : model.takerBps;
      fee = roundMoney((qty * p * bps) / 10000);
      break;
    }

    case 'kalshi_quadratic': {
      // Kalshi: fee = ceil(rate x C x P x (1-P)), rounded up to the next cent.
      // Peaks at a 50c price and vanishes at the extremes — cheap to bet on a
      // near-certainty, expensive to bet on a coin flip.
      fee = ceilCents(model.rate * qty * p * (1 - p));
      break;
    }
  }

  return roundMoney(fee * multiplier);
}

/** Parse a `venues.fee_model` jsonb blob into a typed model, defaulting to free. */
export function parseFeeModel(raw: unknown): FeeModel {
  if (!raw || typeof raw !== 'object') return { kind: 'none' };
  const o = raw as Record<string, unknown>;

  if (typeof o.rate === 'number' && (o.kind === 'kalshi_quadratic' || o.formula === 'quadratic')) {
    return { kind: 'kalshi_quadratic', rate: o.rate, note: str(o.note) };
  }
  if (typeof o.taker_bps === 'number' || typeof o.maker_bps === 'number') {
    return {
      kind: 'bps',
      takerBps: typeof o.taker_bps === 'number' ? o.taker_bps : 0,
      makerBps: typeof o.maker_bps === 'number' ? o.maker_bps : 0,
      note: str(o.note),
    };
  }
  return { kind: 'none', note: str(o.note) };
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/**
 * Defaults shipped with the schema. Kalshi's published formula is
 * `ceil(0.07 x C x P x (1-P))`; verify against the live fee schedule before
 * launch and update the row rather than this constant.
 */
export const DEFAULT_FEE_MODELS: Record<string, FeeModel> = {
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
