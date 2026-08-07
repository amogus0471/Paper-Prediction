import {
  computeFee as coreComputeFee,
  roundPrice,
  type Ladder,
  type Level,
  type NormalizedBook,
  type OrderSide,
} from '@polyfill/core';
import { dollarsStringToCents, sizeStringToQty } from './decimal-parse';
import { mapConcurrent, venueFetch } from './http';
import type {
  BookRef,
  Candle,
  Interval,
  NormalizedEvent,
  NormalizedMarket,
  Resolution,
  VenueAdapter,
} from './types';
import { VenueError } from './types';

const API = 'https://api.hyperliquid.xyz';

/**
 * Hyperliquid HIP-4 adapter — outcome (prediction) markets.
 *
 * These are the same instrument Polymarket and Kalshi trade: binary, YES/NO,
 * fully collateralised, settling to 1 or 0. So `walkBook`, `settlePosition` and
 * the Brier scoring all apply unchanged. (Hyperliquid's *perps* are a different
 * instrument entirely — leverage, funding, liquidation, no $1/$0 settlement —
 * and are deliberately not touched here.)
 *
 * Everything is `POST /info` with a JSON body, and reads need no auth.
 *
 * THE NON-OBVIOUS PART — the asset id. `l2Book` rejects the outcome number, a
 * ticker, and `@index` alike, returning `null` rather than an error, so a wrong
 * guess looks like an empty market instead of a bug. The real convention is only
 * discoverable through `allMids`: `#{outcome}{sideIndex}`, e.g. outcome 1025
 * side 0 (Yes) is `"#10250"` and side 1 (No) is `"#10251"`. That is string
 * CONCATENATION, not arithmetic — outcome 1026 gives `#10260`, so the ids are
 * not sequential integers and must never be computed by adding.
 */
export class HyperliquidAdapter implements VenueAdapter {
  readonly code = 'hyperliquid' as const;
  readonly displayName = 'Hyperliquid';
  readonly unitNoun = 'contracts';

  private async info<T>(body: Record<string, unknown>): Promise<T> {
    return venueFetch<T>(this.code, `${API}/info`, { method: 'POST', body });
  }

  /**
   * All outcome markets, grouped into events.
   *
   * A HIP-4 `question` is a multi-bucket grouping whose `namedOutcomes` are the
   * tradeable binaries, which maps exactly onto our event → sibling-markets
   * shape. Standalone outcomes become single-market events.
   */
  async listEvents(): Promise<{ events: NormalizedEvent[]; next?: string }> {
    const meta = await this.info<RawOutcomeMeta>({ type: 'outcomeMeta' });
    const mids = await this.info<Record<string, string>>({ type: 'allMids' });

    const byId = new Map<number, RawOutcome>();
    for (const o of meta.outcomes ?? []) byId.set(o.outcome, o);

    const grouped = new Set<number>();
    const events: NormalizedEvent[] = [];

    for (const q of meta.questions ?? []) {
      const ids = q.namedOutcomes ?? [];
      const markets: NormalizedMarket[] = [];
      for (const id of ids) {
        const o = byId.get(id);
        if (!o) continue;
        grouped.add(id);
        markets.push(this.toMarket(o, mids, String(q.question), parseSpec(q.description)));
      }
      if (markets.length === 0) continue;

      const spec = parseSpec(q.description);
      events.push({
        venue: this.code,
        venueEventId: `q${q.question}`,
        title: describe(spec, q.description),
        category: categorize(spec),
        isActive: true,
        ...(spec.expiry ? { closeTime: spec.expiry } : {}),
        markets,
      });
    }

    // Anything not inside a question stands alone.
    for (const o of meta.outcomes ?? []) {
      if (grouped.has(o.outcome)) continue;
      const spec = parseSpec(o.description);
      events.push({
        venue: this.code,
        venueEventId: `o${o.outcome}`,
        title: describe(spec, o.description),
        category: categorize(spec),
        isActive: true,
        ...(spec.expiry ? { closeTime: spec.expiry } : {}),
        markets: [this.toMarket(o, mids)],
      });
    }

    return { events };
  }

  async getMarkets(ids: string[]): Promise<NormalizedMarket[]> {
    if (ids.length === 0) return [];
    const { events } = await this.listEvents();
    const wanted = new Set(ids);
    return events.flatMap((e) => e.markets).filter((m) => wanted.has(m.venueMarketId));
  }

