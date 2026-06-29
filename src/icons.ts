// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run terminal; dual-licensed - see LICENSE.md.

// Lucide icons (https://lucide.dev) replace the terminal's hand-rolled SVGs.
// - icon() builds an inline <svg> for dynamically-created UI (file tree, preview).
// - renderChromeIcons() swaps the static [data-lucide] placeholders in index.html.

import {
  createElement,
  createIcons,
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
} from "lucide";

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

/** Replace the static `<i data-lucide="…">` placeholders in the chrome. */
export function renderChromeIcons(): void {
  createIcons({
    icons: {
      PanelLeft,
      Trash2,
      RotateCw,
      Ellipsis,
      Folder,
      LayoutGrid,
      SquareTerminal,
      Code,
      Globe,
      Command,
    },
    attrs: { width: "16", height: "16", "stroke-width": STROKE },
  });
}
