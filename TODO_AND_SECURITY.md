# Ghostfill — TODO and security checklist

State as of this pass: local-first solo play works end to end (typecheck clean, 47/47 non-live tests pass, build self-verifies). Leaderboard backend is deployed and tested but not called by the extension yet. This doc is what's left, ordered by what actually blocks something.

---

## 0. Just fixed (this session)

- **The load error.** `chrome://extensions` said *"Could not load javascript 'src/content/index.js' for script. Could not load manifest."* Root cause: `vite.config.ts` had `emptyOutDir: true` and `build.mjs` used `cpSync` for the manifest/icons — both do an `unlink` before writing. On this machine's filesystem, a previous build's file handles weren't releasing cleanly, so `unlink` threw `EPERM` mid-build. The build crashed *after* partially clearing `dist/`, leaving a `manifest.json` with no matching `src/content/index.js` next to it — exactly the error Chrome showed. Fixed by making the build overwrite-in-place instead of delete-then-write (`emptyOutDir: false`, `cpSync` replaced with plain read+write). **If you ever see that error again, it means the build crashed — check the terminal output, don't just re-load the folder.**
- Gated the 4 live-network tests in `apps/extension/test/local-engine.test.ts` behind `LIVE=1`, matching the pattern already used in `packages/venues/test/live-invariants.test.ts`. They were failing unconditionally in any offline/CI environment, which is a false negative, not a real bug.
- Full verification run: `npm run typecheck --workspaces` clean, `npm test --workspaces` → 47 passed / 7 skipped (skipped = live-network only), `npm run build --workspace @ghostfill/extension` → self-verifies no missing files, no secrets, budget-compliant sizes.

**How to load it now:** `npm install && npm run build --workspace @ghostfill/extension`, then `chrome://extensions` → Developer mode → **Load unpacked** → select `apps/extension/dist` (the `dist` folder specifically, not `apps/extension`). If the build ever errors, fix that first — a red error in the terminal means there is no valid `dist/`, and Chrome will fail exactly this way.

---

## 1. Security — ordered by exploitability

### P0 — fix before the leaderboard is reachable by anyone but you

