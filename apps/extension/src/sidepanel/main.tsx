import { StrictMode, useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  formatCents,
  formatCompact,
  formatCountdown,
  formatGhostDollars,
  formatSignedGhostDollars,
  formatSignedPercent,
  summarizeCalibration,
  coachingVerdict,
  MIN_N_FOR_BSS,
  type CalibrationRecord,
} from '@ghostfill/core';
import { send } from '../lib/messages';
import { playSound } from '../lib/sfx';
import { summarize, checkLedger, type GhostState, type Settings, type StoredPosition } from '../lib/store';
import './styles.css';

type Tab = 'dashboard' | 'positions' | 'history' | 'record' | 'settings';

function App() {
  const [state, setState] = useState<GhostState | null>(null);
  const [tab, setTab] = useState<Tab>('dashboard');
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setState(await send<GhostState>({ type: 'GET_STATE' }));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
    // chrome.storage fires on every write from the worker or the overlay, so
    // the panel stays live without polling.
    const onChange = () => void refresh();
    chrome.storage.local.onChanged.addListener(onChange);
    return () => chrome.storage.local.onChanged.removeListener(onChange);
  }, [refresh]);

  useEffect(() => {
    if (state?.settings.colorblindMode) {
      document.documentElement.dataset.cb = '1';
    } else {
      delete document.documentElement.dataset.cb;
    }
  }, [state?.settings.colorblindMode]);

  if (error) {
    return (
      <div className="app">
        <SimBar />
        <main>
          <div className="empty">
            Could not reach the Ghostfill worker.
            <br />
            <br />
            {error}
          </div>
        </main>
      </div>
    );
  }

  if (!state) {
    return (
      <div className="app">
        <SimBar />
        <main>
          <div className="empty">Loading…</div>
        </main>
      </div>
    );
  }

  const s = summarize(state);

  return (
    <div className="app">
      <SimBar />
      <header>
        <div className="handle">{state.settings.handle ?? 'Local portfolio'} · lifetime</div>
        <div className="equity num">{formatGhostDollars(s.equity)}</div>
        <div className={`delta num ${s.returnPct > 0 ? 'up' : s.returnPct < 0 ? 'down' : 'flat'}`}>
          {formatSignedGhostDollars(s.equity - state.startingBalance)} ({formatSignedPercent(s.returnPct)})
        </div>
      </header>

      <nav role="tablist">
        {(['dashboard', 'positions', 'history', 'record', 'settings'] as Tab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
            {t === 'dashboard' ? 'Book' : t[0]!.toUpperCase() + t.slice(1)}
          </button>
        ))}
      </nav>

      <main>
        {tab === 'dashboard' && <Dashboard state={state} />}
        {tab === 'positions' && <Positions state={state} />}
        {tab === 'history' && <History state={state} />}
        {tab === 'record' && <Record state={state} />}
        {tab === 'settings' && <SettingsView state={state} onChange={refresh} />}
      </main>
    </div>
  );
}

/** Non-dismissible, on every surface that shows a price, position or order. */
function SimBar() {
  return (
    <div className="simbar">
      <span className="simdot" />
      SIMULATED · NO REAL MONEY
    </div>
  );
}

