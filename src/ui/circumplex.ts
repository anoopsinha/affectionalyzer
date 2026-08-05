import type { AffectModel, AffectSample } from '../affect/model';
import { quadrantLabel } from '../affect/model';
import { fmt, setAttrs, showMark, svgEl } from './svg';

/**
 * The valence x arousal circumplex — the dashboard's hero chart.
 *
 * A scatter of one live point plus a decaying trail. Position is the encoding;
 * the point's fill additionally carries valence on the diverging blue-red ramp
 * so the sign of the affect reads without tracing back to the axis.
 *
 * With a partner stream bound, a second point and trail are drawn and joined by
 * a line whose length is the pair's affective distance. The two subjects are
 * distinguished by *shape* — circle for you, diamond for the partner — because
 * both points already spend their colour budget encoding valence, and telling
 * the subjects apart must not depend on hue.
 */

const VIEW = 400;
const PAD = 44;
const PLOT = VIEW - PAD * 2;

/** Trail is split into two strata so recency reads without per-point opacity. */
const RECENT_MS = 15_000;

export interface CircumplexOptions {
  /** Trailing window the average marker summarises. */
  meanWindowMs?: number;
}

export class Circumplex {
  readonly root: HTMLElement;
  private svg: SVGSVGElement;
  private trailOld: SVGPolylineElement;
  private trailRecent: SVGPolylineElement;
  private meanMarker: SVGCircleElement;
  private point: SVGCircleElement;
  private pointRing: SVGCircleElement;
  private hoverDot: SVGCircleElement;
  private tooltip: HTMLElement;
  private readout: HTMLElement;
  private meanWindowMs: number;
  private model: AffectModel | null = null;

  // Partner marks are created up front but stay hidden until a partner model is
  // bound and has data, so a solo session renders exactly as it did before.
  private partnerModel: AffectModel | null = null;
  private partnerTrail: SVGPolylineElement;
  private partnerPoint: SVGPathElement;
  private partnerRing: SVGPathElement;
  private link: SVGLineElement;

  constructor(container: HTMLElement, opts: CircumplexOptions = {}) {
    this.meanWindowMs = opts.meanWindowMs ?? 30_000;

    this.root = document.createElement('figure');
    this.root.className = 'circumplex';
    container.appendChild(this.root);

    const head = document.createElement('figcaption');
    head.className = 'chart-head';
    head.innerHTML = `
      <h2>Affect position</h2>
      <p class="chart-sub">Valence from frontal alpha asymmetry, arousal from band-power activation. Trail covers the last 2 minutes.</p>
    `;
    this.root.appendChild(head);

    const plotWrap = document.createElement('div');
    plotWrap.className = 'circumplex-plot';
    this.root.appendChild(plotWrap);

    this.svg = svgEl('svg', {
      viewBox: `0 0 ${VIEW} ${VIEW}`,
      role: 'img',
      'aria-label': 'Valence versus arousal position over the last two minutes',
    });
    this.svg.classList.add('circumplex-svg');
    plotWrap.appendChild(this.svg);

    this.drawFrame();

    this.trailOld = svgEl('polyline', { class: 'trail trail-old', points: '' }, this.svg);
    this.trailRecent = svgEl('polyline', { class: 'trail trail-recent', points: '' }, this.svg);

    // Partner trail sits under the subject's own marks: in a solo-plus-partner
    // read the subject is the figure and the partner is the reference.
    this.partnerTrail = svgEl(
      'polyline',
      { class: 'trail trail-partner mark-hidden', points: '' },
      this.svg,
    );

    // Drawn before the points so the join reads as a connector, not an overlay.
    this.link = svgEl(
      'line',
      { class: 'pair-link mark-hidden', x1: 0, y1: 0, x2: 0, y2: 0 },
      this.svg,
    );

    this.meanMarker = svgEl(
      'circle',
      { class: 'mean-marker mark-hidden', r: 7, cx: 0, cy: 0 },
      this.svg,
    );

    this.hoverDot = svgEl('circle', { class: 'hover-dot mark-hidden', r: 5, cx: 0, cy: 0 }, this.svg);

    // Ring first, then the fill on top: the 2px surface ring keeps the live dot
    // legible where it crosses its own trail.
    this.pointRing = svgEl('circle', { class: 'point-ring mark-hidden', r: 9, cx: 0, cy: 0 }, this.svg);
    this.point = svgEl('circle', { class: 'point mark-hidden', r: 7, cx: 0, cy: 0 }, this.svg);

    this.partnerRing = svgEl('path', { class: 'point-ring mark-hidden', d: '' }, this.svg);
    this.partnerPoint = svgEl('path', { class: 'point point-partner mark-hidden', d: '' }, this.svg);

    this.tooltip = document.createElement('div');
    this.tooltip.className = 'tooltip';
    this.tooltip.hidden = true;
    plotWrap.appendChild(this.tooltip);

    this.readout = document.createElement('div');
    this.readout.className = 'circumplex-readout';
    this.root.appendChild(this.readout);
    this.renderReadout(null, null);

    this.attachHover(plotWrap);
  }

