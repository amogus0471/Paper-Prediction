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
 * RENDERING RULE — the reason this file is shaped the way it is: the DOM is
 * BUILT ONCE and thereafter only PATCHED. An earlier version reassigned
 * innerHTML on every poll, which rebuilt every node once a second — that is
 * the "twitch": text reflows, focus is lost mid-typing, CSS animations restart,
 * and any open dropdown snaps shut. Structure changes only when the market
 * changes; values are written through `paint()`.
 */

import { playSound } from '../lib/sfx';
import { send } from '../lib/messages';
import { friendlyError } from '@polyfill/core';
import { Odometer, ODOMETER_CSS } from './odometer';
import type { MarketMeta, QuoteResult } from '../lib/engine';
import type { ResolvedMarket } from '../lib/resolve';
import type { Settings } from '../lib/store';

const HOST_ID = 'paper-predictions-root';

/**
 * Book refresh cadence.
 *
 * Polymarket's CLOB read budget is shared across every consumer of their API
 * and tightens near 100 req/min, so a 500ms poll on one market would sit on
 * the ceiling and earn 429s for everyone. One second stays inside it, and the
 * odometer animates between ticks so it reads as continuous.
 */
const POLL_MS = 1000;

interface Live {
  yes: number | null;
  no: number | null;
  spread: number | null;
  /** When the last book actually landed. Null until the first one does. */
  at: number | null;
  /** Consecutive failed polls — what turns a silent freeze into a visible one. */
  misses: number;
}

/** Beyond this, the price on screen is old enough to say so. */
const STALE_AFTER_MS = 6000;

let shadow: ShadowRoot | null = null;
let wrap: HTMLDivElement | null = null;
let settings: Settings | null = null;
let market: ResolvedMarket | null = null;
let meta: MarketMeta | null = null;
let quote: QuoteResult | null = null;
let live: Live = { yes: null, no: null, spread: null, at: null, misses: 0 };
let pnl: { equity: number; delta: number } | null = null;
let outcome: 'yes' | 'no' = 'yes';
let amount = 100;
let busy = false;
let collapsed = false;
let expanded = false;
let watched = false;
let pollTimer: number | undefined;
let quoteTimer: number | undefined;
let structureKey = '';
/** Chosen popup width. Kept here so switching markets never resets the size. */
let overlayWidth = 300;
/** Last five resolved outcomes, newest first, for the pill's streak dots. */
let streak: boolean[] = [];
/** When the last drag ended, so the trailing click can be swallowed. */
let lastDragEnd = 0;
let lastSideKey: 'yes' | 'no' | null = null;
let lastSideKeyAt = 0;
/** True when this market is the pinned one. */
let pinned = false;

/** Stable references into the built DOM, so paint() never queries. */
interface Nodes {
  root: HTMLDivElement;
  question: HTMLDivElement;
  yesPx: Odometer;
  noPx: Odometer;
  yesBtn: HTMLButtonElement;
  noBtn: HTMLButtonElement;
  amtInput: HTMLInputElement;
  chips: HTMLDivElement;
  ticket: HTMLDivElement;
  go: HTMLButtonElement;
  star: HTMLButtonElement;
  extra: HTMLDivElement;
  picker: HTMLDivElement | null;
  pickerLabel: HTMLSpanElement | null;
  /** The panel wrapper, so the whole card can be dimmed when prices go stale. */
  wrapEl: HTMLDivElement;
  stale: HTMLDivElement;
}
let n: Nodes | null = null;

// Pill nodes, kept separate because the pill is its own small tree.
interface PillNodes {
  root: HTMLDivElement;
  px: Odometer;
  pnl: Odometer;
  label: HTMLSpanElement;
  streak: HTMLDivElement;
}
let pn: PillNodes | null = null;

