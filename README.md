# Polyfill

**Paper-trade real prediction markets.**

Every fill is priced by walking the venue's actual live order book — real depth,
real fees, a real latency penalty — so a thin market gives you a genuinely bad
average fill. That is the lesson, and it is the whole product.

Then it scores you on something P&L can't measure: a **Brier Skill Score against
the market's own price**. Did the forecast you paid for beat the forecast the
market was already giving away for free?

**No real money is involved anywhere. There is no path to placing a real order.**

> **Why "Polyfill"?** A *polyfill* is code that fills in what's missing — and
> this app fills orders. It says "poly" so prediction-market people clock it
> instantly, and it contains no gambling word, which matters: the Chrome Web
> Store bans extensions that facilitate real-money prediction market trading and
> carves out an exception only for simulators that clearly indicate no real
> money is involved. A name like "Polybet" argues against that exception in the
> first place a reviewer looks.

---

## Try it in 60 seconds

```bash
npm install && npm run build --workspace @polyfill/extension
```

Then:

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → select **`apps/extension/dist`** — the `dist` folder
   specifically, *not* `apps/extension`
4. Visit any market on **polymarket.com** or **kalshi.com**
5. The Polyfill panel appears bottom-left — pick a side, set a size, place an order

You start with **P$10,000**. No sign-up, no email, no account.

> If Chrome says *"Could not load manifest"*, the build crashed — there is no
> valid `dist/`. Read the terminal output rather than re-loading the folder.

Click the extension icon for the side panel: **Book** (earnings, positions),
**Watch**, **Record** (calibration + Readiness Check), **History**, **Settings**.

---

## Architecture: local-first, server only where it earns its cost

A leaderboard is worthless if the client can name its own fill price. An app is
annoying if it demands an account from someone who just wants to practise. Those
pull in opposite directions, so the split falls where the line naturally is:

| | Solo play (default) | Leaderboard (opt-in) |
|---|---|---|
| Sign-up | none | anonymous handle, still no email |
| Fills priced | in the extension | Supabase Edge Function |
| State | `chrome.storage.local` | Postgres, RLS deny-all to clients |
| Network to our backend | **zero** | per order |
| User can edit their results | yes — it's their machine | no |

**One fill engine, not two.** `packages/core` is imported by the extension *and*
bundled into the Edge Functions. A simulator that quotes with one engine and
fills with another is how you get a leaderboard nobody trusts.

```
polyfill/
├── apps/extension/       MV3: service worker, overlay, side panel
├── packages/core/        THE fill engine + scoring + coaching. Pure, 99% covered.
├── packages/venues/      VenueAdapter + Polymarket + Kalshi normalizers
├── supabase/migrations/  forward-only SQL (leaderboard path)
└── supabase/functions/   quote · order-submit · portfolio · settle · bootstrap
```

---

## The fill engine — four rules

1. **Never fill beyond visible depth.** 500 on the book, you asked for 2,000 →
   you get 500, marked `partial`. No synthesized liquidity.
2. **Cap an order at 5% of visible depth.** *"Larger than this market can absorb
   — in reality you'd move the price against yourself."* This kills the main
   leaderboard exploit: dumping a bankroll into a 1-share book.
3. **Replay latency.** Your order does **not** fill against the book you quoted
   from. Realistic waits 250 ms (Brutal: 750 ms), fetches a *new* book, fills
   against that, and rejects with `price_moved` if the price ran >2% against you.
   Your quote is not your fill.
4. **No market impact modelling — and Settings says so.** Paper orders never
   touch the real book. Rule 2 keeps sizes small enough that this stays honest.

Plus a **resolution front-running lockout**: once a book is ≥97¢ / ≤3¢ with a
spread under 2¢, the outcome is already public and trading it is collecting, not
forecasting. Frozen.

| Mode | Price | Fees | Latency | Scores? |
|---|---|---|---|---|
| Instant | book mid | none | 0 ms | no — tutorial only |
| **Realistic** | walk the book | venue model | 250 ms | yes |
| Brutal | +1 tick adverse | 1.5× | 750 ms | yes |

---

## Statistical honesty is a feature

