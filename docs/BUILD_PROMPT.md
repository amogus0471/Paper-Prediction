# GHOSTFILL — Build Prompt

> Paste this into Claude Code / Cursor / any coding agent as the project brief.
> Full detail lives in `GHOSTFILL_MASTER_PLAN.md` — this is the executable summary.

---

## ROLE

You are the lead engineer building **Ghostfill**, a Chrome extension for paper trading prediction markets. Work in small, tested, reviewable increments. Do not scaffold the whole app at once. Follow the phase order exactly. Ask before deviating from the architecture below.

---

## THE PRODUCT IN ONE PARAGRAPH

Ghostfill lets people trade **real Polymarket and Kalshi markets with simulated money**. Every order is priced server-side against the **actual live order book** — walking real depth, applying real fee models, and replaying a latency penalty — so fills are honest. Users get scored not just on P&L but on a **Brier Skill Score versus the market's own price**: did their forecasts beat the price they paid? A weekly **Ladder** with divisions, promotion and relegation keeps them coming back, and a shareable **Weekly Wrapped** card is the growth loop. The pitch: *learn to trade prediction markets before it costs you anything.*

---

## HARD CONSTRAINTS — VIOLATING ANY OF THESE FAILS THE PROJECT

1. **NO REAL MONEY, ANYWHERE.** Chrome Web Store policy (Regulated goods and services, clause 2) bans extensions that facilitate real-money prediction market trading — enforced from 1 August 2026 — and *explicitly permits* simulators that clearly indicate no real money is involved. Therefore:
   - No control anywhere may place, prefill, or deep-link a real order with parameters.
   - No prizes of cash or value, ever. Cosmetic rewards only.
   - No affiliate or referral links to real-money venues.
   - A persistent, **non-dismissible** `SIMULATED · NO REAL MONEY` badge on every surface showing a price, position, or order.

2. **THE CLIENT IS A RENDERER. THE SERVER IS THE EXCHANGE.** The extension never sends a price, a timestamp, or a P&L number. It sends intent (`{quote_id, idempotency_key}`) and receives results. Every fill derives from a stored `book_snapshot_id` and a server `now()`. If you break this, the leaderboard is worthless.

3. **NO WRITE POLICIES ON TRADING TABLES.** RLS is on everywhere. Users can `SELECT` their own rows. There is **no** client-side INSERT/UPDATE/DELETE path to `orders`, `fills`, `positions`, `transactions`, or `portfolios`. All writes go through Edge Functions using `service_role`.

4. **NEVER SHIP `service_role` IN THE BUNDLE.** Only the publishable/anon key. Add a CI step that greps the built ZIP for secret patterns and fails the build.

5. **NO REMOTELY-HOSTED CODE.** MV3 forbids it. All JS ships in the bundle; only data comes over the network.

---

## STACK

| Layer | Choice |
|---|---|
| Backend | **Supabase** — Postgres, Auth (GoTrue), Edge Functions (Deno), Realtime, Storage, Vault, pg_cron |
| Extension | **Chrome MV3** — Vite + CRXJS + React 18 + TypeScript |
| State | TanStack Query (server state) + Zustand (UI state only) |
| Styling | Tailwind + a shared token package. Dark-first. |
| Charts | `lightweight-charts` (lazy-loaded chunk only) |
| Monorepo | pnpm workspaces + Turborepo |
| Web | Next.js at `ghostfill.app` (marketing + public `/u/:handle` profiles) |
| Venues (v1) | **Polymarket + Kalshi** |

---

## REPO LAYOUT

```
ghostfill/
├── apps/extension/          # MV3: background/ offscreen/ sidepanel/ popup/ content/
├── apps/web/                # Next.js marketing + public profiles
├── packages/core/           # PURE + 90% TESTED: book.ts fees.ts pnl.ts scoring.ts format.ts
├── packages/venues/         # VenueAdapter interface + polymarket/ + kalshi/
├── packages/ui/             # design tokens + components
├── packages/types/          # generated Supabase types + DTOs
├── supabase/migrations/     # forward-only SQL
├── supabase/functions/      # quote, order-submit, settle, ingest-*, season-rollover, share-card…
└── docs/                    # ARCHITECTURE FILL_ENGINE SCORING COMPLIANCE RUNBOOK
```

---

## PHASE ORDER — DO NOT SKIP AHEAD

### Phase 1 — Foundation (build and test this before touching any UI)

1. **Monorepo scaffold.** pnpm + turbo + shared tsconfig/eslint/prettier.

