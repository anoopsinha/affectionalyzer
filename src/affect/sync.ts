/**
 * Interpersonal synchrony between two affect streams.
 *
 * This is the hyperscanning half of the app: not "what is this brain doing" but
 * "are these two brains doing the same thing at the same time".
 *
 * Three deliberate choices, because each is a place where a plausible-looking
 * number would be wrong:
 *
 * 1. **Time base is local arrival, not the daemon timestamp.** The two daemons
 *    run on different machines with independent wall clocks; a second of NTP
 *    skew would shift one series against the other and quietly fabricate (or
 *    destroy) correlation. Both streams arrive at *this* process, so tagging
 *    them on arrival puts them on one clock. The cost is the transport delay —
 *    ~10 ms over a LAN SSH tunnel, against signals already smoothed at ~1.5 s.
 *
 * 2. **Resample onto a fixed grid before correlating.** The streams are ~8 Hz
 *    but not aligned and not evenly spaced, and Pearson over raw index pairs
 *    would be comparing samples taken at different moments.
 *
 * 3. **Report a surrogate floor next to every r.** Two smoothed, autocorrelated
 *    signals correlate with each other by construction — feed this white noise
 *    through a 1.5 s EMA and it will still show |r| well above zero. The
 *    surrogate is the same computation against time-shifted data, so it
 *    estimates that floor rather than pretending it is not there. An r that does
 *    not clear its surrogate is not evidence of anything.
 */

/** Resampling grid. 4 Hz is well above the ~1.5 s smoothing already applied. */
const GRID_MS = 250;

/** Correlation epoch. Long enough for a stable r, short enough to feel live. */
export const SYNC_WINDOW_MS = 60_000;

/**
 * A held sample older than this counts as missing rather than being carried
 * forward. Without it, a dropped stream flatlines into a constant that either
 * correlates spuriously or silently zeroes the variance.
 */
const MAX_HOLD_MS = 1_500;

/** Lag search range for the leader/follower readout. */
const MAX_LAG_MS = 4_000;

/**
 * Surrogates are circular rotations of one series within the epoch. Rotation
 * preserves each signal's own spectrum and autocorrelation exactly while
 * destroying the timing relationship between them, which is precisely the null
 * hypothesis worth testing against.
 *
 * Rotations smaller than `SURROGATE_MIN_ROTATION_MS` are skipped: those still
 * overlap the signal's own autocorrelation and would land in the alternative
 * rather than the null.
 */
const SURROGATE_MIN_ROTATION_MS = 8_000;
const SURROGATE_COUNT = 12;

export interface Correlation {
  /** Pearson r at zero lag, -1..1. */
  r: number;
  /** Samples on the common grid that contributed. */
  n: number;
  /**
   * Strongest |r| any time-shifted control reached — the level this pair hits by
   * autocorrelation alone. `r` means something only above it. This is the upper
   * tail of the null rather than its centre, which is what keeps the test
   * honest: against 40 simulated independent pairs of 1.5 s-smoothed noise the
   * raw |r| ran to a median of 0.12 and a maximum of 0.30, while this floor cut
   * the false-positive rate to 5% and still flagged every pair sharing 55% of a
   * common signal. See `sync.test.ts`.
   */
  surrogate: number;
  /**
   * Lag of peak correlation, in ms. Positive means the partner's series matches
   * the subject's *earlier* values, i.e. the partner follows.
   */
  peakLagMs: number;
  /** Pearson r at `peakLagMs`. */
  peakR: number;
  /**
   * Surrogate floor for `peakR`. Higher than `surrogate` because the lag sweep
   * itself is a maximisation over ~33 tries and inflates |r| on its own; the
   * controls are swept the same way so the comparison stays fair.
   */
  peakSurrogate: number;
}

export interface SyncResult {
  valence: Correlation | null;
  arousal: Correlation | null;
  /** Euclidean distance between the two current circumplex points, 0..2√2. */
  distance: number | null;
  /** Fraction of the epoch where both streams had a fresh sample, 0..1. */
  coverage: number;
}

interface Point {
  t: number;
  value: number;
}

/** One side of one measure, as an arrival-time-ordered ring of samples. */
class Track {
  private points: Point[] = [];

  push(t: number, value: number): void {
    if (!Number.isFinite(value)) return;
    this.points.push({ t, value });
  }

  prune(cutoff: number): void {
    let drop = 0;
    while (drop < this.points.length && this.points[drop].t < cutoff) drop += 1;
    if (drop > 0) this.points.splice(0, drop);
  }

