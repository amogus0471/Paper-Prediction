import { useState } from 'react';
import { send } from '../lib/messages';
import { ALERT_LABELS, type AlertKind } from '../lib/alerts';
import type { LocalState } from '../lib/store';

/**
 * A three-step walkthrough, about alerts and nothing else.
 *
 * Scoped deliberately. A tour of the whole app is a tour nobody finishes, and
 * the one thing that genuinely needs explaining is that alerts exist at all —
 * the rest of the product is discoverable by using it.
 *
 * Skippable at every step, and it never blocks the app.
 */
export function Onboarding({ state, onDone }: { state: LocalState; onDone: () => void }) {
  const [step, setStep] = useState(0);
  const [picked, setPicked] = useState<AlertKind[]>(['resolved']);
  const [leaving, setLeaving] = useState(false);

  const finish = async (celebrate: boolean) => {
    setLeaving(true);
    if (celebrate) confetti();
    await send({ type: 'SET_SETTINGS', patch: { onboardedAt: new Date().toISOString() } });
    // Let the exit animation play before the panel swaps out.
    setTimeout(onDone, celebrate ? 900 : 260);
  };

  const toggle = (k: AlertKind) =>
    setPicked((p) => (p.includes(k) ? p.filter((x) => x !== k) : [...p, k]));

  return (
    <div className={`onb ${leaving ? 'out' : ''}`}>
      <div className="onb-dots" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <span key={i} className={i === step ? 'on' : i < step ? 'done' : ''} />
        ))}
      </div>

      {step === 0 && (
        <div className="onb-step" key="s0">
          <div className="onb-ico">🔔</div>
          <h2>Get told when it matters</h2>
          <p>
            You do not have to watch a market to follow it. Star one, set an alert, and this
            extension will tell you when something actually happens.
          </p>
          <p className="onb-sub">Everything is checked on your machine. Nothing is sent anywhere.</p>
          <button className="action primary" onClick={() => setStep(1)}>
            Show me
          </button>
          <button className="onb-skip" onClick={() => void finish(false)}>
            Skip
          </button>
        </div>
      )}

      {step === 1 && (
        <div className="onb-step" key="s1">
          <div className="onb-ico">⚡</div>
          <h2>What should we tell you about?</h2>
          <p className="onb-sub">Pick any. You can change these per market later.</p>

          <div className="onb-picks">
            {(Object.keys(ALERT_LABELS) as AlertKind[]).map((k) => (
              <button
                key={k}
                className={`onb-pick ${picked.includes(k) ? 'on' : ''}`}
                onClick={() => toggle(k)}
              >
                <span className="onb-check">{picked.includes(k) ? '✓' : ''}</span>
                <span>
                  <strong>{ALERT_LABELS[k]}</strong>
                  <em>{EXAMPLES[k]}</em>
                </span>
              </button>
            ))}
          </div>

          <button className="action primary" onClick={() => setStep(2)}>
            Continue
          </button>
          <button className="onb-skip" onClick={() => void finish(false)}>
            Skip
          </button>
        </div>
      )}

      {step === 2 && (
        <div className="onb-step" key="s2">
          <div className="onb-ico">★</div>
          <h2>Star a market to arm it</h2>
          <p>
            On any Polymarket or Kalshi market, hit the <strong>★</strong> in the corner panel. It
            lands in your Watch tab, where you can open it and add an alert in one tap.
          </p>
          <div className="onb-demo">
            <div className="onb-demo-row">
              <span className="onb-demo-q">Will the Fed cut rates in September?</span>
              <span className="onb-demo-px up">63¢</span>
            </div>
            <div className="onb-demo-alert">🔔 {ALERT_LABELS[picked[0] ?? 'resolved']}</div>
          </div>

          <button className="action primary" onClick={() => void finish(true)}>
            {state.watchlist.length > 0 ? 'Done' : 'Got it'}
          </button>
        </div>
      )}
    </div>
  );
}

const EXAMPLES: Record<AlertKind, string> = {
  resolved: 'It settled — you won or lost',
  moved_up: 'It jumped 20 points in your favour',
  moved_down: 'It fell 20 points',
  crosses: 'It hit the price you were waiting for',
};

/** Same throwaway-canvas confetti as the popup, no dependency. */
function confetti(): void {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const cv = document.createElement('canvas');
  cv.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:9999';
  cv.width = innerWidth;
  cv.height = innerHeight;
  document.body.appendChild(cv);
  const ctx = cv.getContext('2d');
  if (!ctx) return;

  const colours = ['#3B82F6', '#22C55E', '#F59E0B', '#60A5FA', '#EC4899'];
  const bits = Array.from({ length: 90 }, () => ({
    x: cv.width / 2 + (Math.random() - 0.5) * 260,
    y: cv.height * 0.38,
    vx: (Math.random() - 0.5) * 10,
    vy: -Math.random() * 12 - 4,
    w: 5 + Math.random() * 6,
    h: 3 + Math.random() * 5,
    rot: Math.random() * Math.PI,
    vr: (Math.random() - 0.5) * 0.32,
    c: colours[(Math.random() * colours.length) | 0]!,
  }));

  let f = 0;
  const tick = () => {
    f++;
    ctx.clearRect(0, 0, cv.width, cv.height);
    for (const b of bits) {
      b.vy += 0.34;
      b.x += b.vx;
      b.y += b.vy;
      b.rot += b.vr;
      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.rotate(b.rot);
      ctx.globalAlpha = Math.max(0, 1 - f / 95);
      ctx.fillStyle = b.c;
      ctx.fillRect(-b.w / 2, -b.h / 2, b.w, b.h);
      ctx.restore();
    }
    if (f < 95) requestAnimationFrame(tick);
    else cv.remove();
  };
  requestAnimationFrame(tick);
}