2. **`packages/core`** — pure functions, no I/O, **90% coverage gate**:
   - `walkBook(levels, target, tickSize)` → `{fills, avgPrice, totalQty, cost}`. Supports both a quantity target and a notional target. **Never fills beyond visible depth.**
   - `computeFee(venue, qty, priceCents, side)` — per-venue fee models loaded from config.
   - `costBasis`, `realizedPnl`, `unrealizedPnl` with weighted-average cost basis.
   - `brier`, `brierSkillScore`, `murphyDecomposition`, `ladderPoints`.
   - Formatters: cents, dollars, percent, all tabular-safe.
   - **Property tests:** avgPrice always between best and worst level touched; cost always equals Σ(qty×price); never fills more than available depth.

3. **`packages/venues`** — one `VenueAdapter` interface, two implementations.
   - Normalization contract: **price in cents (0,100) exclusive, size in units, YES and NO both first-class, all times UTC server-generated.**
   - **Polymarket:** `gamma-api.polymarket.com` for events/markets, `clob.polymarket.com` for `/book`, `/books`, `/price`, `/midpoint`, `/spread`, `/prices-history`. No auth needed for any read. Each binary market has **two token IDs** (YES, NO) — fetch both, merge into one normalized book. Use the public WebSocket for hot markets; REST polling alone will hit Cloudflare limits (~60 req/min Gamma, ~100 req/min CLOB read in practice).
   - **Kalshi:** prod `https://external-api.kalshi.com/trade-api/v2`, **demo `https://external-api.demo.kalshi.co/trade-api/v2` — build against demo for dev/staging.** Endpoints: `/markets`, `/markets/{ticker}`, `/markets/{ticker}/orderbook?depth=100`, `/markets/trades`, `/events`, `/series`, `/account/api-limits`.
   - **Kalshi requires auth on everything, including market data.** Ignore third-party guides claiming otherwise — the official OpenAPI spec declares `kalshiAccessKey`/`kalshiAccessSignature`/`kalshiAccessTimestamp` security on the orderbook endpoint and documents a `401`. Sign requests **RSA-PSS** over `timestamp_ms + METHOD + path`. Key pair goes in Supabase Vault; all Kalshi calls are server-side only. Rate limits are tiered (~20 reads/s basic) — call `GET /account/api-limits` at boot and adapt the scheduler.
   - **⚠️ TWO CRITICAL BUGS TO AVOID IN ONE ENDPOINT:**
     1. **Bid ladders only.** The response has no asks. Kalshi's docs: *"a bid for yes at price X is equivalent to an ask for no at price (100−X)… a yes bid at 7¢ is the same as a no ask at 93¢, with identical contract sizes."* Synthesize both ask sides.
     2. **Shape is `{orderbook_fp: {yes_dollars: [...], no_dollars: [...]}}`** where each level is `["0.1500", "100.00"]` — **element 1 is a price in DOLLARS as a string, element 2 is a CONTRACT QUANTITY, not a price.** Convert price to cents by ×100. Parse with decimal/integer math, never accumulating `parseFloat`.
     Property-test `best_yes_ask == 100 − best_no_bid` and `best_no_ask == 100 − best_yes_bid` on **every** snapshot; alert in production on violation. Getting either wrong makes every fill price silently wrong.
   - **Contract tests** against recorded fixtures, plus a nightly job that hits the live APIs and alerts on schema drift.

4. **Database.** Implement the full schema from `GHOSTFILL_MASTER_PLAN.md` §9 — profiles, venues, events, markets, book_snapshots, price_ticks, price_candles, portfolios, quotes, orders, fills, positions, transactions, seasons, divisions, ladder_entries, calibration_records, badges, user_badges, watchlist, follows, leagues, league_members, integrity_events. Then RLS per §10. Run Supabase's security advisor and get to zero findings.

5. **Ingestion.** Cron jobs with Postgres advisory locks: `ingest-markets-full` (5m), `ingest-markets-hot` (30s), `ingest-books-hot` (5s), `ingest-books-warm` (30s), `retier-markets` (60s), `build-candles` (1m), `prune-snapshots` (daily). Hot/warm/cold tiering per §8.4 — a market goes HOT the instant anyone opens it or holds a position in it. Log every run to an `ingest_runs` table.

