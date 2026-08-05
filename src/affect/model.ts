import type { EegBands } from '../neuroskill/types';

/**
 * Maps NeuroSkill metrics onto Russell's circumplex model of affect: emotion as
 * a point in a valence x arousal plane rather than a discrete category.
 *
 * Valence comes straight from the daemon's `mood` index, which is frontal alpha
 * asymmetry rescaled to 0-100. That mapping is well grounded — FAA is the most
 * studied EEG correlate of approach/withdrawal motivation (Coan & Allen 2004).
 *
 * Arousal has no single canonical index, so it is a *choice*, surfaced in the
 * UI rather than hidden here. See `AROUSAL_SOURCES`.
 */

export interface AffectSample {
  /**
   * Daemon timestamp, milliseconds since the Unix epoch. Authoritative for
   * ordering and windowing *within* one stream.
   */
  t: number;
  /**
   * When this process received the frame. Two daemons on two machines keep
   * independent wall clocks, so `t` values from different streams are not
   * comparable and anything plotting both against one time axis must use this
   * instead. Same reasoning as `affect/sync.ts`.
   */
  tLocal: number;
  /** -1 (withdrawal / negative) .. +1 (approach / positive). */
  valence: number;
  /** -1 (deactivated / calm) .. +1 (activated / alert). */
  arousal: number;
  /**
   * Smoothed mood on the original 0-100 scale — `valence` rescaled back.
   * Everything user-facing reads this so the hero figure, the trend line and
   * the circumplex point can never disagree about the same instant.
   */
  moodSmooth: number;
  /** Unsmoothed 0-100 daemon score, kept for the table view. */
  mood: number;
  faa: number;
  engagement: number;
  cognitiveLoad: number;
  relaxation: number;
  meditation: number;
  drowsiness: number;
  snr: number;
}

export interface ArousalSource {
  id: string;
  label: string;
  /** Shown in the UI so the derivation is never a black box. */
  formula: string;
  compute: (b: EegBands) => number;
}

const num = (v: unknown, fallback = 0): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;

/**
 * Composite weights are a judgement call, not something the daemon or the
 * literature specifies. Engagement (beta/(alpha+theta)) is the classic
 * biocybernetic activation index so it leads; cognitive load adds frontal-theta
 * effort; inverted drowsiness keeps a fading subject from reading as "calm"
 * when they are really falling asleep.
 */
const COMPOSITE_WEIGHTS = { engagement: 0.5, cognitiveLoad: 0.3, alertness: 0.2 };

export const AROUSAL_SOURCES: ArousalSource[] = [
  {
    id: 'composite',
    label: 'Composite',
    formula: '0.5·engagement + 0.3·cognitive load + 0.2·(100 − drowsiness)',
    compute: (b) =>
      COMPOSITE_WEIGHTS.engagement * num(b.engagement) +
      COMPOSITE_WEIGHTS.cognitiveLoad * num(b.cognitive_load) +
      COMPOSITE_WEIGHTS.alertness * (100 - num(b.drowsiness)),
  },
  {
    id: 'engagement',
    label: 'Engagement',
    formula: 'engagement = β / (α + θ), normalised 0–100',
    compute: (b) => num(b.engagement),
  },
  {
    id: 'cognitive_load',
    label: 'Cognitive load',
    formula: 'frontal θ / temporal α, normalised 0–100',
    compute: (b) => num(b.cognitive_load),
  },
  {
    id: 'wakefulness',
    label: 'Wakefulness',
    formula: 'consciousness_wakefulness, normalised 0–100',
    compute: (b) => num(b.consciousness_wakefulness),
  },
];

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Map a 0-100 daemon score onto the circumplex's -1..1 axis. */
const toAxis = (score0to100: number) => clamp((score0to100 - 50) / 50, -1, 1);

/**
 * Exponential smoothing over wall-clock gaps.
 *
 * Frame-count smoothing would change behaviour whenever the stream stutters,
 * which BLE guarantees it will, so the decay is tied to elapsed time instead.
 */
class TimeEma {
  private value: number | null = null;
  private lastT = 0;

  constructor(private tauMs: number) {}

  push(v: number, t: number): number {
    if (!Number.isFinite(v)) return this.value ?? 0;
    if (this.value === null) {
      this.value = v;
      this.lastT = t;
      return v;
    }
    const dt = Math.max(0, t - this.lastT);
    const alpha = 1 - Math.exp(-dt / this.tauMs);
    this.value += alpha * (v - this.value);
    this.lastT = t;
    return this.value;
  }

