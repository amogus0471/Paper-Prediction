import {
  DEFAULT_FEE_MODELS,
  computeFee as coreComputeFee,
  roundPrice,
  type Ladder,
  type Level,
  type NormalizedBook,
  type OrderSide,
} from '@polyfill/core';
import { dollarsStringToCents, num, parseDate, sizeStringToQty } from './decimal-parse';
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

/**
 * Kalshi hosts. Market data reads on the elections host are PUBLIC — verified
 * live: `GET /markets` and `GET /markets/{ticker}/orderbook` both return 200
 * with no credentials at all.
 *
 * That contradicts guidance saying the orderbook requires RSA-PSS signing, so
 * it is worth being explicit: signing is required for account and trading
 * endpoints, which Polyfill never calls, because Polyfill never places a real
 * order. If a read ever starts returning 401, `KalshiAdapter` will surface it
 * as a retryable VenueError rather than silently serving a stale book.
 */
const HOSTS = {
  prod: 'https://api.elections.kalshi.com/trade-api/v2',
  demo: 'https://demo-api.kalshi.co/trade-api/v2',
} as const;

/**
 * Kalshi's tick grid is described by `price_level_structure`, not a tick field.
 * Anything unrecognized falls back to a whole cent, which is the coarsest and
 * therefore the safest assumption — it can never invent precision.
 */
const TICK_BY_STRUCTURE: Record<string, number> = {
  linear_cent: 1,
  cent: 1,
  deci_cent: 0.1,
  tapered_deci_cent: 0.1,
  linear_deci_cent: 0.1,
};

export interface KalshiOptions {
  /** 'prod' reads the live elections host; 'demo' points at the sandbox. */
  env?: keyof typeof HOSTS;
  baseUrl?: string;
}

/**
 * Kalshi adapter.
 *
 * The orderbook endpoint carries the single most dangerous payload in this
 * codebase. Two independent traps, both of which produce plausible-looking but
 * completely wrong fills:
 *
 *   1. IT RETURNS BID LADDERS ONLY. There are no asks in the response. A YES
 *      bid at 7c IS a NO ask at 93c with identical size, so both ask ladders
 *      must be synthesized by mirroring the opposite side's bids. Skip this and
 *      every buy prices against an empty book.
 *
 *   2. THE SHAPE IS `{orderbook_fp: {yes_dollars, no_dollars}}` where each level
 *      is `["0.1500", "100.00"]` — element 0 is a price in DOLLARS as a string,
 *      element 1 is a CONTRACT COUNT, not a price. Reading element 1 as a price
 *      is an easy and very expensive mistake.
 *
 * Verified live on KXELONMARS-99: yes bids topped at 0.0900 and no bids at
 * 0.8900, and the venue's own quoted yes_ask was 0.1100 == 100 - 89. The
 * mirror holds, and `checkBookInvariants` re-proves it on every snapshot.
 */
export class KalshiAdapter implements VenueAdapter {
  readonly code = 'kalshi' as const;
  readonly displayName = 'Kalshi';
  readonly unitNoun = 'contracts';

  private readonly base: string;

  constructor(opts: KalshiOptions = {}) {
    this.base = opts.baseUrl ?? HOSTS[opts.env ?? 'prod'];
  }

  async listEvents(cursor?: string, limit = 100): Promise<{ events: NormalizedEvent[]; next?: string }> {
    const url =
      `${this.base}/events?limit=${limit}&status=open&with_nested_markets=true` +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');

    const raw = await venueFetch<{ events?: RawEvent[]; cursor?: string }>(this.code, url);
    const events = (raw.events ?? [])
      // Multivariate parlay collections dominate the raw feed and are not
      // forecastable questions — they are combinatorial bundles. Skip them.
      .filter((e) => !isMultivariate(e.event_ticker))
      .map((e) => this.normalizeEvent(e))
      .filter((e) => e.markets.length > 0);

    return { events, ...(raw.cursor ? { next: raw.cursor } : {}) };
  }

