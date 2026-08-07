import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedBook } from '@polyfill/core';
import type { OrderError as OrderErrorType } from '../src/lib/engine';

/**
 * Offline unit tests for the local fill engine.
 *
 * `local-engine.test.ts` proves the path against a real venue book, but it is
 * gated behind LIVE=1 and therefore contributes nothing to a normal or CI run.
 * These use a fixture book so the guards that actually reject orders — closed
 * market, expired quote, replayed quote, depth cap, funds, position limit —
 * are covered every time the suite runs.
 */

const memory = new Map<string, unknown>();
vi.stubGlobal('chrome', {
  storage: {
    local: {
      get: async (keys: string | string[]) => {
        const list = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(list.map((k) => [k, memory.get(k)]));
      },
      set: async (obj: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(obj)) memory.set(k, v);
      },
      remove: async (k: string) => void memory.delete(k),
    },
  },
});

const { loadState, saveState, freshState, summarize, checkLedger } = await import('../src/lib/store');
const { buildQuote, submitOrder, OrderError, QUOTE_TTL_MS } = await import('../src/lib/engine');

/** A well-formed two-sided book: YES 40/41, mirrored NO 59/60. */
function book(overrides: Partial<NormalizedBook> = {}): NormalizedBook {
  return {
    marketId: 'TEST-1',
    capturedAt: new Date(),
    yes: {
      bids: [
        [40, 50000],
        [39, 80000],
      ],
      asks: [
        [41, 50000],
        [42, 80000],
      ],
    },
    no: {
      bids: [
        [58, 80000],
        [59, 50000],
      ].reverse() as [number, number][],
      asks: [
        [60, 50000],
        [61, 80000],
      ],
    },
    ...overrides,
  };
}

const meta = {
  venue: 'kalshi',
  venueMarketId: 'TEST-1',
  question: 'Will the test pass?',
  yesLabel: 'Yes',
  noLabel: 'No',
  tickCents: 1,
  minOrderSize: 1,
  category: 'science',
};

const quoteArgs = {
  book: book(),
  meta,
  side: 'buy' as const,
  outcome: 'yes' as const,
  realism: 'realistic' as const,
  target: { kind: 'notional' as const, usd: 100 },
};

describe('buildQuote', () => {
  it('prices against the ask side and reports self-consistent ticket maths', () => {
    const q = buildQuote(quoteArgs);
    expect(q.avgPrice).toBe(41);
    expect(q.qty).toBeCloseTo(243.9, 1); // 100 / 0.41, floored to 2dp
    expect(q.cost).toBeLessThanOrEqual(100.000001);
    expect(q.maxPayout).toBeCloseTo(q.qty, 4);
    expect(q.maxProfit).toBeCloseTo(q.maxPayout - q.totalCost, 4);
    expect(q.breakeven).toBeCloseTo((q.totalCost / q.qty) * 100, 2);
  });

  it('hits the bid side when selling', () => {
    expect(buildQuote({ ...quoteArgs, side: 'sell', target: { kind: 'qty', qty: 10 } }).avgPrice).toBe(40);
  });

  it('rejects an order past 5% of visible depth', () => {
    expect(() => buildQuote({ ...quoteArgs, target: { kind: 'notional', usd: 10_000_000 } })).toThrow(
      /market can absorb/,
    );
  });

  it('rejects a market that has already closed', () => {
    const closed = { ...meta, closeTime: new Date(Date.now() - 90 * 60_000).toISOString() };
    try {
      buildQuote({ ...quoteArgs, meta: closed });
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as OrderErrorType).code).toBe('market_closed');
      expect((e as OrderErrorType).detail).toContain('hour');
    }
  });

  it('allows a market that has not closed yet', () => {
    const open = { ...meta, closeTime: new Date(Date.now() + 3_600_000).toISOString() };
    expect(() => buildQuote({ ...quoteArgs, meta: open })).not.toThrow();
  });

  it('rejects a stale book rather than quoting from it', () => {
    const stale = book({ capturedAt: new Date(Date.now() - 60_000) });
    try {
      buildQuote({ ...quoteArgs, book: stale });
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as OrderErrorType).code).toBe('stale_book');
    }
  });

  it('refuses to price a book whose mirror invariants fail', () => {
    // NO bids nowhere near 100 - yes_ask: the adapter mis-parsed something.
    const broken = book({ no: { bids: [[10, 50000]], asks: [[60, 50000]] } });
    try {
      buildQuote({ ...quoteArgs, book: broken });
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as OrderErrorType).code).toBe('stale_book');
      expect((e as OrderErrorType).detail).toContain('mirror invariants');
    }
  });

  it('freezes trading once the book is priced as a near-certainty', () => {
    const resolved = book({
      yes: { bids: [[98, 50000]], asks: [[99, 50000]] },
      no: { bids: [[1, 50000]], asks: [[2, 50000]] },
    });
    try {
      buildQuote({ ...quoteArgs, book: resolved });
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as OrderErrorType).code).toBe('resolution_lockout');
    }
  });

  it('charges no fee on Polymarket and a real one on Kalshi', () => {
    const kalshi = buildQuote(quoteArgs);
    const poly = buildQuote({ ...quoteArgs, meta: { ...meta, venue: 'polymarket' } });
    expect(kalshi.fee).toBeGreaterThan(0);
    expect(poly.fee).toBe(0);
  });

  it('fills at the mid with no fee in instant mode, and marks it unscored', () => {
    const q = buildQuote({ ...quoteArgs, realism: 'instant' });
    expect(q.avgPrice).toBe(40.5);
    expect(q.fee).toBe(0);
    expect(q.scoringEligible).toBe(false);
  });

  it('fills one tick worse in brutal mode', () => {
    const q = buildQuote({ ...quoteArgs, realism: 'brutal' });
    expect(q.avgPrice).toBe(42);
    expect(q.scoringEligible).toBe(true);
  });
});