  /**
   * Both sides, in parallel.
   *
   * Unlike Kalshi, both YES and NO are genuinely quoted books here — nothing is
   * synthesized. The mirror still holds exactly (verified live: YES bid 0.86617
   * against NO ask 0.13383), and `checkBookInvariants` re-proves it per snapshot.
   */
  async getOrderBook(ref: BookRef): Promise<NormalizedBook> {
    if (ref.venue !== 'hyperliquid') {
      throw new VenueError(this.code, 0, 'wrong adapter for book ref');
    }

    const [yesRaw, noRaw] = await Promise.all([
      this.info<RawBook | null>({ type: 'l2Book', coin: ref.yesCoin }),
      this.info<RawBook | null>({ type: 'l2Book', coin: ref.noCoin }),
    ]);

    return {
      marketId: ref.yesCoin,
      capturedAt: new Date(yesRaw?.time ?? noRaw?.time ?? Date.now()),
      yes: toLadder(yesRaw),
      no: toLadder(noRaw),
    };
  }

  async getOrderBooks(refs: BookRef[]): Promise<Map<string, NormalizedBook>> {
    const out = new Map<string, NormalizedBook>();
    const books = await mapConcurrent(refs, 6, async (ref) => {
      try {
        return { ref, book: await this.getOrderBook(ref) };
      } catch {
        return null;
      }
    });
    for (const e of books) {
      if (e && e.ref.venue === 'hyperliquid') out.set(e.ref.yesCoin, e.book);
    }
    return out;
  }

  /** No candle endpoint for outcome assets yet, and inventing one would lie. */
  async getPriceHistory(_ref: BookRef, _from: Date, _to: Date, _i: Interval): Promise<Candle[]> {
    return [];
  }

  async getResolutions(ids: string[]): Promise<Resolution[]> {
    const meta = await this.info<RawOutcomeMeta>({ type: 'outcomeMeta' });
    // A settled outcome leaves `outcomes` and appears in its question's
    // `settledNamedOutcomes`. Absence alone is not proof of a result, so an id
    // we can no longer see resolves to `null` (void) rather than a guess.
    const settled = new Set<number>();
    for (const q of meta.questions ?? []) {
      for (const id of q.settledNamedOutcomes ?? []) settled.add(id);
    }
    const live = new Set((meta.outcomes ?? []).map((o) => String(o.outcome)));

    return ids.map((id) => {
      const num = Number(id.replace(/^#/, '').slice(0, -1));
      if (live.has(String(num))) {
        return { venueMarketId: id, status: 'open' as const, resolution: null };
      }
      return {
        venueMarketId: id,
        status: settled.has(num) ? ('resolved' as const) : ('closed' as const),
        resolution: null,
      };
    });
  }

  /** HIP-4 charges nothing to open a position: the cost is purely the spread. */
  computeFee(qty: number, priceCents: number, side: OrderSide, multiplier = 1): number {
    return coreComputeFee({ kind: 'none' }, qty, priceCents, side, multiplier);
  }

  private toMarket(
    o: RawOutcome,
    mids: Record<string, string>,
    eventId?: string,
    parent?: Spec,
  ): NormalizedMarket {
    const spec = parseSpec(o.description);
    const yesCoin = coinFor(o.outcome, 0);
    const noCoin = coinFor(o.outcome, 1);
    const yesMid = dollarsStringToCents(mids[yesCoin]);

    return {
      venue: this.code,
      venueEventId: eventId ?? `o${o.outcome}`,
      venueMarketId: yesCoin,
      question: bucketName(o.description, parent) ?? describe(spec, o.description),
      yesLabel: o.sideSpecs?.[0]?.name ?? 'Yes',
      noLabel: o.sideSpecs?.[1]?.name ?? 'No',
      status: 'open',
      ...(yesMid != null ? { midPrice: yesMid, lastPrice: yesMid } : {}),
      volume24h: 0,
      volumeTotal: 0,
      // Prices float in (0.001, 0.999), i.e. a tenth of a cent.
      tickCents: 0.1,
      minOrderSize: 1,
      ...(spec.expiry ? { closeTime: spec.expiry } : {}),
      bookRef: { venue: 'hyperliquid', yesCoin, noCoin },
    };
  }
}

/** `#{outcome}{side}` — concatenation, never arithmetic. See the class docs. */
export function coinFor(outcome: number, side: 0 | 1): string {
  return `#${outcome}${side}`;
}

function toLadder(raw: RawBook | null | undefined): Ladder {
  const bids = levels(raw?.levels?.[0]);
  const asks = levels(raw?.levels?.[1]);
  // These arrive best-first already, unlike the other two venues. Sorted anyway,
  // so a future ordering change cannot silently invert every book.
  return {
    bids: bids.sort((a, b) => b[0] - a[0]),
    asks: asks.sort((a, b) => a[0] - b[0]),
  };
}

function levels(rows: RawLevel[] | undefined): Level[] {
  const out: Level[] = [];
  for (const r of rows ?? []) {
    const price = dollarsStringToCents(r.px);
    const size = sizeStringToQty(r.sz);
    if (price == null || size == null) continue;
    if (!(price > 0) || !(price < 100) || !(size > 0)) continue;
    out.push([roundPrice(price), size]);
  }
  return out;
}

interface Spec {
  class?: string;
  underlying?: string;
  targetPrice?: number;
  priceThresholds?: number[];
  expiry?: Date;
  period?: string;
}

/**
 * `description` is pipe-delimited key:value pairs, not prose:
 *   "class:priceBinary|underlying:BTC|expiry:20260808-0600|targetPrice:64306"
 * Showing it raw to a user would be unreadable, so it gets parsed and rendered.
 */
function parseSpec(description: string | undefined): Spec {
  const spec: Spec = {};
  for (const part of (description ?? '').split('|')) {
    const at = part.indexOf(':');
    if (at < 0) continue;
    const k = part.slice(0, at);
    const v = part.slice(at + 1);
    if (k === 'class') spec.class = v;
    else if (k === 'underlying') spec.underlying = v;
    else if (k === 'period') spec.period = v;
    else if (k === 'targetPrice') spec.targetPrice = Number(v);
    else if (k === 'priceThresholds') spec.priceThresholds = v.split(',').map(Number);
    else if (k === 'expiry') spec.expiry = parseExpiry(v);
  }
  return spec;
}

/** `20260808-0600` -> Date (UTC). */
function parseExpiry(v: string): Date | undefined {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(v);
  if (!m) return undefined;
  const d = new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])),
  );
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** Turn a spec into a question a person can read. */
function describe(spec: Spec, fallback: string | undefined): string {
  const when = spec.expiry
    ? spec.expiry.toLocaleString('en-GB', {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'UTC',
      }) + ' UTC'
    : null;

  if (spec.underlying && spec.targetPrice != null) {
    const price = spec.targetPrice.toLocaleString('en-US', { maximumFractionDigits: 2 });
    return `Will ${spec.underlying} be above $${price}${when ? ` at ${when}` : ''}?`;
  }
  if (spec.underlying && spec.priceThresholds?.length) {
    const t = spec.priceThresholds.map((n) => `$${n.toLocaleString('en-US')}`).join(' / ');
    return `Where will ${spec.underlying} settle${when ? ` at ${when}` : ''}? (${t})`;
  }
  if (spec.underlying) return `${spec.underlying}${when ? ` — ${when}` : ''}`;
  return fallback ?? 'Outcome market';
}

