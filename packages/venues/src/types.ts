import type { Ladder, NormalizedBook, OrderSide, VenueCode } from '@polyfill/core';

export type { Ladder, NormalizedBook, VenueCode };

export type MarketStatus = 'open' | 'closed' | 'resolving' | 'resolved' | 'cancelled';
export type Interval = '1m' | '5m' | '1h' | '6h' | '1d' | '1w';

export interface NormalizedEvent {
  venue: VenueCode;
  venueEventId: string;
  seriesKey?: string;
  title: string;
  slug?: string;
  description?: string;
  category: string;
  subcategory?: string;
  imageUrl?: string;
  openTime?: Date;
  closeTime?: Date;
  isActive: boolean;
  raw?: unknown;
  markets: NormalizedMarket[];
}

export interface NormalizedMarket {
  venue: VenueCode;
  venueEventId: string;
  venueMarketId: string;
  question: string;
  slug?: string;
  /** The label the venue gives the YES side. Sports markets say "Lakers", not "Yes". */
  yesLabel: string;
  noLabel: string;
  /** Per-market artwork when the venue provides it. Kalshi does not. */
  imageUrl?: string;
  resolutionSource?: string;
  resolutionRules?: string;
  status: MarketStatus;

  /** All prices in CENTS, 0..100. */
  yesBid?: number;
  yesAsk?: number;
  noBid?: number;
  noAsk?: number;
  lastPrice?: number;
  midPrice?: number;
  price24hAgo?: number;

  volume24h?: number;
  volumeTotal?: number;
  openInterest?: number;
  liquidity?: number;

  tickCents: number;
  minOrderSize: number;

  openTime?: Date;
  closeTime?: Date;
  resolvedAt?: Date;
  resolution?: 'yes' | 'no';

  /** Venue-specific handles the adapter needs to fetch a book later. */
  bookRef: BookRef;
  raw?: unknown;
}

/**
 * What `getOrderBook` needs to actually reach the book.
 * Polymarket needs two ERC-1155 token ids; Kalshi needs a ticker.
 */
export type BookRef =
  | { venue: 'polymarket'; yesTokenId: string; noTokenId: string }
  | { venue: 'kalshi'; ticker: string }
  | { venue: 'hyperliquid'; yesCoin: string; noCoin: string };

export interface Candle {
  ts: Date;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface Resolution {
  venueMarketId: string;
  status: MarketStatus;
  /** Null when the market voided — a void is not a forecast error and must not score. */
  resolution: 'yes' | 'no' | null;
  resolvedAt?: Date;
  note?: string;
}

export interface Tick {
  venueMarketId: string;
  ts: Date;
  yesMid: number;
  yesBid?: number;
  yesAsk?: number;
  volume?: number;
}

export type Unsubscribe = () => void;

/**
 * One interface per venue. Adding Manifold or Limitless later should be a new
 * file, not a refactor — so nothing venue-specific may leak past this boundary.
 */
export interface VenueAdapter {
  readonly code: VenueCode;
  readonly displayName: string;
  /** "shares" on Polymarket, "contracts" on Kalshi. */
  readonly unitNoun: string;

  listEvents(cursor?: string, limit?: number): Promise<{ events: NormalizedEvent[]; next?: string }>;
  getMarkets(venueMarketIds: string[]): Promise<NormalizedMarket[]>;
  getOrderBook(ref: BookRef): Promise<NormalizedBook>;
  getOrderBooks(refs: BookRef[]): Promise<Map<string, NormalizedBook>>;
  getPriceHistory(ref: BookRef, from: Date, to: Date, interval: Interval): Promise<Candle[]>;
  getResolutions(venueMarketIds: string[]): Promise<Resolution[]>;
  computeFee(qty: number, priceCents: number, side: OrderSide, multiplier?: number): number;
}

export class VenueError extends Error {
  constructor(
    readonly venue: VenueCode,
    readonly status: number,
    message: string,
    readonly endpoint?: string,
  ) {
    super(message);
    this.name = 'VenueError';
  }

  /** 429 and 5xx are worth retrying with backoff; 4xx generally is not. */
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500 || this.status === 0;
  }
}
