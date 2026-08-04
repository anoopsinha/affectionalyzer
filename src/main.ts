import './styles.css';

import { AffectModel, AROUSAL_SOURCES, quadrantLabel } from './affect/model';
import { NeuroSkillClient, type NeuroSkillConfig } from './neuroskill/client';
import { resolveConfig } from './neuroskill/config';
import type { EegBands } from './neuroskill/types';
import { BandBars } from './ui/bands';
import { Circumplex } from './ui/circumplex';
import { PanelControls } from './ui/panels';
import { SettingsPanel } from './ui/settings';
import { StatusBar } from './ui/statusbar';
import { fmt, fmtSigned } from './ui/svg';
import { Tiles } from './ui/tiles';
import { TimeSeries } from './ui/timeseries';

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('#app container missing from index.html');

const WINDOW_MS = 120_000;

const model = new AffectModel({ windowMs: WINDOW_MS });

/** Set by the event stream and by layout changes; consumed by the rAF loop. */
let dirty = false;

/**
 * Raw frames are retained so switching the arousal definition can recompute the
 * whole window rather than leaving a step in the trail.
 */
const rawFrames: EegBands[] = [];

const statusBar = new StatusBar(app);

const main = document.createElement('main');
main.className = 'layout';
app.appendChild(main);

const left = document.createElement('div');
left.className = 'col col-primary';
main.appendChild(left);

const right = document.createElement('div');
right.className = 'col col-secondary';
main.appendChild(right);

// --- Hero figure: exactly one per view ---
const hero = document.createElement('section');
hero.className = 'card hero';
hero.innerHTML = `
  <h2 class="hero-label">Mood index</h2>
  <div class="hero-value is-empty" id="hero-value">--</div>
  <div class="hero-meta">
    <span id="hero-state" class="hero-state">Awaiting data…</span>
    <span class="hero-detail">FAA <b id="hero-faa">—</b> · 50 is neutral</span>
  </div>
  <p class="hero-note">Frontal alpha asymmetry, rescaled 0–100 and smoothed over ~1.5 s. Above 60 leans approach/positive; below 40 leans withdrawal/negative. FAA is trait-like and highly individual — read shifts against your own baseline, not absolutes.</p>
`;
left.appendChild(hero);
const heroValue = hero.querySelector<HTMLElement>('#hero-value')!;
const heroState = hero.querySelector<HTMLElement>('#hero-state')!;
const heroFaa = hero.querySelector<HTMLElement>('#hero-faa')!;

// --- Circumplex ---
const circumplexCard = document.createElement('section');
circumplexCard.className = 'card';
left.appendChild(circumplexCard);
const circumplex = new Circumplex(circumplexCard, { meanWindowMs: 30_000 });
circumplex.bind(model);

// --- Arousal source control ---
const controls = document.createElement('div');
controls.className = 'controls';
controls.innerHTML = `
  <label class="control">
    <span class="control-label">Arousal axis</span>
    <select id="arousal-source">
      ${AROUSAL_SOURCES.map((s) => `<option value="${s.id}">${s.label}</option>`).join('')}
    </select>
  </label>
  <p class="control-formula" id="arousal-formula"></p>
`;
circumplexCard.appendChild(controls);
const arousalSelect = controls.querySelector<HTMLSelectElement>('#arousal-source')!;
const arousalFormula = controls.querySelector<HTMLElement>('#arousal-formula')!;

function renderFormula() {
  arousalFormula.textContent = model.arousalSource.formula;
}
renderFormula();

arousalSelect.addEventListener('change', () => {
  model.setArousalSource(arousalSelect.value, rawFrames);
  renderFormula();
  circumplex.render();
  timeseries.render();
  tiles.render();
});

// --- Secondary column ---
const timeseries = new TimeSeries(right, WINDOW_MS);
timeseries.bind(model);

const tiles = new Tiles(right);
tiles.bind(model);

const bandBars = new BandBars(right);

// --- Table view: the non-visual path to the same numbers ---
const tableCard = document.createElement('section');
tableCard.className = 'card table-card';
tableCard.innerHTML = `
  <details>
    <summary>Current values as a table</summary>
    <table class="data-table">
      <caption>Latest frame from the daemon</caption>
      <thead><tr><th scope="col">Metric</th><th scope="col">Value</th></tr></thead>
      <tbody id="data-table-body"><tr><td colspan="2">Awaiting data…</td></tr></tbody>
    </table>
  </details>
`;
right.appendChild(tableCard);
const tableBody = tableCard.querySelector<HTMLElement>('#data-table-body')!;

// --- View controls ---
// The hero and the circumplex are deliberately absent from this list: they are
// the reading, not a panel.
new PanelControls(
  statusBar.actions,
  main,
  right,
  [
    { id: 'trend', label: 'Trend', el: timeseries.root },
    { id: 'tiles', label: 'Brain-state scores', el: tiles.root },
    { id: 'bands', label: 'Band power', el: bandBars.root },
    { id: 'table', label: 'Table view', el: tableCard },
  ],
  () => {
    // Charts read their pixel size from the layout, so redraw once it settles.
    dirty = true;
  },
);

// --- Connection ---
let config: NeuroSkillConfig | null = resolveConfig();

