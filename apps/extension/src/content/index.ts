/**
 * The market-page popup.
 *
 * Safety rules, non-negotiable because this runs on someone else's site:
 *   - Exactly ONE node appended to document.body. Host DOM is never mutated.
 *   - Closed shadow root: host CSS cannot leak in, ours cannot leak out.
 *   - Market detected by URL, never by scraping. Both venues are SPAs that
 *     reshuffle their markup every deploy; a selector that works today breaks
 *     silently next week, and a silently wrong market is worse than none.
 *   - Visually distinct from the host so it can never be mistaken for a real
 *     order control on a real-money venue.
 *
 * It mounts ONLY on a page that resolves to a tradeable market, and unmounts
 * the moment you navigate away. A panel that follows you onto the homepage
 * saying "open a market" is clutter, not a feature.
 */

import { playSound } from '../lib/sfx';
import { send } from '../lib/messages';
import type { MarketMeta, QuoteResult } from '../lib/engine';
import type { ResolvedMarket } from '../lib/resolve';
import type { Settings } from '../lib/store';

const HOST_ID = 'polyfill-root';

let shadow: ShadowRoot | null = null;
let panel: HTMLDivElement | null = null;
let settings: Settings | null = null;
let market: ResolvedMarket | null = null;
let meta: MarketMeta | null = null;
let quote: QuoteResult | null = null;
let outcome: 'yes' | 'no' = 'yes';
let amount = 100;
let busy = false;
let open = true;
let status: { text: string; kind: 'ok' | 'err' } | null = null;
let quoteTimer: number | undefined;

