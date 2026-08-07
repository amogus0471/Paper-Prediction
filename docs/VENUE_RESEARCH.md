# Which venues can we actually trade, and why

Every claim here was probed against the live endpoint on **2026-08-07**, not
read off a docs page. Where I previously got something wrong from documentation
alone, that is called out.

The bar for shipping a venue is deliberately narrow, and it is not "does the
site mention predictions":

1. **The instrument is a binary outcome contract** — YES/NO, settles to $1 or
   $0. Anything with leverage, funding or liquidation is a different instrument
   and needs a second fill engine. Two engines is how a simulator's numbers stop
   meaning anything.
2. **The order book is readable without authentication.** No API key, no
   wallet signature, no session cookie. We ship no secrets and hold no accounts.
3. **There is depth, not just a last price.** A chart gives you a number; a fill
   needs a ladder to walk. Without depth every fill is a guess dressed up as a
   simulation.

## Shipped

| Venue | Instrument | Auth | Book |
|---|---|---|---|
| **Polymarket** | binary CLOB | none | `POST /books`, both tokens, one request |
| **Kalshi** | binary CLOB | none | `GET /markets/{ticker}/orderbook` |
| **Hyperliquid** (HIP-4) | binary outcome contract | none | `POST /info {type:"l2Book"}` |
| **Limitless** (Base) | binary CLOB | none | `GET /markets/{slug}/orderbook` |

### Limitless — the newest one, and its three traps

Public REST at `https://api.limitless.exchange`, 616 active markets, no auth of
any kind. Details that will bite anyone reading this later:

- **`limit` is capped at 25.** Asking for 26 returns `400` with no data at all,
  not a shorter page. Paginate with `page`; never widen.
- **Sizes are raw collateral units.** USDC has 6 decimals, so `100000000` is
  100 shares. Miss the scaling and every quantity is a million times too big
  while staying internally consistent — the worst kind of wrong.
- **Only the YES book exists.** The endpoint takes a `tokenId` parameter and
  ignores it (verified). So our NO ladder is *mirrored*, which means
  `checkBookInvariants` passing here proves only that we can subtract. Evidence
  for the parse comes instead from the venue's own `midpoint`, which the tests
  compare against.

One more thing worth knowing: `/markets/active` lists markets whose book is
already gone, because the venue runs 5- and 15-minute markets that roll faster
than its own listing. Asking for one answers `400 "Market is not active"`,
which the adapter normalises to an empty book rather than an exception.

On those fast markets the published price and the top of book routinely
disagree — a rolling 5-minute market often shows nothing but dust at 3c/95c
while the listing still says 64c. **We show the book**, because the book is what
a fill walks. A displayed 64c that fills at 95c would be the worse lie.

## Rejected, with the reason

### axiom.trade — blocked, not absent

I previously wrote that Axiom has no prediction markets, based on
`docs.axiom.trade`. **That was wrong** — the docs were stale, and Axiom does run
a predictions surface. The correction stands.

What is *also* true is that we cannot reach it:

```
GET https://axiom.trade/predictions?chain=sol   ->  403  "Just a moment..."  (Cloudflare)
GET https://api.axiom.trade/predictions         ->  502  {"error":"No auth cookies present"}
GET https://api2.axiom.trade/predictions        ->  502  {"error":"No auth cookies present"}
```

Their API requires a logged-in session cookie, and the site itself is behind bot
protection. Reading it would mean either shipping credentials or defeating a
bot check — the first is against the design, the second is against the rules.

There is a real path if this matters: Axiom's predictions are **Polymarket-
backed**, so a per-market URL could be mapped to the underlying Polymarket
market and priced through the adapter we already have, with zero Axiom API
access. That needs one thing I do not have: **the URL of a single market on
Axiom.** `axiom.trade/predictions?chain=sol&…` is the feed page and identifies
no market. Send one and this becomes a small change.

> **Name collision:** `axiomprotocol.io` ("Axiom Protocol") is a *different
> company* that runs an XRP/RLUSD prediction market.

### gmgn.ai — spot only, and also blocked

`GET https://gmgn.ai/` returns `403` behind Cloudflare. Product is Solana
memecoin spot trading and copy-trading. No binary outcome contracts.

### lute.gg — not a prediction market at all

Renders fine, no auth wall. It is a Solana memecoin terminal with a social
layer: send tokens to friends, "call" a play, revenue share on referrals. The
words on the page are Send / Call / Share / cashback / SOL per day. Nothing
settles to $1 or $0.

### liquid.xyz vs liquid.trade — worth separating

`liquid.xyz` renders an empty document, no readable content.

**`liquid.trade` is the real product and it does carry prediction markets**,
alongside perps on stocks, commodities and FX. But its predictions live inside
`app.liquid.trade`, a non-custodial app behind a wallet, and I found no
unauthenticated market or book endpoint. It fails bar 2, not bar 1 — this one is
worth revisiting if they publish a public API.

## Not attempted, and honestly

- **WebSocket feeds.** Polymarket, Kalshi and Hyperliquid all publish one, and
  they would replace polling entirely. The blocker is not the protocol, it is
  MV3: a service worker is torn down when idle and a socket's lifecycle has to
  be rebuilt around that. Batched polling at one request per second is well
  inside every budget, so this is an optimisation and not a fix.
- **Chart scraping**, on any venue. A chart gives a last price. Depth cannot be
  walked through a picture, and a fill priced off a last price is fiction.
