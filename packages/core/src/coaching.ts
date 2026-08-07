import { MIN_N_FOR_BSS, type CalibrationSummary } from './scoring';
import { clamp, roundTo } from './decimal';

/**
 * The coaching decision table.
 *
 * A Brier Skill Score is a number almost nobody can act on. What a forecaster
 * can act on is *which way* they are wrong: consistently too confident, too
 * timid, or simply not informative yet. Those are different failures with
 * different fixes, and the Murphy decomposition already separates them —
 * reliability says "your probabilities do not mean what they say", resolution
 * says "your probabilities barely move off the base rate".
 *
 * Kept as a pure function so the Dashboard summary and the full Record screen
 * cannot drift apart, and so the verdicts are unit-testable rather than
 * hand-checked in a UI.
 */

export type Diagnosis =
  | 'not_enough_data'
  | 'real_edge'
  | 'overconfident'
  | 'too_timid'
  | 'matching_market'
  | 'no_edge';

export interface Verdict {
  diagnosis: Diagnosis;
  /** One line, plain English, safe to show as a headline. */
  headline: string;
  /** What to actually do differently. Empty when there is nothing to say yet. */
  advice: string;
  /** true when the verdict is good news — lets the UI colour it without re-deriving. */
  positive: boolean;
}

/** Reliability above this means the forecasts do not mean what they claim. */
const RELIABILITY_POOR = 0.02;
/** Resolution below this means the forecasts barely leave the base rate. */
const RESOLUTION_FLAT = 0.01;
/** Skill inside +/- this band is indistinguishable from matching the market. */
const SKILL_NOISE_BAND = 0.02;

/**
 * Diagnose a calibration record.
 *
 * Order matters: "not enough data" always wins, because every verdict below it
 * would be noise. After that, a genuine edge is reported even if the forecaster
 * is also somewhat overconfident — being right is the headline, and the
 * overconfidence shows up in the advice rather than being buried.
 */
export function diagnose(summary: CalibrationSummary): Verdict {
  const { n, brierSkill, murphy } = summary;

  if (n < MIN_N_FOR_BSS || brierSkill == null) {
    return {
      diagnosis: 'not_enough_data',
      headline: `Building your record — ${n}/${MIN_N_FOR_BSS} resolved positions.`,
      advice:
        'A skill score before 30 resolved positions is noise, so we will not show you one yet. Keep trading across different markets.',
      positive: false,
    };
  }

  const overconfident = murphy.reliability > RELIABILITY_POOR;
  const flat = murphy.resolution < RESOLUTION_FLAT;

  if (brierSkill > SKILL_NOISE_BAND) {
    return {
      diagnosis: 'real_edge',
      headline: 'You are beating the market price.',
      advice: overconfident
        ? 'Your forecasts carry real information, but your confidence runs ahead of your accuracy. Size down on your strongest convictions and you keep the edge with less variance.'
        : 'Your forecasts carry information the price did not. Keep sizing consistently — this is what an edge looks like before it gets thrown away by bad position sizing.',
      positive: true,
    };
  }

  if (overconfident) {
    return {
      diagnosis: 'overconfident',
      headline: 'You are paying for confidence you have not earned.',
      advice:
        'Your extreme forecasts miss most often — when you say 90%, it happens far less than 90% of the time. Trade closer to the mid and let the market carry the tails.',
      positive: false,
    };
  }

  if (flat) {
    return {
      diagnosis: 'too_timid',
      headline: 'Your forecasts barely move off the market price.',
      advice:
        'You are well calibrated but not informative — you are agreeing with the price and paying a spread to do it. Look for the few markets where you genuinely disagree, and skip the rest.',
      positive: false,
    };
  }

  if (brierSkill >= -SKILL_NOISE_BAND) {
    return {
      diagnosis: 'matching_market',
      headline: 'You are matching the market.',
      advice:
        'That is harder than it sounds — most people are worse. But matching it while paying the spread is a losing trade over time. You need markets where you actually know more.',
      positive: false,
    };
  }

  return {
    diagnosis: 'no_edge',
    headline: 'The market price is beating your forecasts.',
    advice:
      'Trading everything is the usual cause. Find the one or two categories where you have real knowledge and ignore the rest — your per-category breakdown below will show you where.',
    positive: false,
  };
}

export interface CategoryEdge {
  category: string;
  n: number;
  brierSkill: number | null;
  /** False below MIN_N_FOR_CATEGORY — the UI greys these out as "thin". */
  reliable: boolean;
}

/**
 * The single most useful line from a per-category breakdown, for the Dashboard.
 *
 * Surfaces the best and worst category the user has *enough data* to judge, so
 * the headline insight does not require opening the Record screen. Returns null
 * when nothing is reliable enough to say — better silent than misleading.
 */