  get current(): number | null {
    return this.value;
  }

  reset(): void {
    this.value = null;
  }
}

/**
 * A retained raw frame plus the moment it arrived, so a replay reproduces the
 * original timeline instead of stamping the whole window with the replay time.
 */
export interface ReplayFrame {
  bands: EegBands;
  tLocal: number;
}

export interface AffectModelOptions {
  /** How much history the trail and time series can draw. */
  windowMs?: number;
  /** Smoothing constant for the plotted point. FAA itself is already EMA'd ~5 s. */
  smoothingTauMs?: number;
}

export class AffectModel {
  private samples: AffectSample[] = [];
  private valenceEma: TimeEma;
  private arousalEma: TimeEma;
  private source: ArousalSource = AROUSAL_SOURCES[0];

  readonly windowMs: number;

  constructor(opts: AffectModelOptions = {}) {
    this.windowMs = opts.windowMs ?? 120_000;
    const tau = opts.smoothingTauMs ?? 1500;
    this.valenceEma = new TimeEma(tau);
    this.arousalEma = new TimeEma(tau);
  }

  get arousalSource(): ArousalSource {
    return this.source;
  }

  /**
   * Switching the arousal definition recomputes history so the trail matches the
   * new axis instead of showing a discontinuity where the setting changed.
   */
  setArousalSource(id: string, replay: readonly ReplayFrame[] = []): void {
    const next = AROUSAL_SOURCES.find((s) => s.id === id);
    if (!next || next === this.source) return;
    this.source = next;
    this.arousalEma.reset();
    if (replay.length) {
      this.samples = [];
      this.valenceEma.reset();
      for (const f of replay) this.push(f.bands, f.tLocal);
    }
  }

  /**
   * `tLocal` defaults to now, but replays pass the original arrival time so that
   * switching the arousal source does not restamp the whole window to this
   * instant and collapse the partner overlay onto a single x position.
   */
  push(bands: EegBands, tLocal = Date.now()): AffectSample {
    // The daemon's `timestamp` is fractional seconds; trust it over the local
    // clock so ordering survives a burst of buffered frames after a reconnect.
    const t = Number.isFinite(bands.timestamp) ? bands.timestamp * 1000 : Date.now();

    const mood = num(bands.mood, 50);
    const arousalScore = clamp(this.source.compute(bands), 0, 100);

    const moodSmooth = this.valenceEma.push(mood, t);

    const sample: AffectSample = {
      t,
      tLocal,
      valence: toAxis(moodSmooth),
      arousal: toAxis(this.arousalEma.push(arousalScore, t)),
      moodSmooth,
      mood,
      faa: num(bands.faa),
      engagement: num(bands.engagement),
      cognitiveLoad: num(bands.cognitive_load),
      relaxation: num(bands.relaxation),
      meditation: num(bands.meditation),
      drowsiness: num(bands.drowsiness),
      snr: num(bands.snr),
    };

    this.samples.push(sample);
    const cutoff = t - this.windowMs;
    let drop = 0;
    while (drop < this.samples.length && this.samples[drop].t < cutoff) drop += 1;
    if (drop > 0) this.samples.splice(0, drop);

    return sample;
  }

  get history(): readonly AffectSample[] {
    return this.samples;
  }

  get latest(): AffectSample | null {
    return this.samples.length ? this.samples[this.samples.length - 1] : null;
  }

  /** Mean position over the trailing `ms`, used for the "recent average" marker. */
  meanOver(ms: number): { valence: number; arousal: number } | null {
    if (!this.samples.length) return null;
    const cutoff = this.samples[this.samples.length - 1].t - ms;
    let v = 0;
    let a = 0;
    let n = 0;
    for (let i = this.samples.length - 1; i >= 0; i -= 1) {
      if (this.samples[i].t < cutoff) break;
      v += this.samples[i].valence;
      a += this.samples[i].arousal;
      n += 1;
    }
    return n ? { valence: v / n, arousal: a / n } : null;
  }

  clear(): void {
    this.samples = [];
    this.valenceEma.reset();
    this.arousalEma.reset();
  }
}

/** Russell quadrant label for a point, used in the live readout. */
export function quadrantLabel(valence: number, arousal: number): string {
  const deadzone = 0.08;
  if (Math.abs(valence) < deadzone && Math.abs(arousal) < deadzone) return 'Neutral';
  if (arousal >= 0) return valence >= 0 ? 'Excited' : 'Tense';
  return valence >= 0 ? 'Calm' : 'Subdued';
}
