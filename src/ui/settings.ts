import type { NeuroSkillConfig } from '../neuroskill/client';
import { bootstrapConfig, clearOverride, saveOverride } from '../neuroskill/config';
import { el } from './svg';

/**
 * Manual connection entry.
 *
 * The dev server injects the daemon's port and token automatically, so this
 * panel is the fallback for a production build, a non-default daemon port, or a
 * scoped token created via `POST /v1/auth/tokens`.
 */
export class SettingsPanel {
  readonly root: HTMLDialogElement;
  private portInput: HTMLInputElement;
  private tokenInput: HTMLInputElement;
  private onApply: (config: NeuroSkillConfig) => void;

  constructor(container: HTMLElement, onApply: (config: NeuroSkillConfig) => void) {
    this.onApply = onApply;

    this.root = document.createElement('dialog');
    this.root.className = 'settings';
    container.appendChild(this.root);

    const form = el('form', 'settings-form', this.root);
    form.setAttribute('method', 'dialog');

    const h = el('h2', undefined, form);
    h.textContent = 'Daemon connection';

    const note = el('p', 'settings-note', form);
    note.innerHTML =
      'The dev server reads the port and token from the running daemon automatically. ' +
      'Override here to target a different port or a scoped token.';

    const portLabel = el('label', 'field', form);
    portLabel.innerHTML = '<span>Port</span>';
    this.portInput = document.createElement('input');
    this.portInput.type = 'number';
    this.portInput.min = '1';
    this.portInput.max = '65535';
    this.portInput.placeholder = '18444';
    portLabel.appendChild(this.portInput);

    const tokenLabel = el('label', 'field', form);
    tokenLabel.innerHTML = '<span>Token</span>';
    this.tokenInput = document.createElement('input');
    this.tokenInput.type = 'password';
    this.tokenInput.autocomplete = 'off';
    this.tokenInput.placeholder = 'Bearer token';
    tokenLabel.appendChild(this.tokenInput);

    const hint = el('p', 'settings-hint', form);
    hint.innerHTML =
      'Default token: <code>~/Library/Application Support/skill/daemon/auth.token</code>';

    const row = el('div', 'settings-actions', form);

    const reset = el('button', 'btn btn-quiet', row);
    reset.type = 'button';
    reset.textContent = 'Use auto-detected';
    reset.addEventListener('click', () => {
      clearOverride();
      const boot = bootstrapConfig();
      if (boot) {
        this.portInput.value = String(boot.port);
        this.tokenInput.value = boot.token;
        this.onApply(boot);
      }
      this.root.close();
    });

    const cancel = el('button', 'btn btn-quiet', row);
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => this.root.close());

    const apply = el('button', 'btn', row);
    apply.type = 'button';
    apply.textContent = 'Connect';
    apply.addEventListener('click', () => {
      const port = Number(this.portInput.value);
      const token = this.tokenInput.value.trim();
      if (!Number.isInteger(port) || port < 1 || port > 65535 || !token) return;
      const config = { port, token };
      saveOverride(config);
      this.onApply(config);
      this.root.close();
    });
  }

  open(current: NeuroSkillConfig | null): void {
    if (current) {
      this.portInput.value = String(current.port);
      this.tokenInput.value = current.token;
    }
    this.root.showModal();
  }
}
