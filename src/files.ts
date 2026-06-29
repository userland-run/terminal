// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run terminal; dual-licensed - see LICENSE.md.

import type { NanoVM, DirEntry } from "@container/nanovm.mjs";
import { LocalMounts, isFileSystemAccessSupported } from "./localfs";
import { I, icon, type IconNode } from "./icons";

export interface FilesPanelOptions {
  /** Called when a file row is activated (wired to the Editor tab in P3). */
  onOpenFile?: (path: string) => void;
  /** Local FS mapping (File System Access API); enables the mount buttons. */
  localMounts?: LocalMounts;
}

const joinPath = (dir: string, name: string): string =>
  dir === "/" ? `/${name}` : `${dir}/${name}`;

const sortEntries = (a: DirEntry, b: DirEntry): number => {
  if (a.type === "dir" && b.type !== "dir") return -1;
  if (a.type !== "dir" && b.type === "dir") return 1;
  return a.name.localeCompare(b.name);
};

/**
 * Files sidebar panel: a lazy file tree over the guest VFS with CRUD. Reads and
 * mutations go straight through the synchronous MemFS-backed NanoVM methods (no
 * VM step), so they're safe alongside the live interactive shell. Children are
 * listed only for expanded directories — never recurse `/` eagerly (after a
 * catalog install it holds thousands of nodes).
 */
export class FilesPanel {
  private body!: HTMLElement;
  private treeEl!: HTMLElement;
  private readonly expanded = new Set<string>(["/"]);
  private activeDir = "/"; // target directory for New file / New folder
  private selected: string | null = null;
  private pendingDelete: string | null = null;
  private deleteTimer = 0;

  constructor(
    private readonly vm: NanoVM,
    private readonly opts: FilesPanelOptions = {},
  ) {}

  /** Render the panel into the `#files` body element (replaces the placeholder). */
  mount(body: HTMLElement): void {
    this.body = body;
    body.textContent = "";
    body.classList.remove("muted-note");
    body.classList.add("files-body");

    const toolbar = document.createElement("div");
    toolbar.className = "files-toolbar";
    toolbar.append(
      this.toolBtn("New file", I.newFile, () => this.beginCreate("file")),
      this.toolBtn("New folder", I.newFolder, () => this.beginCreate("dir")),
      this.toolBtn("Refresh", I.refresh, () => this.refresh()),
    );
    if (this.opts.localMounts && isFileSystemAccessSupported()) {
      const spacer = document.createElement("span");
      spacer.className = "files-tool-gap";
      toolbar.append(
        spacer,
        this.toolBtn("Map local file…", I.mapFile, () => this.mapLocal("file")),
        this.toolBtn("Map local folder…", I.mapFolder, () => this.mapLocal("dir")),
      );
    }

    this.treeEl = document.createElement("div");
    this.treeEl.className = "files-tree";

    body.append(toolbar, this.treeEl);
    this.render();
  }

  /** Re-list the expanded directories (call after external FS changes). */
  refresh(): void {
    this.render();
  }

  /** Mark a path as the selected file (e.g. when opened elsewhere). */
  setSelected(path: string | null): void {
    this.selected = path;
    this.render();
  }

  // --- rendering ---

  private render(): void {
    this.clearPendingDelete();
    this.treeEl.textContent = "";
    this.renderDir(this.treeEl, "/", 0);
    if (!this.treeEl.childElementCount) {
      const empty = document.createElement("div");
      empty.className = "muted-note";
      empty.textContent = "empty";
      this.treeEl.append(empty);
    }
  }

  private renderDir(container: HTMLElement, dirPath: string, depth: number): void {
    const entries = this.vm.listDir(dirPath);
    if (!entries) return;
    for (const entry of [...entries].sort(sortEntries)) {
      const path = joinPath(dirPath, entry.name);
      container.append(this.makeRow(entry, path, depth));
      if (entry.type === "dir" && this.expanded.has(path)) {
        this.renderDir(container, path, depth + 1);
      }
    }
  }

  private makeRow(entry: DirEntry, path: string, depth: number): HTMLElement {
    const row = document.createElement("div");
    row.className = `file-row ${entry.type}`;
    if (path === this.selected) row.classList.add("selected");
    if (entry.type === "dir" && path === this.activeDir) row.classList.add("active-dir");
    if (entry.type === "file" && this.opts.localMounts?.isMapped(path)) {
      row.classList.add("mapped");
      row.title = "mapped to a local file (edits write back to disk)";
    }
    row.style.paddingLeft = `${6 + depth * 12}px`;
    row.dataset.path = path;

    const isDir = entry.type === "dir";
    if (isDir) {
      const tw = icon(I.chevron, 16);
      tw.classList.add("file-twist");
      if (this.expanded.has(path)) tw.classList.add("open");
      row.append(tw);
    } else {
      const spacer = document.createElement("span");
      spacer.className = "file-twist-spacer";
      row.append(spacer);
    }

    row.append(icon(isDir ? I.folder : I.file, 16));

    const name = document.createElement("span");
    name.className = "file-name";
    name.textContent = entry.name;
    row.append(name);

    const actions = document.createElement("span");
    actions.className = "file-actions";
    actions.append(
      this.rowBtn("Rename", I.rename, (ev) => {
        ev.stopPropagation();
        this.beginRename(row, entry, path);
      }),
      this.rowBtn("Delete", I.trash, (ev) => {
        ev.stopPropagation();
        this.confirmDelete(row, path);
      }),
    );
    row.append(actions);

    row.addEventListener("click", () => {
      if (isDir) {
        this.activeDir = path;
        if (this.expanded.has(path)) this.expanded.delete(path);
        else this.expanded.add(path);
        this.render();
      } else {
        this.selected = path;
        this.opts.onOpenFile?.(path);
        this.render();
      }
    });
    return row;
  }

