# GHOSTFILL — Master Plan

**A Chrome extension for paper trading prediction markets.**
Real markets. Real prices. Fake money. Real skill.

---

**Document version:** 1.0
**Date:** 6 August 2026
**Stack decision:** Supabase (Postgres + Edge Functions + Auth) · Chrome MV3 · React + TypeScript
**Venue coverage (v1):** Polymarket + Kalshi
**Brand direction:** sharp / trader slang

---

## 0. TL;DR — the whole thing in one page

You are building **Ghostfill**: a Chrome extension that sits on top of Polymarket and Kalshi and lets people trade those markets with simulated money against **live, real order books**. Every fill is a "ghost fill" — priced exactly as it would have been in reality, but nothing settles to a wallet.

Three things make it more than a toy:

1. **Server-authoritative simulation.** The extension never decides a price. The backend pulls the real book, walks it, applies realistic slippage + fee models + a latency penalty, and writes an immutable fill. This is what makes a leaderboard credible instead of a joke.

2. **Calibration Score, not just P&L.** Anyone can get lucky. Ghostfill scores you on a **Brier Skill Score vs. the market's own price** — "when you disagreed with the market, were you right?" This is the single metric that no competitor ships, it's the actual skill in prediction markets, and it's the entire marketing story.

3. **Weekly Ladder seasons with promotion/relegation + auto-generated share cards.** Every Monday the board resets, divisions shuffle, and everyone gets a Wrapped-style image they want to post on X. X OAuth is both your login and your growth loop.

**The timing is the alpha.** As of **1 August 2026** — five days ago — the Chrome Web Store bans extensions that facilitate real-money prediction market trading. The same policy paragraph *explicitly permits* simulated ones. Every real-money competitor extension is getting delisted right now. You are shipping the one category Google just cleared.

---

## 1. Why now — the regulatory window

### 1.1 The policy text

Chrome Web Store Program Policies, *Regulated goods and services*, clause 2:

> "We don't allow content or services that facilitate or promote real money gambling or prediction markets, including but not limited to online casinos, sports betting, lotteries, or games of skill that offer prizes of cash or other value. **Products that simulate gambling or prediction markets, but don't offer any opportunity for real money winnings, payouts, or prizes of value may be allowed. However, such products must clearly indicate that no real money is involved** and comply with all other applicable policies of the Chrome Web Store."

Enforcement against real-money prediction market extensions began **1 August 2026**.

### 1.2 What that means operationally

This is not a footnote. It is a **hard architectural constraint** that shapes the product:

| Constraint | Consequence for Ghostfill |
|---|---|
| No facilitation of real-money trades | The extension must **never** inject a control that places a real order, prefills a real order ticket, or deep-links to a real buy flow with parameters. |
| No prizes "of cash or other value" | Leaderboard rewards must be **cosmetic only** — badges, titles, profile flair, division rank. No gift cards, no crypto, no "top 10 get $100". Ever. |
| Must clearly indicate no real money | A persistent, non-dismissible **"SIMULATED — NO REAL MONEY"** badge in every surface that shows a price or a position. Store listing title/description must say it. First-run screen must say it. |
| Comply with all other policies | Minimal permissions, no remote code execution, published privacy policy, single-purpose extension. |

**Rule for the whole team:** if a feature could be described as "helps you place a real bet," it does not ship. If it can be described as "helps you learn whether you'd be any good at placing a real bet," it ships.

### 1.3 Market context

- Kalshi + Polymarket are roughly **97.5%** of prediction market volume.
- Kalshi closed May 2026 at **$17.91B** notional (ninth consecutive record month); Polymarket at **$7.08B**, down 21% from its March peak. Kalshi holds ~73% share as of early July.
- Sports, politics and crypto are **~90–91%** of volume on both venues.
- Volume has soared industry-wide over the past year (Pew, May 2026).

Translation: a very large, very fast-growing pool of people are about to put real money into instruments they do not understand, and Google just deleted the competing extension category. That is the opening.

---

## 2. Naming and brand

You picked the **sharp / trader-slang** direction. Here's the shortlist, then the recommendation.

### 2.1 Shortlist

| Name | Meaning / why it works | Risk |
|---|---|---|
| **Ghostfill** ⭐ | A fill that isn't real. Describes the product exactly, in one word, in trader language. Ownable, no baggage, great logo potential. | Slight "spooky" skin if you lean too hard on it. Don't use a ghost emoji. |
| **Blotter** | The trader's daily log of every trade. Beautifully insider-y. | "Blotter" also means blotter acid — minor SEO/association noise. |
| **Dry Powder** | Capital held in reserve, ready to deploy. Fits "learn before you deploy real capital" perfectly. | Two words, harder as a handle. |
| **The Tape** / **Tapelab** | "Reading the tape" = reading order flow. | "Tape" is generic; hard to trademark. |
| **Sharpen** | A "sharp" is a professional bettor. Verb form implies improvement. | Crowded name in SaaS. |
| **Runback** | Running a trade back to see how it would have gone. | Slightly ambiguous. |
| **Conviction** | The thing paper trading actually tests. Strong word. | Legal/criminal connotation. |
| **Vig** | The house's cut. Very insider. | Too gambling-coded for a Chrome Web Store review. **Avoid.** |
| **Backfill** | Filling in after the fact. | Reads as a data-engineering term. |
| **Sizing** | Position sizing — the skill most beginners lack. | Too generic. |

### 2.2 Recommendation

**Ghostfill.**

- One word, two syllables, trader-native, and it *is* the product spec: your orders fill like ghosts — real price, no substance.
- Zero gambling connotation, which matters enormously for Chrome Web Store review.
- Scales into a whole vocabulary: **ghost fill** (a simulated execution), **ghost book** (your simulated portfolio), **Ghost Mode** (the on-page overlay), **the Ghost Ladder** (the weekly leaderboard), **ghosting a market** (paper-trading it).

**Asset checklist to claim today (verify availability yourself — do not assume):**

- `ghostfill.app` (primary), `ghostfill.io`, `ghostfill.com` (stretch)
- `@ghostfill` on X, `@ghostfill` on Discord, `r/ghostfill`
- GitHub org: `ghostfill`
- Chrome Web Store listing name: **"Ghostfill — Paper Trade Prediction Markets"**

### 2.3 Brand voice

- **Confident, dry, technical.** Talks to you like a desk colleague, not a casino.
- Never celebrates a win with confetti. Celebrates *calibration*.
- Never says "bet." Says **trade**, **position**, **fill**, **book**, **edge**.
- The one-liner: **"Find out if you're actually good at this — before it costs you anything."**

### 2.4 Visual identity

- **Dark-first.** Both Polymarket and Kalshi are dark-mode-dominant; a light-first extension would feel foreign immediately.
- **Base:** near-black `#0B0D10`, surface `#14171C`, border `#232830`.
- **Semantic:** YES/long `#00D18F`, NO/short `#FF4D6A`, neutral `#7A8290`, accent (Ghostfill brand) `#8B5CF6` violet — deliberately *not* green or red, so brand chrome never gets confused with P&L.
- **The simulation tell:** every price surface carries a subtle 2px violet left-border and a `SIM` chip. This is both a compliance requirement and a brand signature. Users should be able to tell at a glance "this number is a ghost."
- **Type:** Inter (UI) + a tabular-figures mono (JetBrains Mono / Geist Mono) for **every number**. Tabular figures are non-negotiable in a trading UI — digits must not jitter as prices tick.

---

## 3. Product definition

### 3.1 What Ghostfill is

A Chrome extension (MV3) + Supabase backend that lets a user:

1. Sign in with **X** or **Google**.
2. Get a simulated bankroll (default **$10,000** "ghost dollars", denominated `G$`).
3. Browse or search live Polymarket and Kalshi markets inside the extension side panel, **or** open a real market page and see a Ghost Mode overlay on it.
4. Place simulated market or limit orders that are priced server-side against the **real, live order book**.
5. Watch positions mark-to-market in real time, and settle automatically when the real market resolves.
6. Get scored on **P&L, Brier Skill Score, calibration curve, streaks, and discipline metrics**.
7. Compete on a **weekly Ladder** with divisions, promotion, and relegation.
8. Get a shareable **Weekly Wrapped** card, one tap to post on X.

### 3.2 What Ghostfill is explicitly NOT

- Not a broker, exchange, or introducing broker.
- Not a route to real-money trading. No deep links with order parameters, no affiliate funnels into real order tickets, no "trade this for real" button.
- Not a prize competition. Rewards are cosmetic, always.
- Not financial advice. Not signal-selling. Not copy-trading into real money.

### 3.3 Target users

| Segment | Size signal | Job to be done |
|---|---|---|
| **The curious lurker** | The largest by far — people who've read about Polymarket but never funded an account | "I want to know if I'd be any good at this without wiring money" |
| **The new funder** | Just deposited $100–500, down 40%, doesn't know why | "I need to learn position sizing before I blow up" |
| **The forecaster** | Metaculus/Manifold crowd, quantitatively literate | "I want a Brier score against real market prices, not play markets" |
| **The sports bettor crossing over** | Huge inbound flow as sports = the top category on both venues | "Event contracts look like betting but the math is different" |
| **The educator** | Econ/finance instructors, forecasting clubs | "I want a class competition with no gambling exposure" |

The educator segment is small but is your **credibility and press** segment. A "Ghostfill for Classrooms" mode (private leagues, instructor dashboard) is cheap to build on top of seasons and buys you legitimacy that no growth hack can.

---

## 4. Competitive landscape

| Competitor | What it is | Weakness you exploit |
|---|---|---|
| **DemoMarket** (Chrome extension) | Injects a "Demo" button on Polymarket for simulated buy/sell with virtual funds | Single-venue, no leaderboard, no calibration scoring, no social layer, no seasons. It's a feature; Ghostfill is a product. |
| **Manifold** | Play-money prediction market with its own currency (Mana) | Its markets are *not real markets* — prices come from a small play-money crowd. Your entire pitch is "real prices, fake money." Manifold is "fake prices, fake money." |
| **Metaculus** | Research forecasting platform, Brier scoring | No order book, no P&L, no position sizing, no trading mechanics at all. It teaches forecasting, not trading. |
| **thinkorswim paperMoney / TradingView / Webull sim** | Best-in-class equity/options paper trading | Zero prediction market coverage. But: **study their UX**. They are the reference for "what a serious sim feels like." |
| **Kalshi / Polymarket themselves** | Could ship a demo mode | They won't, and they can't — a demo mode cannibalizes deposits and creates regulatory questions about promotional gaming. This is a structurally safe niche. |
| **Real-money PM extensions** | Portfolio trackers, order helpers | **Being delisted from the Chrome Web Store as of 1 Aug 2026.** Their users need somewhere to go. |

