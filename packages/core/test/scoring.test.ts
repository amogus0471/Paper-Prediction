import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  MIN_N_FOR_BSS,
  activityScore,
  brier,
  brierSkillScore,
  calibrationBins,
  coachingVerdict,
  disciplineScore,
  edgeBps,
  ladderPoints,
  logScore,
  murphyDecomposition,
  normalizeBrierSkill,
  percentile,
  summarizeCalibration,
  winsorizedNormalizedReturn,
  type CalibrationRecord,
} from '../src/scoring';

describe('brier', () => {
  it('is 0 for a perfect forecast and 1 for a perfectly wrong one', () => {
    expect(brier(1, 1)).toBe(0);
    expect(brier(0, 0)).toBe(0);
    expect(brier(0, 1)).toBe(1);
    expect(brier(0.5, 1)).toBe(0.25);
  });

  it('is bounded in [0,1] for any probability', () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1, noNaN: true }), fc.boolean(), (p, o) => {
        const b = brier(p, o ? 1 : 0);
        expect(b).toBeGreaterThanOrEqual(0);
        expect(b).toBeLessThanOrEqual(1);
      }),
      { numRuns: 300 },
    );
  });

  it('clamps out-of-range probabilities rather than producing nonsense', () => {
    expect(brier(1.5, 1)).toBe(0);
    expect(brier(-0.5, 0)).toBe(0);
  });
});

describe('log score', () => {
  it('punishes confident wrongness far harder than brier does', () => {
    expect(logScore(0.99, 0)).toBeGreaterThan(logScore(0.6, 0));
    expect(logScore(0.99, 1)).toBeCloseTo(0.01, 2);
  });
  it('stays finite at the extremes', () => {
    expect(Number.isFinite(logScore(0, 1))).toBe(true);
    expect(Number.isFinite(logScore(1, 0))).toBe(true);
  });
});

describe('brier skill score', () => {
  it('is positive when you beat the reference and negative when you do not', () => {
    expect(brierSkillScore(0.15, 0.2)!).toBeGreaterThan(0);
    expect(brierSkillScore(0.25, 0.2)!).toBeLessThan(0);
    expect(brierSkillScore(0.2, 0.2)).toBe(0);
  });

  it('refuses to divide by a zero reference', () => {
    expect(brierSkillScore(0.1, 0)).toBeNull();
  });
});

describe('edge', () => {
  it('is signed by the direction of disagreement with the market', () => {
    expect(edgeBps(0.6, 0.65)).toBeCloseTo(500, 4);
    expect(edgeBps(0.65, 0.6)).toBeCloseTo(-500, 4);
  });
});

describe('murphy decomposition', () => {
  it('reconstructs the brier score from its three parts', () => {
    const records: CalibrationRecord[] = [];
    for (let i = 0; i < 200; i++) {
      const p = (i % 10) / 10 + 0.05;
      records.push({ pUser: p, pMarket: p, outcome: Math.random() < p ? 1 : 0 });
    }
    const m = murphyDecomposition(records);
    const meanBrier =
      records.reduce((s, r) => s + brier(r.pUser, r.outcome), 0) / records.length;
    expect(Math.abs(m.brier - meanBrier)).toBeLessThan(1e-3);
  });

  it('gives a perfectly calibrated forecaster near-zero reliability', () => {
    // 100 forecasts at 0.7, exactly 70 of which happen.
    const records: CalibrationRecord[] = Array.from({ length: 100 }, (_, i) => ({
      pUser: 0.7,
      pMarket: 0.7,
      outcome: i < 70 ? 1 : 0,
    }));
    const m = murphyDecomposition(records);
    expect(m.reliability).toBeLessThan(1e-6);
  });

  it('gives a badly calibrated forecaster high reliability error', () => {
    // Says 0.9 every time; it happens 20% of the time.
    const records: CalibrationRecord[] = Array.from({ length: 100 }, (_, i) => ({
      pUser: 0.9,
      pMarket: 0.5,
      outcome: i < 20 ? 1 : 0,
    }));
    expect(murphyDecomposition(records).reliability).toBeCloseTo(0.49, 2);
  });

  it('returns zeros on an empty corpus', () => {
    expect(murphyDecomposition([]).brier).toBe(0);
  });
});

describe('calibration bins', () => {
  it('puts p=1.0 in the top bin rather than a phantom eleventh bin', () => {
    const bins = calibrationBins([{ pUser: 1, pMarket: 1, outcome: 1 }]);
    expect(bins).toHaveLength(1);
    expect(bins[0]!.bin).toBe(9);
  });

  it('reports n per bin so the UI can size the dots', () => {
    const records: CalibrationRecord[] = [
      { pUser: 0.05, pMarket: 0.05, outcome: 0 },
      { pUser: 0.06, pMarket: 0.06, outcome: 0 },
      { pUser: 0.95, pMarket: 0.95, outcome: 1 },
    ];
    const bins = calibrationBins(records);
    expect(bins.find((b) => b.bin === 0)!.n).toBe(2);
    expect(bins.find((b) => b.bin === 9)!.n).toBe(1);
  });
});

