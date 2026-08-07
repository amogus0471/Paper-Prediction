import { describe, expect, it, vi } from 'vitest';

/**
 * The path a user actually takes, against live venues: a URL in the address
 * bar becomes a resolved market, a live book, and a priced ticket.
 *
 * Unit tests cover each link in that chain, but only this one catches the
 * failures that live between them — a book ref that resolves but cannot be
 * fetched, a market whose id does not round-trip, a venue that answers `null`
 * instead of erroring. Every one of those looks like "the popup doesn't work"
 * and none of them shows up offline.
 *
 *   LIVE=1 npx vitest run test/live-venues.test.ts
 */

const memory = new Map<string, unknown>();
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
      remove: async () => undefined,
    },
  },
});

const { parseVenueUrl, resolveUrl, fetchBook, BOOK_CACHE_MS } = await import('../src/lib/resolve');
const { buildQuote } = await import('../src/lib/engine');
const { checkBookInvariants } = await import('@polyfill/core');
const { HyperliquidAdapter } = await import('@polyfill/venues');

const LIVE = process.env.LIVE === '1';
const dLive = LIVE ? describe : describe.skip;

dLive('hyperliquid, end to end from a URL', () => {
  it(
    'resolves a real outcome coin into a tradeable market',
    async () => {
      // Pick a coin that exists right now rather than hardcoding one — HIP-4
      // outcomes are recurring dailies and every id expires.
      const { events } = await new HyperliquidAdapter().listEvents();
      const market = events.flatMap((e) => e.markets).find((m) => m.status === 'open');
      expect(market, 'no open hyperliquid outcome markets').toBeTruthy();

      const coin = market!.venueMarketId;
      const url = `https://app.hyperliquid.xyz/trade/${coin}`;
      expect(parseVenueUrl(url)).toEqual({ venue: 'hyperliquid', coin });

      const resolved = await resolveUrl(url);
      expect(resolved, `resolveUrl returned nothing for ${coin}`).toBeTruthy();
      expect(resolved!.meta.venueMarketId).toBe(coin);
      // The bucket-name bug: three markets all reading "index:0".
      expect(resolved!.meta.question).not.toMatch(/^index:/);
      expect(resolved!.meta.question.length).toBeGreaterThan(8);

      const { book } = await fetchBook(resolved!.meta);
      expect(checkBookInvariants(book.yes, book.no, 0.2).violations).toEqual([]);

      if (book.yes.asks.length === 0) return; // one-sided right now; nothing to price
      const quote = buildQuote({
        book,
        meta: resolved!.meta,
        side: 'buy',
        outcome: 'yes',
        realism: 'realistic',
        target: { kind: 'notional', usd: 50 },
        // HIP-4 books are genuinely thin and P$50 can be over 5% of them. The
        // cap is not what this test is about, and it has its own coverage.
        enforceDepthCap: false,
      });
      expect(quote.qty).toBeGreaterThan(0);
      expect(quote.cost).toBeLessThanOrEqual(50.001);
      expect(quote.visibleDepth).toBeGreaterThan(0);
      console.log(`  ${resolved!.meta.question}`);
      console.log(`  P$50 -> ${quote.qty} @ ${quote.avgPrice}c, depth P$${quote.visibleDepth}`);
    },
    180000,
  );
});

dLive('the poll path costs one venue round trip, not four', () => {
  it(
    'serves a second read of the same book from cache',
    async () => {
      const resolved = await resolveUrl('https://polymarket.com/event/' + (await someEventSlug()));
      expect(resolved).toBeTruthy();

      const t0 = Date.now();
      await fetchBook(resolved!.meta);
      const cold = Date.now() - t0;

      const t1 = Date.now();
      await fetchBook(resolved!.meta);
      const warm = Date.now() - t1;

      // The overlay asks for the same book twice per tick — once to paint the
      // price, once to price the ticket. The second must not hit the network.
      expect(warm).toBeLessThan(Math.max(20, cold / 4));
      console.log(`  cold ${cold}ms -> warm ${warm}ms (TTL ${BOOK_CACHE_MS}ms)`);

      // And it must expire, so a poll never shows a previous second's price.
      await new Promise((r) => setTimeout(r, BOOK_CACHE_MS + 60));
      const t2 = Date.now();
      await fetchBook(resolved!.meta);
      expect(Date.now() - t2).toBeGreaterThan(10);
    },
    180000,
  );

  it(
    'issues exactly one venue request for a whole poll tick',
    async () => {
      const resolved = await resolveUrl('https://polymarket.com/event/' + (await someEventSlug()));
      expect(resolved).toBeTruthy();
      const meta = resolved!.meta;

      // Count real network calls rather than trusting the reasoning. This is
      // the number that was four: two GETs for the book the panel paints, two
      // more for the book the ticket prices against, every second, against a
      // CLOB budget that tightens near a hundred reads a minute.
      const real = globalThis.fetch;
      let calls = 0;
      globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
        calls++;
        return real(...args);
      }) as typeof fetch;

      try {
        await new Promise((r) => setTimeout(r, BOOK_CACHE_MS + 60)); // start cold
        calls = 0;

        const { book } = await fetchBook(meta); // what GET_BOOK does
        const forQuote = (await fetchBook(meta)).book; // what QUOTE does
        expect(forQuote).toBe(book);

        console.log(`  one poll tick = ${calls} venue request(s)`);
        expect(calls).toBe(1);
      } finally {
        globalThis.fetch = real;
      }
    },
    180000,
  );
});

/**
 * A Polymarket event with at least one genuinely open market.
 *
 * `closed=false` on the events query is not the same claim as "its markets are
 * open" — a finished esports event still lists with forty closed markets under
 * it, which is exactly what made the first version of this test fail while the
 * resolver was behaving correctly.
 */
async function someEventSlug(): Promise<string> {
  const res = await fetch(
    'https://gamma-api.polymarket.com/events?limit=40&closed=false&order=volume24hr&ascending=false',
  );
  const events = (await res.json()) as {
    slug?: string;
    markets?: { clobTokenIds?: string; closed?: boolean; active?: boolean }[];
  }[];
  const hit = events.find(
    (e) =>
      e.slug &&
      e.markets?.some((m) => m.clobTokenIds && m.closed !== true && m.active !== false),
  );
  if (!hit?.slug) throw new Error('no polymarket event with an open, tokenised market');
  return hit.slug;
}