function Dashboard({ state }: { state: GhostState }) {
  const s = summarize(state);
  const ledger = checkLedger(state);

  const curve = useMemo(() => {
    const pts = [...state.transactions].reverse().map((t) => t.balanceAfter);
    return pts.length > 1 ? pts : [state.startingBalance, state.cash];
  }, [state.transactions, state.cash, state.startingBalance]);

  return (
    <>
      <div className="card">
        <h3>Earnings</h3>
        <Sparkline points={curve} />
        <div className="row">
          <span className="k">Realized P&amp;L</span>
          <span className={`num ${s.realized > 0 ? 'up' : s.realized < 0 ? 'down' : ''}`}>
            {formatSignedGhostDollars(s.realized)}
          </span>
        </div>
        <div className="row">
          <span className="k">Unrealized P&amp;L</span>
          <span className={`num ${s.unrealized > 0 ? 'up' : s.unrealized < 0 ? 'down' : ''}`}>
            {formatSignedGhostDollars(s.unrealized)}
          </span>
        </div>
        <div className="row">
          <span className="k">Fees paid</span>
          <span className="num">{formatGhostDollars(s.totalFees)}</span>
        </div>
        <div className="row">
          <span className="k">Peak equity</span>
          <span className="num">{formatGhostDollars(s.peakEquity)}</span>
        </div>
      </div>

      <div className="grid2" style={{ marginBottom: 8 }}>
        <div className="stat">
          <div className="k">Cash</div>
          <div className="v num">{formatGhostDollars(s.cash)}</div>
        </div>
        <div className="stat">
          <div className="k">At risk</div>
          <div className="v num">{formatGhostDollars(s.costBasis)}</div>
        </div>
        <div className="stat">
          <div className="k">Open</div>
          <div className="v num">{s.openCount}</div>
        </div>
        <div className="stat">
          <div className="k">Trades</div>
          <div className="v num">{s.tradeCount}</div>
        </div>
        <div className="stat">
          <div className="k">Markets</div>
          <div className="v num">{s.marketsTraded}</div>
        </div>
        <div className="stat">
          <div className="k">Win rate</div>
          <div className="v num">
            {s.winRate == null ? '--' : `${Math.round(s.winRate * 100)}%`}
          </div>
        </div>
      </div>

      {!ledger.ok && (
        <div className="card" style={{ borderLeftColor: 'var(--no)' }}>
          <h3>Ledger drift detected</h3>
          <div className="note">
            Cash balance disagrees with the transaction ledger by{' '}
            {formatGhostDollars(ledger.drift)}. This should never happen — please report it.
          </div>
        </div>
      )}

      <div className="card">
        <h3>How to trade</h3>
        <div className="note">
          Open any market on polymarket.com or kalshi.com. The Ghostfill panel appears in the
          corner — pick a side, set a size, and place a ghost order. Fills are priced by walking
          the venue&apos;s real order book, so a thin market gives you a genuinely bad average.
        </div>
      </div>
    </>
  );
}

