// GENERATED FILE — DO NOT EDIT.
// Built from packages/core + packages/venues by scripts/build-edge-shared.mjs.
// Regenerate with: npm run build:edge
// packages/core/src/types.ts
var REALISM = {
  instant: {
    latencyMs: 0,
    feeMultiplier: 0,
    adverseTicks: 0,
    allowPartial: false,
    usesMid: true,
    scoringEligible: false
  },
  realistic: {
    latencyMs: 250,
    feeMultiplier: 1,
    adverseTicks: 0,
    allowPartial: true,
    usesMid: false,
    scoringEligible: true
  },
  brutal: {
    latencyMs: 750,
    feeMultiplier: 1.5,
    adverseTicks: 1,
    allowPartial: true,
    usesMid: false,
    scoringEligible: true
  }
};
var DEFAULT_MARKET_RULES = {
  tickCents: 1,
  minOrderSize: 1,
  maxDepthFraction: 0.05
};

// packages/core/src/decimal.ts
var PRICE_DP = 4;
var QTY_DP = 2;
var MONEY_DP = 6;
function shiftExponent(value, exp) {
  if (value === 0 || !Number.isFinite(value)) return value;
  const [mantissa, existing] = `${value}`.split("e");
  const nextExp = (existing ? Number(existing) : 0) + exp;
  return Number(`${mantissa}e${nextExp}`);
}
function roundTo(value, dp) {
  if (!Number.isFinite(value)) return 0;
  const scaled = shiftExponent(value, dp);
  if (!Number.isFinite(scaled)) return 0;
  const rounded = Math.sign(scaled) * Math.round(Math.abs(scaled));
  const out = shiftExponent(rounded, -dp);
  return !Number.isFinite(out) || out === 0 ? 0 : out;
}
var roundPrice = (v) => roundTo(v, PRICE_DP);
var roundQty = (v) => roundTo(v, QTY_DP);
var roundMoney = (v) => roundTo(v, MONEY_DP);
function floorTo(value, dp) {
  if (!Number.isFinite(value)) return 0;
  const scaled = shiftExponent(value, dp);
  if (!Number.isFinite(scaled)) return 0;
  const truncated = Math.sign(scaled) * Math.floor(Math.abs(scaled));
  const out = shiftExponent(truncated, -dp);
  return !Number.isFinite(out) || out === 0 ? 0 : out;
}
var floorQty = (v) => floorTo(v, QTY_DP);
function ceilCents(dollars) {
  return roundMoney(Math.ceil(roundTo(dollars * 100, 6)) / 100);
}
function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}
function snapToTick(priceCents, tickCents, mode = "nearest") {
  if (!(tickCents > 0)) return roundPrice(priceCents);
  const scale = 10 ** PRICE_DP;
  const p = Math.round(priceCents * scale);
  const t = Math.round(tickCents * scale);
  if (t <= 0) return roundPrice(priceCents);
  const q = p / t;
  const snapped = mode === "down" ? Math.floor(q) : mode === "up" ? Math.ceil(q) : Math.round(q);
  return roundPrice(snapped * t / scale);
}
function isOnTick(priceCents, tickCents) {
  if (!(tickCents > 0)) return true;
  const scale = 10 ** PRICE_DP;
  const p = Math.round(priceCents * scale);
  const t = Math.round(tickCents * scale);
  return t > 0 && p % t === 0;
}

// packages/core/src/book.ts
function walkBook(levels, target, tickCents = 1) {
  const fills = [];
  let remainingQty = target.kind === "qty" ? target.qty : Number.POSITIVE_INFINITY;
  let remainingUsd = target.kind === "notional" ? target.usd : Number.POSITIVE_INFINITY;
  let totalQty = 0;
  let cost = 0;
  if (!(remainingQty > 0) || !(remainingUsd > 0)) {
    return { fills, avgPrice: 0, totalQty: 0, cost: 0, partial: false, unfilledQty: 0, levelsConsumed: 0 };
  }
  for (const level of levels) {
    if (remainingQty <= 0 || remainingUsd <= 0) break;
    const rawPrice = level[0];
    const availableSize = level[1];
    if (!(availableSize > 0)) continue;
    const priceCents = snapToTick(clamp(rawPrice, 0, 100), tickCents);
    if (!(priceCents > 0) || !(priceCents < 100)) continue;
    const priceUsd = priceCents / 100;
    const byQty = Math.min(remainingQty, availableSize);
    const byUsd = remainingUsd / priceUsd;
    const take = floorQty(Math.min(byQty, byUsd, availableSize));
    if (!(take > 0)) break;
    const notional = roundMoney(take * priceUsd);
    fills.push({ price: priceCents, qty: take, notional });
    totalQty = roundQty(totalQty + take);
    cost = roundMoney(cost + notional);
    remainingQty -= take;
    remainingUsd -= notional;
  }
  const avgPrice = totalQty > 0 ? roundPrice(cost / totalQty * 100) : 0;
  const unfilledQty = target.kind === "qty" ? roundQty(Math.max(0, target.qty - totalQty)) : 0;
  return {
    fills,
    avgPrice,
    totalQty,
    cost,
    partial: target.kind === "qty" ? unfilledQty > 0 : remainingUsd > 1e-4 && totalQty > 0,
    unfilledQty,
    levelsConsumed: fills.length
  };
}
function depthQty(levels) {
  let q = 0;
  for (const l of levels) if (l[1] > 0) q += l[1];
  return roundQty(q);
}
function depthNotional(levels) {
  let usd = 0;
  for (const l of levels) {
    if (l[1] > 0 && l[0] > 0 && l[0] < 100) usd += l[1] * l[0] / 100;
  }
  return roundMoney(usd);
}
function bestBid(ladder) {
  const l = ladder.bids[0];
  return l ? roundPrice(l[0]) : null;
}
function bestAsk(ladder) {
  const l = ladder.asks[0];
  return l ? roundPrice(l[0]) : null;
}
function midPrice(ladder) {
  const b = bestBid(ladder);
  const a = bestAsk(ladder);
  if (b == null && a == null) return null;
  if (b == null) return a;
  if (a == null) return b;
  return roundPrice((b + a) / 2);
}
function spreadCents(ladder) {
  const b = bestBid(ladder);
  const a = bestAsk(ladder);
  if (b == null || a == null) return null;
  return roundPrice(a - b);
}
function slippageBps(avgPriceCents, midCents, side) {
  if (!(midCents > 0) || !(avgPriceCents > 0)) return 0;
  const raw = (avgPriceCents - midCents) / midCents * 1e4;
  return roundPrice(side === "buy" ? raw : -raw);
}
function takerLevels(ladder, side) {
  return side === "buy" ? ladder.asks : ladder.bids;
}
function applyAdverseTicks(levels, side, ticks, tickCents) {
  if (!ticks) return levels;
  const delta = ticks * tickCents * (side === "buy" ? 1 : -1);
  const out = [];
  for (const l of levels) {
    const p = roundPrice(clamp(l[0] + delta, tickCents, 100 - tickCents));
    out.push([p, l[1]]);
  }
  return out;
}
function checkBookInvariants(yes, no, toleranceCents = 0.01) {
  const violations = [];
  let checked = 0;
  const pairs = [
    ["best_yes_ask == 100 - best_no_bid", bestAsk(yes), bestBid(no) == null ? null : 100 - bestBid(no)],
    ["best_no_ask == 100 - best_yes_bid", bestAsk(no), bestBid(yes) == null ? null : 100 - bestBid(yes)],
    ["best_yes_bid == 100 - best_no_ask", bestBid(yes), bestAsk(no) == null ? null : 100 - bestAsk(no)],
    ["best_no_bid == 100 - best_yes_ask", bestBid(no), bestAsk(yes) == null ? null : 100 - bestAsk(yes)]
  ];
  for (const [label, lhs, rhs] of pairs) {
    if (lhs == null || rhs == null) continue;
    checked++;
    if (Math.abs(lhs - rhs) > toleranceCents) {
      violations.push(`${label}: ${lhs} vs ${rhs} (delta ${roundPrice(lhs - rhs)})`);
    }
  }
  return { ok: violations.length === 0, violations, checked };
}
function isSortedBestFirst(levels, side) {
  for (let i = 1; i < levels.length; i++) {
    const prev = levels[i - 1][0];
    const cur = levels[i][0];
    if (side === "bids" ? cur > prev : cur < prev) return false;
  }
  return true;
}

