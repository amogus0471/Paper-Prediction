/**
 * The Polyfill trading overlay.
 *
 * Safety rules, all non-negotiable because this runs on somebody else's site:
 *   - Exactly ONE node appended to document.body. The host DOM is never mutated.
 *   - Closed shadow root, so host CSS cannot leak in and our CSS cannot leak out.
 *   - Market detected by URL, never by scraping the DOM.
 *   - Visually distinct (violet border + SIM chip) so it can never be mistaken
 *     for a native control on a real-money venue.
 *   - Draggable, and it remembers where you put it, so it can be moved off the
 *     host's own order panel.
 */

import { playSound } from '../lib/sfx';
import { send } from '../lib/messages';
import type { MarketMeta, QuoteResult } from '../lib/engine';
import type { ResolvedMarket } from '../lib/resolve';
import type { Settings } from '../lib/store';

const HOST_ID = 'polyfill-root';

let shadow: ShadowRoot | null = null;
let root: HTMLDivElement | null = null;
let settings: Settings | null = null;
let resolved: ResolvedMarket | null = null;
let activeMeta: MarketMeta | null = null;
let quote: QuoteResult | null = null;
let side: 'buy' | 'sell' = 'buy';
let outcome: 'yes' | 'no' = 'yes';
let amount = 100;
let collapsed = false;
let busy = false;
let statusLine = '';
let statusKind: 'ok' | 'error' | 'info' = 'info';
let quoteTimer: number | undefined;
let watched = false;

const STYLE = `
:host { all: initial; }
* { box-sizing: border-box; margin: 0; padding: 0; }
.panel {
  position: fixed; z-index: 2147483600;
  width: 320px; font-family: Inter, system-ui, -apple-system, "Segoe UI", sans-serif;
  background: #14171C; color: #E8EAED;
  border: 1px solid #232830; border-left: 2px solid #8B5CF6;
  border-radius: 10px; box-shadow: 0 12px 40px rgba(0,0,0,.55);
  font-size: 13px; line-height: 1.4; overflow: hidden;
}
.bar { display: flex; align-items: center; gap: 8px; padding: 9px 10px;
  background: #0B0D10; border-bottom: 1px solid #232830; cursor: grab; user-select: none; }
.bar:active { cursor: grabbing; }
.brand { font-weight: 700; font-size: 12px; letter-spacing: .02em; }
.sim { font-size: 9px; font-weight: 700; letter-spacing: .06em; padding: 2px 5px;
  border: 1px solid #8B5CF6; color: #C4B5FD; border-radius: 4px; white-space: nowrap; }
.spacer { flex: 1; }
.iconbtn { background: none; border: none; color: #7A8290; cursor: pointer;
  font-size: 15px; line-height: 1; padding: 2px 4px; border-radius: 4px; }
.iconbtn:hover { color: #E8EAED; background: #232830; }
.iconbtn.on { color: #8B5CF6; }
.body { padding: 10px; display: grid; gap: 9px; }
.q { font-size: 12px; color: #E8EAED; font-weight: 600; }
.meta { display: flex; gap: 8px; align-items: center; font-size: 10px; color: #7A8290; }
.chip { font-size: 10px; padding: 1px 5px; border: 1px solid #232830; border-radius: 4px; }
select { width: 100%; background: #0B0D10; color: #E8EAED; border: 1px solid #232830;
  border-radius: 6px; padding: 5px 6px; font-size: 11px; font-family: inherit; }
.sides { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.side { padding: 8px 6px; border-radius: 7px; border: 1px solid #232830;
  background: #0B0D10; cursor: pointer; text-align: center; font-family: inherit;
  transition: border-color .12s, background .12s; }
.side .lbl { font-size: 10px; font-weight: 700; letter-spacing: .05em; }
.side .px { font-size: 16px; font-weight: 700; font-variant-numeric: tabular-nums;
  font-family: "JetBrains Mono", ui-monospace, monospace; }
.side.yes { color: #00D18F; } .side.no { color: #FF4D6A; }
.side.yes[data-on="1"] { border-color: #00D18F; background: rgba(0,209,143,.1); }
.side.no[data-on="1"] { border-color: #FF4D6A; background: rgba(255,77,106,.1); }
.row { display: flex; gap: 6px; align-items: center; }
.amt { flex: 1; background: #0B0D10; border: 1px solid #232830; border-radius: 6px;
  padding: 7px 8px; color: #E8EAED; font-size: 14px; font-weight: 600;
  font-family: "JetBrains Mono", ui-monospace, monospace; font-variant-numeric: tabular-nums; }
.amt:focus { outline: none; border-color: #8B5CF6; }
.presets { display: flex; gap: 4px; }
.preset { flex: 1; background: #0B0D10; border: 1px solid #232830; color: #7A8290;
  border-radius: 5px; padding: 4px 0; font-size: 10px; cursor: pointer; font-family: inherit; }
.preset:hover { color: #E8EAED; border-color: #8B5CF6; }
.ticket { background: #0B0D10; border: 1px solid #232830; border-radius: 7px;
  padding: 7px 8px; display: grid; gap: 3px; font-size: 11px; }
.tr { display: flex; justify-content: space-between; }
.tr span:first-child { color: #7A8290; }
.tr span:last-child { font-family: "JetBrains Mono", ui-monospace, monospace;
  font-variant-numeric: tabular-nums; }
.tr.hl span:last-child { color: #00D18F; font-weight: 600; }
.warn { color: #FFB020; }
.place { width: 100%; padding: 10px; border: none; border-radius: 7px; cursor: pointer;
  font-size: 13px; font-weight: 700; font-family: inherit; color: #06070A; }
.place.yes { background: #00D18F; } .place.no { background: #FF4D6A; }
.place:disabled { opacity: .5; cursor: not-allowed; }
.status { font-size: 11px; padding: 6px 7px; border-radius: 6px; }
.status.ok { background: rgba(0,209,143,.12); color: #00D18F; }
.status.error { background: rgba(255,77,106,.12); color: #FF8095; }
.status.info { background: #0B0D10; color: #7A8290; }
.pos { background: rgba(139,92,246,.1); border: 1px solid #8B5CF6; border-radius: 7px;
  padding: 6px 8px; font-size: 11px; display: grid; gap: 2px; }
.foot { font-size: 9px; color: #4A5260; text-align: center; padding-top: 1px; }
.hidden { display: none !important; }
`;