  async getMarkets(tickers: string[]): Promise<NormalizedMarket[]> {
    if (tickers.length === 0) return [];
    const results = await mapConcurrent(tickers, 6, async (ticker) => {
      try {
        const raw = await venueFetch<{ market?: RawMarket }>(
          this.code,
          `${this.base}/markets/${encodeURIComponent(ticker)}`,
        );
        return raw.market ? this.normalizeMarket(raw.market, raw.market.event_ticker ?? '') : null;
      } catch {
        return null;
      }
    });
    return results.filter((m): m is NormalizedMarket => m !== null);
  }

  async getOrderBook(ref: BookRef): Promise<NormalizedBook> {
    if (ref.venue !== 'kalshi') throw new VenueError(this.code, 0, 'wrong adapter for book ref');

    const raw = await venueFetch<RawOrderbookResponse>(
      this.code,
      `${this.base}/markets/${encodeURIComponent(ref.ticker)}/orderbook?depth=100`,
    );

    const { yes, no } = normalizeKalshiBook(raw);
    return { marketId: ref.ticker, capturedAt: new Date(), yes, no };
  }

  async getOrderBooks(refs: BookRef[]): Promise<Map<string, NormalizedBook>> {
    const out = new Map<string, NormalizedBook>();
    const books = await mapConcurrent(refs, 8, async (ref) => {
      try {
        return { ref, book: await this.getOrderBook(ref) };
      } catch {
        return null;
      }
    });
    for (const entry of books) {
      if (entry && entry.ref.venue === 'kalshi') out.set(entry.ref.ticker, entry.book);
    }
    return out;
  }

  async getPriceHistory(ref: BookRef, from: Date, to: Date, interval: Interval): Promise<Candle[]> {
    if (ref.venue !== 'kalshi') return [];
    const period = PERIOD_MINUTES[interval] ?? 60;
    const url =
      `${this.base}/series/${seriesOf(ref.ticker)}/markets/${encodeURIComponent(ref.ticker)}/candlesticks` +
      `?start_ts=${Math.floor(from.getTime() / 1000)}&end_ts=${Math.floor(to.getTime() / 1000)}` +
      `&period_interval=${period}`;

    try {
      const raw = await venueFetch<{ candlesticks?: RawCandle[] }>(this.code, url);
      return (raw.candlesticks ?? []).flatMap((c) => {
        const ts = c.end_period_ts ? new Date(c.end_period_ts * 1000) : null;
        const price = c.price ?? {};
        const o = dollarsStringToCents(price.open_dollars);
        const h = dollarsStringToCents(price.high_dollars);
        const l = dollarsStringToCents(price.low_dollars);
        const close = dollarsStringToCents(price.close_dollars);
        if (!ts || o == null || h == null || l == null || close == null) return [];
        return [{ ts, o, h, l, c: close, v: num(c.volume_fp) ?? 0 }];
      });
    } catch {
      // Charts are a nice-to-have; never let a history 404 break ingestion.
      return [];
    }
  }

  async getResolutions(tickers: string[]): Promise<Resolution[]> {
    const results = await mapConcurrent(tickers, 6, async (ticker) => {
      try {
        const raw = await venueFetch<{ market?: RawMarket }>(
          this.code,
          `${this.base}/markets/${encodeURIComponent(ticker)}`,
        );
        const m = raw.market;
        if (!m) return null;
        return {
          venueMarketId: ticker,
          status: statusOf(m),
          resolution: resolutionOf(m),
          ...(parseDate(m.expiration_time) ? { resolvedAt: parseDate(m.expiration_time)! } : {}),
        } satisfies Resolution;
      } catch {
        return null;
      }
    });
    return results.filter((r): r is Resolution => r !== null);
  }

  computeFee(qty: number, priceCents: number, side: OrderSide, multiplier = 1): number {
    return coreComputeFee(DEFAULT_FEE_MODELS.kalshi!, qty, priceCents, side, multiplier);
  }

  private normalizeEvent(e: RawEvent): NormalizedEvent {
    const markets = (e.markets ?? [])
      .map((m) => this.normalizeMarket(m, e.event_ticker))
      .filter((m): m is NormalizedMarket => m !== null);

    return {
      venue: this.code,
      venueEventId: e.event_ticker,
      ...(e.series_ticker ? { seriesKey: e.series_ticker } : {}),
      title: e.title ?? e.event_ticker,
      ...(e.sub_title ? { description: e.sub_title } : {}),
      category: categorize(e.category, e.title),
      ...(e.category ? { subcategory: e.category } : {}),
      isActive: true,
      markets,
    };
  }

