/**
 * Tests for the synchrony estimator.
 *
 * Run with `npm test`. No test framework: this bundles with the esbuild that
 * already ships inside Vite and runs on plain Node, so the check costs no
 * dependencies. Assertions print and set the exit code.
 *
 * The point of these is the surrogate floor. Two independently generated,
 * identically smoothed signals correlate substantially by construction — the
 * measured |r| here runs to a median of ~0.12 and a maximum of ~0.30 — so a bare
 * correlation would report coupling between strangers most of the time. What is
 * being tested is that the floor removes that without also removing real
 * coupling.
 */

import { SyncModel, verdictOf, peakVerdictOf, SYNC_WINDOW_MS } from './sync';

/** Deterministic PRNG: a failure here must be reproducible. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HZ = 8; // the observed Muse 2 EegBands rate
const DT = 1000 / HZ;
const T0 = 1_000_000_000_000;
const N = Math.floor((SYNC_WINDOW_MS + 5_000) / DT);

/** Smooth like `AffectModel` does, so surrogates face realistic autocorrelation. */
function ema(xs: number[], tauMs = 1500): number[] {
  const alpha = 1 - Math.exp(-DT / tauMs);
  let v = xs[0];
  return xs.map((x) => (v += alpha * (x - v)));
}

function series(seed: number, n = N): number[] {
  const rng = mulberry32(seed);
  return ema(Array.from({ length: n }, () => rng() * 2 - 1));
}

function feed(selfV: number[], partnerV: number[], n = N) {
  const m = new SyncModel();
  for (let i = 0; i < n; i += 1) {
    const t = T0 + i * DT;
    m.push('self', { valence: selfV[i], arousal: selfV[i] * 0.5 }, t);
    m.push('partner', { valence: partnerV[i], arousal: partnerV[i] * 0.5 }, t);
  }
  return m.compute(T0 + (n - 1) * DT);
}

const checks: Array<[string, boolean]> = [];
const check = (name: string, ok: boolean) => checks.push([name, ok]);

// --- Behaviour on known inputs ---------------------------------------------

const a = series(1);
const b = series(2);

const identical = feed(a, a);
check('identical streams give r ~ 1', (identical.valence?.r ?? 0) > 0.99);
check('identical streams read as strong', verdictOf(identical.valence) === 'strong');
check('identical streams sit at distance 0', (identical.distance ?? 1) < 1e-9);

const independent = feed(a, b);
check('independent streams do not clear the floor', verdictOf(independent.valence) === 'none');

const LAG_STEPS = Math.round(1500 / DT);
const lagged = a.map((_, i) => a[Math.max(0, i - LAG_STEPS)]);
const laggedRes = feed(a, lagged);
check(
  'a 1500 ms lag is recovered within one grid step',
  Math.abs((laggedRes.valence?.peakLagMs ?? 0) - 1500) <= 250,
);

const mixed = a.map((v, i) => 0.6 * v + 0.4 * b[i]);
check('60% shared signal is detected', verdictOf(feed(a, mixed).valence) !== 'none');

const flat = feed(a, new Array(N).fill(0.25));
check('a flat partner yields no correlation', flat.valence === null);

// A stream that stops must degrade coverage rather than being held forward.
// The partner is fed for only the first fifth of the run, so it overlaps a
// small and analytically obvious slice of the trailing 60 s epoch.
const half = new SyncModel();
const PARTNER_UNTIL = Math.floor(N * 0.2);
for (let i = 0; i < N; i += 1) {
  const t = T0 + i * DT;
  half.push('self', { valence: a[i], arousal: 0 }, t);
  if (i < PARTNER_UNTIL) half.push('partner', { valence: b[i], arousal: 0 }, t);
}
const dead = half.compute(T0 + (N - 1) * DT);
// Epoch spans the last SYNC_WINDOW_MS; the partner covers only its opening.
const expectedCoverage =
  Math.max(0, PARTNER_UNTIL * DT - (N * DT - SYNC_WINDOW_MS)) / SYNC_WINDOW_MS;
check('a dead partner drops coverage to its true overlap', Math.abs(dead.coverage - expectedCoverage) < 0.05);
check('a dead partner reports no distance', dead.distance === null);

// --- Error rates over many pairs -------------------------------------------

const TRIALS = 40;
let falsePos = 0;
let peakFalsePos = 0;
const magnitudes: number[] = [];

for (let i = 0; i < TRIALS; i += 1) {
  const res = feed(series(i * 2 + 1000), series(i * 2 + 1001));
  if (res.valence) magnitudes.push(Math.abs(res.valence.r));
  if (verdictOf(res.valence) !== 'none') falsePos += 1;
  if (peakVerdictOf(res.valence) !== 'none') peakFalsePos += 1;
}

const COUPLED = 20;
let truePos = 0;
for (let i = 0; i < COUPLED; i += 1) {
  const shared = series(i + 5000);
  const na = series(i + 7000);
  const nb = series(i + 9000);
  const res = feed(
    shared.map((v, j) => 0.55 * v + 0.45 * na[j]),
    shared.map((v, j) => 0.55 * v + 0.45 * nb[j]),
  );
  if (verdictOf(res.valence) !== 'none') truePos += 1;
}

magnitudes.sort((x, y) => x - y);
const median = magnitudes[Math.floor(magnitudes.length / 2)];

check('false positives stay at or under 15%', falsePos / TRIALS <= 0.15);
check('lagged false positives stay at or under 20%', peakFalsePos / TRIALS <= 0.2);
check('at least 80% of truly coupled pairs are found', truePos / COUPLED >= 0.8);
// Guards the premise: if smoothed noise stopped correlating, the floor would be
// solving a problem that no longer exists and these tests would prove nothing.
check('raw |r| between independent pairs is substantial', median > 0.05);

// --- Report -----------------------------------------------------------------

console.log(`independent pairs   ${TRIALS}`);
console.log(`  raw |r|           median ${median.toFixed(3)}  max ${magnitudes[magnitudes.length - 1].toFixed(3)}`);
console.log(`  false positives   ${falsePos}/${TRIALS} zero-lag, ${peakFalsePos}/${TRIALS} lagged`);
console.log(`coupled pairs       ${truePos}/${COUPLED} detected at 55% shared signal\n`);

let failed = 0;
for (const [name, ok] of checks) {
  if (!ok) failed += 1;
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}`);
}
console.log(failed ? `\n${failed} of ${checks.length} failed` : `\nall ${checks.length} passed`);
process.exit(failed ? 1 : 0);
