// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run terminal; dual-licensed - see LICENSE.md.

// Design tokens (Paged dark theme) + ANSI palette.
// All monospace is JetBrains Mono — no IBM Plex Mono anywhere.

export const THEME = {
  bg: "#15151A", // terminal pane = the comp's window surface (--surface)
  fg: "#EDECF3", // primary text
  cursor: "#A984F5", // violet primary
  // Selection highlight — the comp's ::selection violet rgba(169,132,245,.32)
  // composited over the terminal surface (#15151a).
  selection: "#443960",
  font: '"JetBrains Mono", ui-monospace, SFMono-Regular, monospace',
};

// 16 base ANSI colours, tuned for the dark theme. Indices 0–7 normal, 8–15 bright.
// "Blue" (4/12) is mapped to the userland violet so directory listings etc. read
// in-brand instead of blue; magenta (5/13) is a distinct pink so the two stay
// distinguishable (ls colours, diffs, prompts that use both).
const ANSI16 = [
  "#1c1c20", "#f0616d", "#57b87a", "#d39a3e", "#a984f5", "#d672c4", "#3fb6b2", "#9b9ba4",
  "#3a3a42", "#ff7b86", "#74d493", "#e6b45a", "#c4b6f2", "#ec9ddc", "#5fd6d1", "#edecf3",
];

/** An rgb triple, each channel a 0..1 float (sRGB-encoded, as the canvas is). */
export type Rgb = readonly [number, number, number];

/** Parse `#rrggbb` (or `#rgb`) into a 0..1 float triple. */
export function hexToRgb(hex: string): Rgb {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h, 16);
  return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
}

/** The full 256-colour palette as 0..1 float triples, built once. */
const ANSI256_RGB: Rgb[] = (() => {
  const out: Rgb[] = ANSI16.map(hexToRgb);
  const c = (v: number) => (v === 0 ? 0 : 55 + v * 40) / 255;
  for (let n = 0; n < 216; n++) out.push([c(Math.floor(n / 36)), c(Math.floor((n % 36) / 6)), c(n % 6)]);
  for (let i = 0; i < 24; i++) {
    const v = (8 + i * 10) / 255;
    out.push([v, v, v]);
  }
  return out;
})();

/** CSS strings for the same palette (2D canvas renderer). */
const ANSI256_CSS: string[] = ANSI256_RGB.map(
  ([r, g, b]) => `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`,
);

/** Resolve a 0–255 ANSI palette index to a CSS colour. */
export function ansiColor(idx: number): string {
  return ANSI256_CSS[idx & 0xff];
}

// ---------------------------------------------------------------------------
// Numeric (float 0..1) colour API — used by the WebGPU renderer, which needs
// linear vertex/instance attributes rather than CSS strings.
// ---------------------------------------------------------------------------

/** Design tokens as float triples (ground, text, violet cursor, selection). */
export const THEME_RGB = {
  bg: hexToRgb(THEME.bg),
  fg: hexToRgb(THEME.fg),
  cursor: hexToRgb(THEME.cursor),
  selection: hexToRgb(THEME.selection),
};

/** Resolve a 0–255 ANSI palette index to a 0..1 float triple. */
export function ansiRgb(idx: number): Rgb {
  return ANSI256_RGB[idx & 0xff];
}
