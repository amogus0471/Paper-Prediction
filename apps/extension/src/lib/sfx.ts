/**
 * Order sound effects, synthesized at runtime.
 *
 * No .mp3 files. Shipping audio binaries would add weight to a content script
 * that runs on every page load, and inline data: URIs trip the CSP. A few
 * oscillators cost nothing, ship as ~2 KB of code, and let each sound carry
 * real information rather than just being a click:
 *
 *   fill     rising major third  — it went through
 *   partial  rising, then flat   — you got some of it
 *   reject   falling minor       — it did not go through
 *   settle   bright arpeggio     — the market resolved
 *
 * A trader should be able to tell a fill from a rejection without looking.
 */

type Ctx = AudioContext;

let ctx: Ctx | null = null;

function audio(): Ctx | null {
  if (typeof AudioContext === 'undefined') return null;
  if (!ctx) {
    try {
      ctx = new AudioContext();
    } catch {
      return null;
    }
  }
  // Browsers suspend contexts created before a gesture; every play attempt
  // nudges it awake rather than failing silently forever.
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

interface ToneSpec {
  freq: number;
  start: number;
  duration: number;
  type?: OscillatorType;
  gain?: number;
  /** Optional glide target — a tone that bends carries more character. */
  slideTo?: number;
}

function play(tones: ToneSpec[], volume: number): void {
  const ac = audio();
  if (!ac || volume <= 0) return;

  const master = ac.createGain();
  master.gain.value = Math.min(1, Math.max(0, volume));
  master.connect(ac.destination);

  const now = ac.currentTime;

  for (const t of tones) {
    const osc = ac.createOscillator();
    const env = ac.createGain();

    osc.type = t.type ?? 'sine';
    osc.frequency.setValueAtTime(t.freq, now + t.start);
    if (t.slideTo) {
      osc.frequency.exponentialRampToValueAtTime(t.slideTo, now + t.start + t.duration);
    }

    // Short attack, exponential decay. A linear fade reads as a "beep"; the
    // exponential tail is what makes it sound like an instrument.
    const peak = t.gain ?? 0.3;
    env.gain.setValueAtTime(0.0001, now + t.start);
    env.gain.exponentialRampToValueAtTime(peak, now + t.start + 0.008);
    env.gain.exponentialRampToValueAtTime(0.0001, now + t.start + t.duration);

    osc.connect(env);
    env.connect(master);
    osc.start(now + t.start);
    osc.stop(now + t.start + t.duration + 0.02);
  }

  // Release the master node once the longest tone has finished.
  const tail = tones.reduce((m, t) => Math.max(m, t.start + t.duration), 0);
  setTimeout(() => master.disconnect(), (tail + 0.1) * 1000);
}

export type SoundName = 'fill' | 'partial' | 'reject' | 'settle' | 'tick';

const SOUNDS: Record<SoundName, (v: number) => void> = {
  // C5 -> E5. Confident, resolved, over quickly.
  fill: (v) =>
    play(
      [
        { freq: 523.25, start: 0, duration: 0.09, type: 'triangle', gain: 0.35 },
        { freq: 659.25, start: 0.06, duration: 0.16, type: 'triangle', gain: 0.3 },
      ],
      v,
    ),

  // Same opening, but the second note does not lift — you got part of it.
  partial: (v) =>
    play(
      [
        { freq: 523.25, start: 0, duration: 0.09, type: 'triangle', gain: 0.32 },
        { freq: 587.33, start: 0.06, duration: 0.13, type: 'triangle', gain: 0.26 },
        { freq: 587.33, start: 0.19, duration: 0.1, type: 'triangle', gain: 0.18 },
      ],
      v,
    ),

  // A4 -> F4, bending down. Unmistakably "no".
  reject: (v) =>
    play(
      [
        { freq: 440, start: 0, duration: 0.13, type: 'sawtooth', gain: 0.16, slideTo: 349.23 },
        { freq: 220, start: 0.02, duration: 0.16, type: 'sine', gain: 0.14 },
      ],
      v,
    ),

  // C-E-G-C. The market resolved; you found out whether you were right.
  settle: (v) =>
    play(
      [
        { freq: 523.25, start: 0, duration: 0.1, type: 'triangle', gain: 0.26 },
        { freq: 659.25, start: 0.07, duration: 0.1, type: 'triangle', gain: 0.26 },
        { freq: 783.99, start: 0.14, duration: 0.12, type: 'triangle', gain: 0.26 },
        { freq: 1046.5, start: 0.21, duration: 0.22, type: 'triangle', gain: 0.22 },
      ],
      v,
    ),

  // Barely-there UI click for size increments.
  tick: (v) => play([{ freq: 880, start: 0, duration: 0.03, type: 'sine', gain: 0.08 }], v * 0.6),
};

export function playSound(name: SoundName, volume = 0.35, enabled = true): void {
  if (!enabled) return;
  try {
    SOUNDS[name]?.(volume);
  } catch {
    // Audio is a nicety. It must never break an order.
  }
}
