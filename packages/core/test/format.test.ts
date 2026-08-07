import { describe, expect, it } from 'vitest';
import {
  formatBps,
  formatCents,
  formatCompact,
  formatCountdown,
  formatGhostDollars,
  formatPercent,
  formatProbability,
  formatQty,
  formatRelativeTime,
  formatScore,
  formatSignedGhostDollars,
  formatSignedPercent,
  rejectCopy,
  unitNoun,
} from '../src/format';
import { ceilCents, isOnTick, roundTo, snapToTick, clamp } from '../src/decimal';

describe('decimal', () => {
  it('rounds half away from zero, including the classic float traps', () => {
    expect(roundTo(1.005, 2)).toBe(1.01);
    expect(roundTo(2.675, 2)).toBe(2.68);
    expect(roundTo(-1.005, 2)).toBe(-1.01);
    expect(roundTo(0, 2)).toBe(0);
    expect(roundTo(Number.NaN, 2)).toBe(0);
    expect(Object.is(roundTo(-0.0001, 2), 0)).toBe(true);
  });

  it('ceils to the next whole cent', () => {
    expect(ceilCents(1.751)).toBeCloseTo(1.76, 4);
    expect(ceilCents(1.75)).toBeCloseTo(1.75, 4);
  });

  it('snaps prices onto a tick grid', () => {
    expect(snapToTick(63.4, 1)).toBe(63);
    expect(snapToTick(63.6, 1)).toBe(64);
    expect(snapToTick(63.44, 0.1)).toBe(63.4);
    expect(snapToTick(63.4, 1, 'down')).toBe(63);
    expect(snapToTick(63.4, 1, 'up')).toBe(64);
    expect(snapToTick(63.4, 0)).toBe(63.4);
  });

  it('detects off-grid prices', () => {
    expect(isOnTick(63, 1)).toBe(true);
    expect(isOnTick(63.5, 1)).toBe(false);
    expect(isOnTick(63.5, 0.1)).toBe(true);
    expect(isOnTick(63.5, 0)).toBe(true);
  });

  it('clamps', () => {
    expect(clamp(5, 0, 3)).toBe(3);
    expect(clamp(-5, 0, 3)).toBe(0);
    expect(clamp(2, 0, 3)).toBe(2);
  });
});

describe('formatters', () => {
  it('formats cents with venue-appropriate precision', () => {
    expect(formatCents(63)).toBe('63¢');
    expect(formatCents(4.5)).toBe('4.5¢');
    expect(formatCents(63, 1)).toBe('63.0¢');
    expect(formatCents(null)).toBe('--');
  });

  it('always prefixes ghost dollars so they cannot be mistaken for real money', () => {
    expect(formatGhostDollars(1234.5)).toBe('G$1,234.50');
    expect(formatGhostDollars(-50)).toBe('-G$50.00');
    expect(formatGhostDollars(null)).toBe('--');
  });

  it('signs P&L explicitly', () => {
    expect(formatSignedGhostDollars(120)).toBe('+G$120.00');
    expect(formatSignedGhostDollars(-120)).toBe('-G$120.00');
    expect(formatSignedGhostDollars(0)).toBe('G$0.00');
  });

  it('formats percents, probabilities, bps and scores', () => {
    expect(formatPercent(12.34)).toBe('12.3%');
    expect(formatSignedPercent(12.34)).toBe('+12.3%');
    expect(formatSignedPercent(-12.34)).toBe('-12.3%');
    expect(formatProbability(0.634)).toBe('63%');
    expect(formatBps(123.6)).toBe('+124 bps');
    expect(formatScore(0.1234)).toBe('+0.123');
    expect(formatScore(-0.1234)).toBe('-0.123');
    expect(formatScore(null)).toBe('--');
    expect(formatPercent(null)).toBe('--');
    expect(formatProbability(null)).toBe('--');
    expect(formatBps(null)).toBe('--');
  });

  it('compacts volume without losing readability', () => {
    expect(formatCompact(1_250_000)).toBe('1.3M');
    expect(formatCompact(2_100_000_000)).toBe('2.1B');
    expect(formatCompact(45_000)).toBe('45K');
    expect(formatCompact(4_500)).toBe('4.5K');
    expect(formatCompact(842)).toBe('842');
    expect(formatCompact(null)).toBe('--');
  });

  it('formats quantities', () => {
    expect(formatQty(1000)).toBe('1,000');
    expect(formatQty(10.5)).toBe('10.50');
    expect(formatQty(null)).toBe('--');
  });

  it('counts down to close', () => {
    const now = new Date('2026-08-06T12:00:00Z');
    expect(formatCountdown('2026-08-06T12:00:30Z', now)).toBe('30s');
    expect(formatCountdown('2026-08-06T12:45:00Z', now)).toBe('45m');
    expect(formatCountdown('2026-08-06T15:30:00Z', now)).toBe('3h 30m');
    expect(formatCountdown('2026-08-09T18:00:00Z', now)).toBe('3d 6h');
    expect(formatCountdown('2026-12-06T12:00:00Z', now)).toBe('4mo');
    expect(formatCountdown('2026-08-06T11:00:00Z', now)).toBe('Closed');
    expect(formatCountdown(null)).toBe('--');
    expect(formatCountdown('not-a-date')).toBe('--');
  });

  it('formats relative times', () => {
    const now = new Date('2026-08-06T12:00:00Z');
    expect(formatRelativeTime('2026-08-06T11:59:58Z', now)).toBe('just now');
    expect(formatRelativeTime('2026-08-06T11:59:30Z', now)).toBe('30s ago');
    expect(formatRelativeTime('2026-08-06T11:30:00Z', now)).toBe('30m ago');
    expect(formatRelativeTime('2026-08-06T09:00:00Z', now)).toBe('3h ago');
    expect(formatRelativeTime('2026-08-04T12:00:00Z', now)).toBe('2d ago');
    expect(formatRelativeTime(null)).toBe('--');
  });

  it('uses the venue’s own noun for a unit', () => {
    expect(unitNoun('polymarket', 1)).toBe('share');
    expect(unitNoun('polymarket', 5)).toBe('shares');
    expect(unitNoun('kalshi', 1)).toBe('contract');
    expect(unitNoun('kalshi', 5)).toBe('contracts');
  });

  it('has specific copy for every rejection, never a generic failure', () => {
    expect(rejectCopy('size_exceeds_depth')).toContain('move the price against yourself');
    expect(rejectCopy('price_moved')).toContain('Requote');
    expect(rejectCopy('insufficient_funds', 'You have G$412; this costs G$500.')).toBe(
      'You have G$412; this costs G$500.',
    );
    expect(rejectCopy('unknown_code')).toBe('Order rejected.');
  });
});
