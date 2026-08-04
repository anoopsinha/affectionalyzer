import type { AffectModel, AffectSample } from '../affect/model';
import { fmt, setAttrs, showMark, svgEl } from './svg';

/**
 * Mood and arousal against time. Both series are 0-100 daemon scores, so they
 * share one y-axis — the alternative, a second scale, is the mistake this chart
 * exists to avoid.
 */

const W = 720;
const H = 200;
const PAD_L = 34;
const PAD_R = 16;
const PAD_T = 14;
const PAD_B = 24;
const PLOT_W = W - PAD_L - PAD_R;
const PLOT_H = H - PAD_T - PAD_B;

interface SeriesDef {
  id: 'mood' | 'arousal';
  label: string;
  colorVar: string;
  value: (s: AffectSample) => number;
}

const SERIES: SeriesDef[] = [
  { id: 'mood', label: 'Mood (valence)', colorVar: 'var(--series-1)', value: (s) => s.moodSmooth },
  {
    id: 'arousal',
    label: 'Arousal',
    colorVar: 'var(--series-2)',
    // Plotted back on the 0-100 score scale it was derived from, so both
    // series share the axis honestly.
    value: (s) => s.arousal * 50 + 50,
  },
];

export class TimeSeries {
  readonly root: HTMLElement;
  private svg: SVGSVGElement;
  private paths = new Map<string, SVGPolylineElement>();
  private endDots = new Map<string, SVGCircleElement>();
  private endLabels = new Map<string, SVGTextElement>();
  private crosshair: SVGLineElement;
  private tooltip: HTMLElement;
  private model: AffectModel | null = null;
  private windowMs: number;

  constructor(container: HTMLElement, windowMs = 120_000) {
    this.windowMs = windowMs;

    this.root = document.createElement('figure');
    this.root.className = 'card timeseries';
    container.appendChild(this.root);

    const head = document.createElement('figcaption');
    head.className = 'chart-head';
    head.innerHTML = `
      <h2>Trend</h2>
      <p class="chart-sub">Last ${Math.round(windowMs / 1000)} seconds, both on the 0–100 score scale.</p>
    `;
    this.root.appendChild(head);

    // Legend is mandatory at two or more series — identity never rests on colour alone.
    const legend = document.createElement('div');
    legend.className = 'legend';
    legend.innerHTML = SERIES.map(
      (s) =>
        `<span class="legend-item"><span class="legend-key" style="background:${s.colorVar}"></span>${s.label}</span>`,
    ).join('');
    this.root.appendChild(legend);

    const wrap = document.createElement('div');
    wrap.className = 'chart-plot';
    this.root.appendChild(wrap);

    this.svg = svgEl('svg', {
      viewBox: `0 0 ${W} ${H}`,
      preserveAspectRatio: 'none',
      role: 'img',
      'aria-label': 'Mood and arousal over time',
    });
    this.svg.classList.add('timeseries-svg');
    wrap.appendChild(this.svg);

    this.drawGrid();

    this.crosshair = svgEl(
      'line',
      { class: 'crosshair mark-hidden', x1: 0, x2: 0, y1: PAD_T, y2: PAD_T + PLOT_H },
      this.svg,
    );

    for (const s of SERIES) {
      const p = svgEl(
        'polyline',
        { class: 'series-line', points: '', style: `stroke:${s.colorVar}` },
        this.svg,
      );
      this.paths.set(s.id, p);
    }
    for (const s of SERIES) {
      const ring = svgEl('circle', { class: 'end-ring mark-hidden', r: 6, cx: 0, cy: 0 }, this.svg);
      ring.dataset.for = s.id;
      const dot = svgEl(
        'circle',
        { class: 'end-dot mark-hidden', r: 4, cx: 0, cy: 0, style: `fill:${s.colorVar}` },
        this.svg,
      );
      this.endDots.set(s.id, dot);
      // One label per series, at the line end only — never a number per point.
      const label = svgEl('text', { class: 'end-label mark-hidden', x: 0, y: 0 }, this.svg);
      this.endLabels.set(s.id, label);
    }

    this.tooltip = document.createElement('div');
    this.tooltip.className = 'tooltip';
    this.tooltip.hidden = true;
    wrap.appendChild(this.tooltip);

    this.attachHover(wrap);
  }

