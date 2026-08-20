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

const T = { pairedMs: 1000, scanningMs: 2000, calibratingMs: 4000 };

const checks: Array<[string, boolean]> = [];
const check = (name: string, ok: boolean) => checks.push([name, ok]);

// --- A pair walks the whole sequence ---------------------------------------

{
  const flow = new SessionFlow(T);
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

  advance(T.scanningMs - 1);
  check('scanning holds for its full duration', flow.phase === 'scanning');
  advance(1);
  check('scanning advances to calibrating', flow.phase === 'calibrating');

  check('calibration starts at 0', flow.calibrationProgress === 0);
  advance(T.calibratingMs / 2);
  check('calibration reaches halfway', Math.abs(flow.calibrationProgress - 0.5) < 1e-9);
  advance(T.calibratingMs / 2 - 1);
  check('calibration holds until complete', flow.phase === 'calibrating');
  advance(1);
  check('calibration advances to live', flow.phase === 'live');
  check('calibration progress is zero outside the count', flow.calibrationProgress === 0);
}

// --- Reset ------------------------------------------------------------------

{
  const flow = new SessionFlow(T);
  flow.setPaired(true);
  flow.setReady(true);
  advance(T.pairedMs + T.scanningMs + T.calibratingMs);
  check('reaches live before reset', flow.phase === 'live');

  flow.reset();
  check('reset returns to calibrating, not to paired', flow.phase === 'calibrating');
  check('reset restarts the count at zero', flow.calibrationProgress === 0);
  advance(T.calibratingMs);
  check('reset runs back to live', flow.phase === 'live');
}

// --- Losing a subject mid-session -------------------------------------------

{
  const flow = new SessionFlow(T);
  flow.setPaired(true);
  flow.setReady(true);
  advance(T.pairedMs + T.scanningMs + T.calibratingMs);
  check('live before the drop', flow.phase === 'live');

  flow.setReady(false);
  check('losing a subject falls back to waiting', flow.phase === 'waiting');

  flow.setReady(true);
  check('recovering re-enters paired', flow.phase === 'paired');
  advance(T.pairedMs + T.scanningMs + T.calibratingMs);
  check('recovery runs the sequence again', flow.phase === 'live');
}

// A drop *during* the run-up must not leave a stale timer that later fires and
// drags a disconnected session into calibration on its own.
{
  const flow = new SessionFlow(T);
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
  advance(T.pairedMs + T.scanningMs + T.calibratingMs);
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
  'shipped timings run the whole run-up in under 20s',
  DEFAULT_TIMINGS.pairedMs + DEFAULT_TIMINGS.scanningMs + DEFAULT_TIMINGS.calibratingMs < 20_000,
);

// --- Report -----------------------------------------------------------------

let failed = 0;
for (const [name, ok] of checks) {
  if (!ok) failed += 1;
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}`);
}
if (failed) throw new Error(`${failed} of ${checks.length} flow checks failed`);
console.log(`\nall ${checks.length} passed`);
