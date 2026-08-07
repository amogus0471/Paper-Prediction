/** The message contract between the overlay, the side panel and the service worker. */

import type { NormalizedBook, OrderSide, OutcomeSide } from '@polyfill/core';
import type { MarketMeta, QuoteResult } from './engine';
import type { LocalState, Settings, StoredOrder } from './store';

export type Request =
  | { type: 'PING' }
  | { type: 'GET_STATE' }
  | { type: 'GET_SETTINGS' }
  | { type: 'SET_SETTINGS'; patch: Partial<Settings> }
  | { type: 'RESET_PORTFOLIO' }
  | { type: 'RESOLVE_URL'; url: string }
  | { type: 'GET_BOOK'; meta: MarketMeta }
  | { type: 'SEARCH_MARKETS'; query: string; venue?: string; limit?: number }
  | { type: 'TRENDING'; limit?: number }
  | {
      type: 'QUOTE';
      meta: MarketMeta;
      side: OrderSide;
      outcome: OutcomeSide;
      notional?: number;
      qty?: number;
    }
  | { type: 'SUBMIT'; meta: MarketMeta; quote: QuoteResult }
  | { type: 'SETTLE_CHECK' }
  | { type: 'WATCH_HAS'; meta: MarketMeta }
  | { type: 'GET_SUMMARY' }
  | { type: 'POPOUT' }
  | { type: 'OPEN_MARKET'; url: string }
  | { type: 'UNDO_ORDER'; orderId: string; meta: MarketMeta }
  | { type: 'CLOSE_POSITION'; meta: MarketMeta; outcome: 'yes' | 'no'; qty?: number }
  | { type: 'TOGGLE_WATCH'; meta: MarketMeta; mid?: number | null; sourceUrl?: string }
  | { type: 'REFRESH_WATCHLIST' }
  | { type: 'GET_RECORD' };

export type Response<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: string; message: string; detail?: string };

export interface MarketCard {
  meta: MarketMeta;
  yesBid: number | null;
  yesAsk: number | null;
  mid: number | null;
  volume24h: number;
  closeTime?: string;
  category: string;
  imageUrl?: string;
}

export interface BookResult {
  book: NormalizedBook;
  meta: MarketMeta;
}

export interface SubmitResult {
  order: StoredOrder;
  state: LocalState;
}

/**
 * Requests that are safe to abandon and ask again.
 *
 * A message to a service worker can hang rather than reject — MV3 tears the
 * worker down when it decides the worker is idle, and a message in flight at
 * that moment sometimes never settles at all. Anything guarding itself with an
 * "already in flight" flag then waits forever, which is how a once-a-second
 * poll stops dead and the price on screen quietly stops being a price.
 *
 * Only READS get a deadline. Re-asking for a book costs nothing. SUBMIT and
 * the other mutations deliberately wait as long as they need to: timing out on
 * the client while the worker goes on to book the order would show a failure
 * for a trade that actually happened, which is far worse than waiting.
 */
const READ_TIMEOUT_MS = 12_000;
const RETRYABLE: ReadonlySet<Request['type']> = new Set([
  'PING',
  'GET_BOOK',
  'QUOTE',
  'GET_STATE',
  'GET_SETTINGS',
  'GET_SUMMARY',
  'GET_RECORD',
  'TRENDING',
  'SEARCH_MARKETS',
  'WATCH_HAS',
  'RESOLVE_URL',
]);

/** Typed wrapper so callers get a rejected promise instead of an `ok:false`. */
export async function send<T>(req: Request): Promise<T> {
  const call = chrome.runtime.sendMessage(req) as Promise<Response<T> | undefined>;

  const res = RETRYABLE.has(req.type)
    ? await Promise.race([
        call,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`${req.type} timed out — the background worker did not answer.`)),
            READ_TIMEOUT_MS,
          ),
        ),
      ])
    : await call;

  if (!res) throw new Error('No response from the background worker.');
  if (!res.ok) {
    const err = new Error(res.message) as Error & { code?: string; detail?: string };
    err.code = res.error;
    err.detail = res.detail;
    throw err;
  }
  return res.data;
}
