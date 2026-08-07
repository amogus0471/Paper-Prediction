import {
  DEFAULT_FEE_MODELS,
  computeFee as coreComputeFee,
  midPrice,
  roundPrice,
  type Ladder,
  type Level,
  type NormalizedBook,
  type OrderSide,
} from '@polyfill/core';
import { dollarsStringToCents, num, parseDate, parseJsonArray, sizeStringToQty } from './decimal-parse';
import { mapConcurrent, venueFetch } from './http';
import type {
  BookRef,
  Candle,
  Interval,
  NormalizedEvent,
  NormalizedMarket,
  Resolution,
  VenueAdapter,
} from './types';
import { VenueError } from './types';

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';

/**
 * Polymarket adapter.
 *
 * Every read endpoint is public — no API key, no wallet, no auth of any kind.
 * Only placing a real order needs EIP-712 headers, and Polyfill never places
 * one, so there is no wallet anywhere in this codebase.
 *
 * Two things about this API will silently corrupt fills if you get them wrong:
 *
 *   1. Books arrive WORST-FIRST. `bids` ascend to the best bid at the END of
 *      the array and `asks` descend to the best ask at the END. Verified live:
 *      bids [...0.10, 0.11, 0.12], asks [...0.15, 0.14, 0.13]. We sort
 *      explicitly rather than reversing, so a future ordering change cannot
 *      quietly invert every book.
 *   2. Each binary market is TWO ERC-1155 tokens. The NO book is a real book,
 *      not a derived one, and both must be fetched and merged.
 */
export class PolymarketAdapter implements VenueAdapter {
  readonly code = 'polymarket' as const;
  readonly displayName = 'Polymarket';
  readonly unitNoun = 'shares';

  async listEvents(cursor?: string, limit = 100): Promise<{ events: NormalizedEvent[]; next?: string }> {
    const offset = cursor ? Number(cursor) : 0;
    const url =
      `${GAMMA}/events?limit=${limit}&offset=${offset}&closed=false&archived=false` +
      `&order=volume24hr&ascending=false`;

    const raw = await venueFetch<RawEvent[]>(this.code, url);
    const events = raw.map((e) => this.normalizeEvent(e)).filter((e) => e.markets.length > 0);
    const next = raw.length === limit ? String(offset + limit) : undefined;
    return { events, ...(next ? { next } : {}) };
  }

  async getMarkets(venueMarketIds: string[]): Promise<NormalizedMarket[]> {
    if (venueMarketIds.length === 0) return [];
    const chunks = chunk(venueMarketIds, 20);
    const results = await mapConcurrent(chunks, 3, async (ids) => {
      const qs = ids.map((id) => `condition_ids=${encodeURIComponent(id)}`).join('&');
      const raw = await venueFetch<RawMarket[]>(this.code, `${GAMMA}/markets?${qs}&limit=100`);
      // Gamma types event ids loosely — sometimes a number, sometimes a string.
      return raw.map((m) => this.normalizeMarket(m, String(m.events?.[0]?.id ?? '')));
    });
    return results.flat().filter((m): m is NormalizedMarket => m !== null);
  }

  async getOrderBook(ref: BookRef): Promise<NormalizedBook> {
    if (ref.venue !== 'polymarket') throw new VenueError(this.code, 0, 'wrong adapter for book ref');

    // Both sides, in parallel. A merged book missing its NO half would still
    // "work" and be silently wrong on every NO trade.
    const [yesRaw, noRaw] = await Promise.all([
      venueFetch<RawBook>(this.code, `${CLOB}/book?token_id=${ref.yesTokenId}`),
      venueFetch<RawBook>(this.code, `${CLOB}/book?token_id=${ref.noTokenId}`),
    ]);

    return {
      marketId: ref.yesTokenId,
      capturedAt: bookTimestamp(yesRaw, noRaw),
      yes: normalizeLadder(yesRaw),
      no: normalizeLadder(noRaw),
    };
  }

  async getOrderBooks(refs: BookRef[]): Promise<Map<string, NormalizedBook>> {
    const out = new Map<string, NormalizedBook>();
    // Concurrency 4: the CLOB read budget is shared across every API consumer,
    // so a wide fan-out here costs everyone their books.
    const books = await mapConcurrent(refs, 4, async (ref) => {
      try {
        return { ref, book: await this.getOrderBook(ref) };
      } catch {
        return null;
      }
    });
    for (const entry of books) {
      if (entry && entry.ref.venue === 'polymarket') out.set(entry.ref.yesTokenId, entry.book);
    }
    return out;
  }

  async getPriceHistory(ref: BookRef, from: Date, to: Date, interval: Interval): Promise<Candle[]> {
    if (ref.venue !== 'polymarket') return [];
    const fidelity = FIDELITY_MINUTES[interval] ?? 60;
    const url =
      `${CLOB}/prices-history?market=${ref.yesTokenId}` +
      `&startTs=${Math.floor(from.getTime() / 1000)}&endTs=${Math.floor(to.getTime() / 1000)}` +
      `&fidelity=${fidelity}`;

    const raw = await venueFetch<{ history?: { t: number; p: number }[] }>(this.code, url);
    // The history endpoint returns points, not candles. Treating each point as
    // a flat OHLC is honest; inventing wicks would not be.
    return (raw.history ?? []).map((pt) => {
      const cents = roundPrice(pt.p * 100);
      return { ts: new Date(pt.t * 1000), o: cents, h: cents, l: cents, c: cents, v: 0 };
    });
  }

