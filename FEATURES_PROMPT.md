# Ghostfill — next pass: 10 features + cleanup

> Paste into your coding agent. This repo is real and already working (local-first
> solo play, server-authoritative leaderboard backend deployed but not wired up).
> Read `TODO_AND_SECURITY.md` first — items P0 #1 and #3 there (unset `CRON_SECRET`,
> unlimited free profile minting) must be fixed **before** feature 1 below, since
> that feature is what makes them exploitable by someone other than you.

## Ground rules

- This is `packages/core` + `packages/venues` + `apps/extension` + `supabase/functions`, a real pnpm/npm workspace monorepo. Read the existing code's conventions before adding to it — it's terser and more heavily commented-on-the-why than average; match that.
- Local-first is the default and must stay untouched by anything below unless a feature explicitly requires the server. `packages/core`'s `walkBook`, `fees`, `pnl`, `scoring` are shared by both the local engine (`apps/extension/src/lib/engine.ts`) and the server (`supabase/functions/_shared/fill.ts`) — **one engine, not two.** If a feature needs new scoring or fill logic, it goes in `packages/core` first, then both callers use it.
- Every PR: `npm run typecheck --workspaces && npm test --workspaces && npm run build --workspace @ghostfill/extension`. The build's self-verification (no missing manifest refs, no secrets, size budgets) must stay green.
- Content script (`apps/extension/src/content/index.ts`) budget is 60 KB, currently at 18.4 KB — leave headroom.
- Never let the `SIMULATED · NO REAL MONEY` disclaimer disappear from any new price/position/order surface.

---

## Cleanup pass (do this first, it's fast and unblocks the rest)

1. Fix the six items in `TODO_AND_SECURITY.md` §2 (dead `lib/compete.ts` reference, `.gitignore` gap, README load instructions, `npm run verify` script, confirm coverage gate, tests for `resolve.ts`/`engine.ts`).
2. Add `.github/workflows/ci.yml` running `npm run verify` (once it exists) on every push and PR.
3. Extract the repeated `meta` object construction in `apps/extension/test/local-engine.test.ts` (built 4 times identically) into a helper — small, but it's the kind of duplication that hides a real diff next time someone touches `MarketMeta`.

---

## The 10 features

Ordered so each one only depends on what's above it.

