import './styles.css';

import { AffectModel, AROUSAL_SOURCES, quadrantLabel, type ReplayFrame } from './affect/model';
import { SyncModel } from './affect/sync';
import { NeuroSkillClient, type NeuroSkillConfig } from './neuroskill/client';
import { isSameEndpoint, resolveConfig, type SourceId } from './neuroskill/config';
import type { EegBands } from './neuroskill/types';
import { BandBars } from './ui/bands';
import { Circumplex } from './ui/circumplex';
import { PanelControls } from './ui/panels';
import { SettingsPanel } from './ui/settings';
import { StatusBar, type SourceChips } from './ui/statusbar';
import { fmt, fmtSigned } from './ui/svg';
import { SyncPanel } from './ui/sync';
import { Tiles } from './ui/tiles';
import { TimeSeries } from './ui/timeseries';

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('#app container missing from index.html');

const WINDOW_MS = 120_000;

const model = new AffectModel({ windowMs: WINDOW_MS });
/**
 * The partner's model exists from the start even when no partner is configured.
 * It simply stays empty, which keeps every consumer on one code path instead of
 * branching on whether hyperscanning is active.
 */
const partnerModel = new AffectModel({ windowMs: WINDOW_MS });
const sync = new SyncModel();

/** Set by the event stream and by layout changes; consumed by the rAF loop. */
let dirty = false;

/**
 * Raw frames are retained so switching the arousal definition can recompute the
 * whole window rather than leaving a step in the trail.
 */
const rawFrames: Record<SourceId, ReplayFrame[]> = { self: [], partner: [] };

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

// --- Banner ---
// Declared here rather than at the end of the file because setup below can
// raise one, and a `let` referenced before its declaration runs is a temporal
// dead zone error rather than an undefined read.
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

