import type { Correlation, SyncResult } from '../affect/sync';
import { SYNC_WINDOW_MS, VERDICT_LABEL, peakVerdictOf, verdictOf } from '../affect/sync';
import { el, fmt } from './svg';

/**
 * The synchrony readout: whether two brains are actually tracking each other.
 *
 * Every correlation is shown against its surrogate floor rather than alone. A
 * bare r here would be the most misreadable number in the app — smoothed EEG
 * indices correlate with each other by construction, so an unqualified 0.3 looks
 * like rapport when it is really just autocorrelation. The bar draws the floor
 * as a marked threshold the value has to visibly clear.
 */

const EPOCH_S = Math.round(SYNC_WINDOW_MS / 1000);

interface Row {
  root: HTMLElement;
  verdict: HTMLElement;
  fill: HTMLElement;
  floor: HTMLElement;
  detail: HTMLElement;
}

export class SyncPanel {
  readonly root: HTMLElement;
  private valence: Row;
  private arousal: Row;
  private distanceEl: HTMLElement;
  private coverageEl: HTMLElement;
  private lagEl: HTMLElement;
  private empty: HTMLElement;
  private body: HTMLElement;
  private paired = false;

  constructor(container: HTMLElement) {
    this.root = el('section', 'card sync-card', container);

    const head = el('div', 'chart-head', this.root);
    head.innerHTML = `
      <h2>Interpersonal synchrony</h2>
      <p class="chart-sub">How closely the two streams have tracked each other over the last ${EPOCH_S} seconds.</p>
    `;

    this.empty = el('p', 'sync-empty', this.root);

    this.body = el('div', 'sync-body', this.root);
    this.body.hidden = true;

    this.valence = this.addRow('Valence', 'Do you feel positive and negative at the same times?');
    this.arousal = this.addRow('Arousal', 'Do you activate and settle at the same times?');

    const stats = el('div', 'sync-stats', this.body);
    this.distanceEl = el('span', 'sync-stat', stats);
    this.lagEl = el('span', 'sync-stat', stats);
    this.coverageEl = el('span', 'sync-stat', stats);

    this.setPaired(false);

    const note = el('p', 'sync-note', this.body);
    note.innerHTML =
      'The marked threshold on each bar is a <b>surrogate floor</b> — the correlation this pair ' +
      'reaches with the same two signals deliberately misaligned in time. Smoothed EEG indices ' +
      'correlate by construction, so only the part of a bar past that mark is evidence of coupling. ' +
      'One unreplicated window is not a finding.';
  }

  private addRow(label: string, question: string): Row {
    const root = el('div', 'sync-row', this.body);

    const head = el('div', 'sync-row-head', root);
    const name = el('span', 'sync-row-label', head);
    name.textContent = label;
    const verdict = el('span', 'sync-verdict', head);

    const track = el('div', 'sync-track', root);
    // The bar is a magnitude readout, so it is announced as a meter rather than
    // left as decorative divs.
    track.setAttribute('role', 'meter');
    track.setAttribute('aria-label', `${label} coupling`);
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', '1');
    const fill = el('div', 'sync-fill', track);
    const floor = el('div', 'sync-floor', track);
    floor.setAttribute('title', 'Surrogate floor — correlation expected by chance');

    const detail = el('p', 'sync-detail', root);
    detail.textContent = question;

    return { root, verdict, fill, floor, detail };
  }

  /**
   * Whether a partner is connected at all.
   *
   * This drives an explanatory empty state rather than hiding the card, because
   * `PanelControls` owns every panel's `hidden` flag and reasserts it on each
   * toggle — a card that hid itself here would reappear blank the moment anyone
   * opened the Panels menu. A solo user who does not want it can hide it there
   * like any other panel.
   */
  setPaired(paired: boolean): void {
    this.paired = paired;
    if (!paired) {
      this.empty.hidden = false;
      this.body.hidden = true;
      this.empty.textContent =
        'No partner connected. Add a second daemon under Connection to measure synchrony.';
    }
  }

