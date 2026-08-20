import { SYNC_WINDOW_MS, type SyncResult } from './sync';

/**
 * The Mutual Affection Index, and the diagnosis it earns.
 *
 * The presentation is a deadpan parody of a diagnostic instrument — bands with
 * clinical names, prescriptions, an upsell. The number underneath is not a joke:
 * it is built from the same surrogate-tested coupling as the synchrony panel, so
 * a high score means the two subjects genuinely tracked each other and a low one
 * means they genuinely did not.
 *
 * Keeping those halves separate matters. A satirical wrapper around a fabricated
 * number would be a lie with a laugh on top; a satirical wrapper around an
 * honest number is a joke about diagnostic instruments, which is the point.
 *
 * Three inputs, weighted:
 *
 * - **Valence coupling** dominates. Feeling positive and negative at the same
 *   times is the closest thing here to affection.
 * - **Arousal coupling** contributes less: activating together is real coupling
 *   but reads more as shared context than shared feeling.
 * - **Proximity** — how near the two points sit on the circumplex — is a small
 *   term, because two people can be in the same affective place at once without
 *   any of it being about each other.
 *
 * Coupling terms count only the part that clears the surrogate floor. Below it,
 * a correlation is what any two smoothed EEG signals produce by construction,
 * and paying out affection for it would make the index mostly measure
 * autocorrelation.
 */

/**
 * Valence leads; arousal contributes less.
 *
 * Proximity is deliberately NOT a third additive term. As one it paid out up to
 * 20 points to two people who had never met — anyone sitting near neutral is
 * near everyone else sitting near neutral — which put a floor of about 15 under
 * the index and made Severe Affection Deficiency unreachable. The storyboard's
 * own example is 3%.
 *
 * It multiplies instead: being in the same affective place amplifies coupling
 * that is already there, and cannot manufacture affection on its own. Two
 * strangers who happen to be equally calm now score zero, which is right.
 */
const WEIGHT = { valence: 0.62, arousal: 0.38 };

/**
 * How far proximity can pull a coupled pair down.
 *
 * It only ever attenuates. Letting it amplify pushed the product above 1 for any
 * strongly coupled pair sitting close together, and the clamp turned all of them
 * into one atom at exactly 100 — which no monotonic calibration can spread back
 * out. Distance now costs a pair up to a quarter of its score; closeness costs
 * nothing.
 */
const PROXIMITY_PENALTY = 0.25;

/*
 * Excess is normalised by the headroom above the floor, not by a fixed constant.
 *
 * A fixed 0.45 made the score a near-step function: floors sit around 0.2–0.5
 * and |r| runs to 1, so anything genuinely coupled saturated at full marks and
 * anything else scored zero. Measured over a coupling sweep, 30% of pairs landed
 * on exactly 0 and 40% on exactly 100, with almost nothing between — and no
 * monotonic calibration can pull identical values apart.
 *
 * Dividing by `1 - floor` asks how far into the range that was actually
 * available this pair got, which spans 0..1 by construction and needs no
 * arbitrary constant.
 */

/** Max meaningful separation on the circumplex. The plane's diagonal is 2√2. */
const FAR_APART = 2.0;

/**
 * How much of the *reachable* window both streams must have covered before the
 * score is treated as settled.
 *
 * Deliberately measured against what was reachable rather than against the whole
 * epoch. Coverage early in a session is low for an entirely benign reason — the
 * two-minute window has not filled — and judging it against the full epoch made
 * every fresh session report a stream failure that was not happening.
 */
const HEALTHY_FILL = 0.75;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/**
 * Why a score might not be settled yet — and crucially, whether that is anyone's
 * fault. `warmup` resolves on its own; `gappy` means a headset needs attention.
 */
export type Confidence = 'ok' | 'warmup' | 'gappy';

