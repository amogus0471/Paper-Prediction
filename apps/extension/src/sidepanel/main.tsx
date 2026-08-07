import { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  BRAND,
  MIN_N_FOR_BSS,
  MIN_N_FOR_CATEGORY,
  formatCents,
  formatCountdown,
  formatSimDollars,
  formatSignedSimDollars,
  formatSignedPercent,
  readinessProgress,
} from '@polyfill/core';
import { send } from '../lib/messages';
import { playSound } from '../lib/sfx';
import type { LocalRecord } from '../lib/record';
import {
  summarize,
  checkLedger,
  type LocalState,
  type Settings,
  type StoredPosition,
} from '../lib/store';
import { Leaderboard } from './Leaderboard';
import './styles.css';

type Tab = 'book' | 'watch' | 'ladder' | 'record' | 'history' | 'settings';

const TABS: { id: Tab; label: string }[] = [
  { id: 'book', label: 'Book' },
  { id: 'watch', label: 'Watch' },
  { id: 'ladder', label: 'Ladder' },
  { id: 'record', label: 'Record' },
  { id: 'history', label: 'History' },
  { id: 'settings', label: 'Settings' },
];

function App() {
  const [state, setState] = useState<LocalState | null>(null);
  const [record, setRecord] = useState<LocalRecord | null>(null);
  const [tab, setTab] = useState<Tab>('book');
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [s, r] = await Promise.all([
        send<LocalState>({ type: 'GET_STATE' }),
        send<LocalRecord>({ type: 'GET_RECORD' }),
      ]);
      setState(s);
      setRecord(r);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
    // The worker and the overlay both write; chrome.storage tells us when, so
    // the panel stays live without polling.
    const onChange = () => void refresh();
    chrome.storage.local.onChanged.addListener(onChange);
    return () => chrome.storage.local.onChanged.removeListener(onChange);
  }, [refresh]);


  if (error || !state || !record) {
    return (
      <div className="app">
        <main>
          <div className="empty">
            {error ? `Could not reach the ${BRAND.name} worker.` : 'Loading…'}
            {error ? <div className="note">{error}</div> : null}
          </div>
        </main>
      </div>
    );
  }

  const s = summarize(state);

  return (
    <div className="app">
      <header>
        <div className="handle">
          {BRAND.name}
          <span className="simchip" title="No real money is involved anywhere in this app.">
            SIM
          </span>
        </div>
        <div className="equity num">{formatSimDollars(s.equity)}</div>
        <div className={`delta num ${s.returnPct > 0 ? 'up' : s.returnPct < 0 ? 'down' : 'flat'}`}>
          {formatSignedSimDollars(s.equity - state.startingBalance)} (
          {formatSignedPercent(s.returnPct)})
        </div>
      </header>

      <nav role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>
            {t.label}
            {t.id === 'watch' && state.watchlist.length > 0 ? ` ${state.watchlist.length}` : ''}
          </button>
        ))}
      </nav>

      <main>
        {tab === 'book' && <Book state={state} record={record} />}
        {tab === 'watch' && <Watch state={state} onChange={refresh} />}
        {tab === 'ladder' && <Leaderboard state={state} onChange={refresh} />}
        {tab === 'record' && <RecordScreen record={record} />}
        {tab === 'history' && <History state={state} />}
        {tab === 'settings' && <SettingsView state={state} onChange={refresh} />}
      </main>
    </div>
  );
}

/** Non-dismissible. Required on every surface showing a price, position or order. */
function SimBar() {
  return (
    <div className="simbar">
      <span className="simdot" />
      {BRAND.disclaimer}
    </div>
  );
}

function Row({ k, v, tone }: { k: string; v: string; tone?: number }) {
  return (
    <div className="row">
      <span className="k">{k}</span>
      <span className={`num ${tone == null ? '' : tone > 0 ? 'up' : tone < 0 ? 'down' : ''}`}>
        {v}
      </span>
    </div>
  );
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div className="stat">
      <div className="k">{k}</div>
      <div className="v num">{v}</div>
    </div>
  );
}