### 1. Wire the leaderboard opt-in end to end
The backend (`bootstrap`, `quote`, `order-submit`, `portfolio`, `settle`) is deployed and tested. The extension has a realism/settings toggle that currently does nothing. Build:
- `apps/extension/src/lib/compete.ts` — thin client for the four Edge Functions, mirroring the shape of `engine.ts` (same `MarketMeta`, same quote/order types from `packages/core`, so the UI doesn't need to branch on local-vs-server data shapes any more than necessary).
- Device key generation (crypto-random, ≥32 chars) and storage in `chrome.storage.local`, separate key from the local portfolio so switching the toggle off doesn't touch solo-play data.
- A **plain-language opt-in screen**, not just a toggle: state what leaves the device (fills, positions, category — never anything else), and the device-key-loss warning from the TODO doc.
- A **Settings → "Show my device key"** reveal-and-copy control, so a user can carry their leaderboard identity to a reinstall. Treat it like a password field (masked by default, explicit reveal).
- Do this only after `CRON_SECRET` is set and a bootstrap rate limit exists (TODO §1 P0).

### 2. Calibration Record screen
The single most differentiated feature in the whole plan and currently unbuilt in the extension UI (the SQL — `compute_calibration`, `calibration_bins`, `calibration_by_category` — already exists in migration 0004/0006). Build the side-panel screen: Brier Skill Score with the confidence interval, the 10-bin calibration curve, Murphy decomposition (reliability/resolution), per-category breakdown. Reuse `packages/core/src/scoring.ts` for anything computed client-side in local/solo mode (a local-only calibration view over `chrome.storage.local` positions, separate from the server aggregate). Gate the headline number behind `n >= 30` exactly as specced — show "Building your record — 18/30" below that.

### 3. Regret Replay
After any closed position (local or server), let the user scrub the market's price history with entry/exit marked and a counterfactual ("held to resolution → +$X"). Needs a price-history fetch per venue — `packages/venues` doesn't have this yet (Polymarket has `/prices-history`; Kalshi doesn't expose candles the same way, so that adapter may need to reconstruct from stored `book_snapshots` server-side, or you scope v1 to Polymarket-only and say so in the UI). Render with a small inline sparkline component, no new charting dependency yet — check whether the budget allows `lightweight-charts` before pulling it in.

### 4. Weekly Wrapped share card
A generated image (server-side, since it needs to read the leaderboard/calibration aggregates): handle, week's return, Brier Skill Score, best call, equity sparkline. New Edge Function `share-card`, Satori + resvg → PNG, cached to Supabase Storage. One-tap share intent to X. This depends on feature 1 (opt-in) existing — solo-only players have nothing server-side to summarize, so scope this to leaderboard participants and say so.

### 5. Position sizing guardrail with a real teaching moment
`packages/core` has the depth cap and the honesty rules already. Add the **20%-of-bankroll single-position cap** from the master plan (§12.6 `position_limit`) if it isn't already enforced locally — check `engine.ts`'s `OrderError` codes against the master plan's table and fill any gap. Each rejection should carry the specific, teaching-moment copy from `BUILD_PROMPT.md`'s §12.6 table, not a generic message. Audit all existing `OrderError` throw sites for this before adding new ones.

### 6. Multi-outcome market support (read-only)
Both venues have non-binary markets you're currently either excluding or mishandling — check `packages/venues/src/types.ts`'s `NormalizedMarket` for whether it assumes exactly two outcomes. Add ingestion + display for N-outcome markets, explicitly **not tradeable** in v1 (label clearly, no order ticket rendered). This unblocks a real chunk of Polymarket's catalog that's currently invisible.

### 7. Watchlist
Simple, high-leverage, currently absent: star a market from the discovery list, see it in a dedicated tab, get it auto-promoted to the "hot" polling tier client-side (more frequent `GET_BOOK` refresh) the way the server already tiers hot/warm/cold. Pure local-storage feature for solo players; if feature 1 is live, sync it server-side too (there's a `watchlist` table shape already implied in the master plan — check whether migrations cover it, add one if not).

### 8. Head-to-Head Duels
Challenge another leaderboard participant to a single-market, fixed-stake, deadline-bound bet. Needs: a duel invite/accept flow, a locked-position type (can't close early), and settlement piggybacking on the existing `settle` function's position-close path. This is a bigger lift than the others here — scope it to leaderboard participants only, and treat the invite as a new small table + two new Edge Function endpoints (`duel-create`, `duel-respond`), not a bolt-on to `order-submit`.

### 9. Category-level calibration insight on the Dashboard
The Record screen (feature 2) shows the full breakdown; the Dashboard should surface the single most useful line from it without requiring a screen change — e.g. "You have real edge in politics (+0.14), none in sports (−0.03)." Small, cheap, reuses feature 2's data, and it's the exact coaching-moment framing from the master plan's §7.1 table — implement that decision table (overconfident / too timid / not there yet / real edge) as a pure function in `packages/core/src/scoring.ts` with its own unit tests, then call it from both the Dashboard summary and the full Record screen.

### 10. Readiness Check
A gated screen, unlocked only at ≥100 resolved positions (local or server, whichever the user has more of — probably local, since that's the default path), that gives a blunt, honest verdict using feature 2's BSS + CI + max drawdown + worst streak + category edges. If BSS is negative, it says so plainly and recommends against funding a real account. This is the feature that makes the "learn before it costs you anything" pitch literal — write the copy carefully, it's doing marketing and ethical work at the same time. No new backend needed if solo-local data is sufficient; reuses feature 2's computation entirely.

---

## Definition of done, same bar as the rest of this repo

- [ ] `npm run typecheck --workspaces` clean
- [ ] `npm test --workspaces` — new code has tests, nothing newly skipped except explicitly-live-network cases gated behind `LIVE=1`
- [ ] `npm run build --workspace @ghostfill/extension` self-verification passes (no missing files, no secrets, size budgets)
- [ ] Every new server write path has RLS + an explicit `revoke ... grant to service_role` if it's a new function (see migration 0008 for the pattern)
- [ ] Every new price/position/order UI surface carries the SIMULATED badge
- [ ] No feature that touches the leaderboard ships before `TODO_AND_SECURITY.md` P0 items are closed