  async getResolutions(venueMarketIds: string[]): Promise<Resolution[]> {
    const markets = await this.getMarkets(venueMarketIds);
    return markets.map((m) => ({
      venueMarketId: m.venueMarketId,
      status: m.status,
      resolution: m.resolution ?? null,
      ...(m.resolvedAt ? { resolvedAt: m.resolvedAt } : {}),
    }));
  }

  computeFee(qty: number, priceCents: number, side: OrderSide, multiplier = 1): number {
    return coreComputeFee(DEFAULT_FEE_MODELS.polymarket!, qty, priceCents, side, multiplier);
  }

  private normalizeEvent(e: RawEvent): NormalizedEvent {
    const markets = (e.markets ?? [])
      .map((m) => this.normalizeMarket(m, String(e.id)))
      .filter((m): m is NormalizedMarket => m !== null);

    return {
      venue: this.code,
      venueEventId: String(e.id),
      ...(e.ticker ? { seriesKey: seriesKeyFromTicker(e.ticker) } : {}),
      title: e.title ?? 'Untitled',
      ...(e.slug ? { slug: e.slug } : {}),
      ...(e.description ? { description: e.description } : {}),
      category: categorize(e),
      ...(e.image ? { imageUrl: e.image } : {}),
      ...(parseDate(e.startDate) ? { openTime: parseDate(e.startDate)! } : {}),
      ...(parseDate(e.endDate) ? { closeTime: parseDate(e.endDate)! } : {}),
      isActive: e.closed !== true,
      markets,
    };
  }

  private normalizeMarket(m: RawMarket, eventId: string): NormalizedMarket | null {
    const tokens = parseJsonArray(m.clobTokenIds);
    const outcomes = parseJsonArray(m.outcomes);
    // No token pair means no book, and no book means nothing we can honestly price.
    if (tokens.length < 2 || !tokens[0] || !tokens[1]) return null;
    if (m.enableOrderBook === false) return null;

    const tickCents = roundPrice((num(m.orderPriceMinTickSize) ?? 0.01) * 100);
    const prices = parseJsonArray(m.outcomePrices);
    const lastPrice = dollarsStringToCents(prices[0] ?? m.lastTradePrice);

    const yesBid = dollarsStringToCents(m.bestBid);
    const yesAsk = dollarsStringToCents(m.bestAsk);

    return {
      venue: this.code,
      venueEventId: eventId,
      venueMarketId: m.conditionId,
      question: m.question ?? m.groupItemTitle ?? 'Untitled market',
      ...(m.slug ? { slug: m.slug } : {}),
      yesLabel: outcomes[0] ?? 'Yes',
      noLabel: outcomes[1] ?? 'No',
      ...(m.resolutionSource ? { resolutionSource: m.resolutionSource } : {}),
      ...(m.description ? { resolutionRules: m.description } : {}),
      status: marketStatus(m),
      ...(yesBid != null ? { yesBid } : {}),
      ...(yesAsk != null ? { yesAsk } : {}),
      // The NO side mirrors YES exactly on Polymarket — verified live on the
      // real books, and re-asserted per snapshot by checkBookInvariants.
      ...(yesAsk != null ? { noBid: roundPrice(100 - yesAsk) } : {}),
      ...(yesBid != null ? { noAsk: roundPrice(100 - yesBid) } : {}),
      ...(lastPrice != null ? { lastPrice } : {}),
      ...(yesBid != null && yesAsk != null ? { midPrice: roundPrice((yesBid + yesAsk) / 2) } : {}),
      ...(num(m.oneDayPriceChange) != null && lastPrice != null
        ? { price24hAgo: roundPrice(lastPrice - num(m.oneDayPriceChange)! * 100) }
        : {}),
      volume24h: num(m.volume24hr) ?? 0,
      volumeTotal: num(m.volumeNum) ?? num(m.volume) ?? 0,
      liquidity: num(m.liquidityNum) ?? num(m.liquidity) ?? 0,
      tickCents: tickCents > 0 ? tickCents : 1,
      minOrderSize: num(m.orderMinSize) ?? 1,
      ...(parseDate(m.startDate) ? { openTime: parseDate(m.startDate)! } : {}),
      ...(parseDate(m.endDate) ? { closeTime: parseDate(m.endDate)! } : {}),
      ...(parseDate(m.closedTime) ? { resolvedAt: parseDate(m.closedTime)! } : {}),
      ...resolutionOf(m, prices),
      bookRef: { venue: 'polymarket', yesTokenId: tokens[0], noTokenId: tokens[1] },
    };
  }
}