const CSS = `
:host { all: initial; }
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
${ODOMETER_CSS}

.wrap {
  position: fixed; z-index: 2147483600;
  font-family: Inter, system-ui, -apple-system, "Segoe UI", sans-serif;
  color: #E6EAF2; font-size: 13px; line-height: 1.4;
  --blue: #3B82F6; --blue2: #60A5FA; --edge: #1E2733;
  --up: #22C55E; --down: #EF4444;
  --bg: #0D1017; --card: #151A23; --line: #222B38; --mute: #78849A;
}
.num { font-variant-numeric: tabular-nums;
  font-family: "SF Mono", "JetBrains Mono", ui-monospace, monospace; }

/* ── pill ───────────────────────────────────────────────────────────────── */
.pill {
  display: flex; align-items: center; gap: 10px; cursor: grab;
  background: linear-gradient(135deg, rgba(19,24,33,.97), rgba(13,16,23,.97));
  backdrop-filter: blur(14px);
  border: 1px solid var(--line); border-left: 2px solid var(--blue);
  border-radius: 12px; padding: 9px 14px 9px 11px;
  box-shadow: 0 10px 30px rgba(0,0,0,.5);
  transition: border-color .2s;
  min-width: 300px;
}
.pill:hover { border-color: var(--blue); }
.pill:active { cursor: grabbing; }
.pill .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--blue); flex: 0 0 auto;
  animation: fade 2.4s infinite; }
@keyframes fade { 0%,100% { opacity: 1; } 50% { opacity: .35; } }
.pill .streak { display: flex; gap: 3px; align-items: center; }
.pill .streak b { width: 6px; height: 6px; border-radius: 50%; background: var(--line); }
.pill .streak b.w { background: var(--up); }
.pill .streak b.l { background: var(--down); }
.pill .stack { display: grid; gap: 1px; line-height: 1.15; min-width: 0; }
.pill .k { font-size: 8.5px; color: var(--mute); letter-spacing: .07em; font-weight: 700; }
.pill .v { font-size: 14px; font-weight: 700; }
.pill .sep { width: 1px; height: 22px; background: var(--line); flex: 0 0 auto; }
.pill .grow { flex: 1; }
.pill .open { font-size: 15px; color: var(--mute); }
.pill:hover .open { color: var(--blue2); }

/* ── panel ──────────────────────────────────────────────────────────────── */
.card {
  width: var(--w, 300px);
  background: linear-gradient(160deg, rgba(21,26,35,.98), rgba(13,16,23,.985));
  backdrop-filter: blur(16px);
  border: 1px solid var(--line); border-radius: 18px;
  box-shadow: 0 20px 60px rgba(0,0,0,.65);
  animation: rise .22s cubic-bezier(.2,.8,.2,1);
  position: relative;
  /* NOT overflow:hidden.
     That clipped the outcome dropdown to the card's own height, which is why
     a 40-outcome event appeared to have four and could not be scrolled: the
     list was the full length and scrollable all along, you were looking at it
     through a letterbox. The card's own background is clipped by border-radius
     without this, and no child paints into the corners. */
  overflow: visible;
}
@keyframes rise { from { opacity: 0; transform: translateY(10px) scale(.98); } }

.head { display: flex; align-items: center; gap: 7px; padding: 11px 13px; cursor: grab;
  border-bottom: 1px solid var(--line); }
.head:active { cursor: grabbing; }
.head .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--blue); }
.head .nm { font-size: 12.5px; font-weight: 800; letter-spacing: .04em; }
.sim { font-size: 8px; font-weight: 800; letter-spacing: .08em; color: #93B4FD;
  border: 1px solid #1D4ED8; border-radius: 4px; padding: 1px 5px; }
.grow { flex: 1; }
.ico { background: none; border: 0; color: var(--mute); cursor: pointer; padding: 3px 5px;
  border-radius: 6px; font-size: 13px; line-height: 1; font-family: inherit;
  transition: color .13s, background .13s; }
.ico:hover { color: #E6EAF2; background: var(--card); }
.ico.on { color: #FBBF24; }

.body { padding: 12px 13px 13px; display: grid; gap: 10px; }
/* Past ~380px the panel becomes two columns: trade controls left, live
   numbers right. Stretching a single column just makes long thin rows. */
.card.wide .body {
  /* Named areas, never row numbers. The sibling picker is conditional, so a
     hard-coded grid-row pushed a control off the grid whenever the picker was
     absent — that is why buttons went missing at wide widths. */
  grid-template-columns: 1fr 1fr;
  grid-template-areas:
    "q     q"
    "dd    dd"
    "sides tick"
    "amt   tick"
    "chips extra"
    "go    go";
  align-items: start; column-gap: 12px;
}
.card.wide.nodd .body { grid-template-areas:
    "q q" "sides tick" "amt tick" "chips extra" "go go"; }
.card.wide .q     { grid-area: q; -webkit-line-clamp: 3; }
.card.wide .dd    { grid-area: dd; }
.card.wide .sides { grid-area: sides; }
.card.wide .amt   { grid-area: amt; }
.card.wide .chips { grid-area: chips; }
.card.wide .tick  { grid-area: tick; align-self: stretch; }
.card.wide .extra { grid-area: extra; }
.card.wide .go    { grid-area: go; }

/* NARROW. Below ~300px the default paddings and type sizes stop fitting and
   controls visibly collide — reported repeatedly as "buttons smushed". These
   are driven by a class rather than a media query because the panel is sized
   by a CSS variable, not by the viewport, so @media never fires. */
.card.tight .body { padding: 9px 9px 10px; gap: 7px; }
.card.tight .head { padding: 8px 9px; gap: 5px; }
.card.tight .head .nm { font-size: 10px; letter-spacing: .02em; }
.card.tight .sim { font-size: 7px; padding: 1px 3px; }
.card.tight .q { font-size: 11px; -webkit-line-clamp: 2; }
.card.tight .sides { gap: 5px; }
.card.tight .side { padding: 7px 3px; border-radius: 9px; }
.card.tight .side .t { font-size: 8px; letter-spacing: .03em; }
.card.tight .side .p { font-size: 15px; }
.card.tight .amt { padding: 0 8px; border-radius: 9px; }
.card.tight .amt input { font-size: 13px; padding: 7px 4px; }
.card.tight .chips { gap: 4px; }
.card.tight .chip { font-size: 9.5px; padding: 5px 0; border-radius: 7px; }
.card.tight .tick { padding: 7px 8px; gap: 3px; }
.card.tight .r { font-size: 10px; }
.card.tight .r.big > span:last-child { font-size: 14px; }
.card.tight .r.lead > span:last-child { font-size: 13px; }
.card.tight .go { padding: 9px; font-size: 12px; border-radius: 9px; }
.card.tight .dd-btn { padding: 6px 8px; }
.card.tight .dd-btn .lbl { font-size: 10.5px; }
/* The grip is a 26px target on a 264px panel; shrink it so it stops eating
   the corner of the place button. */
.card.tight .grip { width: 18px; height: 18px; }
.card.tight .egrip { display: none; }

.q { font-size: 12.5px; font-weight: 600; line-height: 1.35; color: #C9D2E0; cursor: pointer;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.q:hover { color: #fff; }

/* Custom dropdown — a native <select> cannot show an image or a price. */
.dd { position: relative; }
.dd-btn { width: 100%; display: flex; align-items: center; gap: 8px;
  background: var(--card); border: 1px solid var(--line); border-radius: 10px;
  padding: 8px 10px; cursor: pointer; font: inherit; color: #C9D2E0; text-align: left;
  transition: border-color .13s; }
.dd-btn:hover { border-color: var(--blue); }
.dd-btn .lbl { flex: 1; font-size: 11.5px; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; }
.dd-btn .car { color: var(--mute); font-size: 9px; transition: transform .18s; }
.dd.open .dd-btn .car { transform: rotate(180deg); }
.dd-list { position: absolute; left: 0; right: 0; top: calc(100% + 5px); z-index: 5;
  background: #10141C; border: 1px solid var(--line); border-radius: 12px;
  max-height: 264px; overflow-y: auto; box-shadow: 0 16px 44px rgba(0,0,0,.6);
  opacity: 0; visibility: hidden; transform: translateY(-6px);
  transition: opacity .16s, transform .16s, visibility .16s; }
.dd.open .dd-list { opacity: 1; visibility: visible; transform: none; }
.dd-item { display: flex; align-items: center; gap: 9px; padding: 9px 10px; cursor: pointer;
  border-bottom: 1px solid rgba(34,43,56,.6); transition: background .1s; }
.dd-item:last-child { border-bottom: 0; }
.dd-item:hover { background: rgba(59,130,246,.1); }
.dd-item[aria-selected="true"] { background: rgba(59,130,246,.16); }
.dd-item .av { width: 30px; height: 30px; border-radius: 8px; flex: 0 0 auto;
  background: var(--card); object-fit: cover; display: flex; align-items: center;
  justify-content: center; font-size: 10px; font-weight: 800; color: var(--blue2);
  align-self: flex-start; }
.dd-item { align-items: flex-start; }
.dd-item .pc { align-self: center; }
.dd-item .t { flex: 1; font-size: 12px; font-weight: 600; color: #fff;
  line-height: 1.32; white-space: normal; overflow-wrap: anywhere; }
.dd-search { width: calc(100% - 16px); margin: 8px; background: var(--card);
  border: 1px solid var(--line); border-radius: 8px; padding: 7px 9px;
  color: #E6EAF2; font: inherit; font-size: 11.5px; outline: none; }
.dd-search:focus { border-color: var(--blue); }
/* Keep the search reachable while scrolling a long list — on a 40-outcome
   event, scrolling away from the one control that filters it is backwards. */
.dd-search { position: sticky; top: 0; z-index: 1; }
.dd-list::before { content: ''; position: sticky; top: 0; display: block;
  height: 8px; background: #10141C; margin: -8px 0 0; }

/* As tall as the screen allows rather than a fixed guess: the whole point is
   to see as many outcomes at once as there is room for. */
.dd-list { max-height: min(58vh, 440px); }
.dd-item .pc { font-size: 13px; font-weight: 700; }
.dd-list { overscroll-behavior: contain; }
.dd-list::-webkit-scrollbar { width: 7px; }
.dd-list::-webkit-scrollbar-thumb { background: var(--line); border-radius: 4px; }
/* Open upward when the panel is sitting low enough that downward would run off
   the bottom of the window. */
.dd.up .dd-list { top: auto; bottom: calc(100% + 5px); transform: translateY(6px); }
.dd.up.open .dd-list { transform: none; }
.dd-count { padding: 6px 10px 7px; font-size: 10px; color: var(--mute);
  border-bottom: 1px solid rgba(34,43,56,.6); letter-spacing: .03em; }

.sides { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; }
.side { border: 1px solid var(--line); background: var(--card); border-radius: 12px;
  padding: 10px 5px; cursor: pointer; font-family: inherit; text-align: center;
  transition: border-color .15s, background .15s; }
.side .t { font-size: 9px; font-weight: 800; letter-spacing: .07em; opacity: .82; }
.side .p { font-size: 20px; font-weight: 700; margin-top: 2px; }
.side.y { color: var(--up); } .side.n { color: var(--down); }
.side.y[data-on="1"] { border-color: var(--up); background: rgba(34,197,94,.13); }
.side.n[data-on="1"] { border-color: var(--down); background: rgba(239,68,68,.13); }

.amt { display: flex; align-items: center; background: var(--card);
  border: 1px solid var(--line); border-radius: 12px; padding: 0 11px;
  transition: border-color .15s; }
.amt:focus-within { border-color: var(--blue); }
.amt > span { color: var(--mute); font-size: 13px; }
.amt input { flex: 1; background: none; border: 0; color: #E6EAF2; font: inherit;
  font-size: 16px; font-weight: 600; padding: 10px 5px; outline: none;
  font-variant-numeric: tabular-nums; font-family: "SF Mono", ui-monospace, monospace; }
.amt input::-webkit-outer-spin-button, .amt input::-webkit-inner-spin-button {
  -webkit-appearance: none; margin: 0; }

.chips { display: flex; gap: 5px; }
.chip { flex: 1; background: var(--card); border: 1px solid var(--line); color: var(--mute);
  border-radius: 9px; padding: 6px 0; font: inherit; font-size: 10.5px; cursor: pointer;
  transition: color .12s, border-color .12s; }
.chip:hover { color: #E6EAF2; border-color: var(--blue); }

.tick { background: var(--card); border-radius: 12px; padding: 9px 11px; display: grid; gap: 4px;
  min-height: 34px; }
.r { display: flex; justify-content: space-between; font-size: 11px; }
.r > span:first-child { color: var(--mute); }
.r.big { align-items: baseline; }
.r.big > span:last-child { color: var(--up); font-weight: 800; font-size: 17px; }
.r.lead > span:last-child { font-weight: 800; font-size: 16px; color: #fff; }
.warn { color: #F59E0B; }
/* The "can't price this" reason is a sentence, not a figure — let it wrap
   rather than run off the edge or squash the label next to it. */
.r.warn { align-items: flex-start; gap: 10px; }
.r.warn > span:last-child { text-align: right; white-space: normal;
  line-height: 1.35; max-width: 62%; }
.muted { color: var(--mute); font-size: 11px; }

.extra { display: grid; gap: 4px; }

/* Stale prices.
   Hidden entirely while the feed is healthy — a status line that is always
   there is a status line nobody reads. When it does appear, the numbers dim
   rather than vanish: the last real price is still the best information we
   have, it just is not current any more. */
.stale-note { display: none; font-size: 10.5px; color: #F59E0B;
  align-items: center; gap: 5px; }
.stale-note::before { content: ''; width: 5px; height: 5px; border-radius: 50%;
  background: #F59E0B; flex: 0 0 auto; animation: fade 1.6s infinite; }
.card.stale .stale-note { display: flex; }
.card.stale .side .p, .card.stale .tick, .card.stale .extra { opacity: .55; }

.go { width: 100%; padding: 12px; border: 0; border-radius: 12px; cursor: pointer;
  font: inherit; font-size: 13.5px; font-weight: 800; color: #06070A;
  transition: filter .14s, background .2s; }
.go.y { background: var(--up); } .go.n { background: var(--down); }
.go:disabled { opacity: .48; cursor: not-allowed; }
.go.pending { background: var(--blue); color: #fff; }

/* Resize grip — the corner lines that say "this is expandable". */
.grip { position: absolute; right: 0; bottom: 0; width: 26px; height: 26px;
  cursor: nwse-resize; opacity: .55; transition: opacity .15s; }
.grip:hover { opacity: 1; }
.grip::before, .grip::after { content: ''; position: absolute; right: 5px;
  background: var(--blue2); height: 2px; border-radius: 2px; }
.grip::before { width: 15px; bottom: 5px; transform: rotate(-45deg); transform-origin: right center; }
.grip::after  { width: 9px;  bottom: 10px; transform: rotate(-45deg); transform-origin: right center; }
/* Side grip: drag width only, without reaching for the corner. */
.egrip { position: absolute; right: 0; top: 46px; bottom: 26px; width: 9px;
  cursor: ew-resize; display: flex; align-items: center; justify-content: center; }
.egrip::before { content: ''; width: 2px; height: 26px; border-radius: 2px;
  background: var(--line); transition: background .15s; }
.egrip:hover::before { background: var(--blue2); }

/* ── toasts ─────────────────────────────────────────────────────────────── */
.toasts { position: absolute; z-index: 2147483601; display: grid; gap: 5px;
  justify-items: center; }
.toasts .toast { max-width: 100%; }
.toast { display: flex; align-items: flex-start; gap: 7px; padding: 7px 10px;
  background: rgba(13,16,23,.98); backdrop-filter: blur(12px);
  border: 1px solid var(--line); border-radius: 10px;
  font-family: inherit; font-size: 11px; font-weight: 500; line-height: 1.35;
  box-shadow: 0 8px 24px rgba(0,0,0,.55); animation: tIn .2s cubic-bezier(.2,.8,.2,1); }
.toast .ic { flex: 0 0 auto; font-weight: 700; }
.toast.out { animation: tOut .2s forwards; }
@keyframes tIn { from { opacity: 0; transform: translateY(-6px); } }
@keyframes tOut { to { opacity: 0; transform: translateY(-4px); } }
.toast .sp { width: 11px; height: 11px; border-radius: 50%;
  border: 2px solid rgba(59,130,246,.28); border-top-color: var(--blue);
  animation: spin .6s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.toast.ok { border-color: rgba(34,197,94,.45); color: #6EE7A0; }
.toast.undo { position: relative; align-items: center; gap: 10px; padding-bottom: 9px;
  overflow: hidden; }
.undobtn { background: none; border: 1px solid rgba(239,68,68,.5); color: #FCA5A5;
  border-radius: 7px; padding: 3px 10px; font: inherit; font-size: 10.5px; font-weight: 700;
  cursor: pointer; transition: background .14s, color .14s, transform .1s; }
.undobtn:hover { background: rgba(239,68,68,.16); color: #fff; transform: translateY(-1px); }
.undobtn:active { transform: none; }
.undobtn:disabled { opacity: .55; cursor: default; transform: none; }
/* Ten-second wind-down, so the offer visibly expires rather than vanishing. */
.undobar { position: absolute; left: 0; bottom: 0; height: 2px; background: var(--down);
  width: 100%; transform-origin: left; animation: undoWind 10s linear forwards; }
@keyframes undoWind { to { transform: scaleX(0); } }
.toast.bad { border-color: rgba(239,68,68,.45); color: #FCA5A5; }

canvas.confetti { position: fixed; inset: 0; pointer-events: none; z-index: 2147483602; }
.up { color: var(--up); } .down { color: var(--down); }
@media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
`;

