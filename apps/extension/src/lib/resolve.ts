/**
 * Turn a venue URL into a tradeable market.
 *
 * Detection is by URL PARSING, never DOM scraping. Both sites are React SPAs
 * that reshuffle their markup on every deploy; a selector that works today is a
 * silent breakage next week. URLs are a public contract and change far less
 * often — and when they do, it fails loudly here instead of quietly showing a
 * price for the wrong market.
 *
 *   https://polymarket.com/event/<event-slug>
 *   https://polymarket.com/event/<event-slug>/<market-slug>
 *   https://kalshi.com/markets/<series>/<subtitle>
 *   https://kalshi.com/markets/<series>/<subtitle>/<event-ticker>
 *   https://app.hyperliquid.xyz/outcomes/<coin>
 *   https://app.hyperliquid.xyz/trade/#<coin>
 *   https://limitless.exchange/markets/<slug>
 */

import {
  HyperliquidAdapter,
  KalshiAdapter,
  LimitlessAdapter,
  PolymarketAdapter,
} from '@polyfill/venues';
import type { BookRef, NormalizedMarket } from '@polyfill/venues';
import type { MarketMeta } from './engine';

export interface ResolvedMarket {
  meta: MarketMeta;
  /** Sibling markets in the same event, so the overlay can offer a picker. */
  siblings: { meta: MarketMeta; mid: number | null }[];
}

export function parseVenueUrl(
  url: string,
):
  | { venue: 'polymarket'; slug: string }
  | { venue: 'kalshi'; series: string; ticker?: string; slug?: string }
  | { venue: 'hyperliquid'; coin: string }
  | { venue: 'limitless'; slug: string }
  | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }

  const parts = u.pathname.split('/').filter(Boolean);

  if (u.hostname.endsWith('hyperliquid.xyz')) {
    // Route is `/outcomes/:coin`, read straight out of their bundle. The coin
    // is a HIP-4 asset id like `#10250`, and the literal `#` is why this needs
    // three shapes rather than one:
    //
    //   /outcomes/%2310250   the encoded path form
    //   /trade/#10250        where their own router lands you — an unescaped
    //                        `#` in a path IS a fragment, so the coin arrives
    //                        in location.hash and pathname is just "/trade/"
    //   /outcomes/10250      the bare digits, if a link ever drops the hash
    //
    // Verified live: /outcomes/%2310250 redirects to /trade/#10250, while an
    // unknown coin falls back to /trade/HYPE — which is how we know the app
    // resolved it rather than ignored it.
    const hash = u.hash.startsWith('#') ? u.hash.slice(1) : '';
    const seg = parts[0] === 'outcomes' || parts[0] === 'trade' ? (parts[1] ?? '') : '';
    let coin = '';
    try {
      coin = decodeURIComponent(seg);
    } catch {
      coin = seg;
    }
    if (!coin && hash) coin = `#${hash}`;
    if (/^\d+$/.test(coin)) coin = `#${coin}`;

    // A perp lives at /trade/BTC and is NOT a prediction — leverage, funding
    // and liquidation, and it never settles to $1/$0. Only `#`-prefixed
    // outcome assets get a popup.
    if (!/^#\d+[01]$/.test(coin)) return null;
    return { venue: 'hyperliquid', coin };
  }

  if (u.hostname.endsWith('polymarket.com')) {
    // /event/<slug> — the slug is the event, not the market.
    if (parts[0] === 'event' && parts[1]) return { venue: 'polymarket', slug: parts[1] };
    return null;
  }

  if (u.hostname.endsWith('limitless.exchange')) {
    // /markets/<slug>, and the slug is also the book's address.
    if (parts[0] === 'markets' && parts[1]) return { venue: 'limitless', slug: parts[1] };
    return null;
  }

  if (u.hostname.endsWith('kalshi.com')) {
    // /markets/<series>/<subtitle>[/<event-ticker>]
    //
    // Only the FIRST segment is reliably a ticker. The later ones are
    // human-readable slugs ("bitcoin-above"), and treating one as an event
    // ticker sends /events/bitcoin-above, which 404s — that is why the popup
    // never appeared on Kalshi. An event ticker always looks like
    // SERIES-SUFFIX in caps, so only accept a segment that matches that.
    if (parts[0] === 'markets' && parts[1]) {
      const series = parts[1].toUpperCase();
      const candidate = [parts[3], parts[2]].find(
        (p) => p && /^[A-Za-z0-9]+-[A-Za-z0-9]+/.test(p) && p === p.toUpperCase(),
      );
      // The lower-case segment is a human slug of the event title; keep it so
      // the series fallback can identify WHICH event the page is showing.
      const slug = [parts[2], parts[3]].find((p) => p && p !== candidate && /[a-z]/.test(p));
      return {
        venue: 'kalshi',
        series,
        ...(candidate ? { ticker: candidate } : {}),
        ...(slug ? { slug } : {}),
      };
    }
    return null;
  }

  return null;
}