function Sparkline({ points }: { points: number[] }) {
  if (points.length < 2) return null;
  const w = 280;
  const h = 44;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const d = points
    .map((p, i) => {
      const x = (i / (points.length - 1)) * w;
      const y = h - ((p - min) / span) * (h - 4) - 2;
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  const up = points[points.length - 1]! >= points[0]!;

  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
      <path d={d} fill="none" stroke={up ? 'var(--yes)' : 'var(--no)'} strokeWidth="1.5" />
    </svg>
  );
}

function Positions({ state }: { state: GhostState }) {
  const open = state.positions.filter((p) => p.isOpen);
  if (open.length === 0) {
    return <div className="empty">No open positions.<br />Open a market on Polymarket or Kalshi to place your first ghost order.</div>;
  }
  return (
    <>
      {open.map((p) => (
        <PositionCard key={p.marketKey + p.outcome} p={p} />
      ))}
    </>
  );
}

function PositionCard({ p }: { p: StoredPosition }) {
  const value = p.markPrice != null ? (p.qty * p.markPrice) / 100 : p.costBasis;
  const pnl = value - p.costBasis;
  const unit = p.venue === 'polymarket' ? 'shares' : 'contracts';

  return (
    <div className="pos">
      <div className="q">{p.question}</div>
      <div className="line" style={{ marginBottom: 4 }}>
        <span>
          <span className={`tag ${p.outcome}`}>
            {p.outcome === 'yes' ? '▲ YES' : '▼ NO'}
          </span>{' '}
          <span className="tag">{p.venue}</span>
        </span>
        <span>{p.closeTime ? formatCountdown(p.closeTime) : ''}</span>
      </div>
      <div className="line">
        <span>
          {p.qty.toLocaleString()} {unit} @ {formatCents(p.avgEntryPrice)}
        </span>
        <span className="num">mark {formatCents(p.markPrice)}</span>
      </div>
      <div className="line" style={{ marginTop: 3 }}>
        <span>Cost {formatGhostDollars(p.costBasis)}</span>
        <span className={`num ${pnl > 0 ? 'up' : pnl < 0 ? 'down' : ''}`}>
          {formatSignedGhostDollars(pnl)}
        </span>
      </div>
    </div>
  );
}

function History({ state }: { state: GhostState }) {
  if (state.orders.length === 0) return <div className="empty">No orders yet.</div>;
  return (
    <>
      {state.orders.slice(0, 60).map((o) => (
        <div className="pos" key={o.id}>
          <div className="q">{o.question}</div>
          <div className="line" style={{ marginBottom: 3 }}>
            <span>
              <span className={`tag ${o.outcome}`}>
                {o.side === 'buy' ? 'BUY' : 'SELL'} {o.outcome.toUpperCase()}
              </span>{' '}
              <span className="tag">{o.status}</span>
            </span>
            <span>{new Date(o.ts).toLocaleTimeString()}</span>
          </div>
          <div className="line">
            <span>
              {o.qtyFilled.toLocaleString()} @ {formatCents(o.avgPrice)}
            </span>
            <span className="num">{formatGhostDollars(o.cost + o.fee)}</span>
          </div>
          {o.avgPrice !== o.quotedPrice && (
            <div className="line" style={{ marginTop: 2, color: 'var(--dim)' }}>
              <span>quoted {formatCents(o.quotedPrice)}</span>
              <span>{o.latencyMs}ms latency · {Math.round(o.slippageBps)} bps</span>
            </div>
          )}
        </div>
      ))}
    </>
  );
}

/**
 * The Record screen. Statistical honesty is mandatory here: no Brier Skill
 * Score below n = 30, and the confidence interval is always shown.
 */
function Record({ state }: { state: GhostState }) {
  const records: CalibrationRecord[] = state.positions
    .filter((p) => p.settledAt && p.scoringEligible && p.outcomeResult !== undefined)
    .map((p) => ({
      pUser: p.entryPUser,
      pMarket: p.entryPMarket,
      outcome: p.outcomeResult ? 1 : 0,
    }));

  const cal = summarizeCalibration(records);

  return (
    <>
      <div className="card">
        <h3>Brier Skill Score vs the market</h3>
        {cal.displayable ? (
          <>
            <div className={`bss num ${(cal.brierSkill ?? 0) > 0 ? 'up' : 'down'}`}>
              {(cal.brierSkill ?? 0) > 0 ? '+' : ''}
              {(cal.brierSkill ?? 0).toFixed(3)}
            </div>
            <div className="note">
              95% CI {cal.ciLow?.toFixed(3)} to {cal.ciHigh?.toFixed(3)} (approximate) · n = {cal.n}
            </div>
          </>
        ) : (
          <>
            <div className="bss num" style={{ color: 'var(--muted)' }}>
              {cal.n}/{MIN_N_FOR_BSS}
            </div>
            <div className="progress">
              <div style={{ width: `${Math.min(100, (cal.n / MIN_N_FOR_BSS) * 100)}%` }} />
            </div>
            <div className="note">
              Building your record. A skill score before {MIN_N_FOR_BSS} resolved positions would
              be noise, so we will not show you one.
            </div>
          </>
        )}
      </div>

      <div className="card">
        <h3>Verdict</h3>
        <div className="note" style={{ fontSize: 12, color: 'var(--text)' }}>
          {coachingVerdict(cal)}
        </div>
      </div>

      {cal.n > 0 && (
        <div className="card">
          <h3>Murphy decomposition</h3>
          <div className="row">
            <span className="k">Reliability (lower better)</span>
            <span className="num">{cal.murphy.reliability.toFixed(4)}</span>
          </div>
          <div className="row">
            <span className="k">Resolution (higher better)</span>
            <span className="num">{cal.murphy.resolution.toFixed(4)}</span>
          </div>
          <div className="row">
            <span className="k">Uncertainty</span>
            <span className="num">{cal.murphy.uncertainty.toFixed(4)}</span>
          </div>
          <div className="row">
            <span className="k">Your Brier</span>
            <span className="num">{cal.brierUser.toFixed(4)}</span>
          </div>
          <div className="row">
            <span className="k">Market&apos;s Brier</span>
            <span className="num">{cal.brierMarket.toFixed(4)}</span>
          </div>
        </div>
      )}
    </>
  );
}

function SettingsView({ state, onChange }: { state: GhostState; onChange: () => void }) {
  const set = async (patch: Partial<Settings>) => {
    await send({ type: 'SET_SETTINGS', patch });
    onChange();
  };

  const reset = async () => {
    if (!confirm('Reset your ghost portfolio to G$10,000? Trade history is cleared. This cannot be undone.')) return;
    await send({ type: 'RESET_PORTFOLIO' });
    onChange();
  };

  return (
    <>
      <div className="card">
        <h3>Realism</h3>
        <label className="field">
          <span className="lbl">Fill mode</span>
          <select
            value={state.settings.realism}
            onChange={(e) => void set({ realism: e.target.value as Settings['realism'] })}
          >
            <option value="instant">Instant — fills at the mid, no fees (tutorial only)</option>
            <option value="realistic">Realistic — real book, real fees, 250ms latency</option>
            <option value="brutal">Brutal — 1 tick worse, 1.5x fees, 750ms latency</option>
          </select>
        </label>
        <div className="note">
          {state.settings.realism === 'instant'
            ? 'Instant mode is for learning the interface. It is excluded from your calibration record and from any leaderboard.'
            : 'Orders fill against a book fetched after your quote, so the price can move against you. That is the point.'}
        </div>
      </div>

      <div className="card">
        <h3>Order defaults</h3>
        <label className="field">
          <span className="lbl">Default order size (G$)</span>
          <input
            type="number"
            min={1}
            value={state.settings.defaultOrderSize}
            onChange={(e) => void set({ defaultOrderSize: Number(e.target.value) || 100 })}
          />
        </label>
        <label className="field">
          <span className="lbl">Size in</span>
          <select
            value={state.settings.sizeMode}
            onChange={(e) => void set({ sizeMode: e.target.value as Settings['sizeMode'] })}
          >
            <option value="dollars">Dollars</option>
            <option value="contracts">Contracts / shares</option>
          </select>
        </label>
        <Toggle
          label="Confirm before placing"
          desc="Show a confirmation step on every order."
          checked={state.settings.confirmBeforeOrder}
          onChange={(v) => void set({ confirmBeforeOrder: v })}
        />
      </div>

      <div className="card">
        <h3>Sound</h3>
        <Toggle
          label="Order sounds"
          desc="A rising tone on a fill, a falling one on a rejection — so you can tell them apart without looking."
          checked={state.settings.soundEnabled}
          onChange={(v) => {
            void set({ soundEnabled: v });
            if (v) playSound('fill', state.settings.soundVolume, true);
          }}
        />
        <label className="field" style={{ marginTop: 10 }}>
          <span className="lbl">Volume</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={state.settings.soundVolume}
            onChange={(e) => void set({ soundVolume: Number(e.target.value) })}
            onMouseUp={() => playSound('tick', state.settings.soundVolume, state.settings.soundEnabled)}
          />
        </label>
        <div style={{ display: 'flex', gap: 6 }}>
          {(['fill', 'partial', 'reject', 'settle'] as const).map((n) => (
            <button
              key={n}
              className="action"
              style={{ fontSize: 11, padding: 6 }}
              onClick={() => playSound(n, state.settings.soundVolume, true)}
            >
              {n}
            </button>
          ))}
        </div>
      </div>

      <div className="card">
        <h3>Display</h3>
        <Toggle
          label="Ghost Mode overlay"
          desc="Show the trading panel on polymarket.com and kalshi.com."
          checked={state.settings.overlayEnabled}
          onChange={(v) => void set({ overlayEnabled: v })}
        />
        <Toggle
          label="Colourblind-safe colours"
          desc="Blue and orange instead of green and red. YES/NO always carry an arrow and a label regardless."
          checked={state.settings.colorblindMode}
          onChange={(v) => void set({ colorblindMode: v })}
        />
      </div>

      <div className="card">
        <h3>Leaderboard</h3>
        <Toggle
          label="Compete on the ladder"
          desc="Off by default. Solo play is fully local and never leaves your browser. Turning this on creates an anonymous handle so your scores can be ranked server-side — the only way a leaderboard can mean anything."
          checked={state.settings.competeOptIn}
          onChange={(v) => void set({ competeOptIn: v })}
        />
        {state.settings.competeOptIn && (
          <div className="note">
            Still anonymous — no email, no password. Ladder play requires Realistic or Brutal mode.
          </div>
        )}
      </div>

      <div className="card">
        <h3>What Ghostfill does not simulate</h3>
        <div className="note">
          Ghostfill does not model market impact. Your ghost orders never touch the real book, so
          they cannot move it. Order size is capped at 5% of visible depth to keep that
          approximation honest. Fills never exceed the liquidity actually shown on the venue —
          if a book is thin, you get a bad average, exactly as you would in reality.
        </div>
      </div>

      <div className="card">
        <h3>Data</h3>
        <div className="note" style={{ marginBottom: 9 }}>
          Everything above is stored in this browser only. Ghostfill has no account for you and
          sends nothing anywhere unless you opt into the leaderboard. Portfolio resets: {state.resetCount}.
        </div>
        <button className="action danger" onClick={() => void reset()}>
          Reset portfolio to G$10,000
        </button>
      </div>
    </>
  );
}

function Toggle({
  label,
  desc,
  checked,
  onChange,
}: {
  label: string;
  desc: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="toggle">
      <div style={{ flex: 1 }}>
        <div className="t">{label}</div>
        <div className="d">{desc}</div>
      </div>
      <label className="switch">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span className="slider" />
      </label>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