/**
 * Format a price for display.
 *
 * Two rules that matter:
 *   - the decimal appears only when the market actually quotes at that
 *     precision (Polymarket's 0.1c-tick markets do, whole-cent ones do not),
 *     so we never show a digit the venue does not publish;
 *   - never render a bare 100¢ or 0¢. An unresolved market is not a certainty,
 *     and showing one reads as a bug. The DISPLAY clamps to 99.9/0.1 while the
 *     underlying number stays exact for the fill engine.
 */
function cents(v: number | null, tick = 1): string {
  if (v == null) return '--';
  const shown = Math.min(99.9, Math.max(0.1, v));
  const dp = tick < 1 || !Number.isInteger(shown) ? 1 : 0;
  return `${shown.toFixed(dp)}¢`;
}
const money = (v: number) => `${v < 0 ? '-' : '+'}P$${Math.abs(v).toFixed(2)}`;

// ── toasts ──────────────────────────────────────────────────────────────────

let toastHost: HTMLDivElement | null = null;

function toast(text: string, kind: 'pending' | 'ok' | 'bad', ms = 2600): () => void {
  if (!shadow) return () => undefined;
  if (!toastHost) {
    toastHost = document.createElement('div');
    toastHost.className = 'toasts';
    // Inside .wrap, so messages sit directly under the popup and follow it
    // when dragged, instead of floating in the middle of someone else's page.
    toastHost.style.top = 'calc(100% + 7px)';
    toastHost.style.left = '50%';
    toastHost.style.transform = 'translateX(-50%)';
    toastHost.style.minWidth = '100%';
    (wrap ?? shadow).appendChild(toastHost);
  }
  const el = document.createElement('div');
  el.className = `toast ${kind === 'pending' ? '' : kind}`;
  el.innerHTML =
    kind === 'pending'
      ? `<span class="sp"></span><span></span>`
      : `<span class="ic">${kind === 'ok' ? '✓' : '!'}</span><span></span>`;
  el.lastElementChild!.textContent = text;
  toastHost.appendChild(el);

  const kill = () => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 220);
  };
  if (kind !== 'pending') setTimeout(kill, ms);
  return kill;
}

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

  const colours = ['#3B82F6', '#22C55E', '#F59E0B', '#60A5FA', '#EC4899'];
  const bits = Array.from({ length: 70 }, () => ({
    x: cv.width / 2 + (Math.random() - 0.5) * 220,
    y: cv.height * 0.42,
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
      b.vy += 0.32;
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

// ── build (runs once per market) ────────────────────────────────────────────

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function buildPill(): void {
  if (!wrap) return;
  wrap.textContent = '';
  n = null;

  const root = el('div', 'pill');
  const px = new Odometer('--');
  const pnlOdo = new Odometer('P$0.00');

  const priceStack = el('div', 'stack');
  const priceK = el('span', 'k', 'PRICE');
  const priceV = el('span', 'v num');
  priceV.appendChild(px.el);
  priceStack.append(priceK, priceV);

  const pnlStack = el('div', 'stack');
  const pnlK = el('span', 'k', 'TODAY');
  const pnlV = el('span', 'v num');
  pnlV.appendChild(pnlOdo.el);
  pnlStack.append(pnlK, pnlV);

  const label = el('span', 'k');
  priceK.replaceWith(label);
  label.textContent = 'PRICE';

  const streakEl = el('div', 'streak');
  root.append(
    el('span', 'dot'),
    priceStack,
    el('span', 'sep'),
    pnlStack,
    el('span', 'grow'),
    streakEl,
    el('span', 'open', '⌃'),
  );
  wrap.appendChild(root);

  pn = { root, px, pnl: pnlOdo, label, streak: streakEl };

  root.addEventListener('mousedown', (e) => drag(e as MouseEvent, root));
  root.addEventListener('click', () => {
    // Ignored briefly after a drag: releasing the mouse at the end of a drag
    // fires a click, which used to pop the panel open every time you moved the
    // pill even a pixel.
    if (Date.now() - lastDragEnd < 250) return;
    collapsed = false;
    structureKey = '';
    rebuild();
  });
}

function buildPanel(): void {
  if (!wrap || !meta || !market) return;
  wrap.textContent = '';
  pn = null;

  const card = el('div', 'card');
  card.style.setProperty('--w', `${overlayWidth}px`);
  if (overlayWidth > 380) card.classList.add('wide');
  if (overlayWidth < 300) card.classList.add('tight');
  if (market.siblings.length <= 1) card.classList.add('nodd');

  // header
  const head = el('div', 'head');
  const star = el('button', 'ico');
  star.title = 'Save to watchlist';
  const pin = el('button', 'ico');
  pin.title = 'Pin this market so it follows you across pages';
  pin.textContent = '📌';
  const collapse = el('button', 'ico', '−');
  collapse.title = 'Minimise';
  head.append(
    el('span', 'dot'),
    el('span', 'nm', 'PAPER PREDICTIONS'),
    el('span', 'sim', 'SIM'),
    el('span', 'grow'),
    pin,
    star,
    collapse,
  );

  // body
  const body = el('div', 'body');
  const question = el('div', 'q');
  question.title = 'Open this market';

  // Custom dropdown, only when the event actually has siblings.
  let picker: HTMLDivElement | null = null;
  let pickerLabel: HTMLSpanElement | null = null;
  if (market.siblings.length > 1) {
    picker = el('div', 'dd');
    const btn = el('button', 'dd-btn');
    pickerLabel = el('span', 'lbl');
    btn.append(pickerLabel, el('span', 'car', '▼'));
    const list = el('div', 'dd-list');

    // Search box — a 40-market event is unusable without one.
    const search = el('input', 'dd-search');
    search.type = 'text';
    search.placeholder = 'Search outcomes…';
    search.addEventListener('click', (e) => e.stopPropagation());

    // Says how many outcomes there are, and how many the search is hiding.
    // Without it a clipped or filtered list is indistinguishable from a short
    // one, which is exactly the confusion this dropdown caused.
    const count = el('div', 'dd-count');
    const setCount = (shown: number) => {
      const total = market!.siblings.length;
      count.textContent =
        shown === total
          ? `${total} outcome${total === 1 ? '' : 's'} — scroll for more`
          : `${shown} of ${total} outcomes`;
    };

    search.addEventListener('input', () => {
      const q = search.value.toLowerCase().trim();
      let shown = 0;
      for (const row of Array.from(list.querySelectorAll('.dd-item')) as HTMLElement[]) {
        const hit = !q || (row.dataset.q ?? '').includes(q);
        row.style.display = hit ? '' : 'none';
        if (hit) shown++;
      }
      setCount(shown);
    });
    list.append(search, count);
    setCount(market.siblings.length);

    for (const s of market.siblings) {
      const item = el('div', 'dd-item');
      item.setAttribute('role', 'option');
      item.dataset.q = s.meta.question.toLowerCase();

      // Use the venue's own artwork when it supplies some; fall back to a
      // lettered tile rather than a broken image. `referrerpolicy` keeps the
      // host page out of the venue's logs.
      let av: HTMLElement;
      if (s.meta.imageUrl) {
        const img = document.createElement('img');
        img.className = 'av';
        img.src = s.meta.imageUrl;
        img.referrerPolicy = 'no-referrer';
        img.loading = 'lazy';
        img.alt = '';
        img.addEventListener('error', () => {
          const tile = el('div', 'av', (s.meta.yesLabel || s.meta.question).slice(0, 2).toUpperCase());
          img.replaceWith(tile);
        });
        av = img;
      } else {
        av = el('div', 'av', (s.meta.yesLabel || s.meta.question).slice(0, 2).toUpperCase());
      }

      // Full text, wrapped — truncating the one thing that identifies an
      // outcome makes the picker useless on long questions.
      const t = el('div', 't', s.meta.question);
      const pc = el('div', 'pc num', s.mid == null ? '--' : cents(s.mid, s.meta.tickCents));
      if (s.mid != null) pc.classList.add(s.mid >= 50 ? 'up' : 'down');
      item.append(av, t, pc);
      item.addEventListener('click', () => {
        meta = s.meta;
        picker!.classList.remove('open');
        quote = null;
        quoteError = null;
        structureKey = ''; // question + siblings change: rebuild once, then patch
        rebuild();
        void refreshBook();
        requestQuote();
      });
      list.appendChild(item);
    }

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const opening = !picker!.classList.contains('open');
      if (opening) {
        // The popup is draggable, so it can be sitting anywhere. Decide which
        // way to open from where the button actually is, not from a guess.
        const r = btn.getBoundingClientRect();
        const below = innerHeight - r.bottom;
        picker!.classList.toggle('up', below < 260 && r.top > below);
        // Reset the filter each time, so reopening never shows a subset of the
        // outcomes with no visible reason why.
        search.value = '';
        for (const row of Array.from(list.querySelectorAll('.dd-item')) as HTMLElement[]) {
          row.style.display = '';
        }
        setCount(market!.siblings.length);
        list.scrollTop = 0;
      }
      picker!.classList.toggle('open', opening);
    });
    picker.append(btn, list);
  }

  // sides
  const sides = el('div', 'sides');
  const yesBtn = el('button', 'side y');
  const yesPx = new Odometer('--');
  const yesVal = el('div', 'p num');
  yesVal.appendChild(yesPx.el);
  yesBtn.append(el('div', 't', '▲ YES'), yesVal);

  const noBtn = el('button', 'side n');
  const noPx = new Odometer('--');
  const noVal = el('div', 'p num');
  noVal.appendChild(noPx.el);
  noBtn.append(el('div', 't', '▼ NO'), noVal);
  sides.append(yesBtn, noBtn);

  // amount
  const amt = el('div', 'amt');
  const amtInput = el('input');
  amtInput.type = 'number';
  amtInput.min = '1';
  amtInput.value = String(amount);
  amt.append(el('span', 'P$'), amtInput);

  const chips = el('div', 'chips');
  const ticket = el('div', 'tick');
  const extra = el('div', 'extra');
  const stale = el('div', 'stale-note');
  const go = el('button', 'go y');

  body.append(question);
  if (picker) body.append(picker);
  body.append(sides, amt, chips, ticket, extra, stale, go);

  const grip = el('div', 'grip');
  grip.title = 'Drag to resize';
  const egrip = el('div', 'egrip');
  egrip.title = 'Drag to resize';

  card.append(head, body, egrip, grip);
  wrap.appendChild(card);

  n = {
    root: card,
    question,
    yesPx,
    noPx,
    yesBtn,
    noBtn,
    amtInput,
    chips,
    ticket,
    go,
    star,
    extra,
    picker,
    pickerLabel,
    wrapEl: card,
    stale,
  };

  // events
  head.addEventListener('mousedown', (e) => drag(e as MouseEvent, card));
  collapse.addEventListener('click', () => {
    collapsed = true;
    structureKey = '';
    rebuild();
  });
  star.addEventListener('click', () => void toggleWatch());
  pin.addEventListener('click', () => void togglePin(pin));
  question.addEventListener('click', () => window.open(location.href, '_blank', 'noopener'));
  yesBtn.addEventListener('click', () => pickSide('yes'));
  noBtn.addEventListener('click', () => pickSide('no'));
  amtInput.addEventListener('input', () => {
    amount = Number(amtInput.value) || 0;
    // Scale the existing quote immediately so Cost / If it wins track the
    // keystroke, then let the debounced real quote correct it. Waiting 200ms
    // to move a number you are actively typing feels broken.
    if (quote && quote.cost > 0 && amount > 0) {
      const k = amount / quote.cost;
      paintProvisional(quote.qty * k, amount, quote.maxPayout * k);
    }
    requestQuote();
  });
  go.addEventListener('click', () => void place());
  grip.addEventListener('mousedown', (e) => resize(e as MouseEvent, card));
  egrip.addEventListener('mousedown', (e) => resize(e as MouseEvent, card));
  // Close the dropdown on an outside click without a document-wide listener war.
  card.addEventListener('click', (e) => {
    if (picker && !picker.contains(e.target as Node)) picker.classList.remove('open');
  });

  buildChips();
  paint();
}

function buildChips(): void {
  if (!n) return;
  n.chips.textContent = '';

  // Percent mode sizes against the live bankroll, so the presets mean the same
  // thing whether you are up or down — which is the point of position sizing.
  const percent = settings?.quickMode === 'percent';
  const bankroll = pnl?.equity ?? 10000;
  const values = percent
    ? (settings?.quickPercents ?? [1, 2, 5, 10]).map((p) => Math.max(1, Math.round((bankroll * p) / 100)))
    : (settings?.quickAmounts ?? [25, 50, 100, 250]);
  const labels = percent
    ? (settings?.quickPercents ?? [1, 2, 5, 10]).map((p) => `${p}%`)
    : values.map((v) => String(v));

  values.slice(0, 4).forEach((v, i) => {
    const b = el('button', 'chip', labels[i] ?? String(v));
    b.title = percent ? `${labels[i]} of your P$${bankroll.toFixed(0)} balance` : `P$${v}`;
    b.addEventListener('click', () => {
      amount = v;
      n!.amtInput.value = String(v);
      playSound('tick', settings?.soundVolume ?? 0.35, settings?.soundEnabled ?? true);
      requestQuote();
    });
    n!.chips.appendChild(b);
  });
}

function pickSide(o: 'yes' | 'no'): void {
  outcome = o;
  playSound('tick', settings?.soundVolume ?? 0.35, settings?.soundEnabled ?? true);
  paint(); // instant, no rebuild
  requestQuote();
}

/** Rebuild only when the STRUCTURE changes; otherwise paint. */
function rebuild(): void {
  const key = `${collapsed ? 'pill' : 'panel'}:${meta?.venueMarketId ?? ''}:${market?.siblings.length ?? 0}`;
  if (key === structureKey && (n || pn)) {
    paint();
    return;
  }
  structureKey = key;
  if (collapsed) buildPill();
  else buildPanel();
  paint();
}

// ── paint (runs on every tick; touches only what changed) ───────────────────

function paint(): void {
  if (collapsed) {
    if (!pn) return;
    const px = outcome === 'yes' ? live.yes : live.no;
    pn.px.set(cents(px, meta?.tickCents ?? 1));
    pn.label.textContent = outcome === 'yes' ? 'YES' : 'NO';
    if (pnl) {
      pn.pnl.set(money(pnl.delta));
      pn.pnl.el.className = `odo ${pnl.delta >= 0 ? 'up' : 'down'}`;
    }
    // Last five resolved markets as dots. Ambient: you read your recent form
    // without opening anything.
    if (pn.streak.children.length !== streak.length) {
      pn.streak.textContent = '';
      for (const won of streak) {
        const b = el('b', won ? 'w' : 'l');
        pn.streak.appendChild(b);
      }
    }
    return;
  }

  if (!n || !meta) return;

  if (n.question.textContent !== meta.question) n.question.textContent = meta.question;
  if (n.pickerLabel) n.pickerLabel.textContent = meta.question;

  n.yesPx.set(cents(live.yes, meta.tickCents));
  n.noPx.set(cents(live.no, meta.tickCents));
  n.yesBtn.dataset.on = outcome === 'yes' ? '1' : '0';
  n.noBtn.dataset.on = outcome === 'no' ? '1' : '0';
  n.star.textContent = watched ? '★' : '☆';
  n.star.classList.toggle('on', watched);

  // Ticket rows are rewritten as text only — the row elements persist, so
  // nothing reflows and the panel never jumps height mid-poll.
  const rows: [string, string, string?][] = quote
    ? [
        ['Avg fill', `${quote.avgPrice.toFixed(1)}¢`],
        ['You get', `${quote.qty.toLocaleString()} ${quote.unitNoun}`],
        ['Cost', `P$${quote.totalCost.toFixed(2)}`, 'lead'],
        ['If it wins', `+P$${quote.maxProfit.toFixed(2)}`, 'big'],
        ...(quote.partial
          ? ([['Partial fill', 'book ran out', 'warn']] as [string, string, string][])
          : []),
      ]
    : quoteError
      ? ([['Can’t price this', quoteError, 'warn']] as [string, string, string][])
      : [];
  syncRows(n.ticket, rows);

  const extras: [string, string, string?][] = [];
  if (live.spread != null) {
    extras.push([
      live.spread >= 4 ? 'Spread ⓘ' : 'Spread',
      `${live.spread.toFixed(1)}¢`,
      live.spread >= 4 ? 'warn' : undefined,
    ]);
  }
  // Depth of the ladder THIS order eats, which is the quote's own number.
  //
  // The panel used to compute it from `book.yes.asks` no matter what you were
  // buying. Buying NO consumes the NO asks, so on a 1c/99c market the figure
  // shown belonged to a completely different ladder — that is how a ticket
  // could read "book ran out" beside eight figures of visible depth.
  const depth = quote?.visibleDepth ?? null;
  if (depth != null) extras.push(['Visible depth', `P$${Math.round(depth).toLocaleString()}`]);
  if (pnl) extras.push(['Your balance', `P$${pnl.equity.toFixed(2)}`]);
  syncRows(n.extra, expanded ? extras : []);

  paintStaleness();

  n.go.className = `go ${busy ? 'pending' : outcome === 'yes' ? 'y' : 'n'}`;
  n.go.disabled = busy || !quote;
  const label = busy ? 'Placing…' : `Buy ${outcome.toUpperCase()}`;
  if (n.go.textContent !== label) n.go.textContent = label;
}

/**
 * Optimistic ticket while the user is still typing.
 *
 * Linear scaling of the last real quote — accurate enough for the tenth of a
 * second before the true walk returns, and explicitly overwritten by it. Never
 * used to price a fill.
 */
function paintProvisional(qty: number, cost: number, payout: number): void {
  if (!n) return;
  syncRows(n.ticket, [
    ['Avg fill', quote ? `${quote.avgPrice.toFixed(1)}¢` : '--'],
    ['You get', `${Math.round(qty).toLocaleString()} ${quote?.unitNoun ?? ''}`],
    ['Cost', `P$${cost.toFixed(2)}`, 'lead'],
    ['If it wins', `+P$${(payout - cost).toFixed(2)}`, 'big'],
  ]);
}

/** Reconcile a list of label/value rows without discarding existing nodes. */
function syncRows(host: HTMLElement, rows: [string, string, string?][]): void {
  while (host.children.length > rows.length) host.lastElementChild!.remove();
  rows.forEach(([k, v, cls], i) => {
    let row = host.children[i] as HTMLDivElement | undefined;
    if (!row) {
      row = el('div', 'r');
      row.append(el('span'), el('span', 'num'));
      host.appendChild(row);
    }
    row.className = `r ${cls === 'big' ? 'big' : cls === 'lead' ? 'lead' : ''}`;
    const [a, b] = row.children as unknown as [HTMLSpanElement, HTMLSpanElement];
    if (a.textContent !== k) a.textContent = k;
    if (b.textContent !== v) b.textContent = v;
    a.className = cls === 'warn' ? 'warn' : '';
    b.className = cls === 'warn' ? 'warn num' : 'num';
  });
}

// ── interaction ─────────────────────────────────────────────────────────────

function drag(e: MouseEvent, node: HTMLElement): void {
  if ((e.target as HTMLElement).closest('button.ico')) return;
  if (!wrap) return;
  const r = wrap.getBoundingClientRect();
  const dx = e.clientX - r.left;
  const dy = e.clientY - r.top;
  let moved = false;

  const move = (ev: MouseEvent) => {
    if (!wrap) return;
    moved = true;
    wrap.style.left = `${Math.max(0, Math.min(innerWidth - r.width, ev.clientX - dx))}px`;
    wrap.style.top = `${Math.max(0, Math.min(innerHeight - 44, ev.clientY - dy))}px`;
    wrap.style.bottom = 'auto';
  };
  const up = () => {
    removeEventListener('mousemove', move);
    removeEventListener('mouseup', up);
    if (moved) lastDragEnd = Date.now();
    if (moved && wrap) {
      dockToEdge();
      const b = wrap.getBoundingClientRect();
      void send({ type: 'SET_SETTINGS', patch: { overlayPosition: { x: b.left, y: b.top } } }).catch(
        () => undefined,
      );
    }
  };
  addEventListener('mousemove', move);
  addEventListener('mouseup', up);
  e.preventDefault();
  void node;
}

/**
 * Snap to whichever edge the panel was released nearest.
 *
 * Docking keeps it out of the way of the page's own content instead of
 * floating over the middle of it. Only snaps within 40px, so a deliberate
 * mid-screen placement is respected.
 */
function dockToEdge(): void {
  if (!wrap) return;
  const r = wrap.getBoundingClientRect();
  const SNAP = 40;
  const M = 16;
  let { left, top } = r;

  if (r.left < SNAP) left = M;
  else if (innerWidth - r.right < SNAP) left = innerWidth - r.width - M;
  if (r.top < SNAP) top = M;
  else if (innerHeight - r.bottom < SNAP) top = innerHeight - r.height - M;

  if (left !== r.left || top !== r.top) {
    wrap.style.transition = 'left .18s cubic-bezier(.2,.8,.2,1), top .18s cubic-bezier(.2,.8,.2,1)';
    wrap.style.left = `${Math.max(0, left)}px`;
    wrap.style.top = `${Math.max(0, top)}px`;
    setTimeout(() => wrap && (wrap.style.transition = ''), 220);
  }
}

function resize(e: MouseEvent, card: HTMLElement): void {
  const startX = e.clientX;
  const startW = card.getBoundingClientRect().width;

  const move = (ev: MouseEvent) => {
    // Floor at 264px: below that the side buttons and the amount box start
      // colliding. Ceiling at 560px so it never dominates the host page.
      const w = Math.max(264, Math.min(560, startW + (ev.clientX - startX)));
    card.style.setProperty('--w', `${w}px`);
    overlayWidth = w;
    expanded = w > 380;
    card.classList.toggle('wide', expanded);
    paint();
  };
  const up = () => {
    removeEventListener('mousemove', move);
    removeEventListener('mouseup', up);
    void send({ type: 'SET_SETTINGS', patch: { overlayWidth: Math.round(overlayWidth) } }).catch(
      () => undefined,
    );
  };
  addEventListener('mousemove', move);
  addEventListener('mouseup', up);
  e.preventDefault();
  e.stopPropagation();
}

// ── data ────────────────────────────────────────────────────────────────────

/**
 * True while a book request is outstanding.
 *
 * Without this, a slow venue turned a 1s interval into a queue: the tick fires
 * regardless of whether the last one came back, so a few 500ms responses in a
 * row leave several requests in flight at once, which earns more rate limiting,
 * which makes them slower still. Skipping a tick is free; piling on is not.
 */
let bookInFlightSince = 0;

async function refreshBook(): Promise<void> {
  // The guard expires. A flag with no deadline is a flag that can wedge: if a
  // message to the worker never settles, "already in flight" stays true and
  // every later tick returns immediately, so the price on screen freezes for
  // good with nothing to say why. Past the deadline we start a new one.
  const inFlight = bookInFlightSince > 0 && Date.now() - bookInFlightSince < POLL_MS * 3;
  if (!meta || collapsed || inFlight) return;
  bookInFlightSince = Date.now();
  try {
    const { book } = await send<{
      book: { yes: { bids: [number, number][]; asks: [number, number][] } };
    }>({ type: 'GET_BOOK', meta });

    const bid = book.yes.bids[0]?.[0] ?? null;
    const ask = book.yes.asks[0]?.[0] ?? null;
    const mid = bid != null && ask != null ? (bid + ask) / 2 : (bid ?? ask);

    live = {
      yes: mid,
      no: mid == null ? null : 100 - mid,
      spread: bid != null && ask != null ? ask - bid : null,
      at: Date.now(),
      misses: 0,
    };
    paint();
  } catch {
    // A single dropped poll is normal and not worth a word. A run of them is
    // the thing that used to look like the extension had quietly died: the
    // last good price stayed on screen forever with nothing to say it was old.
    live.misses++;
    paintStaleness();
  } finally {
    bookInFlightSince = 0;
  }
}

/**
 * Say so when the price on screen is not live any more.
 *
 * Deliberately not an error card. Nothing is broken — the venue is rate
 * limiting us or the tab lost connectivity — and the number is still the last
 * true one. It just stops pretending to be current.
 */
function paintStaleness(): void {
  if (!n || collapsed) return;
  const age = live.at == null ? Infinity : Date.now() - live.at;
  const stale = live.misses >= 3 || age > STALE_AFTER_MS;
  n.wrapEl.classList.toggle('stale', stale && live.at != null);
  const secs = Number.isFinite(age) ? Math.round(age / 1000) : 0;
  const msg = live.at == null ? 'Waiting for the first price…' : `Last price ${secs}s ago`;
  if (n.stale.textContent !== msg) n.stale.textContent = msg;
}

async function refreshPnl(): Promise<void> {
  try {
    const s = await send<{ equity: number; startingBalance: number; recentResults?: boolean[] }>({
      type: 'GET_SUMMARY',
    });
    pnl = { equity: s.equity, delta: s.equity - s.startingBalance };
    streak = s.recentResults ?? [];
    // Percent presets are relative to the bankroll, so they move with it.
    if (settings?.quickMode === 'percent' && n) buildChips();
    paint();
  } catch {
    /* non-fatal */
  }
}

function startPolling(): void {
  clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (document.hidden) return; // never burn API budget in a background tab
    void refreshBook();
    void refreshPnl();
    // Re-quote whenever there is a size, NOT only when a quote already exists.
    //
    // The old `if (quote && …)` was a one-way door. Any failed quote — and a
    // successful order, which clears it — set `quote` to null, and from then on
    // this line never fired again: no requote, Buy stayed disabled, and the
    // ticket sat frozen until the user retyped the amount. It also meant a
    // quote that had gone stale could never renew itself, which is why placing
    // an order came back "your quote expired".
    if (amount > 0 && !busy) requestQuote(true);
  }, POLL_MS) as unknown as number;
}

