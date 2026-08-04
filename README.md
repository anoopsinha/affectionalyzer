# Affectionalyzer

A live EEG affect monitor. Reads brain-state metrics from a local
[NeuroSkill](https://github.com/NeuroSkill-com/skill) daemon over its WebSocket
API and plots them as a valence × arousal circumplex.

Tested against skill-daemon 0.1.0 (protocol version 1) with a Muse 2.

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
- `npm run build` — type-checks with `tsc`, then bundles
- `npm run preview`

## Project structure

- `index.html` — app shell
- `src/main.ts` — wiring, render loop, hero figure, table view
- `src/neuroskill/` — daemon client, event types, credential resolution
- `src/affect/model.ts` — valence/arousal derivation, smoothing, history buffer
- `src/ui/` — circumplex, trend chart, stat tiles, band bars, status bar, settings
- `src/styles.css` — palette and layout
- `vite.config.ts` — dev-only daemon discovery plugin
