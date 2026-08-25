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
  // Most tests drive the count directly; the floor gets its own case below.
  minCalculatingMs: 0,
};

/** Most tests are not about the score gate, so they hand it a ready score. */
function ready(flow: InstanceType<typeof SessionFlow>) {
  flow.setDiagnosisReady(true);
  return flow;
}

/**
 * A paired flow with the opening screen already dismissed.
 *
 * The order mirrors the app: how many subjects there are is settled at boot,
 * long before anybody touches the screen, and `start()` is the click that comes
 * after. Every case below is about what happens once a pair has sat down, so
 * they would all otherwise open with these same two lines. The opening screen
 * has its own section further down.
 */
function started(timings = T) {
  const flow = new SessionFlow(timings);
  flow.setPaired(true);
  flow.start();
  return flow;
}

/** The same, for a session with only one subject in it. */
function startedSolo(timings = T) {
  const flow = new SessionFlow(timings);
  flow.setPaired(false);
  flow.start();
  return flow;
}

const checks: Array<[string, boolean]> = [];
const check = (name: string, ok: boolean) => checks.push([name, ok]);

// --- A pair walks the whole sequence ---------------------------------------

{
  const flow = ready(started());
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
  const flow = ready(started());
  flow.setPaired(true);
  flow.setReady(true);
  advance(T.pairedMs);
  flow.begin();
  advance(T.calibratingMs + T.diagnosisMs);
  check('reaches live before reset', flow.phase === 'live');

  flow.reset();
  // Reset clears readiness, so the next run needs its own score.
  flow.setDiagnosisReady(true);
  check('reset returns to the opening screen', flow.phase === 'title');
  // And stays there. The pair who pressed it are getting up; the next two have
  // not sat down, and both headsets are still reporting from the last session.
  advance(T.pairedMs * 10);
  check('reset does not walk on by itself', flow.phase === 'title');

  // Both subjects are still connected, so once someone starts it the wait
  // resolves at once and the run begins at the pairing frame rather than
  // stalling on a connect screen that has nothing to wait for.
  flow.start();
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
  const flow = ready(started());
  flow.setPaired(true);
  flow.setReady(true);
  advance(T.pairedMs);
  flow.begin();
  advance(T.calibratingMs + T.diagnosisMs);
  flow.setReady(false);
  flow.reset();
  flow.setDiagnosisReady(true);
  flow.start();
  check('reset with a headset off waits at the connecting frame', flow.phase === 'waiting');
  advance(T.pairedMs * 10);
  check('it stays there while a headset is off', flow.phase === 'waiting');
  flow.setReady(true);
  check('and resumes when both are worn again', flow.phase === 'paired');
}

// --- Losing a subject mid-session -------------------------------------------

// Before a verdict exists, a drop means the instrument cannot do its job.
{
  const flow = ready(started());
  flow.setPaired(true);
  flow.setReady(true);
  advance(T.pairedMs);
  flow.begin();
  advance(T.calibratingMs / 2);
  check('calculating before the drop', flow.phase === 'calibrating');

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
  const flow = ready(started());
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
  const flow = startedSolo();
  check('a solo session skips the ceremony', flow.phase === 'live');
  advance(T.pairedMs);
  flow.begin();
  advance(T.calibratingMs + T.diagnosisMs);
  check('a solo session stays live', flow.phase === 'live');
}

// A partner arriving mid-solo should start the pairing sequence, not jump in.
{
  const flow = startedSolo();
  flow.setPaired(true);
  check('gaining a partner leaves live for waiting', flow.phase === 'waiting');
  flow.setReady(true);
  check('gaining a partner then runs the sequence', flow.phase === 'paired');
}

// --- Waiting for a score ----------------------------------------------------

// The verdict frame must not open on "Inconclusive", so the count holds at 100%
// until there is something to deliver a verdict about.
{
  const flow = started();
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
  const flow = started();
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
  const flow = ready(started());
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
  flow.start();
  check('a pinned phase ignores start', flow.phase === 'calibrating');
}

// --- Defaults ---------------------------------------------------------------

// Pressing Go must never snap straight to a verdict.
{
  const brief = { ...T, calibratingMs: 500, minCalculatingMs: 3000 };
  const flow = ready(started(brief));
  flow.setPaired(true);
  flow.setReady(true);
  advance(brief.pairedMs);
  flow.begin();
  advance(brief.calibratingMs);
  check('a short count is held to the floor', flow.phase === 'calibrating');
  check('and the bar is not yet full', flow.calibrationProgress < 1);
  advance(brief.minCalculatingMs - brief.calibratingMs);
  check('the floor releases it', flow.phase === 'diagnosis');
}

check(
  'the shipped count is at least ten seconds',
  Math.max(DEFAULT_TIMINGS.calibratingMs, DEFAULT_TIMINGS.minCalculatingMs) >= 10_000,
);

check(
  'the verdict is given time to be read',
  DEFAULT_TIMINGS.diagnosisMs >= 15_000,
);

