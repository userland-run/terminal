// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run terminal; dual-licensed - see LICENSE.md.

// Thin controller for the surrounding chrome (top bar, sidebar, footer stats).
// Keeps DOM lookups in one place so main.ts deals in semantic calls.

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
}

export class Chrome {
  private app = el("app");
  private statGrid = el("stat-grid");
  private statCursor = el("stat-cursor");
  private statRenderer = el("stat-renderer");
  private statStatus = el("stat-status");
  private sessionState = el("session-state");
  private cwd = el("cwd");

  setGrid(cols: number, rows: number) {
    this.statGrid.textContent = `${cols}×${rows}`;
  }
  setCursor(row: number, col: number) {
    this.statCursor.textContent = `ln ${row + 1} · col ${col + 1}`;
  }
  setRenderer(name: string) {
    this.statRenderer.textContent = name;
  }
  setStatus(text: string) {
    this.statStatus.textContent = text;
  }
  setSession(text: string) {
    this.sessionState.textContent = text;
  }
  setCwd(path: string) {
    this.cwd.textContent = path;
  }

  toggleSidebar() {
    this.app.classList.toggle("sidebar-collapsed");
  }

  /** Wire the ☰ button; returns nothing — caller may also bind a shortcut. */
  onSidebarToggle(cb: () => void) {
    el("sidebar-toggle").addEventListener("click", cb);
  }
}
