import { useCallback, useEffect, useState } from 'react';
import { formatSignedSimDollars, formatScore } from '@polyfill/core';
import {
  disableCompete,
  enableCompete,
  fetchLeaderboard,
  verifyLocalChain,
  type Eligibility,
  type LeaderboardRow,
  type LeaderboardWindow,
} from '../lib/compete';
import type { LocalState } from '../lib/store';

/**
 * The ladder.
 *
 * Top three on a podium, everyone else in a ranked table below. First place is
 * raised above second and third so the hierarchy reads before any number does.
 */
export function Leaderboard({ state, onChange }: { state: LocalState; onChange: () => void }) {
  const [rows, setRows] = useState<LeaderboardRow[] | null>(null);
  const [you, setYou] = useState<LeaderboardRow | null>(null);
  const [window, setWindow] = useState<LeaderboardWindow>('7d');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [eligibility, setEligibility] = useState<Eligibility | null>(null);

  const optedIn = state.settings.competeOptIn;
  const deviceKey = state.settings.deviceKey;

  const load = useCallback(async () => {
    if (!optedIn || !deviceKey) return;
    try {
      const res = await fetchLeaderboard(deviceKey, window);
      setRows(res.rows);
      setYou(res.you);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [optedIn, deviceKey, window]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!optedIn) {
    return <OptIn onDone={onChange} setEligibility={setEligibility} />;
  }

  return (
    <>
      <div className="lbHead">
        <h2>Ladder</h2>
        <div className="segmented" role="tablist">
          {(['24h', '7d', '30d'] as LeaderboardWindow[]).map((w) => (
            <button key={w} role="tab" aria-selected={window === w} onClick={() => setWindow(w)}>
              {w === '24h' ? '24H' : w === '7d' ? '7 Days' : '30 Days'}
            </button>
          ))}
        </div>
      </div>

      {eligibility && !eligibility.eligible && <EligibilityCard e={eligibility} />}
      {error && <div className="empty">{error}</div>}

      {rows == null && !error && <div className="empty">Loading standings…</div>}

      {rows != null && rows.length === 0 && (
        <div className="empty">
          No ranked traders yet.
          <br />
          <br />
          A place on the ladder needs 10 trades across 5 markets and 2 categories, on an account at
          least 72 hours old — and a ledger chain that verifies. Be the first.
        </div>
      )}

      {rows != null && rows.length > 0 && (
        <>
          <Podium rows={rows.slice(0, 3)} />
          {rows.length > 3 && (
            <div className="table">
              <div className="thead">
                <span>Rank</span>
                <span>Trader</span>
                <span className="right">P&amp;L</span>
              </div>
              {rows.slice(3).map((r) => (
                <Row key={r.handle} r={r} />
              ))}
            </div>
          )}
          {you && you.rank > 3 && (
            <div className="youPin">
              <div className="thead" style={{ border: 0 }}>
                <span>Your rank</span>
                <span />
                <span />
              </div>
              <Row r={you} />
            </div>
          )}
        </>
      )}

      <ChainStatus />

      <div className="card">
        <h3>Leaving the ladder</h3>
        <div className="note" style={{ marginBottom: 9 }}>
          Turning this off stops sending anything to the server. Your device key is kept, so you can
          rejoin with the same identity and history.
        </div>
        <button
          className="action"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await disableCompete();
            onChange();
            setBusy(false);
          }}
        >
          Stop competing
        </button>
      </div>
    </>
  );
}

/** Top three, first place raised. */
function Podium({ rows }: { rows: LeaderboardRow[] }) {
  const [first, second, third] = rows;
  // Visual order puts 2nd on the left and 3rd on the right, flanking 1st.
  const slots: [LeaderboardRow | undefined, 1 | 2 | 3][] = [
    [second, 2],
    [first, 1],
    [third, 3],
  ];

  return (
    <div className="podium">
      {slots.map(([r, place]) =>
        r ? (
          <div key={place} className={`plinth p${place} ${r.isYou ? 'you' : ''}`}>
            <div className="place">
              {place === 1 ? '1st' : place === 2 ? '2nd' : '3rd'}
            </div>
            <div className="pnl num">{formatSignedSimDollars(r.pnl, 2)}</div>
            <div className="pnlLabel">P&amp;L</div>
            <div className="who">
              <Avatar seed={r.avatar_seed ?? r.handle} />
              <span>{r.display_name || r.handle}</span>
            </div>
            {r.brier_skill != null && (
              <div className="bssTag" title="Brier Skill Score vs the market price">
                BSS {formatScore(r.brier_skill)}
              </div>
            )}
          </div>
        ) : (
          <div key={place} className={`plinth p${place} ghosted`} />
        ),
      )}
    </div>
  );
}

function Row({ r }: { r: LeaderboardRow }) {
  return (
    <div className={`trow ${r.isYou ? 'you' : ''}`}>
      <span className="rank num">#{r.rank}</span>
      <span className="who">
        <Avatar seed={r.avatar_seed ?? r.handle} />
        <span className="nm">{r.display_name || r.handle}</span>
        {r.isYou && <span className="tag">you</span>}
      </span>
      <span className={`right num ${r.pnl >= 0 ? 'up' : 'down'}`}>
        {formatSignedSimDollars(r.pnl, 2)}
      </span>
    </div>
  );
}

