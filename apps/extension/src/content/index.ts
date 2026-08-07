/**
 * The market-page popup.
 *
 * Safety rules, non-negotiable because this runs on someone else's site:
 *   - Exactly ONE node appended to document.body. Host DOM is never mutated.
 *   - Closed shadow root: host CSS cannot leak in, ours cannot leak out.
 *   - Market detected by URL, never by scraping.
 *   - Visually distinct from the host so it can never be mistaken for a real
 *     order control on a real-money venue.
 *
 * It mounts only on a page that resolves to a tradeable market, and collapses
 * to a small pill rather than closing — a control you can dismiss but not
 * recover is a bug, not a feature.
 */

import { playSound } from '../lib/sfx';
import { send } from '../lib/messages';
import { friendlyError } from '@polyfill/core';
import type { MarketMeta, QuoteResult } from '../lib/engine';
import type { ResolvedMarket } from '../lib/resolve';
import type { Settings } from '../lib/store';

const HOST_ID = 'polyfill-root';

/**
 * How often the book is refetched while the popup is open.
 *
 * Polymarket's CLOB read budget is shared across every consumer of the API and
 * gets tight around 100 requests/minute, so a 500 ms poll on a single market
 * would sit right on the ceiling and risk 429s for everyone. One second stays
 * inside it, and the displayed numbers are animated between ticks so the panel
 * reads as continuously live rather than stepping.
 */
const POLL_MS = 1000;

let shadow: ShadowRoot | null = null;
let panel: HTMLDivElement | null = null;
let settings: Settings | null = null;
let market: ResolvedMarket | null = null;
let meta: MarketMeta | null = null;
let quote: QuoteResult | null = null;
let live: { yes: number | null; no: number | null } = { yes: null, no: null };
let prevLive: { yes: number | null; no: number | null } = { yes: null, no: null };
let outcome: 'yes' | 'no' = 'yes';
let side: 'buy' | 'sell' = 'buy';
let amount = 100;
let busy = false;
let collapsed = false;
let watched = false;
let pollTimer: number | undefined;
let quoteTimer: number | undefined;

