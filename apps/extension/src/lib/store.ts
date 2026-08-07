/**
 * Local-first portfolio store.
 *
 * Everything a solo player does lives in chrome.storage.local: no account, no
 * network call to our backend, no row in anyone's database. The tradeoff is
 * honest and worth stating plainly — local state is editable by whoever owns
 * the machine, which is fine for practice and is exactly why the leaderboard
 * runs server-side instead, behind an explicit opt-in.
 *
 * The ledger invariant is the same one the Postgres path asserts:
 *   cash + costBasis(open) - realized == startingBalance
 */

import type { ChainLink, OutcomeSide, OrderSide, SimRealism } from '@polyfill/core';

export const STARTING_BALANCE = 10_000;
const KEY = 'polyfill.v1';
/** Pre-rename storage key. Read once so an existing portfolio survives the rename. */
const LEGACY_KEY = 'ghostfill.v1';

export interface StoredFill {
  price: number;
  qty: number;
  notional: number;
}

export interface StoredOrder {
  id: string;
  ts: string;
  venue: string;
  marketKey: string;
  question: string;
  side: OrderSide;
  outcome: OutcomeSide;
  status: 'filled' | 'partial' | 'rejected';
  rejectCode?: string;
  rejectMessage?: string;
  qtyRequested: number;
  qtyFilled: number;
  avgPrice: number;
  quotedPrice: number;
  cost: number;
  fee: number;
  realized?: number;
  slippageBps: number;
  latencyMs: number;
  realism: SimRealism;
  fills: StoredFill[];
  /** The book this fill was priced against, kept so a price is reconstructible. */
  bookSnapshot: {
    capturedAt: string;
    bids: [number, number][];
    asks: [number, number][];
    mid: number | null;
  };
}

export interface StoredPosition {
  marketKey: string;
  venue: string;
  question: string;
  /** Venue category, frozen at entry — drives the per-category calibration split. */
  category?: string;
  outcome: OutcomeSide;
  qty: number;
  avgEntryPrice: number;
  costBasis: number;
  markPrice: number | null;
  realizedPnl: number;
  feesPaid: number;
  /** Frozen at first entry — the forecast pair that gets scored. */
  entryPUser: number;
  entryPMarket: number;
  entryAt: string;
  scoringEligible: boolean;
  isOpen: boolean;
  closedAt?: string;
  settledAt?: string;
  outcomeResult?: boolean;
  closeTime?: string;
}

export interface StoredTxn {
  id: string;
  ts: string;
  kind: 'grant' | 'fill_debit' | 'fill_credit' | 'fee' | 'settlement' | 'reset';
  amount: number;
  balanceAfter: number;
  memo: string;
}

export interface WatchedMarket {
  marketKey: string;
  venue: string;
  venueMarketId: string;
  question: string;
  category?: string;
  addedAt: string;
  /** Last book mid we saw, so the list renders instantly before a refresh. */
  lastMid: number | null;
  /** The mid before that, so a row can colour its own direction of travel. */
  prevMid?: number | null;
  /** Recent mids for the row's sparkline. Bounded — this lives in storage. */
  history?: number[];
  /** Venue slug, for deep-linking back to the market page. */
  slug?: string;
  /**
   * The exact URL the market was starred from.
   *
   * Authoritative for "Open market". Rebuilding a venue URL from an id is
   * guesswork — Polymarket routes on an EVENT slug while we hold a market
   * conditionId, and a Kalshi series ticker is not a page — and the guesses
   * 404ed. Remembering beats reconstructing.
   */
  sourceUrl?: string;
  lastSeenAt?: string;
  closeTime?: string;
}

