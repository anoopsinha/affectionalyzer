import './styles.css';

import { computeAffection, type AffectionScore } from './affect/affection';
import { AffectModel, AROUSAL_SOURCES, quadrantLabel, type ReplayFrame } from './affect/model';
import { SyncModel } from './affect/sync';
import { phaseFromQuery, SessionFlow } from './session/flow';
import { NeuroSkillClient, type NeuroSkillConfig } from './neuroskill/client';
import { isSameEndpoint, resolveConfig, SOURCE_LABEL, type SourceId } from './neuroskill/config';
import type { EegBands } from './neuroskill/types';
import { DiagnosisCard, MaiCard } from './ui/affection';
import { MoodHero } from './ui/hero';
import { BandBars } from './ui/bands';
import { Circumplex } from './ui/circumplex';
import { PanelControls } from './ui/panels';
import { SettingsPanel } from './ui/settings';
import { Overlay } from './ui/overlay';
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

/**
 * The session state machine, and the full-screen frames it drives.
 *
 * Created before the instrument so nothing below can reference an undefined
 * `flow` — the same temporal-dead-zone trap the banner helpers sit above.
 */
const flow = new SessionFlow();

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

// Sits over the instrument rather than replacing it, so the trails keep filling
// underneath and calibration ends on a running session, not an empty one.
const overlay = new Overlay(app);

/**
 * The "Scanning…" chip: the only thing distinguishing frame 02 from the live
 * session it becomes.
 */
const scanning = document.createElement('div');
scanning.className = 'scanning-chip';
scanning.hidden = true;
scanning.innerHTML = '<span class="scanning-dot"></span>Scanning…';
app.insertBefore(scanning, main);

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

// --- Verdict row: the affection index and its diagnosis, side by side ---
// A direct child of the layout rather than of a column: the result spans the
// full width and everything else, the affect map included, sits beneath it.
const verdictRow = document.createElement('div');
verdictRow.className = 'verdict-row';
main.insertBefore(verdictRow, left);
const maiCard = new MaiCard(verdictRow);
const diagnosisCard = new DiagnosisCard(verdictRow);

// --- Mood index: one per subject ---
const heroA = new MoodHero(left, { label: 'Subject A', markerClass: 'marker-self' });
heroA.bind(model);
const heroB = new MoodHero(left, { label: 'Subject B', markerClass: 'marker-partner' });
heroB.bind(null);

// --- Circumplex ---
const circumplexCard = document.createElement('section');
circumplexCard.className = 'card';
right.appendChild(circumplexCard);
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

// --- Instrument ---
// Construction order is DOM order, and DOM order is frame 05: the verdict row,
// then the stats strip, then the trend down the wide column.
const tiles = new Tiles(left);
tiles.bind(model);
tiles.bindPartner(null);

const timeseries = new TimeSeries(left, WINDOW_MS);
timeseries.bind(model);
timeseries.bindPartner(null);

const bandBarsA = new BandBars(right, { label: 'Subject A', markerClass: 'marker-self' });
const bandBarsB = new BandBars(right, { label: 'Subject B', markerClass: 'marker-partner' });

const syncPanel = new SyncPanel(right);

