import { VenueError } from './types';
import type { VenueCode } from './types';

export interface FetchOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Retries on 429 and 5xx only. 4xx means we asked wrong; retrying won't help. */
  retries?: number;
}

/**
 * One HTTP path for every venue call, so rate limiting, timeouts and backoff
 * are handled once rather than per-adapter.
 *
 * On 429 the caller is expected to demote the market's data tier rather than
 * hammer harder — dropping to a slower poll is always better than getting the
 * whole IP blocked and losing every book at once.
 */
export async function venueFetch<T>(
  venue: VenueCode,
  url: string,
  opts: FetchOptions = {},
): Promise<T> {
  const { method = 'GET', body, headers = {}, timeoutMs = 15000, retries = 2 } = opts;

  let lastError: VenueError | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers: {
          accept: 'application/json',
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...headers,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const err = new VenueError(venue, res.status, `${res.status} ${text.slice(0, 200)}`, url);
        if (!err.retryable || attempt === retries) throw err;
        lastError = err;
        await backoff(attempt, res.headers.get('retry-after'));
        continue;
      }

      return (await res.json()) as T;
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

  throw lastError ?? new VenueError(venue, 0, 'exhausted retries', url);
}

/** Exponential backoff with jitter, respecting Retry-After when the venue sends one. */
async function backoff(attempt: number, retryAfter: string | null): Promise<void> {
  const headerMs = retryAfter ? Number(retryAfter) * 1000 : Number.NaN;
  const base = Number.isFinite(headerMs) ? headerMs : 2 ** attempt * 500;
  const jitter = Math.random() * 250;
  await new Promise((r) => setTimeout(r, Math.min(base + jitter, 10000)));
}

/**
 * Run tasks with bounded concurrency.
 *
 * Polymarket's practical ceiling is roughly 100 CLOB reads/minute before
 * Cloudflare starts refusing, and that budget is global across every consumer
 * of the API — so batched book fetches stay deliberately narrow.
 */
export async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  });

  await Promise.all(workers);
  return results;
}