6. **`quote` Edge Function.** Loads the latest book snapshot, rejects if older than 30s, walks the book, computes fees and slippage, inserts a `quotes` row with a **10-second TTL**, returns `{quote_id, avgPrice, qty, cost, fee, slippageBps, maxPayout, maxProfit, breakeven}`.

7. **`order-submit` Edge Function.** One transaction, `SELECT … FOR UPDATE` on the portfolio row:
   - validate quote is live and unconsumed
   - run every rule in §12.6 (insufficient funds, market closed, stale book, quote expired, size > 5% of book depth, below min size, invalid tick, rate limit, position limit >20% bankroll)
   - select the first book snapshot at or after `quote_time + latency_ms` (250ms Realistic / 750ms Brutal)
   - **re-walk the book on that later snapshot**; if the price moved >2% against the user, reject with `price_moved`
   - insert order + fills (each referencing `snapshot_id`) + position (freezing `entry_p_user` and `entry_p_market`) + transactions; update `cash_balance`; consume the quote
   - idempotency: `unique(user_id, idempotency_key)`; replays return the original order

**Phase 1 milestone: a curl request produces a correct, auditable ghost fill whose price you can reconstruct from the stored snapshot.**

---

### Phase 2 — Extension (weeks 4–6)

8. **MV3 scaffold.** Manifest per §15.5. **Generate a key pair and pin `"key"` in the manifest on day one** so the extension ID is stable across dev/CI/store — OAuth breaks silently otherwise. Permissions: `identity, storage, sidePanel, alarms, notifications, offscreen`. Polymarket/Kalshi host permissions are **optional**, requested only when Ghost Mode is enabled.

9. **Supabase client in the service worker.** Custom storage adapter over `chrome.storage.local` (`getItem`/`setItem`/`removeItem`), `persistSession: true`, `autoRefreshToken: true`, `detectSessionInUrl: false`, **`flowType: 'pkce'`**. Service workers have no `window` and no `localStorage`.

10. **OAuth — X and Google.**
    - `supabase.auth.signInWithOAuth({ provider, options: { redirectTo: chrome.identity.getRedirectURL(), skipBrowserRedirect: true } })`
    - `chrome.identity.launchWebAuthFlow({ url: data.url, interactive: true })`
    - read `?code=` from the **query string**, then `supabase.auth.exchangeCodeForSession(code)`
    - **PKCE is mandatory.** Implicit flow puts the token in the URL hash and `launchWebAuthFlow` strips the hash — it silently returns nothing.
    - Register `https://<EXTENSION_ID>.chromiumapp.org/` as an allowed redirect in Supabase.
    - X scopes: `users.read tweet.read offline.access` (X tokens expire in 2h without `offline.access`). Do not add timeline-reading features — X is pay-per-use as of Feb 2026.
    - Then call `profile-init` to create the profile, handle, and portfolio.

11. **Offscreen document** for the Supabase Realtime WebSocket (service workers sleep after ~30s and kill sockets). Relay ticks to the side panel via `chrome.runtime.sendMessage`. **Always ship a `chrome.alarms` polling fallback.**

12. **Side panel UI** — Markets, Book, Ladder, Record, Settings. Build in that order; Ladder and Record can be stubs until Phase 3.
    - **Markets:** virtualized card grid (and a list toggle), category rail, sort/filter, search. Card shows image, question, venue chip, close countdown, **large probability chip**, 7-day sparkline, 24h volume, and side-by-side `▲ YES 63¢` / `▼ NO 37¢` buttons. Tapping either opens the ticket pre-filled to that side.
    - **Order ticket:** dual-linked dollars ⇄ contracts input, preset chips, and a **server-quoted** box showing Avg fill / Slippage / Cost / Max payout / Max profit / Breakeven. Debounce quote requests 250ms. The client displays the quote; it never computes it.
    - **Book:** bankroll, today/season P&L, equity curve, tabs for Open / Orders / History with entry, mark, and unrealized P&L per row.
    - Every surface carries the non-dismissible `SIMULATED · NO REAL MONEY` badge.

**UI principle — steal the shared language:** every serious prediction market UI has converged on the same primitives. Implement all of them: the probability chip; the Yes/No pair as **two explicit columns, never tabs** (tabs are the documented pain point on Polymarket); prices in cents and payouts in dollars; the cost/payout/profit triplet; series→event→market hierarchy; sparklines and full charts with 1H/6H/1D/1W/1M/ALL; volume and open interest as trust signals; a collapsible depth ladder; a "Rules" accordion with resolution criteria; a live countdown to close. Use venue-adaptive vocabulary — "shares" on Polymarket markets, "contracts" on Kalshi markets. Never encode YES/NO by color alone. Use tabular figures for every number.

