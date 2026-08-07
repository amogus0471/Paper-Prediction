# Ghostfill

Paper trade **real** Polymarket and Kalshi markets with simulated money.

Every fill is priced by walking the venue's actual live order book — real depth,
real fees, a real latency penalty — so a thin market gives you a genuinely bad
average fill. That is the lesson, and it is the whole product.

**No real money is involved anywhere. There is no path to placing a real order.**

---

## Try it in 60 seconds

```bash
npm install
npm run build --workspace @ghostfill/extension
```

Then:

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → select `apps/extension/dist`
4. Visit any market on **polymarket.com** or **kalshi.com**
5. The Ghostfill panel appears bottom-left — pick a side, set a size, place a ghost order

You start with **G$10,000**. No sign-up, no email, no account.

Click the extension icon to open the side panel: earnings dashboard, open
positions, order history, your calibration record, and settings.

---

## Architecture: local-first, server only when it must be

The thing that makes a paper-trading leaderboard worthless is a client that can
name its own fill price. The thing that makes a paper-trading *app* annoying is
forcing an account on someone who just wants to practise. Those pull in opposite
directions, so Ghostfill splits them:

| | Solo play (default) | Leaderboard (opt-in) |
|---|---|---|
| Sign-up | none | anonymous handle, still no email |
| Where fills are priced | in the extension | Supabase Edge Function |
| Where state lives | `chrome.storage.local` | Postgres, RLS deny-all to clients |
| Network to our backend | **zero** | per order |
| Can the user edit their results | yes, it's their machine | no |

Solo play costs the backend nothing and works offline-ish. Competitive play is
server-authoritative because that is the only place authority is worth paying
for. **The fill engine is the same code in both** — `packages/core`, imported by
the extension and bundled into the Edge Functions. A simulator that quotes with
one engine and fills with another is how you get a leaderboard nobody trusts.

```
ghostfill/
├── apps/extension/       MV3: service worker, Ghost Mode overlay, side panel
├── packages/core/        THE fill engine — pure, 99% covered, property tested
├── packages/venues/      VenueAdapter + Polymarket + Kalshi normalizers
├── supabase/migrations/  forward-only SQL (leaderboard path)
└── supabase/functions/   quote · order-submit · portfolio · settle · bootstrap
```

---

## The fill engine — four rules

1. **Never fill beyond visible depth.** 500 shares on the book, you asked for
   2,000 → you get 500 and the order is `partial`. No synthesized liquidity.
2. **Cap an order at 5% of visible depth.** Rejected with *"Larger than this
   market can absorb — in reality you'd move the price against yourself."* This
   kills the main leaderboard exploit: dumping a bankroll into a 1-share book.
3. **Replay latency.** Your order does **not** fill against the book you quoted
   from. Realistic mode waits 250 ms (Brutal: 750 ms), fetches a *new* book, and
   fills against that. If the price moved >2% against you, it's rejected with
   `price_moved`. Your quote is not your fill.
4. **No market impact modelling — and Settings says so.** Ghost orders never
   touch the real book. Rule 2 keeps sizes small enough that this stays honest.

Plus a resolution-front-running lockout: once a book is ≥97¢ / ≤3¢ with a spread
under 2¢, the outcome is already public and trading it is collecting, not
forecasting. Frozen.

### Realism modes

| Mode | Price | Fees | Latency | Scores? |
|---|---|---|---|---|
| Instant | book mid | none | 0 ms | no — tutorial only |
| **Realistic** | walk the book | venue model | 250 ms | yes |
| Brutal | +1 tick adverse | 1.5× | 750 ms | yes |

---

## Two bugs that would have silently corrupted every price

Both were found by testing against live data, and both are now asserted on every
snapshot:

**1. Both venues return books worst-first.** Polymarket's `bids` *ascend* to the
best bid at the END of the array; `asks` *descend* to the best ask at the end.
Kalshi does the same. Reading either as best-first inverts the whole book — a
buy that should fill at 13¢ fills at 15¢. The adapters sort explicitly rather
than reversing, so a future ordering change can't quietly flip it back.

**2. Kalshi's orderbook has no asks at all.** The response is
`{orderbook_fp: {yes_dollars, no_dollars}}` — **bid ladders only**, where each
level is `["0.1500", "100.00"]`: element 0 is a price in *dollars as a string*,
element 1 is a *contract count*, not a price. Both ask ladders must be
synthesized by mirroring: a YES bid at 7¢ **is** a NO ask at 93¢, same size.

The mirror is checked on every book, and a book that fails it is refused rather
than quoted from:

```
best_yes_ask == 100 − best_no_bid
best_no_ask  == 100 − best_yes_bid
```

**Verified live on 100 markets per venue: 0 violations, 0 sort failures.** On
Kalshi our synthesized asks matched the venue's own quoted `yes_ask`/`no_ask`
exactly on all 100.

```bash
npm run invariants        # re-run against live venue data
```

### Also worth knowing

- **Kalshi market data needs no auth.** `GET /markets` and
  `/markets/{ticker}/orderbook` both return 200 with no credentials on
  `api.elections.kalshi.com`. No API key, no RSA-PSS signing, no Kalshi account.
- **Polymarket's Gamma metadata lags its own CLOB book** — observed up to 5¢
  drift. Metadata is display-only; every price comes from the book.

---

## Testing

```bash
npm test                                        # all workspaces
npm run invariants                              # live venue contract tests
npm run build --workspace @ghostfill/extension  # build + verify dist/
```

| Suite | What it covers |
|---|---|
| `packages/core` | 87 tests, 99.8% lines / 100% functions. Property tests assert avg price always lies between the levels touched, cost always equals Σ(qty×price), and fills never exceed visible depth. |
| `packages/venues` | Kalshi mirror synthesis and Polymarket ordering, against books captured from live APIs. |
| `apps/extension` | Full local path against a **live Kalshi book**: quote → fill → position → settle, with the ledger balancing after every step. |

The extension build refuses to emit a `dist/` that Chrome would reject: it fails
if the content script contains an `import` (classic scripts can't), if the
manifest points at a missing file, or if anything that looks like a secret
reaches a bundled file.

---

## Privacy

Solo play sends **nothing** anywhere. No account exists for you. Market data is
fetched directly from Polymarket's and Kalshi's public APIs by the extension's
service worker; your trades never leave `chrome.storage.local`.

Opting into the leaderboard creates an anonymous handle — still no email, no
password. Identity is a random device key that stays on your machine; the server
only ever stores its SHA-256.

## Compliance

Chrome Web Store policy bans extensions that facilitate real-money prediction
market trading, and explicitly permits simulators that clearly indicate no real
money is involved. Accordingly:

- No control anywhere places, prefills, or deep-links a real order
- No cash prizes, ever — cosmetic only
- No affiliate or referral links to the venues
- A non-dismissible `SIMULATED · NO REAL MONEY` badge on every surface showing a
  price, position, or order
- No remotely-hosted code; everything ships in the bundle

## Licence

Not yet licensed. All rights reserved.
