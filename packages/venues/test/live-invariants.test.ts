import { describe, expect, it } from 'vitest';
import {
  bestAsk,
  bestBid,
  checkBookInvariants,
  depthNotional,
  isSortedBestFirst,
  midPrice,
  walkBook,
} from '@polyfill/core';
import { KalshiAdapter, PolymarketAdapter } from '../src/index';
import type { NormalizedMarket, VenueAdapter } from '../src/types';

/**
 * Live contract tests. These hit the real venue APIs, so they are opt-in:
 *
 *   LIVE=1 npx vitest run test/live-invariants.test.ts
 *
 * Run them before trusting any adapter change, and nightly in CI to catch
 * schema drift. A venue silently reordering a ladder or renaming a field is the
 * failure mode that turns every fill price wrong without throwing anything.
 */
const LIVE = process.env.LIVE === '1';
const SAMPLE = Number(process.env.SAMPLE ?? 100);
const d = LIVE ? describe : describe.skip;

async function collectOpenMarkets(adapter: VenueAdapter, limit: number): Promise<NormalizedMarket[]> {
  const out: NormalizedMarket[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 12 && out.length < limit; page++) {
    const { events, next } = await adapter.listEvents(cursor, 100);
    for (const e of events) {
      for (const m of e.markets) {
        if (m.status === 'open') out.push(m);
        if (out.length >= limit) break;
      }
      if (out.length >= limit) break;
    }
    if (!next) break;
    cursor = next;
  }
  return out;
}

interface Report {
  fetched: number;
  twoSided: number;
  empty: number;
  invariantFailures: string[];
  sortFailures: string[];
  quoteDrift: string[];
}

async function auditVenue(adapter: VenueAdapter, limit: number): Promise<Report> {
  const markets = await collectOpenMarkets(adapter, limit);
  const report: Report = {
    fetched: 0,
    twoSided: 0,
    empty: 0,
    invariantFailures: [],
    sortFailures: [],
    quoteDrift: [],
  };

  const BATCH = 10;
  for (let i = 0; i < markets.length; i += BATCH) {
    const batch = markets.slice(i, i + BATCH);
    const books = await Promise.all(
      batch.map(async (m) => {
        try {
          return { m, book: await adapter.getOrderBook(m.bookRef) };
        } catch {
          return null;
        }
      }),
    );

    for (const entry of books) {
      if (!entry) continue;
      const { m, book } = entry;
      report.fetched++;

      const yb = bestBid(book.yes);
      const ya = bestAsk(book.yes);
      const nb = bestBid(book.no);
      const na = bestAsk(book.no);
      if (yb == null && ya == null && nb == null && na == null) {
        report.empty++;
        continue;
      }

      const inv = checkBookInvariants(book.yes, book.no);
      if (inv.checked === 4) report.twoSided++;
      if (!inv.ok) report.invariantFailures.push(`${m.venueMarketId}: ${inv.violations.join(' | ')}`);

      if (
        !isSortedBestFirst(book.yes.bids, 'bids') ||
        !isSortedBestFirst(book.yes.asks, 'asks') ||
        !isSortedBestFirst(book.no.bids, 'bids') ||
        !isSortedBestFirst(book.no.asks, 'asks')
      ) {
        report.sortFailures.push(m.venueMarketId);
      }

      // Cross-check the synthesized top-of-book against the price the venue
      // independently quoted in market metadata. A mirror can be internally
      // consistent and still wrong; only this catches that.
      const pairs: [string, number | null, number | undefined][] = [
        ['yes_bid', yb, m.yesBid],
        ['yes_ask', ya, m.yesAsk],
        ['no_bid', nb, m.noBid],
        ['no_ask', na, m.noAsk],
      ];
      for (const [label, ours, theirs] of pairs) {
        if (ours == null || theirs == null) continue;
        // Book and metadata are fetched at different instants, so allow a tick.
        if (Math.abs(ours - theirs) > 1.0001) {
          report.quoteDrift.push(`${m.venueMarketId} ${label}: book=${ours} meta=${theirs}`);
        }
      }
    }
  }

  return report;
}

function printReport(name: string, r: Report): void {
  console.log(
    `\n=== ${name} ===\n` +
      `books fetched      : ${r.fetched}\n` +
      `two-sided books    : ${r.twoSided}\n` +
      `empty books        : ${r.empty}\n` +
      `INVARIANT failures : ${r.invariantFailures.length}\n` +
      `sort failures      : ${r.sortFailures.length}\n` +
      `quote drift >1c    : ${r.quoteDrift.length}`,
  );
  for (const v of r.invariantFailures.slice(0, 10)) console.log(`  INVARIANT ${v}`);
  for (const v of r.sortFailures.slice(0, 10)) console.log(`  SORT ${v}`);
  for (const v of r.quoteDrift.slice(0, 10)) console.log(`  DRIFT ${v}`);
}

d('live venue contract', () => {
  it(
    'Kalshi: synthesized ask ladders satisfy the mirror invariants',
    async () => {
      const r = await auditVenue(new KalshiAdapter({ env: 'prod' }), SAMPLE);
      printReport('KALSHI', r);
      expect(r.fetched).toBeGreaterThan(20);
      expect(r.invariantFailures).toEqual([]);
      expect(r.sortFailures).toEqual([]);
      expect(r.quoteDrift).toEqual([]);
    },
    600000,
  );

  it(
    'Polymarket: independently-fetched YES and NO books mirror each other',
    async () => {
      const r = await auditVenue(new PolymarketAdapter(), SAMPLE);
      printReport('POLYMARKET', r);
      expect(r.fetched).toBeGreaterThan(20);
      expect(r.invariantFailures).toEqual([]);
      expect(r.sortFailures).toEqual([]);
    },
    600000,
  );

  it(
    'a G$100 market order prices sanely against a real book',
    async () => {
      const adapter = new KalshiAdapter({ env: 'prod' });
      const markets = await collectOpenMarkets(adapter, 40);
      let priced = 0;

      for (const m of markets) {
        const book = await adapter.getOrderBook(m.bookRef);
        const asks = book.yes.asks;
        if (asks.length === 0) continue;

        const walk = walkBook(asks, { kind: 'notional', usd: 100 }, m.tickCents);
        if (walk.totalQty === 0) continue;
        priced++;

        // Cost never exceeds the budget, and the average fill sits inside the
        // range of levels actually consumed.
        expect(walk.cost).toBeLessThanOrEqual(100.001);
        const touched = walk.fills.map((f) => f.price);
        expect(walk.avgPrice).toBeGreaterThanOrEqual(Math.min(...touched) - 1e-6);
        expect(walk.avgPrice).toBeLessThanOrEqual(Math.max(...touched) + 1e-6);

        // And it never claims more depth than the book showed.
        expect(walk.cost).toBeLessThanOrEqual(depthNotional(asks) + 1e-6);

        if (priced <= 3) {
          console.log(
            `  ${m.venueMarketId.slice(0, 40)} mid=${midPrice(book.yes)}c ` +
              `G$100 -> ${walk.totalQty} @ ${walk.avgPrice}c across ${walk.levelsConsumed} level(s)`,
          );
        }
        if (priced >= 15) break;
      }

      expect(priced).toBeGreaterThan(3);
    },
    600000,
  );
});