/**
 * Why the last quote failed, shown in the ticket instead of as a toast.
 *
 * Now that the poll re-quotes every second, a standing problem — a size bigger
 * than the book, a market that just closed — would pop a toast every few
 * seconds forever. The reason belongs where the numbers would have been: it
 * stays visible, explains the disabled Buy button, and says itself once.
 */
let quoteError: string | null = null;

/**
 * Price the current ticket. Resolves with the quote so callers that need one
 * *now* — placing an order — can await it rather than hoping the poll has run.
 *
 * `silent` is for the poll: it updates the inline reason but never interrupts.
 */
async function fetchQuote(opts: { silent?: boolean } = {}): Promise<QuoteResult | null> {
  if (!meta || !(amount > 0)) {
    quote = null;
    quoteError = null;
    paint();
    return null;
  }
  try {
    quote = await send<QuoteResult>({
      type: 'QUOTE',
      meta,
      side: 'buy',
      outcome,
      notional: amount,
    });
    quoteError = null;
    paint();
    return quote;
  } catch (e) {
    const err = e as Error & { code?: string; detail?: string };
    quote = null;
    quoteError = friendlyError(err.code, err.message, err.detail);
    paint();
    if (!opts.silent) showError(err);
    return null;
  }
}

function requestQuote(silent = false): void {
  clearTimeout(quoteTimer);
  if (!meta || !(amount > 0)) {
    quote = null;
    quoteError = null;
    paint();
    return;
  }
  // Debounced so typing a size does not fire a quote per keystroke.
  quoteTimer = setTimeout(() => void fetchQuote({ silent }), 200) as unknown as number;
}