  private static x(valence: number): number {
    return PAD + ((valence + 1) / 2) * PLOT;
  }

  private static y(arousal: number): number {
    // SVG y grows downward; arousal grows upward.
    return PAD + ((1 - arousal) / 2) * PLOT;
  }

  private drawFrame(): void {
    const g = svgEl('g', { class: 'frame' }, this.svg);

    // Recessive concentric guides give the plane a sense of magnitude without
    // the ink of a full grid.
    for (const r of [0.33, 0.66, 1]) {
      svgEl(
        'circle',
        {
          class: 'guide-ring',
          cx: PAD + PLOT / 2,
          cy: PAD + PLOT / 2,
          r: (r * PLOT) / 2,
        },
        g,
      );
    }

    svgEl(
      'line',
      { class: 'axis', x1: PAD, y1: PAD + PLOT / 2, x2: PAD + PLOT, y2: PAD + PLOT / 2 },
      g,
    );
    svgEl(
      'line',
      { class: 'axis', x1: PAD + PLOT / 2, y1: PAD, x2: PAD + PLOT / 2, y2: PAD + PLOT },
      g,
    );

    const axisLabels: Array<[string, number, number, string]> = [
      ['Positive →', PAD + PLOT, PAD + PLOT / 2 - 10, 'end'],
      ['← Negative', PAD, PAD + PLOT / 2 - 10, 'start'],
    ];
    for (const [text, x, y, anchor] of axisLabels) {
      const t = svgEl('text', { class: 'axis-label', x, y, 'text-anchor': anchor }, g);
      t.textContent = text;
    }

    const up = svgEl(
      'text',
      { class: 'axis-label', x: PAD + PLOT / 2, y: PAD - 14, 'text-anchor': 'middle' },
      g,
    );
    up.textContent = 'High arousal';
    const down = svgEl(
      'text',
      { class: 'axis-label', x: PAD + PLOT / 2, y: PAD + PLOT + 24, 'text-anchor': 'middle' },
      g,
    );
    down.textContent = 'Low arousal';

    // Quadrant names are the reading key for the plane — Russell's terms.
    const quads: Array<[string, number, number]> = [
      ['Tense', PAD + PLOT * 0.22, PAD + PLOT * 0.16],
      ['Excited', PAD + PLOT * 0.78, PAD + PLOT * 0.16],
      ['Subdued', PAD + PLOT * 0.22, PAD + PLOT * 0.88],
      ['Calm', PAD + PLOT * 0.78, PAD + PLOT * 0.88],
    ];
    for (const [name, x, y] of quads) {
      const t = svgEl('text', { class: 'quadrant-label', x, y, 'text-anchor': 'middle' }, g);
      t.textContent = name;
    }
  }

  bind(model: AffectModel): void {
    this.model = model;
  }

  /** Bind the second subject. Pass `null` to drop back to a solo plot. */
  bindPartner(model: AffectModel | null): void {
    this.partnerModel = model;
    if (!model) {
      for (const mark of [this.partnerTrail, this.partnerPoint, this.partnerRing, this.link]) {
        showMark(mark, false);
      }
    }
    this.svg.setAttribute(
      'aria-label',
      model
        ? 'Valence versus arousal positions for you and your partner over the last two minutes, joined by a line showing how far apart you are'
        : 'Valence versus arousal position over the last two minutes',
    );
  }