const CSS = `
:host { all: initial; }
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

.wrap {
  position: fixed; z-index: 2147483600;
  font-family: Inter, system-ui, -apple-system, "Segoe UI", sans-serif;
  color: #E6EAF2; font-size: 13px; line-height: 1.4;
  --blue: #3B82F6; --blue-dim: #1D4ED8;
  --up: #22C55E; --down: #EF4444;
  --bg: #0E1117; --card: #161B24; --line: #232A36; --mute: #7C8798;
}
.num { font-variant-numeric: tabular-nums;
  font-family: "SF Mono", "JetBrains Mono", ui-monospace, monospace; }

/* ── collapsed pill ─────────────────────────────────────────────────────── */
.pill {
  display: flex; align-items: center; gap: 8px; cursor: pointer;
  background: rgba(14,17,23,.96); backdrop-filter: blur(12px);
  border: 1px solid var(--line); border-radius: 999px;
  padding: 8px 14px 8px 10px; box-shadow: 0 8px 28px rgba(0,0,0,.5);
  transition: transform .18s cubic-bezier(.2,.8,.2,1), border-color .18s;
}
.pill:hover { transform: translateY(-2px); border-color: var(--blue); }
.pill .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--blue);
  box-shadow: 0 0 0 0 rgba(59,130,246,.6); animation: pulse 2.4s infinite; }
@keyframes pulse {
  0% { box-shadow: 0 0 0 0 rgba(59,130,246,.55); }
  70% { box-shadow: 0 0 0 7px rgba(59,130,246,0); }
  100% { box-shadow: 0 0 0 0 rgba(59,130,246,0); }
}
.pill .lbl { font-size: 11px; font-weight: 700; letter-spacing: .04em; }
.pill .px { font-size: 13px; font-weight: 700; }

/* ── panel ──────────────────────────────────────────────────────────────── */
.card {
  width: 292px; background: rgba(14,17,23,.97); backdrop-filter: blur(14px);
  border: 1px solid var(--line); border-radius: 16px; overflow: hidden;
  box-shadow: 0 18px 52px rgba(0,0,0,.62);
  animation: rise .2s cubic-bezier(.2,.8,.2,1);
}
@keyframes rise { from { opacity: 0; transform: translateY(8px) scale(.98); } }

.head { display: flex; align-items: center; gap: 7px; padding: 10px 12px; cursor: grab;
  border-bottom: 1px solid var(--line); }
.head:active { cursor: grabbing; }
.head .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--blue); }
.head .nm { font-size: 11px; font-weight: 700; letter-spacing: .05em; }
.sim { font-size: 8px; font-weight: 800; letter-spacing: .08em; color: #93B4FD;
  border: 1px solid var(--blue-dim); border-radius: 4px; padding: 1px 5px; }
.grow { flex: 1; }
.ico { background: none; border: 0; color: var(--mute); cursor: pointer; padding: 2px 4px;
  border-radius: 5px; font-size: 13px; line-height: 1; font-family: inherit; }
.ico:hover { color: #E6EAF2; background: var(--card); }
.ico.on { color: var(--blue); }

.body { padding: 11px 12px 12px; display: grid; gap: 10px; }

.q { font-size: 12px; font-weight: 600; line-height: 1.35; color: #C4CCDA;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  cursor: pointer; }
.q:hover { color: #fff; text-decoration: underline; }
select.sib { width: 100%; background: var(--card); color: #C4CCDA; border: 1px solid var(--line);
  border-radius: 8px; padding: 6px 7px; font: inherit; font-size: 11px; }

.sides { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; }
.side { border: 1px solid var(--line); background: var(--card); border-radius: 11px;
  padding: 9px 5px; cursor: pointer; font-family: inherit; text-align: center;
  transition: border-color .15s, background .15s, transform .1s; }
.side:active { transform: scale(.97); }
.side .t { font-size: 9px; font-weight: 800; letter-spacing: .06em; opacity: .8; }
.side .p { font-size: 19px; font-weight: 700; margin-top: 2px; transition: color .3s; }
.side.y { color: var(--up); } .side.n { color: var(--down); }
.side.y[data-on="1"] { border-color: var(--up); background: rgba(34,197,94,.12); }
.side.n[data-on="1"] { border-color: var(--down); background: rgba(239,68,68,.12); }
/* Flash the direction a price moved, then fade back. */
.side .p.up { animation: flashUp .55s ease-out; }
.side .p.dn { animation: flashDn .55s ease-out; }
@keyframes flashUp { 0% { color: var(--up); transform: translateY(-3px); } 100% { transform: none; } }
@keyframes flashDn { 0% { color: var(--down); transform: translateY(3px); } 100% { transform: none; } }

.amt { display: flex; align-items: center; background: var(--card);
  border: 1px solid var(--line); border-radius: 11px; padding: 0 10px;
  transition: border-color .15s; }
.amt:focus-within { border-color: var(--blue); }
.amt span { color: var(--mute); font-size: 13px; }
.amt input { flex: 1; background: none; border: 0; color: #E6EAF2; font: inherit;
  font-size: 16px; font-weight: 600; padding: 9px 5px; outline: none;
  font-variant-numeric: tabular-nums; font-family: "SF Mono", ui-monospace, monospace; }
.amt input::-webkit-outer-spin-button, .amt input::-webkit-inner-spin-button {
  -webkit-appearance: none; margin: 0; }

.chips { display: flex; gap: 5px; }
.chip { flex: 1; background: var(--card); border: 1px solid var(--line); color: var(--mute);
  border-radius: 8px; padding: 5px 0; font: inherit; font-size: 10.5px; cursor: pointer;
  transition: all .13s; }
.chip:hover { color: #E6EAF2; border-color: var(--blue); }
.chip:active { transform: scale(.95); }

.tick { background: var(--card); border-radius: 11px; padding: 8px 10px; display: grid; gap: 4px; }
.r { display: flex; justify-content: space-between; font-size: 11px; }
.r > span:first-child { color: var(--mute); }
.r.big > span:last-child { color: var(--up); font-weight: 700; }
.warn { color: #F59E0B; }
.skel { height: 58px; border-radius: 11px; background: linear-gradient(90deg,
  var(--card) 25%, #1D2430 50%, var(--card) 75%); background-size: 200% 100%;
  animation: shim 1.3s infinite; }
@keyframes shim { to { background-position: -200% 0; } }

.go { width: 100%; padding: 11px; border: 0; border-radius: 11px; cursor: pointer;
  font: inherit; font-size: 13.5px; font-weight: 800; color: #06070A;
  transition: filter .15s, transform .1s; }
.go:active { transform: scale(.985); }
.go.y { background: var(--up); } .go.n { background: var(--down); }
.go:disabled { opacity: .5; cursor: not-allowed; }
.go.pending { background: var(--blue); color: #fff; }

.msg { font-size: 11px; padding: 7px 9px; border-radius: 9px; line-height: 1.4; }
.msg.err { background: rgba(239,68,68,.13); color: #FCA5A5; }

/* ── toast ──────────────────────────────────────────────────────────────── */
.toasts { position: fixed; z-index: 2147483601; display: grid; gap: 6px; justify-items: center; }
.toast { display: flex; align-items: center; gap: 8px; padding: 9px 15px;
  background: rgba(14,17,23,.97); backdrop-filter: blur(12px);
  border: 1px solid var(--line); border-radius: 999px; font-size: 12px; font-weight: 600;
  box-shadow: 0 10px 32px rgba(0,0,0,.55); animation: toastIn .22s cubic-bezier(.2,.8,.2,1);
  white-space: nowrap; max-width: 340px; }
.toast.out { animation: toastOut .2s forwards; }
@keyframes toastIn { from { opacity: 0; transform: translateY(10px) scale(.95); } }
@keyframes toastOut { to { opacity: 0; transform: translateY(-6px) scale(.97); } }
.toast .sp { width: 11px; height: 11px; border-radius: 50%;
  border: 2px solid rgba(59,130,246,.3); border-top-color: var(--blue);
  animation: spin .6s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.toast.ok { border-color: rgba(34,197,94,.5); color: var(--up); }
.toast.bad { border-color: rgba(239,68,68,.5); color: #FCA5A5; }

canvas.confetti { position: fixed; inset: 0; pointer-events: none; z-index: 2147483602; }

.hide { display: none !important; }
@media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
`;

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