/** Words that carry no identifying signal in a market title. */
const STOP = new Set(['vs', 'v', 'the', 'a', 'an', 'and', 'or', 'to', 'in', 'at', 'of', 'will']);

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(' ')
      .filter((w) => w.length > 1 && !STOP.has(w)),
  );
}

/**
 * Pick the event a URL slug refers to, or nothing.
 *
 * Scores token overlap between the slug and each event's title. Requires a
 * clear winner: if the best candidate shares fewer than half the slug's words,
 * we would be guessing, and a confidently-wrong market is the worst outcome
 * available here.
 */
function bestSlugMatch<T extends { title?: string; sub_title?: string; event_ticker?: string }>(
  events: T[],
  slug: string,
): T | null {
  const want = tokens(slug);
  if (want.size === 0) return null;

  let best: T | null = null;
  let bestScore = 0;
  for (const e of events) {
    const have = tokens(`${e.title ?? ''} ${e.sub_title ?? ''} ${e.event_ticker ?? ''}`);
    let hits = 0;
    for (const w of want) if (have.has(w)) hits++;
    if (hits > bestScore) {
      bestScore = hits;
      best = e;
    }
  }
  return bestScore / want.size >= 0.5 ? best : null;
}

function toMeta(m: NormalizedMarket, category: string): MarketMeta {
  return {
    venue: m.venue,
    venueMarketId: m.venueMarketId,
    question: m.question,
    yesLabel: m.yesLabel,
    noLabel: m.noLabel,
    tickCents: m.tickCents,
    minOrderSize: m.minOrderSize,
    closeTime: m.closeTime?.toISOString(),
    ...(m.slug ? { slug: m.slug } : {}),
    ...(m.imageUrl ? { imageUrl: m.imageUrl } : {}),
    bookRef: m.bookRef,
    category,
  };
}

const polymarket = new PolymarketAdapter();
const kalshi = new KalshiAdapter({ env: 'prod' });
const hyperliquid = new HyperliquidAdapter();
const limitless = new LimitlessAdapter();

const ADAPTERS = { polymarket, kalshi, hyperliquid, limitless } as const;

export function adapterFor(venue: string) {
  return ADAPTERS[venue as keyof typeof ADAPTERS] ?? polymarket;
}

/**
 * The markets a page should offer, preferring open ones but never returning
 * nothing when the page clearly has a market on it.
 *
 * Returning `null` for a past-its-end-date market is why the popup "sometimes
 * doesn't appear": a finished esports event still lists as an open EVENT with
 * forty closed markets under it, so the panel silently declined to exist and
 * looked exactly like a broken extension. Showing it and letting the engine's
 * `market_closed` guard explain itself is strictly better — nothing here can
 * be traded either way, and the difference is whether the user is told.
 */
function tradeableMarkets(markets: NormalizedMarket[]): NormalizedMarket[] {
  const open = markets.filter((m) => m.status === 'open');
  if (open.length > 0) return open;
  return markets.filter((m) => m.status !== 'resolved');
}

