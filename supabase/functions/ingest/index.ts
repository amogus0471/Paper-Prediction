// ingest — pull live markets and books from the venues.
//
// Two modes, both idempotent:
//   POST {mode:"markets"} — crawl events/markets, upsert metadata
//   POST {mode:"books"}   — snapshot order books for hot/warm markets
//
// A market goes HOT the moment anyone opens it or holds a position in it, so
// the books mode always prioritises tiers before volume.

import { ApiError, handler, json, requireCronSecret } from '../_shared/api.ts';
import { checkBookInvariants, createAdapters, midPrice } from '../_shared/ghostfill.js';

const VENUES = ['kalshi', 'polymarket'] as const;

Deno.serve(
  handler('ingest', async (req, body, db) => {
    requireCronSecret(req);
    const mode = String(body.mode ?? 'markets');
    const started = Date.now();

    const { data: run } = await db
      .from('ingest_runs')
      .insert({ job: `ingest-${mode}` })
      .select('id')
      .single();

    let written = 0;
    let errors = 0;
    const detail: Record<string, unknown> = {};

    try {
      if (mode === 'markets') {
        const res = await ingestMarkets(db, body);
        written = res.written;
        errors = res.errors;
        Object.assign(detail, res.detail);
      } else if (mode === 'books') {
        const res = await ingestBooks(db, body);
        written = res.written;
        errors = res.errors;
        Object.assign(detail, res.detail);
      } else {
        throw new ApiError('bad_request', 'mode must be "markets" or "books".', 400);
      }
    } finally {
      if (run?.id) {
        await db
          .from('ingest_runs')
          .update({
            finished_at: new Date().toISOString(),
            duration_ms: Date.now() - started,
            rows_written: written,
            errors,
            detail,
          })
          .eq('id', run.id);
      }
    }

    return json({ ok: true, mode, written, errors, duration_ms: Date.now() - started, detail });
  }),
);

async function ingestMarkets(
  db: ReturnType<typeof import('../_shared/api.ts').admin>,
  body: Record<string, unknown>,
) {
  const adapters = createAdapters();
  const pages = Number(body.pages ?? 3);
  const only = body.venue ? [String(body.venue)] : [...VENUES];

  let written = 0;
  let errors = 0;
  const detail: Record<string, unknown> = {};

  for (const code of only) {
    const adapter = adapters[code as 'polymarket' | 'kalshi'];
    if (!adapter) continue;

    let cursor: string | undefined;
    let venueMarkets = 0;

    for (let page = 0; page < pages; page++) {
      let events;
      try {
        const res = await adapter.listEvents(cursor, 100);
        events = res.events;
        cursor = res.next;
      } catch (e) {
        errors++;
        detail[`${code}_error`] = String(e);
        break;
      }

      for (const ev of events) {
        const { data: eventRow, error: eErr } = await db
          .from('events')
          .upsert(
            {
              venue: ev.venue,
              venue_event_id: ev.venueEventId,
              series_key: ev.seriesKey ?? null,
              title: ev.title,
              slug: ev.slug ?? null,
              description: ev.description ?? null,
              category: ev.category,
              subcategory: ev.subcategory ?? null,
              image_url: ev.imageUrl ?? null,
              open_time: ev.openTime ?? null,
              close_time: ev.closeTime ?? null,
              is_active: ev.isActive,
              synced_at: new Date().toISOString(),
            },
            { onConflict: 'venue,venue_event_id' },
          )
          .select('id')
          .single();

        if (eErr || !eventRow) {
          errors++;
          continue;
        }

        const rows = ev.markets.map((m) => ({
          event_id: eventRow.id,
          venue: m.venue,
          venue_market_id: m.venueMarketId,
          question: m.question,
          slug: m.slug ?? null,
          yes_label: m.yesLabel,
          no_label: m.noLabel,
          resolution_source: m.resolutionSource ?? null,
          resolution_rules: m.resolutionRules ?? null,
          status: m.status,
          yes_bid: m.yesBid ?? null,
          yes_ask: m.yesAsk ?? null,
          no_bid: m.noBid ?? null,
          no_ask: m.noAsk ?? null,
          last_price: m.lastPrice ?? null,
          mid_price: m.midPrice ?? null,
          price_24h_ago: m.price24hAgo ?? null,
          volume_24h: m.volume24h ?? 0,
          volume_total: m.volumeTotal ?? 0,
          open_interest: m.openInterest ?? 0,
          liquidity: m.liquidity ?? 0,
          tick_cents: m.tickCents,
          min_order_size: m.minOrderSize,
          book_ref: m.bookRef,
          open_time: m.openTime ?? null,
          close_time: m.closeTime ?? null,
          resolved_at: m.resolvedAt ?? null,
          resolution: m.resolution ?? null,
          meta_updated_at: new Date().toISOString(),
        }));

        if (rows.length === 0) continue;

        const { error: mErr } = await db
          .from('markets')
          .upsert(rows, { onConflict: 'venue,venue_market_id' });

        if (mErr) errors++;
        else {
          written += rows.length;
          venueMarkets += rows.length;
        }
      }

      if (!cursor) break;
    }

    detail[`${code}_markets`] = venueMarkets;
  }

  // Retier so the top markets by volume stay warm enough to quote from
  // without anyone having to open them first.
  const { data: tiers } = await db.rpc('retier_markets', { p_warm_count: 250 });
  if (tiers) detail.tiers = tiers;

  return { written, errors, detail };
}

