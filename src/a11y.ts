// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run terminal; dual-licensed - see LICENSE.md.

// Phase-4 accessibility mirror. The WebGPU/2D canvas is opaque to assistive
// tech, so we keep a visually-hidden text mirror of the screen beside it:
//  - a focusable <pre role="textbox"> holding the whole current viewport, and
//  - an aria-live region that announces only newly-revealed bottom lines, so
//    streaming command output is read out without re-reading the whole screen.
// Driven from the same TermSnapshot the renderer consumes.

import type { TermSnapshot } from "@container/nanovm.mjs";

const HIDE =
  "position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;" +
  "clip:rect(0 0 0 0);white-space:pre;border:0;";

export class A11yMirror {
  private screenEl: HTMLPreElement;
  private liveEl: HTMLElement;
  private prev: string[] = [];
  private lastAt = 0;

  constructor(parent: HTMLElement) {
    this.screenEl = document.createElement("pre");
    this.screenEl.setAttribute("role", "textbox");
    this.screenEl.setAttribute("aria-multiline", "true");
    this.screenEl.setAttribute("aria-readonly", "true");
    this.screenEl.setAttribute("aria-label", "Terminal screen");
    this.screenEl.tabIndex = 0;
    this.screenEl.style.cssText = HIDE;

    this.liveEl = document.createElement("div");
    this.liveEl.setAttribute("role", "log");
    this.liveEl.setAttribute("aria-live", "polite");
    this.liveEl.style.cssText = HIDE;

    parent.append(this.screenEl, this.liveEl);
  }

  /** Refresh from a snapshot. Throttled — screen readers don't need 60 Hz. */
  update(snap: TermSnapshot, now: number): void {
    if (now - this.lastAt < 250) return;
    this.lastAt = now;

    const text = rowsToText(snap);
    const joined = text.join("\n");
    if (joined === this.prev.join("\n")) return;

    this.screenEl.textContent = joined;

    // Announce the divergent tail (streaming output appends at the bottom), but
    // not on the very first frame (which would dump the whole screen).
    if (this.prev.length) {
      let i = 0;
      while (i < text.length && i < this.prev.length && text[i] === this.prev[i]) i++;
      const added = text.slice(i).filter((l) => l.trim());
      if (added.length) {
        const line = document.createElement("div");
        line.textContent = added.join("\n");
        this.liveEl.appendChild(line);
        while (this.liveEl.childElementCount > 40) this.liveEl.firstElementChild!.remove();
      }
    }
    this.prev = text;
  }
}

/** Decode a snapshot's cells into one trimmed string per row. */
function rowsToText(snap: TermSnapshot): string[] {
  const dv = new DataView(snap.cells.buffer, snap.cells.byteOffset, snap.cells.byteLength);
  const out: string[] = new Array(snap.rows);
  for (let r = 0; r < snap.rows; r++) {
    let s = "";
    for (let c = 0; c < snap.cols; c++) {
      const ch = dv.getUint32((r * snap.cols + c) * 8, true);
      s += ch && ch !== 0x20 ? String.fromCodePoint(ch) : " ";
    }
    out[r] = s.replace(/\s+$/, "");
  }
  return out;
}
