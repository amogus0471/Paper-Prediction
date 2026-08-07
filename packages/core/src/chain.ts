/**
 * Tamper-evident ledger — a hash chain over every balance-changing event.
 *
 * WHAT THIS ACTUALLY BUYS YOU, precisely, because it is easy to overclaim:
 *
 * Each link commits to the hash of the one before it, so altering any historical
 * entry changes that link's hash, which breaks every link after it. You cannot
 * quietly edit trade #4 of 200 and leave the rest standing. `verifyChain` finds
 * the first break and names it.
 *
 * What it does NOT buy you on its own: if the client both produces the numbers
 * and computes the chain, a cheat just recomputes the whole chain from its
 * forged history and it verifies perfectly. A hash chain proves *internal
 * consistency*, not *truthfulness*.
 *
 * So the guarantee comes from where the links are MINTED, not from the hashing:
 *
 *   - On the leaderboard path the server prices every fill from a stored order
 *     book snapshot and appends the link itself. The client never sends a
 *     price, a quantity, or a P&L — only intent. A forged local chain is simply
 *     not the chain the server holds, and the server's is the one that ranks.
 *   - Postgres refuses any link whose `prev_hash` is not the current head, so
 *     entries cannot be back-dated, reordered, or spliced out even by something
 *     holding service_role.
 *   - Locally the chain is tamper-EVIDENCE: edit chrome.storage.local by hand
 *     and the app tells you the record is broken. That is honest and useful,
 *     and it is not a claim that solo numbers are trustworthy to anyone else.
 *
 * A distributed-consensus blockchain would add nothing here: there is one
 * writer whose honesty is the entire question, and consensus among replicas of
 * that writer does not make it honest.
 */

/** One link. `hash` covers `seq`, `prevHash` and the canonical payload. */
export interface ChainLink {
  seq: number;
  prevHash: string;
  hash: string;
  /** Preimage format this link was written under. Absent means v1. */
  version?: number;
  /** What happened. Must serialize canonically — see `canonicalize`. */
  payload: Record<string, unknown>;
}

/** The chain's anchor: 64 zeroes, so link 0 has a well-defined predecessor. */
export const GENESIS_HASH = '0'.repeat(64);

/**
 * Deterministic JSON.
 *
 * `JSON.stringify` preserves insertion order, so two objects with identical
 * contents but different key order hash differently — which would make a chain
 * fail to verify for no real reason. Keys are sorted at every depth, and
 * numbers are normalized so 1.10 and 1.1 agree.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return 'null';
      // Strip trailing zeroes so 1.10 and 1.1 produce the same bytes.
      return JSON.stringify(Number(value.toFixed(8)));
    }
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(',')}}`;
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Current preimage format. Bump only alongside a `linkPreimage` case. */
export const CHAIN_VERSION = 1;

/**
 * The exact bytes a link commits to.
 *
 * Note the VERSION DISPATCH rather than a constant. A chain that was written
 * under v1 rules must keep re-hashing under v1 rules forever, because a real
 * chain SPANS an upgrade: v1 links sitting directly beside v2 links in the same
 * user's history. Writing `CHAIN_VERSION` here instead of the link's own
 * version would silently invalidate every chain in existence the moment the
 * format moved — including ones already submitted to the leaderboard.
 *
 * A missing version means the original format, so links written before this
 * field existed still verify.
 */
export function linkPreimage(
  seq: number,
  prevHash: string,
  payload: Record<string, unknown>,
  version = CHAIN_VERSION,
): string {
  switch (Number(version) || 1) {
    case 1:
    default:
      return `v1|${seq}|${prevHash}|${canonicalize(payload)}`;
  }
}

export async function hashLink(
  seq: number,
  prevHash: string,
  payload: Record<string, unknown>,
  version = CHAIN_VERSION,
): Promise<string> {
  return sha256Hex(linkPreimage(seq, prevHash, payload, version));
}

/** Append to a chain, given its current head. */
export async function appendLink(
  head: ChainLink | null,
  payload: Record<string, unknown>,
): Promise<ChainLink> {
  const seq = head ? head.seq + 1 : 0;
  const prevHash = head ? head.hash : GENESIS_HASH;
  return {
    seq,
    prevHash,
    version: CHAIN_VERSION,
    hash: await hashLink(seq, prevHash, payload, CHAIN_VERSION),
    payload,
  };
}

export interface ChainVerdict {
  ok: boolean;
  length: number;
  /** Index of the first bad link, or -1. */
  brokenAt: number;
  reason?: string;
  /** Hash of the last valid link — the value to compare against a server head. */
  head: string;
}

/**
 * Walk a chain and find the first break.
 *
 * Reports the index rather than just a boolean, because "your record was
 * altered at trade 47" is actionable and "invalid" is not.
 */
export async function verifyChain(links: ChainLink[]): Promise<ChainVerdict> {
  let prevHash = GENESIS_HASH;

  for (let i = 0; i < links.length; i++) {
    const link = links[i]!;

    if (link.seq !== i) {
      return { ok: false, length: links.length, brokenAt: i, reason: `sequence jumped: expected ${i}, found ${link.seq}`, head: prevHash };
    }
    if (link.prevHash !== prevHash) {
      return { ok: false, length: links.length, brokenAt: i, reason: 'link does not point at the previous entry — an entry was inserted, removed or reordered', head: prevHash };
    }

    // Re-hash under the rules this link was WRITTEN with, not today's.
    const expected = await hashLink(link.seq, link.prevHash, link.payload, link.version ?? 1);
    if (expected !== link.hash) {
      return { ok: false, length: links.length, brokenAt: i, reason: 'entry contents do not match their hash — this entry was edited after it was written', head: prevHash };
    }

    prevHash = link.hash;
  }

  return { ok: true, length: links.length, brokenAt: -1, head: prevHash };
}

/**
 * The payload for a fill. Only fields the SERVER controls go in — a client
 * cannot alter what it never supplies.
 *
 * Note what is absent: nothing the extension typed. Price, quantity and cost
 * are all derived server-side by walking `snapshotId`, so the chain commits to
 * a fill that is independently reproducible from a stored book.
 */
export interface FillLinkPayload extends Record<string, unknown> {
  kind: 'fill';
  orderId: string;
  marketId: string;
  side: string;
  outcome: string;
  qty: number;
  price: number;
  cost: number;
  fee: number;
  /** The book this was priced against. The whole audit trail hangs off this. */
  snapshotId: number;
  balanceAfter: number;
  serverTs: string;
}

export interface SettlementLinkPayload extends Record<string, unknown> {
  kind: 'settlement';
  positionId: string;
  marketId: string;
  resolution: string | null;
  payout: number;
  realized: number;
  balanceAfter: number;
  serverTs: string;
}

export type LedgerPayload = FillLinkPayload | SettlementLinkPayload;