**Phase 2 milestone: install → sign in → place a ghost order in under 90 seconds.**

---

### Phase 3 — The loop closes (weeks 7–9)

13. **Settlement** (60s cron). Detect close → poll venue resolution → pay out $1/share to winners, $0 to losers → write ledger transactions → close positions → cancel resting orders → **write a `calibration_records` row** (`p_user`, `p_market`, `outcome`, `brier_user`, `brier_market`, `edge_bps`) → recompute scores → notify. Handle voids (refund at cost, **exclude from calibration** — a void is not a forecast error) and resolution revisions (compensating transactions, never DELETE).

14. **Record screen** — the differentiator. Brier Skill Score with a 95% CI, calibration curve (10 bins, point size = n), Murphy decomposition (reliability / resolution / uncertainty), per-category breakdown, and a plain-English coaching verdict. **Statistical honesty is mandatory:** never show a BSS below n=30 (show "Building your record — 18/30"), always show the CI, gray out categories with n<20 as "thin".

15. **Seasons and the Ladder.** Monday 00:00 UTC → Sunday 23:59 UTC. Five divisions (Bronze→Diamond) with pods of ~50 and promotion/relegation per §7.2. Ladder points = `0.45·normalized_return + 0.35·brier_skill + 0.10·discipline + 0.10·activity`, with returns **winsorized at the 5th/95th percentile** and activity saturating at 15 trades. Eligibility: ≥10 trades, ≥5 markets, ≥2 categories, account ≥72h, X account ≥30 days old or verified Google email, no integrity flags, and **Realistic or Brutal realism mode** (Instant mode is excluded from the ladder and from calibration entirely). Rollover job handles finalization, promotion, badges, pod rebalancing, and fresh season portfolios (G$10,000 each week; the lifetime book runs separately and untouched).

**Phase 3 milestone: a full week runs end to end with no manual intervention.**

---

### Phase 4 — Growth (weeks 10–12)

16. **Weekly Wrapped** — a `share-card` Edge Function rendering a 1200×675 PNG (Satori + resvg) with handle, season return, division, **Brier Skill Score**, best call, and equity sparkline. Cache to Supabase Storage. One-tap X share intent linking to `ghostfill.app/u/:handle`. **Prototype and test this with 20 alpha users in week 2, not week 12** — if the card doesn't get shared, the growth model is wrong and you need to know early.

17. **Ghost Mode content script.** Draggable, collapsible overlay on `polymarket.com/event/*` and `kalshi.com/markets/*` showing your ghost position and Ghost YES/NO buttons.
    - **Shadow DOM `mode:'closed'`.** Append exactly one node to `document.body`; **never mutate host DOM.**
    - Detect the market by **URL parsing, not DOM scraping** (DOM breaks on every host redeploy; URLs are stable). Resolve slug→`market_id` through your own backend. `MutationObserver` on `history.pushState` — both sites are SPAs.
    - **Collision-detect against the host's real order panel and never cover it.**
    - Visually distinct from the host (violet border + `SIM` chip) so it can never be mistaken for a native control.
    - Ship a **server-controlled kill switch** flag so a host redesign can be handled without a new release (config, not remote code).
    - Keep `content.js` under 60 KB — it runs on every page load.

18. Public profiles on `ghostfill.app`, notifications, onboarding polish.

---

### Phase 5 — Launch
Web Store submission (assume one rejection; budget the round trip), compliance pass per §20, privacy policy, Product Hunt / HN / Reddit.

### Phase 6 — Depth
Regret Replay · Head-to-Head Duels · Shadow Book (15-min delayed, read-only, never auto-copies) · Private Leagues + Classrooms · Readiness Check · more venues via the adapter interface.

---

## THE FILL ENGINE — THE HONESTY CONTRACT

This is what separates a credible simulator from a toy. Four rules, non-negotiable:

1. **Never fill beyond visible depth.** 500 shares available, 2,000 requested → 500 filled, order marked `partial`. Do not synthesize liquidity. Beginners getting a terrible average fill on a thin book **is the lesson**.
2. **Cap orders at 5% of visible book depth**, rejecting with *"Larger than this market can absorb — in reality you'd move the price against yourself."* This kills the main leaderboard exploit.
3. **Replay latency.** Fill against a snapshot taken *after* `quote_time + latency_ms`, not the one the user quoted from. If price moved >2% adverse, reject with `price_moved`. This teaches the most expensive lesson in trading: your quote is not your fill.
4. **Do not model market impact — and say so in Settings.** Rule 2 keeps sizes small enough that it doesn't matter. Honesty about limitations is a feature.

