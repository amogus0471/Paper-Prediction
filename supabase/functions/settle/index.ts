// settle — close out resolved markets and write the calibration corpus.
//
// This is where the loop closes. A position that never settles never becomes a
// forecast that can be scored, so this job is the difference between a P&L toy
// and a calibration product.
//
// Voids refund cost basis and are deliberately excluded from calibration: a
// market that never resolved is not a forecast you got wrong.

import { handler, json, requireCronSecret } from '../_shared/api.ts';
import { createAdapters } from '../_shared/polyfill.js';

Deno.serve(
  handler('settle', async (req, body, db) => {
    requireCronSecret(req);
    const started = Date.now();
    const limit = Number(body.limit ?? 100);

    const { data: run } = await db
      .from('ingest_runs')
      .insert({ job: 'settle' })
      .select('id')
      .single();

    let closed = 0;
    let resolved = 0;
    let settledPositions = 0;
    let errors = 0;

    try {
      // 1. Markets past their close time move to 'resolving'.
      const { data: justClosed } = await db
        .from('markets')
        .update({ status: 'resolving' })
        .eq('status', 'open')
        .lt('close_time', new Date().toISOString())
        .select('id');
      closed = justClosed?.length ?? 0;

      // 2. Ask each venue whether the resolving markets have settled yet.
      const { data: resolving } = await db
        .from('markets')
        .select('id, venue, venue_market_id, event_id, events(category)')
        .eq('status', 'resolving')
        .limit(limit);

      if (resolving && resolving.length > 0) {
        const adapters = createAdapters();
        const byVenue = new Map<string, typeof resolving>();
        for (const m of resolving) {
          const list = byVenue.get(m.venue) ?? [];
          list.push(m);
          byVenue.set(m.venue, list);
        }

        for (const [venue, markets] of byVenue) {
          const adapter = adapters[venue as 'polymarket' | 'kalshi'];
          if (!adapter) continue;

          let resolutions;
          try {
            resolutions = await adapter.getResolutions(markets.map((m) => m.venue_market_id));
          } catch {
            errors++;
            continue;
          }

          for (const r of resolutions) {
            const market = markets.find((m) => m.venue_market_id === r.venueMarketId);
            if (!market) continue;
            if (r.status !== 'resolved' && r.status !== 'cancelled') continue;

            const isVoid = r.resolution == null;

            await db
              .from('markets')
              .update({
                status: isVoid ? 'cancelled' : 'resolved',
                resolution: r.resolution,
                resolved_at: (r.resolvedAt ?? new Date()).toISOString(),
                resolution_note: isVoid ? 'Voided by venue - excluded from calibration' : null,
              })
              .eq('id', market.id);
            resolved++;

            // 3. Settle every open position on the market.
            const { data: positions } = await db
              .from('positions')
              .select('id')
              .eq('market_id', market.id)
              .eq('is_open', true);

            const category =
              (market.events as { category?: string } | null)?.category ?? 'other';

            for (const p of positions ?? []) {
              const { error } = await db.rpc('settle_position', {
                p_position_id: p.id,
                p_resolution: r.resolution,
                p_category: category,
              });
              if (error) errors++;
              else settledPositions++;
            }

            // 4. Cancel anything still resting on a market that no longer exists.
            await db
              .from('orders')
              .update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
              .eq('market_id', market.id)
              .in('status', ['open', 'partial', 'pending']);
          }
        }
      }
    } finally {
      if (run?.id) {
        await db
          .from('ingest_runs')
          .update({
            finished_at: new Date().toISOString(),
            duration_ms: Date.now() - started,
            rows_written: settledPositions,
            errors,
            detail: { closed, resolved, settled_positions: settledPositions },
          })
          .eq('id', run.id);
      }
    }

    // 5. The nightly assertion, run every time: every portfolio's cash balance
    // must equal the sum of its ledger. A non-empty result is a real incident.
    const { data: drift } = await db.rpc('check_ledger_integrity');
    if (drift && drift.length > 0) {
      console.error(
        JSON.stringify({ fn: 'settle', outcome: 'ledger_drift', portfolios: drift.length, drift }),
      );
    }

    return json({
      ok: true,
      closed,
      resolved,
      settled_positions: settledPositions,
      errors,
      ledger_drift: drift?.length ?? 0,
      duration_ms: Date.now() - started,
    });
  }),
);