  update(result: SyncResult | null): void {
    if (!this.paired) return;
    const ready = !!result && (result.valence !== null || result.arousal !== null);
    this.empty.hidden = ready;
    this.body.hidden = !ready;
    if (!ready) {
      this.empty.textContent = 'Waiting for both streams…';
      return;
    }
    if (!result) return;

    this.renderRow(this.valence, result.valence, 'Do you feel positive and negative at the same times?');
    this.renderRow(this.arousal, result.arousal, 'Do you activate and settle at the same times?');

    this.distanceEl.textContent =
      result.distance === null ? 'Apart —' : `Apart ${fmt(result.distance, 2)}`;
    this.distanceEl.title = 'Straight-line distance between the two points on the circumplex, 0 to 2.83.';

    this.renderLag(result.valence);

    const pct = Math.round(result.coverage * 100);
    this.coverageEl.textContent = `Coverage ${pct}%`;
    this.coverageEl.className = `sync-stat${pct < 70 ? ' status-warning' : ''}`;
    this.coverageEl.title =
      'Share of the epoch where both streams had a fresh sample. Low coverage means one headset was dropping out, and the correlation above is built on less data than it looks.';
  }

  private renderRow(row: Row, c: Correlation | null, question: string): void {
    const track = row.fill.parentElement!;
    if (!c) {
      row.verdict.textContent = 'Not enough data';
      row.verdict.className = 'sync-verdict verdict-none';
      row.fill.style.width = '0%';
      row.floor.style.left = '0%';
      row.floor.hidden = true;
      row.detail.textContent = question;
      track.setAttribute('aria-valuenow', '0');
      track.setAttribute('aria-valuetext', 'not enough data');
      return;
    }

    const verdict = verdictOf(c);
    const magnitude = Math.abs(c.r);
    row.verdict.textContent = VERDICT_LABEL[verdict];
    row.verdict.className = `sync-verdict verdict-${verdict}`;

    row.fill.style.width = `${(magnitude * 100).toFixed(1)}%`;
    row.fill.className = `sync-fill verdict-${verdict}`;

    const hasFloor = Number.isFinite(c.surrogate);
    row.floor.hidden = !hasFloor;
    if (hasFloor) row.floor.style.left = `${(c.surrogate * 100).toFixed(1)}%`;

    const sign = c.r >= 0 ? 'together' : 'in opposition';
    row.detail.textContent = hasFloor
      ? `r = ${fmt(c.r, 2)} ${sign}, against a ${fmt(c.surrogate, 2)} chance floor · ${c.n} paired samples`
      : `r = ${fmt(c.r, 2)} ${sign} · ${c.n} paired samples · floor not yet established`;

    track.setAttribute('aria-valuenow', magnitude.toFixed(2));
    track.setAttribute(
      'aria-valuetext',
      `${VERDICT_LABEL[verdict]}. Correlation ${fmt(c.r, 2)}${hasFloor ? `, chance floor ${fmt(c.surrogate, 2)}` : ''}.`,
    );
  }

  /**
   * Lead/lag is reported only when the lagged peak clears its own (higher)
   * floor. A lag sweep maximises over ~33 candidates and will always return
   * *some* best offset, so an ungated readout would name a leader from noise.
   */
  private renderLag(c: Correlation | null): void {
    if (!c || peakVerdictOf(c) === 'none' || c.peakLagMs === 0) {
      this.lagEl.textContent = 'Lead/lag —';
      this.lagEl.title =
        'No lagged coupling above chance. Shown only when the shifted correlation clears its own surrogate floor.';
      return;
    }
    const secs = Math.abs(c.peakLagMs) / 1000;
    const who = c.peakLagMs > 0 ? 'Partner follows' : 'You follow';
    this.lagEl.textContent = `${who} ${secs.toFixed(2)}s`;
    this.lagEl.title = `Valence correlation peaks at ${fmt(c.peakR, 2)} when the streams are offset by ${secs.toFixed(2)} s.`;
  }
}
