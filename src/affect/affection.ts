/**
 * The Mutual Affection Index: the number the verdict is about.
 *
 * It is drawn, not measured. `docs/storyboard/mutual-affection-index` specifies
 * how often each diagnosis should appear, and this samples that distribution
 * directly: pick a band by its stated probability, then a value inside it.
 *
 * An earlier version derived the index from the surrogate-tested coupling in
 * `affect/sync.ts` and mapped it through a fitted curve to reach those
 * frequencies. That is gone from here, and the honest measurement it was built
 * on is still on screen — the Synchrony panel reports the same coupling, floor
 * and all. What changed is that the *index* no longer claims to be it.
 *
 * The draw happens once, while the calculating screen is up, and the number is
 * then fixed for the whole session. Everything else on the page keeps moving;
 * this does not. A verdict that drifted while you read it would not be a
 * verdict.
 */

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
  /**
   * How often this band should come up, 0..1, straight from the table's last
   * column. These sum to 1 and are what `drawAffection` samples.
   */
  probability: number;
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
    probability: 0.20,
    range: 'Severe Deficiency',
    directive: 'Discontinue interpersonal contact immediately.',
    actions: [],
    lockedAction: 'Avoid unnecessary face-to-face contact, unfollow on social media',
  },
  {
    from: 10,
    to: 30,
    name: 'Low Affection',
    probability: 0.11,
    range: 'Low Affection',
    directive: 'Gradual relational withdrawal is advised.',
    actions: [],
    lockedAction: 'Avoid alcohol-assisted and late-night disclosures',
  },
  {
    from: 31,
    to: 49,
    name: 'Subclinical Affection',
    probability: 0.05,
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
    probability: 0.10,
    range: 'Acute Relational Ambiguity',
    directive: 'Maintain the relationship at its current level of intimacy.',
    actions: ['Do not initiate escalation or de-escalation until reassessment'],
    lockedAction: 'Alternate between 1 dose of proximity and 1 dose of distance',
  },
  {
    from: 51,
    to: 70,
    name: 'Moderate Affection',
    probability: 0.17,
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
    probability: 0.16,
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
    probability: 0.21,
    range: 'Terminal Affection',
    directive: 'Strongly recommended to unite for life.',
    actions: ['Marriage certificate should be administered at once'],
    lockedAction: 'Maintain synchronized bedtime',
  },
];

/**
 * Draw an index from the table's distribution.
 *
 * Pick a band by its stated probability, then a value uniformly inside it. Acute
 * Relational Ambiguity spans exactly one value, so it always yields 50 — which is
 * how a one-point band gets its tenth of all sessions.
 *
 * `random` is injectable so the distribution can be tested with a seeded source
 * rather than by hoping.
 */
export function drawAffection(random: () => number = Math.random): number {
  const r = random();
  let cumulative = 0;
  for (const d of DIAGNOSES) {
    cumulative += d.probability;
    if (r < cumulative) {
      const span = d.to - d.from + 1;
      return d.from + Math.min(span - 1, Math.floor(random() * span));
    }
  }
  // Only reachable if the probabilities sum below 1, which a test forbids.
  return DIAGNOSES[DIAGNOSES.length - 1].to;
}

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
