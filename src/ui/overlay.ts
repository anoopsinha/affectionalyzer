import type { AffectionScore } from '../affect/affection';
import { diagnose } from '../affect/affection';
import type { Phase } from '../session/flow';
import { MaiCard } from './affection';
import { el, svgEl } from './svg';

/**
 * The full-screen frames: waiting, paired, calibrating.
 *
 * These sit over the instrument rather than replacing it, so the dashboard keeps
 * rendering underneath and the trails are already populated when the overlay
 * lifts — the far side of calibration is a running session, not an empty one.
 */

export class Overlay {
  readonly root: HTMLElement;
  private waiting: HTMLElement;
  private paired: HTMLElement;
  private calibrating: HTMLElement;
  private percent: HTMLElement;
  private progress: SVGRectElement;
  private waitingDetail: HTMLElement;
  private diagnosis: HTMLElement;
  private diagnosisMai: MaiCard;
  private diagnosisName: HTMLElement;
  private diagnosisDirective: HTMLElement;

  constructor(container: HTMLElement) {
    this.root = el('div', 'overlay', container);
    this.root.hidden = true;
    // Announced as a status region: the phase changes without user action, and a
    // screen reader should hear "calibrating" rather than discover it by touring.
    this.root.setAttribute('role', 'status');
    this.root.setAttribute('aria-live', 'polite');

    this.waiting = this.buildWaiting();
    this.paired = this.buildPaired();
    const cal = this.buildCalibrating();
    this.calibrating = cal.root;
    this.percent = cal.percent;
    this.progress = cal.progress;
    this.waitingDetail = this.waiting.querySelector('.frame-detail')!;

    const diag = this.buildDiagnosis();
    this.diagnosis = diag.root;
    this.diagnosisMai = diag.mai;
    this.diagnosisName = diag.name;
    this.diagnosisDirective = diag.directive;
  }

  /**
   * Frame 04: the verdict, alone on the screen.
   *
   * It holds for several seconds before the running view takes over, so it is
   * the one moment the pair is asked to sit with a number rather than watch it
   * move.
   */
  private buildDiagnosis(): {
    root: HTMLElement;
    mai: MaiCard;
    name: HTMLElement;
    directive: HTMLElement;
  } {
    const frame = el('div', 'overlay-frame frame-diagnosis', this.root);
    const mark = el('div', 'frame-mark', frame);
    mark.innerHTML = 'Affectionalyzer<sup>TM</sup>';

    const centre = el('div', 'frame-centre diagnosis-centre', frame);

    const mai = new MaiCard(centre);

    const name = el('h2', 'diagnosis-name', centre);

    const directive = el('p', 'diagnosis-directive', centre);

    const smallprint = el('p', 'diagnosis-smallprint', centre);
    smallprint.textContent =
      'Unlock Full Prescription for $1. Speak to a medical staff for assistance.';

    return { root: frame, mai, name, directive };
  }

  /** Feed the verdict frame. Called while the score is still moving. */
  setAffection(score: AffectionScore | null): void {
    this.diagnosisMai.update(score);
    if (!score) {
      this.diagnosisName.textContent = 'Inconclusive';
      this.diagnosisDirective.textContent = 'Insufficient data from both subjects.';
      return;
    }
    const d = diagnose(score.value);
    this.diagnosisName.textContent = d.name;
    // Frame 04 shows the directive with the withheld line trailing off it, which
    // is where the upsell underneath gets its pull from.
    this.diagnosisDirective.textContent = `${d.directive} ${d.lockedAction}…`;
  }

  private buildWaiting(): HTMLElement {
    const frame = el('div', 'overlay-frame frame-waiting', this.root);
    const mark = el('div', 'frame-mark', frame);
    mark.innerHTML = 'Affectionalyzer<sup>TM</sup>';

    const centre = el('div', 'frame-centre', frame);

    // Two unresolved waves, drifting apart — the visual inverse of the pairing
    // frame, where they converge into one signal.
    const svg = svgEl('svg', {
      viewBox: '0 0 420 120',
      class: 'waiting-art',
      'aria-hidden': 'true',
    });
    svgEl('path', {
      class: 'wave wave-a',
      d: 'M0 44c34-18 58 16 88 6s40-26 68-16 44 22 74 12 44-18 74-8 44 16 74 8',
    }, svg);
    svgEl('path', {
      class: 'wave wave-b',
      d: 'M0 78c30 16 56-14 86-4s42 24 70 14 46-20 76-10 42 18 72 8 42-14 72-6',
    }, svg);
    centre.appendChild(svg);

    const title = el('p', 'frame-title', centre);
    title.textContent = 'Waiting for both headsets.';
    const detail = el('p', 'frame-detail', centre);
    detail.textContent = 'Put them on and let the contacts settle.';

    return frame;
  }