// The unlock link is the way past a verdict that now holds for half a minute.
{
  const flow = ready(started());
  flow.setPaired(true);
  flow.setReady(true);
  advance(T.pairedMs);
  flow.begin();
  flow.revealDetails();
  check('unlock does nothing while calculating', flow.phase === 'calibrating');

  advance(T.calibratingMs);
  check('the verdict is showing', flow.phase === 'diagnosis');
  advance(T.diagnosisMs / 3);
  flow.revealDetails();
  check('unlock leaves the verdict early', flow.phase === 'live');

  // The verdict's own timer must not fire afterwards and shunt a live session.
  advance(T.diagnosisMs * 3);
  check('no stale verdict timer disturbs the live view', flow.phase === 'live');

  flow.revealDetails();
  check('unlock does nothing once live', flow.phase === 'live');
}

// Go is the only human-driven transition, so it must not fire from anywhere else.
{
  const flow = ready(started());
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

// --- A settled session ------------------------------------------------------

/*
 * Once the verdict frame has handed over, the screen is a result rather than an
 * instrument. The pair take the headsets off as soon as they have read the
 * number, and the last thing that should happen then is the connect frame
 * coming back over the answer they are still looking at.
 */
{
  const flow = ready(started());
  flow.setReady(true);
  check('not settled during the run-up', !flow.settled);
  advance(T.pairedMs);
  flow.begin();
  check('not settled while calculating', !flow.settled);
  advance(T.calibratingMs);
  check('not settled on the verdict frame', flow.phase === 'diagnosis' && !flow.settled);

  advance(T.diagnosisMs);
  check('settled once the verdict hands over', flow.phase === 'live' && flow.settled);

  // Both headsets come off, which is what happens next in the room.
  flow.setReady(false);
  check('a settled session survives the headsets coming off', flow.phase === 'live');
  flow.setPaired(false);
  check('and survives losing the partner outright', flow.phase === 'live');
  advance(T.diagnosisMs * 10);
  check('and no timer disturbs it', flow.phase === 'live');
}

// Leaving the verdict early settles it just the same — it is the frame ending
// that matters, not which of the two ways ended it.
{
  const flow = ready(started());
  flow.setReady(true);
  advance(T.pairedMs);
  flow.begin();
  advance(T.calibratingMs);
  flow.revealDetails();
  check('unlocking early also settles the session', flow.phase === 'live' && flow.settled);
  flow.setReady(false);
  check('and it holds against a drop too', flow.phase === 'live');
}

// Reset is the only way out, and it leaves nothing settled behind it.
{
  const flow = ready(started());
  flow.setReady(true);
  advance(T.pairedMs);
  flow.begin();
  advance(T.calibratingMs + T.diagnosisMs);
  check('settled before reset', flow.settled);
  flow.reset();
  check('reset unsettles it', !flow.settled);
  check('and returns to the opening screen', flow.phase === 'title');
  flow.setDiagnosisReady(true);
  flow.start();
  check('the next run answers the streams again', flow.phase === 'paired');
  flow.setReady(false);
  check('and falls back on a drop as it should', flow.phase === 'waiting');
}

// A solo session's live view is the running instrument, not a result.
{
  const flow = startedSolo();
  check('a solo session is live', flow.phase === 'live');
  check('but never settled', !flow.settled);
}

// Pinning a phase is for looking at a frame, so it must not settle one either —
// a pinned `live` that stopped taking data would have nothing to show.
{
  const flow = new SessionFlow(T);
  flow.forcePhase('live');
  check('a pinned live view is not settled', flow.phase === 'live' && !flow.settled);
}

// --- The opening screen -----------------------------------------------------

// It is the first thing on screen, and it holds until a person acts. Everything
// the app learns while it is up is recorded and none of it advances the frame.
{
  const flow = new SessionFlow(T);
  check('the app opens on the title screen', flow.phase === 'title');

  flow.setPaired(true);
  flow.setReady(true);
  flow.setDiagnosisReady(true);
  check('a fully connected pair does not start the session itself', flow.phase === 'title');
  advance(T.pairedMs * 20);
  check('and no timer starts it either', flow.phase === 'title');

  // What was learned while it waited is not thrown away — the run-up picks up
  // from what is actually connected rather than re-discovering it.
  flow.start();
  check('starting a connected pair goes straight to the pairing frame', flow.phase === 'paired');
  flow.start();
  check('a second press does not skip ahead', flow.phase === 'paired');
}

// A solo session still has to be started; it just has no ceremony after that.
{
  const flow = new SessionFlow(T);
  flow.setPaired(false);
  check('a solo session waits on the title screen too', flow.phase === 'title');
  flow.start();
  check('and goes straight to live once started', flow.phase === 'live');
}

// Nothing is connected yet: starting lands on the connect screen, not past it.
{
  const flow = new SessionFlow(T);
  flow.setPaired(true);
  flow.start();
  check('starting with no headsets waits for them', flow.phase === 'waiting');
  flow.setReady(true);
  check('and runs on when they arrive', flow.phase === 'paired');
}

// Go and the unlock link belong to their own frames, and the title is not one.
{
  const flow = ready(new SessionFlow(T));
  flow.setPaired(true);
  flow.begin();
  check('Go does nothing on the title screen', flow.phase === 'title');
  flow.revealDetails();
  check('unlock does nothing on the title screen', flow.phase === 'title');
}

// --- Report -----------------------------------------------------------------

let failed = 0;
for (const [name, ok] of checks) {
  if (!ok) failed += 1;
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}`);
}
if (failed) throw new Error(`${failed} of ${checks.length} flow checks failed`);
console.log(`\nall ${checks.length} passed`);
