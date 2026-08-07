import { describe, expect, it } from 'vitest';
import { bestAsk, bestBid, isSortedBestFirst, walkBook, type Ladder } from '@polyfill/core';
import { LimitlessAdapter, mirror } from '../src/limitless';

const LIVE = process.env.LIVE === '1';
const dLive = LIVE ? describe : describe.skip;

describe('mirror — the NO ladder we construct ourselves', () => {
  it('reflects prices and preserves size', () => {
    const yes: Ladder = {
      bids: [
        [51.2, 100],
        [30, 50],
      ],
      asks: [[55.8, 100]],
    };
    const no = mirror(yes);

    // A YES bid at 51.2c IS a NO ask at 48.8c for the same size.
    expect(no.asks).toEqual([
      [48.8, 100],
      [70, 50],
    ]);
    expect(no.bids).toEqual([[44.2, 100]]);
  });

  it('keeps both sides sorted best-first after reflection', () => {
    // Reflecting reverses the ordering, which is exactly the kind of thing that
    // silently inverts a book. bestBid must still be the highest NO bid.
    const yes: Ladder = {
      bids: [
        [40, 1],
        [39, 1],
        [38, 1],
      ],
      asks: [
        [41, 1],
        [42, 1],
        [43, 1],
      ],
    };
    const no = mirror(yes);
    expect(isSortedBestFirst(no.bids, 'bids')).toBe(true);
    expect(isSortedBestFirst(no.asks, 'asks')).toBe(true);
    expect(bestBid(no)).toBe(59);
    expect(bestAsk(no)).toBe(60);
  });
});

dLive('Limitless (live)', () => {
  const lx = new LimitlessAdapter();

  it(
    'lists markets with prices, and refuses to page wider than the venue allows',
    async () => {
      const { events } = await lx.listEvents();
      expect(events.length).toBeGreaterThan(0);

      const markets = events.flatMap((e) => e.markets);
      for (const m of markets) {
        expect(m.question.length).toBeGreaterThan(3);
        expect(m.venueMarketId).toBeTruthy();
        if (m.midPrice != null) {
          expect(m.midPrice).toBeGreaterThan(0);
          expect(m.midPrice).toBeLessThan(100);
        }
      }

      // `limit` is capped at 25 and asking for 26 is a 400 with NO data, not a
      // shorter page. The adapter clamps rather than discovering this in prod.
      const wide = await lx.listEvents(undefined, 100);
      expect(wide.events.length).toBeGreaterThan(0);
      console.log(`  ${markets.length} markets, e.g. "${markets[0]!.question}"`);
    },
    120000,
  );

  it(
    'parses level prices on the same scale the venue computes its own midpoint on',
    async () => {
      // The mirror invariants cannot prove anything here — we build the NO side
      // ourselves, so agreement is arithmetic, not evidence. The evidence for
      // the price scaling has to come from a number the venue computed: the
      // `midpoint` it returns alongside the ladders, in the same 0..1 units as
      // the levels. If we read dollars as cents, this is off by 100x.
      const { events } = await lx.listEvents();
      const markets = events.flatMap((e) => e.markets);

      let checked = 0;
      for (const m of markets.slice(0, 12)) {
        const book = await lx.getOrderBook(m.bookRef);
        const bid = bestBid(book.yes);
        const ask = bestAsk(book.yes);
        if (bid == null || ask == null) continue;

        const rawRes = await fetch(
          `https://api.limitless.exchange/markets/${m.venueMarketId}/orderbook`,
        );
        if (!rawRes.ok) continue;
        const raw = (await rawRes.json()) as { midpoint?: number };
        if (typeof raw.midpoint !== 'number') continue;

        checked++;
        expect(isSortedBestFirst(book.yes.bids, 'bids')).toBe(true);
        expect(isSortedBestFirst(book.yes.asks, 'asks')).toBe(true);
        expect(ask).toBeGreaterThan(bid);

        // A SCALE check, deliberately not a precision one. Half this venue is
        // 5-minute markets, so our fetch and this one are genuinely different
        // books seconds apart and can differ by several cents honestly. The
        // error being guarded against is 100x, which a 25c band catches with
        // room to spare; tightening it would only buy flakiness.
        expect(Math.abs((bid + ask) / 2 - raw.midpoint * 100)).toBeLessThan(25);

        console.log(
          `  ${m.question.slice(0, 44).padEnd(46)} book ${bid}/${ask}c  venue mid ${(
            raw.midpoint * 100
          ).toFixed(2)}c`,
        );
      }
      expect(checked, 'no two-sided Limitless books right now').toBeGreaterThan(0);
    },
    180000,
  );

  it(
    'never quotes a mid the book does not support, even when the venue does',
    async () => {
      // Their `prices` array can disagree wildly with the top of book: a
      // rolling 5-minute market often has nothing but dust at 3c/95c while the
      // listing still publishes 64c. We show the book, because the book is what
      // a fill walks — a displayed 64c that fills at 95c would be the worse
      // lie. The wide-spread warning is what makes that legible to the user.
      const { events } = await lx.listEvents();
      for (const m of events.flatMap((e) => e.markets).slice(0, 12)) {
        const book = await lx.getOrderBook(m.bookRef);
        for (const [p, q] of [...book.yes.bids, ...book.yes.asks, ...book.no.bids, ...book.no.asks]) {
          expect(p).toBeGreaterThan(0);
          expect(p).toBeLessThan(100);
          expect(q).toBeGreaterThan(0);
        }
      }
    },
    180000,
  );

  it(
    'prices an order in shares a human would recognise',
    async () => {
      const { events } = await lx.listEvents();
      const markets = events.flatMap((e) => e.markets);

      let priced = 0;
      for (const m of markets.slice(0, 12)) {
        const book = await lx.getOrderBook(m.bookRef);
        if (book.yes.asks.length === 0) continue;

        const walk = walkBook(book.yes.asks, { kind: 'notional', usd: 10 }, m.tickCents);
        if (walk.totalQty === 0) continue;
        priced++;

        expect(walk.cost).toBeLessThanOrEqual(10.001);
        // Sizes are raw USDC units on the wire. If the 1e6 scaling were missed,
        // ten dollars would buy a fraction of a millionth of a share and this
        // bound would fail — which is the whole point of asserting it.
        expect(walk.totalQty).toBeGreaterThan(0.01);
        expect(walk.totalQty).toBeLessThan(1_000_000);

        if (priced === 1) console.log(`  P$10 -> ${walk.totalQty} shares @ ${walk.avgPrice}c`);
      }
      expect(priced).toBeGreaterThan(0);
    },
    180000,
  );
});
