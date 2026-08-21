/**
 * Tests for the Mutual Affection Index.
 *
 * The index is drawn from the table in `docs/storyboard/mutual-affection-index`
 * rather than measured, so what matters here is that the draw actually follows
 * that table — including the band that occupies a single value — and that the
 * bands themselves still tile the range without a gap.
 */

import { DIAGNOSES, diagnose, drawAffection, prescription } from './affection';

/** Deterministic source, so a failing distribution is reproducible. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const checks: Array<[string, boolean]> = [];
const check = (name: string, ok: boolean) => checks.push([name, ok]);

// --- The table itself --------------------------------------------------------

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
check(
  'the probabilities sum to one',
  Math.abs(DIAGNOSES.reduce((s, d) => s + d.probability, 0) - 1) < 1e-9,
);
check(
  'every band carries a directive and a withheld line',
  DIAGNOSES.every((d) => d.name && d.range && d.directive && d.lockedAction),
);
check(
  'no action repeats its own directive',
  DIAGNOSES.every((d) => !d.actions.some((a) => d.directive.includes(a))),
);
check(
  'the prescription is every line exactly once',
  DIAGNOSES.every((d) => {
    const lines = prescription(d);
    return lines.length === d.actions.length + 2 && new Set(lines).size === lines.length;
  }),
);

// Acute Relational Ambiguity is a one-point band by design, and an edit that
// widened it would quietly change the joke.
{
  const ambiguity = DIAGNOSES.find((d) => d.name === 'Acute Relational Ambiguity')!;
  check('ambiguity occupies exactly 50', ambiguity.from === 50 && ambiguity.to === 50);
  check('49 and 51 fall outside it', diagnose(49) !== ambiguity && diagnose(51) !== ambiguity);
}

// --- The draw ----------------------------------------------------------------

{
  const random = mulberry32(20260820);
  const N = 40000;
  const counts = new Map<string, number>();
  let outOfRange = 0;
  let notAnInteger = 0;

  for (let i = 0; i < N; i += 1) {
    const v = drawAffection(random);
    if (v < 0 || v > 100) outOfRange += 1;
    if (!Number.isInteger(v)) notAnInteger += 1;
    const d = diagnose(v);
    counts.set(d.name, (counts.get(d.name) ?? 0) + 1);
  }

  check('every draw is an integer percentage', notAnInteger === 0);
  check('every draw is inside 0..100', outOfRange === 0);

  // Each band within a point of its stated probability over 40k draws.
  const worst = DIAGNOSES.reduce((max, d) => {
    const observed = (counts.get(d.name) ?? 0) / N;
    return Math.max(max, Math.abs(observed - d.probability));
  }, 0);
  check('the draw follows the table to within a point', worst < 0.01);

  // The one-value band is the sharpest test: it must be hit at its stated rate
  // and must never produce anything but 50.
  const ambiguity = DIAGNOSES.find((d) => d.from === d.to)!;
  const share = (counts.get(ambiguity.name) ?? 0) / N;
  check('the one-value band is drawn at its stated rate', Math.abs(share - ambiguity.probability) < 0.01);

  // Every band should be reachable, including the narrow ones.
  check('no band is unreachable', DIAGNOSES.every((d) => (counts.get(d.name) ?? 0) > 0));
}

// A degenerate source must not fall off either end of the table.
{
  check('a source pinned at 0 draws the lowest band', diagnose(drawAffection(() => 0)) === DIAGNOSES[0]);
  const nearlyOne = drawAffection(() => 0.999999);
  check('a source pinned near 1 stays in range', nearlyOne >= 0 && nearlyOne <= 100);
}

// --- Report ------------------------------------------------------------------

let failed = 0;
for (const [name, ok] of checks) {
  if (!ok) failed += 1;
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}`);
}
if (failed) throw new Error(`${failed} of ${checks.length} affection checks failed`);
console.log(`\nall ${checks.length} passed`);
