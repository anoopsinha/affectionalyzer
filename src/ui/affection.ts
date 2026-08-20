import type { AffectionScore, Diagnosis } from '../affect/affection';
import { diagnose } from '../affect/affection';
import { el, svgEl } from './svg';

/**
 * The Mutual Affection Index card and the Diagnosis card.
 *
 * Both appear twice — full-screen on the verdict frame, and again in the running
 * view — so they are built once and mounted wherever they are needed rather than
 * drawn twice and left to drift apart.
 */

/**
 * A damped oscillation: two signals ringing down to a flat line.
 *
 * The same motif carries the scanning indicator and the affection index, which
 * is deliberate — it is the pair's signal settling, and settling to nothing is
 * exactly what a low index means.
 */
export function dampedWave(parent: Element, opts: { lead?: string } = {}): SVGSVGElement {
  const W = 320;
  const H = 80;
  const mid = H / 2;

  const svg = svgEl('svg', {
    viewBox: `0 0 ${W} ${H}`,
    class: 'damped-wave',
    'aria-hidden': 'true',
  });

  // Baseline first, so the ringing sits on top of the line it decays to.
  svgEl('line', { class: 'damped-base', x1: 0, y1: mid, x2: W, y2: mid }, svg);

  const trace = (phase: number, amplitude: number, cls: string) => {
    const pts: string[] = [];
    for (let x = 0; x <= 200; x += 2) {
      const t = x / 200;
      const decay = Math.exp(-t * 4.2);
      const y = mid - Math.sin(t * Math.PI * 7 + phase) * amplitude * decay;
      pts.push(`${x.toFixed(1)},${y.toFixed(2)}`);
    }
    // Once the ringing has died the trace is the baseline, so it runs on flat.
    pts.push(`${W},${mid}`);
    svgEl('polyline', { class: `damped-trace ${cls}`, points: pts.join(' ') }, svg);
  };

  trace(0, 30, opts.lead ?? 'damped-lead');
  trace(Math.PI * 0.85, 26, 'damped-follow');

  parent.appendChild(svg);
  return svg;
}

/** The big percentage, its title, and the settling waveform under it. */
export class MaiCard {
  readonly root: HTMLElement;
  private value: HTMLElement;
  private note: HTMLElement;

  constructor(container: HTMLElement, opts: { framed?: boolean } = {}) {
    this.root = el('section', `mai-card${opts.framed === false ? '' : ' is-framed'}`, container);

    const title = el('h2', 'mai-title', this.root);
    title.textContent = 'Mutual Affection Index';

    this.value = el('div', 'mai-value', this.root);
    this.value.textContent = '—';

    dampedWave(this.root);

    this.note = el('p', 'mai-note', this.root);
    this.note.textContent = '';
  }

  update(score: AffectionScore | null): void {
    if (!score) {
      this.value.textContent = '—';
      this.note.textContent = 'Not enough from both subjects yet.';
      this.root.classList.remove('is-provisional');
      return;
    }
    this.value.textContent = `${score.value}%`;
    // Coverage is the one caveat worth carrying onto the hero number: a score
    // built on half a window is a different claim from one built on a whole one.
    this.root.classList.toggle('is-provisional', !score.confident);
    this.note.textContent = score.confident ? '' : 'Provisional — one stream is dropping out.';
  }
}

/** The verdict, its prescription, and the upsell. */
export class DiagnosisCard {
  readonly root: HTMLElement;
  private summary: HTMLElement;
  private actions: HTMLElement;

  constructor(container: HTMLElement) {
    this.root = el('section', 'diagnosis-card is-framed', container);

    const title = el('h2', 'diagnosis-title', this.root);
    title.textContent = 'Diagnosis';

    this.summary = el('p', 'diagnosis-summary', this.root);

    const label = el('p', 'diagnosis-label', this.root);
    label.textContent = 'Suggested actions:';

    this.actions = el('ul', 'diagnosis-actions', this.root);

    const unlock = el('button', 'diagnosis-unlock', this.root);
    unlock.type = 'button';
    unlock.textContent = 'Unlock Full Prescription for $1';
    // The upsell is part of the joke, not a real payment path. Saying so out
    // loud beats a dead control that looks like it should charge someone.
    unlock.addEventListener('click', () => {
      unlock.textContent = 'Payment declined. Please consult a medical professional.';
      unlock.disabled = true;
    });

    this.update(null);
  }

  update(score: AffectionScore | null): void {
    if (!score) {
      this.summary.textContent = 'Awaiting sufficient data from both subjects.';
      this.actions.innerHTML = '';
      return;
    }
    const d = diagnose(score.value);
    this.summary.textContent = `Your affection score lies within the ${d.range} range.`;
    this.actions.innerHTML = d.actions.map((a) => `<li>${a}</li>`).join('');
  }
}

/** Headline and directive, as the verdict frame shows them. */
export function diagnosisHeadline(score: AffectionScore | null): Diagnosis | null {
  return score ? diagnose(score.value) : null;
}
