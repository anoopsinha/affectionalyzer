import { el } from './svg';

/**
 * View controls: what stays on screen.
 *
 * The mood index and the affect circumplex are the reading and are never
 * hideable — everything else is supporting detail. Focus mode collapses all of
 * it at once and widens what remains; the panel menu hides pieces individually.
 * Focus is a temporary override, so leaving it restores the per-panel choices
 * rather than clearing them.
 */

export interface PanelDef {
  id: string;
  label: string;
  el: HTMLElement;
}

interface ViewState {
  focus: boolean;
  hidden: string[];
}

const STORAGE_KEY = 'affectionalyzer.view';

function loadState(): ViewState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ViewState>;
      return {
        focus: parsed.focus === true,
        hidden: Array.isArray(parsed.hidden) ? parsed.hidden.filter((h) => typeof h === 'string') : [],
      };
    }
  } catch {
    /* corrupt entry — fall back to showing everything */
  }
  return { focus: false, hidden: [] };
}

export class PanelControls {
  private state: ViewState;
  private focusBtn: HTMLButtonElement;
  private menu: HTMLDetailsElement;
  private menuSummary: HTMLElement;
  private checkboxes = new Map<string, HTMLInputElement>();

  constructor(
    mount: HTMLElement,
    private layout: HTMLElement,
    private secondaryCol: HTMLElement,
    private panels: PanelDef[],
    private onLayoutChange: () => void,
  ) {
    this.state = loadState();

    this.focusBtn = el('button', 'btn btn-quiet', mount);
    this.focusBtn.type = 'button';
    this.focusBtn.addEventListener('click', () => this.setFocus(!this.state.focus));

    this.menu = document.createElement('details');
    this.menu.className = 'panel-menu';
    mount.appendChild(this.menu);

    this.menuSummary = document.createElement('summary');
    this.menuSummary.className = 'btn btn-quiet';
    this.menuSummary.textContent = 'Panels';
    this.menu.appendChild(this.menuSummary);

    const list = el('div', 'panel-menu-list', this.menu);
    const hint = el('p', 'panel-menu-hint', list);
    hint.textContent = 'Mood index and affect position always stay.';

    for (const p of panels) {
      const row = el('label', 'panel-menu-row', list);
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.addEventListener('change', () => {
        const hidden = new Set(this.state.hidden);
        if (box.checked) hidden.delete(p.id);
        else hidden.add(p.id);
        this.state.hidden = [...hidden];
        this.persist();
        this.apply();
      });
      row.appendChild(box);
      const text = document.createElement('span');
      text.textContent = p.label;
      row.appendChild(text);
      this.checkboxes.set(p.id, box);
    }

    const showAll = el('button', 'panel-menu-reset', list);
    showAll.type = 'button';
    showAll.textContent = 'Show all';
    showAll.addEventListener('click', () => {
      this.state.hidden = [];
      this.state.focus = false;
      this.persist();
      this.apply();
    });

    // Close the menu on an outside click — a <details> otherwise stays open.
    document.addEventListener('click', (ev) => {
      if (this.menu.open && !this.menu.contains(ev.target as Node)) this.menu.open = false;
    });

    // `f` toggles focus, but not while the user is typing into a field.
    document.addEventListener('keydown', (ev) => {
      if (ev.key !== 'f' && ev.key !== 'F') return;
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
      const t = ev.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      ev.preventDefault();
      this.setFocus(!this.state.focus);
    });

    this.apply();
  }

  private setFocus(focus: boolean): void {
    this.state.focus = focus;
    this.persist();
    this.apply();
  }

  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
    } catch {
      /* private browsing — the view still works, it just won't be remembered */
    }
  }

  private apply(): void {
    const { focus } = this.state;
    const hidden = new Set(this.state.hidden);

    for (const p of this.panels) {
      // Focus hides everything without touching the stored per-panel choices,
      // so leaving focus puts the user back where they were.
      const visible = !focus && !hidden.has(p.id);
      p.el.hidden = !visible;
      const box = this.checkboxes.get(p.id);
      if (box) {
        box.checked = !hidden.has(p.id);
        box.disabled = focus;
      }
    }

    const anyVisible = this.panels.some((p) => !p.el.hidden);
    // With nothing left in the second column, drop to a single centred column
    // rather than leaving a wide empty gutter.
    this.layout.classList.toggle('is-solo', !anyVisible);
    this.secondaryCol.hidden = !anyVisible;

    this.focusBtn.textContent = focus ? 'Exit focus' : 'Focus';
    this.focusBtn.setAttribute('aria-pressed', String(focus));
    this.focusBtn.title = focus ? 'Show all panels (f)' : 'Show only mood and affect position (f)';
    this.menuSummary.classList.toggle('is-disabled', focus);
    if (focus) this.menu.open = false;

    const hiddenCount = this.panels.filter((p) => p.el.hidden).length;
    this.menuSummary.textContent = hiddenCount > 0 ? `Panels · ${this.panels.length - hiddenCount}/${this.panels.length}` : 'Panels';

    this.onLayoutChange();
  }
}
