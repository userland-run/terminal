// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run terminal; dual-licensed - see LICENSE.md.

// Lucide icons (https://lucide.dev) replace the terminal's hand-rolled SVGs.
// - icon() builds an inline <svg> for dynamically-created UI (file tree, preview).
// - renderChromeIcons() swaps the static [data-lucide] placeholders in index.html.

import {
  createElement,
  type IconNode,
  ChevronRight,
  File,
  Folder,
  FilePlus,
  FolderPlus,
  RefreshCw,
  Pencil,
  Trash2,
  FolderInput,
  FileInput,
  RotateCw,
  ExternalLink,
  PanelLeft,
  Ellipsis,
  Globe,
  SquareTerminal,
  LayoutGrid,
  Code,
  Command,
  Sparkles,
  Send,
} from "lucide";

import { qsa } from "./dom";

export type { IconNode };

/** Icon nodes used by the dynamically-built UI. */
export const I = {
  chevron: ChevronRight,
  file: File,
  folder: Folder,
  newFile: FilePlus,
  newFolder: FolderPlus,
  refresh: RefreshCw,
  rename: Pencil,
  trash: Trash2,
  mapFolder: FolderInput,
  mapFile: FileInput,
  reload: RotateCw,
  openExternal: ExternalLink,
  sparkles: Sparkles,
  send: Send,
};

// Lucide's default stroke (2) reads heavy at chrome sizes; 1.5 is lighter/crisper.
const STROKE = "1.5";

/** Build an inline Lucide icon SVG sized to `size` px. */
export function icon(node: IconNode, size = 16, strokeWidth: string | number = STROKE): SVGElement {
  const el = createElement(node);
  el.setAttribute("width", String(size));
  el.setAttribute("height", String(size));
  el.setAttribute("stroke-width", String(strokeWidth));
  return el;
}

// data-lucide placeholder name → icon node. (kebab-case, as written in the scaffold.)
const CHROME_ICONS: Record<string, IconNode> = {
  "panel-left": PanelLeft,
  "trash-2": Trash2,
  "rotate-cw": RotateCw,
  ellipsis: Ellipsis,
  folder: Folder,
  "layout-grid": LayoutGrid,
  "square-terminal": SquareTerminal,
  code: Code,
  globe: Globe,
  command: Command,
  sparkles: Sparkles,
};

/**
 * Replace the static `<i data-lucide="…">` placeholders in the chrome with
 * inline Lucide SVGs. Scoped to the terminal's root (not the global document, so
 * it works inside a shadow root) — replaces lucide's own `createIcons`, which
 * only scans `document`.
 */
export function renderChromeIcons(): void {
  for (const ph of qsa<HTMLElement>("[data-lucide]")) {
    const name = ph.getAttribute("data-lucide");
    const node = name ? CHROME_ICONS[name] : undefined;
    if (!node) continue;
    const svg = icon(node, 16);
    if (ph.className) svg.setAttribute("class", ph.className); // keep .session-ico, .accent, …
    ph.replaceWith(svg);
  }
}
