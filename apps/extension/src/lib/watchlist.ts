/**
 * Watchlist — purely local, and the client-side answer to the server's
 * hot/warm/cold tiering.
 *
 * A watched market gets polled more often than a browsed one, which is the
 * whole point: the price you glance at should be current. Poll pressure is
 * bounded by the list itself, so a user who stars 3 markets costs 3 requests a
 * cycle, not a crawl.
 */

import { midPrice } from '@polyfill/core';
import type { MarketMeta } from './engine';
import { marketKey, mutate, type LocalState, type WatchedMarket } from './store';

/** Hard ceiling. Above this the refresh loop stops being cheap. */
export const MAX_WATCHLIST = 25;

export function isWatched(state: LocalState, venue: string, venueMarketId: string): boolean {
  const key = marketKey(venue, venueMarketId);
  return state.watchlist.some((w) => w.marketKey === key);
}

/** Star / unstar. Returns the new watched state so the caller can render it. */
export async function toggleWatch(meta: MarketMeta, mid: number | null): Promise<boolean> {
  const key = marketKey(meta.venue, meta.venueMarketId);
  return mutate((state) => {
    const at = state.watchlist.findIndex((w) => w.marketKey === key);
    if (at >= 0) {
      state.watchlist.splice(at, 1);
      return false;
    }
    if (state.watchlist.length >= MAX_WATCHLIST) {
      // Drop the oldest rather than refusing — a silent cap that rejects the
      // user's click reads as a bug, and this list is not precious.
      state.watchlist.pop();
    }
    const entry: WatchedMarket = {
      marketKey: key,
      venue: meta.venue,
      venueMarketId: meta.venueMarketId,
      question: meta.question,
      category: meta.category,
      addedAt: new Date().toISOString(),
      lastMid: mid,
      ...(meta.slug ? { slug: meta.slug } : {}),
      lastSeenAt: new Date().toISOString(),
      closeTime: meta.closeTime,
    };
    state.watchlist.unshift(entry);
    return true;
  });
}

/** Record a fresh mid for a watched market after a book refresh. */
/** How many mids a watch row keeps for its sparkline. ~1 minute at 1s. */
export const HISTORY_POINTS = 60;

export async function noteMid(key: string, mid: number | null): Promise<void> {
  await mutate((state) => {
    const w = state.watchlist.find((x) => x.marketKey === key);
    if (!w) return;
    // Keep the previous mid so a row can colour its own direction, and a short
    // trail for its sparkline. Bounded, because this is persisted storage and
    // an unbounded array here would grow forever at one point per second.
    if (mid != null && mid !== w.lastMid) {
      w.prevMid = w.lastMid;
      w.history = [...(w.history ?? []), mid].slice(-HISTORY_POINTS);
    }
    w.lastMid = mid;
    w.lastSeenAt = new Date().toISOString();
  });
}

/**
 * Markets due a refresh: watched, still open, and not seen recently.
 *
 * Returns at most `limit` so one sweep can never fan out unboundedly, and
 * prefers the stalest entries so everything gets its turn.
 */
export function dueForRefresh(
  state: LocalState,
  staleMs = 30_000,
  limit = 6,
): WatchedMarket[] {
  const now = Date.now();
  return state.watchlist
    .filter((w) => !w.closeTime || new Date(w.closeTime).getTime() > now)
    .filter((w) => !w.lastSeenAt || now - new Date(w.lastSeenAt).getTime() > staleMs)
    .sort((a, b) => {
      const at = a.lastSeenAt ? new Date(a.lastSeenAt).getTime() : 0;
      const bt = b.lastSeenAt ? new Date(b.lastSeenAt).getTime() : 0;
      return at - bt;
    })
    .slice(0, limit);
}

/** Rebuild a MarketMeta from a watchlist entry, for a book fetch. */
export function metaOf(w: WatchedMarket): MarketMeta {
  return {
    venue: w.venue,
    venueMarketId: w.venueMarketId,
    question: w.question,
    yesLabel: 'Yes',
    noLabel: 'No',
    // The refresh path re-fetches market metadata anyway, which corrects these.
    tickCents: 1,
    minOrderSize: 1,
    closeTime: w.closeTime,
    category: w.category,
  };
}

export { midPrice };
