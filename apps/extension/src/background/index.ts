/**
 * Service worker — the only place that talks to venue APIs.
 *
 * Content scripts run in the page's origin, so a fetch to clob.polymarket.com
 * from inside polymarket.com would need CORS the venue does not grant. The
 * service worker holds the host permissions, so its fetches bypass CORS
 * entirely. Everything funnels through here.
 *
 * It is also where the fill engine runs, so a single serialized context owns
 * every mutation of the portfolio — the local stand-in for a row lock.
 */

import {
  buildQuote,
  submitOrder,
  markPositions,
  settleLocal,
  closePosition,
  OrderError,
} from '../lib/engine';
import { fetchBook, resolveUrl, searchMarkets, trending } from '../lib/resolve';
import { loadState, mutate, freshState, saveState, marketKey, summarize } from '../lib/store';
import { buildRecord } from '../lib/record';
import { dueForRefresh, isWatched, metaOf, noteMid, toggleWatch } from '../lib/watchlist';
import { evaluateAlerts } from '../lib/alerts';
import type { Request, Response } from '../lib/messages';
import { REALISM, midPrice } from '@polyfill/core';

chrome.runtime.onInstalled.addListener(async () => {
  // Touch the store so a fresh install has a portfolio before the first render.
  await loadState();
  // The dashboard is a full tab, not a side panel: it shows an equity curve, a
  // calibration chart and a ladder, none of which fit a 320px rail.
  // Settlement sweep. Cheap: it only looks at markets the user actually holds.
  chrome.alarms.create('settle-check', { periodInMinutes: 5 });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create('settle-check', { periodInMinutes: 5 });
});

const DASHBOARD = 'src/sidepanel/index.html';

/**
 * Toolbar click opens the dashboard.
 *
 * Focuses an existing dashboard tab rather than piling up duplicates — clicking
 * the icon twice should take you to the thing, not open a second copy of it.
 */
chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL(DASHBOARD);

  // Reuse the dashboard tab we opened before.
  //
  // The obvious chrome.tabs.query({ url }) needs the "tabs" permission to match
  // on URL; without it the filter silently yields [] and every click opened yet
  // another dashboard. Keeping the id costs no permission at all.
  const { dashboardTabId } = await chrome.storage.local.get('dashboardTabId');
  if (typeof dashboardTabId === 'number') {
    try {
      const tab = await chrome.tabs.update(dashboardTabId, { active: true });
      if (tab?.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
      return;
    } catch {
      // Closed since — fall through and open a fresh one.
    }
  }

  const created = await chrome.tabs.create({ url });
  if (created.id != null) await chrome.storage.local.set({ dashboardTabId: created.id });
});

/**
 * Open a market URL, reusing an already-loaded venue tab when Turbo is on.
 *
 * A cold Polymarket page load is seconds of JS; navigating a tab that already
 * has the app warm is near-instant. Only ever reuses a tab already on the same
 * venue — never a random tab of yours.
 */
async function openMarket(url: string): Promise<void> {
  const settings = (await loadState()).settings;
  if (settings.turboMode) {
    const host = new URL(url).hostname;
    const tabs = await chrome.tabs.query({});
    const warm = tabs.find((t) => {
      try {
        return t.url != null && new URL(t.url).hostname === host;
      } catch {
        return false;
      }
    });
    if (warm?.id != null) {
      await chrome.tabs.update(warm.id, { url, active: true });
      if (warm.windowId != null) await chrome.windows.update(warm.windowId, { focused: true });
      return;
    }
  }
  await chrome.tabs.create({ url });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'settle-check') {
    void settlementSweep();
    // Piggyback the watchlist refresh on the same wake-up rather than adding a
    // second alarm — the service worker is already spun up, and this keeps the
    // background cost of a watched market close to zero.
    void refreshWatchlist();
  }
});

chrome.runtime.onMessage.addListener((req: Request, _sender, sendResponse) => {
  handle(req)
    .then((data) => sendResponse({ ok: true, data } satisfies Response))
    .catch((e: unknown) => {
      const err = e instanceof OrderError ? e : null;
      sendResponse({
        ok: false,
        error: err?.code ?? 'internal',
        message: e instanceof Error ? e.message : String(e),
        detail: err?.detail,
      } satisfies Response);
    });
  // Keep the message channel open for the async reply.
  return true;
});

