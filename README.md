# Affectionalyzer

A live EEG affect monitor. Reads brain-state metrics from a local
[NeuroSkill](https://github.com/NeuroSkill-com/skill) daemon over its WebSocket
API and plots them as a valence × arousal circumplex. A second headset on a
second machine can be plotted alongside the first and tested for
[interpersonal synchrony](#hyperscanning-a-second-person).

Tested against skill-daemon 0.1.0 (protocol version 1) with a Muse 2.

![Affectionalyzer running against a live Muse 2 session: a mood index of 32.7, a valence × arousal circumplex with a two-minute trail, a mood and arousal trend chart, brain-state tiles and relative band power.](docs/screenshot.png)

*Live capture — a real Muse 2 session streaming at ~8 Hz.*

## Quick start

1. Run the NeuroSkill app and connect your headset.
2. `npm install`
3. `npm run dev`

The dev server finds the running daemon by itself — it reads the token file and
resolves the port from the daemon PID, falling back to probing the usual ports.
The startup log says which port it found. If it finds nothing, open **Connection**
in the app and enter a port and token manually.

## What it shows

**Valence** is the daemon's `mood` index: frontal alpha asymmetry
(`ln(α_AF8) − ln(α_AF7)`) rescaled to 0–100, where 50 is neutral. FAA is the most
studied EEG correlate of approach/withdrawal motivation, but it is trait-like and
highly individual — read shifts against your own baseline, not absolute values.

**Arousal** has no single canonical index, so it is a choice rather than a fact.
The selector under the circumplex switches between:

| Source | Definition |
|---|---|
| Composite (default) | `0.5·engagement + 0.3·cognitive load + 0.2·(100 − drowsiness)` |
| Engagement | `β / (α + θ)` — the biocybernetic activation index |
| Cognitive load | frontal θ / temporal α |
| Wakefulness | the daemon's `consciousness_wakefulness` score |

The composite weights are a judgement call, not something the daemon or the
literature prescribes. The active formula is always printed under the selector.

Everything user-facing reads a time-smoothed mood (τ ≈ 1.5 s) so the hero figure,
the trend line and the circumplex point can never disagree. The table view
exposes the unsmoothed per-frame value alongside it.

## Focus mode and panels

- **Focus** (or the `f` key) puts the supporting panels away and widens what is
  left to fill the page.
- **Panels** toggles all six panels individually — mood index, affect position,
  trend, brain-state scores, band power and table view — with **Show all** and
  **Hide all**.

Focus does one thing: it suppresses the four supporting panels. The mood index
and affect position keep following their own checkboxes, so focus never
re-shows something you chose to hide, and you can still toggle them from the
menu while focused. **Leaving focus is the reset** — it brings every panel back.

Emptying a column drops the layout to a single centred column. Hiding everything
leaves a restore button, so the view is never a dead end. Both focus and the
per-panel choices persist across reloads.

## Hyperscanning: a second person

Two headsets on two machines, plotted together and tested for coupling.

### Reaching the second daemon

The daemon **binds strictly to `127.0.0.1`**. It refuses connections on its own
LAN address, so there is no host you can point this app at — a port scan of the
network finds nothing because nothing is ever listening off loopback. Forward it
onto a local port instead:

```bash
ssh -N -L 18454:127.0.0.1:18444 user@partner-host
```

The remote daemon is now `127.0.0.1:18454`, which is why `{port, token}` is
enough to address both subjects and no host field is needed. It also keeps the
full-access token off the wire.

Each daemon has its own token, and the partner's lives on the partner's machine.
Pass it at dev-server start, or enter it under **Connection**:

```bash
AFFECT_PARTNER_TOKEN=… AFFECT_PARTNER_PORT=18454 npm run dev
```

The startup log reports both sources; if the tunnel is down it says so rather
than leaving you to decode a WebSocket error in the browser. Pointing both
sources at one daemon is refused outright — it would compare a brain with itself
and report perfect synchrony.

### What it shows

The circumplex gains a second point and trail, joined by a line whose length is
the pair's affective distance. The two subjects are told apart by **shape** —
circle for you, diamond for your partner — because both marks already spend
their colour on valence. The trend chart overlays your partner's mood as a
dashed line, and the **Synchrony** panel reports windowed correlation of valence
and of arousal.

### Reading the synchrony numbers

Every correlation is shown against a **surrogate floor**: the same computation
with the two signals deliberately misaligned in time. This is the whole point of
the panel. Smoothed EEG indices correlate with each other by construction — over
40 simulated independent pairs, raw |r| ran to a median of 0.12 and a maximum of
0.30 — so an unqualified 0.3 looks like rapport when it is really autocorrelation.
Only the part of a bar past the marked threshold is evidence of anything.

Three things follow from the signal rather than from choice:

- **Correlation runs on local arrival time, not daemon timestamps.** The two
  daemons keep independent wall clocks; a second of NTP skew would fabricate or
  destroy coupling. Both streams arrive at one process, so arrival time is one
  clock. The trend chart switches to the same basis when paired.
- **Each epoch is detrended first.** These indices drift, and two drifting
  signals correlate on their ramps alone. Measured live on two Muse 2 headsets,
  the floor on raw levels sat at **0.68** — a full minute unable to separate
  coupling from drift.
- **The epoch is 2 minutes because 1 was not enough.** FAA is already smoothed on
  roughly a 5 s constant, so a 60 s window holds only ~12 effectively independent
  samples, and the floor measured 0.52 — about the critical |r| for that many.
  Doubling the window doubles the samples and drops the floor by roughly √2.

A lead/lag readout appears only when the lagged peak clears its *own*, higher
floor: sweeping ~33 offsets is a maximisation that will always return some best
answer, and an ungated readout would name a leader from noise.

None of this makes one 2-minute window a finding. It is a live monitor, not an
experiment: no replication, no pre-registration, one dyad.

## The Mutual Affection Index

The bands, their prescriptions and how often each should appear come from
`docs/storyboard/mutual-affection-index`. The number underneath is the same
surrogate-tested coupling the synchrony panel reports, so the framing is the joke
and the measurement is not.

**Coupling counts only what clears its surrogate floor**, normalised by the
headroom above it. Valence leads, arousal contributes less, and **proximity only
attenuates** — being in the same affective place amplifies nothing on its own,
because two strangers who happen to be equally calm are not affectionate. As an
additive term it paid out up to 20 points to people who had never met, which put
a floor of ~15 under the index and made Severe Affection Deficiency unreachable
even though the storyboard's own example is 3%.

### Calibration

Raw coupling does not land in the bands at the table's rates on its own. The
surrogate test is close to a step, so a large share of pairs sit at exactly 0 or
exactly 1 and the middle bands barely occur. Acute Relational Ambiguity is worse
than rare: it occupies the single value 50, which a continuous score would
essentially never hit, yet is supposed to appear a tenth of the time.

So the raw score is mapped through a **monotonic piecewise curve** — a more
coupled pair always scores at least as high as a less coupled one — whose breaks
are the raw quantiles at the table's cumulative probabilities. A whole interval
maps onto 50, which is what gives that one-value band a real probability.

The curve is fitted against the simulator **as the app actually consumes it** —
a sliding two-minute window over a continuously drifting signal — not against
pairs held at a fixed coupling. That distinction matters: coupling that moves
*within* a window depresses the correlation for the whole window, and a fit done
on static pairs put the live median at 0 where it predicted 50.

Measured over a 40-minute run with a **shifted phase and different private
signals from the fit**:

| Band | Observed | Table |
|---|---:|---:|
| Severe Affection Deficiency | 18% | 20% |
| Low Affection | 10% | 11% |
| Subclinical Affection | 4% | 5% |
| Acute Relational Ambiguity | 10% | 10% |
| Moderate Affection | 19% | 17% |
| Critical Affection Saturation | 16% | 16% |
| Terminal Affection | 23% | 21% |

Two consequences worth expecting. **The index sits on exactly 50 while it is in
the Ambiguity band** — that band is the single value 50 and the table gives it a
tenth of all sessions, so a whole interval of raw scores has to map onto it.
And **about a fifth of windows read 0**, because the surrogate floor rejects
them; that is not a fault, it is the share the table assigns to Severe
Affection Deficiency.

`RAW_BREAKS` describes an **assumed population, not a law**. A real cohort of
dyads would need it refitted, and until someone measures one, these frequencies
are a design intent rather than an observation.

## Simulated data

Building UI is a poor reason to put a headset on, so `tools/mock-daemon.mjs`
impersonates a daemon: `/healthz`, `/v1/status`, and an `/v1/events` WebSocket
emitting `EegBands` at 8 Hz. Two terminals:

```bash
npm run sim       # two simulated subjects on 19444 and 19454
npm run dev:sim   # the app, pointed at them instead of the real daemon
```

**Two instances couple without talking to each other.** Both derive a shared
latent signal from wall-clock time, so running two processes produces a
genuinely correlated pair — the only way to watch the synchrony panel do
anything without two people and two headsets. Coupling drifts between roughly
0.05 and 0.95 over about five minutes, so verdicts move through their whole
range rather than sitting on one.

Flags worth knowing, all on `tools/mock-daemon.mjs`:

| Flag | Effect |
|---|---|
| `--coupling 0..1` | baseline share of the shared signal, before drift |
| `--lag <ms>` | sample the shared signal late, so this subject genuinely follows |
| `--drop 0..1` | discard that fraction of frames, to exercise stale and coverage paths |
| `--hz`, `--seed`, `--device`, `--port`, `--token` | the obvious |

Every period in the shared signal is far longer than any lag worth simulating.
An earlier version had 1.7 s and 3.3 s components, and a 1250 ms lag landed near
antiphase on them — the pair came out *anti*-correlated at r = −0.58, a lag
artefact rather than following behaviour. It also matches the real signal better,
since FAA arrives already smoothed on roughly a 5 s constant.

The same environment variables the simulator uses work for any daemon:
`AFFECT_SELF_TOKEN` / `AFFECT_SELF_PORT` override discovery for the local
source, mirroring the partner pair.

## Session flow

A paired session walks through five frames rather than dropping straight into
the dashboard:

```
waiting → paired → scanning → calibrating → diagnosis → live
   ↑                  ⏸ Go                                │
   └───────────────────── reset ─────────────────────────┘
```

**Waiting** holds until *both* subjects have an open daemon link **and** a
connected headset. Link alone is not enough — the daemon answers happily with
nothing on anyone's head, and "Paired successfully." is precisely the claim that
would then be false. Losing a subject mid-session drops back here; the models
keep their history, so reconnecting resumes rather than restarts.

**Paired**, **calibrating** and **diagnosis** are timed holds (2.5 s, 12 s, 9 s).
The frames overlay the instrument rather than replacing it, so the models keep
filling underneath and each takeover ends on a running session instead of an
empty one.

**Scanning does not advance on its own.** It waits for **Go**, because it is
where both signals are confirmed to be arriving — a timer would march past a
headset with a dead electrode and deliver a verdict built on it. Lingering there
also costs nothing: the models fill the whole time, so the calibration count that
follows usually has a score waiting for it.

The count on **calibrating** never runs for less than **10 seconds**, however
short its own timing is set. Pressing Go must not snap straight to a verdict: the
pair has just been told the instrument is calculating, and a result that arrives
instantly reads as one that was never computed. The shipped count is 12 s, so the
floor is slack today — it is enforced separately precisely so shortening the
count cannot quietly remove it.

The count also *waits*. No affection index exists until the
surrogate floor does, which needs roughly 18 s of both streams, so a fixed count
could hand the verdict frame nothing to report. It holds at 100% until there is a
score — which is what a screen saying "Calculating" implies anyway — with a 20 s
cap so a pair whose data never becomes testable cannot sit there forever.

**Scanning** shows only the two subjects' brain-state scores and band strength,
plus the Go that leaves it.
It is the instrument gathering, not reporting, so nothing that implies a result
appears — no affect map, no trend, and certainly no affection index. The session
phase dictates that set outright rather than intersecting it with the panel
choices, which is why band strength shows here despite being opt-in in the
running view. Panel checkboxes read as unavailable while a phase is driving the
view, and the choices are untouched when it hands back.

**Diagnosis** is the verdict alone on the screen: the Mutual Affection Index and
the band it falls in. It is the one moment the pair is asked to sit with a number
rather than watch it move. The index itself does not exist before this point, so
the running view carries no affection panel until the diagnosis has been
delivered — frame 02 is the instrument still gathering.

That phase reads **"Calculating……"** on screen; the phase itself is called
`calibrating` in code, which is what `?phase=` takes. The identifier means "the
timed hold before the verdict" and is meant to outlast the wording on the frame.

It is a **transition, not a measurement** — it counts to 100% and computes
nothing. It buys two people a moment to settle and gives the trails
time to become more than a dot. If it should ever earn its name, the hook is the
right shape already: capture each subject's resting mean and spread during the
count and show mood against their own baseline, which is the only way an absolute
FAA number means anything across people.

A **solo session skips all of it** and sits in `live`. Every frame before `live`
is about two subjects becoming a pair, which is not something that happens when
there is only one.

### Reset

**Reset** — in the header, and again at the foot of the running view — is the
change-over between one pair and the next. It clears both subjects' history, the
synchrony epoch and both replay buffers, then returns to the top of the sequence.
Connections are deliberately left alone: the headsets have not moved, only the
people wearing them.

It lands on `waiting`, which is where the next pair will be while they put the
headsets on. If the headsets are still being worn there is nothing to wait for,
so it resolves at once and the run restarts from the pairing frame — a screen
saying "waiting for both headsets" while both are plainly connected would be
telling an obvious lie.

It also clears the *drawn* marks, which is less obvious than it sounds: both
charts return early from `render()` when history is empty, so clearing the models
alone would leave the previous pair's trails painted and reading as live data
until the next frame arrived. `Circumplex.clear()` and `TimeSeries.clear()` exist
for that reason.

### Inspecting one frame

`?phase=calibrating` pins any phase so it can be looked at without sitting
through the run-up. Accepts `waiting`, `paired`, `scanning`, `calibrating`,
`diagnosis` and `live`; nothing advances while pinned — including reset, which a
pinned phase ignores.

## Notes on the daemon

- `EegBands` events arrive at **~8 Hz** on a Muse 2, not the ~4 Hz the API docs
  state. Rendering is decoupled from the event rate via `requestAnimationFrame`.
- Raw `EegSample` / `PpgSample` / `ImuSample` events are ignored — this app plots
  derived metrics only.
- BLE drops are common. The client reconnects with capped exponential backoff,
  and **Reconnect headset** calls `POST /v1/control/retry-connect` (admin scope).
- Signal-quality levels are not a documented closed set (`good` and `fair` are
  both observed); unknown levels degrade to a neutral indicator.

## Security

The daemon token is a **full-access credential**. The Vite plugin injects it into
the dev bundle only (`apply: 'serve'`); production builds get `null` and rely on
the in-app Connection panel. If you deploy this anywhere, create a scoped token
with `POST /v1/auth/tokens` (`"acl": "stream"` is enough for the live dashboard)
rather than reusing the default one.

## Available commands

- `npm install`
- `npm run dev`
- `npm run sim` — two simulated subjects, no headset required
- `npm run dev:sim` — the app pointed at the simulators
- `npm run build` — type-checks with `tsc`, then bundles
- `npm run preview`
- `npm test` — the synchrony estimator's error rates and the session state
  machine, via esbuild + node (no test framework, no extra dependencies).
  `npm run test:sync` and `npm run test:flow` run them separately.

## Project structure

- `index.html` — app shell
- `src/main.ts` — wiring, render loop, hero figure, table view
- `src/neuroskill/` — daemon client, event types, credential resolution
- `src/affect/model.ts` — valence/arousal derivation, smoothing, history buffer
- `src/affect/sync.ts` — interpersonal synchrony, surrogate testing (`sync.test.ts`)
- `src/session/flow.ts` — the session state machine (`flow.test.ts`)
- `src/ui/` — circumplex, trend chart, synchrony panel, stat tiles, band bars,
  status bar, settings, session overlay
- `src/styles.css` — palette and layout
- `docs/storyboard/` — Figma frames the session flow is built from
- `vite.config.ts` — dev-only daemon discovery plugin
- `tools/mock-daemon.mjs` — fake daemon for UI work without a headset
