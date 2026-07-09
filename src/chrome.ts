// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run terminal; dual-licensed - see LICENSE.md.

// Thin controller for the surrounding chrome (top bar, sidebar, footer stats,
// settings popover). Keeps DOM lookups in one place so main.ts deals in
// semantic calls. Layout + tokens follow style-guide/terminal/Userland
// Terminal.dc.html.

import { byId, qs, qsa, domRoot } from "./dom";

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = byId<T>(id);
  if (!node) throw new Error(`missing #${id}`);
  return node;
}

export interface ChromeActions {
  onClear: () => void;
  onRestart: () => void;
  onPalette: () => void;
}

export class Chrome {
  private statGrid = el("stat-grid");
  private statCursor = el("stat-cursor");
  private statStatus = el("stat-status");
  private statUptime = el("stat-uptime");
  private statIps = el("stat-ips");
  private statPort = el("stat-port");
  private statPortSep = el("stat-port-sep");
  private statAsst = el("stat-asst");
  private statAsstSep = el("stat-asst-sep");
  private statAsstModel = el("stat-asst-model");
  private statAsstTps = el("stat-asst-tps");
  private statCwd = el("stat-cwd");
  private sessionState = el("session-state");
  private cwd = el("cwd");
  private settings = el("settings-popover");

  private activeView: string | null = null;
  private readonly enabledViews = new Set<string>(["files", "catalog", "sessions"]);

  constructor() {
    // VS Code-style activity bar: each icon switches the single active view.
    for (const btn of qsa<HTMLElement>(".activity-btn")) {
      btn.addEventListener("click", () => {
        const v = btn.dataset.view;
        if (v) this.showView(v);
      });
    }
    // Dismiss the settings popover on outside click / Escape. Listen on the
    // scoped root: under shadow DOM, document-level events are retargeted to the
    // host, so `e.target` would never be the real (in-shadow) popover/button.
    domRoot().addEventListener("mousedown", (e) => {
      if (this.settings.hidden) return;
      const t = (e as MouseEvent).target as Node;
      if (!this.settings.contains(t) && !el("act-settings").contains(t)) this.hideSettings();
    });
    domRoot().addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key === "Escape" && !this.settings.hidden) this.hideSettings();
    });
  }

  setGrid(cols: number, rows: number) {
    this.statGrid.textContent = `${cols}×${rows}`;
  }
  setCursor(row: number, col: number) {
    this.statCursor.textContent = `ln ${row + 1}:${col + 1}`;
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
  /** Footer assistant readout while generating: model + tok/s, or null to hide. */
  setAssistantStat(info: { model: string; toksPerSec: number } | null) {
    const on = info != null;
    this.statAsst.hidden = !on;
    this.statAsstSep.hidden = !on;
    if (on) {
      this.statAsstModel.textContent = info.model;
      this.statAsstTps.textContent = info.toksPerSec.toFixed(1);
    }
  }
  setSession(text: string) {
    this.sessionState.textContent = text;
  }
  setCwd(path: string) {
    this.cwd.textContent = path;
    this.statCwd.textContent = path;
  }

  /** Show one sidebar view (Files / Catalog / Sessions); hide the rest. */
  showView(view: string) {
    if (!this.enabledViews.has(view)) return;
    this.activeView = view;
    for (const p of qsa<HTMLElement>(".sidebar-views .panel")) {
      p.classList.toggle("active", p.dataset.view === view);
    }
    for (const b of qsa<HTMLElement>(".activity-btn")) {
      const on = b.dataset.view === view;
      b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", String(on));
    }
  }

  /** Enable/disable a view (its activity-bar icon + panel) for feature gating. */
  setViewEnabled(view: string, enabled: boolean) {
    if (enabled) this.enabledViews.add(view);
    else this.enabledViews.delete(view);
    const btn = qs<HTMLElement>(`.activity-btn[data-view="${view}"]`);
    if (btn) btn.style.display = enabled ? "" : "none";
    if (!enabled && this.activeView === view) this.activeView = null;
  }

  /** Activate the first enabled view (Files first, then Catalog, Sessions). */
  activateDefaultView() {
    const first = ["files", "catalog", "sessions"].find((v) => this.enabledViews.has(v));
    if (first) this.showView(first);
  }

  /** Wire the ☰ button; caller may also bind a keyboard shortcut. */
  onSidebarToggle(cb: () => void) {
    el("sidebar-toggle").addEventListener("click", cb);
  }

  /** Wire the top-bar assistant toggle (opens/closes the right pane). */
  onAssistantToggle(cb: () => void) {
    el("assistant-toggle").addEventListener("click", cb);
  }
  /** Wire the assistant pane's close button. */
  onAssistantClose(cb: () => void) {
    el("assistant-close").addEventListener("click", cb);
  }
  /** Reflect the open/closed state on the top-bar toggle. */
  setAssistantPressed(on: boolean) {
    el("assistant-toggle").setAttribute("aria-pressed", String(on));
  }
  /** Hide the assistant toggle entirely (feature disabled). */
  setAssistantEnabled(on: boolean) {
    el("assistant-toggle").style.display = on ? "" : "none";
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
