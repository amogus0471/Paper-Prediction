/**
 * Market alerts.
 *
 * Deliberately narrow: three things a person actually wants to be told about,
 * not a configurable rule engine. Every extra option here is a decision the
 * user has to make before they get any value, and the whole point is that
 * setting one up takes two taps.
 *
 * All evaluation is local, on markets the user already watches, piggybacking
 * the watchlist refresh that already runs. No new polling, no server.
 */

import { loadState, mutate, type LocalState, type WatchedMarket } from './store';

export type AlertKind = 'resolved' | 'moved_up' | 'moved_down' | 'crosses';

export interface MarketAlert {
  id: string;
  marketKey: string;
  question: string;
  kind: AlertKind;
  /** Percentage points for a move, or a price in cents for a crossing. */
  threshold: number;
  /** The price when the alert was armed — moves are measured from here. */
  basePrice: number | null;
  createdAt: string;
  firedAt?: string;
  /** Fire once, then keep the row so the UI can show it happened. */
  oneShot: boolean;
}

export const ALERT_LABELS: Record<AlertKind, string> = {
  resolved: 'Tell me when it resolves',
  moved_up: 'Tell me if it goes up',
  moved_down: 'Tell me if it drops',
  crosses: 'Tell me when it crosses a price',
};

export function describeAlert(a: MarketAlert): string {
  switch (a.kind) {
    case 'resolved':
      return 'When this market resolves';
    case 'moved_up':
      return `If it rises ${a.threshold} points from ${fmt(a.basePrice)}`;
    case 'moved_down':
      return `If it drops ${a.threshold} points from ${fmt(a.basePrice)}`;
    case 'crosses':
      return `When it crosses ${a.threshold}¢`;
  }
}

function fmt(p: number | null): string {
  return p == null ? '--' : `${Math.round(p)}¢`;
}

export async function addAlert(
  w: WatchedMarket,
  kind: AlertKind,
  threshold: number,
): Promise<MarketAlert> {
  const alert: MarketAlert = {
    id: crypto.randomUUID(),
    marketKey: w.marketKey,
    question: w.question,
    kind,
    threshold,
    basePrice: w.lastMid ?? null,
    createdAt: new Date().toISOString(),
    oneShot: true,
  };
  await mutate((s) => {
    s.alerts ??= [];
    s.alerts.unshift(alert);
    // Bounded: this lives in chrome.storage and nobody needs 200 alerts.
    if (s.alerts.length > 50) s.alerts.length = 50;
  });
  return alert;
}

export async function removeAlert(id: string): Promise<void> {
  await mutate((s) => {
    s.alerts = (s.alerts ?? []).filter((a) => a.id !== id);
  });
}

export function alertsFor(state: LocalState, marketKey: string): MarketAlert[] {
  return (state.alerts ?? []).filter((a) => a.marketKey === marketKey);
}

/**
 * Evaluate every armed alert against the latest watchlist prices.
 *
 * Called from the same alarm that refreshes the watchlist, so alerts cost no
 * extra network at all.
 */
export async function evaluateAlerts(): Promise<number> {
  const state = await loadState();
  const alerts = (state.alerts ?? []).filter((a) => !a.firedAt);
  if (alerts.length === 0) return 0;

  const byKey = new Map(state.watchlist.map((w) => [w.marketKey, w]));
  const settled = new Map(
    state.positions.filter((p) => p.settledAt).map((p) => [p.marketKey, p]),
  );

  const fired: { alert: MarketAlert; title: string; body: string }[] = [];

  for (const a of alerts) {
    const w = byKey.get(a.marketKey);
    const price = w?.lastMid ?? null;

    if (a.kind === 'resolved') {
      const pos = settled.get(a.marketKey);
      if (pos) {
        fired.push({
          alert: a,
          title: 'Market resolved',
          body: `${short(a.question)} — you ${pos.outcomeResult ? 'won' : 'lost'} this one.`,
        });
      }
      continue;
    }

    if (price == null || a.basePrice == null) continue;
    const delta = price - a.basePrice;

    if (a.kind === 'moved_up' && delta >= a.threshold) {
      fired.push({
        alert: a,
        title: 'Price moved up',
        body: `${short(a.question)} — now ${Math.round(price)}¢, up ${Math.round(delta)} points.`,
      });
    } else if (a.kind === 'moved_down' && -delta >= a.threshold) {
      fired.push({
        alert: a,
        title: 'Price dropped',
        body: `${short(a.question)} — now ${Math.round(price)}¢, down ${Math.round(-delta)} points.`,
      });
    } else if (a.kind === 'crosses') {
      // Crossing means passing THROUGH the level, in either direction, so
      // arming one just above the current price does not fire immediately.
      const wasBelow = a.basePrice < a.threshold;
      const isBelow = price < a.threshold;
      if (wasBelow !== isBelow) {
        fired.push({
          alert: a,
          title: 'Price crossed your level',
          body: `${short(a.question)} — now ${Math.round(price)}¢.`,
        });
      }
    }
  }

  if (fired.length === 0) return 0;

  const now = new Date().toISOString();
  await mutate((s) => {
    for (const f of fired) {
      const row = (s.alerts ?? []).find((x) => x.id === f.alert.id);
      if (row) row.firedAt = now;
    }
  });

  for (const f of fired) {
    try {
      chrome.notifications?.create?.(f.alert.id, {
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: f.title,
        message: f.body,
      });
    } catch {
      // Notifications are a nicety; never let one break the sweep.
    }
  }

  return fired.length;
}

function short(q: string): string {
  return q.length > 64 ? `${q.slice(0, 61)}…` : q;
}