  get last(): Point | null {
    return this.points.length ? this.points[this.points.length - 1] : null;
  }

  /**
   * Zero-order hold onto `grid`. Returns NaN wherever the most recent sample is
   * older than `MAX_HOLD_MS`, which the correlation then treats as missing.
   */
  sampleOnto(grid: number[]): number[] {
    const out = new Array<number>(grid.length);
    let i = 0;
    for (let g = 0; g < grid.length; g += 1) {
      const t = grid[g];
      while (i + 1 < this.points.length && this.points[i + 1].t <= t) i += 1;
      const p = this.points[i];
      out[g] = p && p.t <= t && t - p.t <= MAX_HOLD_MS ? p.value : NaN;
    }
    return out;
  }
}

export interface SyncSample {
  valence: number;
  arousal: number;
}

export class SyncModel {
  private selfValence = new Track();
  private selfArousal = new Track();
  private partnerValence = new Track();
  private partnerArousal = new Track();

  /**
   * Surrogates rotate within the epoch, so no pre-epoch history is needed —
   * just a little slack so the grid's oldest cell still has a sample to hold.
   */
  private readonly retainMs = SYNC_WINDOW_MS + 5_000;

  /**
   * `t` is the local arrival time, not the daemon's timestamp — see the module
   * comment. Callers pass `Date.now()` at the moment the frame is handled.
   */
  push(source: 'self' | 'partner', sample: SyncSample, t: number): void {
    if (source === 'self') {
      this.selfValence.push(t, sample.valence);
      this.selfArousal.push(t, sample.arousal);
    } else {
      this.partnerValence.push(t, sample.valence);
      this.partnerArousal.push(t, sample.arousal);
    }
    const cutoff = t - this.retainMs;
    this.selfValence.prune(cutoff);
    this.selfArousal.prune(cutoff);
    this.partnerValence.prune(cutoff);
    this.partnerArousal.prune(cutoff);
  }

  /** Current straight-line separation in the circumplex plane. */
  private currentDistance(now: number): number | null {
    const sv = this.selfValence.last;
    const sa = this.selfArousal.last;
    const pv = this.partnerValence.last;
    const pa = this.partnerArousal.last;
    if (!sv || !sa || !pv || !pa) return null;
    // Both sides must be live; a frozen stream should not report a distance.
    if (now - sv.t > MAX_HOLD_MS || now - pv.t > MAX_HOLD_MS) return null;
    return Math.hypot(sv.value - pv.value, sa.value - pa.value);
  }

  compute(now: number): SyncResult {
    const grid: number[] = [];
    for (let t = now - SYNC_WINDOW_MS; t <= now; t += GRID_MS) grid.push(t);

    const sv = this.selfValence.sampleOnto(grid);
    const pv = this.partnerValence.sampleOnto(grid);
    const sa = this.selfArousal.sampleOnto(grid);
    const pa = this.partnerArousal.sampleOnto(grid);

    let both = 0;
    for (let i = 0; i < grid.length; i += 1) {
      if (!Number.isNaN(sv[i]) && !Number.isNaN(pv[i])) both += 1;
    }

    return {
      valence: correlate(sv, pv),
      arousal: correlate(sa, pa),
      distance: this.currentDistance(now),
      coverage: grid.length ? both / grid.length : 0,
    };
  }

  clear(): void {
    this.selfValence = new Track();
    this.selfArousal = new Track();
    this.partnerValence = new Track();
    this.partnerArousal = new Track();
  }
}

/** Minimum paired grid points before an r is worth reporting (~10 s at 4 Hz). */
const MIN_N = 40;

function correlate(a: number[], b: number[]): Correlation | null {
  const base = pearson(a, b);
  if (!base || base.n < MIN_N) return null;

  const swept = sweepLags(a, b, base.r);

  // Surrogate floor: rotate B within the epoch and redo the whole computation.
  // Rotation keeps B's own spectrum intact and only destroys its alignment with
  // A, so whatever correlation survives is the autocorrelation artefact.
  const minRot = Math.round(SURROGATE_MIN_ROTATION_MS / GRID_MS);
  const usable = a.length - 2 * minRot;
  let surrogate = NaN;
  let peakSurrogate = NaN;
  if (usable > SURROGATE_COUNT) {
    const step = Math.floor(usable / SURROGATE_COUNT);
    let zeroLagMax = 0;
    let sweptMax = 0;
    let got = 0;
    for (let i = 0; i < SURROGATE_COUNT; i += 1) {
      const rotated = rotate(b, minRot + i * step);
      const res = pearson(a, rotated);
      if (!res || res.n < MIN_N) continue;
      got += 1;
      zeroLagMax = Math.max(zeroLagMax, Math.abs(res.r));
      sweptMax = Math.max(sweptMax, Math.abs(sweepLags(a, rotated, res.r).peakR));
    }
    if (got) {
      surrogate = zeroLagMax;
      peakSurrogate = sweptMax;
    }
  }

  return {
    r: base.r,
    n: base.n,
    surrogate,
    peakLagMs: swept.peakLagMs,
    peakR: swept.peakR,
    peakSurrogate,
  };
}

