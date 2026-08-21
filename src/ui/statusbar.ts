import type { DaemonStatus, LinkState, QualityLevel } from '../neuroskill/types';
import { el } from './svg';

/**
 * Header: per-source daemon link, headset state, contact quality, rate, battery.
 *
 * Contact quality uses the reserved status palette and always ships a glyph and
 * a text label alongside the colour, so it never depends on hue alone.
 *
 * With two subjects the health of each stream has to be readable separately —
 * a single merged indicator would let a dead partner headset hide behind a
 * healthy local one, and every synchrony number downstream would then be built
 * on data that is not arriving.
 */

/**
 * The daemon's quality vocabulary is not documented and is not a closed set —
 * `good` and `fair` are both observed in practice. Unknown levels degrade to a
 * neutral glyph instead of rendering a bare "?".
 */
type QualityTier = 'good' | 'fair' | 'poor' | 'unknown';

const QUALITY_TIER: Record<string, QualityTier> = {
  good: 'good',
  ok: 'good',
  fair: 'fair',
  medium: 'fair',
  moderate: 'fair',
  poor: 'poor',
  bad: 'poor',
};

const TIER_GLYPH: Record<QualityTier, string> = {
  good: '●',
  fair: '◐',
  poor: '○',
  unknown: '◌',
};

function tierOf(level: string): QualityTier {
  return QUALITY_TIER[String(level).toLowerCase()] ?? 'unknown';
}

const DEFAULT_CHANNELS = ['TP9', 'AF7', 'AF8', 'TP10'];

/** The chip group for one subject's stream. */
export class SourceChips {
  readonly root: HTMLElement;
  private linkEl: HTMLElement;
  private deviceEl: HTMLElement;
  private qualityEl: HTMLElement;
  private batteryEl: HTMLElement;
  private rateEl: HTMLElement;
  private channelNames = DEFAULT_CHANNELS;
  private frameTimes: number[] = [];

  constructor(container: HTMLElement, label: string, markerClass: string) {
    this.root = el('div', 'source-row', container);

    const name = el('span', `source-name ${markerClass}`, this.root);
    name.textContent = label;

    this.linkEl = el('span', 'chip', this.root);
    this.deviceEl = el('span', 'chip', this.root);
    this.qualityEl = el('span', 'chip chip-quality', this.root);
    this.rateEl = el('span', 'chip', this.root);
    this.batteryEl = el('span', 'chip', this.root);

    this.setLink('idle');
    this.setDevice(null);
    this.setQuality([]);
    this.setBattery(null);
    this.renderRate();
  }

  setLink(state: LinkState, detail?: string): void {
    const map: Record<LinkState, [string, string]> = {
      idle: ['status-muted', 'Daemon: idle'],
      connecting: ['status-warning', 'Daemon: connecting…'],
      open: ['status-good', 'Daemon: linked'],
      closed: ['status-serious', 'Daemon: disconnected'],
      error: ['status-critical', 'Daemon: error'],
    };
    const [cls, text] = map[state];
    this.linkEl.className = `chip ${cls}`;
    this.linkEl.textContent = text;
    this.linkEl.title = detail ?? '';
  }

  /** Absorbs a status frame: device, channel names, quality and battery at once. */
  applyStatus(status: DaemonStatus | null): void {
    this.setDevice(status);
    if (!status) return;
    if (Array.isArray(status.channel_names) && status.channel_names.length) {
      this.channelNames = status.channel_names;
    }
    if (Array.isArray(status.channel_quality)) {
      this.setQuality(status.channel_quality);
    }
    if (typeof status.battery === 'number' && status.battery > 0) {
      this.setBattery(status.battery);
    }
  }

  setDevice(status: DaemonStatus | null): void {
    if (!status || status.state !== 'connected') {
      const state = status?.state ?? 'unknown';
      this.deviceEl.className = `chip ${state === 'connecting' ? 'status-warning' : 'status-serious'}`;
      this.deviceEl.textContent = `Headset: ${state}`;
      return;
    }
    this.deviceEl.className = 'chip status-good';
    this.deviceEl.textContent = `Headset: ${status.device_name ?? 'connected'}`;
  }

  setQuality(quality: QualityLevel[], channelNames?: string[]): void {
    const names = channelNames ?? this.channelNames;
    if (!quality.length) {
      this.qualityEl.className = 'chip chip-quality status-muted';
      this.qualityEl.textContent = 'Contact: —';
      return;
    }
    const tiers = quality.map(tierOf);
    const worst: QualityTier = tiers.includes('poor')
      ? 'poor'
      : tiers.includes('fair')
        ? 'fair'
        : tiers.includes('unknown')
          ? 'unknown'
          : 'good';
    const cls: Record<QualityTier, string> = {
      good: 'status-good',
      fair: 'status-warning',
      poor: 'status-critical',
      unknown: 'status-muted',
    };
    this.qualityEl.className = `chip chip-quality ${cls[worst]}`;
    this.qualityEl.innerHTML =
      `<span class="chip-key">Contact</span>` +
      quality
        .map((q, i) => {
          const name = names[i] ?? `ch${i}`;
          const tier = tierOf(q);
          return `<span class="electrode q-${tier}" title="${name}: ${q}"><span class="electrode-glyph">${TIER_GLYPH[tier]}</span>${name}</span>`;
        })
        .join('');
  }

