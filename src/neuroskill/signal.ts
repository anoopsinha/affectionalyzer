import type { EegBands } from './types';

/**
 * The simulated EEG signal, shared by the Node mock daemon and the in-browser
 * demo.
 *
 * One implementation, two consumers. `tools/mock-daemon.ts` serves these frames
 * over a WebSocket for local development against the real client; the deployed
 * build generates them in the page, because a static host has no daemon to talk
 * to. Duplicating the maths would let the two drift, and every property the
 * synchrony estimator is tested against — the timescales, the coupling sweep,
 * the drift — lives here.
 *
 * Everything is a deterministic function of wall-clock time, with no state to
 * diverge, so two subjects generated independently still agree on the component
 * they share.
 */

export const CHANNELS = ['TP9', 'AF7', 'AF8', 'TP10'];

/** Smooth pseudo-random-looking signal in -1..1 from incommensurable periods. */
function wobble(t: number, periods: number[], phase: number): number {
  let v = 0;
  let w = 0;
  for (let i = 0; i < periods.length; i += 1) {
    const amp = 1 / (i + 1);
    v += amp * Math.sin(t / periods[i] + phase * (i + 1.7));
    w += amp;
  }
  return v / w;
}

/**
 * The signal both subjects share.
 *
 * Every period is far longer than any lag worth simulating. An earlier version
 * included 1.7 s and 3.3 s components, and a 1250 ms lag landed close to
 * antiphase on those — the pair came out *anti*-correlated at r = -0.58 with no
 * recoverable peak, which is a lag artefact rather than the following behaviour
 * it models. Slow periods also match the real signal, where FAA arrives already
 * smoothed on roughly a 5 s constant.
 */
const latent = (t: number) => wobble(t, [37000, 19000, 11000, 6500], 0.4);

/** One subject's private component, on the same timescales but uncorrelated. */
const own = (t: number, seed: number) => wobble(t, [31000, 16000, 9000, 5200], seed * 0.618);

/**
 * Coupling sweeps linearly over a bounded, higher band.
 *
 * A sine dwells near its turning points, parking the pair at "no coupling" and
 * "identical" — the two states where the surrogate test saturates. And the
 * synchrony window slides over a signal that keeps moving, so coupling that
 * swings hard *within* two minutes depresses the correlation for the whole
 * window: a fast sweep across the full range spent half its time reading zero.
 */
export const COUPLING_MIN = 0.6;
export const COUPLING_MAX = 0.9;
export const COUPLING_PERIOD_MS = 600_000;

export function couplingAt(t: number, baseline: number): number {
  const phase = (((t / COUPLING_PERIOD_MS) % 1) + 1) % 1;
  const triangle = phase < 0.5 ? phase * 2 : 2 - phase * 2;
  const span = (COUPLING_MAX - COUPLING_MIN) * (0.5 + baseline);
  return Math.min(COUPLING_MAX, Math.max(COUPLING_MIN, COUPLING_MIN + triangle * span));
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const score = (v: number) => Math.round(clamp01((v + 1) / 2) * 1000) / 10;

export interface SubjectOptions {
  /** Distinguishes this subject's private component from the other's. */
  seed: number;
  /** Baseline share of the shared signal, before the sweep. */
  coupling: number;
  /** Sample the shared signal this late, so this subject genuinely follows. */
  lagMs: number;
  /** Frames per second, for the running sample count. */
  hz: number;
}

/** One `EegBands` frame for one subject at wall-clock time `now`. */
export function frameAt(now: number, opts: SubjectOptions): EegBands {
  const { seed, coupling, lagMs, hz } = opts;
  const t = now - lagMs;
  const k = couplingAt(now, coupling);
  const core = k * latent(t) + (1 - k) * own(t, seed);

  // A slow ramp on top, because real sessions drift and the correlation maths
  // is supposed to detrend it away rather than read it as coupling.
  const drift = 0.25 * Math.sin(now / 130000);
  const valence = Math.max(-1, Math.min(1, core + drift));
  const arousalCore = 0.7 * core + 0.3 * own(t, seed + 11);

  const engagement = score(arousalCore);
  const cognitiveLoad = score(0.6 * arousalCore + 0.4 * own(t, seed + 3));
  const drowsiness = score(-0.7 * arousalCore + 0.3 * own(t, seed + 5));
  const relaxation = score(-0.5 * arousalCore + 0.5 * own(t, seed + 7));

  /*
   * Relative band powers must sum to 1 — the bars read them as a composition.
   *
   * These get their own fast wobble rather than riding `own()`. The coupling
   * signal is deliberately slow, but band strength is not part of it and
   * inherited the slowness for no reason: the markers barely moved.
   */
  const band = (s: number) => wobble(t, [9000, 4100, 1900, 900], s * 0.437);
  const raw: Record<string, number> = {
    rel_delta: 0.12 + 0.1 * (1 + band(seed + 13)),
    rel_theta: 0.14 + 0.11 * (1 + band(seed + 17)),
    rel_alpha: 0.18 + 0.16 * (1 - arousalCore) + 0.06 * band(seed + 23),
    rel_beta: 0.14 + 0.15 * (1 + arousalCore) + 0.06 * band(seed + 29),
    rel_gamma: 0.05 + 0.06 * (1 + band(seed + 19)),
  };
  const total = Object.values(raw).reduce((s, v) => s + v, 0);
  const rel = Object.fromEntries(Object.entries(raw).map(([key, v]) => [key, v / total]));

  const channels = CHANNELS.map((channel, i) => {
    const jitter = 1 + 0.18 * band(seed + 41 + i * 7);
    const c = Object.entries(rel).map(([key, v]) => [key, v * jitter] as const);
    const sum = c.reduce((s, [, v]) => s + v, 0);
    const norm = Object.fromEntries(c.map(([key, v]) => [key, v / sum]));
    return {
      channel,
      delta: norm.rel_delta * 40,
      theta: norm.rel_theta * 40,
      alpha: norm.rel_alpha * 40,
      beta: norm.rel_beta * 40,
      gamma: norm.rel_gamma * 40,
      high_gamma: 0.5,
      ...norm,
      rel_high_gamma: 0.01,
      dominant: 'alpha',
      dominant_symbol: 'α',
      dominant_color: '#1baf7a',
    };
  });

  return {
    timestamp: now / 1000,
    channels,
    // FAA is the quantity mood is derived from; keep them consistent so the
    // hero figure and its FAA subtitle cannot disagree.
    faa: valence * 1.2,
    mood: score(valence),
    laterality_index: valence * 0.8,
    engagement,
    focus: engagement,
    relaxation,
    meditation: score(-0.4 * arousalCore + 0.6 * own(t, seed + 29)),
    cognitive_load: cognitiveLoad,
    drowsiness,
    ...rel,
    snr: 12 + 4 * own(t, seed + 31),
    apf: 10.2,
    sef95: 24,
    spectral_centroid: 12,
    pse: 0.8,
    coherence: 0.5,
    tar: 1.2,
    bar: 0.9,
    dtr: 1.1,
    tbr: 1.3,
    higuchi_fd: 1.6,
    permutation_entropy: 0.9,
    sample_entropy: 1.1,
    dfa_exponent: 0.8,
    hjorth_activity: 1,
    hjorth_mobility: 0.5,
    hjorth_complexity: 1.4,
    consciousness_lzc: 60,
    consciousness_wakefulness: score(arousalCore),
    consciousness_integration: 55,
    blink_count: 0,
    blink_rate: 12,
    samples_per_frame: Math.round(256 / hz),
  } as unknown as EegBands;
}
