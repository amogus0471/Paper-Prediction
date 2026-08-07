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

import { buildQuote, submitOrder, markPositions, settleLocal, OrderError } from '../lib/engine';
import { fetchBook, resolveUrl, searchMarkets, trending } from '../lib/resolve';
import { loadState, mutate, freshState, saveState, marketKey } from '../lib/store';
import type { Request, Response } from '../lib/messages';
import { REALISM } from '@ghostfill/core';

chrome.runtime.onInstalled.addListener(async () => {
  // Touch the store so a fresh install has a portfolio before the first render.
  await loadState();
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
  // Settlement sweep. Cheap: it only looks at markets the user actually holds.
  chrome.alarms.create('settle-check', { periodInMinutes: 5 });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create('settle-check', { periodInMinutes: 5 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'settle-check') void settlementSweep();
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
        target:
          req.qty != null && req.qty > 0
            ? { kind: 'qty', qty: req.qty }
            : { kind: 'notional', usd: req.notional ?? state.settings.defaultOrderSize },
        enforceDepthCap: req.side === 'buy',
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

    case 'SETTLE_CHECK':
      return settlementSweep();

    default:
      throw new Error(`Unknown request: ${(req as { type: string }).type}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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
      title: 'Ghostfill — market settled',
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