// packages/core/src/fees.ts
function computeFee(model, qty, priceCents, side, multiplier = 1) {
  if (!(qty > 0) || !(priceCents > 0) || multiplier === 0) return 0;
  const p = priceCents / 100;
  let fee = 0;
  switch (model.kind) {
    case "none":
      fee = 0;
      break;
    case "bps": {
      const bps = side === "buy" ? model.takerBps : model.takerBps;
      fee = roundMoney(qty * p * bps / 1e4);
      break;
    }
    case "kalshi_quadratic": {
      fee = ceilCents(model.rate * qty * p * (1 - p));
      break;
    }
  }
  return roundMoney(fee * multiplier);
}
function parseFeeModel(raw) {
  if (!raw || typeof raw !== "object") return { kind: "none" };
  const o = raw;
  if (typeof o.rate === "number" && (o.kind === "kalshi_quadratic" || o.formula === "quadratic")) {
    return { kind: "kalshi_quadratic", rate: o.rate, note: str(o.note) };
  }
  if (typeof o.taker_bps === "number" || typeof o.maker_bps === "number") {
    return {
      kind: "bps",
      takerBps: typeof o.taker_bps === "number" ? o.taker_bps : 0,
      makerBps: typeof o.maker_bps === "number" ? o.maker_bps : 0,
      note: str(o.note)
    };
  }
  return { kind: "none", note: str(o.note) };
}
function str(v) {
  return typeof v === "string" ? v : void 0;
}
var DEFAULT_FEE_MODELS = {
  polymarket: {
    kind: "none",
    note: "No explicit trading fee. Your cost is the spread; gas is not simulated."
  },
  kalshi: {
    kind: "kalshi_quadratic",
    rate: 0.07,
    note: "ceil(0.07 x contracts x price x (1 - price)), rounded up to the next cent."
  }
};

// packages/core/src/pnl.ts
var EMPTY_POSITION = {
  qty: 0,
  avgEntryPrice: 0,
  costBasis: 0,
  realizedPnl: 0,
  feesPaid: 0
};
function applyBuy(pos, qty, priceCents, fee = 0) {
  if (!(qty > 0)) return pos;
  const addCost = roundMoney(qty * priceCents / 100);
  const newQty = roundQty(pos.qty + qty);
  const newCost = roundMoney(pos.costBasis + addCost);
  return {
    qty: newQty,
    avgEntryPrice: newQty > 0 ? roundPrice(newCost / newQty * 100) : 0,
    costBasis: newCost,
    realizedPnl: pos.realizedPnl,
    feesPaid: roundMoney(pos.feesPaid + fee)
  };
}
function applySell(pos, qty, priceCents, fee = 0) {
  const sellQty = roundQty(Math.min(qty, pos.qty));
  if (!(sellQty > 0)) {
    return { position: pos, realized: 0, proceeds: 0 };
  }
  const proceeds = roundMoney(sellQty * priceCents / 100);
  const basisOut = roundMoney(sellQty * pos.avgEntryPrice / 100);
  const realized = roundMoney(proceeds - basisOut - fee);
  const newQty = roundQty(pos.qty - sellQty);
  const newCost = roundMoney(Math.max(0, pos.costBasis - basisOut));
  return {
    position: {
      qty: newQty,
      // Average entry survives a partial close — that is what makes it an average.
      avgEntryPrice: newQty > 0 ? pos.avgEntryPrice : 0,
      costBasis: newQty > 0 ? newCost : 0,
      realizedPnl: roundMoney(pos.realizedPnl + realized),
      feesPaid: roundMoney(pos.feesPaid + fee)
    },
    realized,
    proceeds
  };
}
function unrealizedPnl(pos, markPriceCents) {
  if (!(pos.qty > 0)) return 0;
  const marketValue2 = roundMoney(pos.qty * markPriceCents / 100);
  return roundMoney(marketValue2 - pos.costBasis);
}
function marketValue(pos, markPriceCents) {
  return roundMoney(pos.qty * markPriceCents / 100);
}
function settlePosition(pos, won) {
  if (!(pos.qty > 0)) return { payout: 0, realized: 0 };
  const payout = won ? roundMoney(pos.qty * 1) : 0;
  return { payout, realized: roundMoney(payout - pos.costBasis) };
}
function equity(cash, reserved, unrealized) {
  return roundMoney(cash + reserved + unrealized);
}
function returnPct(equityNow, startingBalance) {
  if (!(startingBalance > 0)) return 0;
  return roundPrice((equityNow - startingBalance) / startingBalance * 100);
}
function drawdownPct(equityNow, peakEquity) {
  if (!(peakEquity > 0)) return 0;
  return roundPrice(Math.max(0, (peakEquity - equityNow) / peakEquity * 100));
}
function ticketMath(qty, avgPriceCents, fee) {
  const cost = roundMoney(qty * avgPriceCents / 100);
  const totalCost = roundMoney(cost + fee);
  const maxPayout = roundMoney(qty * 1);
  const maxProfit = roundMoney(maxPayout - totalCost);
  return {
    cost,
    fee: roundMoney(fee),
    totalCost,
    maxPayout,
    maxProfit,
    breakevenCents: qty > 0 ? roundPrice(totalCost / qty * 100) : 0,
    roiPct: totalCost > 0 ? roundPrice(maxProfit / totalCost * 100) : 0
  };
}

