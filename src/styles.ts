// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run terminal; dual-licensed - see LICENSE.md.

// Runtime stylesheet injection for the SDK-embedded path. When the terminal is
// bundled into the SDK, ui.css is imported as a text string (tsup `.css` text
// loader) and injected here. In the standalone Vite build the same `import` is a
// side-effect that injects the CSS already, so `css` is undefined and this no-ops.
// ui.css is fully scoped under #app, so injecting it can't leak onto a host page.

const STYLE_ID = "nano-terminal-styles";

/** Inject the stylesheet into `root` (a shadow root, or document.head). No-op if
 *  `css` is empty (the standalone Vite build already injected it) or if a sheet
 *  is already present in this root. */
export function ensureStyles(css: string | undefined, root: Document | ShadowRoot | HTMLElement): void {
  if (!css || typeof document === "undefined") return;
  if (root.querySelector(`#${STYLE_ID}`)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = css;
  root.appendChild(style);
}
