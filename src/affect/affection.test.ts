/**
 * Tests for the Mutual Affection Index.
 *
 * The presentation is a joke; the number is not. What matters here is that the
 * index cannot be talked up by correlations that never cleared their surrogate
 * floor — otherwise the instrument would mostly be diagnosing autocorrelation,
 * and the satire would be resting on a fabrication.
 */

import { computeAffection, diagnose, DIAGNOSES } from './affection';
import type { Correlation, SyncResult } from './sync';

const corr = (r: number, surrogate: number): Correlation => ({
  r,
  n: 400,
  surrogate,
  peakLagMs: 0,
  peakR: r,
  peakSurrogate: surrogate,
});

const result = (over: Partial<SyncResult> = {}): SyncResult => ({
  valence: null,
  arousal: null,
  distance: null,
  coverage: 1,
  ...over,
});

const checks: Array<[string, boolean]> = [];
const check = (name: string, ok: boolean) => checks.push([name, ok]);

// --- Nothing to say ---------------------------------------------------------

check('no sync result yields no score', computeAffection(null) === null);
check('an empty result yields no score', computeAffection(result()) === null);

// --- The floor is load-bearing ----------------------------------------------

{
  // A correlation that looks impressive but sits under its own chance floor.
  const belowFloor = computeAffection(
    result({ valence: corr(0.55, 0.62), arousal: corr(0.5, 0.58), distance: 0.2 }),
  )!;
  // The same correlation against a floor it clears.
  const aboveFloor = computeAffection(
    result({ valence: corr(0.55, 0.12), arousal: corr(0.5, 0.1), distance: 0.2 }),
  )!;

  check('an r under its floor contributes nothing', belowFloor.parts.valence === 0);
  check('an r over its floor contributes', aboveFloor.parts.valence > 0);
  check('clearing the floor scores far higher', aboveFloor.value > belowFloor.value + 30);
  check(
    'proximity alone cannot reach the healthy bands',
    belowFloor.value < DIAGNOSES[2].from,
  );
}

// --- Bounds -----------------------------------------------------------------

{
  const perfect = computeAffection(
    result({ valence: corr(1, 0), arousal: corr(1, 0), distance: 0 }),
  )!;
  check('a perfect pair scores 100', perfect.value === 100);

  const none = computeAffection(
    result({ valence: corr(0, 0.3), arousal: corr(0, 0.3), distance: 2.8 }),
  )!;
  check('an uncoupled distant pair scores 0', none.value === 0);

  // Negative correlation is still coupling — moving in opposition is a
  // relationship, and the magnitude is what the index reads.
  const opposed = computeAffection(
    result({ valence: corr(-0.7, 0.1), arousal: corr(-0.6, 0.1), distance: 0.5 }),
  )!;
  check('opposition counts as coupling', opposed.value > 40);
}

// --- Missing surrogate floor ------------------------------------------------

{
  const untested = computeAffection(
    result({ valence: corr(0.9, NaN), arousal: corr(0.9, NaN), distance: 0.1 }),
  )!;
  check(
    'an untested correlation scores zero rather than 90',
    untested.parts.valence === 0 && untested.parts.arousal === 0,
  );
}

// --- Confidence -------------------------------------------------------------

{
  const thin = computeAffection(result({ valence: corr(0.8, 0.1), coverage: 0.2 }))!;
  const full = computeAffection(result({ valence: corr(0.8, 0.1), coverage: 0.95 }))!;
  check('thin coverage is reported as provisional', !thin.confident);
  check('full coverage is reported as confident', full.confident);
  check('coverage does not change the score itself', thin.value === full.value);
}

// --- Bands ------------------------------------------------------------------

check('0 falls in the first band', diagnose(0) === DIAGNOSES[0]);
check('100 falls in the last band', diagnose(100) === DIAGNOSES[DIAGNOSES.length - 1]);
check(
  'every band is reachable at both of its bounds',
  DIAGNOSES.every((d) => diagnose(d.from) === d && diagnose(d.to) === d),
);

// The bands come from a hand-written table, so the invariant that matters is
// that they tile 0-100 without a gap or an overlap. A gap would leave some score
// with no diagnosis at all; an overlap would make the lookup order-dependent.
check(
  'the bands tile 0 to 100 with no gap or overlap',
  DIAGNOSES[0].from === 0 &&
    DIAGNOSES[DIAGNOSES.length - 1].to === 100 &&
    DIAGNOSES.every((d, i) => i === 0 || d.from === DIAGNOSES[i - 1].to + 1) &&
    DIAGNOSES.every((d) => d.to >= d.from),
);
check(
  'every integer score lands in exactly one band',
  Array.from({ length: 101 }, (_, v) => DIAGNOSES.filter((d) => v >= d.from && v <= d.to).length)
    .every((n) => n === 1),
);

// Acute Relational Ambiguity is a one-point band by design, and an edit that
// widened it would quietly change the joke.
{
  const ambiguity = DIAGNOSES.find((d) => d.name === 'Acute Relational Ambiguity')!;
  check('ambiguity occupies exactly 50', ambiguity.from === 50 && ambiguity.to === 50);
  check('49 and 51 fall outside it', diagnose(49) !== ambiguity && diagnose(51) !== ambiguity);
}

check(
  'every band carries a directive, actions and a withheld one',
  DIAGNOSES.every((d) => d.name && d.range && d.directive && d.actions.length >= 1 && d.lockedAction),
);

// --- Report -----------------------------------------------------------------

let failed = 0;
for (const [name, ok] of checks) {
  if (!ok) failed += 1;
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}`);
}
if (failed) throw new Error(`${failed} of ${checks.length} affection checks failed`);
console.log(`\nall ${checks.length} passed`);
