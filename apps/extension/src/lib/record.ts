/**
 * Local calibration, derived from `chrome.storage.local` positions.
 *
 * Everything here is a projection over settled positions — nothing is stored,
 * so the Record screen cannot drift out of step with the trades it describes.
 * The maths itself lives in @polyfill/core (`scoring.ts`, `coaching.ts`) and is
 * the same code the server aggregates run, so a solo player and a leaderboard
 * player are scored identically.
 */

import {
  MIN_N_FOR_CATEGORY,
  calibrationBins,
  diagnose,
  drawdownPct,
  readinessCheck,
  summarizeCalibration,
  worstLosingStreak,
  brierSkillScore,
  brier,
  categoryInsight,
  type CalibrationBin,
  type CalibrationRecord,
  type CalibrationSummary,
  type CategoryEdge,
  type Readiness,
  type Verdict,
} from '@polyfill/core';
import { summarize, type LocalState, type StoredPosition } from './store';

/**
 * A settled position becomes a forecast record only if it was placed in a
 * scoring-eligible realism mode and actually resolved. Instant-mode trades and
 * voided markets are excluded — a void is not a forecast you got wrong.
 */
export function scorablePositions(state: LocalState): StoredPosition[] {
  return state.positions.filter(
    (p) => p.settledAt != null && p.scoringEligible && p.outcomeResult !== undefined,
  );
}

export function toRecords(positions: StoredPosition[]): CalibrationRecord[] {
  return positions.map((p) => ({
    pUser: p.entryPUser,
    pMarket: p.entryPMarket,
    outcome: p.outcomeResult ? 1 : 0,
    category: categoryOf(p),
  }));
}

/**
 * Category for a position.
 *
 * Local positions do not carry the venue's category (the overlay resolves a
 * market without needing it), so this falls back to the venue name. Better a
 * coarse-but-true grouping than a fabricated one.
 */
function categoryOf(p: StoredPosition): string {
  return (p as StoredPosition & { category?: string }).category ?? p.venue;
}

export interface LocalRecord {
  summary: CalibrationSummary;
  bins: CalibrationBin[];
  categories: CategoryEdge[];
  verdict: Verdict;
  insight: string | null;
  readiness: Readiness;
  /** Every settled position, newest first, for the history list. */
  settled: StoredPosition[];
}

export function buildRecord(state: LocalState): LocalRecord {
  const positions = scorablePositions(state);
  const records = toRecords(positions);
  const summary = summarizeCalibration(records);

  // Per-category, computed the same way as the aggregate so the numbers add up.
  const byCategory = new Map<string, CalibrationRecord[]>();
  for (const r of records) {
    const key = r.category ?? 'other';
    const arr = byCategory.get(key);
    if (arr) arr.push(r);
    else byCategory.set(key, [r]);
  }

  const categories: CategoryEdge[] = [...byCategory.entries()]
    .map(([category, rs]) => {
      const bu = mean(rs.map((r) => brier(r.pUser, r.outcome)));
      const bm = mean(rs.map((r) => brier(r.pMarket, r.outcome)));
      return {
        category,
        n: rs.length,
        brierSkill: brierSkillScore(bu, bm),
        reliable: rs.length >= MIN_N_FOR_CATEGORY,
      };
    })
    .sort((a, b) => b.n - a.n);

  const stats = summarize(state);

  // Drawdown from the ledger's own equity path, not a stored field, so it
  // cannot disagree with the balance shown next to it.
  const curve = [...state.transactions].reverse().map((t) => t.balanceAfter);
  let peak = state.startingBalance;
  let maxDd = 0;
  for (const point of curve) {
    if (point > peak) peak = point;
    const dd = drawdownPct(point, peak);
    if (dd > maxDd) maxDd = dd;
  }

  // Settled in chronological order, so a "losing streak" means what it says.
  const chronological = [...positions].sort(
    (a, b) => new Date(a.settledAt!).getTime() - new Date(b.settledAt!).getTime(),
  );

  return {
    summary,
    bins: calibrationBins(records),
    categories,
    verdict: diagnose(summary),
    insight: categoryInsight(categories),
    readiness: readinessCheck({
      calibration: summary,
      categories,
      maxDrawdownPct: maxDd,
      worstLosingStreak: worstLosingStreak(chronological.map((p) => p.outcomeResult === true)),
      returnPct: stats.returnPct,
    }),
    settled: [...positions].sort(
      (a, b) => new Date(b.settledAt!).getTime() - new Date(a.settledAt!).getTime(),
    ),
  };
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}
