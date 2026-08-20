import type { AffectModel } from '../affect/model';
import { quadrantLabel } from '../affect/model';
import { el, fmt, fmtSigned } from './svg';

/**
 * The mood index: one subject's smoothed valence as a single large figure.
 *
 * A component rather than markup in `main.ts` because there are two of them
 * now, and the original built its lookups on `id` attributes — a second copy
 * would have produced duplicate ids and quietly driven both panels from the
 * first one's elements.
 */
export class MoodHero {
  readonly root: HTMLElement;
  private valueEl: HTMLElement;
  private stateEl: HTMLElement;
  private faaEl: HTMLElement;
  private model: AffectModel | null = null;

  constructor(container: HTMLElement, subject?: { label: string; markerClass: string }) {
    this.root = el('section', 'card hero', container);

    const label = el('h2', 'hero-label', this.root);
    label.innerHTML = subject
      ? `<span class="hero-subject ${subject.markerClass}"></span>Mood index · ${subject.label}`
      : 'Mood index';

    this.valueEl = el('div', 'hero-value is-empty', this.root);
    this.valueEl.textContent = '—';

    const meta = el('div', 'hero-meta', this.root);
    this.stateEl = el('span', 'hero-state', meta);
    this.stateEl.textContent = 'Awaiting data…';
    const detail = el('span', 'hero-detail', meta);
    detail.innerHTML = 'FAA <b>—</b> · 50 is neutral';
    this.faaEl = detail.querySelector('b')!;

    const note = el('p', 'hero-note', this.root);
    note.textContent =
      'Frontal alpha asymmetry, rescaled 0–100 and smoothed over ~1.5 s. Above 60 leans ' +
      'approach/positive; below 40 leans withdrawal/negative. FAA is trait-like and highly ' +
      'individual — read shifts against your own baseline, not absolutes.';
  }

  bind(model: AffectModel | null): void {
    this.model = model;
    if (!model) this.render();
  }

  render(): void {
    const s = this.model?.latest ?? null;
    if (!s) {
      // Falls back to the empty state rather than returning early. The original
      // returned on no-sample, so after a reset it kept displaying the previous
      // pair's figure until fresh data arrived — the same stale-claim bug the
      // trails had.
      this.valueEl.textContent = '—';
      this.valueEl.classList.add('is-empty');
      this.stateEl.textContent = 'Awaiting data…';
      this.stateEl.className = 'hero-state';
      this.faaEl.textContent = '—';
      return;
    }
    this.valueEl.textContent = fmt(s.moodSmooth, 1);
    this.valueEl.classList.remove('is-empty');
    this.stateEl.textContent = quadrantLabel(s.valence, s.arousal);
    this.stateEl.className = `hero-state ${
      s.moodSmooth >= 60 ? 'lean-positive' : s.moodSmooth <= 40 ? 'lean-negative' : 'lean-neutral'
    }`;
    this.faaEl.textContent = fmtSigned(s.faa, 2);
  }
}
