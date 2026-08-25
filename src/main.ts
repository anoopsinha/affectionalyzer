import './styles.css';

import { drawAffection } from './affect/affection';
import { AffectModel, quadrantLabel, type ReplayFrame } from './affect/model';
import { SyncModel } from './affect/sync';
import { phaseFromQuery, SessionFlow, type Phase } from './session/flow';
import { NeuroSkillClient, type NeuroSkillConfig } from './neuroskill/client';
import { DemoSource } from './neuroskill/demo';
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

/**
 * The drawn Mutual Affection Index, fixed for the session.
 *
 * Drawn once when the calculating screen goes up and held from then on. It does
 * not follow the streams — everything else on the page keeps moving, and this
 * deliberately does not, because a verdict that drifted while you read it would
 * not be a verdict.
 */
let affection: number | null = null;

/**
 * When the instrument stopped taking data, or null while it is running.
 *
 * The last screen is the verdict's evidence, so it shows the session as it stood
 * when the verdict frame ended rather than drifting on past the number it was
 * given. A chart still moving underneath a fixed score invites reading the two
 * together, and by then they are about different moments.
 *
 * Frozen by not ingesting rather than by not drawing. The models keep exactly
 * what they had, so a resize or a panel being toggled redraws the same picture —
 * where a paused renderer over a live model would quietly repaint a later one.
 */
let frozenAt: number | null = null;

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
// Fetched on demand, not bundled — see `loadPairedAnimation`. Started now so it
// is usually ready by the time the frame appears, and harmless if it is not.
void overlay.loadPairedAnimation();

/**
 * Frame 02's bar: the "Scanning…" chip, and the Go that leaves it.
 *
 * This frame does not advance on a timer. It is where both signals are confirmed
 * to be arriving, and a clock would march past a headset with a dead electrode
 * and deliver a verdict built on it.
 */
const scanning = document.createElement('div');
scanning.className = 'scanning-bar';
scanning.hidden = true;

const scanningChip = document.createElement('div');
scanningChip.className = 'scanning-chip';
scanningChip.innerHTML = '<span class="scanning-dot"></span>Scanning…';

const goBtn = document.createElement('button');
goBtn.type = 'button';
goBtn.className = 'btn btn-go';
goBtn.textContent = 'Go';

const goHint = document.createElement('span');
goHint.className = 'scanning-hint';
goHint.textContent = 'Check both signals are live, then calculate.';

scanning.append(scanningChip, goBtn, goHint);
app.insertBefore(scanning, main);

goBtn.addEventListener('click', () => flow.begin());

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

/*
 * Name any subject the page is inventing, in the header beside the connection
 * chips it concerns — revealed by the wordmark along with the rest of them.
 *
 * Not the transient banner above the layout: the self stream hides that one as
 * soon as its link opens, and a generated stream opens a link like any other,
 * so a message there would have dismissed itself immediately.
 */
function refreshSimulationNotice(): void {
  const generated = ([streams.self, streams.partner] as Stream[])
    .filter((s) => present(s) && simulated(s))
    .map((s) => SOURCE_LABEL[s.id]);
  // Silent in the deployed build, where there is no daemon to reach and
  // generating both subjects is the entire point, and when the demo was asked
  // for outright. This is for the case nobody chose.
  const warn = import.meta.env.DEV && forcedDemo === null && generated.length > 0;
  if (!warn) {
    statusBar.setNotice(null);
    return;
  }
  const subject = generated.join(' and ');
  const verb = generated.length === 1 ? 'is' : 'are';
  statusBar.setNotice(
    `${subject} ${verb} being generated, not read from a headset — no daemon ` +
      'credentials were found for it at startup. The dev server looks for the ' +
      'daemon once, when it starts: if you started the NeuroSkill app afterwards, ' +
      'restart the dev server. Otherwise enter the port and token under Connection.',
  );
}

// --- Verdict row: the affection index and its diagnosis, side by side ---
// Frame 05 sets the result alongside the affect map rather than above
// everything, so it lives in the left column and no longer spans.
const verdictRow = document.createElement('div');
verdictRow.className = 'verdict-row';
left.appendChild(verdictRow);
const maiCard = new MaiCard(verdictRow);
const diagnosisCard = new DiagnosisCard(verdictRow);

