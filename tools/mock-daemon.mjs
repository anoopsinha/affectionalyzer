/**
 * A fake skill-daemon, for building UI without wearing a headset.
 *
 * Speaks enough of the real protocol for the app to believe it: `/healthz`,
 * `/v1/status`, `/v1/control/retry-connect`, and an `/v1/events` WebSocket
 * emitting `EegBands` at the ~8 Hz a Muse 2 actually delivers.
 *
 * The WebSocket handshake is implemented here rather than pulled from `ws`,
 * because the app has no runtime dependencies and a mock is a poor reason to
 * acquire the first one. Server-to-client frames are unmasked per RFC 6455, so
 * only the outbound path needs real work.
 *
 * TWO INSTANCES COUPLE WITHOUT TALKING TO EACH OTHER. Both derive a shared
 * latent signal from wall-clock time, so running two on one machine produces a
 * genuinely correlated pair — which is the only way to see the synchrony panel
 * do anything. `--coupling` sets how much of each subject is that shared signal,
 * and it drifts slowly on its own so verdicts move between "no coupling" and
 * "strong" over a few minutes instead of sitting still.
 *
 *   node tools/mock-daemon.mjs --port 18444 --token dev --device Sim-A
 *   node tools/mock-daemon.mjs --port 18454 --token dev --device Sim-B --lag 1200
 *
 * `--lag` makes a subject sample the shared signal late, so they genuinely
 * follow — the lead/lag readout should recover roughly that many milliseconds.
 */

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const PORT = Number(arg('port', 18444));
const TOKEN = arg('token', 'dev');
const DEVICE = arg('device', 'Sim-A');
const SEED = Number(arg('seed', PORT));
const LAG_MS = Number(arg('lag', 0));
/** Baseline share of the shared signal, 0..1. Drifts around this at runtime. */
const COUPLING = Number(arg('coupling', 0.5));
const HZ = Number(arg('hz', 8));
/** Fraction of frames to drop, for exercising the stale/coverage paths. */
const DROP = Number(arg('drop', 0));

const CHANNELS = ['TP9', 'AF7', 'AF8', 'TP10'];
const started = Date.now();
let sampleCount = 0;

// --- Signal ---------------------------------------------------------------
// Deterministic functions of wall-clock time: no state to diverge, and two
// processes started minutes apart still agree on the shared component.

/** Smooth pseudo-random-looking signal in -1..1 from incommensurable periods. */
function wobble(t, periods, phase) {
  let v = 0;
  let w = 0;
  for (let i = 0; i < periods.length; i += 1) {
    const amp = 1 / (i + 1);
    v += amp * Math.sin((t / periods[i]) + phase * (i + 1.7));
    w += amp;
  }
  return v / w;
}

/**
 * The signal both subjects share. Identical in every instance by construction.
 *
 * Every period is far longer than any `--lag` worth simulating. An earlier
 * version included 1.7 s and 3.3 s components, and a 1250 ms lag landed close to
 * antiphase on those — the pair came out *anti*-correlated at r = -0.58 with no
 * recoverable peak, which is a lag artefact rather than the following behaviour
 * it was meant to model. It also matches the real signal better: FAA arrives
 * already smoothed on roughly a 5 s constant, so there is little genuine power
 * down there to reproduce.
 */
const latent = (t) => wobble(t, [37000, 19000, 11000, 6500], 0.4);

/** One subject's private component, on the same timescales but uncorrelated. */
const own = (t, seed) => wobble(t, [31000, 16000, 9000, 5200], seed * 0.618);

/** Coupling strength drifts, so the panel's verdict changes over ~5 minutes. */
const couplingAt = (t) => {
  const swing = 0.45 * Math.sin(t / 45000);
  return Math.min(0.95, Math.max(0.02, COUPLING + swing));
};

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const score = (v) => Math.round(clamp01((v + 1) / 2) * 1000) / 10;

