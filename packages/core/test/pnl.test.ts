import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  EMPTY_POSITION,
  applyBuy,
  applySell,
  drawdownPct,
  equity,
  marketValue,
  returnPct,
  settlePosition,
  ticketMath,
  unrealizedPnl,
} from '../src/pnl';
import { computeFee, parseFeeModel, DEFAULT_FEE_MODELS } from '../src/fees';

describe('weighted average cost basis', () => {
  it('averages two entries at different prices', () => {
    let p = applyBuy(EMPTY_POSITION, 100, 60);
    p = applyBuy(p, 100, 80);
    expect(p.qty).toBe(200);
    expect(p.avgEntryPrice).toBe(70);
    expect(p.costBasis).toBeCloseTo(140, 4);
  });

  it('keeps the average entry price through a partial close', () => {
    let p = applyBuy(EMPTY_POSITION, 200, 70);
    const { position, realized } = applySell(p, 50, 90);
    expect(position.qty).toBe(150);
    expect(position.avgEntryPrice).toBe(70);
    // 50 shares, 20c gain each = G$10
    expect(realized).toBeCloseTo(10, 4);
    expect(position.costBasis).toBeCloseTo(105, 4);
  });

  it('charges fees against realized P&L rather than hiding them', () => {
    const p = applyBuy(EMPTY_POSITION, 100, 50);
    const { realized } = applySell(p, 100, 60, 2.5);
    expect(realized).toBeCloseTo(10 - 2.5, 4);
  });

  it('cannot sell more than it holds', () => {
    const p = applyBuy(EMPTY_POSITION, 10, 50);
    const { position, realized, proceeds } = applySell(p, 999, 60);
    expect(position.qty).toBe(0);
    expect(proceeds).toBeCloseTo(6, 4);
    expect(realized).toBeCloseTo(1, 4);
  });

  it('is a no-op on empty or non-positive operations', () => {
    expect(applyBuy(EMPTY_POSITION, 0, 50)).toBe(EMPTY_POSITION);
    const r = applySell(EMPTY_POSITION, 10, 50);
    expect(r.position).toBe(EMPTY_POSITION);
    expect(r.realized).toBe(0);
  });

  it('never loses money to rounding across a random buy/sell sequence', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            buy: fc.boolean(),
            qty: fc.integer({ min: 1, max: 500 }),
            price: fc.integer({ min: 1, max: 99 }),
          }),
          { minLength: 1, maxLength: 30 },
        ),
        (ops) => {
          let pos = EMPTY_POSITION;
          let cash = 0;
          for (const op of ops) {
            if (op.buy) {
              cash -= (op.qty * op.price) / 100;
              pos = applyBuy(pos, op.qty, op.price);
            } else {
              const r = applySell(pos, op.qty, op.price);
              cash += r.proceeds;
              pos = r.position;
            }
          }
          // The ledger identity: money out of pocket, plus what is still held
          // at cost, equals realized P&L. Residue comes only from rounding the
          // weighted average entry price, so allow a sub-cent per operation.
          const reconciled = cash + pos.costBasis - pos.realizedPnl;
          expect(Math.abs(reconciled)).toBeLessThan(0.01 * ops.length);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('marking and settlement', () => {
  it('marks unrealized P&L against the current book', () => {
    const p = applyBuy(EMPTY_POSITION, 100, 60);
    expect(unrealizedPnl(p, 75)).toBeCloseTo(15, 4);
    expect(unrealizedPnl(p, 40)).toBeCloseTo(-20, 4);
    expect(marketValue(p, 75)).toBeCloseTo(75, 4);
    expect(unrealizedPnl(EMPTY_POSITION, 75)).toBe(0);
  });

  it('pays $1 per contract to winners and nothing to losers', () => {
    const p = applyBuy(EMPTY_POSITION, 100, 60);
    expect(settlePosition(p, true)).toEqual({ payout: 100, realized: 40 });
    expect(settlePosition(p, false)).toEqual({ payout: 0, realized: -60 });
    expect(settlePosition(EMPTY_POSITION, true)).toEqual({ payout: 0, realized: 0 });
  });
});

describe('portfolio math', () => {
  it('computes equity, return and drawdown', () => {
    expect(equity(9000, 500, 250)).toBe(9750);
    expect(returnPct(11000, 10000)).toBe(10);
    expect(returnPct(11000, 0)).toBe(0);
    expect(drawdownPct(9000, 10000)).toBe(10);
    expect(drawdownPct(11000, 10000)).toBe(0);
    expect(drawdownPct(9000, 0)).toBe(0);
  });
});

describe('ticket math — what the user sees before committing', () => {
  it('computes cost, payout, profit and breakeven', () => {
    const t = ticketMath(100, 63, 0);
    expect(t.cost).toBeCloseTo(63, 4);
    expect(t.maxPayout).toBe(100);
    expect(t.maxProfit).toBeCloseTo(37, 4);
    expect(t.breakevenCents).toBeCloseTo(63, 4);
    expect(t.roiPct).toBeCloseTo(58.73, 1);
  });

  it('folds fees into breakeven so the displayed number is the honest one', () => {
    const t = ticketMath(100, 63, 1);
    expect(t.totalCost).toBeCloseTo(64, 4);
    expect(t.breakevenCents).toBeCloseTo(64, 4);
    expect(t.maxProfit).toBeCloseTo(36, 4);
  });

  it('degrades safely at zero quantity', () => {
    const t = ticketMath(0, 63, 0);
    expect(t.breakevenCents).toBe(0);
    expect(t.roiPct).toBe(0);
  });
});

describe('fee models', () => {
  it('charges Polymarket nothing', () => {
    expect(computeFee(DEFAULT_FEE_MODELS.polymarket!, 100, 63, 'buy')).toBe(0);
  });

  it("peaks Kalshi's quadratic fee at a coin flip and vanishes at the extremes", () => {
    const model = DEFAULT_FEE_MODELS.kalshi!;
    const atMid = computeFee(model, 100, 50, 'buy');
    const atEdge = computeFee(model, 100, 3, 'buy');
    expect(atMid).toBeGreaterThan(atEdge);
    // ceil(0.07 * 100 * 0.5 * 0.5) = ceil(1.75) -> 1.75 rounded up to the cent
    expect(atMid).toBeCloseTo(1.75, 2);
  });

  it('applies the realism multiplier and zeroes out instant mode', () => {
    const model = DEFAULT_FEE_MODELS.kalshi!;
    const base = computeFee(model, 100, 50, 'buy', 1);
    expect(computeFee(model, 100, 50, 'buy', 1.5)).toBeCloseTo(base * 1.5, 2);
    expect(computeFee(model, 100, 50, 'buy', 0)).toBe(0);
  });

  it('charges a bps model proportionally to notional', () => {
    const model = { kind: 'bps' as const, takerBps: 100, makerBps: 0 };
    expect(computeFee(model, 100, 50, 'buy')).toBeCloseTo(0.5, 4);
  });

  it('returns zero for degenerate inputs', () => {
    expect(computeFee(DEFAULT_FEE_MODELS.kalshi!, 0, 50, 'buy')).toBe(0);
    expect(computeFee(DEFAULT_FEE_MODELS.kalshi!, 100, 0, 'buy')).toBe(0);
  });

  it('parses fee models out of the venues table jsonb', () => {
    expect(parseFeeModel({ taker_bps: 10, maker_bps: 0 })).toMatchObject({ kind: 'bps', takerBps: 10 });
    expect(parseFeeModel({ kind: 'kalshi_quadratic', rate: 0.07 })).toMatchObject({
      kind: 'kalshi_quadratic',
      rate: 0.07,
    });
    expect(parseFeeModel(null)).toEqual({ kind: 'none' });
    expect(parseFeeModel({ note: 'free' })).toMatchObject({ kind: 'none', note: 'free' });
  });
});
