# Hyperliquid HIP-4 — verified API notes

Everything here was probed against live mainnet on 2026-08-07. It is the
undocumented-by-us half of building `packages/venues/src/hyperliquid.ts`.

## Why this venue fits and the memecoin terminals do not

HIP-4 outcome contracts are the **same instrument** we already model: binary,
YES/NO, fully collateralised, settling to 1 or 0. `walkBook`, `settlePosition`
and the Brier scoring all apply unchanged.

Memecoin terminals (GMGN, Axiom.trade, Photon, BullX, Padre) are spot and perp
venues. A perp has leverage, funding and liquidation, and never settles to
$1/$0 — supporting one means a **second fill engine**, which is exactly the
thing that makes a simulator's numbers stop meaning anything. Confirmed from
Axiom's own docs (docs.axiom.trade): the feature list is migration tools, spot
buys, quick sell, Twitter monitor, wallet tracking, limit orders. No
predictions.

> **Name collision worth knowing:** `axiomprotocol.io` ("Axiom Protocol") IS a
> prediction market, for XRP/RLUSD. It is a different company from
> `axiom.trade`. If Axiom predictions were the goal, that is the one.

## Endpoints

Base: `https://api.hyperliquid.xyz` (testnet: `https://api.hyperliquid-testnet.xyz`).
All reads are `POST /info` with a JSON body. **No auth for reads.**

### Discovery

```bash
curl -X POST https://api.hyperliquid.xyz/info \
  -H 'Content-Type: application/json' -d '{"type":"outcomeMeta"}'
```

```jsonc
{
  "outcomes": [
    {
      "outcome": 1025,
      "name": "Recurring",
      // Pipe-delimited, NOT a sentence. Parse it, don't display it.
      "description": "class:priceBinary|underlying:BTC|expiry:20260808-0600|targetPrice:64306|period:1d",
      "sideSpecs": [{ "name": "Yes" }, { "name": "No" }],
      "quoteToken": "USDC"
    }
  ],
  "questions": [
    {
      "question": 168,
      "description": "class:priceBucket|underlying:BTC|expiry:20260808-0600|priceThresholds:63019,65592|period:1d",
      "fallbackOutcome": 1029,
      "namedOutcomes": [1030, 1031, 1032]
    }
  ]
}
```

`questions` are multi-bucket groupings whose `namedOutcomes` are the tradeable
binaries. They map cleanly onto our existing event → sibling-markets shape, so
the overlay's sibling picker needs no new concept.

### The asset id — the part that is not obvious

`l2Book` does **not** accept the outcome number, a ticker, or `@index`. All of
these return `null`:

```
{"type":"l2Book","coin":"@1025"}          -> null
{"type":"l2Book","coin":"1025:Yes"}       -> null
{"type":"l2Book","coin":"OUTCOME:1025:Yes"} -> null
```

The convention is only discoverable through `allMids`:

```bash
curl -X POST https://api.hyperliquid.xyz/info \
  -H 'Content-Type: application/json' -d '{"type":"allMids"}'
# {"#10250":"0.879215","#10251":"0.120785","#10260":"0.685", ...}
```

**`#{outcome}{sideIndex}`** — outcome `1025` side `0` (Yes) is `#10250`, side
`1` (No) is `#10251`. Note this is string concatenation, not arithmetic:
outcome 1026 gives `#10260`/`#10261`, so the ids are NOT sequential integers.

### Order book

```bash
curl -X POST https://api.hyperliquid.xyz/info \
  -H 'Content-Type: application/json' -d '{"type":"l2Book","coin":"#10250"}'
```

```jsonc
{
  "coin": "#10250",
  "time": 1786122556155,          // epoch ms, use as capturedAt
  "levels": [
    [ { "px": "0.86617", "sz": "50.0", "n": 1 } ],  // levels[0] = BIDS
    [ { "px": "0.86717", "sz": "50.0", "n": 1 } ]   // levels[1] = ASKS
  ]
}
```

- `levels` is a **two-element array**, not an object: `[bids, asks]`.
- Prices are **dollars 0..1 as strings**. Multiply by 100 for our cents.
  Reuse `dollarsStringToCents` — it is already exact and already tested.
- Unlike Polymarket and Kalshi, levels arrive **best-first** here. Sort anyway;
  the adapters sort explicitly precisely so an ordering change cannot silently
  invert a book.
- Sizes are contract counts as strings.
- Prices float in `(0.001, 0.999)`, so the display clamp to 99.9/0.1 already
  matches the venue's own bounds.

### Mirror invariant — verified live

Both sides are real, independently-quoted books, as on Polymarket. Checked on
outcome 1025:

```
YES bid 0.86617  ->  NO ask 0.13383   (1 - 0.86617)  ✓ exact
NO  bid 0.12     ->  YES ask 0.88     (1 - 0.12)     ✓ exact
```

`checkBookInvariants` applies unchanged. Assert it on every snapshot, as we do
for the other two.

## What remains to build

1. `packages/venues/src/hyperliquid.ts` implementing `VenueAdapter`:
   - `listEvents` from `outcomeMeta`, parsing the pipe-delimited `description`
     into a human question ("Will BTC be above $64,306 at 06:00 on 8 Aug?")
   - `getOrderBook` via `l2Book` on `#{outcome}{side}` for both sides
   - `computeFee` → zero. HIP-4 charges **no fee to open**, so the fee model is
     `{ kind: 'none' }` and the cost is purely the spread.
2. URL detection for `app.hyperliquid.xyz` in `resolve.ts`.
3. A WebSocket feed: `l2Book` and `trades` subscriptions exist for outcome
   assets, which would replace polling on all three venues.

## Lute.gg — nearly free

Lute is a **social frontend on Polymarket**: same liquidity, same settlement,
same oracle. Supporting it is URL detection that resolves to the Polymarket
market we already handle, not a new adapter.
