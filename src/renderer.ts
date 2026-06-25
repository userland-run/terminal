// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run terminal; dual-licensed - see LICENSE.md.

import { THEME, ansiColor } from "./palette";
import type { TermSnapshot } from "@container/nanovm.mjs";

/**
 * The contract shared by every renderer backend (throwaway 2D canvas, WebGPU).
 * `main.ts` is written against this so it can pick a backend at runtime and
 * fall back gracefully when WebGPU is unavailable.
 */
export interface TermRenderer {
  /** Cell metrics in CSS px — used to size the grid / compute cols×rows. */
  readonly cellW: number;
  readonly cellH: number;
  /** Re-measure cell metrics against the current font (call after font load). */
  measure(): void;
  /** Change the font size (px) and re-measure. */
  setFontSize(px: number): void;
  /** Resize the backing surface to a cols×rows grid. */
  resize(cols: number, rows: number): void;
  /** Paint one frame from a terminal snapshot; `cursorOn` is the blink phase. */
  draw(s: TermSnapshot, cursorOn: boolean): void;
  /** Set (or clear) the drag-selection highlight. Optional per backend. */
  setSelection?(sel: import("./selection").Selection | null): void;
  /** Release GPU/native resources, if any. */
  destroy?(): void;
}

// Cell flag bits — must match src/term.rs in the nano repo.
const FLAG_BOLD = 1 << 0;
const FLAG_DIM = 1 << 1;
const FLAG_ITALIC = 1 << 2;
const FLAG_UNDERLINE = 1 << 3;
const FLAG_INVERSE = 1 << 4;
const FLAG_FG_DEFAULT = 1 << 5;
const FLAG_BG_DEFAULT = 1 << 6;

/**
 * Throwaway Phase-0 renderer: paints the cell grid to a 2D canvas. Replaced by
 * the Vello/WebGPU renderer in Phase 2 — kept deliberately simple (full redraw
 * per frame; the grid is tiny).
 */
export class CanvasRenderer implements TermRenderer {
  private ctx: CanvasRenderingContext2D;
  cellW = 0;
  cellH = 0;
  private dpr = Math.max(1, window.devicePixelRatio || 1);

  constructor(private canvas: HTMLCanvasElement, private fontSize = 15) {
    this.ctx = canvas.getContext("2d")!;
    this.measure();
  }

  /** Measure monospace cell metrics for the current font size. */
  measure() {
    this.ctx.font = `${this.fontSize}px ${THEME.font}`;
    this.cellW = Math.max(1, Math.round(this.ctx.measureText("M").width));
    this.cellH = Math.round(this.fontSize * 1.4);
  }

  setFontSize(px: number) {
    this.fontSize = px;
    this.measure();
  }

  resize(cols: number, rows: number) {
    const w = cols * this.cellW;
    const h = rows * this.cellH;
    this.canvas.width = Math.floor(w * this.dpr);
    this.canvas.height = Math.floor(h * this.dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.measure();
  }

  draw(s: TermSnapshot, cursorOn: boolean) {
    const ctx = this.ctx;
    const dv = new DataView(s.cells.buffer, s.cells.byteOffset, s.cells.byteLength);
    ctx.textBaseline = "top";

    ctx.fillStyle = THEME.bg;
    ctx.fillRect(0, 0, s.cols * this.cellW, s.rows * this.cellH);

    const glyphY = (this.cellH - this.fontSize) / 2;
    for (let r = 0; r < s.rows; r++) {
      for (let c = 0; c < s.cols; c++) {
        const o = (r * s.cols + c) * 8;
        const ch = dv.getUint32(o, true);
        const fg = dv.getUint8(o + 4);
        const bg = dv.getUint8(o + 5);
        const flags = dv.getUint8(o + 6);

        let fgCol = flags & FLAG_FG_DEFAULT ? THEME.fg : ansiColor(fg);
        let bgCol: string | null = flags & FLAG_BG_DEFAULT ? null : ansiColor(bg);
        if (flags & FLAG_INVERSE) {
          const t = bgCol ?? THEME.bg;
          bgCol = fgCol;
          fgCol = t;
        }

        const x = c * this.cellW;
        const y = r * this.cellH;
        if (bgCol) {
          ctx.fillStyle = bgCol;
          ctx.fillRect(x, y, this.cellW, this.cellH);
        }
        if (ch && ch !== 0x20) {
          const weight = flags & FLAG_BOLD ? "700" : "400";
          const italic = flags & FLAG_ITALIC ? "italic " : "";
          ctx.font = `${italic}${weight} ${this.fontSize}px ${THEME.font}`;
          ctx.fillStyle = fgCol;
          ctx.globalAlpha = flags & FLAG_DIM ? 0.6 : 1;
          ctx.fillText(String.fromCodePoint(ch), x, y + glyphY);
          ctx.globalAlpha = 1;
          if (flags & FLAG_UNDERLINE) ctx.fillRect(x, y + this.cellH - 2, this.cellW, 1);
        }
      }
    }

    if (cursorOn) {
      const x = s.cursorCol * this.cellW;
      const y = s.cursorRow * this.cellH;
      ctx.fillStyle = THEME.cursor;
      ctx.globalAlpha = 0.85;
      ctx.fillRect(x, y, this.cellW, this.cellH);
      ctx.globalAlpha = 1;
      const o = (s.cursorRow * s.cols + s.cursorCol) * 8;
      const ch = dv.getUint32(o, true);
      if (ch && ch !== 0x20) {
        ctx.fillStyle = THEME.bg;
        ctx.font = `${this.fontSize}px ${THEME.font}`;
        ctx.fillText(String.fromCodePoint(ch), x, y + glyphY);
      }
    }
  }
}