**Defensibility:** the moat is not the simulator (that's a weekend). The moat is (a) the accumulated calibration history — a user with 8 months of Brier data will not restart elsewhere, (b) the ladder's network effects, and (c) the ingestion + settlement pipeline being genuinely fiddly to get right across two venues.

---

## 5. UI study — 10 prediction market interfaces

**Goal: a user who has used Polymarket or Kalshi should never have to learn anything.** Ghostfill's UI should feel like a native mode of the site they're already on.

### 5.1 The ten platforms studied

| # | Platform | Design DNA | What to steal |
|---|---|---|---|
| 1 | **Polymarket** | Web3-native. Grid of market **cards** with image, question, big % chip, volume. Buy/sell panel with Yes/No tabs. On-chain receipts per fill. | Card grid, the giant probability chip, the Yes/No two-button primary action, the "Buy Yes at 63¢" phrasing |
| 2 | **Kalshi** | Reads like a **brokerage screen**. Lists, filters, charts, a proper order ticket with type/limit/qty/cost/max-payout. Account-based. | The order ticket layout, explicit "Cost / Max payout / Max profit" triplet, filter rail, series→event→market hierarchy |
| 3 | **Manifold** | Community-created markets, playful, comment-heavy, prominent creator identity. Play money is normalized and *fun*. | How to make fake currency feel like it matters. Comment threads under markets. Creator/leaderboard prominence. |
| 4 | **Metaculus** | Forecast-first. Community distribution curves, track records, Brier scores front and center. | **The track record page.** Calibration curve visualization. Scoring transparency. This is the core of your differentiator. |
| 5 | **Myriad Markets** | Markets **embedded directly into news content** — trade while you read | Contextual, inline market widgets. Directly inspires Ghost Mode's on-page overlay. |
| 6 | **Limitless** | Fast, mobile-first, low-friction one-tap trading, short-duration markets | Speed. One-tap order entry with preset sizes. |
| 7 | **Drift BET** | DeFi-native on Solana; leverage, liquidity pools, advanced order types | Advanced order type UI — good reference for your limit/stop UI in v2. |
| 8 | **PredictIt** | Old-school, dense, table-first, US politics | Dense table view for power users. Some people want a spreadsheet, not cards. Ship both. |
| 9 | **Futuur** | Dual-currency (play + real) side by side | **Directly relevant** — how they visually separate play from real. Study their labeling; you must be even clearer. |
| 10 | **Robinhood event contracts** | Consumer-grade, extremely simplified, heavy onboarding | The onboarding funnel. How to make a first trade happen in under 60 seconds. |

### 5.2 The convergent patterns (build these — they are the shared language)

Every serious prediction market UI has converged on the same primitives. Ghostfill implements all of them:

1. **The probability chip.** A large percentage, colored, at the top-right of every market card. Users read the chip before the question. Make it the largest element after the question text.

2. **The Yes/No binary pair.** Two side-by-side buttons, green YES with price, red NO with price. Always shows *price in cents*, never a decimal probability, because both major venues price in cents. `YES 63¢ · NO 37¢`.

3. **Price expressed in cents, payout expressed in dollars.** Universal convention: shares cost 0–100¢, pay $1 if right, $0 if wrong. Your order ticket must show `Cost` and `Max payout` and `Max profit` and `Profit if right (%)`.

4. **The cost/payout triplet in the order ticket.** Kalshi's biggest UX win. Never make the user compute payout.

5. **Series → Event → Market hierarchy.** "Fed decisions" (series) → "Fed decision, Sept 2026" (event) → "≥50bp cut" (market). Your data model must mirror this or navigation will feel broken.

6. **The price history sparkline / chart.** Every market card gets a 7-day sparkline; every market detail gets a full chart with 1H / 6H / 1D / 1W / 1M / ALL toggles.

7. **Volume + liquidity as trust signals.** Always show 24h volume and open interest. Users use these to judge whether a price is real.

8. **The category filter rail.** Politics / Sports / Crypto / Economics / Culture / Science. Sports + politics + crypto = ~90% of volume; put them first.

9. **Order book depth ladder.** Bids on one side, asks on the other, cumulative size. Power users demand it; beginners ignore it. Collapsed by default, one tap to expand.

10. **Position rows that show entry, mark, and unrealized P&L.** Three numbers, colored, tabular figures.

11. **Resolution criteria, always accessible.** A "Rules" accordion on every market. Half of all prediction-market disputes are people who didn't read the resolution source.

12. **Countdown to close/resolution.** A live timer creates urgency and is present on every venue.

### 5.3 The divergences (where you must choose)

| Axis | Polymarket way | Kalshi way | **Ghostfill choice** |
|---|---|---|---|
| Discovery | Image-rich card grid | Dense filterable list | **Both.** Grid default, `⌘/Ctrl+Shift+L` toggles to list. Remember per user. |
| Order entry | Simple buy panel, amount in $ | Full order ticket, amount in contracts | **Dual input.** Type dollars *or* contracts; the other field computes live. This is the single biggest beginner UX unlock. |
| Yes/No presentation | Tabs (confusing per user reports) | Two explicit columns | **Two explicit columns.** Never tabs. Tabs are the documented pain point on Polymarket. |
| Vocabulary | "Shares", crypto-native | "Contracts", brokerage-native | **Venue-adaptive.** Show "shares" on Polymarket markets, "contracts" on Kalshi markets. Small touch; enormous familiarity payoff. |
| Color | Green/red | Green/red | Green/red. Do not innovate here. |

### 5.4 Accessibility (do this from day one, it's cheap)

- Never encode YES/NO by color alone — always pair with the word and a directional glyph (▲/▼).
- Ship a colorblind-safe palette toggle (blue/orange instead of green/red).
- All numbers use tabular figures so screen magnification doesn't reflow.
- Full keyboard operation: `/` focus search, `B`/`S` buy/sell, `Esc` cancel, arrows navigate the market list.
- Respect `prefers-reduced-motion`: price flashes become static color changes.

---

## 6. Information architecture and screens

### 6.1 Surfaces

Ghostfill has **four** surfaces. Keeping this list short is what keeps the extension "single purpose" for Web Store review.

```
┌─ 1. SIDE PANEL (chrome.sidePanel) — the main app, always available
│    ├─ Markets      (discover, search, filter, watchlist)
│    ├─ Book         (open positions, orders, history, P&L chart)
│    ├─ Ladder       (weekly leaderboard, divisions, your rank)
│    ├─ Record       (calibration curve, Brier, streaks, badges)
│    └─ Settings     (account, bankroll reset, sim realism, theme, privacy)
│
├─ 2. GHOST MODE OVERLAY (content script on polymarket.com / kalshi.com)
│    └─ A floating, draggable, collapsible panel pinned to the real market page
│
├─ 3. POPUP (action click) — deliberately minimal
│    └─ Bankroll, today's P&L, ladder rank, "Open Ghostfill" button
│
└─ 4. WEB (ghostfill.app) — marketing site + public profiles + share card landing
     └─ /u/:handle public track record (SEO + the share loop's destination)
```

### 6.2 Screen-by-screen spec

#### 6.2.1 Markets (side panel default)

```
┌───────────────────────────────────────────┐
│ ⌕ Search markets…              [▦] [☰]   │  ← grid/list toggle
├───────────────────────────────────────────┤
│ ⬤ All  Politics  Sports  Crypto  Econ  … │  ← horizontally scrollable rail
├───────────────────────────────────────────┤
│ Sort: Volume ▾   Venue: All ▾   Close: ▾ │
├───────────────────────────────────────────┤
│ ┌───────────────────────────────────────┐ │
│ │ [img]  Will the Fed cut in September? │ │
│ │        POLYMARKET · closes in 34d     │ │
│ │        ╭───────╮   ▁▂▄▆▇▆▅   $2.4M   │ │  ← sparkline + 24h volume
│ │        │  63%  │                      │ │  ← the probability chip
│ │        ╰───────╯                      │ │
│ │  ┌──────────────┐ ┌──────────────┐   │ │
│ │  │ ▲ YES  63¢   │ │ ▼ NO   37¢   │   │ │
│ │  └──────────────┘ └──────────────┘   │ │
│ └───────────────────────────────────────┘ │
│                    …                      │
└───────────────────────────────────────────┘
```

- Infinite scroll, 20 per page, virtualized list (`@tanstack/react-virtual`) — this list will get long and MV3 side panels are memory-constrained.
- Tapping YES/NO opens the order ticket **pre-filled to that side** with the last-used size. One tap from browse to a filled ticket.
- Long-press / right-click a card → "Add to watchlist", "Open on Polymarket", "Copy resolution rules".

#### 6.2.2 Market detail + order ticket

```
┌───────────────────────────────────────────┐
│ ← Will the Fed cut in September?          │
│   POLYMARKET · Economics · closes 18 Sep  │
├───────────────────────────────────────────┤
│         63%  ▲ +4 (24h)                   │
│   ╭─────────────────────────────────────╮ │
│   │        (price chart)                │ │
│   ╰─────────────────────────────────────╯ │
│    1H  6H  1D  1W  1M  ALL                │
├───────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐        │
│  │  ▲ BUY YES  │  │  ▼ BUY NO   │        │
│  │    63¢      │  │    37¢      │        │
│  └─────────────┘  └─────────────┘        │
│                                           │
│  Order type   [ Market ▾ ]                │
│  Amount       [ $ 100.00 ] ⇄ [ 158 sh ]  │  ← dual-linked input
│  Presets      [25] [50] [100] [MAX]       │
│                                           │
│  ┌───────────────────────────────────┐   │
│  │ Avg fill        63.4¢             │   │  ← server-quoted, book-walked
│  │ Slippage        0.4¢  (0.6%)      │   │
│  │ Cost            $100.00           │   │
│  │ Max payout      $157.73           │   │
│  │ Max profit      $57.73  (+57.7%)  │   │
│  │ Breakeven       63.4%             │   │
│  └───────────────────────────────────┘   │
│                                           │
│  ┌───────────────────────────────────┐   │
│  │  ▲ PLACE GHOST ORDER — BUY YES    │   │
│  └───────────────────────────────────┘   │
│  ⓘ SIMULATED · NO REAL MONEY INVOLVED    │  ← persistent, non-dismissible
├───────────────────────────────────────────┤
│  ▸ Order book                             │
│  ▸ Resolution rules                       │
│  ▸ Recent ghost fills (community)         │
└───────────────────────────────────────────┘
```

**Critical detail:** the quote box (`Avg fill / Slippage / Cost / …`) is **fetched from the backend**, debounced 250ms on amount change. The client displays it, never computes it. It carries a server-signed `quote_id` with a 10-second TTL; the order submit must reference a live `quote_id`. This is the anti-cheat foundation.

#### 6.2.3 Book (positions)

Tabs: **Open · Orders · History**

```
┌───────────────────────────────────────────┐
│  Bankroll  G$ 11,847.22                   │
│  Today     ▲ +$312.44  (+2.7%)            │
│  Season    ▲ +$1,847.22 (+18.5%)          │
│  ╭─────── equity curve ───────╮           │
│  ╰────────────────────────────╯           │
├─── Open (7) ── Orders (2) ── History ─────┤
│ Fed cut Sept        YES  158sh            │
│ entry 63.4¢ · mark 71¢ · ▲ +$12.03 (+12%) │
├───────────────────────────────────────────┤
│ Lakers vs Celtics   NO   400sh            │
│ entry 41¢  · mark 33¢ · ▼ -$32.00 (-19%)  │
└───────────────────────────────────────────┘
```

Swipe/right-click a position → **Close**, **Close half**, **Add**, **View market**.

#### 6.2.4 Ladder (the weekly leaderboard) — see §7.2
#### 6.2.5 Record (calibration track record) — see §7.1

#### 6.2.6 Ghost Mode overlay (content script)

When the user is on `polymarket.com/event/*` or `kalshi.com/markets/*`, a compact panel docks bottom-right:

```
        ╭──────────────────────────────╮
        │ 👻 GHOSTFILL          — ✕    │
        │ Your ghost position           │
        │ YES 158sh @ 63.4¢             │
        │ ▲ +$12.03 (+12.0%)            │
        │ ┌──────────┐ ┌──────────┐    │
        │ │ ▲ GHOST  │ │ ▼ GHOST  │    │
        │ │ YES 63¢  │ │ NO  37¢  │    │
        │ └──────────┘ └──────────┘    │
        │ SIMULATED · NO REAL MONEY     │
        ╰──────────────────────────────╯
```

Rules for this overlay (compliance-critical):
- It is **draggable, collapsible, and fully dismissible per-site** (settings toggle to disable entirely).
- It must **never overlap or obscure the real site's order controls** — position it with collision detection against the real order panel's bounding box.
- Its buttons place **ghost** orders only. They must never touch the host page's DOM inputs.
- The `SIMULATED · NO REAL MONEY` line is not dismissible.
- Visual style is deliberately *distinct* from the host site (violet border, `SIM` chip) so no user can mistake it for a native control. This is both good ethics and your Web Store defence.

---

## 7. The killer features

### 7.1 ⭐ Calibration Score — the differentiator

**This is the feature.** Everything else is table stakes.

P&L alone is noise. On a 60-trade week, luck dominates skill. Ghostfill scores the thing that actually persists: **were your probability estimates better than the market's?**

#### The math

For every position, at entry, record:
- `p_user` — the implied probability you paid (your avg fill price ÷ 100)
- `p_market` — the market mid at the moment of your fill
- `o` — the eventual outcome, 1 if the side you bought resolved true, else 0

**Brier score** (lower is better, range 0–1):

```
B = (1/N) · Σ (p_i − o_i)²
```

**Brier Skill Score vs. the market** — the headline number:

```
BSS = 1 − (B_user / B_market)
```

- `BSS > 0` → you beat the market's own forecast. You have edge.
- `BSS = 0` → you are the market. Trading costs will kill you.
- `BSS < 0` → you are worse than just reading the price. Do not fund an account.

**Murphy decomposition** — for the coaching layer, split Brier into three terms:

```
B = Reliability − Resolution + Uncertainty
```

- **Reliability** (lower better): are your 70%s actually right 70% of the time? This is *calibration*.
- **Resolution** (higher better): do you make confident calls that differ from the base rate? This is *discrimination*.
- **Uncertainty**: property of the markets you chose, not of you. Normalizes across easy/hard market mixes.

This gives you three distinct coaching messages instead of one score:

| Pattern | Diagnosis | In-app message |
|---|---|---|
| Poor reliability, good resolution | Overconfident | "You pick the right side, but you size and price like you're more certain than you are. Your 80%s hit 62%." |
| Good reliability, poor resolution | Too timid | "You're well calibrated but you never disagree with the market. Well-calibrated agreement earns nothing." |
| Both poor | Not there yet | "Right now you're paying the spread to express the market's own opinion. Here's what to work on." |
| Both good, BSS > 0 | You have edge | "Over 140 resolved positions, your forecasts beat the market by 8.3%. That's real." |

#### The Record screen

```
┌───────────────────────────────────────────┐
│  YOUR RECORD              142 resolved    │
│                                           │
│      BRIER SKILL SCORE                    │
│           +0.083                          │
│      You beat the market by 8.3%          │
│      ▓▓▓▓▓▓▓▓░░░░  95% CI: +0.02 → +0.15  │  ← show the CI. Honesty is the brand.
│                                           │
│  CALIBRATION CURVE                        │
│  100│                            ·╱       │
│     │                        ●  ╱         │
│   75│                    ●   ╱            │
│     │                ●   ╱                │
│   50│            ●  ╱                     │
│     │        ●  ╱                         │
│   25│    ●  ╱                             │
│     │  ●╱                                 │
│    0└─────────────────────────────        │
│      0    25    50    75   100            │
│      your stated probability →            │
│      ╱ = perfect   ● = you (size = n)     │
│                                           │
│  Reliability   0.021  ▓▓▓▓▓▓▓▓░░  good    │
│  Resolution    0.094  ▓▓▓▓▓▓░░░░  fair    │
│                                           │
│  BY CATEGORY                              │
│   Politics   +0.14  (48)   ▓▓▓▓▓▓▓▓       │
│   Crypto     +0.09  (37)   ▓▓▓▓▓▓         │
│   Sports     −0.03  (44)   ▓▓░░░░         │
│   Econ       +0.11  (13)   ▓▓▓▓▓ · thin   │
│                                           │
│  ⓘ You have real edge in politics and     │
│    none in sports. If you ever trade for  │
│    real, that's where your size belongs.  │
└───────────────────────────────────────────┘
```

**Why this wins:** it's the single most defensible thing in the product. It requires resolved-outcome history, which takes months to accumulate. A user with a 200-position calibration record has switching costs that no clone can erase. It's also inherently viral — "I have a +0.08 Brier Skill Score against Polymarket" is a flex that only exists if Ghostfill exists.

**Statistical honesty rules (bake these in):**
- Never show a BSS with `n < 30` resolved positions. Show "Building your record — 18/30" instead.
- Always show the 95% confidence interval.
- Gray out any category with `n < 20` and label it "thin".
- Never let a lucky 5-trade week produce a boast.

### 7.2 ⭐ The Ladder — weekly seasons with promotion and relegation

Straight leaderboards fail: after week two, the top is unreachable and 95% of users disengage. Divisions fix this — everyone is always in a winnable race.

**Season:** Monday 00:00 UTC → Sunday 23:59 UTC.

**Divisions** (you're placed after your first 10 resolved positions):

| Division | Population | Promote | Relegate |
|---|---|---|---|
| 💎 Diamond | Top 1% | — | Bottom 20% |
| 🔷 Platinum | Next 4% | Top 10% | Bottom 20% |
| 🥇 Gold | Next 15% | Top 15% | Bottom 20% |
| 🥈 Silver | Next 30% | Top 20% | Bottom 20% |
| 🥉 Bronze | Everyone else | Top 25% | — |

**Within a division, you're bucketed into pods of ~50.** You race 49 peers, not 400,000. Your rank is always legible ("you're 12th of 50, 4 places from promotion") and always movable.

**Scoring — deliberately NOT pure P&L:**

```
Ladder Points = 0.45 · normalized_return
              + 0.35 · brier_skill_score_this_season
              + 0.10 · discipline_score
              + 0.10 · activity_score
```

- `normalized_return` — season % return, **winsorized at the 5th/95th percentile** so one lottery ticket can't win the week.
- `brier_skill_score_this_season` — only counts positions that resolved this season.
- `discipline_score` — rewards consistent position sizing (low coefficient of variation on stake size), penalizes >20% of bankroll in one position and >50% in one category.
- `activity_score` — saturating at 15 trades. Prevents both inactivity and spam.

**Why weight calibration at 35%:** it makes the leaderboard reward the skill you're teaching, not the variance you're not. It also makes farming much harder — you cannot brute-force a Brier score.

**Eligibility gates (anti-farm):**
- ≥ 10 trades across ≥ 5 distinct markets in ≥ 2 distinct categories
- Account age ≥ 72 hours
- Verified OAuth identity (X account age ≥ 30 days, or Google account with verified email)
- No flagged integrity events this season

**Rewards are cosmetic only.** Division badge on your profile, an animated border for Diamond, a permanent "Season 14 Diamond" title, a streak counter for consecutive weeks held. **No cash, no crypto, no gift cards, no prizes of any value — ever.** This is a Chrome Web Store policy requirement, not a preference.

```
┌───────────────────────────────────────────┐
│  🔷 PLATINUM · Pod 7      Season 14       │
│  ⏳ Resets in 2d 14h 22m                  │
│                                           │
│  ↑ PROMOTION ZONE ───────────────────     │
│   1  @swanhunter    2,847   +0.19  💎     │
│   2  @tapewatcher   2,610   +0.14         │
│   3  @nofloor       2,455   +0.11         │
│   4  @dry_powder    2,301   +0.09         │
│   5  @basisrisk     2,180   +0.07         │
│  ─────────────────────────────────────    │
│   …                                       │
│  ▸ 12  YOU              1,640   +0.04     │
│   …                                       │
│  ─────────────────────────────────────    │
│  ↓ RELEGATION ZONE ──────────────────     │
│  41  @yolo_only       410   −0.22         │
│                                           │
│  4 places from promotion.                 │
└───────────────────────────────────────────┘
```

### 7.3 ⭐ Weekly Wrapped — the growth loop

Every Monday at 09:00 in the user's local time, a notification: *"Your week is in."*

Tapping it opens a full-bleed, animated, **1200×675 shareable card** rendered server-side (Satori + resvg in a Deno edge function, cached to Supabase Storage):

```
╔═══════════════════════════════════════════╗
║  GHOSTFILL · SEASON 14                    ║
║                                           ║
║  @dry_powder                              ║
║                                           ║
║      ▲ +18.4%          🔷 PLATINUM        ║
║      season return       4th of 50        ║
║                                           ║
║      BRIER SKILL   +0.083                 ║
║      you beat the market by 8.3%          ║
║                                           ║
║  BEST CALL                                ║
║  "Fed cuts 50bp in September"             ║
║  bought YES at 34¢ · resolved YES         ║
║  +$1,240                                  ║
║                                           ║
║  ▁▂▄▃▆▇▆█  equity curve                   ║
║                                           ║
║  ghostfill.app  ·  SIMULATED, NO REAL $   ║
╚═══════════════════════════════════════════╝
```

One tap → X intent with pre-filled text and the image, linking to `ghostfill.app/u/dry_powder`.

**Why this is the loop:** the card contains a number (`+0.083 Brier Skill`) that is *only obtainable through Ghostfill*. It is a status object. People post status objects. And the landing page is a public track record, which is both the ad and the SEO surface.

### 7.4 Supporting features (in priority order)

**5. Regret Replay.** After a position closes, scrub the market's price history with your entry and exit marked. Overlay a counterfactual: "held to resolution → +$340" or "you exited 4h before the peak." Turns every loss into a lesson instead of a sting.

**6. Head-to-Head Duels.** Challenge a friend on a single market with a fixed stake and a deadline. Both positions locked until resolution. Winner takes a cosmetic W. Lightweight, extremely shareable, and perfect for the X audience.

**7. The Shadow Book.** Follow a top-ranked trader; their new ghost positions appear in a read-only feed **with a 15-minute delay**. Never auto-copies. Never links to real trading. Learning tool, not a signal service — say this explicitly in the UI.

**8. Conviction Streaks.** Consecutive resolved positions where you were on the right side *and* beat the market price. Streak-freeze token earned every 7 days (Duolingo mechanic, works).

**9. Private Leagues / Ghostfill for Classrooms.** Invite-code leagues with their own ladder, an instructor dashboard, and a CSV export of every student's Brier score. Cheap (it's seasons scoped to a `league_id`) and it buys you legitimacy, press, and a B2B2C wedge.

**10. Paper→Real Readiness Check.** A gated screen that will not unlock until you have ≥ 100 resolved positions, and then tells you plainly: your BSS with CI, your max drawdown, your worst tilt streak, your category edges — and a blunt verdict. If your BSS is negative it says so. **This feature is the marketing message made literal**, and it must be scrupulously honest, including telling users not to fund an account. That honesty is the entire brand.


---

## 8. System architecture

### 8.1 The big picture

```
┌──────────────────────── CHROME ────────────────────────┐
│                                                        │
│  ┌────────────┐  ┌────────────┐  ┌──────────────────┐ │
│  │ Side Panel │  │   Popup    │  │  Content Script  │ │
│  │  (React)   │  │  (React)   │  │   (Ghost Mode)   │ │
│  └──────┬─────┘  └──────┬─────┘  └────────┬─────────┘ │
│         │  chrome.runtime message bus      │           │
│         └────────────┬────────────────────┘           │
│                      ▼                                 │
│         ┌─────────────────────────────┐               │
│         │  SERVICE WORKER (MV3)       │               │
│         │  • Supabase client w/       │               │
│         │    chrome.storage adapter   │               │
│         │  • session + token refresh  │               │
│         │  • alarms (poll fallback)   │               │
│         │  • notifications            │               │
│         └──────────┬──────────────────┘               │
│                    │                                   │
│  ┌─────────────────▼─────────────────┐                │
│  │ OFFSCREEN DOCUMENT                │                │
│  │ • Realtime WebSocket (survives    │                │
│  │   SW sleep)                       │                │
│  │ • chrome.identity.launchWebAuth   │                │
│  └─────────────────┬─────────────────┘                │
└────────────────────┼──────────────────────────────────┘
                     │ HTTPS + WSS (JWT)
                     ▼
┌──────────────────── SUPABASE ─────────────────────────┐
│                                                       │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────┐  │
│  │ GoTrue Auth │  │ PostgREST    │  │  Realtime   │  │
│  │ X + Google  │  │ (RLS-gated   │  │  (postgres  │  │
│  │ OAuth       │  │  reads)      │  │  changes)   │  │
│  └─────────────┘  └──────────────┘  └─────────────┘  │
│                                                       │
│  ┌───────────────── EDGE FUNCTIONS (Deno) ─────────┐ │
│  │  quote          order-submit    order-cancel    │ │
│  │  position-close leaderboard     share-card      │ │
│  │  profile-init   readiness       league-join     │ │
│  └─────────────────────────────────────────────────┘ │
│                                                       │
│  ┌──────────────── CRON (pg_cron) ─────────────────┐ │
│  │  ingest-markets     30s   venue adapters        │ │
│  │  ingest-books        5s   top-N hot markets     │ │
│  │  ingest-books-cold   60s  everything else       │ │
│  │  match-resting       5s   limit order engine    │ │
│  │  mark-to-market     15s   position marks        │ │
│  │  settle             60s   resolved markets      │ │
│  │  leaderboard-refresh 60s  matview refresh       │ │
│  │  season-rollover    weekly Mon 00:00 UTC        │ │
│  │  wrapped-generate   weekly Mon 00:05 UTC        │ │
│  └─────────────────────────────────────────────────┘ │
│                                                       │
│  ┌──────────┐  ┌───────────┐  ┌──────────────────┐  │
│  │ Postgres │  │  Storage  │  │  Vault (secrets) │  │
│  │ +TimescaleDB│ (cards)   │  │                  │  │
│  └──────────┘  └───────────┘  └──────────────────┘  │
└───────────────────────────────────────────────────────┘
                     │
        ┌────────────┴────────────┐
        ▼                         ▼
┌───────────────┐        ┌──────────────────┐
│  POLYMARKET   │        │     KALSHI       │
│ gamma-api     │        │ external-api     │
│ clob          │        │ /trade-api/v2    │
│ data-api      │        │ + WSS (auth'd)   │
│ WSS (public)  │        │                  │
└───────────────┘        └──────────────────┘
```

### 8.2 The one architectural rule that matters

> **The client is a renderer. The server is the exchange.**

Every price, every fill, every P&L number, every score is computed server-side from server-fetched data with server timestamps. The extension sends *intent* (`"buy 100 dollars of YES on market X, quote_id Q"`) and receives *results*. It never sends a price, a timestamp, or a P&L.

If you break this rule anywhere, the leaderboard is worthless within a week — someone will open devtools, and they will be right to.

### 8.3 Why a separate ingestion path from user requests

Market data is fetched on a **fixed cron schedule shared across all users**, never on demand per user. Reasons:

1. **Rate limits.** Polymarket's limits are Cloudflare-driven and global — roughly 4,000 req/10s on Gamma, 9,000 req/10s on CLOB overall, but with much tighter per-endpoint sub-budgets (practically ~60 req/min on Gamma and ~100 req/min on CLOB reads for a polling client). Kalshi is tiered token-cost, ~20 reads/s on basic. Per-user fetching gets you banned at 500 users.
2. **Consistency.** Two users quoting the same market at the same second must see the same book. Otherwise the leaderboard is unfair.
3. **Cost.** One fetch serves everyone.
4. **Auditability.** Every fill references a specific stored `book_snapshot_id`. You can reconstruct any fill months later during a dispute.

### 8.4 Hot/cold market tiering

You cannot poll 40,000 markets every 5 seconds. Tier them:

| Tier | Definition | Book poll | Meta poll |
|---|---|---|---|
| **HOT** | Any market with an open ghost position, an open resting order, on a watchlist, or top-200 by 24h volume | 5s (or WS) | 60s |
| **WARM** | Top 2,000 by volume, or viewed by anyone in the last 30 min | 30s | 5 min |
| **COLD** | Everything else | on-demand + 10 min | 30 min |

Promotion HOT/WARM/COLD is recomputed every 60s by a cron job. A market instantly becomes HOT the moment anyone opens its detail view or places an order.

Use **Polymarket's public WebSocket** for hot-tier prices rather than REST polling — this is explicitly the recommended pattern and it's what keeps you inside rate limits. **Kalshi's WebSocket requires API key auth even for public channels**, so you will need a Kalshi developer account with API keys stored in Supabase Vault; the REST market-data endpoints (`/markets`, `/markets/{ticker}`, `/markets/{ticker}/orderbook`, `/markets/trades`) are usable without auth as a fallback.

---

## 9. Data model

Full Postgres schema. Enable `pgcrypto`, `pg_cron`, and optionally `timescaledb` for the tick hypertable.

### 9.1 Enums and extensions

```sql
create extension if not exists pgcrypto;
create extension if not exists pg_cron;
create extension if not exists pg_stat_statements;

create type venue_code       as enum ('polymarket', 'kalshi');
create type market_status    as enum ('open','closed','resolving','resolved','cancelled');
create type order_side       as enum ('buy','sell');
create type outcome_side     as enum ('yes','no');
create type order_type       as enum ('market','limit');
create type order_status     as enum ('pending','open','partial','filled','cancelled','rejected','expired');
create type txn_kind         as enum ('grant','fill_debit','fill_credit','fee','settlement','reset','adjustment');
create type sim_realism      as enum ('instant','realistic','brutal');
create type division_tier    as enum ('bronze','silver','gold','platinum','diamond');
create type integrity_kind   as enum ('multi_account','wash_trade','stale_quote','rate_abuse','impossible_latency','book_impact');
```

### 9.2 Identity and profiles

```sql
-- auth.users is managed by Supabase GoTrue.
-- auth.identities holds the X / Google provider links.

create table public.profiles (
  id                uuid primary key references auth.users(id) on delete cascade,
  handle            citext unique not null
                      check (handle ~ '^[a-z0-9_]{3,20}$'),
  display_name      text not null,
  avatar_url        text,
  bio               text check (char_length(bio) <= 200),
  primary_provider  text not null,                    -- 'twitter' | 'google'
  x_user_id         text unique,
  x_username        text,
  x_account_created_at timestamptz,                   -- anti-sybil signal
  google_email_verified boolean default false,
  country_code      char(2),
  timezone          text default 'UTC',

  sim_realism       sim_realism not null default 'realistic',
  theme             text default 'dark',
  colorblind_mode   boolean default false,
  layout_pref       text default 'grid',              -- 'grid' | 'list'

  is_public         boolean not null default true,    -- public track record page
  is_leaderboard_eligible boolean not null default true,
  shadow_banned     boolean not null default false,

  onboarded_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index on public.profiles (handle);
create index on public.profiles (created_at desc);
```

### 9.3 Venues, markets, outcomes

Mirrors the universal **series → event → market → outcome** hierarchy so navigation feels native on both venues.

```sql
create table public.venues (
  code            venue_code primary key,
  display_name    text not null,
  base_url        text not null,
  fee_model       jsonb not null default '{}'::jsonb,
  is_enabled      boolean not null default true
);

insert into public.venues (code, display_name, base_url, fee_model) values
  ('polymarket','Polymarket','https://polymarket.com',
     '{"taker_bps":0,"maker_bps":0,"note":"no explicit trading fee; cost is spread + gas, gas not simulated"}'),
  ('kalshi','Kalshi','https://kalshi.com',
     '{"formula":"ceil(0.07 * C * P * (1-P))","note":"Kalshi trading fee formula; verify against current fee schedule before launch"}');

create table public.events (
  id              uuid primary key default gen_random_uuid(),
  venue           venue_code not null references public.venues(code),
  venue_event_id  text not null,
  series_key      text,                       -- e.g. 'FED', 'NBA'
  title           text not null,
  slug            text,
  description     text,
  category        text not null,              -- politics|sports|crypto|economics|culture|science|other
  subcategory     text,
  image_url       text,
  open_time       timestamptz,
  close_time      timestamptz,
  is_active       boolean not null default true,
  raw             jsonb,
  synced_at       timestamptz not null default now(),
  unique (venue, venue_event_id)
);

create index on public.events (category, close_time);
create index on public.events (venue, is_active);

create table public.markets (
  id                uuid primary key default gen_random_uuid(),
  event_id          uuid not null references public.events(id) on delete cascade,
  venue             venue_code not null references public.venues(code),
  venue_market_id   text not null,            -- Polymarket conditionId / Kalshi ticker
  question          text not null,
  slug              text,
  resolution_source text,
  resolution_rules  text,                     -- the "Rules" accordion content
  status            market_status not null default 'open',

  -- pricing (cents, 0..100)
  yes_bid           numeric(6,2),
  yes_ask           numeric(6,2),
  no_bid            numeric(6,2),
  no_ask            numeric(6,2),
  last_price        numeric(6,2),
  mid_price         numeric(6,2),
  price_24h_ago     numeric(6,2),

  volume_24h        numeric(20,2) default 0,
  volume_total      numeric(20,2) default 0,
  open_interest     numeric(20,2) default 0,
  liquidity         numeric(20,2) default 0,

  tick_size         numeric(6,4) not null default 1.0,
  min_order_size    numeric(20,4) not null default 1,

  open_time         timestamptz,
  close_time        timestamptz,
  resolved_at       timestamptz,
  resolution        outcome_side,             -- null until resolved
  resolution_note   text,

  data_tier         text not null default 'cold',    -- hot|warm|cold
  book_updated_at   timestamptz,
  meta_updated_at   timestamptz,
  raw               jsonb,

  unique (venue, venue_market_id)
);

create index on public.markets (status, close_time);
create index on public.markets (data_tier) where status = 'open';
create index on public.markets (volume_24h desc) where status = 'open';
create index on public.markets (event_id);
create index markets_question_trgm on public.markets using gin (question gin_trgm_ops);
```

### 9.4 Order books and price history

```sql
-- Immutable book snapshots. Every fill points at one of these.
create table public.book_snapshots (
  id            bigserial primary key,
  market_id     uuid not null references public.markets(id) on delete cascade,
  captured_at   timestamptz not null default now(),
  -- [[price_cents, size], ...] sorted best-first
  yes_bids      jsonb not null,
  yes_asks      jsonb not null,
  no_bids       jsonb not null,
  no_asks       jsonb not null,
  source_seq    bigint,                       -- venue sequence number if provided
  checksum      text
);
create index on public.book_snapshots (market_id, captured_at desc);

-- Retention: keep 7 days of all snapshots, then keep only snapshots referenced by a fill.
-- Everything else is pruned nightly.

create table public.price_ticks (
  market_id   uuid not null references public.markets(id) on delete cascade,
  ts          timestamptz not null,
  yes_mid     numeric(6,2) not null,
  yes_bid     numeric(6,2),
  yes_ask     numeric(6,2),
  volume      numeric(20,2),
  primary key (market_id, ts)
);
-- select create_hypertable('price_ticks','ts');  -- if using TimescaleDB

-- Pre-aggregated candles for charts (1m, 5m, 1h, 1d)
create table public.price_candles (
  market_id   uuid not null references public.markets(id) on delete cascade,
  bucket      text not null,               -- '1m','5m','1h','1d'
  ts          timestamptz not null,
  o numeric(6,2), h numeric(6,2), l numeric(6,2), c numeric(6,2),
  v numeric(20,2),
  primary key (market_id, bucket, ts)
);
```

### 9.5 Portfolios, orders, fills, positions

```sql
-- NOTE: `seasons` (defined in §9.6) must be created BEFORE `portfolios` in the
-- actual migration file — the FK below depends on it. Sections here are ordered
-- for reading, not for execution. Order your migration: venues → seasons →
-- profiles → events → markets → book_snapshots → portfolios → quotes → orders …
create table public.portfolios (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.profiles(id) on delete cascade,
  season_id         uuid references public.seasons(id),   -- null = lifetime portfolio
  starting_balance  numeric(20,4) not null default 10000,
  cash_balance      numeric(20,4) not null default 10000,
  reserved_balance  numeric(20,4) not null default 0,     -- locked by resting limit orders
  realized_pnl      numeric(20,4) not null default 0,
  unrealized_pnl    numeric(20,4) not null default 0,
  equity            numeric(20,4) generated always as
                      (cash_balance + reserved_balance + unrealized_pnl) stored,
  peak_equity       numeric(20,4) not null default 10000,
  max_drawdown_pct  numeric(8,4) not null default 0,
  reset_count       int not null default 0,
  last_reset_at     timestamptz,
  created_at        timestamptz not null default now(),
  unique (user_id, season_id)
);

-- Server-signed quotes. An order MUST reference a live quote.
create table public.quotes (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles(id) on delete cascade,
  market_id      uuid not null references public.markets(id) on delete cascade,
  snapshot_id    bigint not null references public.book_snapshots(id),
  side           order_side not null,
  outcome        outcome_side not null,
  requested_notional numeric(20,4),
  requested_qty      numeric(20,4),
  quoted_avg_price   numeric(8,4) not null,
  quoted_qty         numeric(20,4) not null,
  quoted_cost        numeric(20,4) not null,
  quoted_fee         numeric(20,4) not null default 0,
  slippage_bps       numeric(10,2),
  realism            sim_realism not null,
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null default (now() + interval '10 seconds'),
  consumed_at    timestamptz
);
create index on public.quotes (user_id, created_at desc);
create index on public.quotes (expires_at) where consumed_at is null;

create table public.orders (
  id              uuid primary key default gen_random_uuid(),
  portfolio_id    uuid not null references public.portfolios(id) on delete cascade,
  user_id         uuid not null references public.profiles(id) on delete cascade,
  market_id       uuid not null references public.markets(id),
  quote_id        uuid references public.quotes(id),
  idempotency_key text not null,

  side            order_side not null,
  outcome         outcome_side not null,
  type            order_type not null,
  limit_price     numeric(6,2),                 -- required when type='limit'
  qty_requested   numeric(20,4) not null,
  qty_filled      numeric(20,4) not null default 0,
  avg_fill_price  numeric(8,4),
  status          order_status not null default 'pending',
  reject_reason   text,

  time_in_force   text not null default 'gtc',  -- 'gtc' | 'ioc' | 'fok'
  expires_at      timestamptz,

  client_ts       timestamptz,                  -- recorded for forensics ONLY, never trusted
  server_ts       timestamptz not null default now(),
  filled_at       timestamptz,
  cancelled_at    timestamptz,

  unique (user_id, idempotency_key)
);
create index on public.orders (portfolio_id, server_ts desc);
create index on public.orders (market_id, status) where status in ('open','partial');

create table public.fills (
  id              bigserial primary key,
  order_id        uuid not null references public.orders(id) on delete cascade,
  portfolio_id    uuid not null references public.portfolios(id) on delete cascade,
  market_id       uuid not null references public.markets(id),
  snapshot_id     bigint not null references public.book_snapshots(id),

  side            order_side not null,
  outcome         outcome_side not null,
  qty             numeric(20,4) not null check (qty > 0),
  price           numeric(8,4) not null check (price > 0 and price < 100),
  notional        numeric(20,4) not null,
  fee             numeric(20,4) not null default 0,

  book_mid_at_fill    numeric(8,4) not null,    -- for calibration: p_market
  slippage_bps        numeric(10,2),
  latency_ms          int,
  filled_at       timestamptz not null default now()
);
create index on public.fills (portfolio_id, filled_at desc);
create index on public.fills (market_id, filled_at desc);

create table public.positions (
  id              uuid primary key default gen_random_uuid(),
  portfolio_id    uuid not null references public.portfolios(id) on delete cascade,
  user_id         uuid not null references public.profiles(id) on delete cascade,
  market_id       uuid not null references public.markets(id),
  outcome         outcome_side not null,

  qty             numeric(20,4) not null default 0,
  avg_entry_price numeric(8,4) not null,
  cost_basis      numeric(20,4) not null,
  mark_price      numeric(8,4),
  market_value    numeric(20,4),
  unrealized_pnl  numeric(20,4) default 0,
  realized_pnl    numeric(20,4) not null default 0,
  fees_paid       numeric(20,4) not null default 0,

  -- calibration snapshot, frozen at first entry
  entry_p_user    numeric(8,6),                 -- avg_entry_price / 100
  entry_p_market  numeric(8,6),                 -- book mid at first fill / 100
  entry_at        timestamptz,

  is_open         boolean not null default true,
  closed_at       timestamptz,
  settled_at      timestamptz,
  outcome_result  boolean,                      -- did this side win

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (portfolio_id, market_id, outcome)
);
create index on public.positions (portfolio_id) where is_open;
create index on public.positions (market_id) where is_open;
create index on public.positions (user_id, settled_at desc) where settled_at is not null;

-- Double-entry-ish ledger. Every balance change gets a row. Append-only.
create table public.transactions (
  id            bigserial primary key,
  portfolio_id  uuid not null references public.portfolios(id) on delete cascade,
  kind          txn_kind not null,
  amount        numeric(20,4) not null,        -- signed
  balance_after numeric(20,4) not null,
  order_id      uuid references public.orders(id),
  fill_id       bigint references public.fills(id),
  position_id   uuid references public.positions(id),
  memo          text,
  created_at    timestamptz not null default now()
);
create index on public.transactions (portfolio_id, created_at desc);
```

### 9.6 Seasons, ladder, calibration

```sql
create table public.seasons (
  id            uuid primary key default gen_random_uuid(),
  number        int unique not null,
  name          text not null,                 -- 'Season 14'
  starts_at     timestamptz not null,          -- Monday 00:00 UTC
  ends_at       timestamptz not null,          -- Sunday 23:59:59 UTC
  is_active     boolean not null default false,
  finalized_at  timestamptz
);

create table public.divisions (
  id            uuid primary key default gen_random_uuid(),
  season_id     uuid not null references public.seasons(id) on delete cascade,
  tier          division_tier not null,
  pod_number    int not null,
  member_count  int not null default 0,
  unique (season_id, tier, pod_number)
);

create table public.ladder_entries (
  id                uuid primary key default gen_random_uuid(),
  season_id         uuid not null references public.seasons(id) on delete cascade,
  division_id       uuid not null references public.divisions(id) on delete cascade,
  user_id           uuid not null references public.profiles(id) on delete cascade,
  portfolio_id      uuid not null references public.portfolios(id),

  ladder_points     numeric(12,4) not null default 0,
  normalized_return numeric(12,6),
  brier_skill       numeric(12,6),
  discipline_score  numeric(12,6),
  activity_score    numeric(12,6),

  rank_in_pod       int,
  rank_in_tier      int,
  rank_global       int,

  trades_count      int not null default 0,
  markets_count     int not null default 0,
  categories_count  int not null default 0,
  is_eligible       boolean not null default false,
  ineligible_reason text,

  final_tier        division_tier,
  promoted          boolean,
  relegated         boolean,
  updated_at        timestamptz not null default now(),
  unique (season_id, user_id)
);
create index on public.ladder_entries (division_id, ladder_points desc);
create index on public.ladder_entries (season_id, ladder_points desc) where is_eligible;

-- One row per resolved position. The calibration corpus.
create table public.calibration_records (
  id            bigserial primary key,
  user_id       uuid not null references public.profiles(id) on delete cascade,
  position_id   uuid not null references public.positions(id) on delete cascade unique,
  market_id     uuid not null references public.markets(id),
  season_id     uuid references public.seasons(id),
  category      text not null,

  p_user        numeric(8,6) not null,         -- implied prob you paid
  p_market      numeric(8,6) not null,         -- market mid at your fill
  outcome       int not null check (outcome in (0,1)),

  brier_user    numeric(10,8) not null,        -- (p_user - outcome)^2
  brier_market  numeric(10,8) not null,        -- (p_market - outcome)^2
  log_score_user numeric(12,8),                -- -ln(p) if right, -ln(1-p) if wrong
  edge_bps      numeric(12,4),                 -- (p_market - p_user) * 10000, signed by direction
  notional      numeric(20,4) not null,

  entered_at    timestamptz not null,
  resolved_at   timestamptz not null
);
create index on public.calibration_records (user_id, resolved_at desc);
create index on public.calibration_records (user_id, category);
create index on public.calibration_records (season_id, user_id);

create table public.badges (
  id          text primary key,               -- 'season_14_diamond', 'streak_30'
  name        text not null,
  description text not null,
  icon        text not null,
  rarity      text not null                   -- common|rare|epic|legendary
);

create table public.user_badges (
  user_id     uuid not null references public.profiles(id) on delete cascade,
  badge_id    text not null references public.badges(id),
  earned_at   timestamptz not null default now(),
  season_id   uuid references public.seasons(id),
  primary key (user_id, badge_id, season_id)
);

create table public.watchlist (
  user_id     uuid not null references public.profiles(id) on delete cascade,
  market_id   uuid not null references public.markets(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (user_id, market_id)
);

create table public.follows (
  follower_id uuid not null references public.profiles(id) on delete cascade,
  followee_id uuid not null references public.profiles(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (follower_id, followee_id),
  check (follower_id <> followee_id)
);

create table public.leagues (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references public.profiles(id) on delete cascade,
  name        text not null,
  invite_code text unique not null default encode(gen_random_bytes(6),'hex'),
  is_classroom boolean not null default false,
  max_members int not null default 200,
  created_at  timestamptz not null default now()
);

create table public.league_members (
  league_id   uuid not null references public.leagues(id) on delete cascade,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  role        text not null default 'member',   -- 'owner'|'instructor'|'member'
  joined_at   timestamptz not null default now(),
  primary key (league_id, user_id)
);

create table public.integrity_events (
  id          bigserial primary key,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  kind        integrity_kind not null,
  severity    int not null check (severity between 1 and 5),
  detail      jsonb not null,
  action_taken text,                            -- 'none'|'flagged'|'ineligible'|'shadow_ban'
  created_at  timestamptz not null default now()
);
create index on public.integrity_events (user_id, created_at desc);
```

### 9.7 Materialized view for the ladder

```sql
create materialized view public.ladder_public as
select
  le.season_id, le.division_id, d.tier, d.pod_number,
  le.user_id, p.handle, p.display_name, p.avatar_url,
  le.ladder_points, le.normalized_return, le.brier_skill,
  le.rank_in_pod, le.rank_in_tier, le.rank_global,
  le.trades_count
from public.ladder_entries le
join public.divisions d on d.id = le.division_id
join public.profiles  p on p.id = le.user_id
where le.is_eligible
  and not p.shadow_banned
  and p.is_public;

create unique index on public.ladder_public (season_id, user_id);
create index on public.ladder_public (division_id, ladder_points desc);

-- refreshed by cron every 60s
-- refresh materialized view concurrently public.ladder_public;
```

---

## 10. Row Level Security

**Turn RLS on for every table.** Anon key ships inside the extension bundle and is therefore public — RLS is your only real access control.

```sql
alter table public.profiles            enable row level security;
alter table public.portfolios          enable row level security;
alter table public.orders              enable row level security;
alter table public.fills               enable row level security;
alter table public.positions           enable row level security;
alter table public.transactions        enable row level security;
alter table public.quotes              enable row level security;
alter table public.calibration_records enable row level security;
alter table public.ladder_entries      enable row level security;
alter table public.watchlist           enable row level security;
alter table public.integrity_events    enable row level security;
alter table public.markets             enable row level security;
alter table public.events              enable row level security;
alter table public.book_snapshots      enable row level security;

-- ── Public reference data: readable by anyone authenticated ──
create policy "markets readable" on public.markets
  for select to authenticated using (true);
create policy "events readable" on public.events
  for select to authenticated using (true);
create policy "books readable" on public.book_snapshots
  for select to authenticated using (true);

-- ── Profiles ──
create policy "own profile full" on public.profiles
  for all to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

create policy "public profiles readable" on public.profiles
  for select to authenticated
  using (is_public = true and shadow_banned = false);

-- ── Portfolios / positions / orders / fills / txns: OWNER READ ONLY ──
create policy "own portfolio read" on public.portfolios
  for select to authenticated using (user_id = auth.uid());
create policy "own orders read" on public.orders
  for select to authenticated using (user_id = auth.uid());
create policy "own positions read" on public.positions
  for select to authenticated using (user_id = auth.uid());
create policy "own fills read" on public.fills
  for select to authenticated
  using (exists (select 1 from public.portfolios pf
                 where pf.id = fills.portfolio_id and pf.user_id = auth.uid()));
create policy "own txns read" on public.transactions
  for select to authenticated
  using (exists (select 1 from public.portfolios pf
                 where pf.id = transactions.portfolio_id and pf.user_id = auth.uid()));
create policy "own quotes read" on public.quotes
  for select to authenticated using (user_id = auth.uid());
create policy "own calibration read" on public.calibration_records
  for select to authenticated using (user_id = auth.uid());

-- ── NO INSERT / UPDATE / DELETE POLICIES ON ANY TRADING TABLE. ──
-- Writes happen exclusively through Edge Functions using the service_role key,
-- which bypasses RLS. There is deliberately no client-side path to create an
-- order, a fill, a position, or a transaction. This is the whole security model.

-- ── Ladder: read your own row always; read others only if eligible+public ──
create policy "ladder read" on public.ladder_entries
  for select to authenticated
  using (
    user_id = auth.uid()
    or exists (select 1 from public.profiles p
               where p.id = ladder_entries.user_id
                 and p.is_public and not p.shadow_banned)
  );

-- ── Watchlist: user-owned, safe to allow direct writes ──
create policy "own watchlist" on public.watchlist
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ── Integrity events: never readable by users ──
-- (no policies at all = deny all for authenticated; service_role bypasses)
```

**Advisor checklist before launch:** run Supabase's security advisor and confirm zero "RLS disabled" and zero "policy allows anon write" findings. Also confirm you are shipping the **publishable/anon** key in the extension, never the `service_role` key. If `service_role` ever appears in a bundled artifact, rotate immediately — the bundle is world-readable once published.


---

## 11. Market data ingestion

### 11.1 The adapter interface

Every venue implements one interface. Adding Manifold, Limitless, or Myriad later becomes a ~200-line file instead of a refactor.

```ts
// packages/venues/src/types.ts
export interface VenueAdapter {
  readonly code: 'polymarket' | 'kalshi';

  /** Discover events + markets. Paginated, cursor-based. */
  listEvents(cursor?: string): Promise<{ events: NormalizedEvent[]; next?: string }>;

  /** Full metadata for specific markets. Batched. */
  getMarkets(venueMarketIds: string[]): Promise<NormalizedMarket[]>;

  /** L2 order book. Normalized to cents (0-100) + share size. */
  getOrderBook(venueMarketId: string): Promise<NormalizedBook>;

  /** Batched book fetch where the venue supports it. */
  getOrderBooks(ids: string[]): Promise<Map<string, NormalizedBook>>;

  /** Historical candles for charts. */
  getPriceHistory(venueMarketId: string, from: Date, to: Date, interval: Interval)
    : Promise<Candle[]>;

  /** Resolution status for settlement. */
  getResolutions(venueMarketIds: string[]): Promise<Resolution[]>;

  /** Optional live stream. Falls back to polling if unsupported. */
  subscribe?(ids: string[], onTick: (t: Tick) => void): Unsubscribe;

  /** Fee model for realistic sim. */
  computeFee(qty: number, priceCents: number, side: 'buy'|'sell'): number;
}

export interface NormalizedBook {
  marketId: string;
  capturedAt: Date;
  // Always expressed as: price in CENTS (0-100), size in SHARES/CONTRACTS
  yes: { bids: [number, number][]; asks: [number, number][] };
  no:  { bids: [number, number][]; asks: [number, number][] };
  sourceSeq?: number;
}
```

**Normalization is the whole job.** Polymarket thinks in ERC-1155 token IDs, decimal USDC prices `0.0–1.0`, and shares. Kalshi thinks in tickers, integer cents `1–99`, and contracts. Everything downstream — the fill engine, the UI, the scoring — sees only the normalized form: **price in cents 0–100, size in units, YES and NO both as first-class sides.**

### 11.2 Polymarket adapter

| Need | Endpoint | Auth |
|---|---|---|
| Event/market discovery + metadata | `GET https://gamma-api.polymarket.com/events`, `/markets` | none |
| Live book | `GET https://clob.polymarket.com/book?token_id=…`, `/books` (batch) | none |
| Best prices / midpoint / spread | `GET https://clob.polymarket.com/price`, `/midpoint`, `/spread` | none |
| Price history | `GET https://clob.polymarket.com/prices-history?market=<token_id>&interval=…` | none |
| Live stream | Polymarket public WebSocket, `market` channel | none |
| Trade/position data | `https://data-api.polymarket.com/*` | none |

Key facts to build around:
- **Public read endpoints require no API key, no auth, no wallet.** Only order placement needs EIP-712 L2 headers — and you will **never** place a real order, so you never need a wallet. Say this loudly in your privacy policy; it's a trust asset.
- Each binary market has **two token IDs** (YES and NO). `getOrderBook` must fetch both and normalize them into one `NormalizedBook`.
- `/prices-history` accepts **one `token_id` at a time**. For charting many markets, batch it into a queue with concurrency ~4 and cache aggressively into `price_candles`.
- Rate limits are Cloudflare-driven and **global across all accounts** (no tiers): ~15,000 req/10s overall, ~4,000/10s Gamma, ~9,000/10s CLOB, ~1,000/10s Data — but tighter per-endpoint sub-budgets mean a naive poller hits limits at roughly 60 req/min on Gamma and ~100 req/min on CLOB reads. **Use the WebSocket for hot markets.** This is not optional at scale.

### 11.3 Kalshi adapter

Base URLs (both production hosts are supported):
- `https://external-api.kalshi.com/trade-api/v2`
- `https://api.elections.kalshi.com/trade-api/v2`

**Demo environment** — use this for local/dev/staging:
- `https://external-api.demo.kalshi.co/trade-api/v2`
- `https://demo-api.kalshi.co/trade-api/v2`

| Need | Endpoint | Auth |
|---|---|---|
| Markets list | `GET /markets?limit=1000&cursor=…&status=open` | key |
| Single market | `GET /markets/{ticker}` | key |
| Order book | `GET /markets/{ticker}/orderbook?depth=100` | **key (RSA-PSS signed)** |
| Trades | `GET /markets/trades` | key |
| Events / series | `GET /events`, `GET /series` | key |
| Live stream | WebSocket: `ticker`, `trade`, `market_lifecycle_v2` | **key** |
| Your rate tier | `GET /account/api-limits` | key |

**Key facts — verified against Kalshi's published OpenAPI spec (v3.27.0):**

- **Kalshi requires authentication, including for market data.** ⚠️ Some third-party guides claim Kalshi's REST market-data reads are open; the official spec for `/markets/{ticker}/orderbook` declares `kalshiAccessKey` / `kalshiAccessSignature` / `kalshiAccessTimestamp` security and documents a `401` response. **Budget for a Kalshi developer account and API key pair from day one.** Requests are signed with **RSA-PSS**: sign `timestamp_ms + METHOD + path` with your private key and send it as `KALSHI-ACCESS-SIGNATURE`, alongside `KALSHI-ACCESS-KEY` and `KALSHI-ACCESS-TIMESTAMP`. Store the private key in **Supabase Vault** — never in the repo, never in the bundle. All Kalshi calls happen server-side only.
- **Build against the demo host first.** It's the same API shape with no production rate pressure, and it's the natural fit for a paper-trading product's dev environment.
- Rate limits are **tiered and token-cost-based**; basic tier is roughly **20 reads/s, 10 writes/s**, max ~200 WebSocket connections. Poll `GET /account/api-limits` on boot and adapt your scheduler to the tier you actually have.
- ⚠️ **The orderbook returns YES and NO *bid* ladders only — no asks.** Kalshi's own docs: *"a bid for yes at price X is equivalent to an ask for no at price (100−X)… a yes bid at 7¢ is the same as a no ask at 93¢, with identical contract sizes."* Your normalizer **must synthesize both ask ladders**. Get this wrong and every fill price is silently wrong — this is the single most likely catastrophic bug in the codebase. Property-test it: `best_yes_ask == 100 − best_no_bid` and `best_no_ask == 100 − best_yes_bid`, on every snapshot, with a production alert on violation.
- ⚠️ **Response shape is `orderbook_fp`, not cents integers.** It contains `yes_dollars` and `no_dollars` arrays of `[dollars_string, fixed_point_count_string]` pairs — e.g. `["0.1500", "100.00"]`, where the **first element is a price in dollars as a string** and the **second is a contract quantity, not a price**. Parse both as decimals (use a decimal library or integer math — **never** `parseFloat` into accumulating arithmetic), then convert price to cents by ×100. A misread of element 2 as a price is an easy and very expensive mistake.
- `depth` query param accepts 1–100 (0 or negative = all levels). Request `depth=100` for hot markets; the depth cap in §12.3 depends on seeing the real ladder.
- Kalshi charges a **trading fee** (a `ceil(0.07 · C · P · (1−P))`-shaped formula). **Verify the current published fee schedule before launch and store it in `venues.fee_model`** so you can update it without a deploy.

### 11.4 Ingestion scheduling

```
ingest-markets-hot     */30 sec   → refresh metadata for HOT markets
ingest-markets-full    */5 min    → full Gamma/Kalshi crawl, upsert events+markets
ingest-books-hot       */5 sec    → book snapshots for HOT (WS-fed where possible)
ingest-books-warm      */30 sec   → book snapshots for WARM
retier-markets         */60 sec   → recompute hot/warm/cold
build-candles          */1 min    → roll price_ticks into price_candles
prune-snapshots        daily 03:00 → delete book_snapshots > 7d not referenced by a fill
```

Each ingestion job:
1. Acquires a Postgres advisory lock so two concurrent cron runs never overlap.
2. Writes to a staging table, then upserts in one transaction.
3. Records latency, row counts, and error counts to an `ingest_runs` table.
4. On venue 429: exponential backoff with jitter, and **demote the tier** rather than dropping data silently.
5. On venue 5xx or timeout: keep the last good snapshot, mark `markets.book_updated_at` stale. **The quote endpoint refuses to quote on a stale book** (see §12.6).

---

## 12. The fill engine — the hard part

This is where a paper trading app is either credible or a toy. Take it seriously.

### 12.1 Three realism modes

The user picks in Settings. Default is **Realistic**.

| Mode | Fill price | Fees | Latency | Partial fills | Use case |
|---|---|---|---|---|---|
| **Instant** | Book mid | none | 0 | never | First-run tutorial only |
| **Realistic** ⭐ | Walk the real book | venue fee model | 250ms replay | yes | Default. Leaderboard-eligible. |
| **Brutal** | Walk the book, +1 tick adverse | venue fee ×1.5 | 750ms | yes, aggressive | For people who want the truth |

**Leaderboard eligibility requires Realistic or Brutal.** Instant-mode trades are excluded from ladder points and from calibration records. Say this in the UI when the user switches modes.

### 12.2 Market order: walking the book

```ts
function walkBook(
  levels: [priceCents: number, size: number][],  // best-first
  target: { kind: 'qty'; qty: number } | { kind: 'notional'; usd: number },
  tickSize: number
): { fills: {price:number; qty:number}[]; avgPrice:number; totalQty:number; cost:number } {
  const fills = [];
  let remainingQty = target.kind === 'qty' ? target.qty : Infinity;
  let remainingUsd = target.kind === 'notional' ? target.usd : Infinity;
  let totalQty = 0, cost = 0;

  for (const [priceCents, availableSize] of levels) {
    if (remainingQty <= 0 || remainingUsd <= 0) break;
    const priceUsd = priceCents / 100;

    // How much can we take at this level?
    const byQty = Math.min(remainingQty, availableSize);
    const byUsd = remainingUsd / priceUsd;
    const take = Math.min(byQty, byUsd, availableSize);
    if (take <= 0) break;

    fills.push({ price: priceCents, qty: take });
    totalQty     += take;
    cost         += take * priceUsd;
    remainingQty -= take;
    remainingUsd -= take * priceUsd;
  }

  return {
    fills,
    totalQty,
    cost,
    avgPrice: totalQty > 0 ? (cost / totalQty) * 100 : 0,
  };
}
```

Then:

```
slippage_bps = ((avgPrice - bookMid) / bookMid) * 10000    // signed by direction
fee          = venue.computeFee(totalQty, avgPrice, side)
totalCost    = cost + fee
```

### 12.3 The four rules that make it honest

**Rule 1 — Never fill beyond visible depth.**
If the book only shows 500 shares and the user asks for 2,000, they get 500 and the order is `partial` (or rejected for FOK). Do **not** synthesize liquidity beyond the last level. Beginners blowing through thin books and getting a 12¢ average fill on a 63¢ market is *exactly the lesson*.

**Rule 2 — Cap order size relative to book depth.**
Reject any order whose notional exceeds **5% of total visible book depth on that side**, with the message: *"This order is larger than the market can absorb. In reality you'd move the price against yourself."* This prevents the single most common leaderboard exploit: dumping the whole bankroll into an illiquid market with a 1-share ask at 2¢.

**Rule 3 — Simulate latency with a real replay.**
On Realistic mode, do not fill against the snapshot the user quoted from. Instead:
1. Record `quote_snapshot_id` and `quote_time`.
2. Wait for (or select) the first book snapshot with `captured_at >= quote_time + latency_ms`.
3. Fill against **that** book.
4. If the price moved against the user beyond a 2% tolerance, the order is `rejected` with `reject_reason='price_moved'` and the UI shows *"Price moved — requote?"*

This is exactly what happens on a real venue and it teaches the single most expensive lesson in trading: **your quote is not your fill.**

**Rule 4 — No market impact modelling, and say so.**
You are not simulating how the book would have reacted to the user's order. That's unmodellable without a full LOB simulator. Instead, Rule 2 caps size so impact stays negligible, and the Settings page states plainly: *"Ghostfill does not simulate market impact. Your ghost orders never move the real book. Keep sizes realistic and results stay meaningful."* Honesty about limitations is a feature.

### 12.4 Limit orders and the resting engine

Resting limit orders live in `orders` with `status='open'` and reserve cash in `portfolios.reserved_balance`.

`match-resting` runs every 5s:

```
for each open limit order O on a market with a fresh book:
    book = latest_snapshot(O.market_id)
    if O.side = 'buy':
        crossable = levels of book[O.outcome].asks where price <= O.limit_price
    else:
        crossable = levels of book[O.outcome].bids where price >= O.limit_price

    if crossable is empty: continue

    # Queue-position model: you are BEHIND everyone already resting at your price.
    # You only fill from size that traded THROUGH your level since the last check.
    traded_through = volume_at_or_better(O.market_id, O.limit_price, since=O.last_checked_at)
    fillable = min(O.qty_remaining, traded_through * QUEUE_FACTOR)

    if fillable >= market.min_order_size:
        create_fill(O, fillable, price = O.limit_price)   # maker fills at YOUR price
        release_reserved(O, fillable)
```

`QUEUE_FACTOR` starts at **0.35** — meaning you assume you're roughly two-thirds back in the queue. It's a tunable honesty dial. Without a queue model, limit orders in a paper simulator fill instantly and perfectly every time, which is the second-biggest lie a bad simulator tells.

Expire GTC orders after 30 days. Cancel automatically on market close.

### 12.5 Selling and closing

- **Sell YES** = hit the YES bid ladder (walk bids, not asks).
- Closing a position is a sell of the same outcome, not a buy of the opposite. (Buying the opposite side creates a hedged pair, which is a legitimate but distinct thing — support both, label them differently.)
- Realized P&L on a partial close uses **weighted average cost basis**:
  ```
  realized += qty_sold * (sell_price - avg_entry_price) / 100 - fees
  cost_basis -= qty_sold * avg_entry_price / 100
  ```
- Short selling: **not in v1.** On both venues "shorting YES" is economically "buying NO", and exposing it as a short adds margin, borrow, and liquidation concepts that don't exist on these venues. Buying NO covers it. Revisit only if Drift-style leverage venues get added.

### 12.6 Rejection reasons (be specific — every rejection is a teaching moment)

| Code | Trigger | User-facing copy |
|---|---|---|
| `insufficient_funds` | cost + fee > cash_balance | "Not enough ghost cash. You have G$412; this costs G$500." |
| `market_closed` | status ≠ open, or past close_time | "This market closed 12 minutes ago." |
| `stale_book` | `book_updated_at` older than 30s | "We've lost the live book for this market. Try again shortly." |
| `quote_expired` | quote older than 10s | "Your quote expired. Refreshing…" |
| `price_moved` | fill price >2% worse than quote | "Price moved from 63¢ to 68¢. Requote?" |
| `size_exceeds_depth` | notional > 5% of book depth | "Larger than this market can absorb — in reality you'd move the price against yourself." |
| `below_min_size` | qty < market.min_order_size | "Minimum order on this market is 5 contracts." |
| `invalid_tick` | limit price not on tick grid | "Prices on this market move in 1¢ steps." |
| `rate_limited` | >30 orders/min or >300/hr | "Slow down — you're placing orders faster than a human can think." |
| `position_limit` | >20% bankroll in one market | "This would put more than 20% of your bankroll in one market. Position sizing is the point." |
| `duplicate` | idempotency_key seen before | (silent — returns the original order) |

### 12.7 Order flow, end to end

```
CLIENT                     EDGE FN: quote              EDGE FN: order-submit
  │                              │                              │
  ├─ user types $100 ───────────►│                              │
  │  (debounce 250ms)            ├─ load latest book snapshot   │
  │                              ├─ check freshness (<30s)      │
  │                              ├─ walkBook()                  │
  │                              ├─ computeFee()                │
  │                              ├─ insert quotes row (TTL 10s) │
  │◄─ {quote_id, avg, cost,  ────┤                              │
  │    slippage, max_payout}     │                              │
  │                                                             │
  ├─ user hits PLACE ────────────────────────────────────────► │
  │  {quote_id, idempotency_key}                                │
  │                                            ├─ BEGIN TX      │
  │                                            ├─ lock portfolio FOR UPDATE
  │                                            ├─ validate quote live & unconsumed
  │                                            ├─ validate all §12.6 rules
  │                                            ├─ select post-latency snapshot
  │                                            ├─ re-walk book on THAT snapshot
  │                                            ├─ if moved >2% → reject
  │                                            ├─ insert order (status=filled/partial)
  │                                            ├─ insert fill(s) → snapshot_id
  │                                            ├─ upsert position (freeze p_user,p_market)
  │                                            ├─ insert transactions (debit + fee)
  │                                            ├─ update portfolio.cash_balance
  │                                            ├─ mark quote consumed
  │                                            ├─ COMMIT
  │◄─ {order, fills, position, new_balance} ───┤
  │
  └─ Realtime pushes position/portfolio updates to all the user's open tabs
```

**Everything inside one transaction with `SELECT … FOR UPDATE` on the portfolio row.** Two orders submitted in the same millisecond must not both spend the same cash. Use `SERIALIZABLE` or explicit row locking — not optimistic concurrency.

---

## 13. Settlement

`settle` runs every 60s.

```
1. For each market where status='open' and close_time < now():
     → set status='resolving'

2. For each market in 'resolving':
     resolution = adapter.getResolutions([venue_market_id])
     if not yet resolved on venue: continue        # some take hours/days
     if resolved:
        set markets.resolution, resolved_at, status='resolved'

3. For each open position on a newly resolved market:
     won = (position.outcome == market.resolution)
     payout = won ? position.qty * 1.00 : 0
     realized_pnl += payout - position.cost_basis
     insert transaction(kind='settlement', amount=payout)
     update portfolio.cash_balance += payout
     set position.is_open=false, settled_at=now(), outcome_result=won

4. Cancel every resting order on the market, release reserved cash.

5. Write the calibration record:
     p_user   = position.entry_p_user
     p_market = position.entry_p_market
     outcome  = won ? 1 : 0
     brier_user   = (p_user   - outcome)^2
     brier_market = (p_market - outcome)^2
     edge_bps     = (p_market - p_user) * 10000
     insert calibration_records(...)

6. Recompute the user's aggregate scores; update ladder_entries.

7. Push a notification: "The Fed market resolved YES. You made +$340."
```

**Edge cases you must handle or you will corrupt the ledger:**

| Case | Handling |
|---|---|
| Market cancelled / voided by venue | Refund `cost_basis` at 1:1, mark position `void`, **exclude from calibration records**. A void is not a forecast error. |
| Multi-outcome (non-binary) markets | v1: ingest but flag `is_binary=false` and make them **read-only, not tradeable**. Add in v2 with proper N-outcome handling. |
| Venue changes a resolution after the fact | Store `resolution_revision`; if it changes, run a compensating transaction chain, never a `DELETE`. Notify affected users explicitly. |
| Market resolves while an order is mid-flight | The `SELECT … FOR UPDATE` on the market row in the settle job blocks the order transaction. Order gets `market_closed`. |
| Position still open at season end | Season scoring uses **only positions resolved within the season**. Open positions carry to the lifetime portfolio. |

---

## 14. Scoring implementation

### 14.1 Aggregate calibration (materialized per user, refreshed on settle)

```sql
create or replace function public.compute_calibration(p_user_id uuid, p_since timestamptz default null)
returns table (
  n int, brier_user numeric, brier_market numeric, brier_skill numeric,
  reliability numeric, resolution numeric, uncertainty numeric,
  ci_low numeric, ci_high numeric
) language sql stable as $fn$
  with recs as (
    select * from public.calibration_records
    where user_id = p_user_id
      and (p_since is null or resolved_at >= p_since)
  ),
  agg as (
    select
      count(*)::int                        as n,
      avg(brier_user)                      as bu,
      avg(brier_market)                    as bm,
      avg(outcome::numeric)                as base_rate,
      stddev_samp(brier_user)              as sd
    from recs
  ),
  -- Murphy decomposition over 10 probability bins
  bins as (
    select width_bucket(p_user, 0, 1, 10) as bin,
           count(*)                       as nk,
           avg(p_user)                    as pk,
           avg(outcome::numeric)          as ok
    from recs group by 1
  ),
  murphy as (
    select
      sum(nk * power(pk - ok, 2)) / nullif((select n from agg),0)          as reliability,
      sum(nk * power(ok - (select base_rate from agg), 2))
        / nullif((select n from agg),0)                                     as resolution
    from bins
  )
  select
    a.n,
    round(a.bu, 6),
    round(a.bm, 6),
    case when a.bm > 0 then round(1 - (a.bu / a.bm), 6) end                 as brier_skill,
    round(m.reliability, 6),
    round(m.resolution, 6),
    round(a.base_rate * (1 - a.base_rate), 6)                               as uncertainty,
    -- 95% CI on Brier Skill via normal approx on the difference
    case when a.n >= 30 and a.bm > 0
      then round(1 - (a.bu / a.bm) - 1.96 * (a.sd / sqrt(a.n)) / a.bm, 6) end,
    case when a.n >= 30 and a.bm > 0
      then round(1 - (a.bu / a.bm) + 1.96 * (a.sd / sqrt(a.n)) / a.bm, 6) end
  from agg a cross join murphy m;
$fn$;
```

> For a publishable-grade CI, replace the normal approximation with a **bootstrap** (2,000 resamples) computed in the Edge Function. The SQL version is fine for the in-app display; label it "approximate".

### 14.2 Ladder points

```sql
create or replace function public.compute_ladder_points(p_season_id uuid, p_user_id uuid)
returns numeric language plpgsql stable as $fn$
declare
  v_return numeric; v_norm numeric; v_bss numeric;
  v_disc numeric;   v_act numeric;  v_trades int;
  v_p5 numeric;     v_p95 numeric;
begin
  select (pf.equity - pf.starting_balance) / nullif(pf.starting_balance,0)
    into v_return
  from public.portfolios pf
  where pf.user_id = p_user_id and pf.season_id = p_season_id;

  -- winsorize season returns at the 5th/95th percentile of the eligible cohort
  select percentile_cont(0.05) within group (order by season_return),
         percentile_cont(0.95) within group (order by season_return)
    into v_p5, v_p95
  from public.v_season_returns where season_id = p_season_id;

  v_norm := greatest(v_p5, least(v_p95, coalesce(v_return,0)));
  v_norm := case when v_p95 > v_p5 then (v_norm - v_p5) / (v_p95 - v_p5) else 0.5 end;

  select coalesce(brier_skill, 0) into v_bss
  from public.compute_calibration(
        p_user_id,
        (select starts_at from public.seasons where id = p_season_id));
  v_bss := greatest(0, least(1, (v_bss + 0.25) / 0.5));   -- map [-0.25,+0.25] → [0,1]

  -- discipline: 1 - coefficient of variation of stake size, clamped
  select greatest(0, least(1,
           1 - coalesce(stddev_samp(notional) / nullif(avg(notional),0), 1)))
    into v_disc
  from public.fills f
  join public.portfolios pf on pf.id = f.portfolio_id
  where pf.user_id = p_user_id and pf.season_id = p_season_id;

  select count(*) into v_trades
  from public.orders o
  where o.user_id = p_user_id and o.status in ('filled','partial')
    and o.server_ts >= (select starts_at from public.seasons where id = p_season_id);
  v_act := least(1, v_trades / 15.0);

  return round(1000 * (0.45*v_norm + 0.35*v_bss + 0.10*v_disc + 0.10*v_act), 4);
end;
$fn$;
```

### 14.3 Season rollover (Monday 00:00 UTC)

```
1. Freeze the outgoing season: is_active=false, finalized_at=now().
2. Final ranks computed per pod → per tier → global.
3. Promotion/relegation per §7.2 table. Write final_tier, promoted, relegated.
4. Award badges (division badge, streak badges, "beat the market" badge).
5. Create the new season row, is_active=true.
6. Assign divisions:
     - returning users → their post-promotion/relegation tier
     - new users → unplaced until 10 resolved positions, then placed at Bronze/Silver
       based on their placement Brier
7. Rebalance pods to ~50 members, sorting by prior points so pods are competitive.
8. Create a fresh season portfolio for every active user, cash = 10,000.
   Lifetime portfolio is untouched and keeps running.
9. Queue Weekly Wrapped generation for every eligible user.
```

**Design note:** every user gets a **fresh G$10,000 season portfolio each week** *and* keeps a **persistent lifetime portfolio**. The weekly reset means a bad week never permanently excludes you from competing — the single most important retention mechanic in this whole design. The lifetime book is where long-term calibration accrues.

---

## 15. Authentication — X and Google OAuth in MV3

This is the fiddliest part of the build. Here is the exact working shape.

### 15.1 Configure Supabase

1. Supabase Dashboard → Authentication → Providers → enable **Twitter (X)** and **Google**.
2. **X:** create an app in the X Developer Portal, enable OAuth 2.0 in the app's authentication settings, set the type to **Confidential Client** (Supabase holds the secret). Copy Client ID + Secret into Supabase. Scopes: `users.read tweet.read offline.access`. Note that X access tokens are valid for **2 hours** unless `offline.access` is requested — request it so refresh tokens are issued. Also note X moved new developers to **pay-per-use** pricing in Feb 2026 ($0.01/post, $0.005/read) — login itself is cheap, but **do not build features that read the timeline**, or your auth becomes a metered cost centre.
3. **Google:** create OAuth credentials in Google Cloud Console (Web application type — *not* Chrome App), add Supabase's callback URL.
4. Redirect URL for both: `https://<project-ref>.supabase.co/auth/v1/callback`.
5. Additional allowed redirect in Supabase → URL Configuration:
   `https://<EXTENSION_ID>.chromiumapp.org/` — this is the synthetic origin `chrome.identity` uses.

### 15.2 Pin the extension ID

`chrome.identity.launchWebAuthFlow` builds its redirect from the extension ID. If the ID changes between dev and prod, OAuth silently breaks.

Generate a key pair, put the public key in `manifest.json` as `"key": "<base64>"`, and the extension ID becomes deterministic across dev, CI, and the Web Store. Do this on day one.

### 15.3 The service worker Supabase client

Two MV3 realities: service workers have **no `window`, no `localStorage`**, and they **sleep**. So:

```ts
// src/background/supabase.ts
import { createClient } from '@supabase/supabase-js';

const chromeStorageAdapter = {
  getItem:    async (k: string) => (await chrome.storage.local.get(k))[k] ?? null,
  setItem:    async (k: string, v: string) => { await chrome.storage.local.set({ [k]: v }); },
  removeItem: async (k: string) => { await chrome.storage.local.remove(k); },
};

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,   // publishable/anon key ONLY
  {
    auth: {
      storage: chromeStorageAdapter,
      persistSession: true,       // write through our adapter
      autoRefreshToken: true,     // refresh the JWT before expiry
      detectSessionInUrl: false,  // no window in a service worker
      flowType: 'pkce',           // REQUIRED — see below
    },
  }
);
```

### 15.4 The OAuth flow — PKCE, not implicit

**PKCE is mandatory here.** The implicit flow puts the token in the URL *hash*, and `chrome.identity.launchWebAuthFlow` **strips the hash** before returning. Implicit flow silently returns nothing. This costs people days. Use PKCE.

```ts
export async function signIn(provider: 'twitter' | 'google') {
  const redirectTo = chrome.identity.getRedirectURL(); // https://<id>.chromiumapp.org/

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider,
    options: {
      redirectTo,
      skipBrowserRedirect: true,   // give us the URL, don't navigate
      scopes: provider === 'twitter'
        ? 'users.read tweet.read offline.access'
        : 'openid email profile',
    },
  });
  if (error) throw error;

  const responseUrl = await chrome.identity.launchWebAuthFlow({
    url: data.url,
    interactive: true,
  });
  if (!responseUrl) throw new Error('Auth cancelled');

  // PKCE returns ?code=… in the QUERY string, which survives launchWebAuthFlow
  const code = new URL(responseUrl).searchParams.get('code');
  if (!code) throw new Error('No auth code returned');

  const { data: sess, error: xErr } = await supabase.auth.exchangeCodeForSession(code);
  if (xErr) throw xErr;

  await supabase.functions.invoke('profile-init');  // creates profile + portfolio
  return sess.session;
}
```

`launchWebAuthFlow` must be called from the service worker or an **offscreen document**, never from a content script.

### 15.5 Manifest

```jsonc
{
  "manifest_version": 3,
  "name": "Ghostfill — Paper Trade Prediction Markets",
  "version": "0.1.0",
  "description": "Practice trading Polymarket and Kalshi markets with simulated money. No real money involved.",
  "key": "<BASE64_PUBLIC_KEY_FOR_STABLE_ID>",
  "minimum_chrome_version": "116",

  "permissions": [
    "identity",        // OAuth
    "storage",         // session + prefs
    "sidePanel",       // main UI
    "alarms",          // background refresh
    "notifications",   // settlements, weekly wrapped
    "offscreen"        // long-lived realtime socket
  ],
  "host_permissions": [
    "https://<project-ref>.supabase.co/*"
  ],
  "optional_host_permissions": [
    "https://polymarket.com/*",
    "https://*.polymarket.com/*",
    "https://kalshi.com/*",
    "https://*.kalshi.com/*"
  ],

  "background": { "service_worker": "background.js", "type": "module" },
  "side_panel": { "default_path": "sidepanel.html" },
  "action":     { "default_popup": "popup.html", "default_title": "Ghostfill" },

  "content_scripts": [{
    "matches": ["https://polymarket.com/*", "https://kalshi.com/*"],
    "js": ["content.js"],
    "css": ["content.css"],
    "run_at": "document_idle"
  }],

  "commands": {
    "_execute_action": { "suggested_key": { "default": "Ctrl+Shift+G" } },
    "open-panel":      { "suggested_key": { "default": "Ctrl+Shift+P" },
                         "description": "Open Ghostfill panel" }
  },

  "content_security_policy": {
    "extension_pages": "script-src 'self'; object-src 'self'"
  },
  "web_accessible_resources": [{
    "resources": ["assets/*"],
    "matches": ["https://polymarket.com/*", "https://kalshi.com/*"]
  }]
}
```

**Permission notes for Web Store review:**
- Ship host permissions for Polymarket/Kalshi as **optional**, requested only when the user first enables Ghost Mode. Reviewers reward least-privilege, and the extension is fully functional without them.
- **No `tabs`, no `webRequest`, no `<all_urls>`, no `scripting` with broad matches.** Every one of those triggers deeper review.
- **No remotely-hosted code.** MV3 forbids it and it's an instant rejection. All JS ships in the bundle; only *data* comes from the network.

### 15.6 The offscreen document

MV3 service workers sleep after ~30s idle, killing any WebSocket. Supabase Realtime needs a persistent connection for live prices and position updates. Solution: an **offscreen document** with reason `DOM_PARSER` (or `AUDIO_PLAYBACK` if you need harder persistence — but prefer the honest reason and accept occasional teardown).

```ts
async function ensureOffscreen() {
  const has = await chrome.offscreen.hasDocument?.();
  if (has) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: [chrome.offscreen.Reason.DOM_PARSER],
    justification: 'Maintain a realtime connection for live market prices and position updates.',
  });
}
```

The offscreen doc holds the Realtime subscription and relays ticks to the side panel via `chrome.runtime.sendMessage`. **Fallback:** if offscreen is unavailable, a `chrome.alarms` job polls every 30s. Always ship the fallback — offscreen has real edge cases.

### 15.7 Handle selection at first run

After OAuth, `profile-init` proposes a handle from the provider (`x_username`, or Google email local-part), sanitized to `^[a-z0-9_]{3,20}$`, with a numeric suffix on collision. The user can change it once for free, then once per 30 days.

---

## 16. Extension architecture

### 16.1 Message bus

Content scripts and side panels cannot talk to each other, or reach Supabase directly with the session. Everything routes through the service worker.

```ts
type Msg =
  | { t:'AUTH_SIGN_IN'; provider:'twitter'|'google' }
  | { t:'AUTH_SIGN_OUT' }
  | { t:'AUTH_STATE' }
  | { t:'MARKETS_LIST'; filter: MarketFilter; cursor?: string }
  | { t:'MARKET_GET'; marketId: string }
  | { t:'QUOTE'; marketId: string; outcome:'yes'|'no'; side:'buy'|'sell';
                 notional?: number; qty?: number }
  | { t:'ORDER_SUBMIT'; quoteId: string; idempotencyKey: string }
  | { t:'ORDER_CANCEL'; orderId: string }
  | { t:'POSITION_CLOSE'; positionId: string; fraction: number }
  | { t:'PORTFOLIO_GET' }
  | { t:'LADDER_GET'; seasonId?: string }
  | { t:'RECORD_GET' }
  | { t:'TICK'; marketId: string; mid: number }        // SW → panels (push)
  | { t:'POSITION_UPDATE'; position: Position };       // SW → panels (push)
```

Always wrap `sendMessage` in try/catch: if the content script isn't running on the active tab (URL doesn't match), the call throws.

