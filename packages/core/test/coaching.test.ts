import { describe, expect, it } from 'vitest';
import {
  MIN_N_FOR_READINESS,
  categoryInsight,
  diagnose,
  readinessCheck,
  readinessProgress,
  worstLosingStreak,
  type CategoryEdge,
} from '../src/coaching';
import { EMPTY_CALIBRATION, type CalibrationSummary } from '../src/scoring';

/** Build a summary with just the fields the decision table reads. */
function summary(over: Partial<CalibrationSummary>): CalibrationSummary {
  return {
    ...EMPTY_CALIBRATION,
    n: 100,
    brierSkill: 0,
    murphy: { reliability: 0.005, resolution: 0.05, uncertainty: 0.25, brier: 0.2 },
    ...over,
  };
}

describe('diagnose — the coaching decision table', () => {
  it('refuses to diagnose below n=30, whatever the score looks like', () => {
    const v = diagnose(summary({ n: 18, brierSkill: 0.9 }));
    expect(v.diagnosis).toBe('not_enough_data');
    expect(v.headline).toContain('18/30');
    expect(v.positive).toBe(false);
  });

  it('also refuses when the skill score is null', () => {
    expect(diagnose(summary({ n: 200, brierSkill: null })).diagnosis).toBe('not_enough_data');
  });

  it('reports a real edge, and is the only positive verdict', () => {
    const v = diagnose(summary({ brierSkill: 0.15 }));
    expect(v.diagnosis).toBe('real_edge');
    expect(v.positive).toBe(true);
  });

  it('still leads with the edge when the forecaster is also overconfident', () => {
    // Being right is the headline; the overconfidence belongs in the advice.
    const v = diagnose(
      summary({
        brierSkill: 0.15,
        murphy: { reliability: 0.09, resolution: 0.05, uncertainty: 0.25, brier: 0.2 },
      }),
    );
    expect(v.diagnosis).toBe('real_edge');
    expect(v.advice.toLowerCase()).toContain('confidence');
    expect(v.advice.toLowerCase()).toContain('size down');
  });

  it('calls out overconfidence when there is no edge to offset it', () => {
    const v = diagnose(
      summary({
        brierSkill: -0.05,
        murphy: { reliability: 0.09, resolution: 0.05, uncertainty: 0.25, brier: 0.2 },
      }),
    );
    expect(v.diagnosis).toBe('overconfident');
    expect(v.advice).toContain('90%');
  });

  it('distinguishes "too timid" from "overconfident" via resolution', () => {
    // Well calibrated (low reliability) but uninformative (low resolution).
    const v = diagnose(
      summary({
        brierSkill: -0.01,
        murphy: { reliability: 0.001, resolution: 0.002, uncertainty: 0.25, brier: 0.2 },
      }),
    );
    expect(v.diagnosis).toBe('too_timid');
    expect(v.advice).toContain('disagree');
  });

  it('treats a score inside the noise band as matching the market', () => {
    const v = diagnose(summary({ brierSkill: 0.005 }));
    expect(v.diagnosis).toBe('matching_market');
    expect(v.advice).toContain('spread');
  });

  it('says plainly when the market is winning', () => {
    const v = diagnose(summary({ brierSkill: -0.2 }));
    expect(v.diagnosis).toBe('no_edge');
    expect(v.positive).toBe(false);
  });

  it('produces a distinct verdict for every diagnosis it can reach', () => {
    const seen = new Set(
      [
        summary({ n: 5 }),
        summary({ brierSkill: 0.2 }),
        summary({
          brierSkill: -0.05,
          murphy: { reliability: 0.09, resolution: 0.05, uncertainty: 0.25, brier: 0.2 },
        }),
        summary({
          brierSkill: -0.01,
          murphy: { reliability: 0.001, resolution: 0.002, uncertainty: 0.25, brier: 0.2 },
        }),
        summary({ brierSkill: 0.005 }),
        summary({ brierSkill: -0.2 }),
      ].map((s) => diagnose(s).diagnosis),
    );
    expect(seen.size).toBe(6);
  });
});

