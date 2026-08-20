/**
 * Tests for the session state machine.
 *
 * Run with `npm test`. The flow is pure logic over timers, so it is driven here
 * with a fake clock rather than a browser — every transition is asserted at the
 * exact millisecond it should and should not have happened, which no amount of
 * watching the screen would establish.
 */

// The fake clock must exist before SessionFlow schedules anything against it.
interface FakeTimer {
  id: number;
  at: number;
  fn: () => void;
}

let now = 1_700_000_000_000;
let nextId = 1;
const timers: FakeTimer[] = [];

(globalThis as unknown as { window: unknown }).window = {
  setTimeout(fn: () => void, ms: number) {
    const id = nextId++;
    timers.push({ id, at: now + ms, fn });
    return id;
  },
  clearTimeout(id: number) {
    const i = timers.findIndex((t) => t.id === id);
    if (i >= 0) timers.splice(i, 1);
  },
};

Date.now = () => now;

/** Advance the clock, firing every timer that falls due, in order. */
function advance(ms: number): void {
  const target = now + ms;
  for (;;) {
    const due = timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
    if (!due) break;
    timers.splice(timers.indexOf(due), 1);
    now = due.at;
    due.fn();
  }
  now = target;
}

// Dynamic import, not a static one: the fake `window` above must exist before
// the module under test is evaluated, and static imports hoist above it.
const { SessionFlow, DEFAULT_TIMINGS } = await import('./flow');

// Marks the file a module so the top-level await above is legal.
export {};

const T = {
  pairedMs: 1000,
  calibratingMs: 4000,
  diagnosisMs: 3000,
  diagnosisWaitCapMs: 5000,
};

/** Most tests are not about the score gate, so they hand it a ready score. */
function ready(flow: InstanceType<typeof SessionFlow>) {
  flow.setDiagnosisReady(true);
  return flow;
}

const checks: Array<[string, boolean]> = [];
const check = (name: string, ok: boolean) => checks.push([name, ok]);

// --- A pair walks the whole sequence ---------------------------------------

{
  const flow = ready(new SessionFlow(T));
  check('starts in waiting', flow.phase === 'waiting');

  flow.setPaired(true);
  check('a configured pair with no data stays waiting', flow.phase === 'waiting');

  // Link alone must not advance it — that is the whole point of the readiness
  // rule, since the daemon answers with nothing on anyone's head.
  flow.setReady(true);
  check('both subjects ready enters paired', flow.phase === 'paired');

  advance(T.pairedMs - 1);
  check('paired holds for its full duration', flow.phase === 'paired');
  advance(1);
  check('paired advances to scanning', flow.phase === 'scanning');

  // Scanning is where both signals are confirmed, so it never advances itself.
  advance(T.calibratingMs * 10);
  check('scanning never advances on its own', flow.phase === 'scanning');
  flow.begin();
  check('Go advances to calibrating', flow.phase === 'calibrating');

  check('calibration starts at 0', flow.calibrationProgress === 0);
  advance(T.calibratingMs / 2);
  check('calibration reaches halfway', Math.abs(flow.calibrationProgress - 0.5) < 1e-9);
  advance(T.calibratingMs / 2 - 1);
  check('calibration holds until complete', flow.phase === 'calibrating');
  advance(1);
  check('calibration advances to the diagnosis', flow.phase === 'diagnosis');
  check('calibration progress is zero outside the count', flow.calibrationProgress === 0);

  advance(T.diagnosisMs - 1);
  check('the diagnosis holds for its full duration', flow.phase === 'diagnosis');
  advance(1);
  check('the diagnosis advances to live', flow.phase === 'live');
}

// --- Reset ------------------------------------------------------------------

{
  const flow = ready(new SessionFlow(T));
  flow.setPaired(true);
  flow.setReady(true);
  advance(T.pairedMs);
  flow.begin();
  advance(T.calibratingMs + T.diagnosisMs);
  check('reaches live before reset', flow.phase === 'live');

  flow.reset();
  // Reset clears readiness, so the next run needs its own score.
  flow.setDiagnosisReady(true);
  // Both subjects are still connected, so the wait resolves at once and the run
  // begins again at the pairing frame rather than stalling on a connect screen
  // that has nothing to wait for.
  check('reset restarts the sequence from the top', flow.phase === 'paired');
  advance(T.pairedMs);
  check('reset replays scanning', flow.phase === 'scanning');
  flow.begin();
  check('reset replays calibrating', flow.phase === 'calibrating');
  check('reset restarts the count at zero', flow.calibrationProgress === 0);
  advance(T.calibratingMs);
  check('reset re-runs the diagnosis', flow.phase === 'diagnosis');
  advance(T.diagnosisMs);
  check('reset runs back to live', flow.phase === 'live');
}

// Between real sessions the headsets come off, so reset should land on the
// connecting frame and stay there until the next pair is wearing them.
{
  const flow = ready(new SessionFlow(T));
  flow.setPaired(true);
  flow.setReady(true);
  advance(T.pairedMs);
  flow.begin();
  advance(T.calibratingMs + T.diagnosisMs);
  flow.setReady(false);
  flow.reset();
  flow.setDiagnosisReady(true);
  check('reset with a headset off waits at the connecting frame', flow.phase === 'waiting');
  advance(T.pairedMs * 10);
  check('it stays there while a headset is off', flow.phase === 'waiting');
  flow.setReady(true);
  check('and resumes when both are worn again', flow.phase === 'paired');
}

