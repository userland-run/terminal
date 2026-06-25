// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run terminal; dual-licensed - see LICENSE.md.

// Design tokens (Paged dark theme) + ANSI palette.
// All monospace is JetBrains Mono — no IBM Plex Mono anywhere.

export const THEME = {
  bg: "#15151A", // terminal pane = the comp's window surface (--surface)
  fg: "#EDECF3", // primary text
  cursor: "#A984F5", // violet primary
  font: '"JetBrains Mono", ui-monospace, SFMono-Regular, monospace',
};

// 16 base ANSI colours, tuned for the dark theme. Indices 0–7 normal, 8–15 bright.
// "Blue" (4/12) is mapped to the userland violet so directory listings etc. read
// in-brand instead of blue.
const ANSI16 = [
  "#1c1c20", "#f0616d", "#57b87a", "#d39a3e", "#a984f5", "#a984f5", "#3fb6b2", "#9b9ba4",
  "#3a3a42", "#ff7b86", "#74d493", "#e6b45a", "#c4b6f2", "#c4b6f2", "#5fd6d1", "#edecf3",
];

/** Resolve a 0–255 ANSI palette index to a CSS colour. */
export function ansiColor(idx: number): string {
  if (idx < 16) return ANSI16[idx];
  if (idx < 232) {
    const n = idx - 16;
    const r = Math.floor(n / 36);
    const g = Math.floor((n % 36) / 6);
    const b = n % 6;
    const c = (v: number) => (v === 0 ? 0 : 55 + v * 40);
    return `rgb(${c(r)},${c(g)},${c(b)})`;
  }
  const v = 8 + (idx - 232) * 10;
  return `rgb(${v},${v},${v})`;
}

// ---------------------------------------------------------------------------
// Numeric (float 0..1) colour API — used by the WebGPU renderer, which needs
// linear vertex/instance attributes rather than CSS strings.
// ---------------------------------------------------------------------------

/** An rgb triple, each channel a 0..1 float (sRGB-encoded, as the canvas is). */
export type Rgb = readonly [number, number, number];

/** Parse `#rrggbb` (or `#rgb`) into a 0..1 float triple. */
export function hexToRgb(hex: string): Rgb {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h, 16);
  return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
}

/** Design tokens as float triples (ground, text, violet cursor). */
export const THEME_RGB = {
  bg: hexToRgb(THEME.bg),
  fg: hexToRgb(THEME.fg),
  cursor: hexToRgb(THEME.cursor),
};

const ANSI16_RGB: Rgb[] = ANSI16.map(hexToRgb);

/** Resolve a 0–255 ANSI palette index to a 0..1 float triple. */
export function ansiRgb(idx: number): Rgb {
  if (idx < 16) return ANSI16_RGB[idx];
  if (idx < 232) {
    const n = idx - 16;
    const r = Math.floor(n / 36);
    const g = Math.floor((n % 36) / 6);
    const b = n % 6;
    const c = (v: number) => (v === 0 ? 0 : 55 + v * 40) / 255;
    return [c(r), c(g), c(b)];
  }
  const v = (8 + (idx - 232) * 10) / 255;
  return [v, v, v];
}