async function handle(req: Request): Promise<unknown> {
  switch (req.type) {
    case 'PING':
      return { pong: true };

    case 'GET_STATE':
      return loadState();

    case 'GET_SETTINGS':
      return (await loadState()).settings;

    case 'SET_SETTINGS':
      return mutate((state) => {
        Object.assign(state.settings, req.patch);
        return state.settings;
      });

    case 'RESET_PORTFOLIO': {
      const prev = await loadState();
      const next = freshState();
      // A reset is a fresh bankroll, not a fresh identity: settings and the
      // reset counter survive so the Record screen stays honest about it.
      next.settings = prev.settings;
      next.resetCount = prev.resetCount + 1;
      await saveState(next);
      return next;
    }

    case 'RESOLVE_URL':
      return resolveUrl(req.url);

    case 'GET_BOOK': {
      const result = await fetchBook(req.meta);
      await markPositions(marketKey(req.meta.venue, req.meta.venueMarketId), result.book);
      return result;
    }

    case 'TRENDING':
      return trending(req.limit ?? 24);

    case 'SEARCH_MARKETS':
      return searchMarkets(req.query, req.limit ?? 20);

    case 'QUOTE': {
      const state = await loadState();
      const { book, meta } = await fetchBook(req.meta);
      const quote = buildQuote({
        book,
        meta,
        side: req.side,
        outcome: req.outcome,
        realism: state.settings.realism,
        enforceDepthCap: state.settings.enforceDepthCap && req.side === 'buy',
        resolutionLockout: state.settings.resolutionLockout,
        target:
          req.qty != null && req.qty > 0
            ? { kind: 'qty', qty: req.qty }
            : { kind: 'notional', usd: req.notional ?? state.settings.defaultOrderSize },
      });
      return quote;
    }

    case 'SUBMIT': {
      // Rule 3, honestly implemented: wait out the realism mode's latency, then
      // fetch a NEW book and fill against that one. The user's quote was priced
      // on a book that no longer exists.
      const latency = REALISM[req.quote.realism].latencyMs;
      const elapsed = Date.now() - new Date(req.quote.quotedAt).getTime();
      const remaining = latency - elapsed;
      if (remaining > 0) await sleep(remaining);

      const { book: fillBook } = await fetchBook(req.meta);
      const order = await submitOrder({ meta: req.meta, quote: req.quote, fillBook });
      const state = await loadState();
      return { order, state };
    }

    case 'UNDO_ORDER': {
      // Reverse the fill at the price it filled at, within the undo window.
      const state = await loadState();
      const order = state.orders.find((o) => o.id === req.orderId);
      if (!order || order.side !== 'buy') {
        throw new OrderError('not_undoable', 'That order can no longer be undone.');
      }
      if (Date.now() - new Date(order.ts).getTime() > 15_000) {
        throw new OrderError('not_undoable', 'The undo window has passed — that is a real trade now.');
      }
      const { book } = await fetchBook(req.meta);
      return closePosition({
        meta: req.meta,
        outcome: order.outcome,
        book,
        realism: order.realism,
        qty: order.qtyFilled,
        atPrice: order.avgPrice,
      });
    }

    case 'CLOSE_POSITION': {
      const s2 = await loadState();
      const { book } = await fetchBook(req.meta);
      return closePosition({
        meta: req.meta,
        outcome: req.outcome,
        book,
        realism: s2.settings.realism,
        ...(req.qty != null ? { qty: req.qty } : {}),
      });
    }

    case 'SETTLE_CHECK':
      return settlementSweep();

    case 'TOGGLE_WATCH':
      return { watched: await toggleWatch(req.meta, req.mid ?? null, req.sourceUrl) };

    case 'OPEN_MARKET':
      await openMarket(req.url);
      return { ok: true };

    case 'POPOUT': {
      // A small always-visible window, for trading beside a livestream or a
      // fullscreen chart. chrome.windows type:'popup' has no tab strip or
      // omnibox, so it reads as a widget rather than a browser window.
      const url = chrome.runtime.getURL(DASHBOARD) + '#popout';
      const { popoutId } = await chrome.storage.local.get('popoutId');
      if (typeof popoutId === 'number') {
        try {
          await chrome.windows.update(popoutId, { focused: true });
          return { ok: true };
        } catch {
          // Closed since; fall through.
        }
      }
      const win = await chrome.windows.create({
        url,
        type: 'popup',
        width: 360,
        height: 620,
        top: 90,
        left: 90,
      });
      if (win.id != null) await chrome.storage.local.set({ popoutId: win.id });
      return { ok: true };
    }

    case 'GET_SUMMARY':
      return summarize(await loadState());

    case 'WATCH_HAS':
      return isWatched(await loadState(), req.meta.venue, req.meta.venueMarketId);

    case 'REFRESH_WATCHLIST': {
      const r = await refreshWatchlist();
      // Alerts ride the refresh that already happened — no extra polling.
      await evaluateAlerts();
      return r;
    }

    case 'GET_RECORD':
      return buildRecord(await loadState());

    default:
      throw new Error(`Unknown request: ${(req as { type: string }).type}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Refresh the stalest watched markets — the client-side equivalent of the
 * server's hot tier.
 *
 * Bounded by `dueForRefresh`, so this never fans out past a handful of requests
 * no matter how long the list is. Failures are swallowed per-market: one dead
 * ticker must not stop the rest of the sweep.
 */
async function refreshWatchlist(): Promise<{ refreshed: number }> {
  const state = await loadState();
  const due = dueForRefresh(state);
  if (due.length === 0) return { refreshed: 0 };

  let refreshed = 0;
  for (const w of due) {
    try {
      const { book } = await fetchBook(metaOf(w));
      await noteMid(w.marketKey, midPrice(book.yes));
      await markPositions(w.marketKey, book);
      refreshed++;
    } catch {
      // Leave lastSeenAt alone so it stays at the front of the queue.
    }
  }
  return { refreshed };
}

/**
 * Settlement, local-first.
 *
 * Only looks at markets the user actually holds a position in — typically a
 * handful, never the whole venue. This is the entire replacement for the
 * server-side settle cron.
 */
async function settlementSweep(): Promise<{ checked: number; settled: number }> {
  const state = await loadState();
  const open = state.positions.filter((p) => p.isOpen);
  if (open.length === 0) return { checked: 0, settled: 0 };

  const byKey = new Map<string, (typeof open)[number]>();
  for (const p of open) byKey.set(p.marketKey, p);

  let settled = 0;
  for (const [key, pos] of byKey) {
    // Do not bother the venue until the market's own close time has passed.
    if (pos.closeTime && new Date(pos.closeTime).getTime() > Date.now()) continue;

    try {
      const resolution = await checkResolution(pos.venue, key.split(':').slice(1).join(':'));
      if (resolution === undefined) continue; // still open
      settled += await settleLocal(key, resolution);
    } catch {
      // A venue hiccup must not corrupt local state; try again next alarm.
    }
  }

  if (settled > 0) {
    chrome.runtime.sendMessage({ type: 'SETTLED', count: settled }).catch(() => undefined);
    chrome.notifications?.create?.({
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'Polyfill — market settled',
      message: `${settled} position${settled === 1 ? '' : 's'} resolved. Open the panel to see the result.`,
    });
  }

  return { checked: byKey.size, settled };
}

/** `undefined` = still open, `null` = void, otherwise the winning side. */
async function checkResolution(
  venue: string,
  venueMarketId: string,
): Promise<'yes' | 'no' | null | undefined> {
  if (venue === 'kalshi') {
    const res = await fetch(
      `https://api.elections.kalshi.com/trade-api/v2/markets/${encodeURIComponent(venueMarketId)}`,
    );
    if (!res.ok) return undefined;
    const { market } = (await res.json()) as { market?: { status?: string; result?: string } };
    const status = (market?.status ?? '').toLowerCase();
    if (status !== 'finalized' && status !== 'settled') return undefined;
    const result = (market?.result ?? '').toLowerCase();
    return result === 'yes' ? 'yes' : result === 'no' ? 'no' : null;
  }

  const res = await fetch(
    `https://gamma-api.polymarket.com/markets?condition_ids=${encodeURIComponent(venueMarketId)}`,
  );
  if (!res.ok) return undefined;
  const rows = (await res.json()) as { closed?: boolean; outcomePrices?: string }[];
  const m = rows?.[0];
  if (!m?.closed) return undefined;
  try {
    const prices = JSON.parse(m.outcomePrices ?? '[]') as string[];
    const yes = Number(prices[0]);
    if (yes >= 0.99) return 'yes';
    if (yes <= 0.01) return 'no';
    return null; // 50/50 void
  } catch {
    return undefined;
  }
}
