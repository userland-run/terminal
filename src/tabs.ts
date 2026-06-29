// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run terminal; dual-licensed - see LICENSE.md.

export type TabName = "terminal" | "editor" | "preview";

export interface TabsOptions {
  /** Called after the active tab changes (e.g. to refit the terminal grid). */
  onSwitch?: (tab: TabName) => void;
  /** Called when a tab's close affordance is clicked. */
  onClose?: (tab: TabName) => void;
}

/**
 * Tab strip over the main pane: Terminal / Editor / Preview share one area, one
 * visible at a time. Editor and Preview tabs stay hidden until {@link reveal}d
 * (so they only appear once their feature has content).
 */
export class Tabs {
  private active: TabName = "terminal";

  constructor(private readonly opts: TabsOptions = {}) {
    for (const btn of document.querySelectorAll<HTMLElement>(".tab")) {
      btn.addEventListener("click", (e) => {
        const closeEl = (e.target as HTMLElement).closest<HTMLElement>(".tab-close");
        if (closeEl) {
          e.stopPropagation();
          const t = closeEl.dataset.close as TabName | undefined;
          if (t) this.opts.onClose?.(t);
          return;
        }
        const t = btn.dataset.tab as TabName | undefined;
        if (t) this.show(t);
      });
    }
  }

  get current(): TabName {
    return this.active;
  }

  /** Activate a tab, showing its pane and hiding the others. */
  show(tab: TabName): void {
    this.active = tab;
    for (const b of document.querySelectorAll<HTMLElement>(".tab")) {
      const on = b.dataset.tab === tab;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", String(on));
    }
    for (const p of document.querySelectorAll<HTMLElement>(".tab-pane")) {
      p.classList.toggle("active", p.dataset.tab === tab);
    }
    this.opts.onSwitch?.(tab);
  }

  /** Un-hide a tab button (Editor/Preview appear on demand). */
  reveal(tab: TabName): void {
    const b = document.querySelector<HTMLElement>(`.tab[data-tab="${tab}"]`);
    if (b) b.hidden = false;
  }

  /** Hide a tab button and fall back to the Terminal tab if it was active. */
  hide(tab: TabName): void {
    const b = document.querySelector<HTMLElement>(`.tab[data-tab="${tab}"]`);
    if (b) b.hidden = true;
    if (this.active === tab) this.show("terminal");
  }

  /** Set the Editor tab's label to the open file's basename. */
  setEditorLabel(text: string): void {
    const label = document.querySelector<HTMLElement>('.tab[data-tab="editor"] .tab-label');
    if (label) label.textContent = text;
  }
}
