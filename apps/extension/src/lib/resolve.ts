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
): { venue: 'polymarket'; slug: string } | { venue: 'kalshi'; series: string; ticker?: string } | null {
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
    if (parts[0] === 'markets' && parts[1]) {
      const ticker = parts[3] ?? parts[2];
      return { venue: 'kalshi', series: parts[1].toUpperCase(), ticker };
    }
    return null;
  }

  return null;
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

  // Kalshi: the URL carries an event ticker; ask the API for its markets.
  const ticker = parsed.ticker ?? parsed.series;
  const res = await fetch(
    `https://api.elections.kalshi.com/trade-api/v2/events/${encodeURIComponent(ticker)}?with_nested_markets=true`,
  );
  if (!res.ok) return null;
  const payload = (await res.json()) as { event?: unknown };
  if (!payload.event) return null;

  const normalized = (kalshi as unknown as {
    normalizeEvent(e: unknown): { category: string; markets: NormalizedMarket[] };
  }).normalizeEvent(payload.event);

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