/**
 * How old a quote may be before placing on it is asking for a rejection.
 *
 * The engine expires quotes at 10s, on purpose: a fill has to be priced off
 * something recent. But the user pressing Buy is not the moment to discover
 * that — so past this age we quietly fetch a fresh one first and place on
 * that. Nothing is loosened by this. The new quote walks a new book, and the
 * fill still walks a book fetched after it, with the same 2% price-moved
 * guard. It only removes a failure the user could do nothing about.
 */
const REQUOTE_BEFORE_PLACE_MS = 3500;

let lastErrorAt = 0;
function showError(e: Error & { code?: string; detail?: string }): void {
  if (Date.now() - lastErrorAt < 3000) return; // a 1s poll must not spam
  lastErrorAt = Date.now();
  toast(friendlyError(e.code, e.message, e.detail), 'bad', 4200);
}

/**
 * Pin the current market so the popup keeps showing it on other pages.
 *
 * Unpinning is the same button, so there is no way to strand yourself with a
 * pinned market you cannot reach.
 */
async function togglePin(btn: HTMLElement): Promise<void> {
  if (!meta) return;
  const on = !pinned;
  pinned = on;
  btn.classList.toggle('on', on);
  try {
    await send({
      type: 'SET_SETTINGS',
      patch: { pinnedMarket: on ? { meta, url: location.href } : null },
    });
    toast(on ? 'Pinned — this market follows you now' : 'Unpinned', 'ok', 1900);
  } catch {
    pinned = !on;
    btn.classList.toggle('on', pinned);
  }
}