describe('categoryInsight', () => {
  const edge = (category: string, brierSkill: number, n = 40): CategoryEdge => ({
    category,
    n,
    brierSkill,
    reliable: n >= 20,
  });

  it('contrasts the best and worst category when both are meaningful', () => {
    const line = categoryInsight([edge('politics', 0.14), edge('sports', -0.03)]);
    expect(line).toContain('politics');
    expect(line).toContain('+0.14');
    expect(line).toContain('sports');
    expect(line).toContain('-0.03');
  });

  it('ignores categories with too little data to judge', () => {
    const line = categoryInsight([edge('politics', 0.14), edge('sports', -0.9, 3)]);
    expect(line).toContain('politics');
    expect(line).not.toContain('sports');
  });

  it('returns null rather than saying something misleading', () => {
    expect(categoryInsight([])).toBeNull();
    expect(categoryInsight([edge('sports', 0.2, 4)])).toBeNull();
  });

  it('handles a single reliable category in both directions', () => {
    expect(categoryInsight([edge('crypto', 0.2)])).toContain('real edge in crypto');
    expect(categoryInsight([edge('crypto', -0.2)])).toContain('No edge in crypto');
  });

  it('does not claim an edge when every category is negative', () => {
    const line = categoryInsight([edge('politics', -0.05), edge('sports', -0.2)]);
    expect(line).toContain('No category shows an edge');
    expect(line).toContain('sports');
  });
});

describe('readinessCheck — the sentence the product exists to earn', () => {
  const base = {
    categories: [] as CategoryEdge[],
    maxDrawdownPct: 22,
    worstLosingStreak: 6,
    returnPct: 12,
  };

  it('stays locked below 100 resolved positions', () => {
    const r = readinessCheck({ ...base, calibration: summary({ n: 40 }) });
    expect(r.unlocked).toBe(false);
    expect(r.status).toBe('locked');
    expect(r.bottomLine).toContain('60 more');
  });

  it('says plainly not to fund a real account on a negative score', () => {
    const r = readinessCheck({
      ...base,
      calibration: summary({ n: 150, brierSkill: -0.08, ciLow: -0.15, ciHigh: -0.01 }),
    });
    expect(r.status).toBe('not_ready');
    expect(r.bottomLine).toContain('recommend against funding a real account');
    // It must not soften this into "keep practising and you'll get there".
    expect(r.bottomLine).toContain('negative expectation');
  });

  it('refuses to call a positive score proven while its CI includes zero', () => {
    const r = readinessCheck({
      ...base,
      calibration: summary({ n: 150, brierSkill: 0.04, ciLow: -0.02, ciHigh: 0.1 }),
    });
    expect(r.status).toBe('mixed');
    expect(r.bottomLine).toContain('not been distinguished from luck');
  });

  it('confirms a genuine edge only when the whole CI is above zero', () => {
    const r = readinessCheck({
      ...base,
      calibration: summary({ n: 150, brierSkill: 0.12, ciLow: 0.03, ciHigh: 0.21 }),
      categories: [{ category: 'politics', n: 60, brierSkill: 0.15, reliable: true }],
    });
    expect(r.status).toBe('ready');
    expect(r.headline).toContain('real, measurable edge');
    expect(r.bottomLine).toContain('politics');
    // Always sizes the advice against a drawdown they have actually had.
    expect(r.bottomLine).toContain('22%');
  });

  it('still gives usable advice when no single category stands out', () => {
    const r = readinessCheck({
      ...base,
      calibration: summary({ n: 150, brierSkill: 0.12, ciLow: 0.03, ciHigh: 0.21 }),
    });
    expect(r.status).toBe('ready');
    expect(r.bottomLine).toContain('drawdown');
  });
});

describe('worstLosingStreak', () => {
  it('finds the longest run of losses', () => {
    expect(worstLosingStreak([true, false, false, true, false, false, false])).toBe(3);
    expect(worstLosingStreak([true, true])).toBe(0);
    expect(worstLosingStreak([])).toBe(0);
    expect(worstLosingStreak([false, false])).toBe(2);
  });
});

describe('readinessProgress', () => {
  it('is clamped to 0..1', () => {
    expect(readinessProgress(0)).toBe(0);
    expect(readinessProgress(50)).toBe(0.5);
    expect(readinessProgress(MIN_N_FOR_READINESS)).toBe(1);
    expect(readinessProgress(9999)).toBe(1);
  });
});
