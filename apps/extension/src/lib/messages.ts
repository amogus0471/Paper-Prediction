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
  | { type: 'OPEN_MARKET'; url: string }
  | { type: 'TOGGLE_WATCH'; meta: MarketMeta; mid: number | null }
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

/** Typed wrapper so callers get a rejected promise instead of an `ok:false`. */
export async function send<T>(req: Request): Promise<T> {
  const res = (await chrome.runtime.sendMessage(req)) as Response<T> | undefined;
  if (!res) throw new Error('No response from Polyfill background worker.');
  if (!res.ok) {
    const err = new Error(res.message) as Error & { code?: string; detail?: string };
    err.code = res.error;
    err.detail = res.detail;
    throw err;
  }
  return res.data;
}