export function categoryInsight(edges: CategoryEdge[]): string | null {
  const reliable = edges.filter((e) => e.reliable && e.brierSkill != null);
  if (reliable.length === 0) return null;

  const sorted = [...reliable].sort((a, b) => (b.brierSkill ?? 0) - (a.brierSkill ?? 0));
  const best = sorted[0]!;
  const worst = sorted[sorted.length - 1]!;

  const fmt = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(2)}`;

  if (sorted.length === 1 || best.category === worst.category) {
    return (best.brierSkill ?? 0) > 0
      ? `You have real edge in ${best.category} (${fmt(best.brierSkill ?? 0)}).`
      : `No edge in ${best.category} yet (${fmt(best.brierSkill ?? 0)}).`;
  }

  if ((best.brierSkill ?? 0) > 0 && (worst.brierSkill ?? 0) < 0) {
    return `You have real edge in ${best.category} (${fmt(best.brierSkill ?? 0)}), none in ${worst.category} (${fmt(worst.brierSkill ?? 0)}).`;
  }
  if ((best.brierSkill ?? 0) > 0) {
    return `Your strongest category is ${best.category} (${fmt(best.brierSkill ?? 0)}).`;
  }
  return `No category shows an edge yet — weakest is ${worst.category} (${fmt(worst.brierSkill ?? 0)}).`;
}

/** Minimum resolved positions before the Readiness Check will render a verdict. */
export const MIN_N_FOR_READINESS = 100;

export interface ReadinessInputs {
  calibration: CalibrationSummary;
  categories: CategoryEdge[];
  /** Peak-to-trough drawdown as a percentage. */
  maxDrawdownPct: number;
  /** Longest run of consecutive losing resolved positions. */
  worstLosingStreak: number;
  /** Total return on the paper account, as a percentage. */
  returnPct: number;
}

export interface Readiness {
  unlocked: boolean;
  n: number;
  required: number;
  /** 'ready' | 'mixed' | 'not_ready' | 'locked' */
  status: 'ready' | 'mixed' | 'not_ready' | 'locked';
  headline: string;
  body: string[];
  /** The blunt one-liner. This is the sentence the whole product exists to earn. */
  bottomLine: string;
}

/**
 * The Readiness Check.
 *
 * The product promise is "learn to trade prediction markets before it costs you
 * anything". This is where that promise is cashed, so the copy has to be honest
 * even when honesty is unwelcome: if the skill score is negative, it says so,
 * and it says not to fund a real account. Softening that would make every other
 * number in the app worth less.
 */
export function readinessCheck(input: ReadinessInputs): Readiness {
  const { calibration: cal, categories, maxDrawdownPct, worstLosingStreak, returnPct } = input;
  const n = cal.n;

  if (n < MIN_N_FOR_READINESS) {
    return {
      unlocked: false,
      n,
      required: MIN_N_FOR_READINESS,
      status: 'locked',
      headline: `Readiness Check unlocks at ${MIN_N_FOR_READINESS} resolved positions.`,
      body: [
        `You have ${n}. Below ${MIN_N_FOR_READINESS} there is not enough evidence to tell skill from luck, and a verdict you cannot trust is worse than no verdict.`,
      ],
      bottomLine: `${MIN_N_FOR_READINESS - n} more resolved positions to go.`,
    };
  }

  const skill = cal.brierSkill ?? 0;
  const ciLow = cal.ciLow;
  // The honest test is not "was the point estimate positive" but "is the whole
  // confidence interval above zero". A skill score whose CI straddles zero has
  // not distinguished itself from luck.
  const provenPositive = ciLow != null && ciLow > 0;
  const strongCategories = categories.filter(
    (c) => c.reliable && (c.brierSkill ?? 0) > 0.02,
  );

  const body: string[] = [
    `Brier Skill Score ${skill > 0 ? '+' : ''}${skill.toFixed(3)} over ${n} resolved positions${
      cal.ciLow != null && cal.ciHigh != null
        ? ` (95% CI ${cal.ciLow.toFixed(3)} to ${cal.ciHigh.toFixed(3)})`
        : ''
    }.`,
    `Worst drawdown ${maxDrawdownPct.toFixed(1)}%, longest losing run ${worstLosingStreak}.`,
    `Paper return ${returnPct > 0 ? '+' : ''}${returnPct.toFixed(1)}%.`,
  ];

  if (skill < 0) {
    return {
      unlocked: true,
      n,
      required: MIN_N_FOR_READINESS,
      status: 'not_ready',
      headline: 'Not ready. The market has been beating your forecasts.',
      body,
      bottomLine:
        'On this evidence we would recommend against funding a real account. You are paying a spread to be less accurate than a price you could read for free. That is not a losing streak, it is a negative expectation — and it does not fix itself with more size.',
    };
  }

  if (!provenPositive) {
    return {
      unlocked: true,
      n,
      required: MIN_N_FOR_READINESS,
      status: 'mixed',
      headline: 'Not proven. Your edge is inside the noise.',
      body,
      bottomLine:
        'Your score is positive but its confidence interval still includes zero, which means it has not been distinguished from luck. Keep going — this is the point where most people mistake a good run for a skill.',
    };
  }

  return {
    unlocked: true,
    n,
    required: MIN_N_FOR_READINESS,
    status: 'ready',
    headline: 'You have demonstrated a real, measurable edge.',
    body: [
      ...body,
      strongCategories.length > 0
        ? `Your edge is concentrated in ${strongCategories.map((c) => c.category).join(', ')}.`
        : 'Your edge is spread evenly rather than concentrated in one category.',
    ],
    bottomLine:
      strongCategories.length > 0
        ? `If you trade real money, trade ${strongCategories.map((c) => c.category).join(' and ')} and skip the rest — that is where the evidence is. Size small enough to survive a ${maxDrawdownPct.toFixed(0)}% drawdown, because you have already had one.`
        : `If you trade real money, size small enough to survive a ${maxDrawdownPct.toFixed(0)}% drawdown, because you have already had one. A demonstrated edge is not a guarantee on any single market.`,
  };
}

/** Longest run of consecutive losses in a settled-position history. */
export function worstLosingStreak(outcomes: boolean[]): number {
  let worst = 0;
  let run = 0;
  for (const won of outcomes) {
    run = won ? 0 : run + 1;
    if (run > worst) worst = run;
  }
  return worst;
}

/** Normalized 0..1 readiness progress, for a progress bar. */
export function readinessProgress(n: number): number {
  return roundTo(clamp(n / MIN_N_FOR_READINESS, 0, 1), 4);
}

