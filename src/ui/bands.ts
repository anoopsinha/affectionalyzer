import type { EegBands } from '../neuroskill/types';
import { setAttrs, svgEl } from './svg';

/**
 * Relative band power, pooled across the four electrodes.
 *
 * Bars carry a value label at every tip. That is deliberate, not decoration:
 * three of these five light-mode hues sit under 3:1 against the surface, and the
 * palette's relief rule requires visible labels when they do.
 */

const BANDS = [
  { id: 'rel_delta', symbol: 'δ', label: 'Delta', range: '1–4 Hz', colorVar: 'var(--series-1)' },
  { id: 'rel_theta', symbol: 'θ', label: 'Theta', range: '4–8 Hz', colorVar: 'var(--series-2)' },
  { id: 'rel_alpha', symbol: 'α', label: 'Alpha', range: '8–13 Hz', colorVar: 'var(--series-3)' },
  { id: 'rel_beta', symbol: 'β', label: 'Beta', range: '13–30 Hz', colorVar: 'var(--series-4)' },
  { id: 'rel_gamma', symbol: 'γ', label: 'Gamma', range: '30–50 Hz', colorVar: 'var(--series-5)' },
] as const;

const W = 520;
const ROW_H = 42;
const LABEL_W = 44;
const VALUE_W = 74;
const TRACK_W = W - LABEL_W - VALUE_W;
/** Half-width of the marker triangle. */
const MARKER = 9;

export class BandBars {
  readonly root: HTMLElement;
  private bars = new Map<string, SVGRectElement>();
  private values = new Map<string, SVGTextElement>();
  private tooltip: HTMLElement;
  private latest: EegBands | null = null;

  /**
   * `subject` names whose bands these are. Two of these panels sit one above the
   * other, so each has to say which head it is reading — an unlabelled pair
   * would be two identical charts of different people.
   */
  constructor(container: HTMLElement, subject?: { label: string; markerClass: string }) {
    this.root = document.createElement('figure');
    this.root.className = 'card bands';
    container.appendChild(this.root);

    const head = document.createElement('figcaption');
    head.className = 'chart-head';
    head.innerHTML = subject
      ? `
      <h2><span class="bands-subject ${subject.markerClass}"></span>Relative Band Strength · ${subject.label}</h2>
      <p class="chart-sub">delta, theta, alpha, beta, gamma</p>
    `
      : `
      <h2>Relative Band Strength</h2>
      <p class="chart-sub">delta, theta, alpha, beta, gamma</p>
    `;
    this.root.appendChild(head);

    const wrap = document.createElement('div');
    wrap.className = 'chart-plot';
    this.root.appendChild(wrap);

    const svg = svgEl('svg', {
      viewBox: `0 0 ${W} ${BANDS.length * ROW_H + 6}`,
      class: 'bands-svg',
      role: 'img',
      'aria-label': subject
        ? `Relative band power by frequency band for ${subject.label}`
        : 'Relative band power by frequency band',
    });
    wrap.appendChild(svg);

    BANDS.forEach((band, i) => {
      const y = i * ROW_H + 4;
      const cy = y + ROW_H / 2 - 4;

      const label = svgEl(
        'text',
        { class: 'band-symbol', x: LABEL_W - 14, y: cy + 7, 'text-anchor': 'end' },
        svg,
      );
      label.textContent = band.symbol;
      // The Greek letter is the mark; the full name stays available to a reader
      // who does not already know it.
      const title = svgEl('title', {}, label);
      title.textContent = `${band.label} (${band.range})`;

      svgEl(
        'line',
        { class: 'band-rule', x1: LABEL_W, y1: cy, x2: LABEL_W + TRACK_W, y2: cy },
        svg,
      );

      // A marker riding a rule, not a filled bar: position alone carries the
      // value, which is what the storyboard asks for and what keeps five rows
      // from reading as five competing quantities.
      const bar = svgEl('path', { class: 'band-marker', d: '' }, svg);
      bar.dataset.band = band.id;
      this.bars.set(band.id, bar as unknown as SVGRectElement);

      const value = svgEl(
        'text',
        { class: 'band-value', x: W, y: cy + 5, 'text-anchor': 'end' },
        svg,
      );
      value.textContent = '—';
      this.values.set(band.id, value);

      // Hit target spans the whole row, not just the drawn bar.
      const hit = svgEl(
        'rect',
        { class: 'band-hit', x: 0, y, width: W, height: ROW_H, fill: 'transparent' },
        svg,
      );
      hit.addEventListener('pointerenter', () => this.showTip(band, i));
      hit.addEventListener('pointerleave', () => {
        this.tooltip.hidden = true;
      });
    });

    this.tooltip = document.createElement('div');
    this.tooltip.className = 'tooltip';
    this.tooltip.hidden = true;
    wrap.appendChild(this.tooltip);
  }

  private showTip(band: (typeof BANDS)[number], row: number): void {
    if (!this.latest) return;
    const rel = numOr(this.latest[band.id], 0);
    const perChannel = (this.latest.channels ?? [])
      .map((c) => {
        const v = numOr((c as unknown as Record<string, unknown>)[band.id], 0);
        return `<dt>${c.channel}</dt><dd>${(v * 100).toFixed(1)}%</dd>`;
      })
      .join('');

    this.tooltip.hidden = false;
    this.tooltip.innerHTML = `
      <div class="tooltip-title">${band.label} · ${band.range}</div>
      <dl><dt>Pooled</dt><dd>${(rel * 100).toFixed(1)}%</dd>${perChannel}</dl>
    `;
    this.tooltip.style.left = '50%';
    this.tooltip.style.top = `${row * ROW_H + 8}px`;
    this.tooltip.classList.remove('flip-x');
  }

  update(bands: EegBands): void {
    this.latest = bands;
    // Scale to the largest band rather than to 1.0: relative powers rarely
    // exceed ~0.6, and a fixed 0-1 axis would leave every bar stubby.
    let max = 0;
    for (const b of BANDS) max = Math.max(max, numOr(bands[b.id], 0));
    const scale = max > 0 ? max : 1;

    BANDS.forEach((b, i) => {
      const v = numOr(bands[b.id], 0);
      const cy = i * ROW_H + 4 + ROW_H / 2 - 4;
      const x = LABEL_W + Math.max(0, Math.min(1, v / scale)) * TRACK_W;
      // Triangle pointing down onto the rule, as drawn in the storyboard.
      setAttrs(this.bars.get(b.id)!, {
        d: `M ${x - MARKER} ${cy - MARKER - 1} L ${x + MARKER} ${cy - MARKER - 1} L ${x} ${cy + 2} Z`,
      });
      this.values.get(b.id)!.textContent = `${(v * 100).toFixed(1)}%`;
    });
  }
}

function numOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
