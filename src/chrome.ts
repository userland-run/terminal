// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run terminal; dual-licensed - see LICENSE.md.

// Thin controller for the surrounding chrome (top bar, sidebar, footer stats,
// settings popover). Keeps DOM lookups in one place so main.ts deals in
// semantic calls. Layout + tokens follow style-guide/terminal/Userland
// Terminal.dc.html.

import type { DomScope } from "./dom";

export interface ChromeActions {
  onClear: () => void;
  onRestart: () => void;
  onPalette: () => void;
}

export class Chrome {
  private readonly statGrid: HTMLElement;
  private readonly statCursor: HTMLElement;
  private readonly statStatus: HTMLElement;
  private readonly statUptime: HTMLElement;
  private readonly statIps: HTMLElement;
  private readonly statPort: HTMLElement;
  private readonly statPortSep: HTMLElement;
  private readonly statAsst: HTMLElement;
  private readonly statAsstSep: HTMLElement;
  private readonly statAsstModel: HTMLElement;
  private readonly statAsstTps: HTMLElement;
  private readonly statCwd: HTMLElement;
  private readonly sessionState: HTMLElement;
  private readonly cwd: HTMLElement;
  private readonly settings: HTMLElement;

  private baseStatus = "";
  private flashTimer = 0;
  private activeView: string | null = null;
  private readonly enabledViews = new Set<string>(["files", "catalog", "sessions"]);

  constructor(private readonly dom: DomScope) {
    this.statGrid = this.el("stat-grid");
    this.statCursor = this.el("stat-cursor");
    this.statStatus = this.el("stat-status");
    this.statUptime = this.el("stat-uptime");
    this.statIps = this.el("stat-ips");
    this.statPort = this.el("stat-port");
    this.statPortSep = this.el("stat-port-sep");
    this.statAsst = this.el("stat-asst");
    this.statAsstSep = this.el("stat-asst-sep");
    this.statAsstModel = this.el("stat-asst-model");
    this.statAsstTps = this.el("stat-asst-tps");
    this.statCwd = this.el("stat-cwd");
    this.sessionState = this.el("session-state");
    this.cwd = this.el("cwd");
    this.settings = this.el("settings-popover");
    // VS Code-style activity bar: each icon switches the single active view.
    for (const btn of this.dom.qsa<HTMLElement>(".activity-btn")) {
      btn.addEventListener("click", () => {
        const v = btn.dataset.view;
        if (v) this.showView(v);
      });
    }
    // Dismiss the settings popover on outside click / Escape. Listen on the
    // scoped root: under shadow DOM, document-level events are retargeted to the
    // host, so `e.target` would never be the real (in-shadow) popover/button.
    const { signal } = dom;
    dom.root.addEventListener(
      "mousedown",
      (e) => {
        if (this.settings.hidden) return;
        const t = (e as MouseEvent).target as Node;
        if (!this.settings.contains(t) && !this.el("act-settings").contains(t)) this.hideSettings();
      },
      { signal },
    );
    dom.root.addEventListener(
      "keydown",
      (e) => {
        if ((e as KeyboardEvent).key === "Escape" && !this.settings.hidden) this.hideSettings();
      },
      { signal },
    );
  }

  private el<T extends HTMLElement = HTMLElement>(id: string): T {
    const node = this.dom.byId<T>(id);
    if (!node) throw new Error(`missing #${id}`);
    return node;
  }

  setGrid(cols: number, rows: number) {
    this.statGrid.textContent = `${cols}×${rows}`;
  }
  setCursor(row: number, col: number) {
    this.statCursor.textContent = `ln ${row + 1}:${col + 1}`;
  }
  /** Set the persistent footer status ("live", "↑ 3/120", …). A transient
   *  {@link flashStatus} in progress keeps showing until it expires. */
  setStatus(text: string) {
    this.baseStatus = text;
    if (!this.flashTimer) this.statStatus.textContent = text;
  }
  /** Show a short-lived status ("copied", "saved"), then revert to the persistent
   *  one. One timer: a newer flash replaces an older one instead of racing it. */
  flashStatus(text: string, ms = 1400) {
    if (this.flashTimer) clearTimeout(this.flashTimer);
    this.statStatus.textContent = text;
    this.flashTimer = window.setTimeout(() => {
      this.flashTimer = 0;
      this.statStatus.textContent = this.baseStatus;
    }, ms);
  }
  /** Cancel any pending flash timer (teardown). */
  dispose() {
    if (this.flashTimer) clearTimeout(this.flashTimer);
    this.flashTimer = 0;
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
    for (const p of this.dom.qsa<HTMLElement>(".sidebar-views .panel")) {
      p.classList.toggle("active", p.dataset.view === view);
    }
    for (const b of this.dom.qsa<HTMLElement>(".activity-btn")) {
      const on = b.dataset.view === view;
      b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", String(on));
    }
  }

  /** Enable/disable a view (its activity-bar icon + panel) for feature gating. */
  setViewEnabled(view: string, enabled: boolean) {
    if (enabled) this.enabledViews.add(view);
    else this.enabledViews.delete(view);
    const btn = this.dom.qs<HTMLElement>(`.activity-btn[data-view="${view}"]`);
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
    this.el("sidebar-toggle").addEventListener("click", cb);
  }

  /** Wire the top-bar assistant toggle (opens/closes the right pane). */
  onAssistantToggle(cb: () => void) {
    this.el("assistant-toggle").addEventListener("click", cb);
  }
  /** Wire the assistant pane's close button. */
  onAssistantClose(cb: () => void) {
    this.el("assistant-close").addEventListener("click", cb);
  }
  /** Reflect the open/closed state on the top-bar toggle. */
  setAssistantPressed(on: boolean) {
    this.el("assistant-toggle").setAttribute("aria-pressed", String(on));
  }
  /** Hide the assistant toggle entirely (feature disabled). */
  setAssistantEnabled(on: boolean) {
    this.el("assistant-toggle").style.display = on ? "" : "none";
  }

  /** Wire the top-bar ⊘/⟳/⚙ actions and the matching settings-popover rows. */
  bindActions(a: ChromeActions) {
    this.el("act-clear").addEventListener("click", a.onClear);
    this.el("act-restart").addEventListener("click", a.onRestart);
    this.el("act-settings").addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggleSettings();
    });
    const row = (id: string, cb: () => void) =>
      this.el(id).addEventListener("click", () => {
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