async function toggleWatch(): Promise<void> {
  if (!meta) return;
  watched = !watched;
  paint(); // optimistic: the star flips on the click, not on the round-trip
  try {
    const { watched: now } = await send<{ watched: boolean }>({
      type: 'TOGGLE_WATCH',
      meta,
      mid: live.yes,
      // The page you were on IS the correct link. Reconstructing one from a
      // conditionId or a series ticker produced 404s, because neither is the
      // slug the venue routes on.
      sourceUrl: location.href,
    });
    watched = now;
    paint();
    toast(now ? 'Saved to your watchlist' : 'Removed from watchlist', 'ok', 1800);
  } catch {
    watched = !watched;
    paint();
  }
}

/**
 * Offer to reverse a fill for ten seconds.
 *
 * Sells back the exact quantity at the exact fill price, so a mis-tap is free.
 * Deliberately short: beyond a few seconds you are not undoing a mistake, you
 * are asking for a risk-free option on the market moving, and that is the one
 * thing a simulator must not hand out.
 */
function offerUndo(order: { id: string; qtyFilled: number; avgPrice: number }): void {
  if (!shadow || !toastHost || !meta) return;

  const el2 = document.createElement('div');
  el2.className = 'toast undo';
  const label = el('span');
  label.textContent = 'Order placed';
  const btn = el('button', 'undobtn', 'Undo');
  const bar = el('span', 'undobar');
  el2.append(label, btn, bar);
  toastHost.appendChild(el2);

  let done = false;
  const close = () => {
    if (done) return;
    done = true;
    el2.classList.add('out');
    setTimeout(() => el2.remove(), 220);
  };

  btn.addEventListener('click', async () => {
    if (done || !meta) return;
    btn.disabled = true;
    btn.textContent = 'Undoing…';
    try {
      await send({ type: 'UNDO_ORDER', orderId: order.id, meta });
      close();
      toast('Order reversed — nothing was charged', 'ok', 2400);
      void refreshPnl();
    } catch (e) {
      btn.disabled = false;
      btn.textContent = 'Undo';
      showError(e as Error);
    }
  });

  setTimeout(close, 10_000);
}

