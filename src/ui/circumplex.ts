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
 * then distinguished by *both* shape and hue — circle and blue for A, diamond
 * and green for B.
 *
 * Paired, the points stop encoding valence in their fill. Position on the
 * horizontal axis already says exactly that, so spending colour on it a second
 * time buys nothing, while spending it on identity answers the question the
 * plane actually raises with two people on it: which one is which. Solo, there
 * is no identity to encode and the diverging ramp goes back to carrying
 * valence.
 */

const VIEW = 400;
const PAD = 44;
const PLOT = VIEW - PAD * 2;

/** Trail is split into two strata so recency reads without per-point opacity. */
const RECENT_MS = 15_000;

/**
 * How stale a subject's last frame may be before their live point is withdrawn.
 *
 * A point means "here they are now". The model keeps two minutes of history, so
 * without this a stream that dies leaves its dot sitting on the plane for that
 * long, and the connector between the two subjects goes on asserting a closeness
 * nobody is currently observing. Matches `MAX_HOLD_MS` in `affect/sync.ts`, which
 * already refuses to report a distance on stale data — this makes the picture
 * agree with the statistic.
 */
const STALE_MS = 1_500;

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
    // No subtitle. The trail's span is still in the plot's own description for
    // anyone reading it by screen reader; on screen it was a fixed sentence
    // spending a line of a card whose height is now set to the row it sits in.
    head.innerHTML = `<h2>Affect Map</h2>`;
    this.root.appendChild(head);

    /*
     * Plot and readout sit side by side rather than stacked. The card's height
     * is fixed by the row it belongs to, and the plot is square — so every line
     * under it came straight off the diameter of the circle. Beside it, the
     * labels cost width, which is what the card has spare.
     */
    const body = document.createElement('div');
    body.className = 'circumplex-body';
    this.root.appendChild(body);

    const plotWrap = document.createElement('div');
    plotWrap.className = 'circumplex-plot';
    body.appendChild(plotWrap);

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
    body.appendChild(this.readout);
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
        ? 'Valence versus arousal positions for both subjects over the last two minutes, joined by a line showing how far apart they are'
        : 'Valence versus arousal position over the last two minutes',
    );
  }

  /**
   * Wipe every drawn mark.
   *
   * Clearing the model is not enough. `render()` returns early on empty history
   * — written when history only ever grew — so after a reset the previous pair's
   * trails and points would stay painted, looking exactly like live data. Reset
   * calls this explicitly rather than waiting for a frame that may not come.
   */
  clear(): void {
    this.trailOld.setAttribute('points', '');
    this.trailRecent.setAttribute('points', '');
    this.partnerTrail.setAttribute('points', '');
    for (const mark of [
      this.trailOld,
      this.trailRecent,
      this.partnerTrail,
      this.point,
      this.pointRing,
      this.partnerPoint,
      this.partnerRing,
      this.meanMarker,
      this.hoverDot,
      this.link,
    ]) {
      showMark(mark, false);
    }
    this.tooltip.hidden = true;
    this.renderReadout(null, null);
  }

  render(): void {
    if (!this.model) return;
    const history = this.model.history;
    if (!history.length) return;

    // Trails are re-shown here rather than only in the constructor, so a cleared
    // plot comes back to life on the first frame after a reset.
    showMark(this.trailOld, true);
    showMark(this.trailRecent, true);

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
    // Trails take the subject hue when paired so a trail and its point agree.
    const trailColor = this.partnerModel ? SUBJECT_A_COLOR : 'var(--series-1)';
    this.trailOld.style.stroke = trailColor;
    this.trailRecent.style.stroke = trailColor;

    const mean = this.model.meanOver(this.meanWindowMs);
    if (mean) {
      setAttrs(this.meanMarker, {
        cx: Circumplex.x(mean.valence),
        cy: Circumplex.y(mean.arousal),
      });
      showMark(this.meanMarker, true);
    }

    const latest = history[history.length - 1];
    const live = Circumplex.isFresh(latest);
    const cx = Circumplex.x(latest.valence);
    const cy = Circumplex.y(latest.arousal);
    setAttrs(this.point, { cx, cy });
    // Inline style, not a `fill` attribute: `.point`'s class rule outranks a
    // presentation attribute, so setting the attribute here had no effect.
    this.point.style.fill = this.partnerModel
      ? SUBJECT_A_COLOR
      : valenceColor(latest.valence);
    setAttrs(this.pointRing, { cx, cy });
    showMark(this.point, live);
    showMark(this.pointRing, live);

    const partner = this.renderPartner();

    // The connector is only meaningful while BOTH points are live. Drawn to a
    // stale subject it asserts a closeness nobody is currently observing.
    if (live && partner) {
      setAttrs(this.link, { x1: cx, y1: cy, x2: partner.cx, y2: partner.cy });
      showMark(this.link, true);
    } else {
      showMark(this.link, false);
    }

    this.renderReadout(live ? latest : null, partner?.sample ?? null);
  }

  /** Whether a sample is recent enough to stand for "now". Uses local arrival. */
  private static isFresh(s: AffectSample): boolean {
    return Date.now() - s.tLocal <= STALE_MS;
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
    this.partnerTrail.style.stroke = SUBJECT_B_COLOR;
    showMark(this.partnerTrail, true);

    // The trail stays after a stream dies — it is history and remains true, and
    // it ages out of the window on its own. The live point does not.
    const latest = history[history.length - 1];
    if (!Circumplex.isFresh(latest)) {
      showMark(this.partnerPoint, false);
      showMark(this.partnerRing, false);
      return null;
    }

    const cx = Circumplex.x(latest.valence);
    const cy = Circumplex.y(latest.arousal);
    this.partnerPoint.setAttribute('d', diamond(cx, cy, 7));
    this.partnerPoint.style.fill = SUBJECT_B_COLOR;
    this.partnerRing.setAttribute('d', diamond(cx, cy, 9));
    showMark(this.partnerPoint, true);
    showMark(this.partnerRing, true);

    return { cx, cy, sample: latest };
  }

  private renderReadout(s: AffectSample | null, partner: AffectSample | null): void {
    if (!s) {
      // Your own stream has stalled. Say so plainly, but keep reporting the
      // partner if theirs is still arriving — half a pair is still information.
      this.readout.innerHTML = partner
        ? `<span class="readout-state muted">Subject A stream stalled</span>
           <span class="readout-pair"><span class="key-shape key-partner"></span>Subject B <b>${quadrantLabel(partner.valence, partner.arousal)}</b></span>`
        : `<span class="readout-state muted">Awaiting data…</span>`;
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
    // No separation figure here. It moved on every frame, which made the one
    // line under the plot the twitchiest thing on the page — and the distance
    // between two points is already the thing the plot itself shows. The
    // synchrony panel still reports it, against a surrogate floor, where a
    // number like that means something.
    this.readout.innerHTML = `
      <span class="readout-pair"><span class="key-shape key-self"></span>Subject A <b>${quadrantLabel(s.valence, s.arousal)}</b></span>
      <span class="readout-pair"><span class="key-shape key-partner"></span>Subject B <b>${quadrantLabel(partner.valence, partner.arousal)}</b></span>
      <span class="readout-legend">
        <span class="key-dot key-mean"></span>${Math.round(this.meanWindowMs / 1000)}s average
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

const SUBJECT_A_COLOR = 'var(--series-1)';
const SUBJECT_B_COLOR = 'var(--series-3)';

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