/**
 * Deterministic identicon from the handle.
 *
 * No uploads, no image hosting, no moderation surface — and it cannot leak
 * anything, because the only input is a name that is already public.
 */
function Avatar({ seed }: { seed: string }) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return (
    <span
      className="avatar"
      aria-hidden="true"
      style={{
        background: `linear-gradient(135deg, hsl(${hue} 62% 52%), hsl(${(hue + 48) % 360} 62% 40%))`,
      }}
    >
      {seed.slice(0, 1).toUpperCase()}
    </span>
  );
}

function EligibilityCard({ e }: { e: Eligibility }) {
  const items: [string, string, boolean][] = [
    ['Account age', `${Math.floor(e.progress.account_age_hours)}h / 72h`, e.progress.account_age_hours >= 72],
    ['Trades', `${e.progress.trades} / 10`, e.progress.trades >= 10],
    ['Markets', `${e.progress.markets} / 5`, e.progress.markets >= 5],
    ['Categories', `${e.progress.categories} / 2`, e.progress.categories >= 2],
  ];
  return (
    <div className="card">
      <h3>Not ranked yet</h3>
      {items.map(([k, v, ok]) => (
        <div className="row" key={k}>
          <span className="k">
            {ok ? '✓' : '○'} {k}
          </span>
          <span className={`num ${ok ? 'up' : ''}`}>{v}</span>
        </div>
      ))}
      <div className="note">
        These gates exist because minting a fresh account is free. Making a fake identity earn its
        way onto the ladder is what stops someone scripting 500 of them.
        {e.progress.instant_trades_excluded > 0 && (
          <>
            {' '}
            {e.progress.instant_trades_excluded} Instant-mode trade
            {e.progress.instant_trades_excluded === 1 ? '' : 's'} don&apos;t count — Instant never scores.
          </>
        )}
      </div>
    </div>
  );
}

/** Local tamper-evidence readout. Honest about what it does and doesn't prove. */
function ChainStatus() {
  const [v, setV] = useState<{ ok: boolean; length: number; brokenAt: number; reason?: string } | null>(
    null,
  );
  useEffect(() => {
    void verifyLocalChain().then(setV).catch(() => undefined);
  }, []);
  if (!v) return null;

  return (
    <div className="card" style={{ borderLeftColor: v.ok ? 'var(--yes)' : 'var(--no)' }}>
      <h3>Ledger chain</h3>
      <div className="row">
        <span className="k">{v.ok ? 'Verified' : 'BROKEN'}</span>
        <span className="num">{v.length} entries</span>
      </div>
      <div className="note">
        {v.ok
          ? 'Every entry commits to the hash of the one before it, so no trade can be edited, reordered or removed after the fact without breaking the chain. Ladder standings are chain-verified server-side before they rank.'
          : `Broken at entry ${v.brokenAt}: ${v.reason}`}
      </div>
    </div>
  );
}

/** Plain-language opt-in. Not a toggle — this one deserves a screen. */
function OptIn({
  onDone,
  setEligibility,
}: {
  onDone: () => void;
  setEligibility: (e: Eligibility) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  return (
    <>
      <div className="card">
        <h3>Compete on the ladder</h3>
        <div className="note" style={{ fontSize: 12, color: 'var(--text)', marginBottom: 10 }}>
          Solo play is entirely local — nothing you do leaves this browser. The ladder is the one
          feature that needs a server, because a leaderboard where the client reports its own P&amp;L
          is worth nothing.
        </div>

        <h3 style={{ marginTop: 12 }}>What gets sent</h3>
        <div className="row"><span className="k">✓ Which market, side and size</span></div>
        <div className="row"><span className="k">✓ Fills the server priced itself</span></div>
        <div className="row"><span className="k">✗ No email, password, or name</span></div>
        <div className="row"><span className="k">✗ No browsing history</span></div>
        <div className="row"><span className="k">✗ No prices or P&amp;L from your device</span></div>

        <div className="note" style={{ marginTop: 10 }}>
          Your orders are priced <em>on the server</em>, from a stored order book snapshot, and
          written into a hash chain the server controls. That is what makes the standings mean
          something — and it means fake numbers cannot be typed in from this side.
        </div>
      </div>

      <div className="card" style={{ borderLeftColor: 'var(--warn)' }}>
        <h3>Read this before you opt in</h3>
        <div className="note">
          You get an anonymous handle and a random device key. That key <strong>is</strong> your
          identity — there is no password reset and no email to recover from. Clearing extension
          storage or moving to a new browser loses your ladder history unless you copy the key
          first. Settings → Show device key lets you save it.
        </div>
      </div>

      {err && <div className="empty" style={{ color: 'var(--no)' }}>{err}</div>}

      <button
        className="action primary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setErr(null);
          try {
            const p = await enableCompete();
            setEligibility(p.eligibility);
            onDone();
          } catch (e) {
            setErr((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? 'Creating your handle…' : 'Opt in and create my handle'}
      </button>
      <div className="note" style={{ textAlign: 'center', marginTop: 8 }}>
        Still no email. Still no password.
      </div>
    </>
  );
}