// packages/core/src/scoring.ts
var MIN_N_FOR_BSS = 30;
var MIN_N_FOR_CATEGORY = 20;
function brier(p, outcome) {
  const pc = clamp(p, 0, 1);
  return roundTo((pc - outcome) ** 2, 8);
}
function logScore(p, outcome) {
  const eps = 1e-9;
  const pc = clamp(p, eps, 1 - eps);
  return roundTo(-Math.log(outcome === 1 ? pc : 1 - pc), 8);
}
function brierSkillScore(brierUser, brierReference) {
  if (!(brierReference > 0)) return null;
  return roundTo(1 - brierUser / brierReference, 6);
}
function edgeBps(pUser, pMarket) {
  return roundTo((pMarket - pUser) * 1e4, 4);
}
var EMPTY_MURPHY = { reliability: 0, resolution: 0, uncertainty: 0, brier: 0 };
var EMPTY_CALIBRATION = {
  n: 0,
  brierUser: 0,
  brierMarket: 0,
  brierSkill: null,
  ciLow: null,
  ciHigh: null,
  baseRate: 0,
  bins: [],
  murphy: EMPTY_MURPHY,
  displayable: false,
  meanEdgeBps: 0
};
function murphyDecomposition(records, binCount = 10) {
  const n = records.length;
  if (n === 0) return EMPTY_MURPHY;
  const baseRate = records.reduce((s, r) => s + r.outcome, 0) / n;
  const buckets = /* @__PURE__ */ new Map();
  for (const r of records) {
    const bin = binIndex(r.pUser, binCount);
    const arr = buckets.get(bin);
    if (arr) arr.push(r);
    else buckets.set(bin, [r]);
  }
  let reliability = 0;
  let resolution = 0;
  for (const group of buckets.values()) {
    const nk = group.length;
    const pk = group.reduce((s, r) => s + clamp(r.pUser, 0, 1), 0) / nk;
    const ok = group.reduce((s, r) => s + r.outcome, 0) / nk;
    reliability += nk * (pk - ok) ** 2;
    resolution += nk * (ok - baseRate) ** 2;
  }
  reliability /= n;
  resolution /= n;
  const uncertainty = baseRate * (1 - baseRate);
  return {
    reliability: roundTo(reliability, 6),
    resolution: roundTo(resolution, 6),
    uncertainty: roundTo(uncertainty, 6),
    brier: roundTo(reliability - resolution + uncertainty, 6)
  };
}
function binIndex(p, binCount) {
  const pc = clamp(p, 0, 1);
  return Math.min(binCount - 1, Math.floor(pc * binCount));
}
function calibrationBins(records, binCount = 10) {
  const buckets = /* @__PURE__ */ new Map();
  for (const r of records) {
    const bin = binIndex(r.pUser, binCount);
    const arr = buckets.get(bin);
    if (arr) arr.push(r);
    else buckets.set(bin, [r]);
  }
  const out = [];
  for (let b = 0; b < binCount; b++) {
    const group = buckets.get(b);
    if (!group || group.length === 0) continue;
    const nk = group.length;
    out.push({
      bin: b,
      binMid: roundTo((b + 0.5) / binCount, 4),
      n: nk,
      meanPredicted: roundTo(group.reduce((s, r) => s + clamp(r.pUser, 0, 1), 0) / nk, 6),
      observedFrequency: roundTo(group.reduce((s, r) => s + r.outcome, 0) / nk, 6)
    });
  }
  return out;
}
function summarizeCalibration(records) {
  const n = records.length;
  if (n === 0) return EMPTY_CALIBRATION;
  const bu = records.map((r) => brier(r.pUser, r.outcome));
  const bm = records.map((r) => brier(r.pMarket, r.outcome));
  const diffs = bu.map((v, i) => v - bm[i]);
  const meanBu = mean(bu);
  const meanBm = mean(bm);
  const skill = brierSkillScore(meanBu, meanBm);
  const baseRate = records.reduce((s, r) => s + r.outcome, 0) / n;
  let ciLow = null;
  let ciHigh = null;
  if (n >= MIN_N_FOR_BSS && meanBm > 0) {
    const se = stddevSample(diffs) / Math.sqrt(n);
    const halfWidth = 1.96 * se / meanBm;
    ciLow = roundTo((skill ?? 0) - halfWidth, 6);
    ciHigh = roundTo((skill ?? 0) + halfWidth, 6);
  }
  return {
    n,
    brierUser: roundTo(meanBu, 6),
    brierMarket: roundTo(meanBm, 6),
    brierSkill: skill,
    ciLow,
    ciHigh,
    baseRate: roundTo(baseRate, 6),
    bins: calibrationBins(records),
    murphy: murphyDecomposition(records),
    displayable: n >= MIN_N_FOR_BSS,
    meanEdgeBps: roundTo(mean(records.map((r) => edgeBps(r.pUser, r.pMarket))), 4)
  };
}
function mean(xs) {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}
function stddevSample(xs) {
  const k = xs.length;
  if (k < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (k - 1));
}
function percentile(sorted, q) {
  if (sorted.length === 0) return 0;
  const xs = [...sorted].sort((a, b) => a - b);
  const pos = clamp(q, 0, 1) * (xs.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return xs[lo];
  return xs[lo] + (xs[hi] - xs[lo]) * (pos - lo);
}
function winsorizedNormalizedReturn(value, cohort) {
  if (cohort.length === 0) return 0.5;
  const p5 = percentile(cohort, 0.05);
  const p95 = percentile(cohort, 0.95);
  const clamped = clamp(value, p5, p95);
  if (!(p95 > p5)) return 0.5;
  return roundTo((clamped - p5) / (p95 - p5), 6);
}
function normalizeBrierSkill(bss) {
  if (bss == null) return 0;
  return roundTo(clamp((bss + 0.25) / 0.5, 0, 1), 6);
}
function disciplineScore(stakeNotionals) {
  if (stakeNotionals.length < 2) return 0;
  const m = mean(stakeNotionals);
  if (!(m > 0)) return 0;
  const cv = stddevSample(stakeNotionals) / m;
  return roundTo(clamp(1 - cv, 0, 1), 6);
}
function activityScore(tradeCount, saturateAt = 15) {
  return roundTo(clamp(tradeCount / saturateAt, 0, 1), 6);
}
var LADDER_WEIGHTS = {
  normalizedReturn: 0.45,
  brierSkill: 0.35,
  discipline: 0.1,
  activity: 0.1
};
function ladderPoints(i) {
  const raw = LADDER_WEIGHTS.normalizedReturn * clamp(i.normalizedReturn, 0, 1) + LADDER_WEIGHTS.brierSkill * clamp(i.brierSkillNormalized, 0, 1) + LADDER_WEIGHTS.discipline * clamp(i.discipline, 0, 1) + LADDER_WEIGHTS.activity * clamp(i.activity, 0, 1);
  return roundTo(1e3 * raw, 4);
}
function coachingVerdict(s) {
  if (s.n < MIN_N_FOR_BSS) {
    return `Building your record \u2014 ${s.n}/${MIN_N_FOR_BSS} resolved positions. Keep trading; a skill score before 30 would be noise.`;
  }
  const bss = s.brierSkill ?? 0;
  const overconfident = s.murphy.reliability > 0.02;
  if (bss > 0.05) {
    return overconfident ? "You are beating the market price, but your confidence runs ahead of your accuracy. Size down on your strongest convictions." : "You are genuinely beating the market price. Your forecasts carry information the price did not.";
  }
  if (bss > -0.02) {
    return "You are roughly matching the market. That is harder than it sounds \u2014 but the spread you pay makes it a losing trade over time.";
  }
  return overconfident ? "You are paying for confidence you have not earned. Your extreme forecasts miss most often \u2014 try trading closer to the mid." : "The market price is beating your forecasts. Look for categories where you actually have an edge instead of trading everything.";
}

// packages/core/src/format.ts
function formatCents(cents, dp) {
  if (cents == null || !Number.isFinite(cents)) return "--";
  const places = dp ?? (Number.isInteger(roundTo(cents, 2)) ? 0 : 1);
  return `${cents.toFixed(places)}\xA2`;
}
function formatGhostDollars(usd, dp = 2) {
  if (usd == null || !Number.isFinite(usd)) return "--";
  const sign = usd < 0 ? "-" : "";
  return `${sign}G$${Math.abs(usd).toLocaleString("en-US", {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp
  })}`;
}
function formatSignedGhostDollars(usd, dp = 2) {
  if (usd == null || !Number.isFinite(usd)) return "--";
  const sign = usd > 0 ? "+" : usd < 0 ? "-" : "";
  return `${sign}G$${Math.abs(usd).toLocaleString("en-US", {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp
  })}`;
}
function formatPercent(pct, dp = 1) {
  if (pct == null || !Number.isFinite(pct)) return "--";
  return `${pct.toFixed(dp)}%`;
}
function formatSignedPercent(pct, dp = 1) {
  if (pct == null || !Number.isFinite(pct)) return "--";
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(dp)}%`;
}
function formatProbability(p) {
  if (p == null || !Number.isFinite(p)) return "--";
  return `${Math.round(p * 100)}%`;
}
function formatBps(bps) {
  if (bps == null || !Number.isFinite(bps)) return "--";
  const sign = bps > 0 ? "+" : "";
  return `${sign}${Math.round(bps)} bps`;
}
function formatCompact(n) {
  if (n == null || !Number.isFinite(n)) return "--";
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(abs >= 1e4 ? 0 : 1)}K`;
  return Math.round(n).toLocaleString("en-US");
}
function formatQty(qty) {
  if (qty == null || !Number.isFinite(qty)) return "--";
  return Number.isInteger(qty) ? qty.toLocaleString("en-US") : qty.toFixed(2);
}
function formatScore(v, dp = 3) {
  if (v == null || !Number.isFinite(v)) return "--";
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(dp)}`;
}
function formatCountdown(closeTime, now = /* @__PURE__ */ new Date()) {
  if (!closeTime) return "--";
  const close = typeof closeTime === "string" ? new Date(closeTime) : closeTime;
  if (Number.isNaN(close.getTime())) return "--";
  const ms = close.getTime() - now.getTime();
  if (ms <= 0) return "Closed";
  const s = Math.floor(ms / 1e3);
  const d = Math.floor(s / 86400);
  const h = Math.floor(s % 86400 / 3600);
  const m = Math.floor(s % 3600 / 60);
  if (d > 30) return `${Math.floor(d / 30)}mo`;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}
function formatRelativeTime(ts, now = /* @__PURE__ */ new Date()) {
  if (!ts) return "--";
  const t = typeof ts === "string" ? new Date(ts) : ts;
  if (Number.isNaN(t.getTime())) return "--";
  const s = Math.floor((now.getTime() - t.getTime()) / 1e3);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
function unitNoun(venue, qty = 2) {
  const singular = venue === "polymarket" ? "share" : "contract";
  return qty === 1 ? singular : `${singular}s`;
}
var REJECT_COPY = {
  insufficient_funds: "Not enough ghost cash for this order.",
  market_closed: "This market has closed.",
  stale_book: "We've lost the live book for this market. Try again shortly.",
  quote_expired: "Your quote expired. Refreshing\u2026",
  price_moved: "Price moved while your order was in flight. Requote?",
  size_exceeds_depth: "Larger than this market can absorb \u2014 in reality you'd move the price against yourself.",
  below_min_size: "Below the minimum order size for this market.",
  invalid_tick: "That price isn't on this market's tick grid.",
  rate_limited: "Slow down \u2014 you're placing orders faster than a human can think.",
  position_limit: "This would put more than 20% of your bankroll in one market. Position sizing is the point.",
  no_liquidity: "There is no visible liquidity on that side of the book right now.",
  resolution_lockout: "This market is already priced as a near-certainty. Trading it now would be front-running the result, not forecasting it.",
  duplicate: "Order already submitted."
};
function rejectCopy(code, detail) {
  return detail || REJECT_COPY[code] || "Order rejected.";
}

// packages/venues/src/types.ts
var VenueError = class extends Error {
  constructor(venue, status, message, endpoint) {
    super(message);
    this.venue = venue;
    this.status = status;
    this.endpoint = endpoint;
    this.name = "VenueError";
  }
  venue;
  status;
  endpoint;
  /** 429 and 5xx are worth retrying with backoff; 4xx generally is not. */
  get retryable() {
    return this.status === 429 || this.status >= 500 || this.status === 0;
  }
};

// packages/venues/src/decimal-parse.ts
var CENTS_DP = 2;
var CENTS_SCALE = 10 ** CENTS_DP;
function dollarsStringToCents(input) {
  if (input == null) return null;
  const s = String(input).trim();
  if (!/^[+-]?\d*\.?\d+(?:[eE][+-]?\d+)?$/.test(s)) return null;
  if (/[eE]/.test(s)) {
    const v = Number(s);
    if (!Number.isFinite(v)) return null;
    return Math.round(v * 100 * CENTS_SCALE) / CENTS_SCALE;
  }
  const negative = s.startsWith("-");
  const body = s.replace(/^[+-]/, "");
  const [wholeRaw, fracRaw = ""] = body.split(".");
  const whole = wholeRaw || "0";
  const keep = 2 + CENTS_DP;
  const frac = fracRaw.padEnd(keep + 1, "0");
  const kept = frac.slice(0, keep);
  const nextDigit = Number(frac[keep] ?? "0");
  let scaledCents = Number(whole) * 100 * CENTS_SCALE + Number(kept || "0");
  if (nextDigit >= 5) scaledCents += 1;
  const cents = scaledCents / CENTS_SCALE;
  return negative ? -cents : cents;
}
function sizeStringToQty(input) {
  if (input == null) return null;
  const s = String(input).trim();
  if (!/^[+-]?\d*\.?\d+(?:[eE][+-]?\d+)?$/.test(s)) return null;
  const v = Number(s);
  if (!Number.isFinite(v)) return null;
  return Math.round(v * 100) / 100;
}
function num(input) {
  if (typeof input === "number") return Number.isFinite(input) ? input : void 0;
  if (typeof input === "string" && input.trim() !== "") {
    const v = Number(input);
    return Number.isFinite(v) ? v : void 0;
  }
  return void 0;
}
function parseJsonArray(input) {
  if (Array.isArray(input)) return input.map((v) => String(v));
  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input);
      return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
    } catch {
      return [];
    }
  }
  return [];
}
function parseDate(input) {
  if (!input) return void 0;
  const d = new Date(String(input));
  return Number.isNaN(d.getTime()) ? void 0 : d;
}

// packages/venues/src/http.ts
async function venueFetch(venue, url, opts = {}) {
  const { method = "GET", body, headers = {}, timeoutMs = 15e3, retries = 2 } = opts;
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers: {
          accept: "application/json",
          ...body ? { "content-type": "application/json" } : {},
          ...headers
        },
        ...body ? { body: JSON.stringify(body) } : {},
        signal: controller.signal
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        const err = new VenueError(venue, res.status, `${res.status} ${text.slice(0, 200)}`, url);
        if (!err.retryable || attempt === retries) throw err;
        lastError = err;
        await backoff(attempt, res.headers.get("retry-after"));
        continue;
      }
      return await res.json();
    } catch (e) {
      if (e instanceof VenueError) {
        if (!e.retryable || attempt === retries) throw e;
        lastError = e;
      } else {
        const err = new VenueError(venue, 0, e instanceof Error ? e.message : String(e), url);
        if (attempt === retries) throw err;
        lastError = err;
      }
      await backoff(attempt, null);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError ?? new VenueError(venue, 0, "exhausted retries", url);
}
async function backoff(attempt, retryAfter) {
  const headerMs = retryAfter ? Number(retryAfter) * 1e3 : Number.NaN;
  const base = Number.isFinite(headerMs) ? headerMs : 2 ** attempt * 500;
  const jitter = Math.random() * 250;
  await new Promise((r) => setTimeout(r, Math.min(base + jitter, 1e4)));
}
async function mapConcurrent(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (; ; ) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

// packages/venues/src/polymarket.ts
var GAMMA = "https://gamma-api.polymarket.com";
var CLOB = "https://clob.polymarket.com";
var PolymarketAdapter = class {
  code = "polymarket";
  displayName = "Polymarket";
  unitNoun = "shares";
  async listEvents(cursor, limit = 100) {
    const offset = cursor ? Number(cursor) : 0;
    const url = `${GAMMA}/events?limit=${limit}&offset=${offset}&closed=false&archived=false&order=volume24hr&ascending=false`;
    const raw = await venueFetch(this.code, url);
    const events = raw.map((e) => this.normalizeEvent(e)).filter((e) => e.markets.length > 0);
    const next = raw.length === limit ? String(offset + limit) : void 0;
    return { events, ...next ? { next } : {} };
  }
  async getMarkets(venueMarketIds) {
    if (venueMarketIds.length === 0) return [];
    const chunks = chunk(venueMarketIds, 20);
    const results = await mapConcurrent(chunks, 3, async (ids) => {
      const qs = ids.map((id) => `condition_ids=${encodeURIComponent(id)}`).join("&");
      const raw = await venueFetch(this.code, `${GAMMA}/markets?${qs}&limit=100`);
      return raw.map((m) => this.normalizeMarket(m, m.events?.[0]?.id ?? ""));
    });
    return results.flat().filter((m) => m !== null);
  }
  async getOrderBook(ref) {
    if (ref.venue !== "polymarket") throw new VenueError(this.code, 0, "wrong adapter for book ref");
    const [yesRaw, noRaw] = await Promise.all([
      venueFetch(this.code, `${CLOB}/book?token_id=${ref.yesTokenId}`),
      venueFetch(this.code, `${CLOB}/book?token_id=${ref.noTokenId}`)
    ]);
    return {
      marketId: ref.yesTokenId,
      capturedAt: bookTimestamp(yesRaw, noRaw),
      yes: normalizeLadder(yesRaw),
      no: normalizeLadder(noRaw)
    };
  }
  async getOrderBooks(refs) {
    const out = /* @__PURE__ */ new Map();
    const books = await mapConcurrent(refs, 4, async (ref) => {
      try {
        return { ref, book: await this.getOrderBook(ref) };
      } catch {
        return null;
      }
    });
    for (const entry of books) {
      if (entry && entry.ref.venue === "polymarket") out.set(entry.ref.yesTokenId, entry.book);
    }
    return out;
  }
  async getPriceHistory(ref, from, to, interval) {
    if (ref.venue !== "polymarket") return [];
    const fidelity = FIDELITY_MINUTES[interval] ?? 60;
    const url = `${CLOB}/prices-history?market=${ref.yesTokenId}&startTs=${Math.floor(from.getTime() / 1e3)}&endTs=${Math.floor(to.getTime() / 1e3)}&fidelity=${fidelity}`;
    const raw = await venueFetch(this.code, url);
    return (raw.history ?? []).map((pt) => {
      const cents = roundPrice(pt.p * 100);
      return { ts: new Date(pt.t * 1e3), o: cents, h: cents, l: cents, c: cents, v: 0 };
    });
  }
  async getResolutions(venueMarketIds) {
    const markets = await this.getMarkets(venueMarketIds);
    return markets.map((m) => ({
      venueMarketId: m.venueMarketId,
      status: m.status,
      resolution: m.resolution ?? null,
      ...m.resolvedAt ? { resolvedAt: m.resolvedAt } : {}
    }));
  }
  computeFee(qty, priceCents, side, multiplier = 1) {
    return computeFee(DEFAULT_FEE_MODELS.polymarket, qty, priceCents, side, multiplier);
  }
  normalizeEvent(e) {
    const markets = (e.markets ?? []).map((m) => this.normalizeMarket(m, String(e.id))).filter((m) => m !== null);
    return {
      venue: this.code,
      venueEventId: String(e.id),
      ...e.ticker ? { seriesKey: seriesKeyFromTicker(e.ticker) } : {},
      title: e.title ?? "Untitled",
      ...e.slug ? { slug: e.slug } : {},
      ...e.description ? { description: e.description } : {},
      category: categorize(e),
      ...e.image ? { imageUrl: e.image } : {},
      ...parseDate(e.startDate) ? { openTime: parseDate(e.startDate) } : {},
      ...parseDate(e.endDate) ? { closeTime: parseDate(e.endDate) } : {},
      isActive: e.closed !== true,
      markets
    };
  }
  normalizeMarket(m, eventId) {
    const tokens = parseJsonArray(m.clobTokenIds);
    const outcomes = parseJsonArray(m.outcomes);
    if (tokens.length < 2 || !tokens[0] || !tokens[1]) return null;
    if (m.enableOrderBook === false) return null;
    const tickCents = roundPrice((num(m.orderPriceMinTickSize) ?? 0.01) * 100);
    const prices = parseJsonArray(m.outcomePrices);
    const lastPrice = dollarsStringToCents(prices[0] ?? m.lastTradePrice);
    const yesBid = dollarsStringToCents(m.bestBid);
    const yesAsk = dollarsStringToCents(m.bestAsk);
    return {
      venue: this.code,
      venueEventId: eventId,
      venueMarketId: m.conditionId,
      question: m.question ?? m.groupItemTitle ?? "Untitled market",
      ...m.slug ? { slug: m.slug } : {},
      yesLabel: outcomes[0] ?? "Yes",
      noLabel: outcomes[1] ?? "No",
      ...m.resolutionSource ? { resolutionSource: m.resolutionSource } : {},
      ...m.description ? { resolutionRules: m.description } : {},
      status: marketStatus(m),
      ...yesBid != null ? { yesBid } : {},
      ...yesAsk != null ? { yesAsk } : {},
      // The NO side mirrors YES exactly on Polymarket — verified live on the
      // real books, and re-asserted per snapshot by checkBookInvariants.
      ...yesAsk != null ? { noBid: roundPrice(100 - yesAsk) } : {},
      ...yesBid != null ? { noAsk: roundPrice(100 - yesBid) } : {},
      ...lastPrice != null ? { lastPrice } : {},
      ...yesBid != null && yesAsk != null ? { midPrice: roundPrice((yesBid + yesAsk) / 2) } : {},
      ...num(m.oneDayPriceChange) != null && lastPrice != null ? { price24hAgo: roundPrice(lastPrice - num(m.oneDayPriceChange) * 100) } : {},
      volume24h: num(m.volume24hr) ?? 0,
      volumeTotal: num(m.volumeNum) ?? num(m.volume) ?? 0,
      liquidity: num(m.liquidityNum) ?? num(m.liquidity) ?? 0,
      tickCents: tickCents > 0 ? tickCents : 1,
      minOrderSize: num(m.orderMinSize) ?? 1,
      ...parseDate(m.startDate) ? { openTime: parseDate(m.startDate) } : {},
      ...parseDate(m.endDate) ? { closeTime: parseDate(m.endDate) } : {},
      ...parseDate(m.closedTime) ? { resolvedAt: parseDate(m.closedTime) } : {},
      ...resolutionOf(m, prices),
      bookRef: { venue: "polymarket", yesTokenId: tokens[0], noTokenId: tokens[1] }
    };
  }
};
function normalizeLadder(raw) {
  return {
    bids: toLevels(raw.bids).sort((a, b) => b[0] - a[0]),
    asks: toLevels(raw.asks).sort((a, b) => a[0] - b[0])
  };
}
function toLevels(rows) {
  const out = [];
  for (const r of rows ?? []) {
    const price = dollarsStringToCents(r.price);
    const size = sizeStringToQty(r.size);
    if (price == null || size == null) continue;
    if (!(price > 0) || !(price < 100) || !(size > 0)) continue;
    out.push([price, size]);
  }
  return out;
}
function bookTimestamp(...books) {
  for (const b of books) {
    const ms = num(b.timestamp);
    if (ms && ms > 1e12) return new Date(ms);
    if (ms && ms > 1e9) return new Date(ms * 1e3);
  }
  return /* @__PURE__ */ new Date();
}
function marketStatus(m) {
  if (m.umaResolutionStatus === "resolved" || m.closed === true) return "resolved";
  if (m.active === false) return "closed";
  const end = parseDate(m.endDate);
  if (end && end.getTime() < Date.now()) return "resolving";
  return "open";
}
function resolutionOf(m, prices) {
  if (m.closed !== true) return {};
  const yes = dollarsStringToCents(prices[0]);
  if (yes == null) return {};
  if (yes >= 99) return { resolution: "yes" };
  if (yes <= 1) return { resolution: "no" };
  return {};
}
function seriesKeyFromTicker(ticker) {
  return ticker.split("-")[0] ?? ticker;
}
function categorize(e) {
  const tags = (e.tags ?? []).map((t) => (typeof t === "string" ? t : t.slug ?? "").toLowerCase());
  const hay = `${tags.join(" ")} ${(e.title ?? "").toLowerCase()}`;
  if (/politic|election|congress|senate|president|nomine/.test(hay)) return "politics";
  if (/sport|nfl|nba|mlb|soccer|football|tennis|esport|ufc|f1|golf|hockey/.test(hay)) return "sports";
  if (/crypto|bitcoin|ethereum|btc|eth|solana|token/.test(hay)) return "crypto";
  if (/econom|inflation|fed|rates|gdp|jobs|cpi|recession/.test(hay)) return "economics";
  if (/science|space|climate|health|ai |artificial intelligence|tech/.test(hay)) return "science";
  if (/movie|music|award|oscar|celebrit|culture|tv|game/.test(hay)) return "culture";
  return "other";
}
function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
var FIDELITY_MINUTES = {
  "1m": 1,
  "5m": 5,
  "1h": 60,
  "6h": 360,
  "1d": 1440,
  "1w": 10080
};
function bookMid(book) {
  return midPrice(book.yes);
}

// packages/venues/src/kalshi.ts
var HOSTS = {
  prod: "https://api.elections.kalshi.com/trade-api/v2",
  demo: "https://demo-api.kalshi.co/trade-api/v2"
};
var TICK_BY_STRUCTURE = {
  linear_cent: 1,
  cent: 1,
  deci_cent: 0.1,
  tapered_deci_cent: 0.1,
  linear_deci_cent: 0.1
};
var KalshiAdapter = class {
  code = "kalshi";
  displayName = "Kalshi";
  unitNoun = "contracts";
  base;
  constructor(opts = {}) {
    this.base = opts.baseUrl ?? HOSTS[opts.env ?? "prod"];
  }
  async listEvents(cursor, limit = 100) {
    const url = `${this.base}/events?limit=${limit}&status=open&with_nested_markets=true` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
    const raw = await venueFetch(this.code, url);
    const events = (raw.events ?? []).filter((e) => !isMultivariate(e.event_ticker)).map((e) => this.normalizeEvent(e)).filter((e) => e.markets.length > 0);
    return { events, ...raw.cursor ? { next: raw.cursor } : {} };
  }
  async getMarkets(tickers) {
    if (tickers.length === 0) return [];
    const results = await mapConcurrent(tickers, 6, async (ticker) => {
      try {
        const raw = await venueFetch(
          this.code,
          `${this.base}/markets/${encodeURIComponent(ticker)}`
        );
        return raw.market ? this.normalizeMarket(raw.market, raw.market.event_ticker ?? "") : null;
      } catch {
        return null;
      }
    });
    return results.filter((m) => m !== null);
  }
  async getOrderBook(ref) {
    if (ref.venue !== "kalshi") throw new VenueError(this.code, 0, "wrong adapter for book ref");
    const raw = await venueFetch(
      this.code,
      `${this.base}/markets/${encodeURIComponent(ref.ticker)}/orderbook?depth=100`
    );
    const { yes, no } = normalizeKalshiBook(raw);
    return { marketId: ref.ticker, capturedAt: /* @__PURE__ */ new Date(), yes, no };
  }
  async getOrderBooks(refs) {
    const out = /* @__PURE__ */ new Map();
    const books = await mapConcurrent(refs, 8, async (ref) => {
      try {
        return { ref, book: await this.getOrderBook(ref) };
      } catch {
        return null;
      }
    });
    for (const entry of books) {
      if (entry && entry.ref.venue === "kalshi") out.set(entry.ref.ticker, entry.book);
    }
    return out;
  }
  async getPriceHistory(ref, from, to, interval) {
    if (ref.venue !== "kalshi") return [];
    const period = PERIOD_MINUTES[interval] ?? 60;
    const url = `${this.base}/series/${seriesOf(ref.ticker)}/markets/${encodeURIComponent(ref.ticker)}/candlesticks?start_ts=${Math.floor(from.getTime() / 1e3)}&end_ts=${Math.floor(to.getTime() / 1e3)}&period_interval=${period}`;
    try {
      const raw = await venueFetch(this.code, url);
      return (raw.candlesticks ?? []).flatMap((c) => {
        const ts = c.end_period_ts ? new Date(c.end_period_ts * 1e3) : null;
        const price = c.price ?? {};
        const o = dollarsStringToCents(price.open_dollars);
        const h = dollarsStringToCents(price.high_dollars);
        const l = dollarsStringToCents(price.low_dollars);
        const close = dollarsStringToCents(price.close_dollars);
        if (!ts || o == null || h == null || l == null || close == null) return [];
        return [{ ts, o, h, l, c: close, v: num(c.volume_fp) ?? 0 }];
      });
    } catch {
      return [];
    }
  }
  async getResolutions(tickers) {
    const results = await mapConcurrent(tickers, 6, async (ticker) => {
      try {
        const raw = await venueFetch(
          this.code,
          `${this.base}/markets/${encodeURIComponent(ticker)}`
        );
        const m = raw.market;
        if (!m) return null;
        return {
          venueMarketId: ticker,
          status: statusOf(m),
          resolution: resolutionOf2(m),
          ...parseDate(m.expiration_time) ? { resolvedAt: parseDate(m.expiration_time) } : {}
        };
      } catch {
        return null;
      }
    });
    return results.filter((r) => r !== null);
  }
  computeFee(qty, priceCents, side, multiplier = 1) {
    return computeFee(DEFAULT_FEE_MODELS.kalshi, qty, priceCents, side, multiplier);
  }
  normalizeEvent(e) {
    const markets = (e.markets ?? []).map((m) => this.normalizeMarket(m, e.event_ticker)).filter((m) => m !== null);
    return {
      venue: this.code,
      venueEventId: e.event_ticker,
      ...e.series_ticker ? { seriesKey: e.series_ticker } : {},
      title: e.title ?? e.event_ticker,
      ...e.sub_title ? { description: e.sub_title } : {},
      category: categorize2(e.category, e.title),
      ...e.category ? { subcategory: e.category } : {},
      isActive: true,
      markets
    };
  }
  normalizeMarket(m, eventTicker) {
    if (!m.ticker || isMultivariate(m.ticker)) return null;
    const yesBid = dollarsStringToCents(m.yes_bid_dollars);
    const yesAsk = dollarsStringToCents(m.yes_ask_dollars);
    const noBid = dollarsStringToCents(m.no_bid_dollars);
    const noAsk = dollarsStringToCents(m.no_ask_dollars);
    const last = dollarsStringToCents(m.last_price_dollars);
    const prev = dollarsStringToCents(m.previous_price_dollars);
    const tick = TICK_BY_STRUCTURE[m.price_level_structure ?? ""] ?? 1;
    return {
      venue: this.code,
      venueEventId: m.event_ticker ?? eventTicker,
      venueMarketId: m.ticker,
      question: m.title ?? m.ticker,
      yesLabel: m.yes_sub_title || "Yes",
      noLabel: m.no_sub_title || "No",
      ...m.rules_primary ? { resolutionRules: m.rules_primary } : {},
      status: statusOf(m),
      ...yesBid != null ? { yesBid } : {},
      ...yesAsk != null ? { yesAsk } : {},
      ...noBid != null ? { noBid } : {},
      ...noAsk != null ? { noAsk } : {},
      ...last != null ? { lastPrice: last } : {},
      ...yesBid != null && yesAsk != null ? { midPrice: roundPrice((yesBid + yesAsk) / 2) } : {},
      ...prev != null ? { price24hAgo: prev } : {},
      volume24h: num(m.volume_24h_fp) ?? 0,
      volumeTotal: num(m.volume_fp) ?? 0,
      openInterest: num(m.open_interest_fp) ?? 0,
      liquidity: num(m.liquidity_dollars) ?? 0,
      tickCents: tick,
      minOrderSize: 1,
      ...parseDate(m.open_time) ? { openTime: parseDate(m.open_time) } : {},
      ...parseDate(m.close_time) ? { closeTime: parseDate(m.close_time) } : {},
      ...parseDate(m.expiration_time) ? { resolvedAt: parseDate(m.expiration_time) } : {},
      ...resolutionOf2(m) ? { resolution: resolutionOf2(m) } : {},
      bookRef: { venue: "kalshi", ticker: m.ticker }
    };
  }
};
function normalizeKalshiBook(raw) {
  const fp = raw.orderbook_fp ?? raw.orderbook ?? {};
  const yesBids = toLevels2(fp.yes_dollars ?? fp.yes);
  const noBids = toLevels2(fp.no_dollars ?? fp.no);
  const yesAsks = mirror(noBids);
  const noAsks = mirror(yesBids);
  return {
    yes: {
      bids: yesBids.sort((a, b) => b[0] - a[0]),
      asks: yesAsks.sort((a, b) => a[0] - b[0])
    },
    no: {
      bids: noBids.sort((a, b) => b[0] - a[0]),
      asks: noAsks.sort((a, b) => a[0] - b[0])
    }
  };
}
function mirror(levels) {
  const out = [];
  for (const [price, size] of levels) {
    const mirrored = roundPrice(100 - price);
    if (mirrored > 0 && mirrored < 100) out.push([mirrored, size]);
  }
  return out;
}
function toLevels2(rows) {
  const out = [];
  for (const row of rows ?? []) {
    if (!Array.isArray(row) || row.length < 2) continue;
    const price = dollarsStringToCents(row[0]);
    const size = sizeStringToQty(row[1]);
    if (price == null || size == null) continue;
    if (!(price > 0) || !(price < 100) || !(size > 0)) continue;
    out.push([price, size]);
  }
  return out;
}
function statusOf(m) {
  const s = (m.status ?? "").toLowerCase();
  if (s === "finalized" || s === "settled") return "resolved";
  if (s === "closed" || s === "determined") return "resolving";
  if (s === "active" || s === "open" || s === "initialized") {
    const close = parseDate(m.close_time);
    return close && close.getTime() < Date.now() ? "resolving" : "open";
  }
  return "closed";
}
function resolutionOf2(m) {
  const r = (m.result ?? "").toLowerCase();
  if (r === "yes") return "yes";
  if (r === "no") return "no";
  return null;
}
function seriesOf(ticker) {
  return ticker.split("-")[0] ?? ticker;
}
function isMultivariate(ticker) {
  return !!ticker && ticker.startsWith("KXMVE");
}
function categorize2(category, title) {
  const hay = `${category ?? ""} ${title ?? ""}`.toLowerCase();
  if (/politic|election|congress|senate|president|nomine|governor/.test(hay)) return "politics";
  if (/sport|nfl|nba|mlb|soccer|football|tennis|ufc|f1|golf|hockey|olympic/.test(hay)) return "sports";
  if (/crypto|bitcoin|ethereum|btc|eth|solana/.test(hay)) return "crypto";
  if (/econom|inflation|fed|rates|gdp|jobs|cpi|recession|treasur/.test(hay)) return "economics";
  if (/science|space|climate|health|weather|temperature|ai\b|tech/.test(hay)) return "science";
  if (/movie|music|award|oscar|celebrit|culture|tv|entertain/.test(hay)) return "culture";
  if (/world|geopolit|war|nato/.test(hay)) return "politics";
  return "other";
}
var PERIOD_MINUTES = {
  "1m": 1,
  "5m": 5,
  "1h": 60,
  "6h": 60,
  "1d": 1440,
  "1w": 1440
};

// packages/venues/src/index.ts
function createAdapters(opts = {}) {
  return {
    polymarket: new PolymarketAdapter(),
    kalshi: new KalshiAdapter({ env: opts.kalshiEnv ?? "prod" })
  };
}
export {
  DEFAULT_FEE_MODELS,
  DEFAULT_MARKET_RULES,
  EMPTY_CALIBRATION,
  EMPTY_POSITION,
  KalshiAdapter,
  LADDER_WEIGHTS,
  MIN_N_FOR_BSS,
  MIN_N_FOR_CATEGORY,
  MONEY_DP,
  PRICE_DP,
  PolymarketAdapter,
  QTY_DP,
  REALISM,
  REJECT_COPY,
  VenueError,
  activityScore,
  applyAdverseTicks,
  applyBuy,
  applySell,
  bestAsk,
  bestBid,
  bookMid,
  brier,
  brierSkillScore,
  calibrationBins,
  ceilCents,
  checkBookInvariants,
  clamp,
  coachingVerdict,
  computeFee,
  createAdapters,
  depthNotional,
  depthQty,
  disciplineScore,
  dollarsStringToCents,
  drawdownPct,
  edgeBps,
  equity,
  floorQty,
  floorTo,
  formatBps,
  formatCents,
  formatCompact,
  formatCountdown,
  formatGhostDollars,
  formatPercent,
  formatProbability,
  formatQty,
  formatRelativeTime,
  formatScore,
  formatSignedGhostDollars,
  formatSignedPercent,
  isOnTick,
  isSortedBestFirst,
  ladderPoints,
  logScore,
  mapConcurrent,
  marketValue,
  midPrice,
  murphyDecomposition,
  normalizeBrierSkill,
  normalizeKalshiBook,
  normalizeLadder,
  num,
  parseDate,
  parseFeeModel,
  parseJsonArray,
  percentile,
  rejectCopy,
  returnPct,
  roundMoney,
  roundPrice,
  roundQty,
  roundTo,
  settlePosition,
  sizeStringToQty,
  slippageBps,
  snapToTick,
  spreadCents,
  summarizeCalibration,
  takerLevels,
  ticketMath,
  unitNoun,
  unrealizedPnl,
  venueFetch,
  walkBook,
  winsorizedNormalizedReturn
};
