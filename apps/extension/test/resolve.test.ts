import { describe, expect, it } from 'vitest';
import { parseVenueUrl } from '../src/lib/resolve';

/**
 * URL parsing is the whole detection mechanism — no DOM scraping anywhere — so
 * every shape a venue can put a market at gets pinned here. The failure mode
 * these guard against is not a crash: it is a popup that quietly shows the
 * wrong market, or none at all on a page that has one.
 */

describe('polymarket', () => {
  it('takes the event slug', () => {
    expect(parseVenueUrl('https://polymarket.com/event/fed-september')).toEqual({
      venue: 'polymarket',
      slug: 'fed-september',
    });
  });

  it('ignores pages that are not markets', () => {
    expect(parseVenueUrl('https://polymarket.com/')).toBeNull();
    expect(parseVenueUrl('https://polymarket.com/leaderboard')).toBeNull();
  });
});

describe('kalshi', () => {
  it('only accepts an ALL-CAPS segment as an event ticker', () => {
    // "bitcoin-above" is a human slug. Sending it as an event ticker 404s,
    // which is why the popup never used to appear on Kalshi.
    const parsed = parseVenueUrl('https://kalshi.com/markets/kxbtcd/bitcoin-above');
    expect(parsed).toMatchObject({ venue: 'kalshi', series: 'KXBTCD', slug: 'bitcoin-above' });
    expect((parsed as { ticker?: string }).ticker).toBeUndefined();
  });

  it('picks up a real event ticker when the URL carries one', () => {
    expect(
      parseVenueUrl('https://kalshi.com/markets/kxbtcd/bitcoin-above/KXBTCD-26AUG07'),
    ).toMatchObject({ venue: 'kalshi', series: 'KXBTCD', ticker: 'KXBTCD-26AUG07' });
  });
});

describe('hyperliquid — three shapes for one coin', () => {
  it('reads the encoded path form', () => {
    expect(parseVenueUrl('https://app.hyperliquid.xyz/outcomes/%2310250')).toEqual({
      venue: 'hyperliquid',
      coin: '#10250',
    });
  });

  it('reads the coin out of the fragment', () => {
    // Their own router lands here: an unescaped "#" in a path IS a fragment,
    // so pathname is just "/trade/" and the coin arrives in location.hash.
    expect(parseVenueUrl('https://app.hyperliquid.xyz/trade/#10250')).toEqual({
      venue: 'hyperliquid',
      coin: '#10250',
    });
  });

  it('accepts bare digits', () => {
    expect(parseVenueUrl('https://app.hyperliquid.xyz/outcomes/10261')).toEqual({
      venue: 'hyperliquid',
      coin: '#10261',
    });
  });

  it('refuses a perp', () => {
    // /trade/BTC is a perpetual: leverage, funding, liquidation, and it never
    // settles to $1/$0. Opening a prediction ticket over it would be a lie.
    expect(parseVenueUrl('https://app.hyperliquid.xyz/trade/BTC')).toBeNull();
    expect(parseVenueUrl('https://app.hyperliquid.xyz/trade/HYPE')).toBeNull();
    expect(parseVenueUrl('https://app.hyperliquid.xyz/trade/@142')).toBeNull();
  });

  it('refuses the outcomes index, which names no market', () => {
    expect(parseVenueUrl('https://app.hyperliquid.xyz/outcomes')).toBeNull();
  });

  it('refuses a malformed coin rather than guessing', () => {
    expect(parseVenueUrl('https://app.hyperliquid.xyz/outcomes/%23BOGUS')).toBeNull();
    // A coin is <outcome><side> and side is 0 or 1, so a trailing 2 is not a
    // near miss to be repaired — it addresses nothing. l2Book answers `null`
    // rather than an error for an unknown coin, so a guess here would surface
    // as an empty market instead of a failure.
    expect(parseVenueUrl('https://app.hyperliquid.xyz/trade/#10252')).toBeNull();
  });
});

describe('limitless', () => {
  it('takes the market slug, which is also the book address', () => {
    expect(parseVenueUrl('https://limitless.exchange/markets/btc-up-or-down-hourly-1786')).toEqual({
      venue: 'limitless',
      slug: 'btc-up-or-down-hourly-1786',
    });
  });

  it('ignores the rest of the site', () => {
    expect(parseVenueUrl('https://limitless.exchange/')).toBeNull();
    expect(parseVenueUrl('https://limitless.exchange/portfolio')).toBeNull();
  });
});

describe('anything else', () => {
  it('is not a venue', () => {
    for (const url of [
      // Memecoin terminals. Spot and perps, no binary outcome contracts, and
      // both sit behind Cloudflare bot protection with authenticated APIs —
      // see docs/VENUE_RESEARCH.md.
      'https://gmgn.ai/sol/token/abc',
      'https://axiom.trade/predictions?chain=sol',
      'https://lute.gg/',
      'https://example.com/event/foo',
      'not a url',
    ]) {
      expect(parseVenueUrl(url)).toBeNull();
    }
  });
});
