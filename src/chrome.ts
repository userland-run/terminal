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
  private statIps = el("stat-ips");
  private statPort = el("stat-port");
  private statPortSep = el("stat-port-sep");
  private statCwd = el("stat-cwd");
  private sessionState = el("session-state");
  private cwd = el("cwd");
  private settings = el("settings-popover");

  private activeView: string | null = null;
  private readonly enabledViews = new Set<string>(["files", "catalog", "sessions"]);

  constructor() {
    // VS Code-style activity bar: each icon switches the single active view.
    for (const btn of document.querySelectorAll<HTMLElement>(".activity-btn")) {
      btn.addEventListener("click", () => {
        const v = btn.dataset.view;
        if (v) this.showView(v);
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
  /** Guest instructions/sec readout (footer), e.g. "96M". */
  setMips(text: string) {
    this.statIps.firstChild!.textContent = text + " ";
  }
  /** Footer serving indicator: pass a label (":8080" / "serving") or null to hide. */
  setServing(label: string | null) {
    const on = label != null;
    this.statPort.hidden = !on;
    this.statPortSep.hidden = !on;
    if (on) this.statPort.textContent = `● ${label}`;
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

  /** Show one sidebar view (Files / Catalog / Sessions); hide the rest. */
  showView(view: string) {
    if (!this.enabledViews.has(view)) return;
    this.activeView = view;
    for (const p of document.querySelectorAll<HTMLElement>(".sidebar-views .panel")) {
      p.classList.toggle("active", p.dataset.view === view);
    }
    for (const b of document.querySelectorAll<HTMLElement>(".activity-btn")) {
      const on = b.dataset.view === view;
      b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", String(on));
    }
  }

  /** Enable/disable a view (its activity-bar icon + panel) for feature gating. */
  setViewEnabled(view: string, enabled: boolean) {
    if (enabled) this.enabledViews.add(view);
    else this.enabledViews.delete(view);
    const btn = document.querySelector<HTMLElement>(`.activity-btn[data-view="${view}"]`);
    if (btn) btn.style.display = enabled ? "" : "none";
    if (!enabled && this.activeView === view) this.activeView = null;
  }

  /** Activate the first enabled view (Files first, then Catalog, then Sessions). */
  activateDefaultView() {
    const first = ["files", "catalog", "sessions"].find((v) => this.enabledViews.has(v));
    if (first) this.showView(first);
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
