import type { SyncResult } from './sync';

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

const WEIGHT = { valence: 0.5, arousal: 0.3, proximity: 0.2 };

/** Excess over the floor that counts as a full mark. */
const FULL_MARK_EXCESS = 0.45;

/** Max meaningful separation on the circumplex. The plane's diagonal is 2√2. */
const FAR_APART = 2.0;

/** Below this share of the epoch, the score is reported as provisional. */
const CONFIDENT_COVERAGE = 0.6;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export interface AffectionScore {
  /** 0–100. What the big number shows. */
  value: number;
  /** False when the streams covered too little of the epoch to trust it. */
  confident: boolean;
  /** Component contributions, for the detail line. */
  parts: { valence: number; arousal: number; proximity: number };
}

/** The part of a correlation that clears its own surrogate floor, 0..1. */
function excessOf(c: { r: number; surrogate: number } | null): number {
  if (!c) return 0;
  // A missing floor means the controls have not been built yet. Score it zero
  // rather than crediting an untested correlation.
  if (!Number.isFinite(c.surrogate)) return 0;
  return clamp01((Math.abs(c.r) - c.surrogate) / FULL_MARK_EXCESS);
}

export function computeAffection(sync: SyncResult | null): AffectionScore | null {
  if (!sync) return null;
  // Nothing to report until at least one measure exists or the pair is on screen
  // together — otherwise the index would be an opinion about no data.
  if (!sync.valence && !sync.arousal && sync.distance === null) return null;

  const valence = excessOf(sync.valence);
  const arousal = excessOf(sync.arousal);
  const proximity = sync.distance === null ? 0 : clamp01(1 - sync.distance / FAR_APART);

  const value =
    100 *
    (WEIGHT.valence * valence + WEIGHT.arousal * arousal + WEIGHT.proximity * proximity);

  return {
    value: Math.round(value),
    confident: sync.coverage >= CONFIDENT_COVERAGE,
    parts: { valence, arousal, proximity },
  };
}

export interface Diagnosis {
  /** Lower bound of the band, inclusive. */
  from: number;
  /** The headline on the diagnosis frame. */
  name: string;
  /** How the band is referred to mid-sentence: "lies within the … range". */
  range: string;
  /** The single directive under the headline. */
  directive: string;
  /** Bulleted prescription. */
  actions: string[];
}

/**
 * Bands, ascending. Deliberately unflattering at both ends: an instrument that
 * only pathologises coldness is a worse joke than one that also pathologises
 * warmth.
 */
export const DIAGNOSES: Diagnosis[] = [
  {
    from: 0,
    name: 'Severe Affection Deficiency',
    range: 'Severe Deficiency',
    directive: 'Discontinue interpersonal contact immediately.',
    actions: [
      'Discontinue contact immediately',
      'Unfollow on social media',
      'Avoid unnecessary face-to-face contact',
    ],
  },
  {
    from: 15,
    name: 'Marked Affection Deficiency',
    range: 'Marked Deficiency',
    directive: 'Reduce interpersonal contact to scheduled intervals.',
    actions: [
      'Limit conversation to logistics',
      'Withhold eye contact for 14 days',
      'Do not share food',
    ],
  },
  {
    from: 35,
    name: 'Borderline Affection',
    range: 'Borderline',
    directive: 'Monitor closely. Outcome uncertain.',
    actions: [
      'Maintain current contact levels',
      'Avoid sudden gestures',
      'Re-test in one week',
    ],
  },
  {
    from: 55,
    name: 'Affection Within Normal Limits',
    range: 'Normal Limits',
    directive: 'No intervention indicated at this time.',
    actions: [
      'Continue as you were',
      'Resist the urge to discuss it',
      'Re-test only if symptoms develop',
    ],
  },
  {
    from: 75,
    name: 'Acute Mutual Affection',
    range: 'Acute Mutual Affection',
    directive: 'Seek immediate distance to prevent dependency.',
    actions: [
      'Introduce a third party at once',
      'Schedule unrelated activities',
      'Do not make any joint purchases',
    ],
  },
];

export function diagnose(value: number): Diagnosis {
  let match = DIAGNOSES[0];
  for (const d of DIAGNOSES) if (value >= d.from) match = d;
  return match;
}
