import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  applyAdverseTicks,
  bestAsk,
  bestBid,
  checkBookInvariants,
  depthNotional,
  depthQty,
  isSortedBestFirst,
  midPrice,
  slippageBps,
  spreadCents,
  takerLevels,
  walkBook,
} from '../src/book';
import type { Level } from '../src/types';

/** Generates a plausible ask ladder: ascending prices, positive sizes. */
const askLadder = fc
  .array(
    fc.record({
      price: fc.integer({ min: 1, max: 99 }),
      size: fc.double({ min: 0.1, max: 100000, noNaN: true, noDefaultInfinity: true }),
    }),
    { minLength: 1, maxLength: 25 },
  )
  .map((rows): Level[] => {
    const seen = new Set<number>();
    const uniq = rows.filter((r) => (seen.has(r.price) ? false : (seen.add(r.price), true)));
    return uniq
      .sort((a, b) => a.price - b.price)
      // 2 dp, because that is the finest size either venue actually quotes.
      .map((r): Level => [r.price, Math.round(r.size * 100) / 100]);
  });

describe('walkBook — the honesty contract', () => {
  it('never fills beyond visible depth', () => {
    fc.assert(
      fc.property(askLadder, fc.double({ min: 1, max: 1e7, noNaN: true }), (levels, wantQty) => {
        const available = depthQty(levels);
        const r = walkBook(levels, { kind: 'qty', qty: wantQty });
        expect(r.totalQty).toBeLessThanOrEqual(available + 1e-9);
      }),
      { numRuns: 400 },
    );
  });

  it('cost always equals the sum of qty x price across fills', () => {
    fc.assert(
      fc.property(askLadder, fc.double({ min: 1, max: 1e6, noNaN: true }), (levels, wantQty) => {
        const r = walkBook(levels, { kind: 'qty', qty: wantQty });
        const summed = r.fills.reduce((s, f) => s + f.notional, 0);
        expect(Math.abs(r.cost - summed)).toBeLessThan(1e-9);
        // Exact, not approximate: 2dp qty x 2dp cents lands inside 6dp money.
        for (const f of r.fills) {
          expect(Math.abs(f.notional - (f.qty * f.price) / 100)).toBeLessThan(1e-9);
        }
      }),
      { numRuns: 400 },
    );
  });

  it('avgPrice always sits between the best and worst level touched', () => {
    fc.assert(
      fc.property(askLadder, fc.double({ min: 1, max: 1e6, noNaN: true }), (levels, wantQty) => {
        const r = walkBook(levels, { kind: 'qty', qty: wantQty });
        fc.pre(r.totalQty > 0);
        const touched = r.fills.map((f) => f.price);
        const lo = Math.min(...touched);
        const hi = Math.max(...touched);
        expect(r.avgPrice).toBeGreaterThanOrEqual(lo - 1e-6);
        expect(r.avgPrice).toBeLessThanOrEqual(hi + 1e-6);
      }),
      { numRuns: 400 },
    );
  });

  it('never spends more than a notional budget', () => {
    fc.assert(
      fc.property(askLadder, fc.double({ min: 0.5, max: 1e6, noNaN: true }), (levels, budget) => {
        const r = walkBook(levels, { kind: 'notional', usd: budget });
        expect(r.cost).toBeLessThanOrEqual(budget + 1e-3);
      }),
      { numRuns: 400 },
    );
  });

  it('consumes the book in order — each fill is at a price at least as bad as the last', () => {
    fc.assert(
      fc.property(askLadder, fc.double({ min: 1, max: 1e6, noNaN: true }), (levels, wantQty) => {
        const r = walkBook(levels, { kind: 'qty', qty: wantQty });
        for (let i = 1; i < r.fills.length; i++) {
          expect(r.fills[i]!.price).toBeGreaterThanOrEqual(r.fills[i - 1]!.price);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('marks the order partial exactly when the book ran out', () => {
    const levels: Level[] = [
      [63, 300],
      [64, 200],
    ];
    const full = walkBook(levels, { kind: 'qty', qty: 500 });
    expect(full.partial).toBe(false);
    expect(full.totalQty).toBe(500);

    const short = walkBook(levels, { kind: 'qty', qty: 2000 });
    expect(short.partial).toBe(true);
    expect(short.totalQty).toBe(500);
    expect(short.unfilledQty).toBe(1500);
  });

  it('does not call a fully-spent budget partial just because change is left over', () => {
    // The screenshot bug. P$100 into a 99.1c ask with effectively unlimited
    // depth: quantities floor to 2dp, so 100.90 shares cost P$99.99 and about
    // nine tenths of a cent is left — not enough for another hundredth of a
    // share at any price. The book did not run out; the money did.
    const deep: Level[] = [
      [99.1, 500_000],
      [99.2, 500_000],
    ];
    const walk = walkBook(deep, { kind: 'notional', usd: 100 }, 0.1);

    expect(walk.partial).toBe(false);
    expect(walk.cost).toBeLessThanOrEqual(100);
    expect(walk.cost).toBeGreaterThan(99.9);
    // Still honest about the residue existing — we just do not call it partial.
    expect(walk.totalQty).toBeGreaterThan(100);
  });

  it('still reports partial when the budget really does outlive the book', () => {
    // 10 units at 50c is P$5 of depth against a P$100 order. That IS partial,
    // and the distinction from the case above is the whole point.
    const thin: Level[] = [[50, 10]];
    const walk = walkBook(thin, { kind: 'notional', usd: 100 });

    expect(walk.partial).toBe(true);
    expect(walk.totalQty).toBe(10);
    expect(walk.cost).toBe(5);
  });

  it('is not partial when the budget lands exactly on the book', () => {
    const exact: Level[] = [[50, 10]];
    const walk = walkBook(exact, { kind: 'notional', usd: 5 });
    expect(walk.partial).toBe(false);
    expect(walk.totalQty).toBe(10);
  });

  it('walks a thin book to a genuinely bad average — the lesson', () => {
    // 5 shares at 63c, then a wall of nothing until 92c.
    const levels: Level[] = [
      [63, 5],
      [92, 1000],
    ];
    const r = walkBook(levels, { kind: 'qty', qty: 105 });
    expect(r.totalQty).toBe(105);
    // 5 @ 63 + 100 @ 92 = 3.15 + 92.00 = 95.15 for 105 shares => 90.62c
    expect(r.cost).toBeCloseTo(95.15, 4);
    expect(r.avgPrice).toBeCloseTo(90.619, 2);
    expect(r.levelsConsumed).toBe(2);
  });

  it('produces exact arithmetic on a hand-checked book', () => {
    const levels: Level[] = [
      [13, 3009.62],
      [14, 36163.69],
      [15, 61528.15],
    ];
    const r = walkBook(levels, { kind: 'qty', qty: 10000 });
    expect(r.totalQty).toBe(10000);
    // 3009.62 @ 0.13 = 391.2506 ; 6990.38 @ 0.14 = 978.6532 ; total 1369.9038
    expect(r.cost).toBeCloseTo(1369.9038, 4);
    expect(r.avgPrice).toBeCloseTo(13.699, 3);
  });

  it('returns an empty result for non-positive targets', () => {
    const levels: Level[] = [[50, 100]];
    expect(walkBook(levels, { kind: 'qty', qty: 0 }).totalQty).toBe(0);
    expect(walkBook(levels, { kind: 'notional', usd: 0 }).cost).toBe(0);
    expect(walkBook(levels, { kind: 'qty', qty: -5 }).fills).toHaveLength(0);
  });

  it('skips junk levels rather than trusting them', () => {
    const levels: Level[] = [
      [0, 1000], // a 0c ask is not a tradeable price
      [100, 1000], // nor is 100c
      [-3, 500],
      [50, 0], // zero size
      [55, 10],
    ];
    const r = walkBook(levels, { kind: 'qty', qty: 100 });
    expect(r.totalQty).toBe(10);
    expect(r.fills).toHaveLength(1);
    expect(r.fills[0]!.price).toBe(55);
  });

  it('snaps level prices onto the venue tick grid', () => {
    const levels: Level[] = [[63.4567, 100]];
    expect(walkBook(levels, { kind: 'qty', qty: 10 }, 1).fills[0]!.price).toBe(63);
    expect(walkBook(levels, { kind: 'qty', qty: 10 }, 0.1).fills[0]!.price).toBe(63.5);
  });
});

describe('depth and top-of-book', () => {
  it('sums visible depth', () => {
    const levels: Level[] = [
      [50, 100],
      [51, 200],
    ];
    expect(depthQty(levels)).toBe(300);
    expect(depthNotional(levels)).toBeCloseTo(50 + 102, 4);
  });

  it('reads best bid, best ask, mid and spread from a best-first ladder', () => {
    const ladder = { bids: [[62, 10] as Level, [61, 20] as Level], asks: [[64, 10] as Level] };
    expect(bestBid(ladder)).toBe(62);
    expect(bestAsk(ladder)).toBe(64);
    expect(midPrice(ladder)).toBe(63);
    expect(spreadCents(ladder)).toBe(2);
  });

  it('falls back to the one side it has on a one-sided book', () => {
    expect(midPrice({ bids: [[40, 5]], asks: [] })).toBe(40);
    expect(midPrice({ bids: [], asks: [[60, 5]] })).toBe(60);
    expect(midPrice({ bids: [], asks: [] })).toBeNull();
    expect(spreadCents({ bids: [], asks: [[60, 5]] })).toBeNull();
  });

  it('selects asks for buys and bids for sells', () => {
    const ladder = { bids: [[62, 10] as Level], asks: [[64, 10] as Level] };
    expect(takerLevels(ladder, 'buy')).toBe(ladder.asks);
    expect(takerLevels(ladder, 'sell')).toBe(ladder.bids);
  });
});

describe('slippage', () => {
  it('is positive whenever the fill was worse than the mid, on both sides', () => {
    expect(slippageBps(64, 63, 'buy')).toBeGreaterThan(0);
    expect(slippageBps(62, 63, 'sell')).toBeGreaterThan(0);
    expect(slippageBps(62, 63, 'buy')).toBeLessThan(0);
    expect(slippageBps(64, 63, 'sell')).toBeLessThan(0);
  });

  it('is zero on a degenerate mid', () => {
    expect(slippageBps(64, 0, 'buy')).toBe(0);
    expect(slippageBps(0, 63, 'buy')).toBe(0);
  });
});

describe('brutal mode adverse ticks', () => {
  it('moves buys up and sells down by one tick, clamped inside the range', () => {
    const levels: Level[] = [
      [63, 10],
      [99, 10],
    ];
    expect(applyAdverseTicks(levels, 'buy', 1, 1)[0]![0]).toBe(64);
    expect(applyAdverseTicks(levels, 'sell', 1, 1)[0]![0]).toBe(62);
    // 99 + 1 tick would be 100, which is not a tradeable price.
    expect(applyAdverseTicks(levels, 'buy', 1, 1)[1]![0]).toBe(99);
    expect(applyAdverseTicks(levels, 'buy', 0, 1)).toBe(levels);
  });
});

describe('checkBookInvariants — the catastrophic-bug canary', () => {
  it('passes on a correctly mirrored book', () => {
    const yes = { bids: [[12, 100] as Level], asks: [[13, 200] as Level] };
    const no = { bids: [[87, 200] as Level], asks: [[88, 100] as Level] };
    const r = checkBookInvariants(yes, no);
    expect(r.ok).toBe(true);
    expect(r.checked).toBe(4);
  });

  it('catches a book where the NO side was not synthesized correctly', () => {
    const yes = { bids: [[12, 100] as Level], asks: [[13, 200] as Level] };
    const no = { bids: [[80, 200] as Level], asks: [[88, 100] as Level] };
    const r = checkBookInvariants(yes, no);
    expect(r.ok).toBe(false);
    expect(r.violations.join(' ')).toContain('best_yes_ask == 100 - best_no_bid');
  });

  it('skips comparisons it cannot make instead of inventing a pass', () => {
    const r = checkBookInvariants({ bids: [], asks: [] }, { bids: [], asks: [] });
    expect(r.ok).toBe(true);
    expect(r.checked).toBe(0);
  });

  it('holds for every mirrored book fast-check can produce', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 98 }),
        fc.integer({ min: 1, max: 50 }),
        (yesBid, gap) => {
          const yesAsk = Math.min(99, yesBid + gap);
          const yes = { bids: [[yesBid, 10] as Level], asks: [[yesAsk, 10] as Level] };
          const no = {
            bids: [[100 - yesAsk, 10] as Level],
            asks: [[100 - yesBid, 10] as Level],
          };
          expect(checkBookInvariants(yes, no).ok).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('isSortedBestFirst', () => {
  it('accepts descending bids and ascending asks', () => {
    expect(isSortedBestFirst([[62, 1], [61, 1], [60, 1]], 'bids')).toBe(true);
    expect(isSortedBestFirst([[64, 1], [65, 1]], 'asks')).toBe(true);
  });
  it('rejects the raw worst-first ladders both venues actually return', () => {
    expect(isSortedBestFirst([[60, 1], [61, 1], [62, 1]], 'bids')).toBe(false);
    expect(isSortedBestFirst([[65, 1], [64, 1]], 'asks')).toBe(false);
  });
});
