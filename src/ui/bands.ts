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
  { id: 'rel_delta', label: 'Delta', range: '1–4 Hz', colorVar: 'var(--series-1)' },
  { id: 'rel_theta', label: 'Theta', range: '4–8 Hz', colorVar: 'var(--series-2)' },
  { id: 'rel_alpha', label: 'Alpha', range: '8–13 Hz', colorVar: 'var(--series-3)' },
  { id: 'rel_beta', label: 'Beta', range: '13–30 Hz', colorVar: 'var(--series-4)' },
  { id: 'rel_gamma', label: 'Gamma', range: '30–50 Hz', colorVar: 'var(--series-5)' },
] as const;

const W = 520;
const ROW_H = 34;
const BAR_H = 18; // capped well under the row so the band keeps its air
const LABEL_W = 68;
const VALUE_W = 52;
const TRACK_W = W - LABEL_W - VALUE_W;

export class BandBars {
  readonly root: HTMLElement;
  private bars = new Map<string, SVGRectElement>();
  private values = new Map<string, SVGTextElement>();
  private tooltip: HTMLElement;
  private latest: EegBands | null = null;

  constructor(container: HTMLElement) {
    this.root = document.createElement('figure');
    this.root.className = 'card bands';
    container.appendChild(this.root);

    const head = document.createElement('figcaption');
    head.className = 'chart-head';
    head.innerHTML = `
      <h2>Band power</h2>
      <p class="chart-sub">Relative power across all four electrodes.</p>
    `;
    this.root.appendChild(head);

    const wrap = document.createElement('div');
    wrap.className = 'chart-plot';
    this.root.appendChild(wrap);

    const svg = svgEl('svg', {
      viewBox: `0 0 ${W} ${BANDS.length * ROW_H + 6}`,
      class: 'bands-svg',
      role: 'img',
      'aria-label': 'Relative band power by frequency band',
    });
    wrap.appendChild(svg);

    BANDS.forEach((band, i) => {
      const y = i * ROW_H + 4;
      const cy = y + BAR_H / 2;

      const label = svgEl(
        'text',
        { class: 'band-label', x: LABEL_W - 10, y: cy + 4, 'text-anchor': 'end' },
        svg,
      );
      label.textContent = band.label;

      svgEl(
        'rect',
        { class: 'band-track', x: LABEL_W, y, width: TRACK_W, height: BAR_H, rx: 4 },
        svg,
      );

      const bar = svgEl(
        'rect',
        {
          class: 'band-bar',
          x: LABEL_W,
          y,
          width: 0,
          height: BAR_H,
          rx: 4,
          style: `fill:${band.colorVar}`,
        },
        svg,
      );
      bar.dataset.band = band.id;
      this.bars.set(band.id, bar);

      const value = svgEl(
        'text',
        { class: 'band-value', x: W - 8, y: cy + 4, 'text-anchor': 'end' },
        svg,
      );
      value.textContent = '—';
      this.values.set(band.id, value);

      // Hit target spans the whole row, not just the drawn bar.
      const hit = svgEl(
        'rect',
        { class: 'band-hit', x: 0, y: y - 4, width: W, height: ROW_H, fill: 'transparent' },
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

    for (const b of BANDS) {
      const v = numOr(bands[b.id], 0);
      setAttrs(this.bars.get(b.id)!, { width: Math.max(0, (v / scale) * TRACK_W) });
      this.values.get(b.id)!.textContent = `${(v * 100).toFixed(1)}%`;
    }
  }
}

function numOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