// --- Losing a subject mid-session -------------------------------------------

{
  const flow = ready(new SessionFlow(T));
  flow.setPaired(true);
  flow.setReady(true);
  advance(T.pairedMs);
  flow.begin();
  advance(T.calibratingMs + T.diagnosisMs);
  check('live before the drop', flow.phase === 'live');

  flow.setReady(false);
  check('losing a subject falls back to waiting', flow.phase === 'waiting');

  flow.setReady(true);
  check('recovering re-enters paired', flow.phase === 'paired');
  advance(T.pairedMs);
  flow.begin();
  advance(T.calibratingMs + T.diagnosisMs);
  check('recovery runs the sequence again', flow.phase === 'live');
}

// A drop *during* the run-up must not leave a stale timer that later fires and
// drags a disconnected session into calibration on its own.
{
  const flow = ready(new SessionFlow(T));
  flow.setPaired(true);
  flow.setReady(true);
  advance(T.pairedMs / 2);
  flow.setReady(false);
  check('a drop mid-run-up returns to waiting', flow.phase === 'waiting');
  advance(T.pairedMs * 10);
  check('no stale timer advances a disconnected session', flow.phase === 'waiting');
}

// --- Solo sessions ----------------------------------------------------------

{
  const flow = new SessionFlow(T);
  flow.setPaired(false);
  check('a solo session skips the ceremony', flow.phase === 'live');
  advance(T.pairedMs);
  flow.begin();
  advance(T.calibratingMs + T.diagnosisMs);
  check('a solo session stays live', flow.phase === 'live');
}

// A partner arriving mid-solo should start the pairing sequence, not jump in.
{
  const flow = new SessionFlow(T);
  flow.setPaired(false);
  flow.setPaired(true);
  check('gaining a partner leaves live for waiting', flow.phase === 'waiting');
  flow.setReady(true);
  check('gaining a partner then runs the sequence', flow.phase === 'paired');
}

// --- Waiting for a score ----------------------------------------------------

// The verdict frame must not open on "Inconclusive", so the count holds at 100%
// until there is something to deliver a verdict about.
{
  const flow = new SessionFlow(T);
  flow.setPaired(true);
  flow.setReady(true);
  advance(T.pairedMs);
  flow.begin();
  advance(T.calibratingMs);
  check('the count holds when no score exists yet', flow.phase === 'calibrating');
  check('and shows a finished count while it holds', flow.calibrationProgress === 1);

  // Short of the cap, so this is testing the hold rather than the backstop.
  advance(T.diagnosisWaitCapMs / 2);
  check('it keeps holding while there is still no score', flow.phase === 'calibrating');

  flow.setDiagnosisReady(true);
  check('a score arriving releases it at once', flow.phase === 'diagnosis');
}

// A pair whose data never becomes testable must not sit there forever.
{
  const flow = new SessionFlow(T);
  flow.setPaired(true);
  flow.setReady(true);
  advance(T.pairedMs);
  flow.begin();
  advance(T.calibratingMs);
  check('still waiting before the cap', flow.phase === 'calibrating');
  advance(T.diagnosisWaitCapMs);
  check('the cap releases it anyway', flow.phase === 'diagnosis');
}

// A score already in hand must not make the count end early.
{
  const flow = ready(new SessionFlow(T));
  flow.setPaired(true);
  flow.setReady(true);
  advance(T.pairedMs);
  flow.begin();
  advance(T.calibratingMs - 1);
  check('a ready score does not shorten the count', flow.phase === 'calibrating');
  advance(1);
  check('and it advances the moment the count ends', flow.phase === 'diagnosis');
}

// --- Pinned phase -----------------------------------------------------------

{
  const flow = new SessionFlow(T);
  flow.forcePhase('calibrating');
  check('forcePhase pins the phase', flow.phase === 'calibrating');
  check('a pinned count shows a legible value', flow.calibrationProgress > 0);
  advance(T.calibratingMs * 5);
  check('a pinned phase never advances', flow.phase === 'calibrating');
  flow.setReady(false);
  check('a pinned phase ignores readiness', flow.phase === 'calibrating');
  flow.reset();
  check('a pinned phase ignores reset', flow.phase === 'calibrating');
}

// --- Defaults ---------------------------------------------------------------

check(
  'the shipped timed holds stay under 30s',
  DEFAULT_TIMINGS.pairedMs + DEFAULT_TIMINGS.calibratingMs + DEFAULT_TIMINGS.diagnosisMs <
    30_000,
);

// Go is the only human-driven transition, so it must not fire from anywhere else.
{
  const flow = ready(new SessionFlow(T));
  flow.setPaired(true);
  flow.begin();
  check('Go does nothing while waiting', flow.phase === 'waiting');

  flow.setReady(true);
  flow.begin();
  check('Go does nothing during the paired splash', flow.phase === 'paired');

  advance(T.pairedMs);
  flow.begin();
  check('Go works on the scanning frame', flow.phase === 'calibrating');
  flow.begin();
  check('a second press does not skip ahead', flow.phase === 'calibrating');
}

// --- Report -----------------------------------------------------------------

let failed = 0;
for (const [name, ok] of checks) {
  if (!ok) failed += 1;
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}`);
}
if (failed) throw new Error(`${failed} of ${checks.length} flow checks failed`);
console.log(`\nall ${checks.length} passed`);
