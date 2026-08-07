/**
 * Leaderboard client — the ONLY code that talks to our backend.
 *
 * Solo play never reaches any of this. Opting in is what turns a purely local
 * app into one with a server-side identity, so the boundary is a single file
 * you can read end to end to see exactly what leaves the device.
 *
 * What leaves: order intent (which market, which side, how much), and nothing
 * else. Not a price, not a P&L, not a position. The server prices every fill
 * itself from a stored order book snapshot and appends its own hash-chain link,
 * which is the whole reason its numbers are worth ranking.
 */

import { verifyChain, type ChainLink } from '@polyfill/core';
import type { MarketMeta } from './engine';
import { mutate, loadState } from './store';

const SUPABASE_URL = 'https://cohfsfxnfuqymvbsjtwa.supabase.co';
/** Publishable anon key. Safe to ship: RLS denies it every trading table. */
const ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNvaGZzZnhuZnVxeW12YnNqdHdhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYwNDY0MDQsImV4cCI6MjEwMTYyMjQwNH0.kGwlszE7f_64KkWHndrZbLYELadIgTNyEvU9p8Ez2-o';

const FN = `${SUPABASE_URL}/functions/v1`;

/**
 * Generate a device key.
 *
 * 32 random bytes, base64url. This is the user's entire leaderboard identity —
 * there is no password to reset and no email to recover from, which is the
 * price of not asking for either. Settings lets them reveal and copy it.
 */
export function generateDeviceKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export class CompeteError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
  }
}

async function call<T>(path: string, body: Record<string, unknown>, deviceKey: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${FN}/${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        apikey: ANON_KEY,
        authorization: `Bearer ${ANON_KEY}`,
        'x-device-key': deviceKey,
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new CompeteError('offline', 'Could not reach the leaderboard.', String(e));
  }

  const json = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    data?: T;
    error?: string;
    message?: string;
    detail?: string;
  };

  if (!res.ok || json.ok === false) {
    throw new CompeteError(
      json.error ?? `http_${res.status}`,
      json.message ?? 'Leaderboard request failed.',
      json.detail,
    );
  }
  return (json.data ?? json) as T;
}

export interface EligibilityProgress {
  account_age_hours: number;
  trades: number;
  markets: number;
  categories: number;
  instant_trades_excluded: number;
}

export interface Eligibility {
  eligible: boolean;
  missing: string[];
  progress: EligibilityProgress;
}

export interface CompeteProfile {
  user_id: string;
  handle: string;
  display_name: string;
  created: boolean;
  eligibility: Eligibility;
}

/** Create-or-fetch the server profile. Idempotent: same key, same profile. */
export async function bootstrap(deviceKey: string): Promise<CompeteProfile> {
  return call<CompeteProfile>('bootstrap', {}, deviceKey);
}

export interface LeaderboardRow {
  rank: number;
  handle: string;
  display_name: string;
  avatar_seed: string | null;
  pnl: number;
  return_pct: number | null;
  trades: number;
  brier_skill: number | null;
  chain_head: string | null;
  chain_length: number;
  /** Set by the client when the row is the signed-in user. */
  isYou?: boolean;
}

export type LeaderboardWindow = '24h' | '7d' | '30d';

export async function fetchLeaderboard(
  deviceKey: string,
  window: LeaderboardWindow = '7d',
): Promise<{ rows: LeaderboardRow[]; you: LeaderboardRow | null }> {
  return call<{ rows: LeaderboardRow[]; you: LeaderboardRow | null }>(
    'leaderboard',
    { window },
    deviceKey,
  );
}

/** Server-priced quote. Note what we send: intent only. */
export async function competeQuote(
  deviceKey: string,
  meta: MarketMeta,
  side: 'buy' | 'sell',
  outcome: 'yes' | 'no',
  notional: number,
) {
  return call<{ quote_id: string; avg_price: number; qty: number; cost: number; fee: number }>(
    'quote',
    { market: meta, side, outcome, notional },
    deviceKey,
  );
}

export async function competeSubmit(deviceKey: string, quoteId: string, idempotencyKey: string) {
  return call<{ order_id: string; status: string; chain: { seq: number; hash: string } }>(
    'order-submit',
    { quote_id: quoteId, idempotency_key: idempotencyKey },
    deviceKey,
  );
}

/**
 * Verify the LOCAL chain and report where it broke.
 *
 * Purely tamper-evidence for the user's own benefit — it proves the local
 * record was not edited outside the app, and proves nothing to anyone else.
 * Leaderboard trust comes from the server minting its own links.
 */
export async function verifyLocalChain(): Promise<{
  ok: boolean;
  length: number;
  brokenAt: number;
  reason?: string;
}> {
  const state = await loadState();
  const links = (state.chain ?? []) as ChainLink[];
  const verdict = await verifyChain(links);
  return {
    ok: verdict.ok,
    length: verdict.length,
    brokenAt: verdict.brokenAt,
    ...(verdict.reason ? { reason: verdict.reason } : {}),
  };
}

/** Turn competing on: mint a key if needed, create the profile, store the handle. */
export async function enableCompete(): Promise<CompeteProfile> {
  const state = await loadState();
  const key = state.settings.deviceKey ?? generateDeviceKey();

  const profile = await bootstrap(key);

  await mutate((s) => {
    s.settings.deviceKey = key;
    s.settings.handle = profile.handle;
    s.settings.competeOptIn = true;
  });

  return profile;
}

/**
 * Turn it off. Deliberately keeps the device key: losing it is irreversible,
 * and someone toggling a switch off has not asked to destroy their ladder
 * history. Settings has a separate, explicit control for forgetting it.
 */
export async function disableCompete(): Promise<void> {
  await mutate((s) => {
    s.settings.competeOptIn = false;
  });
}