  private buildPaired(): HTMLElement {
    const frame = el('div', 'overlay-frame frame-paired', this.root);
    const mark = el('div', 'frame-mark', frame);
    mark.innerHTML = 'Affectionalyzer<sup>TM</sup>';

    const centre = el('div', 'frame-centre', frame);

    // Two organic signals converge, merge at the dots, and leave as one square
    // wave: the pair becoming a single instrument.
    const svg = svgEl('svg', {
      viewBox: '0 0 900 260',
      class: 'paired-art',
      'aria-hidden': 'true',
    });

    const organic = svgEl('g', { class: 'paired-organic' }, svg);
    const strands = [
      'M0 96c60-34 100 26 152 10s70-46 122-30',
      'M0 118c66-14 96 38 152 28s78-46 122-32',
      'M0 132c58 22 106-16 156-4s60 36 118 22',
      'M0 150c70 26 104-22 158-8s64 30 116 18',
    ];
    for (const d of strands) svgEl('path', { class: 'strand', d }, organic);

    const dots = svgEl('g', { class: 'paired-dots' }, svg);
    for (const [cx, cy] of [[268, 84], [312, 100], [332, 112], [300, 128], [306, 148]]) {
      svgEl('circle', { cx, cy, r: 7 }, dots);
    }
    for (const [cx, cy] of [[430, 122], [456, 122]]) {
      svgEl('circle', { class: 'dot-merged', cx, cy, r: 7 }, dots);
    }

    svgEl('path', { class: 'bridge', d: 'M348 118c40 4 44 4 74 4' }, svg);
    svgEl(
      'path',
      {
        class: 'square',
        d: 'M472 122h68v58h50V64h56v100h44V96h58v26h52',
      },
      svg,
    );

    centre.appendChild(svg);

    const title = el('p', 'frame-title frame-title-lg', centre);
    title.textContent = 'Paired successfully.';

    return frame;
  }

  private buildCalibrating(): {
    root: HTMLElement;
    percent: HTMLElement;
    progress: SVGRectElement;
  } {
    const frame = el('div', 'overlay-frame frame-calibrating', this.root);
    const mark = el('div', 'frame-mark', frame);
    mark.innerHTML = 'Affectionalyzer<sup>TM</sup>';

    const centre = el('div', 'frame-centre', frame);

    // The phase stays `calibrating` in code while the screen says "Calculating".
    // The phase name means "the timed hold before the verdict", which is stable;
    // the wording on the screen is not, and tying the identifier to it would make
    // the next copy change a refactor.
    const line = el('p', 'frame-title frame-title-lg calibrating-line', centre);
    line.append('Calculating……');
    const percent = el('span', 'calibrating-percent', line);
    percent.textContent = '0%';

    const svg = svgEl('svg', {
      viewBox: '0 0 300 4',
      class: 'calibrating-track',
      preserveAspectRatio: 'none',
      'aria-hidden': 'true',
    });
    svgEl('rect', { class: 'track-bed', x: 0, y: 1, width: 300, height: 2 }, svg);
    const progress = svgEl('rect', { class: 'track-fill', x: 0, y: 1, width: 0, height: 2 }, svg);
    centre.appendChild(svg);

    return { root: frame, percent, progress };
  }

  /** Show the frame for `phase`, or nothing at all once the session is live. */
  render(phase: Phase, calibrationProgress: number): void {
    const frames: Partial<Record<Phase, HTMLElement>> = {
      waiting: this.waiting,
      paired: this.paired,
      calibrating: this.calibrating,
      diagnosis: this.diagnosis,
    };

    const active = frames[phase] ?? null;
    this.root.hidden = !active;
    for (const [name, frame] of Object.entries(frames)) {
      frame!.hidden = name !== phase;
    }

    if (phase === 'calibrating') {
      const pct = Math.round(calibrationProgress * 100);
      this.percent.textContent = `${pct}%`;
      this.progress.setAttribute('width', String(calibrationProgress * 300));
    }
  }

  /** Say which subject the app is still waiting on, when only one is missing. */
  setWaitingDetail(text: string): void {
    this.waitingDetail.textContent = text;
  }
}
