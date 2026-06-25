// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run terminal; dual-licensed - see LICENSE.md.

// Thin controller for the surrounding chrome (top bar, sidebar, footer stats,
// settings popover). Keeps DOM lookups in one place so main.ts deals in
// semantic calls. Layout + tokens follow style-guide/terminal/Userland
// Terminal.dc.html.

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
}

export interface ChromeActions {
  onClear: () => void;
  onRestart: () => void;
  onPalette: () => void;
}

export class Chrome {
  private app = el("app");
  private statGrid = el("stat-grid");
  private statCursor = el("stat-cursor");
  private statRenderer = el("stat-renderer");
  private statStatus = el("stat-status");
  private statUptime = el("stat-uptime");
  private statCwd = el("stat-cwd");
  private sessionState = el("session-state");
  private cwd = el("cwd");
  private settings = el("settings-popover");

  constructor() {
    // Collapsible sidebar sections (Sessions / Files).
    for (const head of document.querySelectorAll<HTMLElement>(".panel-head")) {
      head.addEventListener("click", () => {
        const id = head.dataset.panel;
        if (id) document.getElementById(id)?.classList.toggle("collapsed");
      });
    }
    // Dismiss the settings popover on outside click / Escape.
    document.addEventListener("mousedown", (e) => {
      if (this.settings.hidden) return;
      const t = e.target as Node;
      if (!this.settings.contains(t) && !el("act-settings").contains(t)) this.hideSettings();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !this.settings.hidden) this.hideSettings();
    });
  }

  setGrid(cols: number, rows: number) {
    this.statGrid.textContent = `${cols}×${rows}`;
  }
  setCursor(row: number, col: number) {
    this.statCursor.textContent = `ln ${row + 1}:${col + 1}`;
  }
  setRenderer(name: string) {
    this.statRenderer.textContent = name;
  }
  setStatus(text: string) {
    this.statStatus.textContent = text;
  }
  setUptime(text: string) {
    this.statUptime.textContent = text;
  }
  setSession(text: string) {
    this.sessionState.textContent = text;
  }
  setCwd(path: string) {
    this.cwd.textContent = path;
    this.statCwd.textContent = path;
  }

  toggleSidebar() {
    this.app.classList.toggle("sidebar-collapsed");
  }

  /** Wire the ☰ button; caller may also bind a keyboard shortcut. */
  onSidebarToggle(cb: () => void) {
    el("sidebar-toggle").addEventListener("click", cb);
  }

  /** Wire the top-bar ⊘/⟳/⚙ actions and the matching settings-popover rows. */
  bindActions(a: ChromeActions) {
    el("act-clear").addEventListener("click", a.onClear);
    el("act-restart").addEventListener("click", a.onRestart);
    el("act-settings").addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggleSettings();
    });
    const row = (id: string, cb: () => void) =>
      el(id).addEventListener("click", () => {
        this.hideSettings();
        cb();
      });
    row("set-clear", a.onClear);
    row("set-restart", a.onRestart);
    row("set-palette", a.onPalette);
  }

  private toggleSettings() {
    this.settings.hidden ? this.showSettings() : this.hideSettings();
  }
  private showSettings() {
    this.settings.hidden = false;
  }
  private hideSettings() {
    this.settings.hidden = true;
  }
}