// --- Session footer: ending a session is a thing you do on the page ---
// The header keeps its own copy for the phases before the result exists, but
// the button that matters is the one in reach when two people have just been
// handed a verdict.
const sessionFooter = document.createElement('div');
sessionFooter.className = 'session-footer';
const footerReset = document.createElement('button');
footerReset.type = 'button';
footerReset.className = 'btn btn-reset';
footerReset.textContent = 'Reset';
const footerNote = document.createElement('p');
footerNote.className = 'session-footer-note';
footerNote.textContent = 'Clears both subjects and starts a new session from the top.';
sessionFooter.append(footerReset, footerNote);
main.appendChild(sessionFooter);

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
    {
      id: 'verdict',
      label: 'Affection index',
      el: verdictRow,
      column: 'primary',
      spans: true,
      focus: true,
    },
    {
      id: 'affect',
      label: 'Affect Map',
      el: circumplexCard,
      column: 'secondary',
      focus: true,
    },
    { id: 'tiles', label: 'Brain-state scores', el: tiles.root, column: 'primary' },
    { id: 'trend', label: 'Trend', el: timeseries.root, column: 'primary' },
    {
      id: 'bands-a',
      label: 'Band strength · Subject A',
      el: bandBarsA.root,
      column: 'secondary',
      optIn: true,
    },
    {
      id: 'bands-b',
      label: 'Band strength · Subject B',
      el: bandBarsB.root,
      column: 'secondary',
      optIn: true,
    },
    // Not in the storyboard's running view, but not deleted either — the table
    // is the only non-visual route to the numbers and the synchrony panel is
    // where the coupling is actually justified.
    {
      id: 'mood-a',
      label: 'Mood index · Subject A',
      el: heroA.root,
      column: 'primary',
      optIn: true,
    },
    {
      id: 'mood-b',
      label: 'Mood index · Subject B',
      el: heroB.root,
      column: 'primary',
      optIn: true,
    },
    {
      id: 'sync',
      label: 'Synchrony detail',
      el: syncPanel.root,
      column: 'secondary',
      optIn: true,
    },
    {
      id: 'table',
      label: 'Table view',
      el: tableCard,
      column: 'secondary',
      optIn: true,
    },
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
  /** Daemon WebSocket is open. Necessary for readiness, nowhere near sufficient. */
  linkOpen: boolean;
  /** A headset is actually on someone's head and streaming. */
  headsetConnected: boolean;
}

const streams: Record<SourceId, Stream> = {
  self: {
    id: 'self',
    model,
    chips: statusBar.self,
    config: resolveConfig('self'),
    client: null,
    linkOpen: false,
    headsetConnected: false,
  },
  partner: {
    id: 'partner',
    model: partnerModel,
    chips: statusBar.partner,
    config: resolveConfig('partner'),
    client: null,
    linkOpen: false,
    headsetConnected: false,
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

  stream.linkOpen = false;
  stream.headsetConnected = false;

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
    stream.linkOpen = state === 'open';
    if (!stream.linkOpen) {
      stream.headsetConnected = false;
      // With the link down we no longer know what is on anyone's head, so the
      // chip stops naming a headset. Leaving the last known device there would
      // keep asserting a connection that has demonstrably gone.
      stream.chips.setDevice(null);
    }
    refreshReadiness();
    if (state === 'open' && stream.id === 'self') hideBanner();
  });

  client.on('status', (status) => {
    stream.chips.applyStatus(status);
    stream.headsetConnected = status.state === 'connected';
    refreshReadiness();
  });
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

    // Each subject has their own band-strength panel; the hero figure is still
    // single-subject and stays with Subject A.
    (stream.id === 'self' ? bandBarsA : bandBarsB).update(bands);

    stream.chips.tickFrame(performance.now());
    dirty = true;
  });

  client.connect();

  void (async () => {
    const status = await client.fetchStatus();
    // A reconfigure mid-flight can land before this resolves; ignore a status
    // belonging to a client that has since been replaced.
    if (stream.client === client && status) {
      stream.chips.applyStatus(status);
      stream.headsetConnected = status.state === 'connected';
      refreshReadiness();
    }
  })();

  refreshPairing();
}

/** Show or hide every paired-session affordance based on the partner's state. */
function refreshPairing(): void {
  const paired = !!streams.partner.config;
  statusBar.showPartner(paired);
  circumplex.bindPartner(paired ? partnerModel : null);
  timeseries.bindPartner(paired ? partnerModel : null);
  tiles.bindPartner(paired ? partnerModel : null);
  heroB.bind(paired ? partnerModel : null);
  syncPanel.setPaired(paired);
  if (!paired) sync.clear();
  flow.setPaired(paired);
  refreshReadiness();
  dirty = true;
}