  private drawGrid(): void {
    const g = svgEl('g', { class: 'grid' }, this.svg);
    for (const v of [0, 25, 50, 75, 100]) {
      const y = PAD_T + PLOT_H * (1 - v / 100);
      svgEl(
        'line',
        { class: v === 50 ? 'gridline midline' : 'gridline', x1: PAD_L, x2: W - PAD_R, y1: y, y2: y },
        g,
      );
      const t = svgEl(
        'text',
        { class: 'tick', x: PAD_L - 8, y: y + 3.5, 'text-anchor': 'end' },
        g,
      );
      t.textContent = String(v);
    }
  }

  bind(model: AffectModel): void {
    this.model = model;
  }

  private xFor(t: number, now: number): number {
    const age = now - t;
    return PAD_L + PLOT_W * (1 - Math.min(1, age / this.windowMs));
  }

  private static yFor(score: number): number {
    return PAD_T + PLOT_H * (1 - Math.min(100, Math.max(0, score)) / 100);
  }

  render(): void {
    if (!this.model) return;
    const history = this.model.history;
    if (!history.length) return;
    const now = history[history.length - 1].t;

    for (const s of SERIES) {
      const pts: string[] = [];
      for (const sample of history) {
        if (now - sample.t > this.windowMs) continue;
        pts.push(
          `${this.xFor(sample.t, now).toFixed(1)},${TimeSeries.yFor(s.value(sample)).toFixed(1)}`,
        );
      }
      this.paths.get(s.id)!.setAttribute('points', pts.join(' '));
    }

    const last = history[history.length - 1];
    const placed: Array<{ id: string; y: number }> = [];
    for (const s of SERIES) {
      const v = s.value(last);
      const cx = this.xFor(last.t, now);
      const cy = TimeSeries.yFor(v);
      const dot = this.endDots.get(s.id)!;
      setAttrs(dot, { cx, cy });
      showMark(dot, true);
      const ring = this.svg.querySelector<SVGCircleElement>(`.end-ring[data-for="${s.id}"]`);
      if (ring) {
        setAttrs(ring, { cx, cy });
        showMark(ring, true);
      }

      // Nudge only when the two end-labels would overlap; they stay attached to
      // their own dot the rest of the time.
      let labelY = cy - 10;
      for (const p of placed) {
        if (Math.abs(labelY - p.y) < 13) labelY = p.y + 14;
      }
      placed.push({ id: s.id, y: labelY });

      const label = this.endLabels.get(s.id)!;
      setAttrs(label, { x: cx - 8, y: labelY, 'text-anchor': 'end' });
      label.textContent = fmt(v, 0);
      showMark(label, true);
    }
  }

  private attachHover(wrap: HTMLElement): void {
    const hide = () => {
      this.tooltip.hidden = true;
      showMark(this.crosshair, false);
    };
    wrap.addEventListener('pointerleave', hide);
    wrap.addEventListener('pointermove', (ev) => {
      if (!this.model) return;
      const history = this.model.history;
      if (!history.length) return hide();
      const now = history[history.length - 1].t;

      const rect = this.svg.getBoundingClientRect();
      const sx = ((ev.clientX - rect.left) / rect.width) * W;
      if (sx < PAD_L || sx > W - PAD_R) return hide();

      let best: AffectSample | null = null;
      let bestD = Infinity;
      for (const s of history) {
        const d = Math.abs(this.xFor(s.t, now) - sx);
        if (d < bestD) {
          bestD = d;
          best = s;
        }
      }
      if (!best) return hide();

      const bx = this.xFor(best.t, now);
      setAttrs(this.crosshair, { x1: bx, x2: bx });
      showMark(this.crosshair, true);

      const ageS = (now - best.t) / 1000;
      this.tooltip.hidden = false;
      this.tooltip.innerHTML = `
        <div class="tooltip-title">${ageS < 1 ? 'now' : `${ageS.toFixed(0)}s ago`}</div>
        <dl>
          ${SERIES.map(
            (s) =>
              `<dt><span class="legend-key" style="background:${s.colorVar}"></span>${s.label}</dt><dd>${fmt(s.value(best!), 1)}</dd>`,
          ).join('')}
          <dt>FAA</dt><dd>${fmt(best.faa, 2)}</dd>
        </dl>
      `;
      const px = (bx / W) * rect.width;
      this.tooltip.style.left = `${px}px`;
      this.tooltip.style.top = `8px`;
      this.tooltip.classList.toggle('flip-x', px > rect.width * 0.6);
    });
  }
}