// --- Hero figure: exactly one per view ---
const hero = document.createElement('section');
hero.className = 'card hero';
hero.innerHTML = `
  <h2 class="hero-label">Mood index</h2>
  <div class="hero-value is-empty" id="hero-value">—</div>
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
circumplex.bindPartner(null);

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
  // Both subjects must move to the new definition together; leaving the partner
  // on the old one would make every synchrony number a comparison of two
  // different measures.
  model.setArousalSource(arousalSelect.value, rawFrames.self);
  partnerModel.setArousalSource(arousalSelect.value, rawFrames.partner);
  rebuildSync();
  renderFormula();
  circumplex.render();
  timeseries.render();
  tiles.render();
  syncPanel.update(sync.compute(Date.now()));
});

// --- Secondary column ---
const timeseries = new TimeSeries(right, WINDOW_MS);
timeseries.bind(model);
timeseries.bindPartner(null);

const syncPanel = new SyncPanel(right);

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
new PanelControls(
  statusBar.actions,
  main,
  { primary: left, secondary: right },
  [
    { id: 'mood', label: 'Mood index', el: hero, column: 'primary', focus: true },
    {
      id: 'affect',
      label: 'Affect position',
      el: circumplexCard,
      column: 'primary',
      focus: true,
    },
    { id: 'sync', label: 'Synchrony', el: syncPanel.root, column: 'secondary' },
    { id: 'trend', label: 'Trend', el: timeseries.root, column: 'secondary' },
    { id: 'tiles', label: 'Brain-state scores', el: tiles.root, column: 'secondary' },
    { id: 'bands', label: 'Band power', el: bandBars.root, column: 'secondary' },
    { id: 'table', label: 'Table view', el: tableCard, column: 'secondary' },
  ],
  () => {
    // Charts read their pixel size from the layout, so redraw once it settles.
    dirty = true;
  },
);

// --- Connection ---

/** One live stream: its credentials, its client, and the panels it feeds. */
interface Stream {
  readonly id: SourceId;
  readonly model: AffectModel;
  readonly chips: SourceChips;
  config: NeuroSkillConfig | null;
  client: NeuroSkillClient | null;
}

const streams: Record<SourceId, Stream> = {
  self: {
    id: 'self',
    model,
    chips: statusBar.self,
    config: resolveConfig('self'),
    client: null,
  },
  partner: {
    id: 'partner',
    model: partnerModel,
    chips: statusBar.partner,
    config: resolveConfig('partner'),
    client: null,
  },
};

// Refuse a configuration that would compare one brain with itself. Two clients
// on one daemon produce two identical streams and a perfect synchrony score,
// which looks like a spectacular result rather than the mistake it is.
if (
  streams.self.config &&
  streams.partner.config &&
  isSameEndpoint(streams.self.config, streams.partner.config)
) {
  streams.partner.config = null;
  showBanner(
    'Both sources pointed at the same daemon, so the partner stream was not started — it would have compared one brain with itself. Give the partner its tunnelled port under Connection.',
  );
}

function startStream(stream: Stream): void {
  stream.client?.disconnect();
  stream.client = null;

  if (!stream.config) {
    stream.chips.setLink('idle');
    stream.chips.applyStatus(null);
    stream.model.clear();
    rawFrames[stream.id] = [];
    refreshPairing();
    return;
  }

  const client = new NeuroSkillClient(stream.config);
  stream.client = client;

  client.on('link', (state, detail) => {
    stream.chips.setLink(state, detail);
    if (state === 'open' && stream.id === 'self') hideBanner();
  });

  client.on('status', (status) => stream.chips.applyStatus(status));
  client.on('quality', (q) => stream.chips.setQuality(q));
  client.on('battery', (pct) => stream.chips.setBattery(pct));

  client.on('bands', (bands) => {
    const tLocal = Date.now();
    const frames = rawFrames[stream.id];
    frames.push({ bands, tLocal });
    // Keep the replay buffer aligned with the model's own window.
    while (frames.length && tLocal - frames[0].tLocal > WINDOW_MS) frames.shift();

    const sample = stream.model.push(bands, tLocal);
    sync.push(stream.id, { valence: sample.valence, arousal: sample.arousal }, tLocal);

    // The band bars and the hero figure describe one subject; that subject is
    // always you, so the partner's frames feed the models and the synchrony
    // maths without touching the single-subject panels.
    if (stream.id === 'self') bandBars.update(bands);

    stream.chips.tickFrame(performance.now());
    dirty = true;
  });

  client.connect();

  void (async () => {
    const status = await client.fetchStatus();
    // A reconfigure mid-flight can land before this resolves; ignore a status
    // belonging to a client that has since been replaced.
    if (stream.client === client && status) stream.chips.applyStatus(status);
  })();

  refreshPairing();
}

/** Show or hide every paired-session affordance based on the partner's state. */
function refreshPairing(): void {
  const paired = !!streams.partner.config;
  statusBar.showPartner(paired);
  circumplex.bindPartner(paired ? partnerModel : null);
  timeseries.bindPartner(paired ? partnerModel : null);
  syncPanel.setPaired(paired);
  if (!paired) sync.clear();
  dirty = true;
}

/** Replay both retained buffers into the synchrony model after a settings change. */
function rebuildSync(): void {
  sync.clear();
  const merged = [
    ...rawFrames.self.map((f) => ({ ...f, id: 'self' as SourceId })),
    ...rawFrames.partner.map((f) => ({ ...f, id: 'partner' as SourceId })),
  ].sort((a, b) => a.tLocal - b.tLocal);
  for (const f of merged) {
    const history = streams[f.id].model.history;
    const sample = history.find((s) => s.tLocal === f.tLocal);
    if (sample) sync.push(f.id, { valence: sample.valence, arousal: sample.arousal }, f.tLocal);
  }
}

const settings = new SettingsPanel(app, (source, next) => {
  streams[source].config = next;
  startStream(streams[source]);
});

statusBar.settingsBtn.addEventListener('click', () =>
  settings.open({ self: streams.self.config, partner: streams.partner.config }),
);

if (!streams.self.config) {
  statusBar.self.setLink('error', 'No daemon credentials — open Connection to enter them');
  showBanner(
    'No daemon credentials found. The dev server auto-detects them from a running NeuroSkill daemon; otherwise enter the port and token under Connection.',
  );
}

statusBar.reconnectBtn.addEventListener('click', async () => {
  const active = Object.values(streams).filter((s) => s.client);
  statusBar.reconnectBtn.disabled = true;
  const label = statusBar.reconnectBtn.textContent;
  statusBar.reconnectBtn.textContent = 'Reconnecting…';
  const results = await Promise.all(active.map((s) => s.client!.retryConnect()));
  if (results.some((ok) => !ok)) {
    showBanner('A reconnect request failed — that token may lack admin scope.');
  }
  window.setTimeout(() => {
    statusBar.reconnectBtn.disabled = false;
    statusBar.reconnectBtn.textContent = label;
  }, 2500);
});

startStream(streams.self);
startStream(streams.partner);

/**
 * Rendering is decoupled from the ~8 Hz event rate: frames mark the view dirty
 * and a single rAF loop redraws at most once per display frame.
 */
/**
 * Synchrony is recomputed on its own slower clock. It sweeps ~33 lags across a
 * dozen surrogates over a 240-point grid, which is far too much work to redo on
 * every ~8 Hz frame, and the underlying 60 s statistic cannot visibly change in
 * a quarter of a second anyway.
 */
const SYNC_INTERVAL_MS = 500;
let lastSyncAt = 0;

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
    const now = Date.now();
    if (streams.partner.config && now - lastSyncAt >= SYNC_INTERVAL_MS) {
      lastSyncAt = now;
      syncPanel.update(sync.compute(now));
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