async function place(): Promise<void> {
  if (!quote || !meta || busy) return;
  busy = true;
  paint(); // instant; the 250ms latency replay is deliberate, the UI lag was not
  const done = toast('Placing your order…', 'pending');

  try {
    // Refresh a quote that is about to expire, instead of submitting it and
    // being told no. The debounced poll can leave one a few seconds old, and
    // the user pressing Buy meant "buy at roughly what I see" — not "buy only
    // if the last poll happened to land recently".
    const age = Date.now() - new Date(quote.quotedAt).getTime();
    if (age > REQUOTE_BEFORE_PLACE_MS) {
      clearTimeout(quoteTimer);
      const fresh = await fetchQuote();
      if (!fresh) return; // fetchQuote already surfaced why
      quote = fresh;
    }

    const { order } = await send<{
      order: { id: string; status: string; qtyFilled: number; avgPrice: number };
    }>(
      { type: 'SUBMIT', meta, quote },
    );
    done();
    playSound(order.status === 'partial' ? 'partial' : 'fill', settings?.soundVolume ?? 0.35, settings?.soundEnabled ?? true);
    toast(
      `${order.status === 'partial' ? 'Partly filled' : 'Filled'} — ${order.qtyFilled.toLocaleString()} at ${order.avgPrice.toFixed(1)}¢`,
      'ok',
      3200,
    );
    confetti();
    quote = null;
    void refreshPnl();

    // Ten-second undo. Closes the position at the SAME price it filled at, so
    // a misclick costs nothing — after that it is a real trade and stands.
    offerUndo(order);
  } catch (e) {
    done();
    playSound('reject', settings?.soundVolume ?? 0.35, settings?.soundEnabled ?? true);
    showError(e as Error);
  } finally {
    busy = false;
    paint();
    requestQuote();
  }
}