// ── Book ────────────────────────────────────────────────────────────────────

function Book({ state, record }: { state: LocalState; record: LocalRecord }) {
  const s = summarize(state);
  const ledger = checkLedger(state);
  const open = state.positions.filter((p) => p.isOpen);
  const curve = [...state.transactions].reverse().map((t) => t.balanceAfter);

  return (
    <>
      <div className="card">
        <h3>Earnings</h3>
        <Sparkline points={curve.length > 1 ? curve : [state.startingBalance, state.cash]} />
        <Row k="Realized P&L" v={formatSignedSimDollars(s.realized)} tone={s.realized} />
        <Row k="Unrealized P&L" v={formatSignedSimDollars(s.unrealized)} tone={s.unrealized} />
        <Row k="Fees paid" v={formatSimDollars(s.totalFees)} />
        <Row k="Peak equity" v={formatSimDollars(s.peakEquity)} />
      </div>

      {/* The single most useful line from the Record screen, surfaced where the
          user already is rather than behind a tab change. */}
      {record.insight && (
        <div className="card">
          <h3>Where your edge is</h3>
          <div className="insight">{record.insight}</div>
        </div>
      )}

      <div className="grid2" style={{ marginBottom: 8 }}>
        <Stat k="Cash" v={formatSimDollars(s.cash)} />
        <Stat k="At risk" v={formatSimDollars(s.costBasis)} />
        <Stat k="Open" v={String(s.openCount)} />
        <Stat k="Trades" v={String(s.tradeCount)} />
        <Stat k="Markets" v={String(s.marketsTraded)} />
        <Stat k="Win rate" v={s.winRate == null ? '--' : `${Math.round(s.winRate * 100)}%`} />
      </div>

      {!ledger.ok && (
        <div className="card danger">
          <h3>Ledger drift detected</h3>
          <div className="note">
            Cash disagrees with the transaction ledger by {formatSimDollars(ledger.drift)}. This
            should never happen — please report it.
          </div>
        </div>
      )}

      <h3 className="section">Open positions</h3>
      {open.length === 0 ? (
        <div className="empty">
          No open positions.
          <div className="note">
            Open any market on Polymarket or Kalshi — the {BRAND.name} panel appears in the corner.
          </div>
        </div>
      ) : (
        open.map((p) => <PositionCard key={p.marketKey + p.outcome} p={p} />)
      )}
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

function PositionCard({ p }: { p: StoredPosition }) {
  const value = p.markPrice != null ? (p.qty * p.markPrice) / 100 : p.costBasis;
  const pnl = value - p.costBasis;
  const unit = p.venue === 'polymarket' ? 'shares' : 'contracts';
  return (
    <div className="pos">
      <div className="q">{p.question}</div>
      <div className="line" style={{ marginBottom: 4 }}>
        <span>
          <span className={`tag ${p.outcome}`}>{p.outcome === 'yes' ? '▲ YES' : '▼ NO'}</span>{' '}
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
        <span>Cost {formatSimDollars(p.costBasis)}</span>
        <span className={`num ${pnl > 0 ? 'up' : pnl < 0 ? 'down' : ''}`}>
          {formatSignedSimDollars(pnl)}
        </span>
      </div>
    </div>
  );
}

// ── Watch ───────────────────────────────────────────────────────────────────

function Watch({ state, onChange }: { state: LocalState; onChange: () => void }) {
  const [open, setOpen] = useState<string | null>(null);

  // Auto-refresh once a second. React only re-renders the values that changed,
  // so nothing flickers and an expanded row stays expanded across ticks.
  useEffect(() => {
    if (state.watchlist.length === 0) return;
    const id = setInterval(() => {
      if (document.hidden) return;
      void send({ type: 'REFRESH_WATCHLIST' }).then(onChange).catch(() => undefined);
    }, 1000);
    return () => clearInterval(id);
  }, [state.watchlist.length, onChange]);

  const unstar = async (w: LocalState['watchlist'][number]) => {
    await send({
      type: 'TOGGLE_WATCH',
      meta: {
        venue: w.venue,
        venueMarketId: w.venueMarketId,
        question: w.question,
        yesLabel: 'Yes',
        noLabel: 'No',
        tickCents: 1,
        minOrderSize: 1,
        category: w.category,
        closeTime: w.closeTime,
      },
      mid: w.lastMid,
    });
    onChange();
  };

  if (state.watchlist.length === 0) {
    return (
      <div className="empty">
        Nothing on your watchlist.
        <div className="note">
          Star a market from the {BRAND.name} panel on Polymarket or Kalshi. Watched markets
          refresh once a second while this tab is open.
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="lbHead">
        <h2>Watchlist</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="live">
            <i />
            LIVE
          </span>
          <button
            className="ghostbtn"
            onClick={async () => {
              if (!confirm(`Remove all ${state.watchlist.length} watched markets?`)) return;
              for (const w of [...state.watchlist]) await unstar(w);
            }}
          >
            Clear all
          </button>
        </div>
      </div>
      {state.watchlist.map((w) => (
        <WatchRow
          key={w.marketKey}
          w={w}
          state={state}
          open={open === w.marketKey}
          onToggle={() => setOpen(open === w.marketKey ? null : w.marketKey)}
          onUnstar={() => void unstar(w)}
        />
      ))}
    </>
  );
}

/** Market URLs are stable public routes; deep-linking beats re-searching. */
/**
 * Where "Open market" goes.
 *
 * Prefers the URL the market was starred from, which is by definition correct.
 * The fallbacks are best-effort for rows saved before that was recorded:
 * Polymarket routes on an EVENT slug (we hold a market conditionId, hence the
 * 404s), and a bare Kalshi series ticker is not a page — so that one goes to
 * search rather than a dead link.
 */
function marketUrl(w: LocalState['watchlist'][number]): string {
  if (w.sourceUrl) return w.sourceUrl;
  if (w.venue === 'polymarket') {
    return w.slug
      ? `https://polymarket.com/event/${encodeURIComponent(w.slug)}`
      : `https://polymarket.com/markets?_q=${encodeURIComponent(w.question.slice(0, 60))}`;
  }
  return `https://kalshi.com/search?q=${encodeURIComponent(w.question.slice(0, 60))}`;
}

function WatchRow({
  w,
  state,
  open,
  onToggle,
  onUnstar,
}: {
  w: LocalState['watchlist'][number];
  state: LocalState;
  open: boolean;
  onToggle: () => void;
  onUnstar: () => void;
}) {
  const mid = w.lastMid;
  const prev = w.prevMid ?? null;
  const change = mid != null && prev != null ? mid - prev : null;
  const history = w.history ?? [];
  const pos = state.positions.find((p) => p.marketKey === w.marketKey && p.isOpen);

  return (
    <div className={`wrow ${open ? 'open' : ''}`}>
      <div className="whead" onClick={onToggle} role="button" aria-expanded={open}>
        <span className="q">{w.question}</span>
        <span className="px num">{mid == null ? '--' : `${mid.toFixed(0)}¢`}</span>
        <span className={`chg num ${change == null ? '' : change > 0 ? 'up' : change < 0 ? 'down' : ''}`}>
          {change == null || change === 0 ? '' : `${change > 0 ? '▲' : '▼'}${Math.abs(change).toFixed(1)}`}
        </span>
        <span className="wcar">▼</span>
      </div>

      <div className="wbody">
        <div>
          <div className="winner">
            {history.length > 2 && <MiniSpark points={history} />}
            <div className="wgrid">
              <div className="wstat">
                <div className="k">Yes</div>
                <div className="v num up">{mid == null ? '--' : `${mid.toFixed(0)}¢`}</div>
              </div>
              <div className="wstat">
                <div className="k">No</div>
                <div className="v num down">{mid == null ? '--' : `${(100 - mid).toFixed(0)}¢`}</div>
              </div>
              <div className="wstat">
                <div className="k">Closes</div>
                <div className="v num" style={{ fontSize: 13 }}>
                  {w.closeTime ? formatCountdown(w.closeTime) : '--'}
                </div>
              </div>
              {pos && (
                <div className="wstat">
                  <div className="k">Your P&amp;L</div>
                  <div
                    className={`v num ${
                      pos.markPrice != null && (pos.qty * pos.markPrice) / 100 - pos.costBasis >= 0
                        ? 'up'
                        : 'down'
                    }`}
                  >
                    {pos.markPrice == null
                      ? '--'
                      : formatSignedSimDollars((pos.qty * pos.markPrice) / 100 - pos.costBasis)}
                  </div>
                </div>
              )}
            </div>
            <div className="wactions">
              <button onClick={() => void send({ type: 'OPEN_MARKET', url: marketUrl(w) })}>
                Open market ↗
              </button>
              <button
                onClick={() => {
                  if (confirm(`Stop watching "${w.question.slice(0, 60)}"?`)) onUnstar();
                }}
              >
                Remove
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Tiny price history line. Same shape as the equity sparkline, smaller. */
function MiniSpark({ points }: { points: number[] }) {
  const w = 300;
  const h = 40;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const d = points
    .map((p, i) => {
      const x = (i / (points.length - 1)) * w;
      const y = h - ((p - min) / span) * (h - 6) - 3;
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  const up = points[points.length - 1]! >= points[0]!;
  return (
    <svg className="wspark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
      <path d={d} fill="none" stroke={up ? 'var(--yes)' : 'var(--no)'} strokeWidth="1.5" />
    </svg>
  );
}

function RecordScreen({ record }: { record: LocalRecord }) {
  const { summary: cal, bins, categories, verdict, readiness } = record;

  return (
    <>
      <div className="card">
        <h3>Brier Skill Score vs the market</h3>
        {cal.displayable && cal.brierSkill != null ? (
          <>
            <div className={`bss num ${cal.brierSkill > 0 ? 'up' : 'down'}`}>
              {cal.brierSkill > 0 ? '+' : ''}
              {cal.brierSkill.toFixed(3)}
            </div>
            <div className="note">
              {cal.ciLow != null && cal.ciHigh != null
                ? `95% CI ${cal.ciLow.toFixed(3)} to ${cal.ciHigh.toFixed(3)} (approximate) · `
                : ''}
              n = {cal.n}
            </div>
          </>
        ) : (
          <>
            <div className="bss num muted">
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

      <div className={`card ${verdict.positive ? 'good' : ''}`}>
        <h3>Verdict</h3>
        <div className="verdict">{verdict.headline}</div>
        <div className="note">{verdict.advice}</div>
      </div>

      {bins.length > 0 && (
        <div className="card">
          <h3>Calibration curve</h3>
          <CalibrationChart bins={bins} />
          <div className="note">
            Each dot is a group of your forecasts; size shows how many. On the dashed line, things
            you called 70% happened 70% of the time. Above it you were too cautious, below it too
            confident.
          </div>
        </div>
      )}

      {categories.length > 0 && (
        <div className="card">
          <h3>By category</h3>
          {categories.map((c) => (
            <div className="row" key={c.category}>
              <span className="k">
                {c.category} <span className="tag">n={c.n}{c.reliable ? '' : ' thin'}</span>
              </span>
              <span
                className={`num ${!c.reliable ? 'muted' : (c.brierSkill ?? 0) > 0 ? 'up' : 'down'}`}
              >
                {c.brierSkill == null
                  ? '--'
                  : `${c.brierSkill > 0 ? '+' : ''}${c.brierSkill.toFixed(3)}`}
              </span>
            </div>
          ))}
          <div className="note">
            Categories under {MIN_N_FOR_CATEGORY} resolved positions are greyed out — too few to
            read anything into.
          </div>
        </div>
      )}

      {cal.n > 0 && (
        <div className="card">
          <h3>Murphy decomposition</h3>
          <Row k="Reliability (lower better)" v={cal.murphy.reliability.toFixed(4)} />
          <Row k="Resolution (higher better)" v={cal.murphy.resolution.toFixed(4)} />
          <Row k="Uncertainty" v={cal.murphy.uncertainty.toFixed(4)} />
          <Row k="Your Brier" v={cal.brierUser.toFixed(4)} />
          <Row k="Market's Brier" v={cal.brierMarket.toFixed(4)} />
          <div className="note">
            Reliability is whether your probabilities mean what they say. Resolution is whether
            they are informative at all — a coin-flipper can be perfectly reliable and useless.
          </div>
        </div>
      )}

      <ReadinessCard readiness={readiness} />
    </>
  );
}

function CalibrationChart({ bins }: { bins: LocalRecord['bins'] }) {
  const size = 200;
  const pad = 20;
  const inner = size - pad * 2;
  const maxN = Math.max(...bins.map((b) => b.n), 1);
  const x = (v: number) => pad + v * inner;
  const y = (v: number) => size - pad - v * inner;

  return (
    <svg
      className="calchart"
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label="Calibration curve: forecast probability against observed frequency"
    >
      <rect x={pad} y={pad} width={inner} height={inner} fill="none" stroke="var(--border)" />
      {/* Perfect calibration */}
      <line x1={x(0)} y1={y(0)} x2={x(1)} y2={y(1)} stroke="var(--muted)" strokeDasharray="3 3" />
      {bins.map((b) => (
        <circle
          key={b.bin}
          cx={x(b.meanPredicted)}
          cy={y(b.observedFrequency)}
          r={3 + (b.n / maxN) * 5}
          fill="var(--brand)"
          fillOpacity={0.75}
        />
      ))}
      <text x={pad} y={size - 6} fill="var(--dim)" fontSize="8">
        you said 0%
      </text>
      <text x={size - pad - 30} y={size - 6} fill="var(--dim)" fontSize="8">
        100%
      </text>
    </svg>
  );
}

/**
 * The Readiness Check — the feature that makes "learn before it costs you
 * anything" literal. Locked until there is enough evidence to mean it, and
 * blunt once there is.
 */
function ReadinessCard({ readiness }: { readiness: LocalRecord['readiness'] }) {
  const tone =
    readiness.status === 'ready' ? 'good' : readiness.status === 'not_ready' ? 'danger' : '';

  return (
    <div className={`card ${tone}`}>
      <h3>Readiness Check</h3>
      {!readiness.unlocked ? (
        <>
          <div className="verdict muted">{readiness.headline}</div>
          <div className="progress">
            <div style={{ width: `${readinessProgress(readiness.n) * 100}%` }} />
          </div>
          <div className="note">{readiness.body[0]}</div>
          <div className="note">{readiness.bottomLine}</div>
        </>
      ) : (
        <>
          <div className="verdict">{readiness.headline}</div>
          {readiness.body.map((line) => (
            <div className="note" key={line}>
              {line}
            </div>
          ))}
          <div className="bottomline">{readiness.bottomLine}</div>
        </>
      )}
    </div>
  );
}

// ── History ─────────────────────────────────────────────────────────────────

function History({ state }: { state: LocalState }) {
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
              {o.realism === 'instant' && (
                <span className="tag" style={{ marginLeft: 4 }}>
                  unscored
                </span>
              )}
            </span>
            <span>{new Date(o.ts).toLocaleTimeString()}</span>
          </div>
          <div className="line">
            <span>
              {o.qtyFilled.toLocaleString()} @ {formatCents(o.avgPrice)}
            </span>
            <span className="num">{formatSimDollars(o.cost + o.fee)}</span>
          </div>
          {o.avgPrice !== o.quotedPrice && (
            <div className="line dim" style={{ marginTop: 2 }}>
              <span>quoted {formatCents(o.quotedPrice)}</span>
              <span>
                {o.latencyMs}ms · {Math.round(o.slippageBps)} bps
              </span>
            </div>
          )}
        </div>
      ))}
    </>
  );
}

// ── Settings ────────────────────────────────────────────────────────────────

function SettingsView({ state, onChange }: { state: LocalState; onChange: () => void }) {
  const set = async (patch: Partial<Settings>) => {
    await send({ type: 'SET_SETTINGS', patch });
    onChange();
  };

  const reset = async () => {
    if (
      !confirm(
        `Reset your paper portfolio to ${BRAND.currencySymbol}10,000? Trade history is cleared. This cannot be undone.`,
      )
    )
      return;
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
            <option value="brutal">Brutal — 1 tick worse, 1.5× fees, 750ms latency</option>
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
          <span className="lbl">Default order size ({BRAND.currencySymbol})</span>
          <input
            type="number"
            min={1}
            value={state.settings.defaultOrderSize}
            onChange={(e) => void set({ defaultOrderSize: Number(e.target.value) || 100 })}
          />
        </label>
        <Toggle
          label="Confirm before placing"
          desc="Show a confirmation step on every order."
          checked={state.settings.confirmBeforeOrder}
          onChange={(v) => void set({ confirmBeforeOrder: v })}
        />
        <label className="field" style={{ marginTop: 11 }}>
          <span className="lbl">Quick-buy sizing</span>
          <select
            value={state.settings.quickMode}
            onChange={(e) => void set({ quickMode: e.target.value as 'dollars' | 'percent' })}
          >
            <option value="dollars">Fixed amounts (P$25, P$50…)</option>
            <option value="percent">Percent of balance (1%, 2%, 5%…)</option>
          </select>
        </label>
        <div className="note" style={{ marginTop: -6, marginBottom: 10 }}>
          Percent sizing scales with your balance, so a preset means the same
          thing whether you are up or down. That is what position sizing is —
          and it is 35% of what the ladder scores you on.
        </div>
        {state.settings.quickMode === 'percent' ? (
          <label className="field">
            <span className="lbl">Percent presets</span>
            <div style={{ display: 'flex', gap: 6 }}>
              {state.settings.quickPercents.map((v, i) => (
                <input
                  key={i}
                  type="number"
                  min={1}
                  max={20}
                  value={v}
                  onChange={(e) => {
                    const next = [...state.settings.quickPercents];
                    next[i] = Math.max(1, Math.min(20, Number(e.target.value) || 1));
                    void set({ quickPercents: next });
                  }}
                />
              ))}
            </div>
          </label>
        ) : (
        <label className="field">
          <span className="lbl">Quick-buy buttons</span>
          <div style={{ display: 'flex', gap: 6 }}>
            {state.settings.quickAmounts.map((v, i) => (
              <input
                key={i}
                type="number"
                min={1}
                value={v}
                onChange={(e) => {
                  const next = [...state.settings.quickAmounts];
                  next[i] = Math.max(1, Number(e.target.value) || 1);
                  void set({ quickAmounts: next });
                }}
              />
            ))}
          </div>
        </label>
        )}
        <div className="note">
          These are the four one-tap amounts on the market popup.
        </div>
        <Toggle
          label="Keyboard trading"
          desc="Y and N pick a side, 1-4 pick a preset, Enter places, Esc minimises. Ignored while you are typing in the page."
          checked={state.settings.keyboardTrading}
          onChange={(v) => void set({ keyboardTrading: v })}
        />
        <Toggle
          label="Freeze decided markets"
          desc="Blocks trading once a market is priced at 97c or above (or 3c and below) with a tight spread. At that point the outcome is public and the venue simply has not settled yet, so buying collects rather than forecasts. The ladder always enforces this regardless."
          checked={state.settings.resolutionLockout}
          onChange={(v) => void set({ resolutionLockout: v })}
        />
        <Toggle
          label="Cap orders at 5% of visible depth"
          desc="Refuses an order larger than the book can absorb. Off, you fill against whatever depth exists and eat the bad average - which is the honest outcome, just an expensive lesson."
          checked={state.settings.enforceDepthCap}
          onChange={(v) => void set({ enforceDepthCap: v })}
        />
        <Toggle
          label="Double-tap to place"
          desc="Press Y or N twice within 400ms to place the order, instead of reaching for Enter."
          checked={state.settings.doubleTapToPlace}
          onChange={(v) => void set({ doubleTapToPlace: v })}
        />
        <Toggle
          label="Turbo open"
          desc="Opening a market reuses a tab already on that venue instead of paying for a cold page load. Only ever reuses a tab already on Polymarket or Kalshi."
          checked={state.settings.turboMode}
          onChange={(v) => void set({ turboMode: v })}
        />
      </div>

      <div className="card">
        <h3>Sound</h3>
        <Toggle
          label="Confetti on a fill"
          desc="A short celebration when an order fills. Respects reduced-motion."
          checked={state.settings.confettiEnabled}
          onChange={(v) => void set({ confettiEnabled: v })}
        />
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
            onMouseUp={() =>
              playSound('tick', state.settings.soundVolume, state.settings.soundEnabled)
            }
          />
        </label>
        <div className="btnrow">
          {(['fill', 'partial', 'reject', 'settle'] as const).map((n) => (
            <button
              key={n}
              className="action small"
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
          label={`${BRAND.name} overlay`}
          desc="Show the trading panel on polymarket.com and kalshi.com."
          checked={state.settings.overlayEnabled}
          onChange={(v) => void set({ overlayEnabled: v })}
        />
      </div>

      <div className="card">
        <h3>Leaderboard</h3>
        {state.settings.competeOptIn ? (
          <>
            <div className="row">
              <span className="k">Handle</span>
              <span className="num">{state.settings.handle ?? '—'}</span>
            </div>
            <DeviceKeyReveal deviceKey={state.settings.deviceKey} />
          </>
        ) : (
          <div className="note">
            You are not competing. Solo play is fully local and never leaves this browser. Open the{' '}
            <strong>Ladder</strong> tab to read exactly what would be sent and opt in.
          </div>
        )}
      </div>

      <div className="card">
        <h3>What {BRAND.name} does not simulate</h3>
        <div className="note">
          No market impact modelling. Your paper orders never touch the real book, so they cannot
          move it. Order size is capped at 5% of visible depth to keep that approximation honest,
          and fills never exceed the liquidity the venue actually showed — if a book is thin, you
          get a bad average, exactly as you would in reality.
        </div>
      </div>

      <div className="card">
        <h3>Data</h3>
        <div className="note" style={{ marginBottom: 9 }}>
          Everything is stored in this browser only. {BRAND.name} has no account for you and sends
          nothing anywhere. Portfolio resets: {state.resetCount}.
        </div>
        <button className="action danger" onClick={() => void reset()}>
          Reset portfolio to {BRAND.currencySymbol}10,000
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

/**
 * Reveal-and-copy for the device key.
 *
 * This string IS the user's leaderboard identity — there is no password reset
 * and no email to recover from, which is the price of never asking for either.
 * So it is masked by default and treated like a credential, and the copy button
 * exists because "write down this 43-character string" is not a real recovery
 * plan.
 */
function DeviceKeyReveal({ deviceKey }: { deviceKey: string | null }) {
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState(false);

  if (!deviceKey) return null;

  return (
    <>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <span className="k">Device key</span>
        <span
          className="num"
          style={{
            fontSize: 10,
            maxWidth: 168,
            overflowWrap: 'anywhere',
            textAlign: 'right',
            color: shown ? 'var(--text)' : 'var(--dim)',
          }}
        >
          {shown ? deviceKey : '•'.repeat(24)}
        </span>
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
        <button className="action" style={{ fontSize: 11 }} onClick={() => setShown(!shown)}>
          {shown ? 'Hide' : 'Show'}
        </button>
        <button
          className="action"
          style={{ fontSize: 11 }}
          onClick={async () => {
            await navigator.clipboard.writeText(deviceKey);
            setCopied(true);
            setTimeout(() => setCopied(false), 1800);
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <div className="note">
        Save this somewhere safe. Clearing extension storage or moving browsers loses your ladder
        history unless you paste this key into the new install. There is no password reset.
      </div>
    </>
  );
}