export interface Settings {
  realism: SimRealism;
  soundEnabled: boolean;
  soundVolume: number;
  confirmBeforeOrder: boolean;
  defaultOrderSize: number;
  overlayEnabled: boolean;
  overlayPosition: { x: number; y: number } | null;
  sizeMode: 'dollars' | 'contracts';
  /** The four one-tap amounts on the popup. Fully user-editable. */
  quickAmounts: number[];
  confettiEnabled: boolean;
  /** Popup width in px. Dragging the corner grip persists it. */
  overlayWidth: number;
  /** Y/N to pick a side, 1-4 for presets, Enter to place. */
  keyboardTrading: boolean;
  /** Press Y or N twice quickly to place, instead of Enter. */
  doubleTapToPlace: boolean;
  /**
   * Reuse an already-open Polymarket/Kalshi tab instead of spending a cold
   * page load on a new one. Off by default because it navigates a tab you did
   * not explicitly hand over.
   */
  turboMode: boolean;
  /**
   * A market pinned to follow you across pages.
   *
   * When set, the popup shows this market everywhere on a supported venue
   * instead of only on its own page — so you can watch one market while
   * browsing others.
   */
  pinnedMarket: { meta: unknown; url: string } | null;
  /** Set once the alerts walkthrough has been completed or skipped. */
  /**
   * Enforce the 5%-of-visible-depth cap.
   *
   * On, a big order into a thin book is refused. Off, it fills against
   * whatever depth exists and you eat the bad average — which is the honest
   * outcome anyway, just an expensive one. Default OFF so nobody hits a wall
   * they did not ask for; the ladder always enforces it regardless.
   */
  enforceDepthCap: boolean;
  /**
   * Freeze trading once a market is priced as a near-certainty.
   *
   * A game ends at 22:14 and the venue settles at 22:31; in between the price
   * is 99c and the result is already public. Buying there is collecting, not
   * forecasting, so the ladder always blocks it. Solo play does not have to.
   */
  resolutionLockout: boolean;
  /** Quick amounts as a % of bankroll rather than fixed dollars. */
  quickMode: 'dollars' | 'percent';
  quickPercents: number[];
  competeOptIn: boolean;
  deviceKey: string | null;
  handle: string | null;
}

export interface LocalState {
  version: 1;
  createdAt: string;
  cash: number;
  startingBalance: number;
  peakEquity: number;
  resetCount: number;
  positions: StoredPosition[];
  orders: StoredOrder[];
  transactions: StoredTxn[];
  watchlist: WatchedMarket[];
  /**
   * Hash chain over every balance-changing event.
   *
   * Locally this is tamper-EVIDENCE: it proves the record was not edited
   * outside the app, and proves nothing to anyone else — someone who controls
   * the whole history can rebuild a consistent chain from forged numbers. That
   * is precisely why ladder links are minted server-side instead.
   */
  chain: ChainLink[];
  /** Armed market alerts. Evaluated locally on the watchlist refresh. */
  alerts?: import('./alerts').MarketAlert[];
  settings: Settings;
}

export const DEFAULT_SETTINGS: Settings = {
  realism: 'realistic',
  soundEnabled: true,
  soundVolume: 0.35,
  confirmBeforeOrder: false,
  defaultOrderSize: 100,
  overlayEnabled: true,
  overlayPosition: null,
  sizeMode: 'dollars',
  quickAmounts: [25, 50, 100, 250],
  confettiEnabled: true,
  overlayWidth: 300,
  keyboardTrading: true,
  doubleTapToPlace: false,
  turboMode: false,
  pinnedMarket: null,
  enforceDepthCap: false,
  resolutionLockout: false,
  quickMode: 'dollars',
  quickPercents: [1, 2, 5, 10],
  competeOptIn: false,
  deviceKey: null,
  handle: null,
};

export function freshState(): LocalState {
  const now = new Date().toISOString();
  return {
    version: 1,
    createdAt: now,
    cash: STARTING_BALANCE,
    startingBalance: STARTING_BALANCE,
    peakEquity: STARTING_BALANCE,
    resetCount: 0,
    positions: [],
    orders: [],
    watchlist: [],
    transactions: [
      {
        id: crypto.randomUUID(),
        ts: now,
        kind: 'grant',
        amount: STARTING_BALANCE,
        balanceAfter: STARTING_BALANCE,
        memo: 'Opening balance',
      },
    ],
    chain: [],
    alerts: [],
    settings: { ...DEFAULT_SETTINGS },
  };
}

export async function loadState(): Promise<LocalState> {
  const raw = await chrome.storage.local.get([KEY, LEGACY_KEY]);
  let stored = raw[KEY] as LocalState | undefined;

  // Adopt a pre-rename portfolio rather than silently handing someone a fresh
  // P$10,000 and wiping the record they built. Runs once: the next save writes
  // under the new key, and the old one is dropped.
  if (!stored && raw[LEGACY_KEY]) {
    stored = raw[LEGACY_KEY] as LocalState;
    await chrome.storage.local.set({ [KEY]: stored });
    await chrome.storage.local.remove(LEGACY_KEY);
  }

  if (!stored || stored.version !== 1) {
    const fresh = freshState();
    await saveState(fresh);
    return fresh;
  }
  // Merge forward so a settings key added in a later build does not read as
  // undefined on an existing install.
  stored.settings = { ...DEFAULT_SETTINGS, ...stored.settings };
  stored.watchlist ??= [];
  stored.chain ??= [];
  stored.alerts ??= [];
  return stored;
}