  render(): void {
    if (!this.model) return;
    const history = this.model.history;
    if (!history.length) return;

    const now = history[history.length - 1].t;
    const oldPts: string[] = [];
    const recentPts: string[] = [];

    for (const s of history) {
      const px = `${Circumplex.x(s.valence).toFixed(1)},${Circumplex.y(s.arousal).toFixed(1)}`;
      if (now - s.t > RECENT_MS) oldPts.push(px);
      else recentPts.push(px);
    }
    // Bridge the strata so the trail has no visible seam.
    if (oldPts.length && recentPts.length) recentPts.unshift(oldPts[oldPts.length - 1]);

    this.trailOld.setAttribute('points', oldPts.join(' '));
    this.trailRecent.setAttribute('points', recentPts.join(' '));

    const mean = this.model.meanOver(this.meanWindowMs);
    if (mean) {
      setAttrs(this.meanMarker, {
        cx: Circumplex.x(mean.valence),
        cy: Circumplex.y(mean.arousal),
      });
      showMark(this.meanMarker, true);
    }

    const latest = history[history.length - 1];
    const cx = Circumplex.x(latest.valence);
    const cy = Circumplex.y(latest.arousal);
    setAttrs(this.point, { cx, cy });
    // Inline style, not a `fill` attribute: `.point`'s class rule outranks a
    // presentation attribute, so setting the attribute here had no effect.
    this.point.style.fill = valenceColor(latest.valence);
    setAttrs(this.pointRing, { cx, cy });
    showMark(this.point, true);
    showMark(this.pointRing, true);

    const partner = this.renderPartner();

    // The connector is only meaningful while both points are live; drawing it to
    // a stale partner would assert a closeness that is not currently observed.
    if (partner) {
      setAttrs(this.link, { x1: cx, y1: cy, x2: partner.cx, y2: partner.cy });
      showMark(this.link, true);
    } else {
      showMark(this.link, false);
    }

    this.renderReadout(latest, partner?.sample ?? null);
  }

  /** Draw the partner's trail and point. Returns its screen position, if drawn. */
  private renderPartner(): { cx: number; cy: number; sample: AffectSample } | null {
    if (!this.partnerModel) return null;
    const history = this.partnerModel.history;
    if (!history.length) return null;

    // Partner history gets a single stratum rather than the recent/old split:
    // two two-tone trails on one plane is more ink than the comparison can pay
    // for, and the subject's own trail is the one worth reading in detail.
    const pts = history
      .map((s) => `${Circumplex.x(s.valence).toFixed(1)},${Circumplex.y(s.arousal).toFixed(1)}`)
      .join(' ');
    this.partnerTrail.setAttribute('points', pts);
    showMark(this.partnerTrail, true);

    const latest = history[history.length - 1];
    const cx = Circumplex.x(latest.valence);
    const cy = Circumplex.y(latest.arousal);
    this.partnerPoint.setAttribute('d', diamond(cx, cy, 7));
    this.partnerPoint.style.fill = valenceColor(latest.valence);
    this.partnerRing.setAttribute('d', diamond(cx, cy, 9));
    showMark(this.partnerPoint, true);
    showMark(this.partnerRing, true);

    return { cx, cy, sample: latest };
  }

