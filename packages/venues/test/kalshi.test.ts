import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { checkBookInvariants, isSortedBestFirst } from '@ghostfill/core';
import { normalizeKalshiBook } from '../src/kalshi';
import type { RawOrderbookResponse } from '../src/kalshi';
import { dollarsStringToCents, sizeStringToQty, parseJsonArray, num } from '../src/decimal-parse';

/**
 * Captured live from api.elections.kalshi.com on KXELONMARS-99.
 * Note the shape: bid ladders only, worst-first, prices as dollar strings and
 * element 1 as a CONTRACT COUNT.
 */
const LIVE_FIXTURE: RawOrderbookResponse = {
  orderbook_fp: {
    no_dollars: [
      ['0.7300', '38.73'],
      ['0.7600', '150.00'],
      ['0.7800', '264.32'],
      ['0.8500', '500.00'],
      ['0.8600', '10.00'],
      ['0.8700', '907.44'],
      ['0.8800', '271.81'],
      ['0.8900', '165.20'],
    ],
    yes_dollars: [
      ['0.0200', '507.17'],
      ['0.0300', '18458.00'],
      ['0.0400', '601.77'],
      ['0.0500', '49.00'],
      ['0.0600', '2226.98'],
      ['0.0700', '3195.84'],
      ['0.0800', '753.00'],
      ['0.0900', '1036.88'],
    ],
  },
};

describe('exact decimal parsing', () => {
  it('parses dollar strings to cents with no float drift', () => {
    expect(dollarsStringToCents('0.1500')).toBe(15);
    expect(dollarsStringToCents('0.0900')).toBe(9);
    expect(dollarsStringToCents('0.07')).toBe(7);
    expect(dollarsStringToCents('0.075')).toBe(7.5);
    expect(dollarsStringToCents('1')).toBe(100);
    expect(dollarsStringToCents('1.0000')).toBe(100);
    expect(dollarsStringToCents('0.9999')).toBe(99.99);
  });

  it('is exact where parseFloat would drift', () => {
    // The classic: 0.29 * 100 is 28.999999999999996 in IEEE 754.
    expect(dollarsStringToCents('0.29')).toBe(29);
    expect(dollarsStringToCents('0.57')).toBe(57);
    expect(dollarsStringToCents('0.83')).toBe(83);
    for (let c = 1; c <= 99; c++) {
      const asDollars = (c / 100).toFixed(4);
      expect(dollarsStringToCents(asDollars)).toBe(c);
    }
  });

  it('rejects junk instead of coercing it to zero', () => {
    expect(dollarsStringToCents('')).toBeNull();
    expect(dollarsStringToCents('abc')).toBeNull();
    expect(dollarsStringToCents(null)).toBeNull();
    expect(dollarsStringToCents(undefined)).toBeNull();
  });

  it('parses sizes as counts', () => {
    expect(sizeStringToQty('100.00')).toBe(100);
    expect(sizeStringToQty('18458.00')).toBe(18458);
    expect(sizeStringToQty('3009.62')).toBe(3009.62);
    expect(sizeStringToQty('bad')).toBeNull();
  });

  it('unwraps Polymarket JSON-in-JSON arrays', () => {
    expect(parseJsonArray('["Yes", "No"]')).toEqual(['Yes', 'No']);
    expect(parseJsonArray(['a', 'b'])).toEqual(['a', 'b']);
    expect(parseJsonArray('not json')).toEqual([]);
    expect(parseJsonArray(null)).toEqual([]);
  });

  it('reads tolerant numerics', () => {
    expect(num('12.5')).toBe(12.5);
    expect(num(12.5)).toBe(12.5);
    expect(num('')).toBeUndefined();
    expect(num(null)).toBeUndefined();
    expect(num(Number.NaN)).toBeUndefined();
  });
});

