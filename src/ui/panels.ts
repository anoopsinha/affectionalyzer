import { el } from './svg';

/**
 * View controls: what stays on screen.
 *
 * Every panel is hideable, including the mood index and the affect circumplex.
 * Focus is a preset rather than a bulk hide — it shows those two and puts the
 * rest away, without disturbing the stored per-panel choices, so leaving focus
 * returns you to exactly the view you had.
 */

export interface PanelDef {
  id: string;
  label: string;
  el: HTMLElement;
  /** Which column the panel lives in; empty columns are removed from the grid. */
  column: 'primary' | 'secondary';
  /** Shown by Focus. */
  focus?: boolean;
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
        hidden: Array.isArray(parsed.hidden)
          ? parsed.hidden.filter((h) => typeof h === 'string')
          : [],
      };
    }
  } catch {
    /* corrupt entry — fall back to showing everything */
  }
  return { focus: false, hidden: [] };
}

export interface PanelColumns {
  primary: HTMLElement;
  secondary: HTMLElement;
}

export class PanelControls {
  private state: ViewState;
  private focusBtn: HTMLButtonElement;
  private menu: HTMLDetailsElement;
  private menuSummary: HTMLElement;
  private checkboxes = new Map<string, HTMLInputElement>();
  private emptyState: HTMLElement;

  constructor(
    mount: HTMLElement,
    private layout: HTMLElement,
    private columns: PanelColumns,
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

    let lastColumn: string | null = null;
    for (const p of this.panels) {
      // A rule between the two columns keeps "the focus pair" visually distinct
      // from the supporting panels without needing a second heading.
      if (lastColumn !== null && p.column !== lastColumn) {
        el('div', 'panel-menu-divider', list);
      }
      lastColumn = p.column;

      const row = el('label', 'panel-menu-row', list);
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.addEventListener('change', () => {
        const hidden = new Set(this.state.hidden);
        if (box.checked) hidden.delete(p.id);
        else hidden.add(p.id);
        this.state.hidden = [...hidden];
        // Unchecking something by hand is an explicit choice about the current
        // view, so it drops focus rather than being silently overridden by it.
        this.state.focus = false;
        this.persist();
        this.apply();
      });
      row.appendChild(box);
      const text = document.createElement('span');
      text.textContent = p.label;
      row.appendChild(text);
      this.checkboxes.set(p.id, box);
    }

    const actions = el('div', 'panel-menu-actions', list);

    const showAll = el('button', 'panel-menu-action', actions);
    showAll.type = 'button';
    showAll.textContent = 'Show all';
    showAll.addEventListener('click', () => {
      this.state = { focus: false, hidden: [] };
      this.persist();
      this.apply();
    });

    const hideAll = el('button', 'panel-menu-action', actions);
    hideAll.type = 'button';
    hideAll.textContent = 'Hide all';
    hideAll.addEventListener('click', () => {
      this.state = { focus: false, hidden: this.panels.map((p) => p.id) };
      this.persist();
      this.apply();
    });

    // Something has to remain on screen to get back from an empty view, so the
    // empty state carries its own restore control.
    this.emptyState = el('div', 'empty-state', this.layout);
    this.emptyState.innerHTML = `<p>Every panel is hidden.</p>`;
    const restore = el('button', 'btn', this.emptyState);
    restore.type = 'button';
    restore.textContent = 'Show all panels';
    restore.addEventListener('click', () => {
      this.state = { focus: false, hidden: [] };
      this.persist();
      this.apply();
    });

    document.addEventListener('click', (ev) => {
      if (this.menu.open && !this.menu.contains(ev.target as Node)) this.menu.open = false;
    });

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
      // Focus shows its pair even if they are individually hidden — otherwise
      // "show only these two" could resolve to showing nothing at all.
      const visible = focus ? p.focus === true : !hidden.has(p.id);
      p.el.hidden = !visible;

      const box = this.checkboxes.get(p.id);
      if (box) {
        box.checked = !hidden.has(p.id);
        box.disabled = focus;
      }
    }

    const shown = (column: 'primary' | 'secondary') =>
      this.panels.some((p) => p.column === column && !p.el.hidden);

    const primaryVisible = shown('primary');
    const secondaryVisible = shown('secondary');

    this.columns.primary.hidden = !primaryVisible;
    this.columns.secondary.hidden = !secondaryVisible;

    // One populated column centres; two keep the split grid. Which column is
    // solo matters for width — the circumplex wants a narrow measure, the trend
    // chart a wide one.
    this.layout.classList.toggle('is-solo', primaryVisible !== secondaryVisible);
    this.layout.classList.toggle('is-solo-primary', primaryVisible && !secondaryVisible);
    this.layout.classList.toggle('is-solo-secondary', secondaryVisible && !primaryVisible);
    this.layout.classList.toggle('is-empty', !primaryVisible && !secondaryVisible);
    this.emptyState.hidden = primaryVisible || secondaryVisible;

    this.focusBtn.textContent = focus ? 'Exit focus' : 'Focus';
    this.focusBtn.setAttribute('aria-pressed', String(focus));
    this.focusBtn.title = focus ? 'Show all panels (f)' : 'Show only mood and affect position (f)';
    this.menuSummary.classList.toggle('is-disabled', focus);
    if (focus) this.menu.open = false;

    const visibleCount = this.panels.filter((p) => !p.el.hidden).length;
    this.menuSummary.textContent =
      visibleCount === this.panels.length ? 'Panels' : `Panels · ${visibleCount}/${this.panels.length}`;

    this.onLayoutChange();
  }
}