export async function saveState(state: LocalState): Promise<void> {
  await chrome.storage.local.set({ [KEY]: state });
}

/**
 * Read-modify-write under a promise chain.
 *
 * chrome.storage has no transactions, and the side panel, the overlay and the
 * service worker can all write. Serialising every mutation through one chain
 * inside the single service-worker context is what stops two concurrent orders
 * from both spending the same sim cash — the local equivalent of the
 * SELECT … FOR UPDATE the Postgres path uses.
 */
let queue: Promise<unknown> = Promise.resolve();

export function mutate<T>(fn: (state: LocalState) => Promise<T> | T): Promise<T> {
  const next = queue.then(async () => {
    const state = await loadState();
    const result = await fn(state);
    await saveState(state);
    return result;
  });
  // Keep the chain alive even if one mutation throws.
  queue = next.catch(() => undefined);
  return next as Promise<T>;
}

/** A stable key for a market across both venues. */
export function marketKey(venue: string, venueMarketId: string): string {
  return `${venue}:${venueMarketId}`;
}

export function findPosition(
  state: LocalState,
  key: string,
  outcome: OutcomeSide,
): StoredPosition | undefined {
  return state.positions.find((p) => p.marketKey === key && p.outcome === outcome && p.isOpen);
}

export function pushTxn(
  state: LocalState,
  kind: StoredTxn['kind'],
  amount: number,
  memo: string,
): void {
  state.cash = round6(state.cash + amount);
  state.transactions.unshift({
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    kind,
    amount: round6(amount),
    balanceAfter: state.cash,
    memo,
  });
  // Keep the ledger bounded; the equity curve only needs the recent window.
  if (state.transactions.length > 1000) state.transactions.length = 1000;
}

export function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

export function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** Portfolio totals, derived rather than stored so they cannot drift. */
export function summarize(state: LocalState) {
  const open = state.positions.filter((p) => p.isOpen);
  const unrealized = open.reduce((s, p) => {
    if (p.markPrice == null) return s;
    return s + (p.qty * p.markPrice) / 100 - p.costBasis;
  }, 0);
  const costBasis = open.reduce((s, p) => s + p.costBasis, 0);
  const equity = round6(state.cash + unrealized + costBasis);
  const settled = state.positions.filter((p) => p.settledAt);
  const filled = state.orders.filter((o) => o.status !== 'rejected');

  return {
    cash: round6(state.cash),
    equity,
    unrealized: round6(unrealized),
    costBasis: round6(costBasis),
    realized: round6(state.positions.reduce((s, p) => s + p.realizedPnl, 0)),
    returnPct:
      state.startingBalance > 0
        ? round2(((equity - state.startingBalance) / state.startingBalance) * 100)
        : 0,
    openCount: open.length,
    settledCount: settled.length,
    tradeCount: filled.length,
    totalFees: round6(filled.reduce((s, o) => s + o.fee, 0)),
    marketsTraded: new Set(filled.map((o) => o.marketKey)).size,
    /**
     * Share of finished positions that made money.
     *
     * Counts anything CLOSED, not only markets that resolved. Waiting for
     * resolution meant this read "--" for days on end — most positions are
     * closed by selling long before the event settles, and a trade you sold at
     * a profit is a win by any reading.
     */
    winRate: (() => {
      const finished = state.positions.filter((p) => !p.isOpen);
      if (finished.length === 0) return null;
      const won = finished.filter((p) =>
        p.settledAt ? p.outcomeResult === true : p.realizedPnl > 0,
      ).length;
      return won / finished.length;
    })(),
    peakEquity: Math.max(state.peakEquity, equity),
    /** Last five resolved markets, newest first — the pill's streak dots. */
    recentResults: settled
      .slice()
      .sort((a, b) => (b.settledAt ?? '').localeCompare(a.settledAt ?? ''))
      .slice(0, 5)
      .map((p) => p.outcomeResult === true),
  };
}

/**
 * The ledger integrity check, run client-side for exactly the same reason the
 * server runs it: a P&L number nobody audits is a P&L number nobody should
 * believe.
 */
export function checkLedger(state: LocalState): { ok: boolean; drift: number } {
  const summed = state.transactions.reduce((s, t) => s + t.amount, 0);
  const drift = round6(state.cash - summed);
  return { ok: Math.abs(drift) < 1e-6, drift };
}