  setBattery(pct: number | null): void {
    if (pct === null) {
      this.batteryEl.className = 'chip status-muted';
      this.batteryEl.textContent = 'Battery: —';
      return;
    }
    const cls = pct > 30 ? 'status-good' : pct > 15 ? 'status-warning' : 'status-critical';
    this.batteryEl.className = `chip ${cls}`;
    this.batteryEl.textContent = `Battery: ${Math.round(pct)}%`;
  }

  /** Called on every EegBands frame; reports the observed event rate. */
  tickFrame(now: number): void {
    this.frameTimes.push(now);
    const cutoff = now - 4000;
    while (this.frameTimes.length && this.frameTimes[0] < cutoff) this.frameTimes.shift();
    this.renderRate();
  }

  private renderRate(): void {
    if (this.frameTimes.length < 2) {
      this.rateEl.className = 'chip status-muted';
      this.rateEl.textContent = 'Stream: —';
      return;
    }
    const span = (this.frameTimes[this.frameTimes.length - 1] - this.frameTimes[0]) / 1000;
    const hz = span > 0 ? (this.frameTimes.length - 1) / span : 0;
    this.rateEl.className = 'chip status-muted';
    this.rateEl.textContent = `Stream: ${hz.toFixed(1)} Hz`;
  }
}

export class StatusBar {
  readonly root: HTMLElement;
  /** The wordmark, which doubles as the indicators toggle. */
  readonly brandBtn: HTMLButtonElement;
  private sources!: HTMLElement;
  private indicatorsShown = false;
  readonly self: SourceChips;
  readonly partner: SourceChips;
  readonly reconnectBtn: HTMLButtonElement;
  readonly resetBtn: HTMLButtonElement;
  readonly settingsBtn: HTMLButtonElement;
  /** View controls (focus toggle, panel menu) mount here. */
  readonly actions: HTMLElement;

  constructor(container: HTMLElement) {
    this.root = el('header', 'statusbar');
    container.appendChild(this.root);

    // The wordmark is the control that reveals the connection indicators. A
    // button inside the heading rather than around it: `h1` is not phrasing
    // content, so a button wrapping it would be invalid.
    const brand = el('h1', 'brand', this.root);
    this.brandBtn = el('button', 'brand-toggle', brand);
    this.brandBtn.type = 'button';
    this.brandBtn.innerHTML = 'Affectionalyzer<sup>TM</sup>';
    this.brandBtn.addEventListener('click', () => this.setIndicators(!this.indicatorsShown));

    const sources = el('div', 'sources', this.root);
    this.sources = sources;
    // The marker classes carry the same circle/diamond shapes the circumplex
    // uses, so the header and the plot name the two subjects the same way.
    this.self = new SourceChips(sources, 'Subject A', 'marker-self');
    this.partner = new SourceChips(sources, 'Subject B', 'marker-partner');

    const actions = el('div', 'actions', this.root);
    this.actions = actions;
    this.reconnectBtn = el('button', 'btn', actions);
    this.reconnectBtn.type = 'button';
    // Between sessions two people swap the headsets and start over. This throws
    // the previous pair's data away and returns to the calibration count.
    this.resetBtn = el('button', 'btn btn-quiet', actions);
    this.resetBtn.type = 'button';
    this.resetBtn.textContent = 'Reset';
    this.resetBtn.title = 'Clear both subjects and start a new session. Connections stay up.';
    this.settingsBtn = el('button', 'btn btn-quiet', actions);
    this.settingsBtn.type = 'button';
    this.settingsBtn.textContent = 'Connection';

    // Last: it labels the reconnect button, which has to exist by now.
    this.showPartner(false);
    // Hidden by default; the wordmark brings them back.
    this.setIndicators(false);
  }

  /**
   * Show or hide the whole header: indicators and controls together.
   *
   * Off by default, leaving the wordmark alone above the instrument. Everything
   * here is for the operator rather than the pair — link, headset, contact,
   * rate, battery, and the controls that act on them — so it all sits behind one
   * deliberate press.
   *
   * That makes the wordmark the only way back to Reset, Connection and Panels,
   * which is why it is the app's title rather than an icon: the one thing on a
   * bare screen that anyone would think to click. Not persisted, so a session
   * starts clean.
   */
  setIndicators(shown: boolean): void {
    this.indicatorsShown = shown;
    this.sources.hidden = !shown;
    this.actions.hidden = !shown;
    this.brandBtn.setAttribute('aria-expanded', String(shown));
    this.brandBtn.title = shown ? 'Hide controls' : 'Show controls';
  }

  /** Hide the partner row entirely in a solo session. */
  showPartner(on: boolean): void {
    this.partner.root.hidden = !on;
    this.reconnectBtn.textContent = on ? 'Reconnect headsets' : 'Reconnect headset';
  }
}