describe('submitOrder', () => {
  beforeEach(async () => {
    memory.clear();
    await saveState(freshState());
  });

  it('books a fill, moves the cash and keeps the ledger balanced', async () => {
    const q = buildQuote(quoteArgs);
    const order = await submitOrder({ meta, quote: q, fillBook: book() });

    expect(order.status).toBe('filled');
    expect(order.avgPrice).toBe(41);

    const after = await loadState();
    expect(summarize(after).cash).toBeCloseTo(10000 - order.cost - order.fee, 4);
    expect(checkLedger(after).ok).toBe(true);
    // Category is frozen at entry for the per-category calibration split.
    expect(after.positions[0]!.category).toBe('science');
  });

  it('refuses to replay a quote that was already used', async () => {
    const q = buildQuote(quoteArgs);
    await submitOrder({ meta, quote: q, fillBook: book() });

    await expect(submitOrder({ meta, quote: q, fillBook: book() })).rejects.toThrow(
      /already placed/,
    );
    // And the second attempt must not have moved anything.
    expect((await loadState()).orders).toHaveLength(1);
  });

  it('refuses a quote older than its TTL', async () => {
    const q = buildQuote(quoteArgs);
    q.quotedAt = new Date(Date.now() - QUOTE_TTL_MS - 1000).toISOString();
    await expect(submitOrder({ meta, quote: q, fillBook: book() })).rejects.toThrow(/expired/);
  });

  it('rejects when the price ran more than 2% against the user', async () => {
    const q = buildQuote(quoteArgs);
    // 41c -> 45c is roughly 10% adverse.
    const moved = book({
      yes: { bids: [[44, 50000]], asks: [[45, 50000]] },
      no: { bids: [[55, 50000]], asks: [[56, 50000]] },
    });
    await expect(submitOrder({ meta, quote: q, fillBook: moved })).rejects.toThrow(/Price moved/);
  });

  it('accepts a price that moved in the user’s favour', async () => {
    const q = buildQuote(quoteArgs);
    const better = book({
      yes: { bids: [[37, 50000]], asks: [[38, 50000]] },
      no: { bids: [[62, 50000]], asks: [[63, 50000]] },
    });
    const order = await submitOrder({ meta, quote: q, fillBook: better });
    expect(order.avgPrice).toBe(38);
  });

  it('refuses to spend more than the balance holds', async () => {
    const state = await loadState();
    await saveState({ ...state, cash: 5 });
    const q = buildQuote(quoteArgs);
    await expect(submitOrder({ meta, quote: q, fillBook: book() })).rejects.toThrow(
      /Not enough sim cash/,
    );
  });

  it('enforces the 20%-of-bankroll single-market cap', async () => {
    // Four P$100 buys are fine; the fifth crosses 20% of a P$10,000 bankroll.
    for (let i = 0; i < 4; i++) {
      const q = buildQuote(quoteArgs);
      await submitOrder({ meta, quote: q, fillBook: book() });
    }
    const state = await loadState();
    expect(state.positions[0]!.costBasis).toBeGreaterThan(390);

    const big = buildQuote({ ...quoteArgs, target: { kind: 'notional', usd: 1700 } });
    try {
      await submitOrder({ meta, quote: big, fillBook: book() });
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as OrderErrorType).code).toBe('position_limit');
      expect((e as OrderErrorType).detail).toContain('Position sizing is the point');
    }
  });

  it('realizes P&L on a sell using weighted average cost basis', async () => {
    const buy = buildQuote(quoteArgs);
    const opened = await submitOrder({ meta, quote: buy, fillBook: book() });

    const sell = buildQuote({
      ...quoteArgs,
      side: 'sell',
      target: { kind: 'qty', qty: opened.qtyFilled },
    });
    const closed = await submitOrder({ meta, quote: sell, fillBook: book() });

    // Bought the 41c ask, sold the 40c bid — a one-cent spread loss plus fees.
    expect(closed.realized).toBeLessThan(0);
    const after = await loadState();
    expect(after.positions[0]!.isOpen).toBe(false);
    expect(checkLedger(after).ok).toBe(true);
  });

  it('cannot sell an outcome it does not hold', async () => {
    const sell = buildQuote({ ...quoteArgs, side: 'sell', target: { kind: 'qty', qty: 10 } });
    await expect(submitOrder({ meta, quote: sell, fillBook: book() })).rejects.toThrow(
      /do not hold enough/,
    );
  });
});
