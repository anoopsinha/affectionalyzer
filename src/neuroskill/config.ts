import type { NeuroSkillConfig } from './client';

/**
 * Connection settings for the two hyperscanning sources.
 *
 * `self` is the daemon on this machine, auto-detected by the dev-server plugin.
 * `partner` is a daemon on a second machine, which is *not* auto-detectable:
 * skill-daemon binds to loopback only, so the second machine is reached through
 * an SSH tunnel and its token lives on that machine. Supply it either via the
 * `AFFECT_PARTNER_PORT` / `AFFECT_PARTNER_TOKEN` environment variables when
 * starting the dev server, or through the Connection panel.
 */

export type SourceId = 'self' | 'partner';

export const SOURCE_IDS: readonly SourceId[] = ['self', 'partner'];

export const SOURCE_LABEL: Record<SourceId, string> = {
  self: 'You',
  partner: 'Partner',
};

export interface Bootstrap {
  self: NeuroSkillConfig | null;
  partner: NeuroSkillConfig | null;
}

/**
 * Credentials injected at dev-server start by the plugin in `vite.config.ts`.
 * Both entries are `null` in a production build — tokens are never baked into a
 * shipped bundle.
 */
declare const __NEUROSKILL_BOOTSTRAP__: Bootstrap | null;

const STORAGE_KEY: Record<SourceId, string> = {
  // The self key predates hyperscanning and is left as-is so an existing
  // override survives the upgrade.
  self: 'affectionalyzer.connection',
  partner: 'affectionalyzer.connection.partner',
};

function readOverride(source: SourceId): NeuroSkillConfig | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY[source]);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<NeuroSkillConfig>;
    if (typeof parsed.port === 'number' && typeof parsed.token === 'string' && parsed.token) {
      const config: NeuroSkillConfig = { port: parsed.port, token: parsed.token };
      if (typeof parsed.host === 'string' && parsed.host) config.host = parsed.host;
      return config;
    }
  } catch {
    /* corrupt entry — fall through to the injected bootstrap */
  }
  return null;
}

export function saveOverride(source: SourceId, config: NeuroSkillConfig): void {
  localStorage.setItem(STORAGE_KEY[source], JSON.stringify(config));
}

export function clearOverride(source: SourceId): void {
  localStorage.removeItem(STORAGE_KEY[source]);
}

/** A manual entry in the settings panel always wins over the injected value. */
export function resolveConfig(source: SourceId): NeuroSkillConfig | null {
  return readOverride(source) ?? bootstrapConfig(source);
}

export function bootstrapConfig(source: SourceId): NeuroSkillConfig | null {
  try {
    return __NEUROSKILL_BOOTSTRAP__?.[source] ?? null;
  } catch {
    return null;
  }
}

/**
 * Two sources pointing at the same daemon would plot one brain against itself
 * and report perfect synchrony — the single most misleading failure this app can
 * have. Callers refuse to start the partner stream when this is true.
 */
export function isSameEndpoint(a: NeuroSkillConfig, b: NeuroSkillConfig): boolean {
  return (a.host ?? '127.0.0.1') === (b.host ?? '127.0.0.1') && a.port === b.port;
}