### 16.2 Bundle budget

MV3 side panels are memory-constrained and the Web Store penalizes bloat.

| Artifact | Budget |
|---|---|
| `background.js` | < 120 KB |
| `sidepanel.js` | < 350 KB |
| `content.js` | < 60 KB — **this one matters most**; it runs on every Polymarket/Kalshi page load |
| `popup.js` | < 40 KB |
| Total ZIP | < 2 MB |

Tactics: preact/compat alias for the content script, code-split the charting library (`lightweight-charts`, ~45 KB) into a lazy chunk loaded only on market detail, no moment/date-fns (use `Intl`), no lodash, tree-shakeable Supabase client imports.

### 16.3 State management

- **TanStack Query** for all server state — caching, background refetch, optimistic updates, and stale-while-revalidate map perfectly onto this app.
- **Zustand** for UI state only (selected tab, filter chips, order ticket draft).
- **No Redux.** No global normalized cache. Server state is server state.
- Persist TanStack's cache to `chrome.storage.local` so the panel opens instantly with last-known data, then revalidates.

### 16.4 Content script (Ghost Mode) safety

Injecting UI into someone else's app is where extensions break sites and earn 1-star reviews. Rules:

1. **Shadow DOM with `mode:'closed'`** for the entire overlay. Host page CSS cannot leak in; your CSS cannot leak out.
2. **Never modify host DOM.** Only append one root node to `document.body`. No mutation of the host's inputs, buttons, or React tree.
3. **Market detection by URL, not DOM scraping.** Parse `/event/<slug>` or `/markets/<ticker>` from `location.pathname`. DOM scraping breaks on every host redeploy; URLs are stable. Resolve slug→`market_id` via your own backend.
4. **`MutationObserver` on `history.pushState`** — both sites are SPAs; URL changes without a page load.
5. **Collision detection** — measure the host's order panel bounding box and dock away from it. Never cover a real control.
6. **Debounce everything.** Re-render at most every 500ms.
7. **Kill switch.** A server-controlled `content_script_enabled` flag fetched at startup, so if a host site redesign breaks the overlay you can disable it remotely **without shipping a new version** (this is config, not remote code — fully MV3-compliant).

