import { el } from './svg';

/**
 * View controls: what stays on screen.
 *
 * Every panel is hideable, including the mood index and the affect circumplex.
 *
 * Focus does one thing: it puts the supporting panels away. The focus pair still
 * follows its own checkboxes, so focus never resurrects something you chose to
 * hide. Leaving focus is the reset — it brings everything back.
 */

export interface PanelDef {
  id: string;
  label: string;
  el: HTMLElement;
  /** Which column the panel lives in; empty columns are removed from the grid. */
  column: 'primary' | 'secondary';
  /**
   * Spans both columns instead of sitting inside one. Such a panel is still
   * toggleable, but must not count toward whether a column is empty — the
   * columns collapse when nothing is left in *them*, and a full-width row above
   * would otherwise hold an empty column open.
   */
  spans?: boolean;
  /** Shown by Focus. */
  focus?: boolean;
  /**
   * Opt-in: never shown unless its own checkbox is ticked.
   *
   * Not merely "hidden on a first visit" — that was not enough. Both leaving
   * focus and "Show all" cleared the hidden set outright, so a single press of
   * Focus permanently resurrected every panel the default view had deliberately
   * left out. These stay out of the running view until asked for, and the
   * restore paths below skip them.
   *
   * The storyboard's view does not include the mood hero, the synchrony panel,
   * the table or the band-strength readouts, but deleting them would throw away
   * the only non-visual route to the numbers and the whole surrogate-tested
   * coupling readout.
   */
  optIn?: boolean;
}

interface ViewState {
  focus: boolean;
  hidden: string[];
}

/*
 * Versioned. The storyboard rebuild changed which panels exist, what they are
 * called and which column they live in, so a choice saved against the old set
 * says nothing useful about the new one — and silently reinstating it would
 * bring the mood hero and table view back into a layout designed without them.
 */
const STORAGE_KEY = 'affectionalyzer.view.v4';

function loadState(panels: PanelDef[]): ViewState {
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
  return { focus: false, hidden: defaultHidden(panels) };
}

/** The panels a default view leaves out — every opt-in one. */
function defaultHidden(panels: PanelDef[]): string[] {
  return panels.filter((p) => p.optIn).map((p) => p.id);
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
    this.state = loadState(panels);

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
        // Focus stays on: the focus pair honours these checkboxes, so toggling
        // one while focused is an adjustment within focus, not an exit from it.
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
    // "Reset view", not "Show all": it restores the default layout, which
    // deliberately excludes the opt-in panels. A button labelled "Show all" that
    // skipped four panels would be lying about what it does.
    showAll.textContent = 'Reset view';
    showAll.addEventListener('click', () => {
      this.state = { focus: false, hidden: defaultHidden(this.panels) };
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
    // Leaving focus is the way back to the default dashboard, so it clears the
    // per-panel choices rather than dropping you into a partial view — but back
    // to the *default*, not to everything. Clearing outright used to resurrect
    // the opt-in panels, so one press of Focus undid the layout permanently.
    if (!focus) this.state.hidden = defaultHidden(this.panels);
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
      // Focus only suppresses the supporting panels. The focus pair keeps
      // following its own checkbox, so focus never re-shows something hidden.
      const suppressed = focus && p.focus !== true;
      p.el.hidden = suppressed || hidden.has(p.id);

      const box = this.checkboxes.get(p.id);
      if (box) {
        box.checked = !hidden.has(p.id);
        // A supporting panel's checkbox does nothing while focus is on, so it
        // reads as unavailable rather than silently ignored.
        box.disabled = suppressed;
      }
    }

    const shown = (column: 'primary' | 'secondary') =>
      this.panels.some((p) => !p.spans && p.column === column && !p.el.hidden);

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
    this.focusBtn.title = focus
      ? 'Show all panels (f)'
      : 'Put the supporting panels away (f)';
    // The menu stays usable in focus — the focus pair is still toggleable there.
    this.menuSummary.classList.remove('is-disabled');

    const visibleCount = this.panels.filter((p) => !p.el.hidden).length;
    this.menuSummary.textContent =
      visibleCount === this.panels.length ? 'Panels' : `Panels · ${visibleCount}/${this.panels.length}`;

    this.onLayoutChange();
  }
}
