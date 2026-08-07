import { clamp, floorQty, QTY_DP, roundMoney, roundPrice, roundQty, snapToTick } from './decimal';
import type { Ladder, Level, WalkFill, WalkResult, WalkTarget } from './types';

/**
 * Walk a real order book and produce an honest fill.
 *
 * The four rules of the fill engine live and die here:
 *   1. Never fill beyond visible depth. If the book shows 500 and you want
 *      2,000, you get 500 and the order is partial. No synthesized liquidity.
 *   2. (enforced by the caller via `depthNotional` + maxDepthFraction)
 *   3. (enforced by the caller — it re-walks a post-latency snapshot)
 *   4. No market impact modelling. The book does not react to you.
 *
 * `levels` must be sorted BEST FIRST. Adapters guarantee this.
 *
 * `tickCents` snaps the level prices onto the venue's grid so a fill price can
 * never claim a precision the venue does not actually quote at.
 */
export function walkBook(levels: Level[], target: WalkTarget, tickCents = 1): WalkResult {
  const fills: WalkFill[] = [];
  let remainingQty = target.kind === 'qty' ? target.qty : Number.POSITIVE_INFINITY;
  let remainingUsd = target.kind === 'notional' ? target.usd : Number.POSITIVE_INFINITY;
  let totalQty = 0;
  let cost = 0;

  if (!(remainingQty > 0) || !(remainingUsd > 0)) {
    return { fills, avgPrice: 0, totalQty: 0, cost: 0, partial: false, unfilledQty: 0, levelsConsumed: 0 };
  }

  /**
   * Why the walk stopped — the difference between "the book ran out" and "your
   * budget bought everything it could afford".
   *
   * Only the first is a partial fill. Quantities are floored to QTY_DP, so a
   * $100 order at 99.1c leaves ~0.009 of a cent that cannot buy another
   * hundredth of a share. That residue was being reported as "book ran out"
   * next to millions of dollars of visible depth, which is not a rounding
   * nitpick: it tells the user their order was truncated when it was filled.
   */
  let exhaustedBook = true;
  let lastPriceUsd = 0;

  for (const level of levels) {
    if (remainingQty <= 0 || remainingUsd <= 0) {
      exhaustedBook = false;
      break;
    }

    const rawPrice = level[0];
    const availableSize = level[1];
    if (!(availableSize > 0)) continue;

    // A price outside (0,100) is not a tradeable probability — skip rather than
    // trust it. A venue glitch must not become a free position.
    const priceCents = snapToTick(clamp(rawPrice, 0, 100), tickCents);
    if (!(priceCents > 0) || !(priceCents < 100)) continue;

    const priceUsd = priceCents / 100;

    // How much can we actually take here? The binding constraint of:
    // what's left to buy, what's left to spend, and what the level holds.
    const byQty = Math.min(remainingQty, availableSize);
    const byUsd = remainingUsd / priceUsd;
    // Floor, never round: rounding a partial unit up would overspend a budget
    // the user explicitly capped, and would claim depth the level did not hold.
    const take = floorQty(Math.min(byQty, byUsd, availableSize));
    if (!(take > 0)) {
      // The level had size; we simply could not afford a whole unit of it.
      exhaustedBook = false;
      break;
    }
    lastPriceUsd = priceUsd;

    const notional = roundMoney(take * priceUsd);

    fills.push({ price: priceCents, qty: take, notional });
    totalQty = roundQty(totalQty + take);
    cost = roundMoney(cost + notional);
    remainingQty -= take;
    remainingUsd -= notional;
  }

  // Cost is the sum of what we actually paid at each level, never a
  // recomputation from the average — that is the invariant the tests pin.
  const avgPrice = totalQty > 0 ? roundPrice((cost / totalQty) * 100) : 0;
  const unfilledQty = target.kind === 'qty' ? roundQty(Math.max(0, target.qty - totalQty)) : 0;

  // A budget walk is partial only when the book gave out with money still on
  // the table AND that money could have bought at least one more unit. Below
  // one unit there was nothing left to buy at any depth, so the order is done.
  const oneUnit = 10 ** -QTY_DP;
  const partial =
    target.kind === 'qty'
      ? unfilledQty > 0
      : exhaustedBook && totalQty > 0 && remainingUsd > lastPriceUsd * oneUnit;

  return {
    fills,
    avgPrice,
    totalQty,
    cost,
    partial,
    unfilledQty,
    levelsConsumed: fills.length,
  };
}

/** Total units visible on a ladder side. */
export function depthQty(levels: Level[]): number {
  let q = 0;
  for (const l of levels) if (l[1] > 0) q += l[1];
  return roundQty(q);
}