describe('normalizeKalshiBook — bid-only ladders in, four ladders out', () => {
  const { yes, no } = normalizeKalshiBook(LIVE_FIXTURE);

  it('reads element 1 as a size, not a price', () => {
    // Best yes bid is 9c with 1036.88 contracts behind it. If element 1 were
    // misread as a price, this would be nonsense.
    expect(yes.bids[0]).toEqual([9, 1036.88]);
    expect(no.bids[0]).toEqual([89, 165.2]);
  });

  it('synthesizes both ask ladders from the opposite side’s bids', () => {
    // Best no bid 89c => best yes ask 11c, same size.
    expect(yes.asks[0]).toEqual([11, 165.2]);
    // Best yes bid 9c => best no ask 91c, same size.
    expect(no.asks[0]).toEqual([91, 1036.88]);
  });

  it('matches the venue’s own quoted top-of-book', () => {
    // Kalshi independently reported yes_ask_dollars 0.1100 and
    // no_ask_dollars 0.9100 for this market. Our synthesis agrees.
    expect(yes.asks[0]![0]).toBe(11);
    expect(no.asks[0]![0]).toBe(91);
    expect(yes.bids[0]![0]).toBe(9);
    expect(no.bids[0]![0]).toBe(89);
  });

  it('sorts every ladder best-first, undoing the venue’s worst-first order', () => {
    expect(isSortedBestFirst(yes.bids, 'bids')).toBe(true);
    expect(isSortedBestFirst(no.bids, 'bids')).toBe(true);
    expect(isSortedBestFirst(yes.asks, 'asks')).toBe(true);
    expect(isSortedBestFirst(no.asks, 'asks')).toBe(true);
  });

  it('satisfies the mirror invariants', () => {
    const r = checkBookInvariants(yes, no);
    expect(r.violations).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.checked).toBe(4);
  });

  it('preserves total depth through the mirror', () => {
    const yesBidQty = yes.bids.reduce((s, l) => s + l[1], 0);
    const noAskQty = no.asks.reduce((s, l) => s + l[1], 0);
    expect(noAskQty).toBeCloseTo(yesBidQty, 6);
  });

  it('handles an empty book without inventing liquidity', () => {
    const { yes: y, no: n } = normalizeKalshiBook({ orderbook_fp: { yes_dollars: [], no_dollars: [] } });
    expect(y.bids).toEqual([]);
    expect(y.asks).toEqual([]);
    expect(n.bids).toEqual([]);
    expect(checkBookInvariants(y, n).checked).toBe(0);
  });

  it('accepts the legacy `orderbook` key so a venue rollback cannot break ingestion', () => {
    const { yes: y } = normalizeKalshiBook({ orderbook: { yes: [['0.5000', '10']], no: [['0.4000', '20']] } });
    expect(y.bids[0]).toEqual([50, 10]);
    expect(y.asks[0]).toEqual([60, 20]);
  });

  it('drops malformed and out-of-range levels', () => {
    const { yes: y } = normalizeKalshiBook({
      orderbook_fp: {
        yes_dollars: [
          ['0.0000', '100'],
          ['1.0000', '100'],
          ['bad', '100'],
          ['0.5000', '0'],
          ['0.4200', '7'],
        ] as [string, string][],
        no_dollars: [],
      },
    });
    expect(y.bids).toEqual([[42, 7]]);
  });

  it('holds the mirror invariant for every book fast-check can build', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 49 }), { minLength: 1, maxLength: 10 }),
        fc.array(fc.integer({ min: 51, max: 99 }), { minLength: 1, maxLength: 10 }),
        (yesCents, noCentsRaw) => {
          const uniq = (xs: number[]) => [...new Set(xs)].sort((a, b) => a - b);
          // NO bids mirror to YES asks, so keep them above the YES bids to
          // avoid generating a crossed (arbitrage-able) book.
          const yesLevels = uniq(yesCents).map((c) => [(c / 100).toFixed(4), '100'] as [string, string]);
          const noLevels = uniq(noCentsRaw).map((c) => [(c / 100).toFixed(4), '100'] as [string, string]);

          const { yes: y, no: n } = normalizeKalshiBook({
            orderbook_fp: { yes_dollars: yesLevels, no_dollars: noLevels },
          });
          expect(checkBookInvariants(y, n).ok).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });
});
