import { describe, expect, it } from 'vitest';
import { checkBookInvariants, isSortedBestFirst, walkBook } from '@polyfill/core';
import { normalizeLadder } from '../src/polymarket';

/**
 * Captured live from clob.polymarket.com for the YES/NO token pair of
 * "Strait of Hormuz traffic returns to normal by August 31?".
 *
 * The ordering is the trap: `bids` ASCEND to the best bid at the end of the
 * array and `asks` DESCEND to the best ask at the end. Reading either as
 * best-first inverts the entire book.
 */
const YES_BOOK = {
  timestamp: '1786054113846',
  bids: [
    { price: '0.10', size: '65144.3' },
    { price: '0.11', size: '86163' },
    { price: '0.12', size: '14476.45' },
  ],
  asks: [
    { price: '0.15', size: '61528.15' },
    { price: '0.14', size: '36163.69' },
    { price: '0.13', size: '3009.62' },
  ],
};

const NO_BOOK = {
  timestamp: '1786054113846',
  bids: [
    { price: '0.85', size: '61528.15' },
    { price: '0.86', size: '36163.69' },
    { price: '0.87', size: '3009.62' },
  ],
  asks: [
    { price: '0.90', size: '65144.3' },
    { price: '0.89', size: '86163' },
    { price: '0.88', size: '14476.45' },
  ],
};

describe('normalizeLadder — undoing worst-first ordering', () => {
  const yes = normalizeLadder(YES_BOOK);
  const no = normalizeLadder(NO_BOOK);

  it('puts the best bid and best ask first', () => {
    expect(yes.bids[0]).toEqual([12, 14476.45]);
    expect(yes.asks[0]).toEqual([13, 3009.62]);
    expect(no.bids[0]).toEqual([87, 3009.62]);
    expect(no.asks[0]).toEqual([88, 14476.45]);
  });

  it('sorts every ladder best-first', () => {
    expect(isSortedBestFirst(yes.bids, 'bids')).toBe(true);
    expect(isSortedBestFirst(yes.asks, 'asks')).toBe(true);
    expect(isSortedBestFirst(no.bids, 'bids')).toBe(true);
    expect(isSortedBestFirst(no.asks, 'asks')).toBe(true);
  });

  it('satisfies the mirror invariants against the independently-fetched NO book', () => {
    // This is the strong check: the NO book here was fetched separately from
    // the venue, not derived. Agreement proves the parse is right.
    const r = checkBookInvariants(yes, no);
    expect(r.violations).toEqual([]);
    expect(r.checked).toBe(4);
  });

  it('produces a sane fill when walked', () => {
    const r = walkBook(yes.asks, { kind: 'qty', qty: 5000 });
    // 3009.62 @ 13c, then 1990.38 @ 14c
    expect(r.totalQty).toBe(5000);
    expect(r.avgPrice).toBeGreaterThan(13);
    expect(r.avgPrice).toBeLessThan(14);
    expect(r.levelsConsumed).toBe(2);
  });

  it('would produce a catastrophically wrong fill if the raw order were trusted', () => {
    // Guard against a regression that drops the sort: walking the raw ask array
    // as given starts at 15c instead of 13c — a 15% mispricing on every buy.
    const raw = YES_BOOK.asks.map((a) => [Number(a.price) * 100, Number(a.size)] as [number, number]);
    const naive = walkBook(raw, { kind: 'qty', qty: 100 });
    const correct = walkBook(yes.asks, { kind: 'qty', qty: 100 });
    expect(naive.avgPrice).toBeGreaterThan(correct.avgPrice);
    expect(correct.avgPrice).toBe(13);
  });

  it('drops junk levels and handles an empty book', () => {
    const l = normalizeLadder({
      bids: [
        { price: '0', size: '100' },
        { price: '1.0', size: '100' },
        { price: '0.50', size: '0' },
        { price: '0.42', size: '7' },
      ],
      asks: [],
    });
    expect(l.bids).toEqual([[42, 7]]);
    expect(l.asks).toEqual([]);
    expect(normalizeLadder({}).bids).toEqual([]);
  });
});
