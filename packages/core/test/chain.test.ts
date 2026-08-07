import { describe, expect, it } from 'vitest';
import {
  GENESIS_HASH,
  appendLink,
  canonicalize,
  hashLink,
  linkPreimage,
  verifyChain,
  type ChainLink,
} from '../src/chain';

async function build(payloads: Record<string, unknown>[]): Promise<ChainLink[]> {
  const links: ChainLink[] = [];
  let head: ChainLink | null = null;
  for (const p of payloads) {
    head = await appendLink(head, p);
    links.push(head);
  }
  return links;
}

const sample = [
  { kind: 'fill', orderId: 'a', qty: 10, price: 41 },
  { kind: 'fill', orderId: 'b', qty: 5, price: 62 },
  { kind: 'settlement', positionId: 'a', payout: 10 },
];

describe('canonicalize', () => {
  it('is independent of key order', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
  });

  it('sorts keys at every depth', () => {
    expect(canonicalize({ x: { d: 1, c: 2 } })).toBe(canonicalize({ x: { c: 2, d: 1 } }));
  });

  it('normalizes equal numbers written differently', () => {
    expect(canonicalize({ n: 1.1 })).toBe(canonicalize({ n: 1.1000000 }));
    expect(canonicalize({ n: 10 })).toBe(canonicalize({ n: 10.0 }));
  });

  it('does not confuse a number with its string', () => {
    expect(canonicalize({ n: 1 })).not.toBe(canonicalize({ n: '1' }));
  });

  it('handles arrays, null and non-finite numbers', () => {
    expect(canonicalize([1, 'a', null])).toBe('[1,"a",null]');
    expect(canonicalize({ n: Number.NaN })).toBe('{"n":null}');
    expect(canonicalize(null)).toBe('null');
  });
});

describe('hashLink', () => {
  it('is deterministic', async () => {
    const a = await hashLink(0, GENESIS_HASH, { x: 1 });
    const b = await hashLink(0, GENESIS_HASH, { x: 1 });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when anything in the link changes', async () => {
    const base = await hashLink(0, GENESIS_HASH, { x: 1 });
    expect(await hashLink(1, GENESIS_HASH, { x: 1 })).not.toBe(base);
    expect(await hashLink(0, 'f'.repeat(64), { x: 1 })).not.toBe(base);
    expect(await hashLink(0, GENESIS_HASH, { x: 2 })).not.toBe(base);
  });

  it('exposes a preimage the SQL side can reproduce byte for byte', () => {
    expect(linkPreimage(3, 'ab', { b: 2, a: 1 })).toBe('v1|3|ab|{"a":1,"b":2}');
  });
});

describe('verifyChain', () => {
  it('accepts an untouched chain and reports its head', async () => {
    const links = await build(sample);
    const v = await verifyChain(links);
    expect(v.ok).toBe(true);
    expect(v.brokenAt).toBe(-1);
    expect(v.length).toBe(3);
    expect(v.head).toBe(links[2]!.hash);
  });

  it('accepts an empty chain', async () => {
    const v = await verifyChain([]);
    expect(v.ok).toBe(true);
    expect(v.head).toBe(GENESIS_HASH);
  });

  it('catches an edited entry and names which one', async () => {
    const links = await build(sample);
    // Inflate a fill's quantity — the classic "just type a bigger number" cheat.
    links[1]!.payload = { ...links[1]!.payload, qty: 9999 };

    const v = await verifyChain(links);
    expect(v.ok).toBe(false);
    expect(v.brokenAt).toBe(1);
    expect(v.reason).toContain('edited after it was written');
  });

  it('catches a deleted entry', async () => {
    const links = await build(sample);
    links.splice(1, 1);
    links[1]!.seq = 1; // renumber, as a naive tamper would

    const v = await verifyChain(links);
    expect(v.ok).toBe(false);
    expect(v.brokenAt).toBe(1);
  });

  it('catches reordering', async () => {
    const links = await build(sample);
    const swapped = [links[0]!, links[2]!, links[1]!];
    const v = await verifyChain(swapped);
    expect(v.ok).toBe(false);
  });

  it('catches an entry spliced onto the end with a forged predecessor', async () => {
    const links = await build(sample);
    links.push({
      seq: 3,
      prevHash: 'd'.repeat(64), // not the real head
      hash: 'e'.repeat(64),
      payload: { kind: 'fill', orderId: 'fake', qty: 1e9, price: 1 },
    });

    const v = await verifyChain(links);
    expect(v.ok).toBe(false);
    expect(v.brokenAt).toBe(3);
    expect(v.reason).toContain('does not point at the previous entry');
  });

  it('catches a sequence gap', async () => {
    const links = await build(sample);
    links[2]!.seq = 7;
    const v = await verifyChain(links);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('sequence jumped');
  });

  /**
   * The honest limitation, pinned as a test so nobody later mistakes the chain
   * for proof of truthfulness: a cheat who controls the whole history can
   * rebuild a consistent chain from forged numbers. This is exactly why the
   * leaderboard's links are minted server-side from a stored book snapshot.
   */
  it('cannot detect a wholly rebuilt chain — which is why the server mints links', async () => {
    const forged = await build([
      { kind: 'fill', orderId: 'a', qty: 999999, price: 1 },
      { kind: 'settlement', positionId: 'a', payout: 999999 },
    ]);
    const v = await verifyChain(forged);
    expect(v.ok).toBe(true);
    // Internally consistent, and still not the chain the server holds.
    const honest = await build(sample);
    expect(v.head).not.toBe((await verifyChain(honest)).head);
  });
});
