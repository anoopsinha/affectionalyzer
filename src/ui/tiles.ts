import type { AffectModel, AffectSample } from '../affect/model';
import { fmt, svgEl } from './svg';

/**
 * Supporting brain-state scores, one strip per subject.
 *
 * These are single numbers with a shape, not comparisons, so they get no chart.
 * Frame 05 runs them across the width as one band rather than boxing each in a
 * card: five bordered cards read as five separate things competing for
 * attention, where the strip reads as one row of supporting detail under the
 * verdict. The sparkline stays, small and recessive, because the direction a
 * score is moving is worth more than any single reading of it.
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

/** One subject's row: its marker, its label, and its five readings. */
interface Row {
  root: HTMLElement;
  nodes: Map<string, TileNodes>;
  model: AffectModel | null;
}

export class Tiles {
  readonly root: HTMLElement;
  private rows: Record<'self' | 'partner', Row>;

  constructor(container: HTMLElement) {
    this.root = document.createElement('section');
    this.root.className = 'tiles';
    this.root.setAttribute('aria-label', 'Supporting brain-state scores');
    container.appendChild(this.root);

    this.rows = {
      self: this.addRow('Subject A', 'marker-self'),
      partner: this.addRow('Subject B', 'marker-partner'),
    };
    // Solo sessions show one unlabelled row, as they did before there was a
    // second subject to tell it apart from.
    this.rows.partner.root.hidden = true;
    this.root.classList.add('is-solo');
  }

  private addRow(label: string, markerClass: string): Row {
    const root = document.createElement('div');
    root.className = 'tiles-row';
    this.root.appendChild(root);

    const name = document.createElement('span');
    name.className = `tiles-subject ${markerClass}`;
    name.textContent = label;
    root.appendChild(name);

    const nodes = new Map<string, TileNodes>();

    for (const def of TILES) {
      const tile = document.createElement('article');
      tile.className = 'tile';

      const label = document.createElement('h3');
      label.className = 'tile-label';
      label.textContent = def.label;
      tile.appendChild(label);

      const value = document.createElement('div');
      // A dash at value size reads as a solid bar until it is dimmed; the class
      // comes off as soon as there is a number.
      value.className = 'tile-value is-empty';
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

      // The formula no longer has a visible line in the strip, but it is the
      // only thing that makes the score checkable, so it stays on hover.
      tile.title = `${def.label} — ${def.hint}`;

      root.appendChild(tile);
      nodes.set(def.id, { value, meterFill, spark, sparkDot });
    }

    return { root, nodes, model: null };
  }

  bind(model: AffectModel): void {
    this.rows.self.model = model;
  }

  /** Bind the second subject's row. `null` returns to a single unlabelled row. */
  bindPartner(model: AffectModel | null): void {
    this.rows.partner.model = model;
    this.rows.partner.root.hidden = !model;
    this.root.classList.toggle('is-solo', !model);
  }

  render(): void {
    this.renderRow(this.rows.self);
    if (this.rows.partner.model) this.renderRow(this.rows.partner);
  }

  private renderRow(row: Row): void {
    if (!row.model) return;
    const history = row.model.history;
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
      const n = row.nodes.get(def.id)!;
      const v = def.value(latest);
      n.value.textContent = fmt(v, 1);
      n.value.classList.remove('is-empty');
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