async function ingestBooks(
  db: ReturnType<typeof import('../_shared/api.ts').admin>,
  body: Record<string, unknown>,
) {
  const adapters = createAdapters();
  const limit = Number(body.limit ?? 40);
  const tiers = body.tier ? [String(body.tier)] : ['hot', 'warm'];

  let query = db
    .from('markets')
    .select('id, venue, venue_market_id, book_ref, data_tier, volume_24h')
    .eq('status', 'open')
    .order('volume_24h', { ascending: false })
    .limit(limit);

  if (body.market_id) {
    query = db
      .from('markets')
      .select('id, venue, venue_market_id, book_ref, data_tier, volume_24h')
      .eq('id', String(body.market_id));
  } else {
    query = query.in('data_tier', tiers);
  }

  const { data: markets, error } = await query;
  if (error) throw new ApiError('market_read_failed', error.message, 500);
  if (!markets || markets.length === 0) return { written: 0, errors: 0, detail: { markets: 0 } };

  let written = 0;
  let errors = 0;
  let invariantViolations = 0;

  // Modest concurrency: the venue read budgets are shared across every consumer
  // of those APIs, so a wide fan-out costs everyone their books.
  const BATCH = 6;
  for (let i = 0; i < markets.length; i += BATCH) {
    const batch = markets.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map(async (m) => {
        const adapter = adapters[m.venue as 'polymarket' | 'kalshi'];
        if (!adapter) return null;
        try {
          return { m, book: await adapter.getOrderBook(m.book_ref) };
        } catch {
          return null;
        }
      }),
    );

    const snapshots = [];
    const now = new Date().toISOString();

    for (const r of results) {
      if (!r) {
        errors++;
        continue;
      }
      const inv = checkBookInvariants(r.book.yes, r.book.no);
      if (!inv.ok) {
        invariantViolations++;
        // Store it anyway — a violating snapshot is evidence — but flag it so
        // the quote path refuses to price from it.
        console.error(
          JSON.stringify({
            fn: 'ingest',
            outcome: 'invariant_violation',
            market_id: r.m.id,
            venue: r.m.venue,
            violations: inv.violations,
          }),
        );
      }

      const yesMid = midPrice(r.book.yes);
      snapshots.push({
        market_id: r.m.id,
        captured_at: now,
        yes_bids: r.book.yes.bids,
        yes_asks: r.book.yes.asks,
        no_bids: r.book.no.bids,
        no_asks: r.book.no.asks,
        yes_mid: yesMid,
        invariant_ok: inv.ok,
      });

      // Keep the market row's quoted top-of-book in step with the real book.
      // Venue metadata lags — verified live on Polymarket, where Gamma's
      // bestBid trailed the CLOB by several cents — so the book wins.
      await db
        .from('markets')
        .update({
          yes_bid: r.book.yes.bids[0]?.[0] ?? null,
          yes_ask: r.book.yes.asks[0]?.[0] ?? null,
          no_bid: r.book.no.bids[0]?.[0] ?? null,
          no_ask: r.book.no.asks[0]?.[0] ?? null,
          mid_price: yesMid,
          book_updated_at: now,
        })
        .eq('id', r.m.id);

      if (yesMid != null) {
        await db.rpc('mark_positions', { p_market_id: r.m.id, p_yes_mid: yesMid });
      }
    }

    if (snapshots.length > 0) {
      const { error: sErr } = await db.from('book_snapshots').insert(snapshots);
      if (sErr) errors++;
      else written += snapshots.length;
    }
  }

  return {
    written,
    errors,
    detail: { markets: markets.length, invariant_violations: invariantViolations },
  };
}