// ── toasts ──────────────────────────────────────────────────────────────────

let toastHost: HTMLDivElement | null = null;

function toast(text: string, kind: 'pending' | 'ok' | 'bad', ms = 2600): () => void {
  if (!shadow) return () => undefined;
  if (!toastHost) {
    toastHost = document.createElement('div');
    toastHost.className = 'toasts';
    toastHost.style.left = '50%';
    toastHost.style.transform = 'translateX(-50%)';
    toastHost.style.bottom = '28px';
    shadow.appendChild(toastHost);
  }

  const el = document.createElement('div');
  el.className = `toast ${kind === 'pending' ? '' : kind}`;
  el.innerHTML =
    kind === 'pending'
      ? `<span class="sp"></span><span>${esc(text)}</span>`
      : `<span>${kind === 'ok' ? '✓' : '!'}</span><span>${esc(text)}</span>`;
  toastHost.appendChild(el);

  const kill = () => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 220);
  };
  if (kind !== 'pending') setTimeout(kill, ms);
  return kill;
}

/**
 * Confetti, drawn on a throwaway canvas.
 *
 * No library: a few dozen rectangles under gravity is ~30 lines, and pulling a
 * dependency into a script that runs on every page load is not worth it.
 */
function confetti(): void {
  if (!shadow || settings?.confettiEnabled === false) return;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const cv = document.createElement('canvas');
  cv.className = 'confetti';
  cv.width = innerWidth;
  cv.height = innerHeight;
  shadow.appendChild(cv);
  const ctx = cv.getContext('2d');
  if (!ctx) return;

  const colours = ['#3B82F6', '#22C55E', '#F59E0B', '#A78BFA', '#EC4899'];
  const bits = Array.from({ length: 70 }, () => ({
    x: cv.width / 2 + (Math.random() - 0.5) * 220,
    y: cv.height * 0.42 + (Math.random() - 0.5) * 60,
    vx: (Math.random() - 0.5) * 9,
    vy: -Math.random() * 11 - 3,
    w: 5 + Math.random() * 5,
    h: 3 + Math.random() * 4,
    rot: Math.random() * Math.PI,
    vr: (Math.random() - 0.5) * 0.3,
    c: colours[(Math.random() * colours.length) | 0]!,
  }));

  let frame = 0;
  const tick = () => {
    frame++;
    ctx.clearRect(0, 0, cv.width, cv.height);
    for (const b of bits) {
      b.vy += 0.32; // gravity
      b.x += b.vx;
      b.y += b.vy;
      b.rot += b.vr;
      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.rotate(b.rot);
      ctx.globalAlpha = Math.max(0, 1 - frame / 90);
      ctx.fillStyle = b.c;
      ctx.fillRect(-b.w / 2, -b.h / 2, b.w, b.h);
      ctx.restore();
    }
    if (frame < 90) requestAnimationFrame(tick);
    else cv.remove();
  };
  requestAnimationFrame(tick);
}