  // --- local FS mapping (File System Access API) ---

  private async mapLocal(kind: "file" | "dir"): Promise<void> {
    const mounts = this.opts.localMounts;
    if (!mounts) return;
    try {
      const path = kind === "dir" ? await mounts.mountDirectory() : await mounts.openFile();
      // Reveal the mount: expand /mnt and (for a folder) the mounted dir itself.
      const parent = path.slice(0, path.lastIndexOf("/")) || "/";
      this.expanded.add(parent);
      if (kind === "dir") this.expanded.add(path);
      else {
        this.selected = path;
        this.opts.onOpenFile?.(path);
      }
      this.render();
    } catch (err) {
      // AbortError = user dismissed the picker; anything else is worth a log.
      if ((err as { name?: string })?.name !== "AbortError") {
        console.warn("[files] local map failed:", err);
      }
    }
  }

  // --- create (inline input) ---

  private beginCreate(kind: "file" | "dir"): void {
    if (kind === "dir") {
      // ensure the target dir is expanded so the new entry is visible
      this.expanded.add(this.activeDir);
    }
    this.render();
    const editor = this.makeNameInput("", (raw) => {
      const name = raw.trim();
      if (!name || name.includes("/")) return;
      const path = joinPath(this.activeDir, name);
      try {
        if (kind === "file") this.vm.addFile(path, "");
        else this.vm.makeDir(path);
        if (kind === "dir") this.expanded.add(path);
        if (kind === "file") {
          this.selected = path;
          this.opts.onOpenFile?.(path);
        }
      } catch (err) {
        console.warn("[files] create failed:", err);
      }
      this.render();
    });
    editor.dataset.label = this.activeDir === "/" ? "/" : `${this.activeDir}/`;
    this.treeEl.prepend(editor);
    (editor.querySelector("input") as HTMLInputElement)?.focus();
  }

  // --- rename (inline input over the row) ---

  private beginRename(row: HTMLElement, entry: DirEntry, path: string): void {
    const nameEl = row.querySelector(".file-name") as HTMLElement | null;
    if (!nameEl) return;
    const input = document.createElement("input");
    input.className = "file-input";
    input.value = entry.name;
    input.spellcheck = false;
    nameEl.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const commit = (save: boolean) => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      if (save && name && !name.includes("/") && name !== entry.name) {
        const dir = path.slice(0, path.lastIndexOf("/")) || "/";
        try {
          this.vm.renamePath(path, joinPath(dir, name));
          if (this.selected === path) this.selected = joinPath(dir, name);
        } catch (err) {
          console.warn("[files] rename failed:", err);
        }
      }
      this.render();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") commit(true);
      else if (e.key === "Escape") commit(false);
      e.stopPropagation();
    });
    input.addEventListener("blur", () => commit(true));
  }

  // --- delete (two-click confirm; no blocking native dialog) ---

  private confirmDelete(row: HTMLElement, path: string): void {
    if (this.pendingDelete === path) {
      this.clearPendingDelete();
      try {
        this.vm.removePath(path);
        if (this.selected === path) this.selected = null;
        this.expanded.delete(path);
      } catch (err) {
        console.warn("[files] delete failed:", err);
      }
      this.render();
      return;
    }
    this.clearPendingDelete();
    this.pendingDelete = path;
    row.classList.add("arming-delete");
    const btn = row.querySelector(".file-actions button:last-child") as HTMLElement | null;
    if (btn) btn.title = "Click again to delete";
    this.deleteTimer = window.setTimeout(() => this.clearPendingDelete(), 3000);
  }

  private clearPendingDelete(): void {
    if (this.deleteTimer) window.clearTimeout(this.deleteTimer);
    this.deleteTimer = 0;
    if (this.pendingDelete) {
      this.treeEl
        ?.querySelector(`.file-row[data-path="${cssEscape(this.pendingDelete)}"]`)
        ?.classList.remove("arming-delete");
      this.pendingDelete = null;
    }
  }

  // --- small builders ---

  private makeNameInput(value: string, onCommit: (v: string) => void): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "file-row file-create";
    const input = document.createElement("input");
    input.className = "file-input";
    input.value = value;
    input.spellcheck = false;
    input.placeholder = "name…";
    wrap.append(input);
    let done = false;
    const finish = (save: boolean) => {
      if (done) return;
      done = true;
      if (save) onCommit(input.value);
      else this.render();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") finish(true);
      else if (e.key === "Escape") finish(false);
      e.stopPropagation();
    });
    input.addEventListener("blur", () => finish(true));
    return wrap;
  }

  private toolBtn(title: string, node: IconNode, onClick: () => void): HTMLButtonElement {
    const b = document.createElement("button");
    b.className = "files-tool";
    b.title = title;
    b.setAttribute("aria-label", title);
    b.append(icon(node, 18));
    b.addEventListener("click", onClick);
    return b;
  }

  private rowBtn(
    title: string,
    node: IconNode,
    onClick: (ev: MouseEvent) => void,
  ): HTMLButtonElement {
    const b = document.createElement("button");
    b.className = "file-act";
    b.title = title;
    b.setAttribute("aria-label", title);
    b.append(icon(node, 16));
    b.addEventListener("click", onClick);
    return b;
  }
}

/** Minimal CSS.escape fallback for attribute selectors (paths have no quotes). */
function cssEscape(s: string): string {
  return s.replace(/["\\]/g, "\\$&");
}
