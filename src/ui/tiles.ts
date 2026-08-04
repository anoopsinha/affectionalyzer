import type { AffectModel, AffectSample } from '../affect/model';
import { fmt, svgEl } from './svg';

/**
 * Supporting brain-state scores as stat tiles with 12-point sparklines.
 *
 * These are single numbers with a shape, not comparisons, so the form is a tile
 * rather than a chart. The sparkline rides the de-emphasis ink; the value
 * carries the reading.
 */

interface TileDef {
  id: string;
  label: string;
  hint: string;
  value: (s: AffectSample) => number;
}

const TILES: TileDef[] = [
  { id: 'engagement', label: 'Engagement', hint: 'β / (α + θ)', value: (s) => s.engagement },
  {
    id: 'cognitive_load',
    label: 'Cognitive load',
    hint: 'frontal θ / temporal α',
    value: (s) => s.cognitiveLoad,
  },
  { id: 'relaxation', label: 'Relaxation', hint: 'α / (β + θ)', value: (s) => s.relaxation },
  { id: 'meditation', label: 'Meditation', hint: 'α-dominance + stillness', value: (s) => s.meditation },
  { id: 'drowsiness', label: 'Drowsiness', hint: '(δ + θ) / (α + β)', value: (s) => s.drowsiness },
];

const SPARK_N = 12;
const SPARK_W = 72;
const SPARK_H = 22;

interface TileNodes {
  value: HTMLElement;
  meterFill: HTMLElement;
  spark: SVGPolylineElement;
  sparkDot: SVGCircleElement;
}

export class Tiles {
  readonly root: HTMLElement;
  private nodes = new Map<string, TileNodes>();
  private model: AffectModel | null = null;

  constructor(container: HTMLElement) {
    this.root = document.createElement('section');
    this.root.className = 'tiles';
    this.root.setAttribute('aria-label', 'Supporting brain-state scores');
    container.appendChild(this.root);

    for (const def of TILES) {
      const tile = document.createElement('article');
      tile.className = 'tile';

      const label = document.createElement('h3');
      label.className = 'tile-label';
      label.textContent = def.label;
      tile.appendChild(label);

      const value = document.createElement('div');
      value.className = 'tile-value';
      value.textContent = '—';
      tile.appendChild(value);

      const meter = document.createElement('div');
      meter.className = 'tile-meter';
      const meterFill = document.createElement('div');
      meterFill.className = 'tile-meter-fill';
      meter.appendChild(meterFill);
      tile.appendChild(meter);

      const svg = svgEl('svg', {
        viewBox: `0 0 ${SPARK_W} ${SPARK_H}`,
        class: 'sparkline',
        'aria-hidden': 'true',
      });
      tile.appendChild(svg);
      const spark = svgEl('polyline', { class: 'spark-line', points: '' }, svg);
      const sparkDot = svgEl('circle', { class: 'spark-dot', r: 2.5, cx: -10, cy: -10 }, svg);

      const hint = document.createElement('p');
      hint.className = 'tile-hint';
      hint.textContent = def.hint;
      tile.appendChild(hint);

      this.root.appendChild(tile);
      this.nodes.set(def.id, { value, meterFill, spark, sparkDot });
    }
  }

  bind(model: AffectModel): void {
    this.model = model;
  }

  render(): void {
    if (!this.model) return;
    const history = this.model.history;
    if (!history.length) return;
    const latest = history[history.length - 1];

    // Even samples across the window rather than the last 12 frames, so the
    // sparkline spans real time instead of the last 1.5 seconds. `span` is the
    // last valid index, so a single-sample history repeats that sample rather
    // than indexing past the end.
    const picks: AffectSample[] = [];
    const span = history.length - 1;
    for (let i = 0; i < SPARK_N; i += 1) {
      picks.push(history[Math.round((i / (SPARK_N - 1)) * span)]);
    }

    for (const def of TILES) {
      const n = this.nodes.get(def.id)!;
      const v = def.value(latest);
      n.value.textContent = fmt(v, 1);
      n.meterFill.style.width = `${Math.min(100, Math.max(0, v))}%`;

      const pts = picks.map((s, i) => {
        const x = (i / (SPARK_N - 1)) * SPARK_W;
        const y = SPARK_H - 2 - (Math.min(100, Math.max(0, def.value(s))) / 100) * (SPARK_H - 4);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      });
      n.spark.setAttribute('points', pts.join(' '));
      const [lx, ly] = pts[pts.length - 1].split(',');
      n.sparkDot.setAttribute('cx', lx);
      n.sparkDot.setAttribute('cy', ly);
    }
  }
}