/**
 * Raw coupling, expressed on the diagnosis scale.
 *
 * The band table in `docs/storyboard/mutual-affection-index` specifies not only
 * the bands but how often each should appear. Raw coupling does not land in them
 * at anything like those rates on its own: the surrogate test is close to a
 * step, so a large share of pairs sit at exactly 0 or exactly 1 and the middle
 * bands almost never occur. Acute Relational Ambiguity is worse than rare — it
 * occupies the single value 50, which a continuous score would essentially never
 * hit, yet is supposed to appear a tenth of the time.
 *
 * So the raw score is mapped through this curve: monotonic, so a more coupled
 * pair always scores at least as high as a less coupled one, and piecewise, so
 * each band receives the share of the range the table asks for. A whole interval
 * maps onto 50, which is what gives that one-value band a real probability.
 *
 * `RAW_BREAKS` are the raw quantiles at the table's cumulative probabilities,
 * fitted against the simulator's coupling sweep. They describe an assumed
 * population, not a law — a real cohort of dyads would need them refitted, and
 * until someone measures one these frequencies are a design intent rather than
 * an observation.
 */
export const RAW_BREAKS = [0, 0.1648, 0.3442, 0.4229, 0.5834, 0.805, 0.9358, 1];

export function calibrate(raw: number): number {
  for (let i = 0; i < DIAGNOSES.length; i += 1) {
    const lo = RAW_BREAKS[i];
    const hi = RAW_BREAKS[i + 1];
    if (raw > hi && i < DIAGNOSES.length - 1) continue;
    const band = DIAGNOSES[i];
    // A single-value band swallows its whole interval; the rest ramp across.
    if (band.to === band.from) return band.from / 100;
    const within = hi > lo ? clamp01((raw - lo) / (hi - lo)) : 0;
    return (band.from + within * (band.to - band.from)) / 100;
  }
  return 1;
}

export interface AffectionScore {
  /** 0–100. What the big number shows. */
  value: number;
  confidence: Confidence;
  /** How full the epoch is, 0..1. Drives the warm-up readout. */
  filled: number;
  /** Component contributions, for the detail line. */
  parts: Parts;
}

export interface Parts {
  valence: number;
  arousal: number;
  proximity: number;
}

/** The part of a correlation that clears its own surrogate floor, 0..1. */
function excessOf(c: { r: number; surrogate: number } | null): number {
  if (!c) return 0;
  // A missing floor means the controls have not been built yet. Score it zero
  // rather than crediting an untested correlation.
  if (!Number.isFinite(c.surrogate)) return 0;
  const headroom = 1 - c.surrogate;
  if (headroom <= 0) return 0;
  return clamp01((Math.abs(c.r) - c.surrogate) / headroom);
}

/**
 * Coupling on its own 0..1 scale, before the diagnosis curve is applied.
 *
 * Exported so the calibration can be fitted against measured output rather than
 * guessed at — `RAW_BREAKS` comes from running this over a coupling sweep.
 */
export function rawAffection(sync: SyncResult): { raw: number; parts: Parts } | null {
  if (!sync.valence && !sync.arousal && sync.distance === null) return null;

  const valence = excessOf(sync.valence);
  const arousal = excessOf(sync.arousal);
  const proximity = sync.distance === null ? 0 : clamp01(1 - sync.distance / FAR_APART);

  const coupling = WEIGHT.valence * valence + WEIGHT.arousal * arousal;
  // Proximity modulates around 1, so a distant but strongly coupled pair still
  // scores well and a close but uncoupled pair still scores nothing.
  const raw = clamp01(coupling * (1 - PROXIMITY_PENALTY * (1 - proximity)));
  return { raw, parts: { valence, arousal, proximity } };
}

export function computeAffection(sync: SyncResult | null): AffectionScore | null {
  if (!sync) return null;
  // Nothing to report until at least one measure exists or the pair is on screen
  // together — otherwise the index would be an opinion about no data.
  const base = rawAffection(sync);
  if (!base) return null;

  const { raw, parts } = base;
  const value = 100 * clamp01(calibrate(raw));

  // The most coverage the session could possibly have accrued so far.
  const filled = clamp01(sync.elapsedMs / SYNC_WINDOW_MS);
  const fill = filled > 0 ? sync.coverage / filled : 0;

  /*
   * `distance` is null exactly when one subject's last sample is stale, so it is
   * the immediate answer to "is a stream failing *right now*". The historical
   * ratio alone was too slow: a headset that died seconds ago still leaves most
   * of the two-minute window covered, and the readout went on saying "settling"
   * long after someone should have been told to check it.
   */
  const stalled = sync.distance === null;
  const confidence: Confidence =
    stalled || filled <= 0 || fill < HEALTHY_FILL
      ? 'gappy'
      : filled < 1
        ? 'warmup'
        : 'ok';

  return {
    value: Math.round(value),
    confidence,
    filled,
    parts,
  };
}

