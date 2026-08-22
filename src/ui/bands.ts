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

/*
 * Laid out in measured pixels rather than in a fixed viewBox.
 *
 * The chart used to be a 520-unit box scaled to whatever width the card had,
 * which made every dimension in it — the row spacing and the type most of all —
 * a function of the column width. In a narrow column the labels came out at
 * eight pixels while five rows huddled at the top of a box with nothing under
 * them. Measuring the plot and drawing 1:1 into it means the rows spread over
 * the height the card actually has, and a font size in the stylesheet is the
 * size it renders at, in every frame.
 */

/** Right edge of the Greek symbol; the track starts a little past it. */
const LABEL_W = 26;
const TRACK_X = 38;
/** Room reserved on the right for the percentage, at the row-label size. */
const VALUE_W = 50;
/** Half-width of the marker triangle. */
const MARKER = 8;
const MIN_ROW_H = 26;

export class BandBars {
  readonly root: HTMLElement;
  private bars = new Map<string, SVGRectElement>();
  private values = new Map<string, SVGTextElement>();
  private tooltip: HTMLElement;
  private latest: EegBands | null = null;
  private svg: SVGSVGElement;
  private wrap: HTMLElement;
  private symbols: SVGTextElement[] = [];
  private rules: SVGLineElement[] = [];
  private hits: SVGRectElement[] = [];
  /** Last measured plot size, so a no-op resize does not redraw. */
  private w = 0;
  private h = 0;

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
    this.wrap = wrap;

    const svg = svgEl('svg', {
      viewBox: '0 0 100 100',
      class: 'bands-svg',
      role: 'img',
      'aria-label': subject
        ? `Relative band power by frequency band for ${subject.label}`
        : 'Relative band power by frequency band',
    });
    wrap.appendChild(svg);
    this.svg = svg as SVGSVGElement;

    BANDS.forEach((band, i) => {
      const label = svgEl('text', { class: 'band-symbol', 'text-anchor': 'end' }, svg);
      label.textContent = band.symbol;
      // The Greek letter is the mark; the full name stays available to a reader
      // who does not already know it.
      const title = svgEl('title', {}, label);
      title.textContent = `${band.label} (${band.range})`;
      this.symbols.push(label);

      this.rules.push(svgEl('line', { class: 'band-rule' }, svg) as SVGLineElement);

      // A marker riding a rule, not a filled bar: position alone carries the
      // value, which is what the storyboard asks for and what keeps five rows
      // from reading as five competing quantities.
      const bar = svgEl('path', { class: 'band-marker', d: '' }, svg);
      bar.dataset.band = band.id;
      this.bars.set(band.id, bar as unknown as SVGRectElement);

      const value = svgEl('text', { class: 'band-value', 'text-anchor': 'end' }, svg);
      value.textContent = '—';
      this.values.set(band.id, value);

      // Hit target spans the whole row, not just the drawn bar.
      const hit = svgEl('rect', { class: 'band-hit', x: 0, fill: 'transparent' }, svg);
      hit.addEventListener('pointerenter', () => this.showTip(band, i));
      hit.addEventListener('pointerleave', () => {
        this.tooltip.hidden = true;
      });
      this.hits.push(hit as SVGRectElement);
    });

    this.tooltip = document.createElement('div');
    this.tooltip.className = 'tooltip';
    this.tooltip.hidden = true;
    wrap.appendChild(this.tooltip);

    // The plot has no size until the card is in the grid and the fonts land, so
    // the layout is driven by what the box turns out to be rather than measured
    // once here and left.
    new ResizeObserver(() => this.layout()).observe(wrap);
  }

  private get rowH(): number {
    return Math.max(MIN_ROW_H, this.h / BANDS.length);
  }

  /** Y centre of row `i`, spread evenly over the plot's measured height. */
  private centre(i: number): number {
    return this.rowH * (i + 0.5);
  }

  /**
   * Re-place every row for the plot's current pixel size.
   *
   * Drawing 1:1 means the SVG carries no scale of its own, so this has to run
   * whenever the box changes — but only then, which is what the cached size is
   * for. A resize observer firing on an unchanged box is common.
   */
  private layout(): void {
    const w = Math.round(this.wrap.clientWidth);
    const h = Math.round(this.wrap.clientHeight);
    if (w <= 0 || h <= 0 || (w === this.w && h === this.h)) return;
    this.w = w;
    this.h = h;

    setAttrs(this.svg, { viewBox: `0 0 ${w} ${h}` });

    const trackEnd = Math.max(TRACK_X + 20, w - VALUE_W);
    BANDS.forEach((_, i) => {
      const cy = this.centre(i);
      setAttrs(this.symbols[i], { x: LABEL_W, y: cy });
      setAttrs(this.rules[i], { x1: TRACK_X, y1: cy, x2: trackEnd, y2: cy });
      setAttrs(this.hits[i], {
        y: cy - this.rowH / 2,
        width: w,
        height: this.rowH,
      });
    });
    BANDS.forEach((band, i) => {
      setAttrs(this.values.get(band.id)!, { x: w, y: this.centre(i) });
    });

    // Marker positions are in track units, so the last reading has to be redrawn
    // against the new track rather than left where the old width put it.
    if (this.latest) this.update(this.latest);
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
    this.tooltip.style.top = `${this.centre(row) - this.rowH / 2 + 4}px`;
    this.tooltip.classList.remove('flip-x');
  }

  update(bands: EegBands): void {
    this.latest = bands;
    // Scale to the largest band rather than to 1.0: relative powers rarely
    // exceed ~0.6, and a fixed 0-1 axis would leave every bar stubby.
    let max = 0;
    for (const b of BANDS) max = Math.max(max, numOr(bands[b.id], 0));
    const scale = max > 0 ? max : 1;

    const trackEnd = Math.max(TRACK_X + 20, this.w - VALUE_W);
    const trackW = trackEnd - TRACK_X;
    BANDS.forEach((b, i) => {
      const v = numOr(bands[b.id], 0);
      const cy = this.centre(i);
      const x = TRACK_X + Math.max(0, Math.min(1, v / scale)) * trackW;
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
