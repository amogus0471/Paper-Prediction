import {
  computeFee as coreComputeFee,
  roundPrice,
  roundQty,
  type Ladder,
  type Level,
  type NormalizedBook,
  type OrderSide,
} from '@polyfill/core';
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

const API = 'https://api.limitless.exchange';

/**
 * Limitless adapter — a CLOB prediction market on Base.
 *
 * The same instrument as the other three: binary YES/NO shares between $0 and
 * $1, settling to one or zero. Reads need no key, no wallet and no cookie,
 * which is the entire reason this venue is here and the memecoin terminals are
 * not — see docs/VENUE_RESEARCH.md.
 *
 * Three things about this API will bite:
 *
 *   1. `limit` is capped at 25. Ask for 26 and you get a 400 with no data at
 *      all, not a truncated page — so paginate with `page`, never widen.
 *   2. Sizes are RAW COLLATERAL UNITS. USDC has 6 decimals, so `100000000` is
 *      100 shares, not a hundred million. Getting this wrong scales every fill
 *      quantity by a million and every number downstream stays self-consistent
 *      while being nonsense.
 *   3. The orderbook endpoint only ever returns the YES token's book. It
 *      accepts a `tokenId` parameter and ignores it — verified live. So the NO
 *      ladder here is MIRRORED, not fetched.
 *
 * That last point matters for how much the invariant check is worth. On
 * Hyperliquid, YES and NO are independently quoted and agreement between them
 * is real evidence the parse is right. Here the mirror is constructed by us, so
 * `checkBookInvariants` passing is a tautology and proves only that we can
 * subtract. The parse is evidenced instead by the venue's own `prices` array,
 * which the tests compare against the book.
 */
export class LimitlessAdapter implements VenueAdapter {
  readonly code = 'limitless' as const;
  readonly displayName = 'Limitless';
  readonly unitNoun = 'shares';

  /** Their hard ceiling. Asking for more returns 400, not a shorter page. */
  static readonly MAX_PAGE = 25;

  async listEvents(cursor?: string, limit = 25): Promise<{ events: NormalizedEvent[]; next?: string }> {
    const page = cursor ? Number(cursor) : 1;
    const size = Math.min(limit, LimitlessAdapter.MAX_PAGE);
    const raw = await venueFetch<RawList>(
      this.code,
      `${API}/markets/active?limit=${size}&page=${page}`,
    );

    const rows = raw.data ?? [];
    const events = rows.map((m) => this.toEvent(m)).filter((e) => e.markets.length > 0);
    const seen = page * size;
    const next = seen < (raw.totalMarketsCount ?? 0) && rows.length > 0 ? String(page + 1) : undefined;
    return { events, ...(next ? { next } : {}) };
  }

  async getMarkets(slugs: string[]): Promise<NormalizedMarket[]> {
    if (slugs.length === 0) return [];
    const rows = await mapConcurrent(slugs, 4, async (slug) => {
      try {
        return await venueFetch<RawMarket>(this.code, `${API}/markets/${encodeURIComponent(slug)}`);
      } catch {
        return null;
      }
    });
    return rows.flatMap((m) => (m ? [this.toMarket(m)] : []));
  }

  async getOrderBook(ref: BookRef): Promise<NormalizedBook> {
    if (ref.venue !== 'limitless') throw new VenueError(this.code, 0, 'wrong adapter for book ref');

    let raw: RawBook = {};
    try {
      raw = await venueFetch<RawBook>(
        this.code,
        `${API}/markets/${encodeURIComponent(ref.slug)}/orderbook`,
      );
    } catch (e) {
      // `/markets/active` lists markets whose book is already gone — the venue
      // runs 5- and 15-minute markets that roll faster than its own listing
      // does, and asking for one answers 400 "Market is not active".
      //
      // An empty book is the truthful normalisation of that: there genuinely is
      // no liquidity, `midPrice` becomes null, and the fill engine refuses the
      // order with "no visible liquidity" instead of the popup throwing once a
      // second. Anything that is not that specific 400 still propagates.
      if (!isInactive(e)) throw e;
    }

    const yes = toLadder(raw, ref.decimals);
    return {
      marketId: ref.slug,
      capturedAt: new Date(),
      yes,
      // Mirrored, not fetched — the venue exposes one side. A YES bid at 51.2c
      // IS a NO ask at 48.8c for the same size, which is an identity rather
      // than an approximation, but it is OUR arithmetic and not the venue's
      // quote. Treat agreement with the YES side as proof of nothing.
      no: mirror(yes),
    };
  }

  async getOrderBooks(refs: BookRef[]): Promise<Map<string, NormalizedBook>> {
    const out = new Map<string, NormalizedBook>();
    const books = await mapConcurrent(refs, 4, async (ref) => {
      try {
        return { ref, book: await this.getOrderBook(ref) };
      } catch {
        return null;
      }
    });
    for (const e of books) {
      if (e && e.ref.venue === 'limitless') out.set(e.ref.slug, e.book);
    }
    return out;
  }

  /** No public candle endpoint. Returning [] beats inventing a shape. */
  async getPriceHistory(_r: BookRef, _f: Date, _t: Date, _i: Interval): Promise<Candle[]> {
    return [];
  }