export interface Diagnosis {
  /** Lower bound of the band, inclusive. */
  from: number;
  /** Upper bound of the band, inclusive. */
  to: number;
  /** The headline on the diagnosis frame. */
  name: string;
  /** How the band is referred to mid-sentence: "lies within the … range". */
  range: string;
  /** The lead instruction, set apart under the headline. */
  directive: string;
  /**
   * The rest of the prescription, NOT repeating the directive.
   *
   * They used to overlap — `directive` restated `actions[0]` — and the verdict
   * frame showed the directive and then jumped to the withheld line, so any
   * instruction in between was dropped and appeared nowhere. Keeping them
   * disjoint means every frame can show all of it without repeating any of it.
   */
  actions: string[];
  /** The one held back behind the upsell, shown truncated. */
  lockedAction: string;
}

/**
 * The bands, from `docs/storyboard/mutual-affection-index`.
 *
 * Transcribed rather than invented, including the single-value band at exactly
 * 50 — a one-point diagnosis of ambiguity is the joke, not an off-by-one, so it
 * is preserved exactly. That is also why bands carry an explicit `to` instead of
 * being derived from the next band's floor.
 *
 * The source table leaves small gaps at its seams (nothing at 0, nothing between
 * 30 and 31, nothing above 99). Those are closed here so that every possible
 * score has a diagnosis: an instrument that answers "no band" for 0% would be a
 * worse joke than one that calls it Severe Affection Deficiency.
 */
export const DIAGNOSES: Diagnosis[] = [
  {
    from: 0,
    to: 9,
    name: 'Severe Affection Deficiency',
    range: 'Severe Deficiency',
    directive: 'Discontinue interpersonal contact immediately.',
    actions: [],
    lockedAction: 'Avoid unnecessary face-to-face contact, unfollow on social media',
  },
  {
    from: 10,
    to: 30,
    name: 'Low Affection',
    range: 'Low Affection',
    directive: 'Gradual relational withdrawal is advised.',
    actions: [],
    lockedAction: 'Avoid alcohol-assisted and late-night disclosures',
  },
  {
    from: 31,
    to: 49,
    name: 'Subclinical Affection',
    range: 'Subclinical Affection',
    directive: 'Continuous monitoring recommended.',
    actions: [],
    lockedAction:
      'Maintain face-to-face contact once per week under controlled circumstances, preferably during daylight hours and in group situations',
  },
  {
    from: 50,
    to: 50,
    name: 'Acute Relational Ambiguity',
    range: 'Acute Relational Ambiguity',
    directive: 'Maintain the relationship at its current level of intimacy.',
    actions: ['Do not initiate escalation or de-escalation until reassessment'],
    lockedAction: 'Alternate between 1 dose of proximity and 1 dose of distance',
  },
  {
    from: 51,
    to: 70,
    name: 'Moderate Affection',
    range: 'Moderate Affection',
    directive: 'Controlled escalation is recommended.',
    actions: [],
    lockedAction:
      'Oral and physical affectionate contact may be administered 1–3 times weekly',
  },
  {
    from: 71,
    to: 90,
    name: 'Critical Affection Saturation',
    range: 'Critical Affection Saturation',
    directive: 'Declaration of exclusive commitment is strongly advised.',
    actions: [],
    lockedAction:
      'Conduct exercises of vulnerability exposure by exchanging family and childhood trauma',
  },
  {
    from: 91,
    to: 100,
    name: 'Terminal Affection',
    range: 'Terminal Affection',
    directive: 'Strongly recommended to unite for life.',
    actions: ['Marriage certificate should be administered at once'],
    lockedAction: 'Maintain synchronized bedtime',
  },
];

/** Everything prescribed, in order, with the withheld line last. */
export function prescription(d: Diagnosis): string[] {
  return [d.directive, ...d.actions, d.lockedAction];
}

export function diagnose(value: number): Diagnosis {
  const v = Math.round(value);
  const match = DIAGNOSES.find((d) => v >= d.from && v <= d.to);
  // The bands are contiguous over 0–100 and the index is clamped to that range,
  // so this only fires if the table above is edited into a gap.
  return match ?? DIAGNOSES[0];
}
