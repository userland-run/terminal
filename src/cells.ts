// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run terminal; dual-licensed - see LICENSE.md.

// The one place that knows the TermSnapshot cell layout (src/term.rs in the
// nano repo): 8 bytes per cell — u32 LE codepoint, u8 fg, u8 bg, u8 flags, pad.
// Renderers, the a11y mirror, and selection/copy all decode through here.

import type { TermSnapshot } from "@container/nanovm.mjs";

export const CELL_BYTES = 8;
/** Byte offsets within a cell. */
export const CELL_FG = 4;
export const CELL_BG = 5;
export const CELL_FLAGS = 6;

// Cell flag bits — must match src/term.rs.
export const FLAG_BOLD = 1 << 0;
export const FLAG_DIM = 1 << 1;
export const FLAG_ITALIC = 1 << 2;
export const FLAG_UNDERLINE = 1 << 3;
export const FLAG_INVERSE = 1 << 4;
export const FLAG_FG_DEFAULT = 1 << 5;
export const FLAG_BG_DEFAULT = 1 << 6;

/** A DataView over a snapshot's cell bytes (for the u32 codepoint reads). */
export function cellView(snap: TermSnapshot): DataView {
  return new DataView(snap.cells.buffer, snap.cells.byteOffset, snap.cells.byteLength);
}

/** Codepoint of cell `idx` (row * cols + col); 0 = empty. */
export function cellCodepoint(dv: DataView, idx: number): number {
  return dv.getUint32(idx * CELL_BYTES, true);
}

/** True if a codepoint draws something (not empty / space). */
export function isInk(ch: number): boolean {
  return ch !== 0 && ch !== 0x20;
}

/**
 * Text of one row between columns `c0..c1` (inclusive), empty cells as spaces,
 * trailing whitespace trimmed.
 */
export function rowText(snap: TermSnapshot, row: number, c0 = 0, c1 = snap.cols - 1, dv = cellView(snap)): string {
  let s = "";
  for (let c = c0; c <= c1; c++) {
    const ch = cellCodepoint(dv, row * snap.cols + c);
    s += isInk(ch) ? String.fromCodePoint(ch) : " ";
  }
  return s.replace(/\s+$/, "");
}
