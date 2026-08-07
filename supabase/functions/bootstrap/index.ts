// bootstrap — first contact.
//
// No sign-up, no login, no email. The extension generates a random device
// secret on install and calls this once; it gets a handle, a profile and a
// G$10,000 opening balance. Calling it again with the same secret is a no-op
// that returns the same profile.

import { ApiError, handler, json, requireDevice } from '../_shared/api.ts';

Deno.serve(
  handler('bootstrap', async (req, body, db) => {
    const userId = await requireDevice(db, req, body);

    const { data: profile, error: pErr } = await db
      .from('profiles')
      .select(
        'id, handle, display_name, avatar_seed, sim_realism, theme, colorblind_mode, ' +
          'layout_pref, default_order_size, confirm_before_order, is_public, created_at',
      )
      .eq('id', userId)
      .single();
    if (pErr) throw new ApiError('profile_read_failed', pErr.message, 500);

    const { data: portfolio, error: fErr } = await db
      .from('portfolios')
      .select('id, starting_balance, cash_balance, reserved_balance, realized_pnl, unrealized_pnl, equity, peak_equity')
      .eq('user_id', userId)
      .is('season_id', null)
      .single();
    if (fErr) throw new ApiError('portfolio_read_failed', fErr.message, 500);

    const { data: venues } = await db
      .from('venues')
      .select('code, display_name, unit_noun, fee_model')
      .eq('is_enabled', true);

    return json({
      ok: true,
      profile,
      portfolio,
      venues: venues ?? [],
      // Repeated on every response so no surface can render without it.
      disclaimer: 'SIMULATED · NO REAL MONEY',
    });
  }),
);
