// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run terminal; dual-licensed - see LICENSE.md.

import type { TermSnapshot } from "@container/nanovm.mjs";
import { cellView, rowText } from "./cells";

export interface CellPos {
  row: number;
  col: number;
}
/** A drag selection: `anchor` is where the drag began, `head` follows the mouse. */
export interface Selection {
  anchor: CellPos;
  head: CellPos;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Map a mouse event to a grid cell using CSS-px cell metrics. */
export function pixelToCell(
  e: MouseEvent,
  canvas: HTMLCanvasElement,
  cellW: number,
  cellH: number,
  cols: number,
  rows: number
): CellPos {
  const r = canvas.getBoundingClientRect();
  return {
    col: clamp(Math.floor((e.clientX - r.left) / cellW), 0, cols - 1),
    row: clamp(Math.floor((e.clientY - r.top) / cellH), 0, rows - 1),
  };
}

export function isEmptySelection(sel: Selection): boolean {
  return sel.anchor.row === sel.head.row && sel.anchor.col === sel.head.col;
}

/** Order two endpoints into (start, end) in reading order. */
export function ordered(sel: Selection): { start: CellPos; end: CellPos } {
  const { anchor, head } = sel;
  const headFirst = head.row < anchor.row || (head.row === anchor.row && head.col < anchor.col);
  return headFirst ? { start: head, end: anchor } : { start: anchor, end: head };
}

/**
 * Extract the selected text in reading order (stream selection): full rows
 * between the endpoints, trailing whitespace trimmed per line, newline-joined.
 * `end` is inclusive.
 */
export function extractText(snap: TermSnapshot, sel: Selection): string {
  const { start, end } = ordered(sel);
  const dv = cellView(snap);
  const lines: string[] = [];
  for (let row = start.row; row <= end.row; row++) {
    const cStart = row === start.row ? start.col : 0;
    const cEnd = row === end.row ? end.col : snap.cols - 1;
    lines.push(rowText(snap, row, cStart, cEnd, dv));
  }
  return lines.join("\n");
}

// --- buffer coordinates ------------------------------------------------------
//
// A drag selection is anchored to *content*, not to the screen: while the user
// scrolls (or output scrolls the screen) mid-drag, the anchor must stay on the
// line it was placed on. Buffer rows count from the oldest scrollback line:
//   bufferRow = viewportRow - scrollOffset + scrollMax
// (scrollMax = scrollback depth). Once the scrollback ring is full, evictions no
// longer grow scrollMax, so very long-running output can still drift a selection
// — acceptable for a drag gesture.

/** Viewport cell → buffer cell, given the snapshot's scroll position. */
export function toBuffer(p: CellPos, scrollOffset: number, scrollMax: number): CellPos {
  return { row: p.row - scrollOffset + scrollMax, col: p.col };
}

/**
 * Project a buffer-coordinate selection onto the current viewport (clipped to
 * the visible rows), or null if none of it is visible.
 */
export function toViewport(
  sel: Selection,
  scrollOffset: number,
  scrollMax: number,
  rows: number,
  cols: number,
): Selection | null {
  const { start, end } = ordered(sel);
  const shift = scrollOffset - scrollMax;
  let s = { row: start.row + shift, col: start.col };
  let e = { row: end.row + shift, col: end.col };
  if (e.row < 0 || s.row > rows - 1) return null;
  if (s.row < 0) s = { row: 0, col: 0 };
  if (e.row > rows - 1) e = { row: rows - 1, col: cols - 1 };
  return { anchor: s, head: e };
}