function frame() {
  const now = Date.now();
  const t = now - LAG_MS;
  const k = couplingAt(now);
  const core = k * latent(t) + (1 - k) * own(t, SEED);

  // A slow ramp on top, because real sessions drift and the correlation maths
  // is supposed to detrend it away rather than read it as coupling.
  const drift = 0.25 * Math.sin(now / 130000);
  const valence = Math.max(-1, Math.min(1, core + drift));
  const arousalCore = 0.7 * core + 0.3 * own(t, SEED + 11);

  const engagement = score(arousalCore);
  const cognitiveLoad = score(0.6 * arousalCore + 0.4 * own(t, SEED + 3));
  const drowsiness = score(-0.7 * arousalCore + 0.3 * own(t, SEED + 5));
  const relaxation = score(-0.5 * arousalCore + 0.5 * own(t, SEED + 7));

  // Relative band powers must sum to 1 — the bars read them as a composition.
  const raw = {
    rel_delta: 0.10 + 0.05 * (1 + own(t, SEED + 13)),
    rel_theta: 0.16 + 0.06 * (1 + own(t, SEED + 17)),
    rel_alpha: 0.30 + 0.12 * (1 - arousalCore),
    rel_beta: 0.22 + 0.12 * (1 + arousalCore),
    rel_gamma: 0.07 + 0.03 * (1 + own(t, SEED + 19)),
  };
  const total = Object.values(raw).reduce((s, v) => s + v, 0);
  const rel = Object.fromEntries(Object.entries(raw).map(([key, v]) => [key, v / total]));

  const channels = CHANNELS.map((channel, i) => {
    const jitter = 1 + 0.12 * own(t, SEED + 23 + i);
    const c = Object.fromEntries(Object.entries(rel).map(([key, v]) => [key, v * jitter]));
    const sum = Object.values(c).reduce((s, v) => s + v, 0);
    const norm = Object.fromEntries(Object.entries(c).map(([key, v]) => [key, v / sum]));
    return {
      channel,
      delta: norm.rel_delta * 40,
      theta: norm.rel_theta * 40,
      alpha: norm.rel_alpha * 40,
      beta: norm.rel_beta * 40,
      gamma: norm.rel_gamma * 40,
      high_gamma: 0.5,
      ...norm,
      rel_high_gamma: 0.01,
      dominant: 'alpha',
      dominant_symbol: 'α',
      dominant_color: '#1baf7a',
    };
  });

  sampleCount += Math.round(256 / HZ);

  return {
    timestamp: now / 1000,
    channels,
    // FAA is the quantity mood is derived from; keep them consistent so the
    // hero figure and its FAA subtitle cannot disagree.
    faa: valence * 1.2,
    mood: score(valence),
    laterality_index: valence * 0.8,
    engagement,
    focus: engagement,
    relaxation,
    meditation: score(-0.4 * arousalCore + 0.6 * own(t, SEED + 29)),
    cognitive_load: cognitiveLoad,
    drowsiness,
    ...rel,
    snr: 12 + 4 * own(t, SEED + 31),
    apf: 10.2,
    sef95: 24,
    spectral_centroid: 12,
    pse: 0.8,
    coherence: 0.5,
    tar: 1.2,
    bar: 0.9,
    dtr: 1.1,
    tbr: 1.3,
    higuchi_fd: 1.6,
    permutation_entropy: 0.9,
    sample_entropy: 1.1,
    dfa_exponent: 0.8,
    hjorth_activity: 1,
    hjorth_mobility: 0.5,
    hjorth_complexity: 1.4,
    consciousness_lzc: 60,
    consciousness_wakefulness: score(arousalCore),
    consciousness_integration: 55,
    blink_count: 0,
    blink_rate: 12,
  };
}

const status = () => ({
  state: 'connected',
  device_name: DEVICE,
  device_kind: 'muse',
  device_id: DEVICE,
  sample_count: sampleCount,
  battery: Math.round(100 - ((Date.now() - started) / 600000) * 5),
  device_error: null,
  target_display_name: DEVICE,
  channel_names: CHANNELS,
  channel_quality: ['good', 'good', 'fair', 'good'],
  eeg_sample_rate_hz: 256,
  retry_attempt: 0,
  retry_countdown_secs: 0,
});

// --- HTTP -----------------------------------------------------------------

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const send = (code, body) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (url.pathname === '/healthz') return send(200, { ok: true });
  if (url.pathname === '/v1/status') return send(200, status());
  if (url.pathname === '/v1/control/retry-connect') return send(200, status());
  return send(404, { error: 'not found' });
});

// --- WebSocket ------------------------------------------------------------

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** RFC 6455 text frame, server-to-client, so never masked. */
function encode(text) {
  const payload = Buffer.from(text, 'utf8');
  const n = payload.length;
  let header;
  if (n < 126) {
    header = Buffer.alloc(2);
    header[1] = n;
  } else if (n < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(n, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(n), 2);
  }
  header[0] = 0x81; // FIN + opcode 1 (text)
  return Buffer.concat([header, payload]);
}

server.on('upgrade', (req, socket) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname !== '/v1/events') return socket.destroy();

  const token = url.searchParams.get('token');
  if (!token || (TOKEN && token !== TOKEN)) {
    socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return;
  }

  const key = req.headers['sec-websocket-key'];
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );

  const send = (type, payload) => {
    if (!socket.destroyed) socket.write(encode(JSON.stringify({ type, payload })));
  };

  send('status', status());
  const bands = setInterval(() => {
    if (DROP > 0 && Math.random() < DROP) return;
    send('EegBands', frame());
  }, 1000 / HZ);
  const meta = setInterval(() => send('status', status()), 5000);

  const stop = () => {
    clearInterval(bands);
    clearInterval(meta);
    socket.destroy();
  };
  socket.on('close', stop);
  socket.on('error', stop);
  // Client frames are masked and we need none of them; a close arrives as data.
  socket.on('data', (buf) => {
    if ((buf[0] & 0x0f) === 0x08) stop();
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(
    `mock skill-daemon "${DEVICE}" on 127.0.0.1:${PORT} — ${HZ} Hz, coupling ~${COUPLING}` +
      (LAG_MS ? `, lagging ${LAG_MS}ms` : '') +
      (DROP ? `, dropping ${Math.round(DROP * 100)}% of frames` : ''),
  );
});