1. **`CRON_SECRET` is unset on the deployed project.** `requireCronSecret()` in `supabase/functions/_shared/api.ts` fails *open*: `if (!expected) return;`. Right now `settle` and `ingest` (even though `ingest` also 410s — see #2) are two `service_role`-backed functions callable by anyone who finds the URL, no auth at all. Set `CRON_SECRET` as a project env var and pass `x-cron-secret` from whatever calls them (your cron scheduler / GitHub Action). This is a one-line env var away from closed and it's the single biggest open hole right now.
2. **Confirm `ingest` really is dead.** You said it 410s — good. Once `CRON_SECRET` is set, decide: delete the function entirely (it crawled 7,647 markets you didn't want) or keep it gated and dormant for when markets are created lazily. Dead code that still deploys is a bigger attack surface than no code.
3. **Unlimited free profile minting.** `ensure_profile()` (called by every function via `requireDevice`) creates a fresh G$10,000 profile for *any* string ≥16 characters passed as `x-device-key` — no rate limit, no CAPTCHA, no cost. Fine for solo play (that's the point — no signup friction). **Not fine once the leaderboard goes live**: this is an unmitigated Sybil vector — script 500 device keys, take correlated opposite positions across them, guarantee a top-of-ladder finish. The master plan called for X/Google OAuth specifically to raise this cost; the pivot to device-keys removed that gate. Before wiring the leaderboard toggle, add at least one of: (a) a per-IP rate limit on `bootstrap` (Supabase Edge Functions can read the source IP header), (b) a minimum "account age" or activity threshold before a profile is leaderboard-eligible (the master plan's ≥72h / ≥10 trades gate — reuse it), (c) a lightweight proof-of-work or CAPTCHA on first bootstrap. (a) + (b) together are cheap and enough for v1.
4. **CORS is `Access-Control-Allow-Origin: '*'` on every function.** Reasonable for a bearer-token-free, device-key-based API with no cookies involved — there's no session to steal cross-origin. Just confirm that stays true: if you ever add cookie-based auth, this header becomes a real hole and needs to scope to the extension's origin.

### P1 — fix before you'd call the leaderboard "launched"

5. **Wire the Settings leaderboard toggle to the actual Edge Functions.** Right now it writes a local preference and nothing else — `store.ts` even references a `lib/compete.ts` in a comment that doesn't exist yet. This is a product decision (what happens on a device change / reinstall — do they lose their leaderboard identity? is there a recovery phrase?) more than a security one, but it's the literal last step between "backend works" and "feature exists."
6. **Device-key loss = permanent identity loss, by design.** Worth a plain-language warning in Settings before anyone opts into the leaderboard: *"This device is your identity. Clearing extension storage or switching devices loses your ladder history — there's no password reset."* Decide now whether you want a printable/copyable recovery string (simplest: let the user view+copy their raw device secret from Settings so they can paste it into a new install).
7. **Run the Supabase security advisor and get to zero findings** before flipping the leaderboard on. You already fixed the big one (`record_order_fill` PUBLIC-execute hole, migration 0008) — good instinct, that's exactly the kind of thing the advisor catches. Re-run it after any new function or table.
8. **Nightly ledger integrity check is wired into `settle`** (`check_ledger_integrity()`) but only *logs* on drift — nothing pages you. Once real users exist, route that `console.error` to an actual alert (Sentry, a webhook, anything). A silent ledger drift is a silent-then-loud leaderboard credibility problem.

### P2 — hygiene, do opportunistically

9. **Rotate now, not later, if `.env` was ever committed.** You verified no `service_role` string is in the pushed repo — good — but also grep the full git *history*, not just HEAD: `git log -p --all | grep -i service_role` (or `git secrets`/`trufflehog` over the whole history). A key that was committed and later removed in a follow-up commit is still in history.
10. **`scripts/check-secrets.mjs` and `build.mjs`'s own secret scan** cover the built bundle — good — but nothing currently scans `supabase/functions/` source before deploy. Add the same pattern check to `scripts/build-functions.mjs` or a pre-deploy CI step.
11. **Kalshi API key storage.** Confirm the private key lives in Supabase Vault (or at minimum an Edge Function secret), never in `supabase/functions/_shared/` as a literal. Quick check: `grep -rn "BEGIN.*PRIVATE KEY" supabase/` should return nothing.

---

## 2. Cleanup backlog — ordered by leverage

1. **Remove the dead `lib/compete.ts` reference** in `store.ts`'s doc comment, or create the file — right now it's a comment pointing at nothing, which is confusing for anyone reading the code cold (including a coding agent you hand this to next).
2. **`.gitignore` doesn't cover Vitest's `*.timestamp-*.mjs` temp files.** They showed up as untracked cruft this session. Add `**/vitest.config.ts.timestamp-*.mjs` to `.gitignore`.
3. **`README.md` — update the load-unpacked instructions** to explicitly say "select `apps/extension/dist`, not `apps/extension`" given that's the exact mistake the error message invites.
4. **Add a `npm run verify` root script** that chains `typecheck && test && build` — the thing you actually want to run before trusting a change, in one command, instead of three.
5. **`packages/core` coverage** — check it's actually at the 90% gate the master plan set (`packages/core/coverage/` exists, so it's being measured; confirm it's enforced in CI, not just generated locally).
6. **`apps/extension/src/lib/resolve.ts` and `engine.ts`** have no dedicated unit tests of their own (only exercised indirectly via the live-gated `local-engine.test.ts`). Worth a fixture-based test file for each so the offline test run actually covers the local engine, not just `packages/core`.
7. **CI.** There's no `.github/workflows/` yet in this repo (the master plan specified one). Now that build/typecheck/test all pass cleanly and quickly, this is a good time to add a CI job that runs all three on every push — cheap insurance against the exact "silently broken build" failure mode that caused today's bug.