**Limit orders** rest with cash in `reserved_balance` and use a **queue-position model**: you only fill from volume that traded *through* your level since the last check, times `QUEUE_FACTOR = 0.35` (you're roughly two-thirds back in the queue). Without this, limit orders fill perfectly every time, which is the second-biggest lie a bad simulator tells.

**Every rejection is a teaching moment.** Ship specific copy for each reason (§12.6), never a generic "order failed".

---

## ANTI-CHEAT — SHIP THIS BEFORE THE FIRST PUBLIC SEASON

Server-authoritative pricing, server timestamps, idempotency keys, single-use 10-second quotes, rate limits (30 orders/min, 300/hr, 120 quotes/min), 5% depth cap, 20% single-market position cap, 30s staleness rejection, Instant-mode exclusion.

Nightly detections writing to `integrity_events`:
- **Multi-accounting** — anti-correlated position sets across accounts in the same pod (pairwise correlation < −0.85 over ≥15 shared markets). Mitigated mostly by the X-account-age-≥30-days eligibility gate.
- **Wash trading** — close within 60s within 1 tick. Mitigated structurally: full fees on both legs make it negative EV, and activity_score counts distinct markets and saturates at 15.
- **Thin-market farming** — mitigated by the depth cap plus winsorized returns plus 35% calibration weight.
- **Resolution front-running** — the nastiest one. A game ends at 22:14 and Kalshi settles at 22:31; in between the price is 99¢. **Freeze new orders when best bid ≥97¢ or best ask ≤3¢ with a spread under 2¢**, exclude positions opened in the last 5% of market lifetime from calibration, and cap ladder contribution from entries above 95¢ / below 5¢.
- **Impossible latency** — orders within 200ms of a >3¢ book move, repeated.

Enforcement ladder: flag → warn → season ineligibility → shadow ban → ban. **Always show the reason and always offer an appeal.** False positives on a fake-money game are how you get a viral complaint thread.

---

## DESIGN TOKENS

```
bg          #0B0D10      surface   #14171C      border  #232830
yes/long    #00D18F      no/short  #FF4D6A      muted   #7A8290
brand       #8B5CF6      ← violet, deliberately NOT green/red so brand chrome
                            is never confused with P&L
sim-marker  2px violet left-border + "SIM" chip on every price surface
type        Inter (UI) · JetBrains Mono w/ tabular figures (ALL numbers)
```

Dark-first (both venues are dark-dominant). Colorblind-safe toggle (blue/orange). Respect `prefers-reduced-motion`. Full keyboard operation: `/` search, `B`/`S` buy/sell, `Esc` cancel, arrows navigate.

---

## DEFINITION OF DONE (every PR)

- [ ] Typechecks, lints, builds
- [ ] `packages/core` coverage ≥ 90%
- [ ] No `service_role` or secret pattern anywhere in the built artifact (CI-enforced)
- [ ] RLS verified for any new table; security advisor clean
- [ ] Every new user-facing price/position/order surface carries the SIMULATED badge
- [ ] Edge Functions emit structured JSON logs `{fn, user_id, market_id, duration_ms, outcome, error}`
- [ ] Migrations are forward-only (never edit a committed migration)
- [ ] Nightly ledger integrity check still passes: `Σ transactions + starting_balance == cash_balance` for every portfolio

---

## WHAT TO DO FIRST, RIGHT NOW

1. `pnpm init` the monorepo with turbo, tsconfig, eslint, prettier.
2. Write `packages/core/src/book.ts` — `walkBook` — with property tests. Nothing else. Get it right.
3. Write `packages/venues/src/types.ts` — the `VenueAdapter` interface and normalized types.
4. Write the Polymarket adapter's `getOrderBook` and prove against live data that YES + NO merge into one coherent book.
5. Set up a Kalshi developer account, get an API key pair, and implement RSA-PSS request signing against the **demo** host.
6. Write the Kalshi adapter's `getOrderBook` — synthesize both ask ladders from the bid-only `orderbook_fp` response — and **prove `best_yes_ask == 100 − best_no_bid` and `best_no_ask == 100 − best_yes_bid` on 100 live markets** before writing another line.

Report back after step 6 with the invariant test results before proceeding.
