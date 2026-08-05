import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/**
 * Locate the running NeuroSkill daemon and hand its credentials to the dev bundle.
 *
 * This is a DEV-ONLY convenience (`apply: 'serve'`). The daemon token is a
 * full-access credential, so it is never injected into a production build — a
 * built bundle falls back to the in-app Connection panel, where you can paste a
 * scoped token from `POST /v1/auth/tokens` instead.
 */

interface DaemonConfig {
  port: number;
  token: string;
}

/** The two hyperscanning sources. `partner` is env-supplied; see `partnerConfig`. */
interface Bootstrap {
  self: DaemonConfig | null;
  partner: DaemonConfig | null;
}

function tokenPath(): string {
  const home = homedir();
  switch (platform()) {
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'skill', 'daemon', 'auth.token');
    case 'win32':
      return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'skill', 'daemon', 'auth.token');
    default:
      return join(home, '.config', 'skill', 'daemon', 'auth.token');
  }
}

function daemonDir(): string {
  return join(tokenPath(), '..');
}

/** Ask the OS which port the daemon PID is listening on. */
function portFromPid(): number | null {
  const pidFile = join(daemonDir(), 'daemon.pid');
  if (!existsSync(pidFile)) return null;
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  if (!Number.isInteger(pid) || pid <= 0) return null;

  try {
    if (platform() === 'win32') {
      const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' });
      for (const line of out.split(/\r?\n/)) {
        if (!line.includes('LISTENING') || !line.trim().endsWith(String(pid))) continue;
        const m = line.match(/127\.0\.0\.1:(\d+)/);
        if (m) return Number(m[1]);
      }
      return null;
    }
    const out = execFileSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-p', String(pid)], {
      encoding: 'utf8',
    });
    const m = out.match(/127\.0\.0\.1:(\d+)\s+\(LISTEN\)/);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/** Fallback when the PID lookup fails: probe the daemon's usual ports. */
async function probePort(candidates: number[]): Promise<number | null> {
  for (const port of candidates) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`, {
        signal: AbortSignal.timeout(400),
      });
      if (res.ok) return port;
    } catch {
      /* not this one */
    }
  }
  return null;
}

async function selfConfig(): Promise<DaemonConfig | null> {
  const path = tokenPath();
  if (!existsSync(path)) return null;
  const token = readFileSync(path, 'utf8').trim();
  if (!token) return null;

  const port = portFromPid() ?? (await probePort([18444, 18445, 18446, 18443]));
  return port ? { port, token } : null;
}

const PARTNER_DEFAULT_PORT = 18454;

/**
 * The partner daemon cannot be auto-detected the way the local one can.
 *
 * skill-daemon binds strictly to `127.0.0.1`, so a second machine's daemon is
 * reached by forwarding it onto a local port:
 *
 *   ssh -N -L 18454:127.0.0.1:18444 user@<partner-host>
 *
 * Its token lives on that machine and is deliberately not fetched over SSH —
 * pass it explicitly instead, or leave it unset and use the Connection panel:
 *
 *   AFFECT_PARTNER_TOKEN=… npm run dev
 */
async function partnerConfig(): Promise<DaemonConfig | null> {
  const token = process.env.AFFECT_PARTNER_TOKEN?.trim();
  if (!token) return null;

  const port = Number(process.env.AFFECT_PARTNER_PORT ?? PARTNER_DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;

  // Probe rather than trust: a tunnel whose SSH session died leaves the local
  // port closed, and failing here produces a clear startup line instead of an
  // opaque WebSocket error in the browser.
  return (await probePort([port])) ? { port, token } : null;
}

function neuroskillBootstrap(): Plugin {
  let bootstrap: Bootstrap = { self: null, partner: null };

  return {
    name: 'neuroskill-bootstrap',
    apply: 'serve',
    async config() {
      const [self, partner] = await Promise.all([selfConfig(), partnerConfig()]);
      bootstrap = { self, partner };
      return {
        define: {
          __NEUROSKILL_BOOTSTRAP__: JSON.stringify(bootstrap),
        },
      };
    },
    configureServer(server) {
      const lines = [
        bootstrap.self
          ? `You:     127.0.0.1:${bootstrap.self.port} — credentials injected (dev only).`
          : 'You:     daemon not found. Start the NeuroSkill app, or use the Connection panel.',
        bootstrap.partner
          ? `Partner: 127.0.0.1:${bootstrap.partner.port} — credentials injected (dev only).`
          : process.env.AFFECT_PARTNER_TOKEN
            ? `Partner: nothing answering on 127.0.0.1:${process.env.AFFECT_PARTNER_PORT ?? PARTNER_DEFAULT_PORT} — is the SSH tunnel up?`
            : 'Partner: not configured. Set AFFECT_PARTNER_TOKEN (+ tunnel), or use the Connection panel.',
      ];
      server.config.logger.info(`\n  ${lines.join('\n  ')}\n`);
    },
  };
}

export default defineConfig({
  plugins: [neuroskillBootstrap()],
  define: {
    // Production builds get no credentials; the Connection panel supplies them.
    __NEUROSKILL_BOOTSTRAP__: '{"self":null,"partner":null}',
  },
  server: {
    open: true,
  },
});