---

## 17. Anti-cheat and integrity

A leaderboard with a fake-money economy is a magnet for exploitation. The good news: because the server owns everything, the attack surface is small.

### 17.1 Defence layers

| Layer | Control |
|---|---|
| **Pricing** | Client never supplies a price. All fills derive from a stored `book_snapshot_id`. |
| **Time** | All timestamps are `now()` on the DB. `client_ts` is recorded for forensics and never used in logic. |
| **Idempotency** | Every order requires a client-generated `idempotency_key`, unique per user. Replays return the original order. |
| **Quote binding** | Orders must reference an unconsumed quote < 10s old. Quotes are single-use. |
| **Rate limits** | 30 orders/min, 300/hr, 120 quotes/min per user, enforced in the Edge Function against a Postgres counter. |
| **Depth cap** | No order > 5% of visible book depth (§12.3 Rule 2). |
| **Position cap** | No single market > 20% of bankroll; no single category > 50%. |
| **Staleness** | No quote or fill on a book older than 30s. |
| **Realism gate** | Instant mode is excluded from ladder and calibration entirely. |

### 17.2 Detections (run nightly, write to `integrity_events`)

**Multi-accounting.** The classic attack: 50 accounts, each takes a different side, one wins the week.
- Signals: same X/Google account created within minutes of each other; identical trade timing patterns; near-perfectly anti-correlated position sets across accounts; same install ID.
- Compute pairwise position correlation across accounts active in the same pod. A correlation below −0.85 across ≥15 shared markets is a strong signal.
- Mitigation: **X account age ≥ 30 days** or **verified Google email** required for ladder eligibility. This alone kills most of it.

