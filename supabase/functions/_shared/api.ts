// Shared plumbing for every Ghostfill Edge Function: CORS, device identity,
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
  const bytes = new TextEncoder().encode(`ghostfill:v1:${secret}`);
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

/** Resolve the caller to a profile id, creating one on first contact. */
export async function requireDevice(
  db: SupabaseClient,
  req: Request,
  body: Record<string, unknown>,
): Promise<string> {
  const secret =
    req.headers.get('x-device-key') ??
    (typeof body.device_key === 'string' ? body.device_key : null);

  if (!secret || secret.length < 16) {
    throw new ApiError('no_device', 'Missing device key.', 401);
  }

  const hash = await deviceHash(secret);
  const { data, error } = await db.rpc('ensure_profile', { p_device_hash: hash });
  if (error) throw new ApiError('device_failed', error.message, 500);
  return data as string;
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

/** Guards the cron-only functions, which are otherwise publicly reachable. */
export function requireCronSecret(req: Request): void {
  const expected = Deno.env.get('CRON_SECRET');
  if (!expected) return; // unset in dev; set it before anything is public
  if (req.headers.get('x-cron-secret') !== expected) {
    throw new ApiError('forbidden', 'Bad cron secret.', 403);
  }
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
