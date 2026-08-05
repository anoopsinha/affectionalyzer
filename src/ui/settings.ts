import type { NeuroSkillConfig } from '../neuroskill/client';
import type { SourceId } from '../neuroskill/config';
import { bootstrapConfig, clearOverride, isSameEndpoint, saveOverride } from '../neuroskill/config';
import { el } from './svg';

/**
 * Manual connection entry for both subjects.
 *
 * The dev server injects the local daemon's port and token automatically. It
 * cannot do the same for the partner: skill-daemon binds to loopback only, so
 * the second machine is reached through an SSH tunnel and its token lives on
 * that machine. This panel is where that port and token are entered when they
 * are not supplied via `AFFECT_PARTNER_TOKEN`.
 */

type ApplyFn = (source: SourceId, config: NeuroSkillConfig | null) => void;

interface Section {
  portInput: HTMLInputElement;
  tokenInput: HTMLInputElement;
}

export class SettingsPanel {
  readonly root: HTMLDialogElement;
  private sections: Record<SourceId, Section>;
  private warning: HTMLElement;
  private onApply: ApplyFn;

  constructor(container: HTMLElement, onApply: ApplyFn) {
    this.onApply = onApply;

    this.root = document.createElement('dialog');
    this.root.className = 'settings';
    container.appendChild(this.root);

    const form = el('form', 'settings-form', this.root);
    form.setAttribute('method', 'dialog');

    const h = el('h2', undefined, form);
    h.textContent = 'Daemon connections';

    this.sections = {
      self: this.addSection(
        form,
        'self',
        'You',
        'Auto-detected from the daemon running on this machine.',
      ),
      partner: this.addSection(
        form,
        'partner',
        'Partner',
        'A daemon on a second machine, reached through an SSH tunnel — the daemon ' +
          'binds to loopback only, so it cannot be addressed over the network directly. ' +
          'Run <code>ssh -N -L 18454:127.0.0.1:18444 user@host</code>, then enter 18454 ' +
          'and that machine’s token.',
      ),
    };

    this.warning = el('p', 'settings-warning', form);
    this.warning.hidden = true;
    this.warning.setAttribute('role', 'alert');

    const row = el('div', 'settings-actions', form);

    const cancel = el('button', 'btn btn-quiet', row);
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => this.root.close());

    const apply = el('button', 'btn', row);
    apply.type = 'button';
    apply.textContent = 'Connect';
    apply.addEventListener('click', () => this.apply());
  }

  private addSection(
    form: HTMLElement,
    source: SourceId,
    label: string,
    note: string,
  ): Section {
    const wrap = el('fieldset', 'settings-section', form);
    const legend = el('legend', undefined, wrap);
    legend.textContent = label;

    const noteEl = el('p', 'settings-note', wrap);
    noteEl.innerHTML = note;

    const portLabel = el('label', 'field', wrap);
    portLabel.innerHTML = '<span>Port</span>';
    const portInput = document.createElement('input');
    portInput.type = 'number';
    portInput.min = '1';
    portInput.max = '65535';
    portInput.placeholder = source === 'self' ? '18444' : '18454';
    portLabel.appendChild(portInput);

    const tokenLabel = el('label', 'field', wrap);
    tokenLabel.innerHTML = '<span>Token</span>';
    const tokenInput = document.createElement('input');
    tokenInput.type = 'password';
    tokenInput.autocomplete = 'off';
    tokenInput.placeholder = 'Bearer token';
    tokenLabel.appendChild(tokenInput);

    const hint = el('p', 'settings-hint', wrap);
    hint.innerHTML =
      source === 'self'
        ? 'Default token: <code>~/Library/Application Support/skill/daemon/auth.token</code>'
        : 'The same path <em>on the partner’s machine</em>.';

    const actions = el('div', 'settings-section-actions', wrap);

    const auto = el('button', 'btn btn-quiet btn-small', actions);
    auto.type = 'button';
    auto.textContent = 'Use auto-detected';
    auto.addEventListener('click', () => {
      clearOverride(source);
      const boot = bootstrapConfig(source);
      portInput.value = boot ? String(boot.port) : '';
      tokenInput.value = boot?.token ?? '';
      this.checkCollision();
    });

    const clear = el('button', 'btn btn-quiet btn-small', actions);
    clear.type = 'button';
    clear.textContent = 'Disconnect';
    clear.addEventListener('click', () => {
      portInput.value = '';
      tokenInput.value = '';
      this.checkCollision();
    });

    portInput.addEventListener('input', () => this.checkCollision());

    return { portInput, tokenInput };
  }

  private read(source: SourceId): NeuroSkillConfig | null {
    const { portInput, tokenInput } = this.sections[source];
    const port = Number(portInput.value);
    const token = tokenInput.value.trim();
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !token) return null;
    return { port, token };
  }

  /**
   * Both sources pointing at one daemon would plot a brain against itself and
   * report perfect synchrony — the most misleading state this app can reach, and
   * an easy typo to make. Refuse it rather than render it.
   */
  private checkCollision(): boolean {
    const self = this.read('self');
    const partner = this.read('partner');
    const collides = !!self && !!partner && isSameEndpoint(self, partner);
    this.warning.hidden = !collides;
    if (collides) {
      this.warning.textContent =
        'Both sources point at the same daemon. That would compare one brain with itself and report perfect synchrony — give the partner its tunnelled port instead.';
    }
    return collides;
  }

  private apply(): void {
    if (this.checkCollision()) return;

    for (const source of ['self', 'partner'] as const) {
      const config = this.read(source);
      if (config) {
        saveOverride(source, config);
      } else {
        clearOverride(source);
      }
      this.onApply(source, config);
    }
    this.root.close();
  }

  open(current: Record<SourceId, NeuroSkillConfig | null>): void {
    for (const source of ['self', 'partner'] as const) {
      const config = current[source];
      this.sections[source].portInput.value = config ? String(config.port) : '';
      this.sections[source].tokenInput.value = config?.token ?? '';
    }
    this.checkCollision();
    this.root.showModal();
  }
}
