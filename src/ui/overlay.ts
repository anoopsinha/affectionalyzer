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
  /** Lottie stage for frame 01, and the handle that replays it. */
  private pairedStage: HTMLElement | null = null;
  private pairedAnim: { goToAndPlay(v: number, isFrame?: boolean): void } | null = null;
  private pairedShowing = false;
  private diagnosisMai: MaiCard;
  private diagnosisName: HTMLElement;
  private diagnosisDirective: HTMLElement;
  /** The unlock link on the verdict frame; wired by `main` to leave it early. */
  unlockBtn!: HTMLButtonElement;

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

    const directive = el('div', 'diagnosis-directive', centre);

    // The upsell is the way past the verdict frame, so it is a real control
    // rather than a line of text that looks like one.
    const smallprint = el('p', 'diagnosis-smallprint', centre);
    this.unlockBtn = el('button', 'diagnosis-unlock-link', smallprint);
    this.unlockBtn.type = 'button';
    this.unlockBtn.textContent = 'Unlock Full Prescription for $1';
    smallprint.append('. Speak to a medical staff for assistance.');

    return { root: frame, mai, name, directive };
  }

  /** Feed the verdict frame with the drawn index, or null before the draw. */
  setAffection(value: number | null): void {
    this.diagnosisMai.update(value);
    if (value === null) {
      this.diagnosisName.textContent = 'Inconclusive';
      this.diagnosisDirective.textContent = 'Insufficient data from both subjects.';
      return;
    }
    const d = diagnose(value);
    this.diagnosisName.textContent = d.name;

    // The whole prescription, one line each. It used to run the directive and
    // the withheld line together as a single sentence, which silently dropped
    // anything between them — "Marriage certificate should be administered at
    // once" appeared nowhere on this frame.
    this.diagnosisDirective.innerHTML = '';
    const lines = [d.directive, ...d.actions];
    for (const line of lines) {
      const p = document.createElement('p');
      p.className = 'diagnosis-line';
      p.textContent = line;
      this.diagnosisDirective.appendChild(p);
    }
    // No "Read more" here. It was underlined and inert — the only thing on this
    // frame that does anything is the unlock link below. The trailing ellipsis
    // is what marks the line as cut short.
    const locked = document.createElement('p');
    locked.className = 'diagnosis-line is-locked';
    locked.textContent = `${d.lockedAction}…`;
    this.diagnosisDirective.appendChild(locked);
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

    // The designed animation goes here once it has loaded. Until then — and if
    // the load fails — the hand-drawn fallback below carries the frame, so a
    // slow network degrades to a still rather than to nothing.
    this.pairedStage = el('div', 'paired-stage', frame);

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

  /**
   * Load the designed frame-01 animation and swap it in for the fallback.
   *
   * Both the player and the animation data are fetched on demand rather than
   * bundled: together they are several times the size of the entire app, and a
   * session that never pairs should not pay for them. The frame is fully drawn
   * without them, so arriving late costs nothing.
   */
  async loadPairedAnimation(): Promise<void> {
    if (!this.pairedStage) return;
    try {
      const [{ default: lottie }, data] = await Promise.all([
        import('lottie-web/build/player/lottie_light'),
        import('../assets/paired.json'),
      ]);
      const anim = lottie.loadAnimation({
        container: this.pairedStage,
        renderer: 'svg',
        loop: false,
        autoplay: false,
        animationData: (data as { default: unknown }).default ?? data,
      });
      this.pairedAnim = anim as unknown as typeof this.pairedAnim;
      // The animation carries its own wordmark and its own "Paired
      // successfully.", so ours would double up behind it.
      this.paired.classList.add('has-animation');
      if (this.pairedShowing) anim.goToAndPlay(0, true);
    } catch {
      /* the fallback frame is already on screen and stays */
    }
  }

  /** Show the frame for `phase`, or nothing at all once the session is live. */
  render(phase: Phase, calibrationProgress: number): void {
    const frames: Partial<Record<Phase, HTMLElement>> = {
      waiting: this.waiting,
      paired: this.paired,
      calibrating: this.calibrating,
      diagnosis: this.diagnosis,
    };

    // Replay from the top each time the frame is entered, so a reset shows the
    // animation rather than its last frame.
    const enteringPaired = phase === 'paired' && !this.pairedShowing;
    this.pairedShowing = phase === 'paired';
    if (enteringPaired) this.pairedAnim?.goToAndPlay(0, true);

    const active = frames[phase] ?? null;
    this.root.hidden = !active;
    for (const [name, frame] of Object.entries(frames)) {
      frame!.hidden = name !== phase;
    }

    if (phase === 'calibrating') {
      const pct = Math.round(calibrationProgress * 100);
      /*
       * No padding and no reserved width. The count used to sit in a fixed-width
       * box so the line would not jitter as digits were added, but the number
       * was left-aligned inside it — which centred the *box* and left the
       * visible words about half a counter's width to the left of centre for the
       * whole screen.
       *
       * With nothing reserved, the line is exactly centred at every value. It
       * grows by a digit's width at 10% and again at 100%, symmetrically about
       * the centre. Padding with figure spaces would damp that, but Sansation's
       * figure space is wider than its digits, so it opened a visible gap before
       * the number that the storyboard does not have.
       */
      this.percent.textContent = `${pct}%`;
      this.progress.setAttribute('width', String(calibrationProgress * 300));
    }
  }

  /** Say which subject the app is still waiting on, when only one is missing. */
  setWaitingDetail(text: string): void {
    this.waitingDetail.textContent = text;
  }
}