**Wash trading.** Open and close instantly to farm `activity_score`.
- Detect: fills where a position is closed within 60s at a price within 1 tick of entry, at >10% of the user's trades.
- Mitigation: `activity_score` saturates at 15 trades and counts **distinct markets**, not trades. Also apply full fees to both legs — in Realistic mode wash trading is strictly negative EV, which is the elegant fix.

**Thin-market farming.** Find a market with a 1-share ask at 3¢, buy it, watch it resolve YES at 100¢, post a 3,000% return.
- Mitigation: depth cap (§12.3), plus `normalized_return` is **winsorized at the 5th/95th percentile** so a single outlier cannot win a week, plus ladder points weight calibration at 35% which a single trade cannot move.

**Resolution front-running.** Trade a market after the real-world outcome is publicly known but before the venue marks it resolved.
- This is the nastiest one and it's real. A game ends at 22:14; Kalshi settles at 22:31. In those 17 minutes the price is 99¢ and it's free money.
- Mitigations, in order of effectiveness:
  1. **Freeze trading when the book goes one-sided and extreme:** if best bid ≥ 97¢ or best ask ≤ 3¢ *and* spread < 2¢, reject new orders with `market_effectively_resolved`. This catches nearly all of it and is cheap.
  2. Exclude any position opened within the last 5% of a market's lifetime from calibration records (the forecast wasn't a forecast).
  3. Cap ladder points contribution from positions entered above 95¢ or below 5¢.

