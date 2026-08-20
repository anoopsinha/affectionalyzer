/**
 * The session state machine: what the screen is doing, as opposed to what the
 * data says.
 *
 * Two people sit down, put headsets on, and the app walks them from nothing to
 * a running session:
 *
 *   waiting → paired → scanning → calibrating → diagnosis → live
 *      ↑                    ⏸                                   │
 *      └──────────────────── reset ─────────────────────────────┘
 *
 * `scanning` is the one phase that does not advance on its own. It waits for
 * someone to press Go, because it is where you confirm both signals are actually
 * arriving — a timer would march past a headset with a dead electrode and
 * deliver a verdict built on it.
 *
 * Reset goes all the way back to `waiting`, because between sessions the
 * headsets are coming off one pair and going onto another. If they are still
 * being worn the wait resolves at once and the run starts again from the
 * pairing frame — sitting on "waiting for both headsets" while both are plainly
 * connected would be a screen telling an obvious lie.
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
  /*
   * No `scanningMs`: that frame waits for Go rather than for the clock.
   */
  /**
   * The count to 100%.
   *
   * Long enough that the index is normally ready when it ends — the surrogate
   * floor needs roughly 18 s of both streams before any score exists, and the
   * frames before this one supply about 8.5 s of that.
   */
  calibratingMs: number;
  /**
   * How long the count may hold at 100% waiting for a score.
   *
   * A backstop, not the normal path: without it a pair whose data never becomes
   * testable would sit on the counting screen forever.
   */
  diagnosisWaitCapMs: number;
  /** How long the verdict holds the screen before the full view takes over. */
  diagnosisMs: number;
}

export const DEFAULT_TIMINGS: FlowTimings = {
  pairedMs: 2_500,
  calibratingMs: 12_000,
  diagnosisWaitCapMs: 20_000,
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
  /** Whether there is an affection score to deliver a verdict about. */
  private diagnosisReady = false;
  /** Whether the count has finished and is only waiting on the score. */
  private countDone = false;

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
   * Whether a score exists yet.
   *
   * The verdict frame is the one moment the pair is asked to sit with a number,
   * so it must not open on "Inconclusive". The count holds at 100% until this is
   * true, which is what the screen claims to be doing anyway.
   */
  setDiagnosisReady(ready: boolean): void {
    if (this.diagnosisReady === ready) return;
    this.diagnosisReady = ready;
    if (ready && !this.pinned && this.current === 'calibrating' && this.countDone) {
      this.enter('diagnosis');
    }
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

  /**
   * Leave the scanning frame and start calculating.
   *
   * The only transition in the flow driven by a person rather than a clock.
   * Ignored anywhere else, so a stray press cannot skip a frame.
   */
  begin(): void {
    if (this.pinned || this.current !== 'scanning') return;
    this.enter('calibrating');
  }

  /**
   * Full reset: back to the start, connections untouched.
   *
   * Re-evaluates immediately rather than parking on `waiting`. With the headsets
   * still on, there is nothing to wait for and the sequence restarts from the
   * pairing frame; once they have actually been handed over, this is where it
   * sits until the new pair is wearing them.
   */
  reset(): void {
    if (this.pinned) return;
    // The previous session's readiness says nothing about the next one's.
    this.diagnosisReady = false;
    this.enter('waiting');
    this.evaluate();
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
        // Deliberately no timer. See `begin`.
        break;
      case 'calibrating':
        this.calibrationStart = Date.now();
        this.countDone = false;
        this.after(this.timings.calibratingMs, () => {
          this.countDone = true;
          if (this.diagnosisReady) {
            this.enter('diagnosis');
          } else {
            this.after(this.timings.diagnosisWaitCapMs, () => this.enter('diagnosis'));
          }
        });
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