/** Total dollar value visible on a ladder side. This is what the 5% cap measures against. */
export function depthNotional(levels: Level[]): number {
  let usd = 0;
  for (const l of levels) {
    if (l[1] > 0 && l[0] > 0 && l[0] < 100) usd += (l[1] * l[0]) / 100;
  }
  return roundMoney(usd);
}

export function bestBid(ladder: Ladder): number | null {
  const l = ladder.bids[0];
  return l ? roundPrice(l[0]) : null;
}

export function bestAsk(ladder: Ladder): number | null {
  const l = ladder.asks[0];
  return l ? roundPrice(l[0]) : null;
}

/**
 * Mid price in cents, or null when the book is one-sided.
 *
 * The mid is `p_market` in the calibration record — the price the market
 * thought was fair at the moment you disagreed with it — so it matters as much
 * as the fill price does.
 */
export function midPrice(ladder: Ladder): number | null {
  const b = bestBid(ladder);
  const a = bestAsk(ladder);
  if (b == null && a == null) return null;
  if (b == null) return a;
  if (a == null) return b;
  return roundPrice((b + a) / 2);
}

export function spreadCents(ladder: Ladder): number | null {
  const b = bestBid(ladder);
  const a = bestAsk(ladder);
  if (b == null || a == null) return null;
  return roundPrice(a - b);
}

/**
 * Slippage of a fill against the book mid, in basis points, signed so that
 * positive always means "worse for the user".
 */
export function slippageBps(avgPriceCents: number, midCents: number, side: 'buy' | 'sell'): number {
  if (!(midCents > 0) || !(avgPriceCents > 0)) return 0;
  const raw = ((avgPriceCents - midCents) / midCents) * 10000;
  return roundPrice(side === 'buy' ? raw : -raw);
}

/**
 * The ladder a market order actually consumes.
 * Buying takes from asks; selling hits bids. Selling YES is not buying NO.
 */
export function takerLevels(ladder: Ladder, side: 'buy' | 'sell'): Level[] {
  return side === 'buy' ? ladder.asks : ladder.bids;
}

/**
 * Apply Brutal mode's adverse tick: you fill one tick worse than the book showed.
 * Buys pay more, sells receive less. Never crosses 0 or 100.
 */
export function applyAdverseTicks(
  levels: Level[],
  side: 'buy' | 'sell',
  ticks: number,
  tickCents: number,
): Level[] {
  if (!ticks) return levels;
  const delta = ticks * tickCents * (side === 'buy' ? 1 : -1);
  const out: Level[] = [];
  for (const l of levels) {
    const p = roundPrice(clamp(l[0] + delta, tickCents, 100 - tickCents));
    out.push([p, l[1]]);
  }
  return out;
}

/**
 * Ladder invariant check — the single most likely catastrophic bug in the
 * codebase, so it gets asserted on every snapshot rather than trusted.
 *
 * A YES bid at 7c IS a NO ask at 93c, same size. If these drift apart, the
 * adapter mis-parsed the venue payload and every fill price is silently wrong.
 */
export interface InvariantResult {
  ok: boolean;
  violations: string[];
  checked: number;
}

export function checkBookInvariants(
  yes: Ladder,
  no: Ladder,
  toleranceCents = 0.01,
): InvariantResult {
  const violations: string[] = [];
  let checked = 0;

  const pairs: [string, number | null, number | null][] = [
    ['best_yes_ask == 100 - best_no_bid', bestAsk(yes), bestBid(no) == null ? null : 100 - bestBid(no)!],
    ['best_no_ask == 100 - best_yes_bid', bestAsk(no), bestBid(yes) == null ? null : 100 - bestBid(yes)!],
    ['best_yes_bid == 100 - best_no_ask', bestBid(yes), bestAsk(no) == null ? null : 100 - bestAsk(no)!],
    ['best_no_bid == 100 - best_yes_ask', bestBid(no), bestAsk(yes) == null ? null : 100 - bestAsk(yes)!],
  ];

  for (const [label, lhs, rhs] of pairs) {
    if (lhs == null || rhs == null) continue; // one-sided book, nothing to compare
    checked++;
    if (Math.abs(lhs - rhs) > toleranceCents) {
      violations.push(`${label}: ${lhs} vs ${rhs} (delta ${roundPrice(lhs - rhs)})`);
    }
  }

  return { ok: violations.length === 0, violations, checked };
}

/** A ladder is well-formed when it is sorted best-first with no crossed prices. */
export function isSortedBestFirst(levels: Level[], side: 'bids' | 'asks'): boolean {
  for (let i = 1; i < levels.length; i++) {
    const prev = levels[i - 1]![0];
    const cur = levels[i]![0];
    if (side === 'bids' ? cur > prev : cur < prev) return false;
  }
  return true;
}