/**
 * A pair is ready when both subjects have an open link AND a connected headset.
 *
 * Link alone is not enough — the daemon answers happily with nothing on anyone's
 * head, and "Paired successfully." is precisely the claim that would be false.
 */
function refreshReadiness(): void {
  const live = (s: Stream) => !!s.config && s.linkOpen && s.headsetConnected;
  flow.setReady(live(streams.self) && live(streams.partner));

  const missing = ([streams.self, streams.partner] as Stream[])
    .filter((s) => s.config && !live(s))
    .map((s) => SOURCE_LABEL[s.id]);
  overlay.setWaitingDetail(
    missing.length === 1
      ? `Waiting on ${missing[0]} — put the headset on and let the contacts settle.`
      : 'Put them on and let the contacts settle.',
  );
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

/**
 * Full reset between sessions: two new people, same two headsets.
 *
 * Clearing the models is NOT enough. Both charts return early from `render()`
 * when history is empty, so the previous pair's trails would stay painted and
 * read as live data until the next frame arrived. The explicit visual clear is
 * the whole reason `Circumplex.clear()` and `TimeSeries.clear()` exist.
 *
 * Connections are deliberately left alone — the headsets have not moved, only
 * the people wearing them.
 */
function resetSession(): void {
  model.clear();
  partnerModel.clear();
  sync.clear();
  rawFrames.self = [];
  rawFrames.partner = [];

  circumplex.clear();
  timeseries.clear();
  tiles.render();
  syncPanel.update(null);
  maiCard.update(null);
  diagnosisCard.update(null);
  overlay.setAffection(null);
  heroA.render();
  heroB.render();
  renderTable();

  flow.reset();
  dirty = true;
}

statusBar.resetBtn.addEventListener('click', resetSession);
footerReset.addEventListener('click', resetSession);

flow.on(() => {
  dirty = true;
});

startStream(streams.self);
startStream(streams.partner);

// `?phase=calibrating` freezes a frame for inspection without sitting through
// the run-up. Applied last so it overrides whatever the streams just decided.
const forced = phaseFromQuery();
if (forced) flow.forcePhase(forced);

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
      heroA.render();
      heroB.render();
      renderTable();
    }
    // Driven every frame, not off `dirty`: the calibration count advances with
    // the clock, and would otherwise freeze whenever the data did.
    const phase = flow.phase;
    overlay.render(phase, flow.calibrationProgress);
    scanning.hidden = phase !== 'scanning';

    /*
     * The affection index is a RESULT, so it does not exist before the
     * calibration count delivers one. Frame 02 is the instrument still
     * gathering; the verdict row only joins it from the diagnosis onward, and a
     * reset takes it away again.
     *
     * Gated with a class rather than `hidden`, because `PanelControls` owns that
     * attribute and reasserts it on every toggle — setting it here would work
     * until someone opened the Panels menu, then silently stop.
     */
    main.classList.toggle('is-prediagnosis', phase !== 'diagnosis' && phase !== 'live');
    sessionFooter.hidden = phase !== 'live';

    const now = Date.now();
    if (streams.partner.config && now - lastSyncAt >= SYNC_INTERVAL_MS) {
      lastSyncAt = now;
      const result = sync.compute(now);
      syncPanel.update(result);

      // The affection index rides on the same surrogate-tested coupling the
      // synchrony panel reports, so the joke and the justification can never
      // disagree about what the pair actually did.
      const score = computeAffection(result);
      maiCard.update(score);
      diagnosisCard.update(score);
      // The verdict frame keeps updating underneath while it is on screen: it
      // holds for several seconds and the score is still settling.
      overlay.setAffection(score);
    }
  } catch (err) {
    console.error('render frame failed', err);
  } finally {
    requestAnimationFrame(frame);
  }
}
requestAnimationFrame(frame);

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

