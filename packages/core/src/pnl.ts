import { roundMoney, roundPrice, roundQty } from './decimal';

/**
 * Position accounting on a weighted-average cost basis.
 *
 * Prediction market contracts settle at $1 or $0, which makes P&L simple enough
 * that there is no excuse for getting it wrong. Every function here is pure and
 * returns a whole new position — no mutation, so a fill can be replayed.
 */

export interface PositionState {
  qty: number;
  /** Weighted average entry price, cents. */
  avgEntryPrice: number;
  /** Dollars tied up in the open quantity. */
  costBasis: number;
  realizedPnl: number;
  feesPaid: number;
}

export const EMPTY_POSITION: PositionState = {
  qty: 0,
  avgEntryPrice: 0,
  costBasis: 0,
  realizedPnl: 0,
  feesPaid: 0,
};

/** Add to a position. Recomputes the weighted average entry price. */
export function applyBuy(
  pos: PositionState,
  qty: number,
  priceCents: number,
  fee = 0,
): PositionState {
  if (!(qty > 0)) return pos;
  const addCost = roundMoney((qty * priceCents) / 100);
  const newQty = roundQty(pos.qty + qty);
  const newCost = roundMoney(pos.costBasis + addCost);
  return {
    qty: newQty,
    avgEntryPrice: newQty > 0 ? roundPrice((newCost / newQty) * 100) : 0,
    costBasis: newCost,
    realizedPnl: pos.realizedPnl,
    feesPaid: roundMoney(pos.feesPaid + fee),
  };
}

/**
 * Reduce a position. Realized P&L uses the weighted average cost basis, and
 * fees come out of realized P&L — the user should see the true number, not a
 * gross one that quietly hides the cost of trading.
 */
export function applySell(
  pos: PositionState,
  qty: number,
  priceCents: number,
  fee = 0,
): { position: PositionState; realized: number; proceeds: number } {
  const sellQty = roundQty(Math.min(qty, pos.qty));
  if (!(sellQty > 0)) {
    return { position: pos, realized: 0, proceeds: 0 };
  }

  const proceeds = roundMoney((sellQty * priceCents) / 100);
  const basisOut = roundMoney((sellQty * pos.avgEntryPrice) / 100);
  const realized = roundMoney(proceeds - basisOut - fee);

  const newQty = roundQty(pos.qty - sellQty);
  const newCost = roundMoney(Math.max(0, pos.costBasis - basisOut));

  return {
    position: {
      qty: newQty,
      // Average entry survives a partial close — that is what makes it an average.
      avgEntryPrice: newQty > 0 ? pos.avgEntryPrice : 0,
      costBasis: newQty > 0 ? newCost : 0,
      realizedPnl: roundMoney(pos.realizedPnl + realized),
      feesPaid: roundMoney(pos.feesPaid + fee),
    },
    realized,
    proceeds,
  };
}

/** Mark-to-market against the current book. */
export function unrealizedPnl(pos: PositionState, markPriceCents: number): number {
  if (!(pos.qty > 0)) return 0;
  const marketValue = roundMoney((pos.qty * markPriceCents) / 100);
  return roundMoney(marketValue - pos.costBasis);
}

export function marketValue(pos: PositionState, markPriceCents: number): number {
  return roundMoney((pos.qty * markPriceCents) / 100);
}

/**
 * Settlement. Winners get $1 per contract, losers get $0 — that is the whole
 * instrument. Realized P&L is proceeds minus what you paid.
 */
export function settlePosition(pos: PositionState, won: boolean): { payout: number; realized: number } {
  if (!(pos.qty > 0)) return { payout: 0, realized: 0 };
  const payout = won ? roundMoney(pos.qty * 1) : 0;
  return { payout, realized: roundMoney(payout - pos.costBasis) };
}

/** Portfolio equity = cash + reserved (locked by resting orders) + unrealized. */
export function equity(cash: number, reserved: number, unrealized: number): number {
  return roundMoney(cash + reserved + unrealized);
}

export function returnPct(equityNow: number, startingBalance: number): number {
  if (!(startingBalance > 0)) return 0;
  return roundPrice(((equityNow - startingBalance) / startingBalance) * 100);
}

/** Peak-to-trough drawdown as a percentage of the peak. */
export function drawdownPct(equityNow: number, peakEquity: number): number {
  if (!(peakEquity > 0)) return 0;
  return roundPrice(Math.max(0, ((peakEquity - equityNow) / peakEquity) * 100));
}

/**
 * The numbers the order ticket has to show before the user commits.
 * Payout is $1 per contract; profit is payout minus everything you paid.
 */
export interface TicketMath {
  cost: number;
  fee: number;
  totalCost: number;
  maxPayout: number;
  maxProfit: number;
  /** Price in cents at which this trade breaks even, fees included. */
  breakevenCents: number;
  /** Return on risk if the position wins, as a percentage. */
  roiPct: number;
}

export function ticketMath(qty: number, avgPriceCents: number, fee: number): TicketMath {
  const cost = roundMoney((qty * avgPriceCents) / 100);
  const totalCost = roundMoney(cost + fee);
  const maxPayout = roundMoney(qty * 1);
  const maxProfit = roundMoney(maxPayout - totalCost);
  return {
    cost,
    fee: roundMoney(fee),
    totalCost,
    maxPayout,
    maxProfit,
    breakevenCents: qty > 0 ? roundPrice((totalCost / qty) * 100) : 0,
    roiPct: totalCost > 0 ? roundPrice((maxProfit / totalCost) * 100) : 0,
  };
}
