// Shared plumbing for every Polyfill Edge Function: CORS, device identity,
// the service_role client, structured logging and typed rejections.

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';

export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-device-key, x-cron-secret',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

export function preflight(req: Request): Response | null {
  return req.method === 'OPTIONS' ? new Response('ok', { headers: CORS }) : null;
}

/** service_role client. Never construct one of these outside an Edge Function. */
export function admin(): SupabaseClient {
  return createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

/**
 * Device identity, no login.
 *
 * The client generates a random secret on first run and keeps it in
 * chrome.storage.local. We never store the secret itself — only its SHA-256 —
 * so a database leak cannot be replayed as somebody's session.
 */
export async function deviceHash(secret: string): Promise<string> {
  const bytes = new TextEncoder().encode(`polyfill:v1:${secret}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    readonly detail?: string,
  ) {
    super(message);
  }
}

/**
 * Hash the caller's IP for rate-limiting purposes.
 *
 * Salted and one-way: we need to count new profiles per network, not to know
 * whose network it is. Without a salt the hash of an IPv4 address is trivially
 * reversible — the whole space is 2^32 and fits in a rainbow table.
 */
async function ipHash(req: Request): Promise<string | null> {
  const raw =
    req.headers.get('cf-connecting-ip') ??
    req.headers.get('x-real-ip') ??
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    null;
  if (!raw) return null;

  const salt = Deno.env.get('IP_HASH_SALT') ?? 'polyfill-default-salt';
  const bytes = new TextEncoder().encode(`${salt}:${raw}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Resolve the caller to a profile id, creating one on first contact.
 *
 * Creation is rate-limited per network (migration 0011); returning a profile
 * that already exists never is, so a shared NAT cannot lock out its users.
 */
export async function requireDevice(
  db: SupabaseClient,
  req: Request,
  body: Record<string, unknown>,
): Promise<string> {
  const secret =
    req.headers.get('x-device-key') ??
    (typeof body.device_key === 'string' ? body.device_key : null);

  if (!secret || secret.length < 32) {
    throw new ApiError('no_device', 'Missing or too-short device key.', 401);
  }

  const hash = await deviceHash(secret);
  const { data, error } = await db.rpc('ensure_profile_guarded', {
    p_device_hash: hash,
    p_ip_hash: await ipHash(req),
  });
  if (error) throw new ApiError('device_failed', error.message, 500);

  const result = data as { ok: boolean; user_id?: string; reason?: string; detail?: string };
  if (!result?.ok) {
    throw new ApiError(
      result?.reason ?? 'device_failed',
      result?.detail ?? 'Could not establish a profile.',
      429,
    );
  }
  return result.user_id!;
}

export async function rateLimit(
  db: SupabaseClient,
  userId: string,
  kind: string,
  limit: number,
  window: string,
): Promise<void> {
  const { data, error } = await db.rpc('check_rate_limit', {
    p_user_id: userId,
    p_kind: kind,
    p_limit: limit,
    p_window: window,
  });
  if (error) throw new ApiError('rate_check_failed', error.message, 500);
  if (data === false) {
    throw new ApiError(
      'rate_limited',
      "Slow down — you're placing orders faster than a human can think.",
      429,
    );
  }
}

/**
 * Guards the cron-only functions.
 *
 * This FAILS CLOSED. The previous version returned early when `CRON_SECRET` was
 * unset, on the theory that it was convenient in dev — which meant a project
 * that had simply never had the env var set left `service_role`-backed
 * functions callable by anyone who found the URL. A missing secret is not
 * permission to skip the check; it is a misconfiguration, and the safe reading
 * of a misconfigured guard is "no".
 */
export function requireCronSecret(req: Request): void {
  const expected = Deno.env.get('CRON_SECRET');
  if (!expected) {
    throw new ApiError(
      'not_configured',
      'This endpoint is disabled until CRON_SECRET is set on the project.',
      503,
    );
  }
  const provided = req.headers.get('x-cron-secret');
  if (!provided || !timingSafeEqual(provided, expected)) {
    throw new ApiError('forbidden', 'Bad cron secret.', 403);
  }
}

/**
 * Constant-time string compare. `!==` on a secret leaks its prefix length
 * through timing; the cost of doing this properly is a few microseconds.
 */
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  // Compare lengths without branching out early.
  let diff = ab.length ^ bb.length;
  const len = Math.max(ab.length, bb.length);
  for (let i = 0; i < len; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

export interface LogFields {
  fn: string;
  user_id?: string;
  market_id?: string;
  duration_ms: number;
  outcome: string;
  error?: string;
  [k: string]: unknown;
}

export function log(fields: LogFields): void {
  console.log(JSON.stringify(fields));
}

/** Wraps a handler with CORS, error mapping and one structured log line. */
export function handler(
  fn: string,
  run: (req: Request, body: Record<string, unknown>, db: SupabaseClient) => Promise<Response>,
): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    const pre = preflight(req);
    if (pre) return pre;

    const started = Date.now();
    const db = admin();
    let body: Record<string, unknown> = {};
    try {
      if (req.method === 'POST') {
        body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      } else {
        body = Object.fromEntries(new URL(req.url).searchParams);
      }

      const res = await run(req, body, db);
      log({ fn, duration_ms: Date.now() - started, outcome: 'ok' });
      return res;
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError('internal', String(e), 500);
      log({
        fn,
        duration_ms: Date.now() - started,
        outcome: 'error',
        error: err.code,
        message: err.message,
      });
      return json(
        { ok: false, error: err.code, message: err.message, detail: err.detail },
        err.status,
      );
    }
  };
}