// ── mount ───────────────────────────────────────────────────────────────────

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

  const saved = settings?.overlayPosition;
  if (saved) {
    panel.style.left = `${saved.x}px`;
    panel.style.top = `${saved.y}px`;
  } else {
    // Both venues put their real order panel on the right; stay clear of it.
    panel.style.left = '20px';
    panel.style.bottom = '20px';
  }
}

function unmount(): void {
  clearInterval(pollTimer);
  document.getElementById(HOST_ID)?.remove();
  shadow = null;
  panel = null;
  toastHost = null;
  quote = null;
}

function render(): void {
  if (!panel || !meta || !market) return;

  if (collapsed) {
    const px = outcome === 'yes' ? live.yes : live.no;
    panel.innerHTML = `
      <div class="pill" data-a="expand">
        <span class="dot"></span>
        <span class="lbl">POLYFILL</span>
        <span class="px num">${px == null ? '--' : px.toFixed(0) + '¢'}</span>
      </div>`;
    wire();
    return;
  }

  const self = market.siblings.find((s) => s.meta.venueMarketId === meta!.venueMarketId);
  const yes = live.yes ?? self?.mid ?? null;
  const no = live.no ?? (yes == null ? null : 100 - yes);

  const dir = (now: number | null, before: number | null) =>
    now == null || before == null || now === before ? '' : now > before ? 'up' : 'dn';

  const picker =
    market.siblings.length > 1
      ? `<select class="sib" data-a="pick">${market.siblings
          .map(
            (s) =>
              `<option value="${esc(s.meta.venueMarketId)}"${
                s.meta.venueMarketId === meta!.venueMarketId ? ' selected' : ''
              }>${esc(s.meta.question.slice(0, 56))}</option>`,
          )
          .join('')}</select>`
      : '';

  const ticket = quote
    ? `<div class="tick">
         <div class="r"><span>Avg fill</span><span class="num">${quote.avgPrice.toFixed(1)}¢</span></div>
         <div class="r"><span>You get</span><span class="num">${quote.qty.toLocaleString()} ${quote.unitNoun}</span></div>
         <div class="r"><span>Cost</span><span class="num">P$${quote.totalCost.toFixed(2)}</span></div>
         <div class="r big"><span>If it wins</span><span class="num">+P$${quote.maxProfit.toFixed(2)}</span></div>
         ${quote.partial ? `<div class="r"><span class="warn">Partial fill</span><span class="warn">book ran out</span></div>` : ''}
       </div>`
    : amount > 0
      ? `<div class="skel"></div>`
      : '';

  panel.innerHTML = `
    <div class="card">
      <div class="head">
        <span class="dot"></span>
        <span class="nm">POLYFILL</span>
        <span class="sim">SIM · NO REAL MONEY</span>
        <span class="grow"></span>
        <button class="ico ${watched ? 'on' : ''}" data-a="watch" title="${watched ? 'Saved' : 'Save to watchlist'}">${watched ? '★' : '☆'}</button>
        <button class="ico" data-a="collapse" title="Minimise">−</button>
      </div>
      <div class="body">
        <div class="q" data-a="open" title="Open this market">${esc(meta.question)}</div>
        ${picker}
        <div class="sides">
          <button class="side y" data-a="side" data-o="yes" data-on="${outcome === 'yes' ? 1 : 0}">
            <div class="t">▲ YES</div>
            <div class="p num ${dir(yes, prevLive.yes)}">${yes == null ? '--' : yes.toFixed(0) + '¢'}</div>
          </button>
          <button class="side n" data-a="side" data-o="no" data-on="${outcome === 'no' ? 1 : 0}">
            <div class="t">▼ NO</div>
            <div class="p num ${dir(no, prevLive.no)}">${no == null ? '--' : no.toFixed(0) + '¢'}</div>
          </button>
        </div>
        <div class="amt"><span>P$</span><input data-a="amt" type="number" min="1" step="1" value="${amount}" /></div>
        <div class="chips">
          ${(settings?.quickAmounts ?? [25, 50, 100, 250])
            .slice(0, 4)
            .map((v) => `<button class="chip" data-a="pre" data-v="${v}">${v}</button>`)
            .join('')}
        </div>
        ${ticket}
        <button class="go ${busy ? 'pending' : outcome === 'yes' ? 'y' : 'n'}" data-a="go" ${busy || !quote ? 'disabled' : ''}>
          ${busy ? 'Placing…' : `${side === 'buy' ? 'Buy' : 'Sell'} ${outcome.toUpperCase()}`}
        </button>
      </div>
    </div>`;

  wire();
}