const settings = new SettingsPanel(app, (next) => {
  config = next;
  client.reconfigure(next);
});

statusBar.settingsBtn.addEventListener('click', () => settings.open(config));

if (!config) {
  statusBar.setLink('error', 'No daemon credentials — open Connection to enter them');
  showBanner(
    'No daemon credentials found. The dev server auto-detects them from a running NeuroSkill daemon; otherwise enter the port and token under Connection.',
  );
}

const client = new NeuroSkillClient(config ?? { port: 18444, token: '' });

statusBar.reconnectBtn.addEventListener('click', async () => {
  statusBar.reconnectBtn.disabled = true;
  statusBar.reconnectBtn.textContent = 'Reconnecting…';
  const ok = await client.retryConnect();
  if (!ok) showBanner('Reconnect request failed — the token may lack admin scope.');
  window.setTimeout(() => {
    statusBar.reconnectBtn.disabled = false;
    statusBar.reconnectBtn.textContent = 'Reconnect headset';
  }, 2500);
});

let channelNames = ['TP9', 'AF7', 'AF8', 'TP10'];

client.on('link', (state, detail) => {
  statusBar.setLink(state, detail);
  if (state === 'open') hideBanner();
});

client.on('status', (status) => {
  statusBar.setDevice(status);
  if (Array.isArray(status.channel_names) && status.channel_names.length) {
    channelNames = status.channel_names;
  }
  if (Array.isArray(status.channel_quality)) {
    statusBar.setQuality(status.channel_quality, channelNames);
  }
  if (typeof status.battery === 'number' && status.battery > 0) {
    statusBar.setBattery(status.battery);
  }
});

client.on('quality', (q) => statusBar.setQuality(q, channelNames));
client.on('battery', (pct) => statusBar.setBattery(pct));

client.on('bands', (bands) => {
  rawFrames.push(bands);
  // Keep the replay buffer aligned with the model's own window.
  const cutoff = (bands.timestamp ?? Date.now() / 1000) * 1000 - WINDOW_MS;
  while (rawFrames.length && (rawFrames[0].timestamp ?? 0) * 1000 < cutoff) rawFrames.shift();

  model.push(bands);
  bandBars.update(bands);
  statusBar.tickFrame(performance.now());
  dirty = true;
});

if (config) client.connect();

void (async () => {
  const status = await client.fetchStatus();
  if (status) {
    statusBar.setDevice(status);
    if (Array.isArray(status.channel_names) && status.channel_names.length) {
      channelNames = status.channel_names;
    }
    if (Array.isArray(status.channel_quality)) {
      statusBar.setQuality(status.channel_quality, channelNames);
    }
    if (typeof status.battery === 'number' && status.battery > 0) {
      statusBar.setBattery(status.battery);
    }
  }
})();

/**
 * Rendering is decoupled from the ~8 Hz event rate: frames mark the view dirty
 * and a single rAF loop redraws at most once per display frame.
 */
function frame() {
  // The reschedule lives in `finally`: without it a single throwing render
  // silently stops the loop and freezes the whole dashboard on one stale frame.
  try {
    if (dirty) {
      dirty = false;
      circumplex.render();
      timeseries.render();
      tiles.render();
      renderHero();
      renderTable();
    }
  } catch (err) {
    console.error('render frame failed', err);
  } finally {
    requestAnimationFrame(frame);
  }
}
requestAnimationFrame(frame);

function renderHero(): void {
  const s = model.latest;
  if (!s) return;
  heroValue.textContent = fmt(s.moodSmooth, 1);
  heroValue.classList.remove('is-empty');
  heroState.textContent = quadrantLabel(s.valence, s.arousal);
  heroState.className = `hero-state ${s.moodSmooth >= 60 ? 'lean-positive' : s.moodSmooth <= 40 ? 'lean-negative' : 'lean-neutral'}`;
  heroFaa.textContent = fmtSigned(s.faa, 2);
}

function renderTable(): void {
  const s = model.latest;
  if (!s) return;
  const rows: Array<[string, string]> = [
    ['Mood — smoothed (0–100)', fmt(s.moodSmooth, 1)],
    ['Mood — raw frame', fmt(s.mood, 1)],
    ['FAA', fmtSigned(s.faa, 3)],
    [`Arousal — ${model.arousalSource.label}`, fmt(s.arousal * 50 + 50, 1)],
    ['Engagement', fmt(s.engagement, 1)],
    ['Cognitive load', fmt(s.cognitiveLoad, 1)],
    ['Relaxation', fmt(s.relaxation, 1)],
    ['Meditation', fmt(s.meditation, 1)],
    ['Drowsiness', fmt(s.drowsiness, 1)],
    ['SNR (dB)', fmt(s.snr, 1)],
  ];
  tableBody.innerHTML = rows
    .map(([k, v]) => `<tr><th scope="row">${k}</th><td>${v}</td></tr>`)
    .join('');
}

// --- Banner ---
let banner: HTMLElement | null = null;
function showBanner(message: string): void {
  if (!banner) {
    banner = document.createElement('div');
    banner.className = 'banner';
    banner.setAttribute('role', 'status');
    app!.insertBefore(banner, main);
  }
  banner.textContent = message;
  banner.hidden = false;
}
function hideBanner(): void {
  if (banner) banner.hidden = true;
}