const CSS = `
:host { all: initial; }
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

.wrap {
  position: fixed; z-index: 2147483600; width: 268px;
  font-family: Inter, system-ui, -apple-system, "Segoe UI", sans-serif;
  color: #E8EAED; font-size: 13px; line-height: 1.4;
  background: rgba(16,18,23,.97); backdrop-filter: blur(12px);
  border: 1px solid #262B34; border-radius: 14px;
  box-shadow: 0 16px 48px rgba(0,0,0,.6);
  overflow: hidden; user-select: none;
}
.num { font-variant-numeric: tabular-nums;
  font-family: "SF Mono", "JetBrains Mono", ui-monospace, monospace; }

.head { display: flex; align-items: center; gap: 7px; padding: 9px 11px; cursor: grab; }
.head:active { cursor: grabbing; }
.dot { width: 7px; height: 7px; border-radius: 50%; background: #8B5CF6; flex-shrink: 0; }
.name { font-size: 11px; font-weight: 700; letter-spacing: .04em; }
.sim { font-size: 8px; font-weight: 700; letter-spacing: .07em; color: #A78BFA;
  border: 1px solid #4C1D95; border-radius: 3px; padding: 1px 4px; white-space: nowrap; }
.grow { flex: 1; }
.x { background: none; border: 0; color: #565E6C; cursor: pointer; font-size: 15px;
  line-height: 1; padding: 0 2px; border-radius: 4px; font-family: inherit; }
.x:hover { color: #E8EAED; }

.body { padding: 0 11px 11px; display: grid; gap: 9px; }

.q { font-size: 11.5px; font-weight: 600; line-height: 1.35; color: #C8CCD4;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
select.sib { width: 100%; background: #0C0E12; color: #C8CCD4; border: 1px solid #262B34;
  border-radius: 7px; padding: 5px 6px; font: inherit; font-size: 10.5px; }

.sides { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.side { border: 1px solid #262B34; background: #0C0E12; border-radius: 9px;
  padding: 7px 4px; cursor: pointer; font-family: inherit; text-align: center;
  transition: border-color .12s, background .12s; }
.side .t { font-size: 9px; font-weight: 700; letter-spacing: .05em; opacity: .85; }
.side .p { font-size: 17px; font-weight: 700; margin-top: 1px; }
.side.y { color: #00D18F; } .side.n { color: #FF4D6A; }
.side.y[data-on="1"] { border-color: #00D18F; background: rgba(0,209,143,.11); }
.side.n[data-on="1"] { border-color: #FF4D6A; background: rgba(255,77,106,.11); }

.amt { display: flex; align-items: center; background: #0C0E12; border: 1px solid #262B34;
  border-radius: 9px; padding: 0 9px; }
.amt span { color: #565E6C; font-size: 13px; }
.amt input { flex: 1; background: none; border: 0; color: #E8EAED; font: inherit;
  font-size: 15px; font-weight: 600; padding: 8px 4px; outline: none;
  font-variant-numeric: tabular-nums; font-family: "SF Mono", ui-monospace, monospace; }
.amt input::-webkit-outer-spin-button, .amt input::-webkit-inner-spin-button {
  -webkit-appearance: none; margin: 0; }

.chips { display: flex; gap: 5px; }
.chip { flex: 1; background: #0C0E12; border: 1px solid #262B34; color: #7A8290;
  border-radius: 6px; padding: 4px 0; font: inherit; font-size: 10px; cursor: pointer; }
.chip:hover { color: #E8EAED; border-color: #8B5CF6; }

.tick { background: #0C0E12; border-radius: 9px; padding: 7px 9px; display: grid; gap: 3px; }
.r { display: flex; justify-content: space-between; font-size: 11px; }
.r > span:first-child { color: #6B7280; }
.r.big > span:last-child { color: #00D18F; font-weight: 600; }
.warn { color: #FFB020; }

.go { width: 100%; padding: 10px; border: 0; border-radius: 9px; cursor: pointer;
  font: inherit; font-size: 13px; font-weight: 700; color: #07080B; }
.go.y { background: #00D18F; } .go.n { background: #FF4D6A; }
.go:disabled { opacity: .45; cursor: not-allowed; }

.msg { font-size: 10.5px; padding: 6px 8px; border-radius: 7px; line-height: 1.35; }
.msg.ok { background: rgba(0,209,143,.12); color: #00D18F; }
.msg.err { background: rgba(255,77,106,.12); color: #FF8095; }

.hide { display: none !important; }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
`;

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function mount(): void {
  if (document.getElementById(HOST_ID)) return;
  const host = document.createElement('div');
  host.id = HOST_ID;
  shadow = host.attachShadow({ mode: 'closed' });

  const style = document.createElement('style');
  style.textContent = CSS;
  shadow.appendChild(style);

  panel = document.createElement('div');
  panel.className = 'wrap';
  shadow.appendChild(panel);
  document.body.appendChild(host);

  // Default bottom-left: both venues put their real order panel on the right,
  // and covering it would be both rude and confusing.
  const saved = settings?.overlayPosition;
  if (saved) {
    panel.style.left = `${saved.x}px`;
    panel.style.top = `${saved.y}px`;
  } else {
    panel.style.left = '20px';
    panel.style.bottom = '20px';
  }
}

function unmount(): void {
  document.getElementById(HOST_ID)?.remove();
  shadow = null;
  panel = null;
  quote = null;
  status = null;
}

