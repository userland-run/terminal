// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run terminal; dual-licensed - see LICENSE.md.

import { THEME, ansiColor } from "./palette";
import type { TermSnapshot } from "@container/nanovm.mjs";
import { ordered, type Selection } from "./selection";
import {
  CELL_BYTES,
  CELL_BG,
  CELL_FG,
  CELL_FLAGS,
  FLAG_BG_DEFAULT,
  FLAG_BOLD,
  FLAG_DIM,
  FLAG_FG_DEFAULT,
  FLAG_INVERSE,
  FLAG_ITALIC,
  FLAG_UNDERLINE,
  cellCodepoint,
  cellView,
  isInk,
} from "./cells";

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
  setSelection?(sel: Selection | null): void;
  /** Release GPU/native resources, if any. */
  destroy?(): void;
}

/**
 * Call `onChange` whenever window.devicePixelRatio changes (browser zoom, or the
 * window moving to a monitor with a different scale). A `resolution` media query
 * only fires when leaving *its* value, so it's re-armed for the new DPR each time.
 * Returns an unsubscribe.
 */
export function watchDevicePixelRatio(onChange: (dpr: number) => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  let mq: MediaQueryList | null = null;
  const handler = () => {
    arm();
    onChange(currentDpr());
  };
  const arm = () => {
    mq?.removeEventListener("change", handler);
    mq = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    mq.addEventListener("change", handler);
  };
  arm();
  return () => mq?.removeEventListener("change", handler);
}

/** The device pixel ratio, floored at 1. */
export function currentDpr(): number {
  return Math.max(1, window.devicePixelRatio || 1);
}

/**
 * Throwaway Phase-0 renderer: paints the cell grid to a 2D canvas. Replaced by
 * the Vello/WebGPU renderer in Phase 2 — kept deliberately simple (full redraw
 * per frame; the grid is tiny).
 */
export class CanvasRenderer implements TermRenderer {
  private ctx: CanvasRenderingContext2D;
  cellW = 0;
  cellH = 0;
  private dpr = currentDpr();
  private cols = 0;
  private rows = 0;
  private selection: Selection | null = null;
  private readonly unwatchDpr: () => void;

  constructor(private canvas: HTMLCanvasElement, private fontSize = 15) {
    this.ctx = canvas.getContext("2d")!;
    this.measure();
    // Re-rasterise at the new DPR on zoom / monitor change (else it goes blurry).
    this.unwatchDpr = watchDevicePixelRatio((dpr) => {
      this.dpr = dpr;
      if (this.cols && this.rows) this.resize(this.cols, this.rows);
    });
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

  setSelection(sel: Selection | null) {
    this.selection = sel; // full redraw every frame — picked up on the next draw
  }

  resize(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
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
    const cells = s.cells;
    const dv = cellView(s);
    ctx.textBaseline = "top";

    ctx.fillStyle = THEME.bg;
    ctx.fillRect(0, 0, s.cols * this.cellW, s.rows * this.cellH);

    // Selection highlight replaces the selected cells' background; glyphs still
    // draw on top, so selected text stays readable.
    const selRows = this.selectionRows(s.cols, s.rows);

    const glyphY = (this.cellH - this.fontSize) / 2;
    for (let r = 0; r < s.rows; r++) {
      for (let c = 0; c < s.cols; c++) {
        const o = (r * s.cols + c) * CELL_BYTES;
        const ch = cellCodepoint(dv, r * s.cols + c);
        const fg = cells[o + CELL_FG];
        const bg = cells[o + CELL_BG];
        const flags = cells[o + CELL_FLAGS];

        let fgCol = flags & FLAG_FG_DEFAULT ? THEME.fg : ansiColor(fg);
        let bgCol: string | null = flags & FLAG_BG_DEFAULT ? null : ansiColor(bg);
        if (flags & FLAG_INVERSE) {
          const t = bgCol ?? THEME.bg;
          bgCol = fgCol;
          fgCol = t;
        }
        const sel = selRows[r];
        if (sel && c >= sel[0] && c <= sel[1]) bgCol = THEME.selection;

        const x = c * this.cellW;
        const y = r * this.cellH;
        if (bgCol) {
          ctx.fillStyle = bgCol;
          ctx.fillRect(x, y, this.cellW, this.cellH);
        }
        if (isInk(ch)) {
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

    if (cursorOn && s.cursorRow >= 0) {
      const x = s.cursorCol * this.cellW;
      const y = s.cursorRow * this.cellH;
      ctx.fillStyle = THEME.cursor;
      ctx.globalAlpha = 0.85;
      ctx.fillRect(x, y, this.cellW, this.cellH);
      ctx.globalAlpha = 1;
      const ch = cellCodepoint(dv, s.cursorRow * s.cols + s.cursorCol);
      if (isInk(ch)) {
        ctx.fillStyle = THEME.bg;
        ctx.font = `${this.fontSize}px ${THEME.font}`;
        ctx.fillText(String.fromCodePoint(ch), x, y + glyphY);
      }
    }
  }

  /** Per-row [startCol, endCol] of the selection (inclusive), or undefined. */
  private selectionRows(cols: number, rows: number): ([number, number] | undefined)[] {
    const out: ([number, number] | undefined)[] = new Array(rows);
    if (!this.selection) return out;
    const { start, end } = ordered(this.selection);
    for (let row = Math.max(0, start.row); row <= Math.min(rows - 1, end.row); row++) {
      out[row] = [row === start.row ? start.col : 0, row === end.row ? end.col : cols - 1];
    }
    return out;
  }

  destroy() {
    this.unwatchDpr();
  }
}
