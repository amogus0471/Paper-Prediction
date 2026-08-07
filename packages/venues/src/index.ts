export * from './types';
export * from './decimal-parse';
export * from './http';
export { PolymarketAdapter, normalizeLadder, bookMid } from './polymarket';
export { KalshiAdapter, normalizeKalshiBook } from './kalshi';
export { HyperliquidAdapter, coinFor } from './hyperliquid';

import { HyperliquidAdapter } from './hyperliquid';
import { KalshiAdapter } from './kalshi';
import { PolymarketAdapter } from './polymarket';
import type { VenueAdapter, VenueCode } from './types';

/** The venue registry. Adding a venue is one line here plus one adapter file. */
export function createAdapters(opts: { kalshiEnv?: 'prod' | 'demo' } = {}): Record<
  VenueCode,
  VenueAdapter
> {
  return {
    polymarket: new PolymarketAdapter(),
    kalshi: new KalshiAdapter({ env: opts.kalshiEnv ?? 'prod' }),
    hyperliquid: new HyperliquidAdapter(),
  };
}