  private normalizeMarket(m: RawMarket, eventTicker: string): NormalizedMarket | null {
    if (!m.ticker || isMultivariate(m.ticker)) return null;

    const yesBid = dollarsStringToCents(m.yes_bid_dollars);
    const yesAsk = dollarsStringToCents(m.yes_ask_dollars);
    const noBid = dollarsStringToCents(m.no_bid_dollars);
    const noAsk = dollarsStringToCents(m.no_ask_dollars);
    const last = dollarsStringToCents(m.last_price_dollars);
    const prev = dollarsStringToCents(m.previous_price_dollars);

    const tick = TICK_BY_STRUCTURE[m.price_level_structure ?? ''] ?? 1;

    return {
      venue: this.code,
      venueEventId: m.event_ticker ?? eventTicker,
      venueMarketId: m.ticker,
      question: m.title ?? m.ticker,
      yesLabel: m.yes_sub_title || 'Yes',
      noLabel: m.no_sub_title || 'No',
      ...(m.rules_primary ? { resolutionRules: m.rules_primary } : {}),
      status: statusOf(m),
      ...(yesBid != null ? { yesBid } : {}),
      ...(yesAsk != null ? { yesAsk } : {}),
      ...(noBid != null ? { noBid } : {}),
      ...(noAsk != null ? { noAsk } : {}),
      ...(last != null ? { lastPrice: last } : {}),
      ...(yesBid != null && yesAsk != null ? { midPrice: roundPrice((yesBid + yesAsk) / 2) } : {}),
      ...(prev != null ? { price24hAgo: prev } : {}),
      volume24h: num(m.volume_24h_fp) ?? 0,
      volumeTotal: num(m.volume_fp) ?? 0,
      openInterest: num(m.open_interest_fp) ?? 0,
      liquidity: num(m.liquidity_dollars) ?? 0,
      tickCents: tick,
      minOrderSize: 1,
      ...(parseDate(m.open_time) ? { openTime: parseDate(m.open_time)! } : {}),
      ...(parseDate(m.close_time) ? { closeTime: parseDate(m.close_time)! } : {}),
      ...(parseDate(m.expiration_time) ? { resolvedAt: parseDate(m.expiration_time)! } : {}),
      ...(resolutionOf(m) ? { resolution: resolutionOf(m)! } : {}),
      bookRef: { venue: 'kalshi', ticker: m.ticker },
    };
  }
}

/**
 * The critical normalization. Bid ladders in, four complete ladders out.
 *
 * Mirroring rule, straight from Kalshi's own documentation:
 *   a YES bid at price X == a NO ask at (100 - X), identical size
 *   a NO  bid at price X == a YES ask at (100 - X), identical size
 */
export function normalizeKalshiBook(raw: RawOrderbookResponse): { yes: Ladder; no: Ladder } {
  const fp = raw.orderbook_fp ?? raw.orderbook ?? {};
  const yesBids = toLevels(fp.yes_dollars ?? fp.yes);
  const noBids = toLevels(fp.no_dollars ?? fp.no);

  // Mirror each side's bids into the other side's asks. This is the whole
  // reason a Kalshi book can be traded at all.
  const yesAsks = mirror(noBids);
  const noAsks = mirror(yesBids);

  return {
    yes: {
      bids: yesBids.sort((a, b) => b[0] - a[0]),
      asks: yesAsks.sort((a, b) => a[0] - b[0]),
    },
    no: {
      bids: noBids.sort((a, b) => b[0] - a[0]),
      asks: noAsks.sort((a, b) => a[0] - b[0]),
    },
  };
}

function mirror(levels: Level[]): Level[] {
  const out: Level[] = [];
  for (const [price, size] of levels) {
    const mirrored = roundPrice(100 - price);
    if (mirrored > 0 && mirrored < 100) out.push([mirrored, size]);
  }
  return out;
}

/**
 * Parse `[["0.1500", "100.00"], ...]`.
 * Element 0 is a price in DOLLARS. Element 1 is a CONTRACT COUNT.
 */