**Impossible latency.** Orders placed with sub-human reaction time relative to a price move.
- Detect: order `server_ts` within 200ms of a >3¢ book move on that market, repeated.
- This is not necessarily cheating (could be a script), but scripted trading against a human leaderboard isn't the game. Flag and, at severity ≥3, mark ineligible with a clear appeal path.

### 17.3 Enforcement ladder

1. **Flag** — logged only, invisible to user.
2. **Warn** — in-app notice describing the specific behaviour.
3. **Season ineligibility** — removed from this season's ladder, keeps their book and calibration record.
4. **Shadow ban** — invisible on all public surfaces; account otherwise works.
5. **Ban** — auth identity blocked.

Always show the reason and always offer an appeal. False positives will happen; a mystery ban on a *fake money* game is how you get a viral complaint thread.

---

## 18. Repository structure

Monorepo, pnpm workspaces + Turborepo.

```
ghostfill/
├── apps/
│   ├── extension/                 # Chrome MV3 (Vite + CRXJS + React + TS)
│   │   ├── src/
│   │   │   ├── background/        # service worker: supabase client, msg router, alarms
│   │   │   ├── offscreen/         # realtime socket host
│   │   │   ├── sidepanel/
│   │   │   │   ├── routes/        # Markets, Book, Ladder, Record, Settings
│   │   │   │   ├── components/
│   │   │   │   └── App.tsx
│   │   │   ├── popup/
│   │   │   ├── content/           # Ghost Mode overlay (shadow DOM)
│   │   │   ├── lib/               # msg bus, query client, formatters
│   │   │   └── manifest.config.ts
│   │   ├── public/
│   │   └── vite.config.ts
│   │
│   └── web/                       # ghostfill.app (Next.js) — marketing + /u/:handle
│
├── packages/
│   ├── ui/                        # design system: tokens, Button, Chip, OrderTicket…
│   ├── core/                      # PURE, TESTED, SHARED — no I/O
│   │   ├── book.ts                # walkBook, depth, spread, mid
│   │   ├── fees.ts                # per-venue fee models
│   │   ├── pnl.ts                 # cost basis, realized/unrealized
│   │   ├── scoring.ts             # brier, BSS, murphy decomposition, ladder points
│   │   └── format.ts              # cents, dollars, percentages, tabular
│   ├── venues/                    # VenueAdapter + polymarket/ + kalshi/
│   ├── types/                     # generated Supabase types + shared DTOs
│   └── config/                    # eslint, tsconfig, tailwind presets
│
├── supabase/
│   ├── migrations/                # timestamped SQL, forward-only
│   ├── functions/
│   │   ├── _shared/               # cors, auth guard, rate limit, logger
│   │   ├── quote/
│   │   ├── order-submit/
│   │   ├── order-cancel/
│   │   ├── position-close/
│   │   ├── profile-init/
│   │   ├── ingest-markets/
│   │   ├── ingest-books/
│   │   ├── match-resting/
│   │   ├── mark-to-market/
│   │   ├── settle/
│   │   ├── leaderboard-refresh/
│   │   ├── season-rollover/
│   │   ├── share-card/            # Satori + resvg → PNG
│   │   ├── integrity-scan/
│   │   └── readiness/
│   ├── seed.sql
│   └── config.toml
│
├── docs/
│   ├── ARCHITECTURE.md
│   ├── FILL_ENGINE.md             # the honesty contract — how sim differs from reality
│   ├── SCORING.md                 # the math, publicly documented
│   ├── COMPLIANCE.md              # Web Store policy mapping
│   └── RUNBOOK.md                 # on-call: venue outage, bad settlement, rollback
│
├── .github/workflows/
│   ├── ci.yml                     # typecheck, lint, unit, build
│   ├── e2e.yml                    # Playwright w/ extension loaded
│   ├── deploy-supabase.yml
│   └── release-extension.yml      # zip + Chrome Web Store API upload
│
├── turbo.json
├── pnpm-workspace.yaml
└── README.md
```

