import { clamp, roundTo } from './decimal';

/**
 * Calibration scoring — the thing that makes Ghostfill more than a toy.
 *
 * P&L tells you whether you got lucky. A Brier Skill Score against the market's
 * own price tells you whether you were *right*: did the forecast you paid for
 * beat the forecast the market was already offering for free?
 *
 * Statistical honesty is a hard requirement here. Every function that can
 * produce a misleading number at low n returns the n alongside it so the UI can
 * refuse to render.
 */

/** Minimum resolved positions before a Brier Skill Score may be displayed at all. */
export const MIN_N_FOR_BSS = 30;
/** Minimum resolved positions before a per-category breakdown is trustworthy. */
export const MIN_N_FOR_CATEGORY = 20;

/** Brier score for a single binary forecast. Lower is better; 0 is perfect. */
export function brier(p: number, outcome: 0 | 1): number {
  const pc = clamp(p, 0, 1);
  return roundTo((pc - outcome) ** 2, 8);
}

/** Logarithmic score. Punishes confident wrongness far harder than Brier does. */
export function logScore(p: number, outcome: 0 | 1): number {
  const eps = 1e-9;
  const pc = clamp(p, eps, 1 - eps);
  return roundTo(-Math.log(outcome === 1 ? pc : 1 - pc), 8);
}

/**
 * Brier Skill Score: how much better than the reference forecast you were.
 * > 0 means you beat the market. 0 means you were the market. < 0 means you
 * paid a spread to be worse than a free price.
 */
export function brierSkillScore(brierUser: number, brierReference: number): number | null {
  if (!(brierReference > 0)) return null;
  return roundTo(1 - brierUser / brierReference, 6);
}

/** Signed edge in basis points: how far your price sat from the market's. */
export function edgeBps(pUser: number, pMarket: number): number {
  return roundTo((pMarket - pUser) * 10000, 4);
}

export interface CalibrationRecord {
  pUser: number;
  pMarket: number;
  outcome: 0 | 1;
  category?: string;
  notional?: number;
}

export interface CalibrationBin {
  bin: number;
  /** Bin midpoint, e.g. 0.05, 0.15, ... */
  binMid: number;
  n: number;
  /** Mean forecast probability inside the bin. */
  meanPredicted: number;
  /** Observed frequency inside the bin. Perfect calibration puts this on y=x. */
  observedFrequency: number;
}

export interface MurphyDecomposition {
  /** Miscalibration. Lower is better. */
  reliability: number;
  /** Discrimination — how far your forecasts move from the base rate. Higher is better. */
  resolution: number;
  /** Irreducible difficulty of the questions you picked. Not a skill term. */
  uncertainty: number;
  /** reliability - resolution + uncertainty, which reconstructs the Brier score. */
  brier: number;
}

export interface CalibrationSummary {
  n: number;
  brierUser: number;
  brierMarket: number;
  brierSkill: number | null;
  /** 95% CI on the skill score. Null below MIN_N_FOR_BSS — never fake precision. */
  ciLow: number | null;
  ciHigh: number | null;
  baseRate: number;
  bins: CalibrationBin[];
  murphy: MurphyDecomposition;
  /** True once there is enough data to show the score without misleading anyone. */
  displayable: boolean;
  meanEdgeBps: number;
}

const EMPTY_MURPHY: MurphyDecomposition = { reliability: 0, resolution: 0, uncertainty: 0, brier: 0 };

export const EMPTY_CALIBRATION: CalibrationSummary = {
  n: 0,
  brierUser: 0,
  brierMarket: 0,
  brierSkill: null,
  ciLow: null,
  ciHigh: null,
  baseRate: 0,
  bins: [],
  murphy: EMPTY_MURPHY,
  displayable: false,
  meanEdgeBps: 0,
};

/**
 * Murphy's three-way decomposition of the Brier score:
 *   BS = reliability - resolution + uncertainty
 *
 * It separates "your probabilities mean what they say" (reliability) from
 * "your probabilities are informative at all" (resolution), which is the
 * difference between a well-calibrated coin flipper and a forecaster.
 */