- **No Brier Skill Score below n=30.** It shows `18/30` instead. A skill score
  before 30 resolved positions is noise.
- **Always a confidence interval**, labelled approximate.
- **Categories under n=20 are greyed out** as thin, not presented as findings.
- **Instant-mode trades and voided markets never score.** A void is not a
  forecast you got wrong.
- **The Readiness Check** (unlocks at 100 resolved positions) will tell you
  plainly not to fund a real account if your score is negative — and refuses to
  call a positive score "proven" while its confidence interval still includes
  zero.

---

## Two bugs that would have silently corrupted every price

Both found by testing against live data; both now asserted on every snapshot.

**1. Both venues return books worst-first.** Polymarket's `bids` *ascend* to the
best bid at the END of the array; `asks` *descend* to the best ask at the end.
Kalshi does the same. Read either as best-first and a buy that should fill at 13¢
fills at 15¢. The adapters sort explicitly rather than reversing.

**2. Kalshi's orderbook has no asks at all.** The response is
`{orderbook_fp: {yes_dollars, no_dollars}}` — **bid ladders only**, each level
`["0.1500", "100.00"]`: element 0 is a price in *dollars as a string*, element 1
is a *contract count*, not a price. Both ask ladders must be synthesized by
mirroring — a YES bid at 7¢ **is** a NO ask at 93¢, same size.

The mirror is checked on every book, and a book that fails it is refused rather
than quoted from:

```
best_yes_ask == 100 − best_no_bid
best_no_ask  == 100 − best_yes_bid
```

**Verified live on 100 markets per venue: 0 violations, 0 sort failures.** On
Kalshi the synthesized asks matched the venue's own quoted `yes_ask`/`no_ask`
exactly on all 100.

### Also established against live APIs

- **Kalshi market data needs no auth.** `GET /markets` and
  `/markets/{ticker}/orderbook` both return 200 with no credentials on
  `api.elections.kalshi.com`. No API key, no RSA-PSS signing, no account.
- **Polymarket's Gamma metadata lags its own CLOB book** by up to 5¢. Metadata
  is display-only; every price comes from the book.
- **Neither venue has N-outcome markets.** Multi-outcome questions are modelled
  as an *event containing many binary markets* (one LoL event had 40). Sampling
  100 live Polymarket markets found 100 with exactly two outcomes. The overlay
  handles this with a sibling picker rather than special N-outcome support.

---

## Testing

```bash
npm run verify      # secrets scan → typecheck → tests → build, all workspaces
npm run invariants  # live venue contract tests (LIVE=1)
```

| Suite | Covers |
|---|---|
| `packages/core` | 108 tests, **99.5% lines / 100% functions**, gate enforced at 90%. Property tests assert avg price always lies between the levels touched, cost always equals Σ(qty×price), fills never exceed visible depth, and ladder points stay in 0–1000. |
| `packages/venues` | Kalshi mirror synthesis, Polymarket ordering, exact decimal parsing — against books captured from live APIs. |
| `apps/extension` | 21 offline tests over the local engine: closed market, expired quote, replayed quote, depth cap, funds, 20% position cap, price-moved, weighted-average realized P&L. Plus a `LIVE=1` suite against a real Kalshi book. |

The build refuses to emit a `dist/` Chrome would reject: it fails if the content
script contains an `import` (classic scripts can't have one), if the manifest
points at a missing file, or if anything resembling a secret reaches a bundle.

---

## Privacy

Solo play sends **nothing** anywhere. No account exists for you. Market data is
fetched directly from Polymarket's and Kalshi's public APIs by the extension's
service worker; your trades never leave `chrome.storage.local`.

Opting into the leaderboard creates an anonymous handle — no email, no password.
Identity is a random device key that stays on your machine; the server stores
only its SHA-256, and IP addresses are salted-hashed for rate limiting, never
stored raw.

## Compliance

- No control anywhere places, prefills, or deep-links a real order
- No cash prizes, ever — cosmetic only
- No affiliate or referral links to the venues
- A non-dismissible `SIMULATED · NO REAL MONEY` badge on every surface showing a
  price, position, or order
- No remotely-hosted code; everything ships in the bundle

## Licence

Not yet licensed. All rights reserved.
