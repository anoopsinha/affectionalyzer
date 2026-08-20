/**
 * The session state machine: what the screen is doing, as opposed to what the
 * data says.
 *
 * Two people sit down, put headsets on, and the app walks them from nothing to
 * a running session:
 *
 *   waiting → paired → scanning → calibrating → diagnosis → live
 *                                      ↑                        │
 *                                      └────── reset ───────────┘
 *
 * Reset returns to `calibrating`, not to `paired` — the headsets have not gone
 * anywhere, only the people and their data have.
 *
 * A solo session skips the ceremony entirely and sits in `live`. Every frame
 * before `live` is about two subjects becoming a pair, which is not a thing that
 * happens when there is only one.
 */

export type Phase =
  | 'waiting'
  | 'paired'
  | 'scanning'
  | 'calibrating'
  | 'diagnosis'
  | 'live';

/** Phases that take over the whole screen rather than annotating the instrument. */
export const IS_TAKEOVER: Record<Phase, boolean> = {
  waiting: true,
  paired: true,
  scanning: false,
  calibrating: true,
  diagnosis: true,
  live: false,
};

export interface FlowTimings {
  /** "Paired successfully." Long enough to read, short enough not to annoy. */
  pairedMs: number;
  /** Instrument up and moving while the trails become more than a dot. */
  scanningMs: number;
  /** The count to 100%. */
  calibratingMs: number;
  /** How long the verdict holds the screen before the full view takes over. */
  diagnosisMs: number;
}

export const DEFAULT_TIMINGS: FlowTimings = {
  pairedMs: 2_500,
  scanningMs: 6_000,
  calibratingMs: 8_000,
  // Long enough to read a verdict, a directive and the small print without
  // feeling trapped by it.
  diagnosisMs: 9_000,
};

type Listener = (phase: Phase) => void;

export class SessionFlow {
  private current: Phase = 'waiting';
  private timer: number | null = null;
  /** Wall-clock start of the calibration count, for the progress readout. */
  private calibrationStart = 0;
  private listeners = new Set<Listener>();
  private ready = false;
  private paired = false;
  /** When set, the flow is frozen for inspection — see `forcePhase`. */
  private pinned = false;

  constructor(private timings: FlowTimings = DEFAULT_TIMINGS) {}

  get phase(): Phase {
    return this.current;
  }

  /** 0..1 through the calibration count; 0 outside it. */
  get calibrationProgress(): number {
    if (this.current !== 'calibrating') return 0;
    if (this.pinned) return 0.47;
    if (this.timings.calibratingMs <= 0) return 1;
    const elapsed = Date.now() - this.calibrationStart;
    return Math.min(1, Math.max(0, elapsed / this.timings.calibratingMs));
  }

  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Whether this is a two-subject session at all. A solo session has no pairing
   * ceremony to perform, so it goes straight to the instrument.
   */
  setPaired(paired: boolean): void {
    // No early return on an unchanged value. `paired` starts false and a solo
    // session's first call is `setPaired(false)`, so a change guard here would
    // skip the only evaluation that session ever gets and strand it on the
    // waiting frame forever. `evaluate` is idempotent; the guard was not.
    this.paired = paired;
    this.evaluate();
  }

  /**
   * Both subjects have a live daemon link *and* a connected headset.
   *
   * Link alone is not enough: the daemon answers happily with nothing on
   * anyone's head, and announcing "paired successfully" at that point would be
   * a lie about the one thing this frame exists to assert.
   */
  setReady(ready: boolean): void {
    this.ready = ready;
    this.evaluate();
  }

  /** Full reset: back to the calibration count, connections untouched. */
  reset(): void {
    if (this.pinned) return;
    this.enter('calibrating');
  }

  /**
   * Freeze the flow in one phase so it can be inspected without waiting for the
   * sequence — `?phase=calibrating`. Development only; nothing advances after.
   */
  forcePhase(phase: Phase): void {
    this.clearTimer();
    this.pinned = true;
    this.current = phase;
    this.emit();
  }

  private evaluate(): void {
    if (this.pinned) return;

    // A solo session has nothing to pair, so it is simply live once it has data.
    if (!this.paired) {
      if (this.current !== 'live') this.enter('live');
      return;
    }

    if (!this.ready) {
      // Losing a subject mid-session drops back to waiting rather than leaving a
      // half-dead instrument claiming to be a session. The models keep their
      // history, so reconnecting resumes rather than restarts.
      if (this.current !== 'waiting') this.enter('waiting');
      return;
    }

    if (this.current === 'waiting') this.enter('paired');
  }

  private enter(phase: Phase): void {
    this.clearTimer();
    this.current = phase;

    switch (phase) {
      case 'paired':
        this.after(this.timings.pairedMs, () => this.enter('scanning'));
        break;
      case 'scanning':
        this.after(this.timings.scanningMs, () => this.enter('calibrating'));
        break;
      case 'calibrating':
        this.calibrationStart = Date.now();
        this.after(this.timings.calibratingMs, () => this.enter('diagnosis'));
        break;
      case 'diagnosis':
        this.after(this.timings.diagnosisMs, () => this.enter('live'));
        break;
      default:
        break;
    }

    this.emit();
  }

  private after(ms: number, fn: () => void): void {
    this.timer = window.setTimeout(() => {
      this.timer = null;
      fn();
    }, ms);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private emit(): void {
    for (const fn of this.listeners) fn(this.current);
  }
}

/** `?phase=` override, for looking at a frame without sitting through the run-up. */
export function phaseFromQuery(search = window.location.search): Phase | null {
  const value = new URLSearchParams(search).get('phase');
  const valid: Phase[] = [
    'waiting',
    'paired',
    'scanning',
    'calibrating',
    'diagnosis',
    'live',
  ];
  return valid.includes(value as Phase) ? (value as Phase) : null;
}
