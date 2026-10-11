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
import { cellView, rowText } from "./cells";

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

  /** Remove the mirror's nodes (instance teardown). */
  destroy(): void {
    this.screenEl.remove();
    this.liveEl.remove();
  }

  /** Refresh from a snapshot. Throttled — screen readers don't need 60 Hz. */
  update(snap: TermSnapshot, now: number): void {
    if (now - this.lastAt < 250) return;
    this.lastAt = now;

    const text = rowsToText(snap);
    const joined = text.join("\n");
    if (joined === this.prev.join("\n")) return;

    this.screenEl.textContent = joined;

    // Announce only what's new, but not on the very first frame (which would
    // dump the whole screen). Streaming output scrolls the screen up, so the old
    // lines reappear shifted; detect that shift so we don't re-read them.
    if (this.prev.length) {
      const added = newTail(this.prev, text).filter((l) => l.trim());
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

/**
 * Lines of `next` that weren't on screen in `prev`. Finds the smallest upward
 * scroll `k` such that prev[k..] lines up with next[0..] (the last overlapping
 * line may differ — it's typically the cursor line that gained output), then
 * returns next from the first line that differs within that alignment. With no
 * scroll (k = 0) this is the plain divergent tail.
 */
export function newTail(prev: string[], next: string[]): string[] {
  const n = Math.min(prev.length, next.length);
  const nonBlank = next.filter((l) => l.trim()).length;
  for (let k = 0; k < n; k++) {
    const overlap = n - k;
    let ok = true;
    for (let i = 0; i < overlap - 1; i++) {
      if (next[i] !== prev[k + i]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    // A blank (or single-line) alignment is likely coincidence — e.g. a repeated
    // prompt line; require some real content to line up before trusting a shift.
    if (k > 0) {
      const matched = next.slice(0, overlap - 1).filter((l) => l.trim()).length;
      if (matched < Math.min(2, nonBlank)) continue;
    }
    let i = 0;
    while (i < overlap && next[i] === prev[k + i]) i++;
    return next.slice(i);
  }
  // Nothing lines up (clear screen, full-screen app): fall back to the
  // divergent tail.
  let i = 0;
  while (i < n && next[i] === prev[i]) i++;
  return next.slice(i);
}

/** Decode a snapshot's cells into one trimmed string per row. */
export function rowsToText(snap: TermSnapshot): string[] {
  const dv = cellView(snap);
  const out: string[] = new Array(snap.rows);
  for (let r = 0; r < snap.rows; r++) out[r] = rowText(snap, r, 0, snap.cols - 1, dv);
  return out;
}