### 18.1 Git conventions

- Trunk-based. `main` is always releasable.
- Conventional Commits (`feat:`, `fix:`, `chore:`) → Changesets → automated version bump + changelog.
- Branch names: `feat/fill-engine-queue-model`, `fix/kalshi-ask-synthesis`.
- **Migrations are forward-only.** Never edit a committed migration. A "rollback" is a new migration.
- `packages/core` requires **90% test coverage** to merge. It is the only thing in the repo where a bug silently corrupts every user's history.

### 18.2 First commits (day one order)

```
1. chore: init monorepo, turbo, tsconfig, eslint, prettier
2. feat(core): book walking + fee models + property tests
3. feat(venues): normalized adapter interface + types
4. feat(venues): polymarket adapter (gamma + clob read)
5. feat(venues): kalshi adapter (rest read, synthesize ask ladders)
6. feat(db): initial schema migration
7. feat(db): RLS policies + security advisor clean
8. feat(fn): quote + order-submit edge functions
9. feat(fn): ingest-markets + ingest-books + cron
10. feat(ext): MV3 scaffold, manifest, stable key, side panel shell
11. feat(ext): supabase client with chrome.storage adapter
12. feat(auth): X + Google OAuth via launchWebAuthFlow + PKCE
13. feat(ui): design tokens + market card + order ticket
14. feat(ext): markets list + market detail + place ghost order
15. feat(fn): settle + calibration records
16. feat(fn): seasons + ladder + rollover
17. feat(ext): Ladder + Record screens
18. feat(ext): Ghost Mode content script
19. feat(fn): share-card generation
20. chore: Web Store listing, privacy policy, compliance copy
```

---

## 19. Environments, CI/CD, secrets

### 19.1 Environments

| Env | Supabase | Extension | Data |
|---|---|---|---|
| **local** | `supabase start` (Docker) | `pnpm dev`, load unpacked | Seeded fixtures, no live venue calls |
| **dev** | dev project | unpacked, stable key | Live venue data, 60s poll intervals |
| **staging** | staging project | unlisted Web Store item | Live data, full poll rates, synthetic users |
| **prod** | prod project | public Web Store listing | Live |

Supabase **branching** for PR previews: each PR gets an ephemeral database branch, migrations applied, e2e run against it, torn down on merge.

### 19.2 Secrets

| Secret | Lives in | Never in |
|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase Edge Function env + GitHub Actions secret | **the extension bundle, ever** |
| `KALSHI_API_KEY_ID` / `KALSHI_PRIVATE_KEY` | Supabase Vault | repo, bundle |
| X OAuth client secret | Supabase Auth config | repo, bundle |
| Google OAuth client secret | Supabase Auth config | repo, bundle |
| Chrome Web Store `CLIENT_ID`/`SECRET`/`REFRESH_TOKEN` | GitHub Actions secrets | repo |
| `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` | extension bundle (public by design) | — |

Add a CI step that greps the built extension ZIP for `service_role`, `sk_`, `-----BEGIN`, and known secret prefixes. **Fail the build on any hit.** This check will save you eventually.

### 19.3 Pipelines

```yaml
# ci.yml — on every PR
- pnpm install --frozen-lockfile
- pnpm turbo typecheck lint test build
- pnpm --filter core test -- --coverage   # gate: 90%
- secret-scan built artifacts
- upload extension zip as artifact

# e2e.yml — on PR to main
- supabase branch create + migrate + seed
- playwright test (chromium with --load-extension)
  · sign in (mocked OAuth)
  · place market order → assert fill price matches core.walkBook on the seeded book
  · place limit order → assert resting, then assert fill after seeded trade-through
  · settle a market → assert payout, ledger balance, calibration record
  · assert ladder recompute
- supabase branch delete

# deploy-supabase.yml — on merge to main
- supabase db push (migrations)
- supabase functions deploy --all
- run security advisor; fail on new findings

# release-extension.yml — on tag v*
- build prod bundle
- zip
- upload to Chrome Web Store via API (publish to trusted testers first)
- create GitHub release with changelog
```

### 19.4 Observability

- **Structured JSON logs** from every Edge Function: `{ fn, user_id, market_id, duration_ms, outcome, error }`.
- **`ingest_runs` table** — one row per cron execution with counts and latency. Alert if any job hasn't succeeded in 5× its interval.
- **Sentry** in the extension (scrub all user data; never log positions or handles).
- **Dashboards:** order latency p50/p95/p99, quote→fill conversion, rejection reasons histogram, venue API error rate, settlement lag (close_time → settled_at), DAU/WAU, ladder participation.
- **Alerts that page you:** settlement lag > 6h, any venue adapter erroring > 5 min, order-submit p95 > 2s, ledger integrity check failure.
- **Nightly ledger integrity job:** for every portfolio, assert `sum(transactions.amount) + starting_balance == cash_balance`. Any drift is a P0. Paper money still has to add up, or the leaderboard is meaningless.

---

## 20. Compliance checklist

### 20.1 Chrome Web Store

- [ ] Listing name includes "Paper Trade" or "Simulated": **"Ghostfill — Paper Trade Prediction Markets"**
- [ ] First line of the description: *"Ghostfill is a simulator. No real money is involved. You cannot win, deposit, or withdraw anything of value."*
- [ ] Persistent, non-dismissible **SIMULATED · NO REAL MONEY** badge on every price/position/order surface
- [ ] First-run modal requiring explicit acknowledgement, stored with a timestamp
- [ ] **Zero** prizes of cash or value. Cosmetic rewards only. No sponsorships that offer prizes.
- [ ] **Zero** deep links that prefill a real order. Links to a venue market page are plain, parameterless, `rel="noopener"`, and labelled "View on Polymarket" (viewing is not facilitating)
- [ ] **Zero** affiliate or referral codes to any real-money venue. This would arguably convert you into a facilitator.
- [ ] Single purpose declared: "Simulated trading practice for prediction markets"
- [ ] Every permission justified in the listing's permission rationale field
- [ ] No remotely-hosted code; no `eval`; CSP as specified
- [ ] Privacy policy published at `ghostfill.app/privacy` and linked in the listing
- [ ] Data-use disclosures completed and accurate
- [ ] Trader status registered if/when required (Web Store trader requirements)

### 20.2 Legal posture

- Terms of Service must state plainly: not a broker, not an exchange, not investment advice, no real money, no prizes, simulated results do not predict real results.
- The **Readiness Check** feature must carry: *"This is a simulation. Real trading involves real loss, real fees, real slippage, and real emotion. Nothing here is a recommendation to trade."*
- Age gate: 18+ self-attestation on first run. Not legally required for a simulator, but it's the right call given the subject matter and it strengthens your Web Store position.
- **Do not name your currency anything that sounds redeemable.** "G$" / "ghost dollars" is fine. "Credits", "coins", "tokens", "points you can redeem" is not.
- Respect each venue's Terms of Service regarding data use. Attribute data to Polymarket and Kalshi in the UI and in the listing. Do not present their data as your own. If either venue objects, you need a fallback — which is another argument for the adapter abstraction.

### 20.3 Privacy

- Collect the minimum: provider ID, display name, avatar URL, email (Google) or username (X).
- **Never** request X scopes beyond `users.read tweet.read offline.access`. Never post on the user's behalf without an explicit per-post action.
- Public track record is **opt-in** (`profiles.is_public`), togglable at any time.
- Full data export (JSON) and hard account deletion, both self-serve. GDPR/CCPA baseline.
- No third-party analytics with device fingerprinting or ad SDKs. Use a privacy-respecting product analytics tool and disclose it.

---

## 21. Metrics

### 21.1 The one metric that matters

**Weekly Active Traders who place ≥3 ghost orders across ≥2 markets.**

Not installs, not signups. Installs are vanity; a paper trading app with an inactive user is a rounding error. This metric captures the actual behaviour the product exists to create.

### 21.2 Funnel

| Step | Target |
|---|---|
| Install → OAuth complete | 60% |
| OAuth → first ghost order (same session) | 45% |
| First order → 3 orders in week 1 | 55% |
| Week 1 → Week 2 retention | 35% |
| Week 4 retention | 20% |
| Ladder participation (of WAU) | 50% |
| Weekly Wrapped share rate | 12% |
| ≥30 resolved positions (calibration unlocked) | 15% of signups by day 60 |

### 21.3 Health metrics