export async function resolveUrl(url: string): Promise<ResolvedMarket | null> {
  const parsed = parseVenueUrl(url);
  if (!parsed) return null;

  if (parsed.venue === 'limitless') {
    // One market per slug and no event grouping, so there are no siblings to
    // offer — the picker simply does not appear on this venue.
    const [market] = await limitless.getMarkets([parsed.slug]);
    if (!market) return null;
    const category = market.venue === 'limitless' ? 'Limitless' : market.venue;
    const meta = toMeta(market, category);
    return { meta, siblings: [{ meta, mid: market.midPrice ?? null }] };
  }

  if (parsed.venue === 'hyperliquid') {
    // outcomeMeta describes every live outcome in one call, so finding the coin
    // and its siblings costs the same as finding the coin alone.
    const { events } = await hyperliquid.listEvents();
    for (const ev of events) {
      const hit = ev.markets.find((m) => m.venueMarketId === parsed.coin);
      if (!hit) continue;
      const tradeable = tradeableMarkets(ev.markets);
      if (tradeable.length === 0) return null;
      return {
        meta: toMeta(hit, ev.category),
        siblings: tradeable.map((m) => ({ meta: toMeta(m, ev.category), mid: m.midPrice ?? null })),
      };
    }
    return null;
  }

  if (parsed.venue === 'polymarket') {
    const res = await fetch(
      `https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(parsed.slug)}`,
    );
    if (!res.ok) return null;
    const events = (await res.json()) as unknown[];
    if (!Array.isArray(events) || events.length === 0) return null;

    // Reuse the adapter's normalizer rather than re-parsing the payload here,
    // so the overlay and the fill engine agree on every field.
    const normalized = (polymarket as unknown as {
      normalizeEvent(e: unknown): { category: string; markets: NormalizedMarket[] };
    }).normalizeEvent(events[0]);

    const tradeable = tradeableMarkets(normalized.markets);
    if (tradeable.length === 0) return null;

    return {
      meta: toMeta(tradeable[0]!, normalized.category),
      siblings: tradeable.map((m) => ({
        meta: toMeta(m, normalized.category),
        mid: m.midPrice ?? null,
      })),
    };
  }

  // Kalshi: resolve by event ticker when the URL actually carried one,
  // otherwise fall back to the series and take its soonest open event — which
  // is what the page itself shows for a rolling series like hourly BTC.
  const K = 'https://api.elections.kalshi.com/trade-api/v2';
  let event: unknown = null;

  if (parsed.ticker) {
    const res = await fetch(`${K}/events/${encodeURIComponent(parsed.ticker)}?with_nested_markets=true`);
    if (res.ok) event = ((await res.json()) as { event?: unknown }).event ?? null;
  }

  if (!event) {
    const res = await fetch(
      `${K}/events?series_ticker=${encodeURIComponent(parsed.series)}&status=open&with_nested_markets=true&limit=200`,
    );
    if (!res.ok) return null;
    const { events } = (await res.json()) as {
      events?: { markets?: unknown[]; title?: string; sub_title?: string; event_ticker?: string }[];
    };

    // Match the URL slug against the event, rather than taking the first one.
    //
    // Taking events[0] is how the popup ended up showing "Larraya Guidi vs
    // Schaedel" while the page was "Estevez vs Labrana": one tennis series
    // holds every match of the tournament. Trading the wrong market is far
    // worse than trading none, so an ambiguous match resolves to nothing.
    const candidates = (events ?? []).filter((e) => (e.markets?.length ?? 0) > 0);
    event = parsed.slug ? bestSlugMatch(candidates, parsed.slug) : (candidates[0] ?? null);
  }

  if (!event) return null;

  const normalized = (kalshi as unknown as {
    normalizeEvent(e: unknown): { category: string; markets: NormalizedMarket[] };
  }).normalizeEvent(event);

  const tradeable = tradeableMarkets(normalized.markets);
  if (tradeable.length === 0) return null;

  return {
    meta: toMeta(tradeable[0]!, normalized.category),
    siblings: tradeable.map((m) => ({
      meta: toMeta(m, normalized.category),
      mid: m.midPrice ?? null,
    })),
  };
}

/** Fetch a live book for a market the overlay already resolved. */
/**
 * Book references, cached for the life of the service worker.
 *
 * A market's token pair never changes, so looking it up more than once is pure
 * latency. This is what makes a 1s poll affordable: one request per refresh
 * instead of a metadata round trip plus the book.
 */
const bookRefCache = new Map<string, BookRef>();

async function resolveBookRef(meta: MarketMeta): Promise<BookRef> {
  const key = `${meta.venue}:${meta.venueMarketId}`;

  // Carried through from resolveUrl in the common case — no network at all.
  if (meta.bookRef) {
    bookRefCache.set(key, meta.bookRef as BookRef);
    return meta.bookRef as BookRef;
  }

  const cached = bookRefCache.get(key);
  if (cached) return cached;

  // Kalshi addresses books by ticker, so it needs no lookup either.
  if (meta.venue === 'kalshi') {
    const ref = { venue: 'kalshi' as const, ticker: meta.venueMarketId };
    bookRefCache.set(key, ref);
    return ref;
  }

  // Limitless addresses a book by the same slug that identifies the market.
  // 6 is USDC's decimals and every market on the venue is USDC-collateralised;
  // a market that somehow is not will carry its own value in `meta.bookRef`.
  if (meta.venue === 'limitless') {
    const ref = { venue: 'limitless' as const, slug: meta.venueMarketId, decimals: 6 };
    bookRefCache.set(key, ref);
    return ref;
  }

  // Hyperliquid's two coins are derived from the market id by string rule.
  if (meta.venue === 'hyperliquid') {
    const base = meta.venueMarketId.replace(/[01]$/, '');
    const ref = { venue: 'hyperliquid' as const, yesCoin: `${base}0`, noCoin: `${base}1` };
    bookRefCache.set(key, ref);
    return ref;
  }

  // Polymarket alone needs its ERC-1155 token pair fetched. Once, ever.
  const adapter = polymarket;
  const markets = await adapter.getMarkets([meta.venueMarketId]);
  const ref = markets[0]?.bookRef;
  if (!ref) {
    throw new Error('Could not find this market on the venue.');
  }
  bookRefCache.set(key, ref);
  return ref;
}