/**
 * Name a bucket outcome from its parent question.
 *
 * A bucket describes itself only as "index:0", which is meaningless alone —
 * the thresholds live on the question. Without this, three of Hyperliquid's
 * markets render as "index:0", "index:1", "index:2" and cannot be told apart.
 */
function bucketName(description: string | undefined, parent: Spec | undefined): string | null {
  const m = /^index:(\d+)$/.exec((description ?? '').trim());
  if (!m || !parent?.priceThresholds?.length) return null;

  const i = Number(m[1]);
  const t = parent.priceThresholds;
  const asset = parent.underlying ?? 'it';
  const money = (n: number) => '$' + n.toLocaleString('en-US');

  // n thresholds produce n+1 buckets: below the first, between each pair, and
  // above the last.
  if (i === 0) return `Will ${asset} settle below ${money(t[0]!)}?`;
  if (i >= t.length) return `Will ${asset} settle above ${money(t[t.length - 1]!)}?`;
  return `Will ${asset} settle between ${money(t[i - 1]!)} and ${money(t[i]!)}?`;
}

function categorize(spec: Spec): string {
  const u = (spec.underlying ?? '').toUpperCase();
  if (/BTC|ETH|SOL|HYPE|DOGE|XRP/.test(u)) return 'crypto';
  if (/CPI|FED|GDP|JOBS|NFP/.test(u)) return 'economics';
  return 'other';
}

// ── Raw API shapes ──────────────────────────────────────────────────────────

interface RawLevel {
  px?: string;
  sz?: string;
  n?: number;
}

interface RawBook {
  coin?: string;
  time?: number;
  /** A two-element array: [bids, asks]. Not an object. */
  levels?: [RawLevel[], RawLevel[]];
}

interface RawOutcome {
  outcome: number;
  name?: string;
  description?: string;
  sideSpecs?: { name?: string }[];
  quoteToken?: string;
}

interface RawQuestion {
  question: number;
  description?: string;
  fallbackOutcome?: number;
  namedOutcomes?: number[];
  settledNamedOutcomes?: number[];
}

interface RawOutcomeMeta {
  outcomes?: RawOutcome[];
  questions?: RawQuestion[];
}