function render(): void {
  if (!panel || !meta || !market) return;

  const self = market.siblings.find((s) => s.meta.venueMarketId === meta!.venueMarketId);
  const yes = self?.mid ?? null;
  const no = yes == null ? null : 100 - yes;

  const picker =
    market.siblings.length > 1
      ? `<select class="sib" data-a="pick">${market.siblings
          .map(
            (s) =>
              `<option value="${esc(s.meta.venueMarketId)}"${
                s.meta.venueMarketId === meta!.venueMarketId ? ' selected' : ''
              }>${esc(s.meta.question.slice(0, 54))}</option>`,
          )
          .join('')}</select>`
      : '';

  const ticket = quote
    ? `<div class="tick">
         <div class="r"><span>Avg fill</span><span class="num">${quote.avgPrice.toFixed(1)}¢</span></div>
         <div class="r"><span>Size</span><span class="num">${quote.qty.toLocaleString()}</span></div>
         <div class="r"><span>Cost</span><span class="num">P$${quote.totalCost.toFixed(2)}</span></div>
         <div class="r big"><span>Max profit</span><span class="num">+P$${quote.maxProfit.toFixed(2)}</span></div>
         ${quote.partial ? `<div class="r"><span class="warn">Partial</span><span class="warn">book ran out</span></div>` : ''}
       </div>`
    : '';

  panel.innerHTML = `
    <div class="head">
      <span class="dot"></span>
      <span class="name">POLYFILL</span>
      <span class="sim">SIM</span>
      <span class="grow"></span>
      <button class="x" data-a="fold">${open ? '−' : '+'}</button>
      <button class="x" data-a="close">×</button>
    </div>
    <div class="body ${open ? '' : 'hide'}">
      <div class="q">${esc(meta.question)}</div>
      ${picker}
      <div class="sides">
        <button class="side y" data-a="side" data-o="yes" data-on="${outcome === 'yes' ? 1 : 0}">
          <div class="t">▲ YES</div><div class="p num">${yes == null ? '--' : yes.toFixed(0) + '¢'}</div>
        </button>
        <button class="side n" data-a="side" data-o="no" data-on="${outcome === 'no' ? 1 : 0}">
          <div class="t">▼ NO</div><div class="p num">${no == null ? '--' : no.toFixed(0) + '¢'}</div>
        </button>
      </div>
      <div class="amt"><span>P$</span><input data-a="amt" type="number" min="1" step="1" value="${amount}" /></div>
      <div class="chips">
        ${[25, 50, 100, 250].map((v) => `<button class="chip" data-a="pre" data-v="${v}">${v}</button>`).join('')}
      </div>
      ${ticket}
      ${status ? `<div class="msg ${status.kind}">${esc(status.text)}</div>` : ''}
      <button class="go ${outcome === 'yes' ? 'y' : 'n'}" data-a="go" ${busy || !quote ? 'disabled' : ''}>
        ${busy ? 'Placing…' : `Buy ${outcome.toUpperCase()}`}
      </button>
    </div>`;

  wire();
}

function wire(): void {
  if (!panel) return;

  panel.querySelectorAll('[data-a]').forEach((el) => {
    const a = (el as HTMLElement).dataset.a;
    if (a === 'close') el.addEventListener('click', unmount);
    if (a === 'fold') el.addEventListener('click', () => { open = !open; render(); });
    if (a === 'side') el.addEventListener('click', () => {
      outcome = ((el as HTMLElement).dataset.o as 'yes' | 'no') ?? 'yes';
      beep('tick');
      requestQuote();
    });
    if (a === 'pre') el.addEventListener('click', () => {
      amount = Number((el as HTMLElement).dataset.v) || 100;
      beep('tick');
      requestQuote();
    });
    if (a === 'amt') el.addEventListener('input', () => {
      amount = Number((el as HTMLInputElement).value) || 0;
      requestQuote();
    });
    if (a === 'pick') el.addEventListener('change', () => {
      const id = (el as HTMLSelectElement).value;
      meta = market?.siblings.find((s) => s.meta.venueMarketId === id)?.meta ?? meta;
      quote = null; status = null;
      requestQuote();
    });
    if (a === 'go') el.addEventListener('click', () => void place());
  });

  panel.querySelector('.head')?.addEventListener('mousedown', drag as EventListener);
}

function beep(n: 'tick' | 'fill' | 'partial' | 'reject'): void {
  playSound(n, settings?.soundVolume ?? 0.35, settings?.soundEnabled ?? true);
}