// --- Mood index: one per subject ---
const heroA = new MoodHero(left, { label: 'Subject A', markerClass: 'marker-self' });
heroA.bind(model);
const heroB = new MoodHero(left, { label: 'Subject B', markerClass: 'marker-partner' });
heroB.bind(null);

// --- Circumplex ---
const circumplexCard = document.createElement('section');
circumplexCard.className = 'card affect-card';
right.appendChild(circumplexCard);
const circumplex = new Circumplex(circumplexCard, { meanWindowMs: 30_000 });
circumplex.bind(model);
circumplex.bindPartner(null);

/*
 * No arousal-axis picker on the card.
 *
 * Neither storyboard frame has one, and it was a row of controls under a plot
 * whose height is now set by the row it sits in — it was spending the circle's
 * diameter on a choice a reader of these two screens is not being asked to
 * make. Both models stay on `AROUSAL_SOURCES[0]`, the composite, which is what
 * the picker defaulted to; the label and formula are still carried on
 * `model.arousalSource` and still name the axis in the table view.
 */

// --- Instrument ---
// Construction order is DOM order, and DOM order is frame 05: the verdict row,
// then the stats strip, then the trend down the wide column.
// A column per subject: band strength with that subject's scores beneath it,
// the pair side by side, as both storyboard frames now show them.
/*
 * Grouped by measure rather than by subject: the two band readouts share a row
 * and the two score columns share the row under it. Frame 02 lines those two
 * rows up with the affect map and the trend beside them, which a per-subject
 * column could not do — the bands and the scores have to move independently.
 */
const bandsPair = document.createElement('div');
bandsPair.className = 'subject-pair pair-bands';
right.appendChild(bandsPair);

const tilesPair = document.createElement('div');
tilesPair.className = 'subject-pair pair-tiles';
right.appendChild(tilesPair);

const bandBarsA = new BandBars(bandsPair, { label: 'Subject A', markerClass: 'marker-self' });
const bandBarsB = new BandBars(bandsPair, { label: 'Subject B', markerClass: 'marker-partner' });

const tilesA = new Tiles(tilesPair, { label: 'Subject A', markerClass: 'marker-self' });
tilesA.bind(model);
const tilesB = new Tiles(tilesPair, { label: 'Subject B', markerClass: 'marker-partner' });
tilesB.bind(null);

const timeseries = new TimeSeries(left, WINDOW_MS);
timeseries.bind(model);
timeseries.bindPartner(null);

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

/*
 * Declared here, above `PanelControls`, and not beside `placeAffectMap` where
 * they are read: the panel controls call their layout callback from inside their
 * own constructor, and that callback calls `alignFirstRow`. A `let` declared
 * further down the file is still in its temporal dead zone at that moment, so
 * reaching for it threw and took the rest of the module — the render loop
 * included — down with it, leaving a page that looked built but never updated.
 */
let affectMapOnLeft = false;

/**
 * Make the verdict meet the affect map at the same baseline.
 *
 * The two sit side by side in frame 05 but live in separate columns, so nothing
 * in CSS makes them one row — the map, taller by its plot, simply overhung a
 * short verdict. The storyboard draws both cards to the same depth, so the
 * shorter one is grown to the taller rather than the map being crushed to a
 * plot too small to label. Only ever grows the verdict, so there is no feedback
 * loop back into the map's height.
 */
function alignFirstRow(): void {
  const paired = !affectMapOnLeft && !verdictRow.hidden && !circumplexCard.hidden;
  // Measured, not per-frame: reading `offsetHeight` forces a synchronous layout,
  // and the only things that move this are the phase, the panel toggles and the
  // card's own size. Each of those calls in.
  verdictRow.style.minHeight = paired ? `${circumplexCard.offsetHeight}px` : '';
}

