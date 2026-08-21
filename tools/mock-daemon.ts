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

import { frameAt } from '../src/neuroskill/signal.ts';

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

// --- Signal ---------------------------------------------------------------
// Imported, not reimplemented. `src/neuroskill/signal.ts` is the one copy, and
// the deployed build generates its frames from the same module — see
// `src/neuroskill/demo.ts`. Two copies of this maths would drift, and the
// synchrony estimator is tested against its exact properties.

let sampleCount = 0;

function frame() {
  sampleCount += Math.round(256 / HZ);
  return frameAt(Date.now(), { seed: SEED, coupling: COUPLING, lagMs: LAG_MS, hz: HZ });
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