- Median time from install to first ghost order — **target under 90 seconds**. This is the number to obsess over.
- Quote → order conversion (if low, your ticket is confusing or your slippage disclosure is scaring people)
- Rejection reason distribution (a spike in `stale_book` = ingestion problem; a spike in `size_exceeds_depth` = your cap is too tight or your copy is unclear)
- Settlement lag distribution
- Median resolved positions per user (the calibration flywheel)
- Share card → install conversion (the growth loop's actual efficiency)

---

## 22. Go-to-market

### 22.1 The positioning

> **"Learn to trade prediction markets before it costs you anything."**

Every message ladders to this. You are not a game. You are a **flight simulator**. Pilots train in simulators not because flying is fun but because crashing is expensive.

Secondary line, for the people who think they're already good:
> **"You think you're good at this. Prove it for free."**

### 22.2 Launch sequence

**Phase 0 — Pre-launch (weeks −4 to 0)**
- Build in public on X. Post the fill engine, the calibration curve, the ladder design. The prediction market crowd is on X and it is genuinely interested in market microstructure. Every technical thread is an ad.
- Recruit 50 alpha testers from Manifold, Metaculus forums, and r/PredictionMarkets. These people will find your Kalshi ask-synthesis bug before your users do.
- Publish `docs/SCORING.md` publicly at `ghostfill.app/scoring`. Transparent math is the trust play and forecasting people will read every line.

**Phase 1 — Launch (week 0)**
- Product Hunt, aimed at "Best Finance Product of the Week."
- Hacker News: *"Show HN: I built a paper trading simulator for prediction markets with real order books"*. Lead with the fill engine and the Brier scoring — HN respects the technical honesty, not the gamification.
- Reddit: r/PredictionMarkets, r/Kalshi, r/Polymarket, r/algotrading, r/forecasting. **Post value, not links** — e.g. "I analyzed 10,000 simulated trades; here's the most common way beginners lose money on prediction markets."
- X: the launch thread is the Calibration Score explanation, not the feature list.

**Phase 2 — The share loop (weeks 1–8)**
- Weekly Wrapped is the engine. Every Monday, a cohort of users posts a card with a number no one else can produce. Optimize this ruthlessly: card design, share copy, landing page conversion.
- Seed the Ladder with visible personalities. Invite 20 known forecasters to a Season 1 exhibition. A leaderboard with recognizable names at the top is worth more than any ad.

**Phase 3 — Content and SEO (ongoing)**
- `ghostfill.app/u/:handle` public track records are SEO gold — they are unique, dynamic pages tied to searchable names.
- Publish aggregate research from your own data: *"Do retail prediction market traders beat the market? We measured 50,000 simulated positions."* This is a genuinely novel dataset and it is press-worthy — no one else has retail forecast data paired with market prices at fill time.
- SEO targets: "polymarket demo account", "kalshi paper trading", "prediction market simulator", "how to practice prediction markets", "am I good at forecasting".

**Phase 4 — Institutions (month 3+)**
- Ghostfill for Classrooms. Econ departments, forecasting clubs, high school econ. Free forever for education.
- This is where the credibility compounds and where you get a citation in a paper, which is the best backlink there is.

### 22.3 The channel nobody else can use

Every real-money prediction market extension is being delisted from the Chrome Web Store as of 1 August 2026. Those listings had users. Those users are searching the Web Store right now for a replacement that still exists.

**Optimize the Web Store listing aggressively for the queries those users are typing**: "polymarket", "kalshi", "prediction market", "prediction market tracker", "polymarket portfolio". You will be one of very few compliant results in a category Google just cleared of competitors. This is the single highest-leverage distribution asset in the whole plan, and it has a shelf life — move now.

### 22.4 Anti-goals

- Do **not** market as a game. "Gamified betting simulator" invites exactly the scrutiny you need to avoid.
- Do **not** run prize competitions. Not once, not "just for launch."
- Do **not** take affiliate deals from real-money venues. It compromises the positioning and arguably the compliance posture.
- Do **not** claim Ghostfill makes anyone profitable. Claim it tells them the truth. That's a stronger claim and a defensible one.

---

## 23. Roadmap

### Phase 1 — Foundation (weeks 1–3)
Monorepo, `packages/core` with tested book-walking and fee models, both venue adapters, full schema + RLS, ingestion cron, `quote` + `order-submit`. **Milestone: a curl request produces a correct, auditable ghost fill.**

### Phase 2 — The extension (weeks 4–6)
MV3 scaffold with stable key, Supabase client with storage adapter, X + Google OAuth, side panel with Markets + Market Detail + Order Ticket + Book. **Milestone: install → sign in → place a ghost order in under 90 seconds.**

### Phase 3 — The loop closes (weeks 7–9)
Settlement, calibration records, Record screen with the calibration curve, seasons, divisions, the Ladder, rollover. **Milestone: a full week runs end to end without manual intervention.**

### Phase 4 — Growth (weeks 10–12)
Weekly Wrapped card generation, X share flow, public profiles on `ghostfill.app`, Ghost Mode content script, notifications. **Milestone: first organic install attributed to a shared card.**

### Phase 5 — Launch (weeks 13–14)
Web Store submission, compliance pass, privacy policy, Product Hunt, HN, Reddit. Buffer two weeks for Web Store review — **assume it will be rejected once** and budget the round trip.

### Phase 6 — Depth (months 4–6)
Regret Replay · Head-to-Head Duels · Shadow Book · Private Leagues + Classrooms · Readiness Check · limit-order improvements · mobile web companion · more venues (Manifold, Limitless, Myriad) via the adapter interface.

### Explicitly out of scope for v1
Multi-outcome markets (read-only) · short selling · leverage · options-like structures · real-money anything · a mobile app · public API.

---

## 24. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **Chrome Web Store rejects the extension** | Medium | Critical | Over-comply from day one. Non-dismissible disclosures, zero prizes, zero real-money links, minimal permissions. Submit early to trusted testers to surface review issues before launch. |
| **Venue blocks or rate-limits you** | Medium | High | Respect published limits, use WebSockets over polling, set a descriptive User-Agent with a contact address, cache aggressively. Reach out to both venues proactively — you drive interest to them and take zero volume; you are a good-faith consumer of public data. |
| **Kalshi orderbook parsing bug** | High | Critical | Two traps in one endpoint: (a) only bid ladders are returned, asks must be synthesized; (b) levels are `[dollar_string, contract_count_string]`, so element 2 is a *quantity*, not a price. Property-test both invariants on every snapshot and alert on violation. Most likely silent catastrophic bug in the codebase. |
| **Venue API changes shape** | High | Medium | Adapters isolate it. Contract tests against recorded fixtures run nightly against live APIs; alert on schema drift. |
| **Leaderboard exploited on day one** | High | High | Ship §17 in full before the first public season, not after. A single viral "I cheated Ghostfill" thread costs more than the feature saved. |
| **Nobody shares the Wrapped card** | Medium | High | This is the growth loop. Prototype and test the card with 20 alpha users before building the rest of the season machinery. If it doesn't get shared, the design is wrong and you need to know in week 2, not week 12. |
| **Users churn after one week** | High | High | Weekly reset + divisions + streaks are the answer. Instrument W1/W2 retention from day one and treat < 30% as a product emergency. |
| **Simulated results mislead someone into real losses** | Medium | High (ethical) | The Readiness Check must be brutally honest, including telling users their record says they should not trade. This is a moral obligation and, conveniently, the most differentiated thing you can say. |
| **Supabase Edge Function cold starts hurt order latency** | Medium | Medium | Keep the order path lean; consider a small always-warm container for `quote`/`order-submit` if p95 exceeds 800ms. |
| **Solo-founder burnout across 6 subsystems** | High | High | Phase gates. Do not build Ghost Mode before settlement works. Do not build duels before retention is measured. The ordering in §23 is the plan. |

---

## 25. Open decisions

Answer these before Phase 1 ends:

1. **Starting bankroll: G$10,000 or G$1,000?** $10k mirrors thinkorswim/Webull convention and makes percentages readable. $1k forces sharper position sizing. *Recommendation: G$10,000, with a "Hard Mode" G$500 option.*
2. **Can users reset their bankroll mid-season?** *Recommendation: yes for the lifetime book (max once per 30 days, logged and shown on the profile), never for the season book.*
3. **Ladder points weighting.** 45/35/10/10 is a starting guess. Instrument it and retune after Season 3 with real data.
4. **Is the Shadow Book a v1 feature?** It sharpens the "learning" story but adds a follow graph and a moderation surface. *Recommendation: defer to Phase 6.*
5. **Do you show other users' ghost fills on a market ("47 people ghosted this today")?** Strong social proof, but it creates a herding signal that degrades calibration. *Recommendation: show counts, never directions.*
6. **Kalshi fee schedule** — verify the current published formula and rates before launch. Store in `venues.fee_model` so it's a config change, not a deploy.
6b. **Kalshi API access tier.** Since market data requires a signed API key, confirm which tier you qualify for and what its read budget is *before* designing the ingestion schedule. If the basic tier's ~20 reads/s is too tight for your hot-market count, either request a higher tier or lean harder on the WebSocket. This is a Phase 1 blocker, not a nice-to-have.
7. **Do you support Polymarket's non-binary / multi-outcome markets in v1?** *Recommendation: ingest, display, do not allow trading. Label clearly.*
8. **Mobile.** The extension is desktop-only by definition. A mobile web app at `ghostfill.app` sharing the same backend is Phase 6, but the API should be designed for it now.

---

## 26. Appendix — API cheat sheet

### Polymarket
```
Discovery   GET https://gamma-api.polymarket.com/events?limit=100&offset=0&closed=false
            GET https://gamma-api.polymarket.com/markets?limit=100&offset=0
Book        GET https://clob.polymarket.com/book?token_id=<TOKEN_ID>
Batch book  POST https://clob.polymarket.com/books        body: [{token_id},…]
Price       GET https://clob.polymarket.com/price?token_id=<ID>&side=buy|sell
Midpoint    GET https://clob.polymarket.com/midpoint?token_id=<ID>
Spread      GET https://clob.polymarket.com/spread?token_id=<ID>
History     GET https://clob.polymarket.com/prices-history?market=<TOKEN_ID>&interval=1h&fidelity=…
Data        GET https://data-api.polymarket.com/...
WebSocket   Polymarket public WSS, `market` channel — no auth
Auth        NONE for all reads. EIP-712 L2 headers only for placing real orders (never used).
Limits      Cloudflare, global across accounts. ~15k/10s total; ~4k/10s Gamma; ~9k/10s CLOB;
            ~1k/10s Data. Practical polling ceiling ≈60 req/min Gamma, ≈100 req/min CLOB read.
            USE THE WEBSOCKET.
```

### Kalshi  (verified against OpenAPI spec v3.27.0)
```
Prod        https://external-api.kalshi.com/trade-api/v2
            https://api.elections.kalshi.com/trade-api/v2
DEMO        https://external-api.demo.kalshi.co/trade-api/v2   ← use for dev/staging
            https://demo-api.kalshi.co/trade-api/v2

Markets     GET /markets?limit=1000&status=open&cursor=<CURSOR>
Market      GET /markets/{ticker}
Orderbook   GET /markets/{ticker}/orderbook?depth=100
Trades      GET /markets/trades
Events      GET /events    Series GET /series
Limits      GET /account/api-limits                ← poll at boot to learn your tier
WebSocket   WSS  channels: ticker, trade, market_lifecycle_v2, multivariate*

AUTH        REQUIRED ON EVERYTHING, INCLUDING MARKET DATA. Three headers:
              KALSHI-ACCESS-KEY        your API key ID
              KALSHI-ACCESS-TIMESTAMP  ms epoch
              KALSHI-ACCESS-SIGNATURE  RSA-PSS( timestamp_ms + METHOD + path )
            Private key lives in Supabase Vault. Server-side only, never in the bundle.

⚠ ORDERBOOK SHAPE — this is where the money bugs live:
    { "orderbook_fp": { "yes_dollars": [...], "no_dollars": [...] } }
    each level = ["0.1500", "100.00"]
                  ^price in DOLLARS   ^CONTRACT QUANTITY (not a price)
    BID LADDERS ONLY. No asks are returned.
      yes_ask(p) == 100 − no_bid(100−p)      no_ask(p) == 100 − yes_bid(100−p)
    Kalshi's own example: a YES bid at 7¢ IS a NO ask at 93¢, same size.
    Parse with decimals/integer math, never accumulating parseFloat.

Limits      Tiered, token-cost per endpoint. Basic ≈20 reads/s, 10 writes/s. Max ~200 WS conns.
Fees        ceil(0.07 · C · P · (1−P))-shaped. VERIFY CURRENT SCHEDULE BEFORE LAUNCH.
```

### Normalization contract
```
price   → cents, numeric(6,2), range (0,100), exclusive of both bounds
size    → shares/contracts, numeric(20,4)
outcome → 'yes' | 'no', both first-class (never store only YES and derive NO)
time    → timestamptz UTC, always server-generated
INVARIANT (assert on every snapshot):  best_yes_ask == 100 − best_no_bid
INVARIANT:                             best_no_ask  == 100 − best_yes_bid
```

---

## Sources

- [Chrome Web Store — Regulated goods and services](https://developer.chrome.com/docs/webstore/program-policies/regulated-goods-and-services)
- [Chrome Web Store — Program Policies](https://developer.chrome.com/docs/webstore/program-policies/policies)
- [Google Chrome to Ban Extensions Enabling Real-Money Prediction Market Trading Starting August](https://finance.biggo.com/news/7adc8606-89e6-47c2-ad10-ad8dfdbdf3cf)
- [Polymarket Documentation — API Overview](https://docs.polymarket.com/api-reference/introduction)
- [Polymarket API Guide 2026 — CLOB, Gamma & Data API (pm.wiki)](https://pm.wiki/learn/polymarket-api)
- [Polymarket API for Developers (Chainstack)](https://chainstack.com/polymarket-api-for-developers/)
- [Kalshi — Get Market Orderbook (OpenAPI spec, verified)](https://docs.kalshi.com/api-reference/market/get-market-orderbook) · [Get Markets](https://docs.kalshi.com/api-reference/market/get-markets) · [Quick Start: Market Data](https://docs.kalshi.com/getting_started/quick_start_market_data)
- [Kalshi API Tutorial: Auth, WebSockets, Rate Limits & Orders](https://www.botforkalshi.com/blog/kalshi-api-tutorial)
- [Highest Volume Prediction Markets in 2026 (QuantVPS)](https://www.quantvps.com/blog/prediction-markets-volume-compared)
- [Prediction Market Volume: Kalshi & Polymarket Aggregated Data (DeFi Rate)](https://defirate.com/prediction-markets/volume/)
- [Trading volume on prediction markets has soared (Pew Research, May 2026)](https://www.pewresearch.org/short-reads/2026/05/27/trading-volume-on-prediction-markets-has-soared-in-recent-months/)
- [How Prediction Market Order Books Work on Kalshi and Polymarket](https://defirate.com/prediction-markets/how-order-books-work/)
- [Best UX/UI Patterns for Prediction Markets in 2026 (Avark)](https://avark.agency/learn/prediction-market-design-patterns)
- [Kalshi vs Polymarket (VegasInsider)](https://www.vegasinsider.com/prediction-markets/kalshi-vs-polymarket/)
- [Top 10 Prediction Market Platforms in 2026 (Coinmonks)](https://medium.com/coinmonks/top-10-prediction-market-platforms-in-2026-cc99478052dd)
- [DemoMarket — Chrome Web Store](https://chromewebstore.google.com/detail/demomarket/khhjjkbmckhdabkaepljmhbegbmphael)
- [Supabase Auth in a Chrome Extension: What You Won't Find in the Docs](https://chethiyakd.medium.com/supabase-auth-in-a-chrome-extension-what-you-wont-find-in-the-docs-a2ae6691cca3)
- [Supabase publishable keys: Chrome extension auth fix](https://anishgandhi.com/supabase-publishable-keys-chrome-extension-auth-fix/)
- [X — OAuth 2.0 Authorization Code Flow with PKCE](https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code)
- [How Chrome Extensions Actually Work in 2026 (Manifest V3)](https://www.orlandoascanio.com/notes/chrome-extension-manifest-v3-2026)
- [How to Build a Chrome Extension Side Panel in 2026](https://www.extensionfast.com/blog/how-to-build-a-chrome-extension-side-panel-in-2026)