function toLevels(rows: RawLevel[] | undefined): Level[] {
  const out: Level[] = [];
  for (const row of rows ?? []) {
    if (!Array.isArray(row) || row.length < 2) continue;
    const price = dollarsStringToCents(row[0] as string);
    const size = sizeStringToQty(row[1] as string);
    if (price == null || size == null) continue;
    if (!(price > 0) || !(price < 100) || !(size > 0)) continue;
    out.push([price, size]);
  }
  return out;
}

function statusOf(m: RawMarket): NormalizedMarket['status'] {
  const s = (m.status ?? '').toLowerCase();
  if (s === 'finalized' || s === 'settled') return 'resolved';
  if (s === 'closed' || s === 'determined') return 'resolving';
  if (s === 'active' || s === 'open' || s === 'initialized') {
    const close = parseDate(m.close_time);
    return close && close.getTime() < Date.now() ? 'resolving' : 'open';
  }
  return 'closed';
}

function resolutionOf(m: RawMarket): 'yes' | 'no' | null {
  const r = (m.result ?? '').toLowerCase();
  if (r === 'yes') return 'yes';
  if (r === 'no') return 'no';
  // 'void' / 'all_no' / '' are deliberately not resolutions — a void is not a
  // forecast error and must never enter the calibration corpus.
  return null;
}

/** `KXNBAGAME-26AUG06LALBOS-LAL` -> `KXNBAGAME` */
function seriesOf(ticker: string): string {
  return ticker.split('-')[0] ?? ticker;
}

function isMultivariate(ticker: string | undefined): boolean {
  return !!ticker && ticker.startsWith('KXMVE');
}

function categorize(category: string | undefined, title: string | undefined): string {
  const hay = `${category ?? ''} ${title ?? ''}`.toLowerCase();
  if (/politic|election|congress|senate|president|nomine|governor/.test(hay)) return 'politics';
  if (/sport|nfl|nba|mlb|soccer|football|tennis|ufc|f1|golf|hockey|olympic/.test(hay)) return 'sports';
  if (/crypto|bitcoin|ethereum|btc|eth|solana/.test(hay)) return 'crypto';
  if (/econom|inflation|fed|rates|gdp|jobs|cpi|recession|treasur/.test(hay)) return 'economics';
  if (/science|space|climate|health|weather|temperature|ai\b|tech/.test(hay)) return 'science';
  if (/movie|music|award|oscar|celebrit|culture|tv|entertain/.test(hay)) return 'culture';
  if (/world|geopolit|war|nato/.test(hay)) return 'politics';
  return 'other';
}

const PERIOD_MINUTES: Record<Interval, number> = {
  '1m': 1,
  '5m': 5,
  '1h': 60,
  '6h': 60,
  '1d': 1440,
  '1w': 1440,
};

// ── Raw API shapes ──────────────────────────────────────────────────────────

type RawLevel = [string | number, string | number];

interface RawOrderbookSide {
  yes_dollars?: RawLevel[];
  no_dollars?: RawLevel[];
  yes?: RawLevel[];
  no?: RawLevel[];
}

export interface RawOrderbookResponse {
  orderbook_fp?: RawOrderbookSide;
  /** Older shape, kept so a rollback on Kalshi's side does not break ingestion. */
  orderbook?: RawOrderbookSide;
}

interface RawCandle {
  end_period_ts?: number;
  volume_fp?: string | number;
  price?: {
    open_dollars?: string;
    high_dollars?: string;
    low_dollars?: string;
    close_dollars?: string;
  };
}

interface RawMarket {
  ticker?: string;
  event_ticker?: string;
  title?: string;
  yes_sub_title?: string;
  no_sub_title?: string;
  rules_primary?: string;
  status?: string;
  result?: string;
  yes_bid_dollars?: string;
  yes_ask_dollars?: string;
  no_bid_dollars?: string;
  no_ask_dollars?: string;
  last_price_dollars?: string;
  previous_price_dollars?: string;
  volume_fp?: string | number;
  volume_24h_fp?: string | number;
  open_interest_fp?: string | number;
  liquidity_dollars?: string | number;
  price_level_structure?: string;
  open_time?: string;
  close_time?: string;
  expiration_time?: string;
}

interface RawEvent {
  event_ticker: string;
  series_ticker?: string;
  title?: string;
  sub_title?: string;
  category?: string;
  markets?: RawMarket[];
}
