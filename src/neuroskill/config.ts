import type { NeuroSkillConfig } from './client';

/**
 * Credentials injected at dev-server start by the plugin in `vite.config.ts`,
 * which reads the daemon's own token file. `null` in a production build — the
 * token is never baked into a shipped bundle.
 */
declare const __NEUROSKILL_BOOTSTRAP__: NeuroSkillConfig | null;

const STORAGE_KEY = 'affectionalyzer.connection';

function readOverride(): NeuroSkillConfig | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<NeuroSkillConfig>;
    if (typeof parsed.port === 'number' && typeof parsed.token === 'string' && parsed.token) {
      return { port: parsed.port, token: parsed.token };
    }
  } catch {
    /* corrupt entry — fall through to the injected bootstrap */
  }
  return null;
}

export function saveOverride(config: NeuroSkillConfig): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

export function clearOverride(): void {
  localStorage.removeItem(STORAGE_KEY);
}

/** A manual entry in the settings panel always wins over the injected value. */
export function resolveConfig(): NeuroSkillConfig | null {
  return readOverride() ?? bootstrapConfig();
}

export function bootstrapConfig(): NeuroSkillConfig | null {
  try {
    return __NEUROSKILL_BOOTSTRAP__;
  } catch {
    return null;
  }
}
