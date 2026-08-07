import { beforeEach, describe, expect, it, vi } from 'vitest';
import { KalshiAdapter } from '@polyfill/venues';
import { checkBookInvariants } from '@polyfill/core';

/**
 * End-to-end test of the local fill path against a REAL live Kalshi book.
 *
 * This is the test that matters for the local-first design: it proves the same
 * engine that the server used now produces an auditable fill entirely inside
 * the extension, with the ledger balancing afterwards.
 *
 * `chrome.storage.local` is shimmed with an in-memory map — the store's only
 * dependency on the browser.
 */

const memory = new Map<string, unknown>();

// `get` MUST accept an array of keys, not just a string.
//
// This shim used to take a single string, and `loadState` reads two keys at
// once (the current one and the pre-rename one it migrates from). An array
// argument stringified into a key that was never set, so every load missed,
// fell through to freshState(), and SAVED it — silently resetting the
// portfolio to P$10,000 on every single read. The tests then reported that
// fills do not debit cash, which was a lie told by the harness rather than a
// bug in the engine. Matching the real chrome.storage contract is the fix.
vi.stubGlobal('chrome', {
  storage: {
    local: {
      get: async (keys: string | string[]) => {
        const list = Array.isArray(keys) ? keys : [keys];
        const out: Record<string, unknown> = {};
        for (const k of list) if (memory.has(k)) out[k] = memory.get(k);
        return out;
      },
      set: async (obj: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(obj)) memory.set(k, v);
      },
      remove: async (keys: string | string[]) => {
        for (const k of Array.isArray(keys) ? keys : [keys]) memory.delete(k);
      },
    },
  },
});

const { loadState, summarize, checkLedger, marketKey, freshState, saveState } = await import(
  '../src/lib/store'
);
const { buildQuote, submitOrder, settleLocal, OrderError } = await import('../src/lib/engine');
const kalshi = new KalshiAdapter({ env: 'prod' });

// This suite proves the local fill path against a REAL live Kalshi book, so
// it is opt-in the same way packages/venues/test/live-invariants.test.ts is:
//
//   LIVE=1 npx vitest run test/local-engine.test.ts
//
// Without LIVE=1 it's skipped rather than failed, so offline dev and CI runners
// with no outbound network don't get a false-negative build. The one always-on
// test below (initial balance + ledger check) needs no network and stays on.
const LIVE = process.env.LIVE === '1';
const dLive = LIVE ? describe : describe.skip;

async function liveMarket() {
  const { events } = await kalshi.listEvents(undefined, 60);
  for (const ev of events) {
    for (const m of ev.markets) {
      if (m.status !== 'open') continue;
      const book = await kalshi.getOrderBook(m.bookRef);
      // Need a genuinely two-sided book with room under the 5% depth cap.
      if (book.yes.asks.length >= 2 && book.yes.bids.length >= 1) {
        return { meta: m, book, category: ev.category };
      }
    }
  }
  return null;
}

describe('local fill engine', () => {
  beforeEach(async () => {
    memory.clear();
    await saveState(freshState());
  });

  it('starts with a P$10,000 balance and a balanced ledger', async () => {
    const state = await loadState();
    expect(summarize(state).equity).toBe(10000);
    expect(checkLedger(state).ok).toBe(true);
  });
});