export function murphyDecomposition(records: CalibrationRecord[], binCount = 10): MurphyDecomposition {
  const n = records.length;
  if (n === 0) return EMPTY_MURPHY;

  const baseRate = records.reduce((s, r) => s + r.outcome, 0) / n;
  const buckets = new Map<number, CalibrationRecord[]>();
  for (const r of records) {
    const bin = binIndex(r.pUser, binCount);
    const arr = buckets.get(bin);
    if (arr) arr.push(r);
    else buckets.set(bin, [r]);
  }

  let reliability = 0;
  let resolution = 0;
  for (const group of buckets.values()) {
    const nk = group.length;
    const pk = group.reduce((s, r) => s + clamp(r.pUser, 0, 1), 0) / nk;
    const ok = group.reduce((s, r) => s + r.outcome, 0) / nk;
    reliability += nk * (pk - ok) ** 2;
    resolution += nk * (ok - baseRate) ** 2;
  }
  reliability /= n;
  resolution /= n;
  const uncertainty = baseRate * (1 - baseRate);

  return {
    reliability: roundTo(reliability, 6),
    resolution: roundTo(resolution, 6),
    uncertainty: roundTo(uncertainty, 6),
    brier: roundTo(reliability - resolution + uncertainty, 6),
  };
}

function binIndex(p: number, binCount: number): number {
  const pc = clamp(p, 0, 1);
  // Include 1.0 in the top bin rather than spilling into an empty bin above it.
  return Math.min(binCount - 1, Math.floor(pc * binCount));
}

export function calibrationBins(records: CalibrationRecord[], binCount = 10): CalibrationBin[] {
  const buckets = new Map<number, CalibrationRecord[]>();
  for (const r of records) {
    const bin = binIndex(r.pUser, binCount);
    const arr = buckets.get(bin);
    if (arr) arr.push(r);
    else buckets.set(bin, [r]);
  }
  const out: CalibrationBin[] = [];
  for (let b = 0; b < binCount; b++) {
    const group = buckets.get(b);
    if (!group || group.length === 0) continue;
    const nk = group.length;
    out.push({
      bin: b,
      binMid: roundTo((b + 0.5) / binCount, 4),
      n: nk,
      meanPredicted: roundTo(group.reduce((s, r) => s + clamp(r.pUser, 0, 1), 0) / nk, 6),
      observedFrequency: roundTo(group.reduce((s, r) => s + r.outcome, 0) / nk, 6),
    });
  }
  return out;
}

/**
 * Full calibration summary. The CI is a normal approximation on the difference
 * of Brier scores — good enough for an in-app display, and labelled
 * "approximate" in the UI. Swap for a bootstrap before publishing anything.
 */