  async getResolutions(slugs: string[]): Promise<Resolution[]> {
    const markets = await this.getMarkets(slugs);
    return markets.map((m) => ({
      venueMarketId: m.venueMarketId,
      status: m.status,
      resolution: m.resolution ?? null,
      ...(m.resolvedAt ? { resolvedAt: m.resolvedAt } : {}),
    }));
  }

  /** No explicit taker fee is published; the cost is the spread. */
  computeFee(qty: number, priceCents: number, side: OrderSide, multiplier = 1): number {
    return coreComputeFee({ kind: 'none' }, qty, priceCents, side, multiplier);
  }

  private toEvent(m: RawMarket): NormalizedEvent {
    const market = this.toMarket(m);
    return {
      venue: this.code,
      venueEventId: m.slug ?? String(m.id ?? ''),
      title: m.title ?? m.proxyTitle ?? 'Untitled market',
      category: m.categories?.[0] ?? 'Other',
      isActive: statusOf(m) === 'open',
      ...(m.slug ? { slug: m.slug } : {}),
      ...(closeOf(m) ? { closeTime: closeOf(m)! } : {}),
      markets: [market],
    };
  }

  private toMarket(m: RawMarket): NormalizedMarket {
    // `prices` is [yesProbability, noProbability] as fractions of 1.
    const yesMid = typeof m.prices?.[0] === 'number' ? roundPrice(m.prices[0] * 100) : undefined;
    const decimals = m.collateralToken?.decimals ?? 6;
    const close = closeOf(m);

    return {
      venue: this.code,
      venueEventId: m.slug ?? String(m.id ?? ''),
      // The slug addresses both the market and its book, so it IS the id.
      venueMarketId: m.slug ?? String(m.id ?? ''),
      question: m.title ?? m.proxyTitle ?? 'Untitled market',
      ...(m.slug ? { slug: m.slug } : {}),
      yesLabel: 'Yes',
      noLabel: 'No',
      status: statusOf(m),
      ...(yesMid != null ? { midPrice: yesMid, lastPrice: yesMid } : {}),
      volumeTotal: Number(m.volumeFormatted ?? 0) || 0,
      volume24h: 0,
      // Quotes carry three decimals of a dollar — a tenth of a cent.
      tickCents: 0.1,
      minOrderSize: 1,
      ...(close ? { closeTime: close } : {}),
      ...(m.winningOutcomeIndex === 0
        ? { resolution: 'yes' as const }
        : m.winningOutcomeIndex === 1
          ? { resolution: 'no' as const }
          : {}),
      bookRef: { venue: 'limitless', slug: m.slug ?? String(m.id ?? ''), decimals },
    };
  }
}

/** The venue's way of saying "this market has already rolled". */
function isInactive(e: unknown): boolean {
  return e instanceof VenueError && e.status === 400 && /not active/i.test(e.message);
}

/** A YES ladder reflected into the NO ladder: price 100-p, same size. */
export function mirror(yes: Ladder): Ladder {
  return {
    bids: yes.asks.map(([p, q]): Level => [roundPrice(100 - p), q]),
    asks: yes.bids.map(([p, q]): Level => [roundPrice(100 - p), q]),
  };
}

function toLadder(raw: RawBook | null | undefined, decimals: number): Ladder {
  return {
    bids: levels(raw?.bids, decimals).sort((a, b) => b[0] - a[0]),
    asks: levels(raw?.asks, decimals).sort((a, b) => a[0] - b[0]),
  };
}

function levels(rows: RawLevel[] | undefined, decimals: number): Level[] {
  const scale = 10 ** decimals;
  const out: Level[] = [];
  for (const r of rows ?? []) {
    const priceCents = roundPrice(Number(r.price) * 100);
    const size = roundQty(Number(r.size) / scale);
    if (!Number.isFinite(priceCents) || !Number.isFinite(size)) continue;
    if (!(priceCents > 0) || !(priceCents < 100) || !(size > 0)) continue;
    out.push([priceCents, size]);
  }
  return out;
}

function statusOf(m: RawMarket): NormalizedMarket['status'] {
  if (m.winningOutcomeIndex === 0 || m.winningOutcomeIndex === 1) return 'resolved';
  if ((m.status ?? '').toUpperCase() === 'RESOLVED') return 'resolved';
  if (m.expired === true) return 'resolving';
  const close = closeOf(m);
  if (close && close.getTime() < Date.now()) return 'resolving';
  return 'open';
}

function closeOf(m: RawMarket): Date | undefined {
  const ts = Number(m.expirationTimestamp);
  if (Number.isFinite(ts) && ts > 0) return new Date(ts);
  if (m.expirationDate) {
    const d = new Date(m.expirationDate);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return undefined;
}

interface RawList {
  data?: RawMarket[];
  totalMarketsCount?: number;
}

interface RawMarket {
  id?: number;
  slug?: string;
  title?: string;
  proxyTitle?: string;
  status?: string;
  expired?: boolean;
  categories?: string[];
  prices?: number[];
  volumeFormatted?: string;
  expirationDate?: string;
  expirationTimestamp?: number;
  winningOutcomeIndex?: number | null;
  tradeType?: string;
  collateralToken?: { decimals?: number; symbol?: string };
  tokens?: { yes?: string; no?: string };
}

interface RawLevel {
  price?: number | string;
  size?: number | string;
  side?: string;
}

interface RawBook {
  bids?: RawLevel[];
  asks?: RawLevel[];
  tokenId?: string;
  midpoint?: number;
  minSize?: string;
}
