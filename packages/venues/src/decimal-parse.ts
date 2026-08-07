/**
 * Exact decimal-string parsing for venue payloads.
 *
 * Both venues send prices as decimal STRINGS ("0.1500", "0.13"). The tempting
 * move is `parseFloat(s) * 100`, which is how you end up with a 14.999999999
 * cent price that fails a tick check and mis-prices a fill. These parse the
 * digits directly instead, so "0.1500" becomes exactly 15 and nothing drifts.
 */

/** Cents are carried to 2 dp — enough for a deci-cent tick with room to spare. */
const CENTS_DP = 2;
const CENTS_SCALE = 10 ** CENTS_DP;

/**
 * `"0.1500"` -> `15`, `"0.075"` -> `7.5`, `"1"` -> `100`.
 * Returns null for anything that is not a finite non-negative decimal.
 */
export function dollarsStringToCents(input: string | number | null | undefined): number | null {
  if (input == null) return null;
  const s = String(input).trim();
  if (!/^[+-]?\d*\.?\d+(?:[eE][+-]?\d+)?$/.test(s)) return null;

  // Exponential notation is rare here but cheap to support correctly.
  if (/[eE]/.test(s)) {
    const v = Number(s);
    if (!Number.isFinite(v)) return null;
    return Math.round(v * 100 * CENTS_SCALE) / CENTS_SCALE;
  }

  const negative = s.startsWith('-');
  const body = s.replace(/^[+-]/, '');
  const [wholeRaw, fracRaw = ''] = body.split('.');
  const whole = wholeRaw || '0';

  // Dollars -> cents is a two-place shift, so take two extra digits of the
  // fraction beyond the cent precision we keep, then round the remainder.
  const keep = 2 + CENTS_DP;
  const frac = fracRaw.padEnd(keep + 1, '0');
  const kept = frac.slice(0, keep);
  const nextDigit = Number(frac[keep] ?? '0');

  let scaledCents = Number(whole) * 100 * CENTS_SCALE + Number(kept || '0');
  if (nextDigit >= 5) scaledCents += 1;

  const cents = scaledCents / CENTS_SCALE;
  return negative ? -cents : cents;
}

/** Sizes are plain decimal counts. Kept at 2 dp to match the core qty precision. */
export function sizeStringToQty(input: string | number | null | undefined): number | null {
  if (input == null) return null;
  const s = String(input).trim();
  if (!/^[+-]?\d*\.?\d+(?:[eE][+-]?\d+)?$/.test(s)) return null;
  const v = Number(s);
  if (!Number.isFinite(v)) return null;
  return Math.round(v * 100) / 100;
}

/** Tolerant numeric read for venue metadata fields that may be string or number. */
export function num(input: unknown): number | undefined {
  if (typeof input === 'number') return Number.isFinite(input) ? input : undefined;
  if (typeof input === 'string' && input.trim() !== '') {
    const v = Number(input);
    return Number.isFinite(v) ? v : undefined;
  }
  return undefined;
}

/** Polymarket ships arrays as JSON strings inside JSON. Unwrap either shape. */
export function parseJsonArray(input: unknown): string[] {
  if (Array.isArray(input)) return input.map((v) => String(v));
  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input);
      return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
    } catch {
      return [];
    }
  }
  return [];
}

export function parseDate(input: unknown): Date | undefined {
  if (!input) return undefined;
  const d = new Date(String(input));
  return Number.isNaN(d.getTime()) ? undefined : d;
}