/**
 * Book cache and in-flight de-duplication.
 *
 * The overlay asks for the same book three ways at once — GET_BOOK to paint
 * the price, QUOTE to price the ticket, and a watchlist sweep that may cover
 * the same market — each of which used to be its own venue round trip. On
 * Polymarket, where a book is two tokens, that was four CLOB reads a second
 * against a budget that tightens near a hundred a minute. The 429s that earned
 * are exactly why prices "randomly" stopped updating: `refreshBook` swallows
 * errors, so a rate-limited poll looks identical to a working one that found
 * no change.
 *
 * The TTL is deliberately shorter than the poll interval, so a cache hit only
 * ever collapses requests that belong to the SAME tick. Nothing is ever served
 * from a previous second.
 */
export const BOOK_CACHE_MS = 700;

interface CachedBook {
  book: Awaited<ReturnType<PolymarketAdapter['getOrderBook']>>;
  at: number;
}

const bookCache = new Map<string, CachedBook>();
const bookInFlight = new Map<string, Promise<CachedBook['book']>>();

/** Drop a market's cached book, so the next read is guaranteed to hit the venue. */
export function invalidateBook(meta: MarketMeta): void {
  bookCache.delete(`${meta.venue}:${meta.venueMarketId}`);
}

/**
 * Fetch a live book for a market the overlay already resolved.
 *
 * `fresh` bypasses both the cache AND any in-flight request. Every path that
 * commits a fill must pass it: rule 3 of the fill engine says the fill is
 * walked against a book fetched AFTER the quote, and joining a request that
 * was already running when the quote was made would quietly break that.
 */
export async function fetchBook(meta: MarketMeta, opts: { fresh?: boolean } = {}) {
  const key = `${meta.venue}:${meta.venueMarketId}`;

  if (!opts.fresh) {
    const hit = bookCache.get(key);
    if (hit && Date.now() - hit.at < BOOK_CACHE_MS) return { book: hit.book, meta };
    const flying = bookInFlight.get(key);
    if (flying) return { book: await flying, meta };
  }

  const adapter = adapterFor(meta.venue);
  const task = (async () => {
    const ref = await resolveBookRef(meta);
    const book = await adapter.getOrderBook(ref);
    bookCache.set(key, { book, at: Date.now() });
    // Bounded: one entry per market the session has touched, and they are tiny.
    if (bookCache.size > 200) {
      for (const k of [...bookCache.keys()].slice(0, 100)) bookCache.delete(k);
    }
    return book;
  })();

  // Only a non-fresh fetch is publishable for others to join.
  if (!opts.fresh) bookInFlight.set(key, task);
  try {
    return { book: await task, meta };
  } finally {
    if (bookInFlight.get(key) === task) bookInFlight.delete(key);
  }
}

/** Trending markets for the side panel's browse view. Nothing is persisted. */
export async function trending(limit = 24) {
  const [pm, ks, hl, lx] = await Promise.allSettled([
    polymarket.listEvents(undefined, Math.ceil(limit / 2)),
    kalshi.listEvents(undefined, Math.ceil(limit / 2)),
    hyperliquid.listEvents(),
    limitless.listEvents(),
  ]);

  const out: { meta: MarketMeta; mid: number | null; volume24h: number; category: string; imageUrl?: string }[] = [];

  for (const settled of [pm, ks, hl, lx]) {
    if (settled.status !== 'fulfilled') continue;
    for (const ev of settled.value.events) {
      for (const m of ev.markets) {
        if (m.status !== 'open') continue;
        out.push({
          meta: toMeta(m, ev.category),
          mid: m.midPrice ?? m.lastPrice ?? null,
          volume24h: m.volume24h ?? 0,
          category: ev.category,
          imageUrl: ev.imageUrl,
        });
      }
    }
  }

  return out.sort((a, b) => b.volume24h - a.volume24h).slice(0, limit);
}

export async function searchMarkets(query: string, limit = 20) {
  const all = await trending(120);
  const q = query.toLowerCase().trim();
  if (!q) return all.slice(0, limit);
  return all.filter((m) => m.meta.question.toLowerCase().includes(q)).slice(0, limit);
}