/**
 * Turn a raw Polymarket book into a best-first ladder.
 *
 * Sorting explicitly (rather than reversing the array) means this stays correct
 * no matter what order the venue decides to return tomorrow.
 */
export function normalizeLadder(raw: RawBook): Ladder {
  return {
    bids: toLevels(raw.bids).sort((a, b) => b[0] - a[0]),
    asks: toLevels(raw.asks).sort((a, b) => a[0] - b[0]),
  };
}

function toLevels(rows: RawLevel[] | undefined): Level[] {
  const out: Level[] = [];
  for (const r of rows ?? []) {
    const price = dollarsStringToCents(r.price);
    const size = sizeStringToQty(r.size);
    if (price == null || size == null) continue;
    if (!(price > 0) || !(price < 100) || !(size > 0)) continue;
    out.push([price, size]);
  }
  return out;
}

function bookTimestamp(...books: RawBook[]): Date {
  for (const b of books) {
    const ms = num(b.timestamp);
    // The CLOB reports epoch milliseconds; guard against a seconds-shaped value.
    if (ms && ms > 1e12) return new Date(ms);
    if (ms && ms > 1e9) return new Date(ms * 1000);
  }
  return new Date();
}

function marketStatus(m: RawMarket): NormalizedMarket['status'] {
  if (m.umaResolutionStatus === 'resolved' || m.closed === true) return 'resolved';
  if (m.active === false) return 'closed';
  const end = parseDate(m.endDate);
  if (end && end.getTime() < Date.now()) return 'resolving';
  return 'open';
}

function resolutionOf(m: RawMarket, prices: string[]): { resolution?: 'yes' | 'no' } {
  if (m.closed !== true) return {};
  const yes = dollarsStringToCents(prices[0]);
  if (yes == null) return {};
  if (yes >= 99) return { resolution: 'yes' };
  if (yes <= 1) return { resolution: 'no' };
  return {}; // 50/50 void — deliberately not a resolution, so it cannot score.
}

function seriesKeyFromTicker(ticker: string): string {
  return ticker.split('-')[0] ?? ticker;
}

/**
 * Map Polymarket tags onto Polyfill's own category set. Categories drive the
 * per-category calibration breakdown, so they need to be stable across venues.
 */
function categorize(e: RawEvent): string {
  const tags = (e.tags ?? []).map((t) => (typeof t === 'string' ? t : t.slug ?? '').toLowerCase());
  const hay = `${tags.join(' ')} ${(e.title ?? '').toLowerCase()}`;

  if (/politic|election|congress|senate|president|nomine/.test(hay)) return 'politics';
  if (/sport|nfl|nba|mlb|soccer|football|tennis|esport|ufc|f1|golf|hockey/.test(hay)) return 'sports';
  if (/crypto|bitcoin|ethereum|btc|eth|solana|token/.test(hay)) return 'crypto';
  if (/econom|inflation|fed|rates|gdp|jobs|cpi|recession/.test(hay)) return 'economics';
  if (/science|space|climate|health|ai |artificial intelligence|tech/.test(hay)) return 'science';
  if (/movie|music|award|oscar|celebrit|culture|tv|game/.test(hay)) return 'culture';
  return 'other';
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const FIDELITY_MINUTES: Record<Interval, number> = {
  '1m': 1,
  '5m': 5,
  '1h': 60,
  '6h': 360,
  '1d': 1440,
  '1w': 10080,
};

/** Convenience for callers that only have a mid and want a probability. */
export function bookMid(book: NormalizedBook): number | null {
  return midPrice(book.yes);
}

// ── Raw API shapes (only the fields we actually read) ────────────────────────

interface RawLevel {
  price?: string | number;
  size?: string | number;
}

export interface RawBook {
  market?: string;
  asset_id?: string;
  timestamp?: string | number;
  bids?: RawLevel[];
  asks?: RawLevel[];
  tick_size?: string | number;
  min_order_size?: string | number;
}

interface RawMarket {
  conditionId: string;
  question?: string;
  groupItemTitle?: string;
  slug?: string;
  description?: string;
  resolutionSource?: string;
  outcomes?: string;
  outcomePrices?: string;
  clobTokenIds?: string;
  bestBid?: string | number;
  bestAsk?: string | number;
  lastTradePrice?: string | number;
  oneDayPriceChange?: string | number;
  orderPriceMinTickSize?: string | number;
  orderMinSize?: string | number;
  volume?: string | number;
  volumeNum?: string | number;
  volume24hr?: string | number;
  liquidity?: string | number;
  liquidityNum?: string | number;
  active?: boolean;
  closed?: boolean;
  enableOrderBook?: boolean;
  umaResolutionStatus?: string;
  startDate?: string;
  endDate?: string;
  closedTime?: string;
  events?: { id?: string | number }[];
}

interface RawEvent {
  id: string | number;
  ticker?: string;
  title?: string;
  slug?: string;
  description?: string;
  image?: string;
  startDate?: string;
  endDate?: string;
  closed?: boolean;
  tags?: ({ slug?: string } | string)[];
  markets?: RawMarket[];
}