function wire(): void {
  if (!panel) return;

  panel.querySelectorAll('[data-a]').forEach((el) => {
    const a = (el as HTMLElement).dataset.a;

    if (a === 'collapse')
      el.addEventListener('click', () => {
        collapsed = true;
        render();
      });
    if (a === 'expand')
      el.addEventListener('click', () => {
        collapsed = false;
        render();
        requestQuote();
      });
    if (a === 'side')
      el.addEventListener('click', () => {
        outcome = ((el as HTMLElement).dataset.o as 'yes' | 'no') ?? 'yes';
        beep('tick');
        render(); // paint the selection immediately, quote catches up
        requestQuote();
      });
    if (a === 'pre')
      el.addEventListener('click', () => {
        amount = Number((el as HTMLElement).dataset.v) || 100;
        beep('tick');
        render();
        requestQuote();
      });
    if (a === 'amt')
      el.addEventListener('input', () => {
        amount = Number((el as HTMLInputElement).value) || 0;
        requestQuote();
      });
    if (a === 'pick')
      el.addEventListener('change', () => {
        const id = (el as HTMLSelectElement).value;
        meta = market?.siblings.find((s) => s.meta.venueMarketId === id)?.meta ?? meta;
        quote = null;
        render();
        void refreshBook();
      });
    if (a === 'go') el.addEventListener('click', () => void place());
    if (a === 'watch') el.addEventListener('click', () => void toggleWatch());
    if (a === 'open')
      el.addEventListener('click', () => window.open(location.href, '_blank', 'noopener'));
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

// ── live data ───────────────────────────────────────────────────────────────

/**
 * Refetch the book and repaint.
 *
 * This is what was missing: prices came from the initial URL resolve and then
 * never moved, so on a 5-minute BTC market the panel showed a price from
 * minutes ago and quotes aged out underneath it.
 */
async function refreshBook(): Promise<void> {
  if (!meta || collapsed) return;
  try {
    const { book } = await send<{ book: { yes: { bids: [number, number][]; asks: [number, number][] } } }>(
      { type: 'GET_BOOK', meta },
    );
    const bid = book.yes.bids[0]?.[0] ?? null;
    const ask = book.yes.asks[0]?.[0] ?? null;
    const mid = bid != null && ask != null ? (bid + ask) / 2 : (bid ?? ask);

    prevLive = live;
    live = { yes: mid, no: mid == null ? null : 100 - mid };
    if (live.yes !== prevLive.yes) render();
  } catch {
    // A dropped poll is not worth surfacing; the next tick retries.
  }
}

function startPolling(): void {
  clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (document.hidden || collapsed) return; // don't burn API budget in a background tab
    void refreshBook();
    // Keep the quote fresh so it can never age past its 10s life.
    if (quote && amount > 0) requestQuote();
  }, POLL_MS) as unknown as number;
}

function requestQuote(): void {
  clearTimeout(quoteTimer);
  if (!meta || !(amount > 0)) {
    quote = null;
    render();
    return;
  }
  quoteTimer = setTimeout(async () => {
    try {
      const q = await send<QuoteResult>({
        type: 'QUOTE',
        meta: meta!,
        side,
        outcome,
        notional: amount,
      });
      quote = q;
      render();
    } catch (e) {
      quote = null;
      render();
      showError(e as Error);
    }
  }, 220) as unknown as number;
}

let lastErrorAt = 0;
function showError(e: Error & { code?: string; detail?: string }): void {
  // One error toast at a time; a 1s poll must not produce a wall of them.
  if (Date.now() - lastErrorAt < 3000) return;
  lastErrorAt = Date.now();
  toast(friendlyError(e.code, e.message, e.detail), 'bad', 4200);
}

async function toggleWatch(): Promise<void> {
  if (!meta) return;
  watched = !watched;
  render(); // optimistic — the star flips instantly
  try {
    const { watched: now } = await send<{ watched: boolean }>({
      type: 'TOGGLE_WATCH',
      meta,
      mid: live.yes,
    });
    watched = now;
    render();
    toast(now ? 'Saved to your watchlist' : 'Removed from watchlist', 'ok', 1800);
  } catch {
    watched = !watched;
    render();
  }
}

async function place(): Promise<void> {
  if (!quote || !meta || busy) return;

  // Instant feedback. The 250ms latency replay is deliberate — your quote is
  // not your fill — but the UI must never feel like it missed the click.
  busy = true;
  render();
  const done = toast('Placing your order…', 'pending');

  try {
    const { order } = await send<{ order: { status: string; qtyFilled: number; avgPrice: number } }>(
      { type: 'SUBMIT', meta, quote },
    );
    done();
    beep(order.status === 'partial' ? 'partial' : 'fill');
    toast(
      `${order.status === 'partial' ? 'Partly filled' : 'Filled'} — ${order.qtyFilled.toLocaleString()} at ${order.avgPrice.toFixed(1)}¢`,
      'ok',
      3200,
    );
    confetti();
    quote = null;
  } catch (e) {
    done();
    beep('reject');
    showError(e as Error);
  } finally {
    busy = false;
    render();
    requestQuote();
  }
}

// ── navigation ──────────────────────────────────────────────────────────────

async function sync(): Promise<void> {
  let next: ResolvedMarket | null = null;
  try {
    next = await send<ResolvedMarket | null>({ type: 'RESOLVE_URL', url: location.href });
  } catch {
    next = null;
  }

  if (!next) {
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
    live = { yes: null, no: null };
    prevLive = { yes: null, no: null };
    try {
      watched = await send<boolean>({ type: 'WATCH_HAS', meta: next.meta });
    } catch {
      watched = false;
    }
  }

  mount();
  render();
  if (changed) {
    void refreshBook();
    requestQuote();
  }
  startPolling();
}

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
  new MutationObserver(fire).observe(document.body, { childList: true, subtree: false });
  // Catch up immediately when a backgrounded tab comes forward.
  addEventListener('visibilitychange', () => {
    if (!document.hidden) void refreshBook();
  });
}

async function boot(): Promise<void> {
  try {
    settings = await send<Settings>({ type: 'GET_SETTINGS' });
  } catch {
    return;
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