export function summarizeCalibration(records: CalibrationRecord[]): CalibrationSummary {
  const n = records.length;
  if (n === 0) return EMPTY_CALIBRATION;

  const bu = records.map((r) => brier(r.pUser, r.outcome));
  const bm = records.map((r) => brier(r.pMarket, r.outcome));
  const diffs = bu.map((v, i) => v - bm[i]!);

  const meanBu = mean(bu);
  const meanBm = mean(bm);
  const skill = brierSkillScore(meanBu, meanBm);
  const baseRate = records.reduce((s, r) => s + r.outcome, 0) / n;

  let ciLow: number | null = null;
  let ciHigh: number | null = null;
  if (n >= MIN_N_FOR_BSS && meanBm > 0) {
    // Skill = 1 - Bu/Bm, so the uncertainty in skill is the uncertainty in the
    // paired difference (Bu - Bm), scaled by Bm.
    const se = stddevSample(diffs) / Math.sqrt(n);
    const halfWidth = (1.96 * se) / meanBm;
    ciLow = roundTo((skill ?? 0) - halfWidth, 6);
    ciHigh = roundTo((skill ?? 0) + halfWidth, 6);
  }

  return {
    n,
    brierUser: roundTo(meanBu, 6),
    brierMarket: roundTo(meanBm, 6),
    brierSkill: skill,
    ciLow,
    ciHigh,
    baseRate: roundTo(baseRate, 6),
    bins: calibrationBins(records),
    murphy: murphyDecomposition(records),
    displayable: n >= MIN_N_FOR_BSS,
    meanEdgeBps: roundTo(mean(records.map((r) => edgeBps(r.pUser, r.pMarket))), 4),
  };
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stddevSample(xs: number[]): number {
  const k = xs.length;
  if (k < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (k - 1));
}

/** Percentile of a numeric sample using linear interpolation. */
export function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const xs = [...sorted].sort((a, b) => a - b);
  const pos = clamp(q, 0, 1) * (xs.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return xs[lo]!;
  return xs[lo]! + (xs[hi]! - xs[lo]!) * (pos - lo);
}

/**
 * Winsorize a value into the cohort's 5th-95th percentile band, then normalize
 * to [0,1]. This is what stops one lottery ticket on a 2c market from owning
 * the leaderboard.
 */
export function winsorizedNormalizedReturn(value: number, cohort: number[]): number {
  if (cohort.length === 0) return 0.5;
  const p5 = percentile(cohort, 0.05);
  const p95 = percentile(cohort, 0.95);
  const clamped = clamp(value, p5, p95);
  if (!(p95 > p5)) return 0.5;
  return roundTo((clamped - p5) / (p95 - p5), 6);
}

/** Map a Brier Skill Score in [-0.25, +0.25] onto [0,1] for the ladder formula. */
export function normalizeBrierSkill(bss: number | null): number {
  if (bss == null) return 0;
  return roundTo(clamp((bss + 0.25) / 0.5, 0, 1), 6);
}

/**
 * Discipline: 1 - the coefficient of variation of stake size.
 * Consistent position sizing scores well; going all-in on one trade does not.
 */
export function disciplineScore(stakeNotionals: number[]): number {
  if (stakeNotionals.length < 2) return 0;
  const m = mean(stakeNotionals);
  if (!(m > 0)) return 0;
  const cv = stddevSample(stakeNotionals) / m;
  return roundTo(clamp(1 - cv, 0, 1), 6);
}

/** Activity saturates at 15 trades, so grinding volume buys nothing past that. */
export function activityScore(tradeCount: number, saturateAt = 15): number {
  return roundTo(clamp(tradeCount / saturateAt, 0, 1), 6);
}

export interface LadderInputs {
  normalizedReturn: number;
  brierSkillNormalized: number;
  discipline: number;
  activity: number;
}

export const LADDER_WEIGHTS = {
  normalizedReturn: 0.45,
  brierSkill: 0.35,
  discipline: 0.1,
  activity: 0.1,
} as const;

/**
 * Ladder points, 0-1000.
 *
 * Return is under half the weight on purpose: the point of the product is that
 * being right is worth more than being lucky.
 */
export function ladderPoints(i: LadderInputs): number {
  const raw =
    LADDER_WEIGHTS.normalizedReturn * clamp(i.normalizedReturn, 0, 1) +
    LADDER_WEIGHTS.brierSkill * clamp(i.brierSkillNormalized, 0, 1) +
    LADDER_WEIGHTS.discipline * clamp(i.discipline, 0, 1) +
    LADDER_WEIGHTS.activity * clamp(i.activity, 0, 1);
  return roundTo(1000 * raw, 4);
}

/** Plain-English verdict. The Record screen leads with this, not with a number. */
export function coachingVerdict(s: CalibrationSummary): string {
  if (s.n < MIN_N_FOR_BSS) {
    return `Building your record — ${s.n}/${MIN_N_FOR_BSS} resolved positions. Keep trading; a skill score before 30 would be noise.`;
  }
  const bss = s.brierSkill ?? 0;
  const overconfident = s.murphy.reliability > 0.02;

  if (bss > 0.05) {
    return overconfident
      ? 'You are beating the market price, but your confidence runs ahead of your accuracy. Size down on your strongest convictions.'
      : 'You are genuinely beating the market price. Your forecasts carry information the price did not.';
  }
  if (bss > -0.02) {
    return 'You are roughly matching the market. That is harder than it sounds — but the spread you pay makes it a losing trade over time.';
  }
  return overconfident
    ? 'You are paying for confidence you have not earned. Your extreme forecasts miss most often — try trading closer to the mid.'
    : 'The market price is beating your forecasts. Look for categories where you actually have an edge instead of trading everything.';
}
