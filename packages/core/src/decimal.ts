/**
 * Deterministic fixed-point rounding.
 *
 * Every number that crosses a boundary — into the database, into a response,
 * into a comparison — gets rounded here first. The fill engine has to be able to
 * reconstruct a price from a stored snapshot months later and land on the same
 * digits, so "close enough" floating point is not close enough.
 *
 * Precision contract (matches the SQL column types):
 *   price  → cents,   2 dp   numeric(6,2) / numeric(8,4) for averages
 *   qty    → units,   4 dp   numeric(20,4)
 *   money  → dollars, 4 dp   numeric(20,4)
 */

/**
 * Precision is chosen so that `qty x price` is EXACT, not merely close.
 *
 *   qty    2 dp  — the finest size either venue actually quotes
 *                  (Kalshi contracts are integers; Polymarket shares hit 2 dp)
 *   price  4 dp  — cents to 2 dp, with headroom for weighted averages
 *   money  6 dp  — micro-dollars, matching USDC's own 6 decimals
 *
 * qty(2) x cents(2) / 100 lands in exactly 6 decimal places, so the fill
 * invariant `cost == sum(qty x price)` holds with no residue at all. Widening
 * qty past 2 dp would break that, which is why it is pinned here.
 */
export const PRICE_DP = 4;
export const QTY_DP = 2;
export const MONEY_DP = 6;

/**
 * Multiply `value` by 10^exp without ever going through float multiplication.
 *
 * Naively writing `Number(\`${value}e${exp}\`)` breaks the moment a number's
 * own toString is already exponential: `${1e-7}` is "1e-7", so appending "e8"
 * produces the string "1e-7e8", which parses to NaN. Small Brier scores land
 * there constantly, so this splits off any existing exponent and adds to it.
 */
function shiftExponent(value: number, exp: number): number {
  if (value === 0 || !Number.isFinite(value)) return value;
  const [mantissa, existing] = `${value}`.split('e');
  const nextExp = (existing ? Number(existing) : 0) + exp;
  return Number(`${mantissa}e${nextExp}`);
}

/**
 * Round half-away-from-zero at `dp` decimal places.
 *
 * `Math.round(x * 10 ** dp)` alone is wrong when the float representation lands
 * just below a .5 boundary (the classic 1.005 case). Shifting through the
 * decimal string repairs that before rounding.
 */
export function roundTo(value: number, dp: number): number {
  if (!Number.isFinite(value)) return 0;
  const scaled = shiftExponent(value, dp);
  if (!Number.isFinite(scaled)) return 0;
  const rounded = Math.sign(scaled) * Math.round(Math.abs(scaled));
  const out = shiftExponent(rounded, -dp);
  // Normalize -0 to 0 so equality checks and DB writes stay boring.
  return !Number.isFinite(out) || out === 0 ? 0 : out;
}

export const roundPrice = (v: number): number => roundTo(v, PRICE_DP);
export const roundQty = (v: number): number => roundTo(v, QTY_DP);
export const roundMoney = (v: number): number => roundTo(v, MONEY_DP);

/**
 * Round toward zero at `dp` places.
 *
 * The fill engine floors quantities rather than rounding them: a dollar budget
 * is a ceiling the user set, and rounding a partial unit up would spend money
 * they did not offer. Taking 0.01 fewer shares is always the safe direction.
 */
export function floorTo(value: number, dp: number): number {
  if (!Number.isFinite(value)) return 0;
  const scaled = shiftExponent(value, dp);
  if (!Number.isFinite(scaled)) return 0;
  const truncated = Math.sign(scaled) * Math.floor(Math.abs(scaled));
  const out = shiftExponent(truncated, -dp);
  return !Number.isFinite(out) || out === 0 ? 0 : out;
}

export const floorQty = (v: number): number => floorTo(v, QTY_DP);

/** Round up to the next whole cent. Used by fee models that ceil. */
export function ceilCents(dollars: number): number {
  return roundMoney(Math.ceil(roundTo(dollars * 100, 6)) / 100);
}

/** Clamp into [min, max]. */
export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/**
 * Snap a price to a tick grid. Prediction market ticks are 1c, 0.1c, or similar,
 * so this works in scaled integers to avoid 0.1 + 0.2 drift.
 */
export function snapToTick(priceCents: number, tickCents: number, mode: 'nearest' | 'down' | 'up' = 'nearest'): number {
  if (!(tickCents > 0)) return roundPrice(priceCents);
  const scale = 10 ** PRICE_DP;
  const p = Math.round(priceCents * scale);
  const t = Math.round(tickCents * scale);
  if (t <= 0) return roundPrice(priceCents);
  const q = p / t;
  const snapped = mode === 'down' ? Math.floor(q) : mode === 'up' ? Math.ceil(q) : Math.round(q);
  return roundPrice((snapped * t) / scale);
}

/** True when `priceCents` sits exactly on the tick grid. */
export function isOnTick(priceCents: number, tickCents: number): boolean {
  if (!(tickCents > 0)) return true;
  const scale = 10 ** PRICE_DP;
  const p = Math.round(priceCents * scale);
  const t = Math.round(tickCents * scale);
  return t > 0 && p % t === 0;
}