describe('summarizeCalibration — statistical honesty', () => {
  const makeRecords = (n: number, pUser: number, pMarket: number, winRate: number) =>
    Array.from({ length: n }, (_, i): CalibrationRecord => ({
      pUser,
      pMarket,
      outcome: i < Math.round(n * winRate) ? 1 : 0,
    }));

  it('refuses to display a skill score below n=30', () => {
    const s = summarizeCalibration(makeRecords(29, 0.6, 0.5, 0.6));
    expect(s.n).toBe(29);
    expect(s.displayable).toBe(false);
    expect(s.ciLow).toBeNull();
    expect(s.ciHigh).toBeNull();
  });

  it('produces a CI once there is enough data', () => {
    const s = summarizeCalibration(makeRecords(120, 0.6, 0.5, 0.6));
    expect(s.displayable).toBe(true);
    expect(s.ciLow).not.toBeNull();
    expect(s.ciHigh).not.toBeNull();
    expect(s.ciLow!).toBeLessThanOrEqual(s.brierSkill!);
    expect(s.ciHigh!).toBeGreaterThanOrEqual(s.brierSkill!);
  });

  it('scores a forecaster who beats the market as positive skill', () => {
    // User says 0.6 and is right 60% of the time; market said 0.5 throughout.
    const s = summarizeCalibration(makeRecords(100, 0.6, 0.5, 0.6));
    expect(s.brierSkill!).toBeGreaterThan(0);
  });

  it('scores a forecaster who is worse than the market as negative skill', () => {
    const s = summarizeCalibration(makeRecords(100, 0.9, 0.5, 0.5));
    expect(s.brierSkill!).toBeLessThan(0);
  });

  it('handles an empty corpus', () => {
    const s = summarizeCalibration([]);
    expect(s.n).toBe(0);
    expect(s.brierSkill).toBeNull();
    expect(s.displayable).toBe(false);
  });
});

describe('coaching verdict', () => {
  it('tells a new user how far they have to go instead of showing a number', () => {
    const v = coachingVerdict(summarizeCalibration([{ pUser: 0.6, pMarket: 0.5, outcome: 1 }]));
    expect(v).toContain(`1/${MIN_N_FOR_BSS}`);
  });

  it('gives a distinct verdict for beating, matching and losing to the market', () => {
    const beat = coachingVerdict({
      ...summarizeCalibration([]),
      n: 100,
      displayable: true,
      brierSkill: 0.2,
    });
    const match = coachingVerdict({
      ...summarizeCalibration([]),
      n: 100,
      displayable: true,
      brierSkill: 0,
    });
    const lose = coachingVerdict({
      ...summarizeCalibration([]),
      n: 100,
      displayable: true,
      brierSkill: -0.2,
    });
    expect(new Set([beat, match, lose]).size).toBe(3);
  });

  it('calls out overconfidence separately from accuracy', () => {
    const base = summarizeCalibration([]);
    const overconfident = coachingVerdict({
      ...base,
      n: 100,
      displayable: true,
      brierSkill: 0.2,
      murphy: { ...base.murphy, reliability: 0.1 },
    });
    expect(overconfident.toLowerCase()).toContain('confidence');
  });
});

describe('ladder scoring', () => {
  it('winsorizes an outlier return into the cohort band', () => {
    const cohort = Array.from({ length: 100 }, (_, i) => i / 100);
    // A 50x return still cannot score above the 95th percentile.
    expect(winsorizedNormalizedReturn(50, cohort)).toBe(1);
    expect(winsorizedNormalizedReturn(-50, cohort)).toBe(0);
  });

  it('returns a neutral 0.5 with no cohort to compare against', () => {
    expect(winsorizedNormalizedReturn(1, [])).toBe(0.5);
    expect(winsorizedNormalizedReturn(1, [0.5, 0.5, 0.5])).toBe(0.5);
  });

  it('interpolates percentiles', () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBeCloseTo(2.5, 6);
    expect(percentile([], 0.5)).toBe(0);
    expect(percentile([5], 0.9)).toBe(5);
  });

  it('maps brier skill from [-0.25,0.25] onto [0,1]', () => {
    expect(normalizeBrierSkill(0)).toBe(0.5);
    expect(normalizeBrierSkill(0.25)).toBe(1);
    expect(normalizeBrierSkill(-0.25)).toBe(0);
    expect(normalizeBrierSkill(5)).toBe(1);
    expect(normalizeBrierSkill(null)).toBe(0);
  });

  it('rewards consistent stake sizing over all-in bets', () => {
    const steady = disciplineScore([100, 100, 100, 100]);
    const erratic = disciplineScore([1, 1, 1, 5000]);
    expect(steady).toBe(1);
    expect(erratic).toBeLessThan(0.2);
    expect(disciplineScore([100])).toBe(0);
    expect(disciplineScore([0, 0])).toBe(0);
  });

  it('saturates activity at 15 trades', () => {
    expect(activityScore(15)).toBe(1);
    expect(activityScore(150)).toBe(1);
    expect(activityScore(0)).toBe(0);
    expect(activityScore(3)).toBeCloseTo(0.2, 4);
  });

  it('weights being right above being lucky', () => {
    const lucky = ladderPoints({
      normalizedReturn: 1,
      brierSkillNormalized: 0,
      discipline: 0,
      activity: 0,
    });
    const skilled = ladderPoints({
      normalizedReturn: 0,
      brierSkillNormalized: 1,
      discipline: 1,
      activity: 1,
    });
    expect(lucky).toBe(450);
    expect(skilled).toBe(550);
    expect(skilled).toBeGreaterThan(lucky);
  });

  it('is bounded to 0..1000 for any input', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -10, max: 10, noNaN: true }),
        fc.double({ min: -10, max: 10, noNaN: true }),
        fc.double({ min: -10, max: 10, noNaN: true }),
        fc.double({ min: -10, max: 10, noNaN: true }),
        (a, b, c, d) => {
          const pts = ladderPoints({
            normalizedReturn: a,
            brierSkillNormalized: b,
            discipline: c,
            activity: d,
          });
          expect(pts).toBeGreaterThanOrEqual(0);
          expect(pts).toBeLessThanOrEqual(1000);
        },
      ),
      { numRuns: 300 },
    );
  });
});