  private renderReadout(s: AffectSample | null, partner: AffectSample | null): void {
    if (!s) {
      this.readout.innerHTML = `<span class="readout-state muted">Awaiting data…</span>`;
      return;
    }
    if (!partner) {
      this.readout.innerHTML = `
        <span class="readout-state">${quadrantLabel(s.valence, s.arousal)}</span>
        <span class="readout-pair"><span class="readout-key">valence</span><b>${fmt(s.valence, 2)}</b></span>
        <span class="readout-pair"><span class="readout-key">arousal</span><b>${fmt(s.arousal, 2)}</b></span>
        <span class="readout-legend">
          <span class="key-dot key-live" style="background:${valenceColor(s.valence)}"></span>now
          <span class="key-dot key-mean"></span>${Math.round(this.meanWindowMs / 1000)}s average
        </span>
      `;
      return;
    }
    const distance = Math.hypot(s.valence - partner.valence, s.arousal - partner.arousal);
    this.readout.innerHTML = `
      <span class="readout-pair"><span class="key-shape key-self"></span>You <b>${quadrantLabel(s.valence, s.arousal)}</b></span>
      <span class="readout-pair"><span class="key-shape key-partner"></span>Partner <b>${quadrantLabel(partner.valence, partner.arousal)}</b></span>
      <span class="readout-pair"><span class="readout-key">apart</span><b>${fmt(distance, 2)}</b></span>
      <span class="readout-legend">
        <span class="key-dot key-mean"></span>${Math.round(this.meanWindowMs / 1000)}s average · fill shows valence
      </span>
    `;
  }

  private attachHover(wrap: HTMLElement): void {
    const hide = () => {
      this.tooltip.hidden = true;
      showMark(this.hoverDot, false);
    };

    wrap.addEventListener('pointerleave', hide);
    wrap.addEventListener('pointermove', (ev) => {
      if (!this.model) return;
      const history = this.model.history;
      if (!history.length) return hide();

      const rect = this.svg.getBoundingClientRect();
      const sx = ((ev.clientX - rect.left) / rect.width) * VIEW;
      const sy = ((ev.clientY - rect.top) / rect.height) * VIEW;

      // Nearest trail sample in screen space, with a generous hit radius —
      // trail points are 2px wide and impossible to hit exactly.
      let best: AffectSample | null = null;
      let bestD = Infinity;
      for (const s of history) {
        const dx = Circumplex.x(s.valence) - sx;
        const dy = Circumplex.y(s.arousal) - sy;
        const d = dx * dx + dy * dy;
        if (d < bestD) {
          bestD = d;
          best = s;
        }
      }
      if (!best || bestD > 24 * 24) return hide();

      const bx = Circumplex.x(best.valence);
      const by = Circumplex.y(best.arousal);
      setAttrs(this.hoverDot, { cx: bx, cy: by });
      showMark(this.hoverDot, true);

      const ageS = (history[history.length - 1].t - best.t) / 1000;
      this.tooltip.hidden = false;
      this.tooltip.innerHTML = `
        <div class="tooltip-title">${ageS < 1 ? 'now' : `${ageS.toFixed(0)}s ago`} · ${quadrantLabel(best.valence, best.arousal)}</div>
        <dl>
          <dt>Valence</dt><dd>${fmt(best.valence, 2)}</dd>
          <dt>Arousal</dt><dd>${fmt(best.arousal, 2)}</dd>
          <dt>Mood</dt><dd>${fmt(best.moodSmooth, 1)}</dd>
          <dt>Engagement</dt><dd>${fmt(best.engagement, 1)}</dd>
        </dl>
      `;
      const px = (bx / VIEW) * rect.width;
      const py = (by / VIEW) * rect.height;
      this.tooltip.style.left = `${px}px`;
      this.tooltip.style.top = `${py}px`;
      this.tooltip.classList.toggle('flip-x', px > rect.width * 0.6);
      this.tooltip.classList.toggle('flip-y', py < rect.height * 0.3);
    });
  }
}

/** Diamond centred on (cx, cy) — the partner's mark shape. */
function diamond(cx: number, cy: number, r: number): string {
  return `M ${cx} ${cy - r} L ${cx + r} ${cy} L ${cx} ${cy + r} L ${cx - r} ${cy} Z`;
}

/**
 * Diverging blue<->red across the neutral midpoint, per the reference palette.
 * Read off CSS custom properties so the ramp follows the active theme.
 */
function valenceColor(valence: number): string {
  const magnitude = Math.min(1, Math.abs(valence) / 0.6);
  if (magnitude < 0.12) return 'var(--diverging-mid)';
  const pole = valence >= 0 ? 'pos' : 'neg';
  const step = magnitude < 0.5 ? '1' : '2';
  return `var(--diverging-${pole}-${step})`;
}