function drag(e: MouseEvent): void {
  if ((e.target as HTMLElement).dataset.a) return;
  if (!panel) return;
  const r = panel.getBoundingClientRect();
  const dx = e.clientX - r.left;
  const dy = e.clientY - r.top;

  const move = (ev: MouseEvent) => {
    if (!panel) return;
    panel.style.left = `${Math.max(0, Math.min(innerWidth - r.width, ev.clientX - dx))}px`;
    panel.style.top = `${Math.max(0, Math.min(innerHeight - 50, ev.clientY - dy))}px`;
    panel.style.bottom = 'auto';
  };
  const up = () => {
    removeEventListener('mousemove', move);
    removeEventListener('mouseup', up);
    if (!panel) return;
    const b = panel.getBoundingClientRect();
    void send({ type: 'SET_SETTINGS', patch: { overlayPosition: { x: b.left, y: b.top } } }).catch(
      () => undefined,
    );
  };
  addEventListener('mousemove', move);
  addEventListener('mouseup', up);
  e.preventDefault();
}

function requestQuote(): void {
  clearTimeout(quoteTimer);
  if (!meta || !(amount > 0)) {
    quote = null;
    render();
    return;
  }
  // Debounced so typing a size does not fire a request per keystroke.
  quoteTimer = setTimeout(async () => {
    try {
      quote = await send<QuoteResult>({
        type: 'QUOTE',
        meta: meta!,
        side: 'buy',
        outcome,
        notional: amount,
      });
      status = null;
    } catch (e) {
      quote = null;
      status = { text: (e as Error).message, kind: 'err' };
    }
    render();
  }, 250) as unknown as number;
}

async function place(): Promise<void> {
  if (!quote || !meta || busy) return;
  busy = true;
  status = null;
  render();

  try {
    const { order } = await send<{ order: { status: string; qtyFilled: number; avgPrice: number } }>(
      { type: 'SUBMIT', meta, quote },
    );
    beep(order.status === 'partial' ? 'partial' : 'fill');
    status = {
      text: `${order.status === 'partial' ? 'Partial' : 'Filled'} — ${order.qtyFilled.toLocaleString()} @ ${order.avgPrice.toFixed(1)}¢`,
      kind: 'ok',
    };
    quote = null;
  } catch (e) {
    beep('reject');
    const err = e as Error & { detail?: string };
    status = { text: err.detail ? `${err.message} ${err.detail}` : err.message, kind: 'err' };
  } finally {
    busy = false;
    render();
    if (status?.kind === 'ok') requestQuote();
  }
}

/**
 * Sync to the current URL. Mounts on a market page, unmounts off one.
 */
async function sync(): Promise<void> {
  let next: ResolvedMarket | null = null;
  try {
    next = await send<ResolvedMarket | null>({ type: 'RESOLVE_URL', url: location.href });
  } catch {
    next = null;
  }

  if (!next) {
    // Not a market page — leave no trace.
    market = null;
    meta = null;
    unmount();
    return;
  }

  const changed = next.meta.venueMarketId !== meta?.venueMarketId;
  market = next;
  if (changed) {
    meta = next.meta;
    quote = null;
    status = null;
  }

  mount();
  render();
  if (changed) requestQuote();
}

/**
 * Both venues are SPAs, so `pushState` is the only navigation signal there is.
 * Patching history on `window` observes without touching the host DOM, and
 * every call is forwarded through untouched.
 */
function watchNav(): void {
  let last = location.href;
  const fire = () => {
    if (location.href === last) return;
    last = location.href;
    void sync();
  };

  for (const m of ['pushState', 'replaceState'] as const) {
    const original = history[m];
    history[m] = function (this: History, ...args: Parameters<History['pushState']>) {
      const r = original.apply(this, args);
      queueMicrotask(fire);
      return r;
    };
  }
  addEventListener('popstate', fire);
  // Some client routers swap views without emitting a history event.
  new MutationObserver(fire).observe(document.body, { childList: true, subtree: false });
}

async function boot(): Promise<void> {
  try {
    settings = await send<Settings>({ type: 'GET_SETTINGS' });
  } catch {
    return; // worker asleep; next navigation retries
  }
  if (!settings.overlayEnabled) return;
  amount = settings.defaultOrderSize || 100;
  watchNav();
  await sync();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => void boot());
} else {
  void boot();
}
