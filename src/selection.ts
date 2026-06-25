// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run terminal; dual-licensed - see LICENSE.md.

import type { TermSnapshot } from "@container/nanovm.mjs";

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
  const dv = new DataView(snap.cells.buffer, snap.cells.byteOffset, snap.cells.byteLength);
  const lines: string[] = [];
  for (let row = start.row; row <= end.row; row++) {
    const cStart = row === start.row ? start.col : 0;
    const cEnd = row === end.row ? end.col : snap.cols - 1;
    let line = "";
    for (let col = cStart; col <= cEnd; col++) {
      const ch = dv.getUint32((row * snap.cols + col) * 8, true);
      line += ch && ch !== 0x20 ? String.fromCodePoint(ch) : " ";
    }
    lines.push(line.replace(/\s+$/, ""));
  }
  return lines.join("\n");
}
