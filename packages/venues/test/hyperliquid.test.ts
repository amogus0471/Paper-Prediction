import { describe, expect, it } from 'vitest';
import { bestAsk, bestBid, checkBookInvariants, isSortedBestFirst, walkBook } from '@polyfill/core';
import { HyperliquidAdapter, coinFor } from '../src/hyperliquid';

const LIVE = process.env.LIVE === '1';
const dLive = LIVE ? describe : describe.skip;

describe('bucket names — markets that would otherwise be indistinguishable', () => {
  const hl = new HyperliquidAdapter() as unknown as {
    // Exercised through listEvents in the live suite; reached directly here so
    // the naming rules are pinned without a network call.
    constructor: unknown;
  };
  void hl;

  it('every leg of a bucket question gets a distinct, readable title', async () => {
    const { nameBucketForTest } = await import('../src/hyperliquid');
    const parent = 'class:priceBucket|underlying:BTC|priceThresholds:63019,65592|period:1d';

    const titles = ['index:0', 'index:1', 'index:2', 'other'].map((d) =>
      nameBucketForTest(d, parent),
    );

    expect(titles).toEqual([
      'Will BTC settle below $63,019?',
      'Will BTC settle between $63,019 and $65,592?',
      'Will BTC settle above $65,592?',
      'Will BTC settle outside $63,019–$65,592?',
    ]);
    // The actual requirement: no two legs share a title.
    expect(new Set(titles).size).toBe(4);
  });

  it('declines to invent a name when the parent carries no thresholds', async () => {
    const { nameBucketForTest } = await import('../src/hyperliquid');
    expect(nameBucketForTest('index:0', 'class:priceBinary|underlying:BTC')).toBeNull();
    expect(nameBucketForTest('other', '')).toBeNull();
  });
});

describe('coinFor — the id that is easy to get wrong', () => {
  it('concatenates, never adds', () => {
    expect(coinFor(1025, 0)).toBe('#10250');
    expect(coinFor(1025, 1)).toBe('#10251');
    // The trap: 1026 side 0 is #10260, NOT #10252. Treating these as
    // sequential integers silently addresses a different market.
    expect(coinFor(1026, 0)).toBe('#10260');
    expect(coinFor(1026, 0)).not.toBe('#10252');
  });
});

dLive('Hyperliquid HIP-4 (live)', () => {
  const hl = new HyperliquidAdapter();

  it(
    'lists outcome markets with readable questions',
    async () => {
      const { events } = await hl.listEvents();
      expect(events.length).toBeGreaterThan(0);

      const markets = events.flatMap((e) => e.markets);
      expect(markets.length).toBeGreaterThan(0);

      for (const m of markets) {
        // The raw description is pipe-delimited machine text; if it leaks
        // through to the question we have failed to parse it.
        expect(m.question).not.toContain('|');
        expect(m.question).not.toContain('class:');
        // A bucket describes itself only as "index:0"; the thresholds live on
        // the parent question. Leaking that through makes three markets
        // indistinguishable, so it is pinned rather than left to review.
        expect(m.question).not.toMatch(/^index:/);
        expect(m.question.length).toBeGreaterThan(8);
        expect(m.venueMarketId).toMatch(/^#\d+[01]$/);
      }
      console.log(`  ${markets.length} markets, e.g. "${markets[0]!.question}"`);
    },
    120000,
  );

  it(
    'fetches a two-sided book that satisfies the mirror invariants',
    async () => {
      const { events } = await hl.listEvents();
      const markets = events.flatMap((e) => e.markets);

      let checked = 0;
      for (const m of markets.slice(0, 8)) {
        const book = await hl.getOrderBook(m.bookRef);
        const yb = bestBid(book.yes);
        const ya = bestAsk(book.yes);
        const nb = bestBid(book.no);
        const na = bestAsk(book.no);
        if (yb == null && ya == null && nb == null && na == null) continue;

        checked++;
        expect(isSortedBestFirst(book.yes.bids, 'bids')).toBe(true);
        expect(isSortedBestFirst(book.yes.asks, 'asks')).toBe(true);
        expect(isSortedBestFirst(book.no.bids, 'bids')).toBe(true);
        expect(isSortedBestFirst(book.no.asks, 'asks')).toBe(true);

        // YES and NO are independently quoted here, so agreement is real
        // evidence the parse is right rather than a tautology.
        const inv = checkBookInvariants(book.yes, book.no, 0.2);
        expect(inv.violations).toEqual([]);

        if (checked === 1) {
          console.log(`  ${m.question}`);
          console.log(`  yes ${yb}/${ya}  no ${nb}/${na}`);
        }
      }
      expect(checked).toBeGreaterThan(0);
    },
    180000,
  );

  it(
    'prices a P$100 order against a real book',
    async () => {
      const { events } = await hl.listEvents();
      const markets = events.flatMap((e) => e.markets);

      let priced = 0;
      for (const m of markets.slice(0, 8)) {
        const book = await hl.getOrderBook(m.bookRef);
        if (book.yes.asks.length === 0) continue;

        const walk = walkBook(book.yes.asks, { kind: 'notional', usd: 100 }, m.tickCents);
        if (walk.totalQty === 0) continue;
        priced++;

        expect(walk.cost).toBeLessThanOrEqual(100.001);
        const touched = walk.fills.map((f) => f.price);
        expect(walk.avgPrice).toBeGreaterThanOrEqual(Math.min(...touched) - 1e-6);
        expect(walk.avgPrice).toBeLessThanOrEqual(Math.max(...touched) + 1e-6);

        if (priced === 1) {
          console.log(`  P$100 -> ${walk.totalQty} @ ${walk.avgPrice}¢`);
        }
      }
      expect(priced).toBeGreaterThan(0);
    },
    180000,
  );

  it('charges no fee — HIP-4 is free to open', () => {
    expect(hl.computeFee(100, 50, 'buy')).toBe(0);
  });
});