/**
 * Strongest association across ±`MAX_LAG_MS`. Kept separate from the zero-lag r
 * so a genuine lead/lag relationship shows up as a lag rather than being
 * smeared into a weak instantaneous number.
 */
function sweepLags(a: number[], b: number[], zeroLagR: number): { peakR: number; peakLagMs: number } {
  const maxSteps = Math.round(MAX_LAG_MS / GRID_MS);
  let peakR = zeroLagR;
  let peakLagMs = 0;
  for (let k = -maxSteps; k <= maxSteps; k += 1) {
    if (k === 0) continue;
    const res = pearson(a, shift(b, k));
    if (res && res.n >= MIN_N && Math.abs(res.r) > Math.abs(peakR)) {
      peakR = res.r;
      peakLagMs = k * GRID_MS;
    }
  }
  return { peakR, peakLagMs };
}

/** Shift `xs` by `k` grid steps, padding with NaN so padding never correlates. */
function shift(xs: number[], k: number): number[] {
  const out = new Array<number>(xs.length).fill(NaN);
  for (let i = 0; i < xs.length; i += 1) {
    const j = i + k;
    if (j >= 0 && j < xs.length) out[i] = xs[j];
  }
  return out;
}

/** Circular rotation by `k` steps — wraps rather than padding, unlike `shift`. */
function rotate(xs: number[], k: number): number[] {
  const n = xs.length;
  const out = new Array<number>(n);
  for (let i = 0; i < n; i += 1) out[i] = xs[(i + k) % n];
  return out;
}

/**
 * Pearson r over pairs where both series are present. Returns null when either
 * side has no variance — a flat signal has no correlation to report, and the
 * usual formula would divide by zero and yield NaN dressed up as a result.
 */
function pearson(a: number[], b: number[]): { r: number; n: number } | null {
  let n = 0;
  let sa = 0;
  let sb = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (Number.isNaN(a[i]) || Number.isNaN(b[i])) continue;
    n += 1;
    sa += a[i];
    sb += b[i];
  }
  if (n < 2) return null;

  const ma = sa / n;
  const mb = sb / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (Number.isNaN(a[i]) || Number.isNaN(b[i])) continue;
    const xa = a[i] - ma;
    const xb = b[i] - mb;
    num += xa * xb;
    da += xa * xa;
    db += xb * xb;
  }
  if (da <= 0 || db <= 0) return null;

  const r = num / Math.sqrt(da * db);
  return { r: Math.max(-1, Math.min(1, r)), n };
}

/**
 * How an r should be read given its surrogate floor. Deliberately coarse: the
 * honest resolution of a single unreplicated 60 s window is three or four
 * buckets, not a p-value.
 */
export type SyncVerdict = 'none' | 'weak' | 'moderate' | 'strong';

export function verdictOf(c: Correlation | null): SyncVerdict {
  if (!c) return 'none';
  return gradeExcess(Math.abs(c.r), c.surrogate);
}

/** Same grading for the lagged peak, against its own (higher) floor. */
export function peakVerdictOf(c: Correlation | null): SyncVerdict {
  if (!c) return 'none';
  return gradeExcess(Math.abs(c.peakR), c.peakSurrogate);
}

function gradeExcess(magnitude: number, floor: number): SyncVerdict {
  // A missing floor means too little data to have built controls yet. Assume a
  // pessimistic one rather than reporting coupling that was never tested.
  const excess = magnitude - (Number.isFinite(floor) ? floor : 0.6);
  if (excess < 0.05) return 'none';
  if (excess < 0.2) return 'weak';
  if (excess < 0.4) return 'moderate';
  return 'strong';
}

export const VERDICT_LABEL: Record<SyncVerdict, string> = {
  none: 'No coupling above chance',
  weak: 'Weak coupling',
  moderate: 'Moderate coupling',
  strong: 'Strong coupling',
};