// ── mount ───────────────────────────────────────────────────────────────────

function mount(): void {
  if (document.getElementById(HOST_ID)) return;

  const host = document.createElement('div');
  host.id = HOST_ID;
  // The ONE node we add. Nothing else in the host document is touched.
  shadow = host.attachShadow({ mode: 'closed' });

  const style = document.createElement('style');
  style.textContent = STYLE;
  shadow.appendChild(style);

  root = document.createElement('div');
  root.className = 'panel';
  shadow.appendChild(root);

  document.body.appendChild(host);
  positionPanel();
  render();
}

/**
 * Park the panel where it will not cover the host's own order ticket.
 *
 * Both venues put their buy panel on the right, so the default is bottom-LEFT.
 * A stored position always wins — if the user moved it, that was deliberate.
 */
function positionPanel(): void {
  if (!root) return;
  const saved = settings?.overlayPosition;
  if (saved) {
    root.style.left = `${saved.x}px`;
    root.style.top = `${saved.y}px`;
  } else {
    root.style.left = '20px';
    root.style.bottom = '20px';
  }
}

function h(html: string): string {
  return html;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

function render(): void {
  if (!root) return;

  if (!resolved || !activeMeta) {
    root.innerHTML = h(`
      <div class="bar">
        <span class="brand">POLYFILL</span>
        <span class="sim">SIM · NO REAL MONEY</span>
        <span class="spacer"></span>
        <button class="iconbtn" data-act="close">×</button>
      </div>
      <div class="body">
        <div class="status info">Open a market page to trade it with simulated money.</div>
      </div>`);
    wire();
    return;
  }

  const unit = activeMeta.venue === 'polymarket' ? 'shares' : 'contracts';
  const yesPx = resolved.siblings.find((s) => s.meta.venueMarketId === activeMeta!.venueMarketId)?.mid;

  const picker =
    resolved.siblings.length > 1
      ? `<select data-act="pick">${resolved.siblings
          .map(
            (s) =>
              `<option value="${esc(s.meta.venueMarketId)}" ${
                s.meta.venueMarketId === activeMeta!.venueMarketId ? 'selected' : ''
              }>${esc(s.meta.question.slice(0, 60))}</option>`,
          )
          .join('')}</select>`
      : '';

  const ticket = quote
    ? `<div class="ticket">
        <div class="tr"><span>Avg fill</span><span>${quote.avgPrice.toFixed(1)}¢</span></div>
        <div class="tr"><span>${unit}</span><span>${quote.qty.toLocaleString()}</span></div>
        <div class="tr"><span>Slippage</span><span class="${quote.slippageBps > 50 ? 'warn' : ''}">${Math.round(quote.slippageBps)} bps</span></div>
        ${quote.fee > 0 ? `<div class="tr"><span>Fee</span><span>P$${quote.fee.toFixed(2)}</span></div>` : ''}
        <div class="tr"><span>Cost</span><span>P$${quote.totalCost.toFixed(2)}</span></div>
        <div class="tr"><span>Max payout</span><span>P$${quote.maxPayout.toFixed(2)}</span></div>
        <div class="tr hl"><span>Max profit</span><span>+P$${quote.maxProfit.toFixed(2)}</span></div>
        <div class="tr"><span>Breakeven</span><span>${quote.breakeven.toFixed(1)}¢</span></div>
        ${quote.partial ? `<div class="tr"><span class="warn">Partial</span><span class="warn">book ran out</span></div>` : ''}
      </div>`
    : `<div class="status info">Enter a size to get a live quote.</div>`;

  root.innerHTML = h(`
    <div class="bar">
      <span class="brand">POLYFILL</span>
      <span class="sim">SIM · NO REAL MONEY</span>
      <span class="spacer"></span>
      <button class="iconbtn ${watched ? 'on' : ''}" data-act="star" title="${watched ? 'Unstar' : 'Add to watchlist'}">${watched ? '★' : '☆'}</button>
      <button class="iconbtn" data-act="toggle">${collapsed ? '▴' : '▾'}</button>
      <button class="iconbtn" data-act="close">×</button>
    </div>
    <div class="body ${collapsed ? 'hidden' : ''}">
      <div class="q">${esc(activeMeta.question.slice(0, 110))}</div>
      <div class="meta">
        <span class="chip">${esc(activeMeta.venue)}</span>
        <span class="chip">${esc(settings?.realism ?? 'realistic')}</span>
        ${yesPx != null ? `<span class="chip">mid ${yesPx.toFixed(0)}¢</span>` : ''}
      </div>
      ${picker}
      <div class="sides">
        <button class="side yes" data-act="side" data-outcome="yes" data-on="${outcome === 'yes' ? 1 : 0}">
          <div class="lbl">▲ ${esc(activeMeta.yesLabel.slice(0, 14)).toUpperCase()}</div>
          <div class="px">${yesPx != null ? yesPx.toFixed(0) + '¢' : '--'}</div>
        </button>
        <button class="side no" data-act="side" data-outcome="no" data-on="${outcome === 'no' ? 1 : 0}">
          <div class="lbl">▼ ${esc(activeMeta.noLabel.slice(0, 14)).toUpperCase()}</div>
          <div class="px">${yesPx != null ? (100 - yesPx).toFixed(0) + '¢' : '--'}</div>
        </button>
      </div>
      <div class="row">
        <input class="amt" data-act="amount" type="number" min="1" step="1" value="${amount}" />
      </div>
      <div class="presets">
        ${[25, 50, 100, 250].map((v) => `<button class="preset" data-act="preset" data-v="${v}">$${v}</button>`).join('')}
      </div>
      ${ticket}
      ${statusLine ? `<div class="status ${statusKind}">${esc(statusLine)}</div>` : ''}
      <button class="place ${outcome}" data-act="place" ${busy || !quote ? 'disabled' : ''}>
        ${busy ? 'Placing…' : `${side === 'buy' ? 'Buy' : 'Sell'} ${outcome.toUpperCase()}`}
      </button>
      <div class="foot">Simulated fills against the real book. No real money is involved.</div>
    </div>`);

  wire();
}

function wire(): void {
  if (!root || !shadow) return;

  root.querySelectorAll('[data-act]').forEach((el) => {
    const act = (el as HTMLElement).dataset.act;

    if (act === 'close') el.addEventListener('click', teardown);
    if (act === 'star')
      el.addEventListener('click', async () => {
        if (!activeMeta) return;
        try {
          const { watched: now } = await send<{ watched: boolean }>({
            type: 'TOGGLE_WATCH',
            meta: activeMeta,
            mid: quote?.bookMid ?? null,
          });
          watched = now;
          playSound('tick', settings?.soundVolume ?? 0.35, settings?.soundEnabled ?? true);
          render();
        } catch {
          // Starring is a convenience; never let it surface as an order error.
        }
      });
    if (act === 'toggle')
      el.addEventListener('click', () => {
        collapsed = !collapsed;
        render();
      });
    if (act === 'side')
      el.addEventListener('click', () => {
        outcome = ((el as HTMLElement).dataset.outcome as 'yes' | 'no') ?? 'yes';
        playSound('tick', settings?.soundVolume ?? 0.35, settings?.soundEnabled ?? true);
        void requestQuote();
      });
    if (act === 'preset')
      el.addEventListener('click', () => {
        amount = Number((el as HTMLElement).dataset.v);
        playSound('tick', settings?.soundVolume ?? 0.35, settings?.soundEnabled ?? true);
        void requestQuote();
      });
    if (act === 'amount')
      el.addEventListener('input', () => {
        amount = Number((el as HTMLInputElement).value) || 0;
        void requestQuote();
      });
    if (act === 'pick')
      el.addEventListener('change', () => {
        const id = (el as HTMLSelectElement).value;
        activeMeta = resolved?.siblings.find((s) => s.meta.venueMarketId === id)?.meta ?? activeMeta;
        quote = null;
        void requestQuote();
      });
    if (act === 'place') el.addEventListener('click', () => void place());
  });

  const bar = root.querySelector('.bar');
  if (bar) bar.addEventListener('mousedown', startDrag as EventListener);
}

// ── drag ────────────────────────────────────────────────────────────────────

function startDrag(e: MouseEvent): void {
  if ((e.target as HTMLElement).dataset.act) return; // let buttons be buttons
  if (!root) return;

  const rect = root.getBoundingClientRect();
  const dx = e.clientX - rect.left;
  const dy = e.clientY - rect.top;

  const move = (ev: MouseEvent) => {
    if (!root) return;
    const x = Math.max(0, Math.min(window.innerWidth - rect.width, ev.clientX - dx));
    const y = Math.max(0, Math.min(window.innerHeight - 60, ev.clientY - dy));
    root.style.left = `${x}px`;
    root.style.top = `${y}px`;
    root.style.bottom = 'auto';
  };

  const up = () => {
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
    if (!root) return;
    const r = root.getBoundingClientRect();
    void send({ type: 'SET_SETTINGS', patch: { overlayPosition: { x: r.left, y: r.top } } }).catch(
      () => undefined,
    );
  };

  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', up);
  e.preventDefault();
}

// ── trading ─────────────────────────────────────────────────────────────────

function requestQuote(): void {
  clearTimeout(quoteTimer);
  if (!activeMeta || !(amount > 0)) {
    quote = null;
    render();
    return;
  }
  // Debounce so typing a size does not fire a request per keystroke.
  quoteTimer = window.setTimeout(async () => {
    try {
      quote = await send<QuoteResult>({
        type: 'QUOTE',
        meta: activeMeta!,
        side,
        outcome,
        notional: amount,
      });
      statusLine = '';
      statusKind = 'info';
    } catch (e) {
      quote = null;
      statusLine = (e as Error).message;
      statusKind = 'error';
    }
    render();
  }, 250);
}

/** Ask the worker whether the current market is starred, and repaint. */
async function syncWatched(): Promise<void> {
  if (!activeMeta) { watched = false; return; }
  try {
    const state = await send<{ watchlist: { marketKey: string }[] }>({ type: 'GET_STATE' });
    const key = `${activeMeta.venue}:${activeMeta.venueMarketId}`;
    watched = state.watchlist.some((w) => w.marketKey === key);
  } catch {
    watched = false;
  }
  render();
}

async function place(): Promise<void> {
  if (!quote || !activeMeta || busy) return;
  busy = true;
  statusLine = '';
  render();

  const vol = settings?.soundVolume ?? 0.35;
  const on = settings?.soundEnabled ?? true;

  try {
    const { order } = await send<{ order: { status: string; qtyFilled: number; avgPrice: number } }>({
      type: 'SUBMIT',
      meta: activeMeta,
      quote,
    });

    playSound(order.status === 'partial' ? 'partial' : 'fill', vol, on);
    statusLine = `${order.status === 'partial' ? 'Partial fill' : 'Filled'} — ${order.qtyFilled.toLocaleString()} @ ${order.avgPrice.toFixed(1)}¢`;
    statusKind = 'ok';
    quote = null;
  } catch (e) {
    playSound('reject', vol, on);
    const err = e as Error & { detail?: string };
    statusLine = err.detail ? `${err.message} ${err.detail}` : err.message;
    statusKind = 'error';
  } finally {
    busy = false;
    render();
    // Refresh the quote so the panel shows a live price after a fill.
    if (statusKind === 'ok') void requestQuote();
  }
}

function teardown(): void {
  document.getElementById(HOST_ID)?.remove();
  shadow = null;
  root = null;
}

// ── SPA navigation ──────────────────────────────────────────────────────────

async function syncToUrl(): Promise<void> {
  const url = location.href;
  try {
    const next = await send<ResolvedMarket | null>({ type: 'RESOLVE_URL', url });
    if (!next) {
      resolved = null;
      activeMeta = null;
    } else if (next.meta.venueMarketId !== activeMeta?.venueMarketId) {
      resolved = next;
      activeMeta = next.meta;
      quote = null;
      statusLine = '';
      void syncWatched();
      void requestQuote();
    }
  } catch {
    resolved = null;
    activeMeta = null;
  }
  render();
}

/**
 * Both venues are SPAs, so `pushState` is the only navigation signal there is.
 * Patching history on `window` is observation, not host mutation — it does not
 * touch the DOM and it forwards every call through untouched.
 */
function watchNavigation(): void {
  let last = location.href;

  const fire = () => {
    if (location.href === last) return;
    last = location.href;
    void syncToUrl();
  };

  for (const method of ['pushState', 'replaceState'] as const) {
    const original = history[method];
    history[method] = function (this: History, ...args: Parameters<History['pushState']>) {
      const result = original.apply(this, args);
      queueMicrotask(fire);
      return result;
    };
  }

  window.addEventListener('popstate', fire);
  // Belt and braces: some client routers swap views without a history event.
  new MutationObserver(fire).observe(document.body, { childList: true, subtree: false });
}

async function boot(): Promise<void> {
  try {
    settings = await send<Settings>({ type: 'GET_SETTINGS' });
  } catch {
    return; // worker not ready; the next navigation will retry
  }
  if (!settings.overlayEnabled) return;

  amount = settings.defaultOrderSize || 100;
  mount();
  watchNavigation();
  await syncToUrl();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => void boot());
} else {
  void boot();
}
