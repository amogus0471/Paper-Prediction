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
 */

import { KalshiAdapter, PolymarketAdapter } from '@polyfill/venues';
import type { NormalizedMarket } from '@polyfill/venues';
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
  | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }

  const parts = u.pathname.split('/').filter(Boolean);

  if (u.hostname.endsWith('polymarket.com')) {
    // /event/<slug> — the slug is the event, not the market.
    if (parts[0] === 'event' && parts[1]) return { venue: 'polymarket', slug: parts[1] };
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
    category,
  };
}

const polymarket = new PolymarketAdapter();
const kalshi = new KalshiAdapter({ env: 'prod' });

export async function resolveUrl(url: string): Promise<ResolvedMarket | null> {
  const parsed = parseVenueUrl(url);
  if (!parsed) return null;

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

    const tradeable = normalized.markets.filter((m) => m.status === 'open');
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

  const tradeable = normalized.markets.filter((m) => m.status === 'open');
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
export async function fetchBook(meta: MarketMeta) {
  const adapter = meta.venue === 'polymarket' ? polymarket : kalshi;
  const markets = await adapter.getMarkets([meta.venueMarketId]);
  const fresh = markets[0];
  const ref = fresh?.bookRef ?? bookRefFor(meta);
  const book = await adapter.getOrderBook(ref);
  return { book, meta: fresh ? toMeta(fresh, meta.category ?? 'other') : meta };
}

function bookRefFor(meta: MarketMeta) {
  if (meta.venue === 'kalshi') return { venue: 'kalshi' as const, ticker: meta.venueMarketId };
  throw new Error('Polymarket needs a token pair; refetch the market first.');
}

/** Trending markets for the side panel's browse view. Nothing is persisted. */
export async function trending(limit = 24) {
  const [pm, ks] = await Promise.allSettled([
    polymarket.listEvents(undefined, Math.ceil(limit / 2)),
    kalshi.listEvents(undefined, Math.ceil(limit / 2)),
  ]);

  const out: { meta: MarketMeta; mid: number | null; volume24h: number; category: string; imageUrl?: string }[] = [];

  for (const settled of [pm, ks]) {
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