dLive('local fill engine (live Kalshi book)', () => {
  beforeEach(async () => {
    memory.clear();
    await saveState(freshState());
  });

  it(
    'quotes, fills and books a position against a real Kalshi book',
    async () => {
      const live = await liveMarket();
      if (!live) return; // venue had nothing two-sided; not an engine failure

      expect(checkBookInvariants(live.book.yes, live.book.no).ok).toBe(true);

      const meta = {
        venue: 'kalshi',
        venueMarketId: live.meta.venueMarketId,
        question: live.meta.question,
        yesLabel: live.meta.yesLabel,
        noLabel: live.meta.noLabel,
        tickCents: live.meta.tickCents,
        minOrderSize: live.meta.minOrderSize,
        category: live.category,
      };

      const quote = buildQuote({
        book: live.book,
        meta,
        side: 'buy',
        outcome: 'yes',
        realism: 'realistic',
        target: { kind: 'notional', usd: 25 },
      });

      expect(quote.qty).toBeGreaterThan(0);
      expect(quote.avgPrice).toBeGreaterThan(0);
      expect(quote.avgPrice).toBeLessThan(100);
      expect(quote.cost).toBeLessThanOrEqual(25.001);
      // Payout is $1/contract, so profit and breakeven must be self-consistent.
      expect(quote.maxPayout).toBeCloseTo(quote.qty, 4);
      expect(quote.maxProfit).toBeCloseTo(quote.maxPayout - quote.totalCost, 4);
      expect(quote.breakeven).toBeCloseTo((quote.totalCost / quote.qty) * 100, 2);

      const order = await submitOrder({ meta, quote, fillBook: live.book });

      expect(['filled', 'partial']).toContain(order.status);
      expect(order.qtyFilled).toBeGreaterThan(0);
      // The audit trail: the fill price is reconstructible from the stored book.
      expect(order.bookSnapshot.asks.length).toBeGreaterThan(0);
      const reconstructed = order.fills.reduce((s, f) => s + f.notional, 0);
      expect(Math.abs(order.cost - reconstructed)).toBeLessThan(1e-6);
      // Every fill price must have come from a level that was really there.
      for (const f of order.fills) {
        expect(order.bookSnapshot.asks.some((a) => Math.abs(a[0] - f.price) < 0.011)).toBe(true);
      }

      const after = await loadState();
      const s = summarize(after);
      expect(s.cash).toBeCloseTo(10000 - order.cost - order.fee, 4);
      expect(s.openCount).toBe(1);
      expect(checkLedger(after).ok).toBe(true);

      const pos = after.positions[0]!;
      expect(pos.qty).toBe(order.qtyFilled);
      // The forecast pair is frozen at entry — this is what gets scored.
      expect(pos.entryPUser).toBeCloseTo(order.avgPrice / 100, 6);
      expect(pos.scoringEligible).toBe(true);
    },
    120000,
  );

  it(
    'settles a winning position at $1 per contract and keeps the ledger balanced',
    async () => {
      const live = await liveMarket();
      if (!live) return;

      const meta = {
        venue: 'kalshi',
        venueMarketId: live.meta.venueMarketId,
        question: live.meta.question,
        yesLabel: live.meta.yesLabel,
        noLabel: live.meta.noLabel,
        tickCents: live.meta.tickCents,
        minOrderSize: live.meta.minOrderSize,
        category: live.category,
      };

      const quote = buildQuote({
        book: live.book,
        meta,
        side: 'buy',
        outcome: 'yes',
        realism: 'realistic',
        target: { kind: 'notional', usd: 25 },
      });
      const order = await submitOrder({ meta, quote, fillBook: live.book });

      const key = marketKey('kalshi', live.meta.venueMarketId);
      const settled = await settleLocal(key, 'yes');
      expect(settled).toBe(1);

      const after = await loadState();
      // Won: paid `cost`, received qty x $1.
      expect(summarize(after).cash).toBeCloseTo(
        10000 - order.cost - order.fee + order.qtyFilled,
        4,
      );
      expect(after.positions[0]!.outcomeResult).toBe(true);
      expect(after.positions[0]!.isOpen).toBe(false);
      expect(checkLedger(after).ok).toBe(true);
    },
    120000,
  );

  it(
    'refuses an order larger than 5% of visible depth',
    async () => {
      const live = await liveMarket();
      if (!live) return;

      const meta = {
        venue: 'kalshi',
        venueMarketId: live.meta.venueMarketId,
        question: live.meta.question,
        yesLabel: live.meta.yesLabel,
        noLabel: live.meta.noLabel,
        tickCents: live.meta.tickCents,
        minOrderSize: live.meta.minOrderSize,
        category: live.category,
      };

      expect(() =>
        buildQuote({
          book: live.book,
          meta,
          side: 'buy',
          outcome: 'yes',
          realism: 'realistic',
          target: { kind: 'notional', usd: 9_000_000 },
        }),
      ).toThrow(OrderError);
    },
    120000,
  );

  it('refuses to spend more sim cash than exists', async () => {
    const live = await liveMarket();
    if (!live) return;

    const meta = {
      venue: 'kalshi',
      venueMarketId: live.meta.venueMarketId,
      question: live.meta.question,
      yesLabel: live.meta.yesLabel,
      noLabel: live.meta.noLabel,
      tickCents: live.meta.tickCents,
      minOrderSize: live.meta.minOrderSize,
      category: live.category,
    };

    // Drain the account, then try to trade.
    await saveState({ ...(await loadState()), cash: 0.5 });

    const quote = buildQuote({
      book: live.book,
      meta,
      side: 'buy',
      outcome: 'yes',
      realism: 'realistic',
      target: { kind: 'notional', usd: 25 },
    });

    await expect(submitOrder({ meta, quote, fillBook: live.book })).rejects.toThrow(
      /Not enough sim cash/,
    );
  }, 120000);
});
