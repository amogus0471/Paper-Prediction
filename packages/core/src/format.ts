import { roundTo } from './decimal';

/**
 * Formatters. Every number in the UI goes through one of these.
 *
 * All output is tabular-safe: fixed decimal places so digits line up in a
 * column when rendered in a mono font with tabular figures. Prices are always
 * cents, money is always dollars — the split both venues' UIs converged on.
 */

/** `63c` / `4.5c`. Sub-cent precision only when the venue actually quotes it. */
export function formatCents(cents: number | null | undefined, dp?: number): string {
  if (cents == null || !Number.isFinite(cents)) return '--';
  const places = dp ?? (Number.isInteger(roundTo(cents, 2)) ? 0 : 1);
  return `${cents.toFixed(places)}¢`;
}

/** Ghost dollars carry a G$ prefix so they can never be mistaken for real money. */
export function formatGhostDollars(usd: number | null | undefined, dp = 2): string {
  if (usd == null || !Number.isFinite(usd)) return '--';
  const sign = usd < 0 ? '-' : '';
  return `${sign}G$${Math.abs(usd).toLocaleString('en-US', {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  })}`;
}

/** Signed money, for P&L. Always shows the sign so gains and losses scan fast. */
export function formatSignedGhostDollars(usd: number | null | undefined, dp = 2): string {
  if (usd == null || !Number.isFinite(usd)) return '--';
  const sign = usd > 0 ? '+' : usd < 0 ? '-' : '';
  return `${sign}G$${Math.abs(usd).toLocaleString('en-US', {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  })}`;
}

export function formatPercent(pct: number | null | undefined, dp = 1): string {
  if (pct == null || !Number.isFinite(pct)) return '--';
  return `${pct.toFixed(dp)}%`;
}

export function formatSignedPercent(pct: number | null | undefined, dp = 1): string {
  if (pct == null || !Number.isFinite(pct)) return '--';
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(dp)}%`;
}

/** Probability 0..1 rendered as the probability chip: `63%`. */
export function formatProbability(p: number | null | undefined): string {
  if (p == null || !Number.isFinite(p)) return '--';
  return `${Math.round(p * 100)}%`;
}

export function formatBps(bps: number | null | undefined): string {
  if (bps == null || !Number.isFinite(bps)) return '--';
  const sign = bps > 0 ? '+' : '';
  return `${sign}${Math.round(bps)} bps`;
}

/** `1.2M`, `847K`, `1,204`. Volume is a trust signal, so it must stay readable. */
export function formatCompact(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '--';
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}K`;
  return Math.round(n).toLocaleString('en-US');
}

export function formatQty(qty: number | null | undefined): string {
  if (qty == null || !Number.isFinite(qty)) return '--';
  return Number.isInteger(qty) ? qty.toLocaleString('en-US') : qty.toFixed(2);
}

/** Brier scores need 3 dp to be meaningful and more than 3 to be noise. */
export function formatScore(v: number | null | undefined, dp = 3): string {
  if (v == null || !Number.isFinite(v)) return '--';
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toFixed(dp)}`;
}

/**
 * Live countdown to market close. Both venues put one on every card because
 * time-to-resolution is half of what a price means.
 */
export function formatCountdown(closeTime: Date | string | null | undefined, now = new Date()): string {
  if (!closeTime) return '--';
  const close = typeof closeTime === 'string' ? new Date(closeTime) : closeTime;
  if (Number.isNaN(close.getTime())) return '--';

  const ms = close.getTime() - now.getTime();
  if (ms <= 0) return 'Closed';

  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);

  if (d > 30) return `${Math.floor(d / 30)}mo`;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

export function formatRelativeTime(ts: Date | string | null | undefined, now = new Date()): string {
  if (!ts) return '--';
  const t = typeof ts === 'string' ? new Date(ts) : ts;
  if (Number.isNaN(t.getTime())) return '--';

  const s = Math.floor((now.getTime() - t.getTime()) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/**
 * Venue-adaptive vocabulary. Polymarket sells "shares", Kalshi sells
 * "contracts". Using the wrong word on a market is a small tell that you did
 * not actually look at the venue.
 */
export function unitNoun(venue: string, qty = 2): string {
  const singular = venue === 'polymarket' ? 'share' : 'contract';
  return qty === 1 ? singular : `${singular}s`;
}

/** Copy for every rejection code. Never ship a generic "order failed". */
export const REJECT_COPY: Record<string, string> = {
  insufficient_funds: 'Not enough ghost cash for this order.',
  market_closed: 'This market has closed.',
  stale_book: "We've lost the live book for this market. Try again shortly.",
  quote_expired: 'Your quote expired. Refreshing…',
  price_moved: 'Price moved while your order was in flight. Requote?',
  size_exceeds_depth:
    "Larger than this market can absorb — in reality you'd move the price against yourself.",
  below_min_size: 'Below the minimum order size for this market.',
  invalid_tick: "That price isn't on this market's tick grid.",
  rate_limited: "Slow down — you're placing orders faster than a human can think.",
  position_limit:
    'This would put more than 20% of your bankroll in one market. Position sizing is the point.',
  no_liquidity: 'There is no visible liquidity on that side of the book right now.',
  resolution_lockout:
    'This market is already priced as a near-certainty. Trading it now would be front-running the result, not forecasting it.',
  duplicate: 'Order already submitted.',
};

export function rejectCopy(code: string, detail?: string): string {
  return detail || REJECT_COPY[code] || 'Order rejected.';
}