// --- View controls ---
const panels = new PanelControls(
  statusBar.actions,
  main,
  { primary: left, secondary: right },
  [
    { id: 'verdict', label: 'Affection index', el: verdictRow, column: 'primary', focus: true },
    {
      id: 'affect',
      label: 'Affect Map',
      el: circumplexCard,
      column: 'secondary',
      focus: true,
    },
    {
      id: 'tiles-a',
      label: 'Brain-state scores · Subject A',
      el: tilesA.root,
      column: 'secondary',
      optIn: true,
    },
    {
      id: 'tiles-b',
      label: 'Brain-state scores · Subject B',
      el: tilesB.root,
      column: 'secondary',
      optIn: true,
    },
    { id: 'trend', label: 'Trend', el: timeseries.root, column: 'primary' },
    {
      id: 'bands-a',
      label: 'Band strength · Subject A',
      el: bandBarsA.root,
      column: 'secondary',
    },
    {
      id: 'bands-b',
      label: 'Band strength · Subject B',
      el: bandBarsB.root,
      column: 'secondary',
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
    // A pair row whose two cards are both hidden would still spend the column's
    // gap, leaving a stripe of nothing between the panels either side of it.
    bandsPair.hidden = bandBarsA.root.hidden && bandBarsB.root.hidden;
    tilesPair.hidden = tilesA.root.hidden && tilesB.root.hidden;
    // Charts read their pixel size from the layout, so redraw once it settles.
    alignFirstRow();
    dirty = true;
  },
);
let lastAlignedPhase: string | null = null;
// Observed rather than called once at startup: the card has no height until the
// fonts land and the grid settles, so a single call on load measured zero.
new ResizeObserver(alignFirstRow).observe(circumplexCard);

/**
 * Whether to generate both subjects in the page instead of reading a daemon.
 *
 * On by default when neither source has credentials — which is exactly the
 * deployed build, where there is no daemon to reach and the alternative is a
 * page that says "No daemon credentials found" and does nothing. `?demo=0`
 * turns it off, `?demo` forces it on over a working daemon.
 */
function demoRequested(): boolean | null {
  const v = new URLSearchParams(window.location.search).get('demo');
  if (v === null) return null;
  return v !== '0' && v !== 'false';
}

/**
 * The affect map changes column between the two frames.
 *
 * Frame 02 puts it top-left above the trend; frame 05 puts it top-right above
 * the band columns, with the verdict taking the left. Re-parenting the one card
 * is far simpler than expressing both arrangements in a single grid, and the SVG
 * survives the move untouched — only its measured width changes, which is what
 * the redraw is for.
 */
function placeAffectMap(onLeft: boolean): void {
  if (onLeft === affectMapOnLeft) return;
  affectMapOnLeft = onLeft;
  if (onLeft) left.insertBefore(circumplexCard, timeseries.root);
  else right.insertBefore(circumplexCard, bandsPair);
  alignFirstRow();
  // Charts read their pixel size from the layout, so redraw once it settles.
  dirty = true;
}

/** What frame 02 shows: both subjects' scores and band strength, nothing else. */
const SCANNING_PANELS = ['affect', 'trend', 'bands-a', 'bands-b', 'tiles-a', 'tiles-b'];

// --- Connection ---

/** One live stream: its credentials, its client, and the panels it feeds. */
interface Stream {
  readonly id: SourceId;
  readonly model: AffectModel;
  readonly chips: SourceChips;
  config: NeuroSkillConfig | null;
  /** Either a real daemon client or the in-page demo source; same shape. */
  client: NeuroSkillClient | DemoSource | null;
  /** Daemon WebSocket is open. Necessary for readiness, nowhere near sufficient. */
  linkOpen: boolean;
  /** A headset is actually on someone's head and streaming. */
  headsetConnected: boolean;
}

/**
 * Whether the page generates a subject rather than reading one from a daemon.
 *
 * Per source, not once for the whole app. One real headset on this machine and
 * a generated partner is a normal way to run this — there is only ever one
 * daemon on one laptop — and a single global flag could only ever describe both
 * subjects at once. A source with credentials is read; a source without them is
 * generated. `?demo` generates both over working daemons; `?demo=0` generates
 * neither and leaves an unconfigured source idle, as it did before.
 */
const forcedDemo = demoRequested();

function simulated(s: Stream): boolean {
  return forcedDemo ?? !s.config;
}

/** A subject exists when there is either a daemon to read or a signal to make. */
function present(s: Stream): boolean {
  return simulated(s) || !!s.config;
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

  if (!present(stream)) {
    stream.chips.setLink('idle');
    stream.chips.applyStatus(null);
    stream.model.clear();
    rawFrames[stream.id] = [];
    refreshPairing();
    return;
  }

  const client: NeuroSkillClient | DemoSource = simulated(stream)
    ? new DemoSource(
        stream.id === 'self'
          ? { seed: 1, device: 'Simulated A' }
          : { seed: 2, device: 'Simulated B', lagMs: 1250 },
      )
    : new NeuroSkillClient(stream.config!);
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
    // The daemon keeps delivering after a verdict and the rate chip keeps
    // saying so, because that is the truth about the hardware. Nothing reaches
    // the session's own data — this is the freeze.
    if (frozenAt !== null) {
      stream.chips.tickFrame(performance.now());
      return;
    }

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
  const paired = present(streams.partner);
  statusBar.showPartner(paired);
  circumplex.bindPartner(paired ? partnerModel : null);
  timeseries.bindPartner(paired ? partnerModel : null);
  tilesB.bind(paired ? partnerModel : null);
  heroB.bind(paired ? partnerModel : null);
  syncPanel.setPaired(paired);
  refreshSimulationNotice();
  syncPanel.setSimulated(
    ([streams.self, streams.partner] as Stream[])
      .filter((s) => present(s) && simulated(s))
      .map((s) => SOURCE_LABEL[s.id]),
  );
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
  // A demo stream has no credentials by definition, so requiring `config` here
  // left the deployed build stuck on the connecting frame forever — with both
  // subjects visibly streaming behind it. Local `?demo` hid this, because the
  // dev server injects real credentials even when the demo source is used.
  const live = (s: Stream) => present(s) && s.linkOpen && s.headsetConnected;
  flow.setReady(live(streams.self) && live(streams.partner));

  const missing = ([streams.self, streams.partner] as Stream[])
    .filter((s) => present(s) && !live(s))
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

if (!present(streams.self)) {
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
  tilesA.render();
  tilesB.render();
  syncPanel.update(null);
  affection = null;
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
// The unlock link on the verdict frame is how you get past it before its thirty
// seconds are up. It leads to the detail view, which is what it claims to sell.
overlay.unlockBtn.addEventListener('click', () => flow.revealDetails());
footerReset.addEventListener('click', resetSession);
// The opening screen is one viewport-sized button, so this is the click-anywhere.
overlay.titleBtn.addEventListener('click', () => flow.start());

/*
 * Space and page-down, as ways to press whichever control the screen is
 * currently asking for.
 *
 * Four frames ask for one thing each and nothing else: the opening screen wants
 * to be started, `scanning` wants Go, the verdict wants the unlock link, and the
 * running view wants Reset. Two people sitting side by side with headsets on are
 * not well placed to find a small button with a mouse, so the phase decides what
 * the key means and there is never more than one candidate.
 *
 * Page-down alongside space because that is the other key that means "next" —
 * it is what a presentation remote sends, which puts the whole sequence on a
 * clicker that can be held by someone who is not at the keyboard.
 *
 * The three frames that advance on their own — waiting, paired, calculating —
 * have no action, and neither key does anything on them rather than skipping
 * them.
 */
function primaryAction(phase: Phase): (() => void) | null {
  switch (phase) {
    case 'title':
      return () => flow.start();
    case 'scanning':
      return () => flow.begin();
    case 'diagnosis':
      return () => flow.revealDetails();
    case 'live':
      return resetSession;
    default:
      return null;
  }
}

/** The key belongs to the field, not to us, whenever something is being typed. */
function isTextEntry(node: EventTarget | null): boolean {
  if (!(node instanceof HTMLElement)) return false;
  if (node.isContentEditable) return true;
  const tag = node.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/**
 * Controls that answer space themselves.
 *
 * A focused `<button>` already fires a click on space, so acting here too would
 * run the action twice — visibly so for Reset, which would clear the session it
 * had just restarted.
 */
function handlesSpaceItself(node: Element | null): boolean {
  if (!(node instanceof HTMLElement)) return false;
  const tag = node.tagName;
  return tag === 'BUTTON' || tag === 'SUMMARY' || node.getAttribute('role') === 'button';
}

window.addEventListener('keydown', (event) => {
  const isSpace = event.key === ' ' || event.code === 'Space';
  const isPageDown = event.key === 'PageDown' || event.code === 'PageDown';
  if (!isSpace && !isPageDown) return;
  // A held key must not fire the action over and over, and a modified press is
  // somebody talking to the browser rather than to this page.
  if (event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
  if (isTextEntry(event.target)) return;
  // The focused-control check is space's alone: a button answers space itself,
  // but page-down means nothing to it, so standing down there would make the
  // clicker stop working the moment anyone tabbed to something.
  if (isSpace && handlesSpaceItself(document.activeElement)) return;

  const act = primaryAction(flow.phase);
  if (!act) return;
  // Only once we know there is something to do: both keys scroll the page, and
  // swallowing that on a frame with nothing to advance would be a dead key.
  event.preventDefault();
  act();
});

/**
 * Stop the instrument, or start it again.
 *
 * Both halves are idempotent, so this can be driven straight off the flow's own
 * state on every phase change rather than by catching one transition.
 */
function setFrozen(frozen: boolean): void {
  if (frozen === (frozenAt !== null)) return;
  frozenAt = frozen ? Date.now() : null;
  // The circumplex withdraws a point it considers stale, which a frozen one
  // becomes within seconds. Hand it the instant the clock stopped.
  circumplex.setFrozenAt(frozenAt);
  if (frozen && present(streams.partner)) {
    // One last reading, at the freeze rather than up to half a second before
    // it: the panel is about to hold this number for as long as the screen is
    // up, so it should be the one that matches the rest of the frame.
    syncPanel.update(sync.compute(frozenAt!));
  }
  dirty = true;
}

flow.on((phase) => {
  if (phase === 'calibrating' && affection === null) {
    affection = drawAffection();
    maiCard.update(affection);
    diagnosisCard.update(affection);
    overlay.setAffection(affection);
    // Nothing to wait for now that the number is drawn rather than measured.
    flow.setDiagnosisReady(true);
  }
  // `settled` is the flow's own answer to "has a verdict been delivered", and
  // it is false again after a reset, so the thaw needs no separate trigger.
  setFrozen(flow.settled);
  dirty = true;
});

startStream(streams.self);
startStream(streams.partner);

// `?phase=calibrating` freezes a frame for inspection without sitting through
// the run-up. Applied last so it overrides whatever the streams just decided.
const forced = phaseFromQuery();
if (forced) {
  // Pinning jumps past `calibrating`, where the draw normally happens, so a
  // pinned verdict or detail view would have nothing to show. Draw here too, or
  // the inspection path cannot inspect the thing it exists for.
  if (forced === 'diagnosis' || forced === 'live') {
    affection = drawAffection();
    maiCard.update(affection);
    diagnosisCard.update(affection);
    overlay.setAffection(affection);
  }
  flow.forcePhase(forced);
}

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
      tilesA.render();
      tilesB.render();
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
    main.classList.toggle('is-scanning', phase === 'scanning');
    placeAffectMap(phase === 'scanning');
    // The verdict row only exists from the diagnosis on, so its pairing with the
    // map has to be re-measured when the phase reveals it — the map itself has
    // not resized, so nothing else would have asked.
    if (phase !== lastAlignedPhase) {
      lastAlignedPhase = phase;
      alignFirstRow();
    }
    sessionFooter.hidden = phase !== 'live';

    // Frame 02 is the instrument gathering, not reporting: the two subjects'
    // raw readings and nothing that implies a result. Band strength is opt-in in
    // the running view but shown here, so the phase dictates the set outright
    // rather than intersecting it with whatever the user last chose.
    panels.setPhaseOnly(phase === 'scanning' ? SCANNING_PANELS : null);

    const now = Date.now();
    if (frozenAt === null && present(streams.partner) && now - lastSyncAt >= SYNC_INTERVAL_MS) {
      lastSyncAt = now;
      // The synchrony panel still reports the real, surrogate-tested coupling.
      // The affection index no longer rides on it — it is drawn — so this no
      // longer feeds the verdict.
      syncPanel.update(sync.compute(now));
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