// ── mount / navigation ──────────────────────────────────────────────────────

function mount(): void {
  if (document.getElementById(HOST_ID)) return;
  const host = document.createElement('div');
  host.id = HOST_ID;
  shadow = host.attachShadow({ mode: 'closed' });

  const style = document.createElement('style');
  style.textContent = CSS;
  shadow.appendChild(style);

  wrap = el('div', 'wrap');
  shadow.appendChild(wrap);
  document.body.appendChild(host);

  const saved = settings?.overlayPosition;
  if (saved) {
    wrap.style.left = `${saved.x}px`;
    wrap.style.top = `${saved.y}px`;
  } else {
    wrap.style.left = '20px';
    wrap.style.bottom = '20px';
  }
}

function unmount(): void {
  clearInterval(pollTimer);
  document.getElementById(HOST_ID)?.remove();
  shadow = null;
  wrap = null;
  toastHost = null;
  n = null;
  pn = null;
  structureKey = '';
  quote = null;
  quoteError = null;
}

async function sync(): Promise<void> {
  let next: ResolvedMarket | null = null;
  try {
    next = await send<ResolvedMarket | null>({ type: 'RESOLVE_URL', url: location.href });
  } catch {
    next = null;
  }

  // No market on this page? Fall back to the pinned one, if there is one.
  // That is the whole point of pinning: keep one market in view while you
  // browse elsewhere on the venue.
  if (!next && settings?.pinnedMarket) {
    const p = settings.pinnedMarket as { meta: MarketMeta };
    if (p.meta) {
      meta = p.meta;
      market = { meta: p.meta, siblings: [{ meta: p.meta, mid: null }] };
      pinned = true;
      mount();
      rebuild();
      void refreshBook();
      void refreshPnl();
      requestQuote();
      startPolling();
      return;
    }
  }

  if (!next) {
    market = null;
    meta = null;
    unmount();
    return;
  }

  pinned =
    !!settings?.pinnedMarket &&
    (settings.pinnedMarket as { meta?: MarketMeta }).meta?.venueMarketId === next.meta.venueMarketId;

  const changed = next.meta.venueMarketId !== meta?.venueMarketId;
  market = next;
  if (changed) {
    meta = next.meta;
    quote = null;
    quoteError = null;
    live = { yes: null, no: null, spread: null, at: null, misses: 0 };
    try {
      watched = await send<boolean>({ type: 'WATCH_HAS', meta: next.meta });
    } catch {
      watched = false;
    }
  }

  mount();
  rebuild();
  if (changed) {
    void refreshBook();
    void refreshPnl();
    requestQuote();
  }
  startPolling();
}

/**
 * Keyboard trading.
 *
 * Y/N pick a side, Enter places, Esc minimises.
 *
 * Number keys deliberately do NOT change your size any more: a stray digit
 * silently resizing a live order is the kind of shortcut that loses money.
 * With double-tap enabled, pressing the same side twice within 400ms places —
 * fast, without being reachable by accident.
 *
 * All of it stays inert while the host page has focus in a text field, because
 * hijacking a keystroke meant for the venue's own search box would be hostile.
 */
function bindKeys(): void {
  addEventListener(
    'keydown',
    (e) => {
      if (!meta || collapsed || !settings?.keyboardTrading) return;
      // composedPath()[0], not e.target.
      //
      // Our UI lives in a CLOSED shadow root, and the DOM retargets events
      // crossing that boundary: at document level e.target is the host <div>,
      // never the <input> inside it. So the "is the user typing?" check always
      // read false and Y/N got hijacked mid-word in the outcome search box.
      const t = (e.composedPath?.()[0] ?? e.target) as HTMLElement | null;
      const typing =
        !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      // Our own amount box is an input, so Enter still places from there.
      const ours = t === n?.amtInput;
      if (typing && !ours) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const k = e.key.toLowerCase();
      if ((k === 'y' || k === 'n') && !ours) {
        e.preventDefault();
        const picked = k === 'y' ? 'yes' : 'no';
        const now = Date.now();
        const doubleTap =
          settings.doubleTapToPlace && lastSideKey === picked && now - lastSideKeyAt < 400;
        lastSideKey = picked;
        lastSideKeyAt = now;
        if (doubleTap && quote && !busy) void place();
        else pickSide(picked);
      }
      else if (e.key === 'Enter' && quote && !busy) {
        e.preventDefault();
        void place();
      } else if (e.key === 'Escape') {
        collapsed = true;
        structureKey = '';
        rebuild();
      }
    },
    true,
  );
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
  // Hyperliquid addresses an outcome market as /trade/#10250 — the coin is a
  // URL FRAGMENT, so switching markets fires neither pushState nor popstate.
  // Without this, the panel would keep showing the first market you opened.
  addEventListener('hashchange', fire);
  new MutationObserver(fire).observe(document.body, { childList: true, subtree: false });
  addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      void refreshBook();
      void refreshPnl();
    }
  });
}

async function boot(attempt = 0): Promise<void> {
  try {
    settings = await send<Settings>({ type: 'GET_SETTINGS' });
  } catch {
    // The service worker sleeps after ~30s and takes a moment to wake. The old
    // code gave up silently here, which is why the popup "sometimes" did not
    // appear — it was whenever the worker happened to be cold. Retry with
    // backoff instead of losing the page load.
    if (attempt < 6) {
      setTimeout(() => void boot(attempt + 1), 300 * 2 ** attempt);
    }
    return;
  }
  if (!settings.overlayEnabled) return;
  amount = settings.defaultOrderSize || 100;
  overlayWidth = settings.overlayWidth ?? 300;
  expanded = overlayWidth > 380;
  watchNav();
  bindKeys();
  await sync();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => void boot());
} else {
  void boot();
}
