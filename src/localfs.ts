// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run terminal; dual-licensed - see LICENSE.md.

import type { NanoVM } from "@container/nanovm.mjs";
import {
  mountFolder,
  isFileSystemAccessSupported as sdkFsaSupported,
  type FsDirHandleLike,
  type FsFileHandleLike,
  type MountedFolder,
  type WriteBackReport,
} from "@sdk/folder";

/** Whether this browser exposes the File System Access pickers (Chromium-only). */
export function isFileSystemAccessSupported(): boolean {
  return sdkFsaSupported();
}

// The pickers aren't in every TS lib.dom; reach for them structurally.
const win = globalThis as unknown as {
  showDirectoryPicker?: (opts?: { mode?: "read" | "readwrite" }) => Promise<FsDirHandleLike>;
  showOpenFilePicker?: (opts?: { multiple?: boolean }) => Promise<FsFileHandleLike[]>;
};

/** Outcome of writing VM changes back to disk. */
export interface SaveResult {
  /** False when write permission was denied or a write failed. */
  ok: boolean;
  written: number;
  failed: number;
  /** True when no mapped folder/file covers the request. */
  unmapped?: boolean;
}

const FOLDER_BASE = "/work";

/**
 * Maps local files and folders (picked via the File System Access API) into
 * the guest VFS. Folders go through the SDK folder bridge
 * (`@userland-run/nano-sdk/folder`): copied to `/work` (or `/work/<name>` when
 * `/work` is already in use), snapshotted, and every file added or changed in
 * the VM is written back on save. Single files go under `/mnt` and are written
 * back when saved in the editor.
 */
export class LocalMounts {
  private readonly fileHandles = new Map<string, FsFileHandleLike>();
  private readonly folders: MountedFolder[] = [];

  constructor(
    private readonly vm: NanoVM,
    private readonly base = "/mnt",
  ) {}

  /** True once at least one folder is mapped. */
  get hasFolders(): boolean {
    return this.folders.length > 0;
  }

  /** Pick a folder and import it. Returns the mount path. */
  async mountDirectory(): Promise<string> {
    if (!win.showDirectoryPicker) throw new Error("File System Access API unavailable");
    const dir = await win.showDirectoryPicker({ mode: "readwrite" });
    const at = this.pickMountPath(dir.name);
    const mounted = await mountFolder(this.vm, dir, { at });
    this.folders.push(mounted);
    return mounted.at;
  }

  /** Pick a single file and import it under `<base>/<name>`. Returns the path. */
  async openFile(): Promise<string> {
    if (!win.showOpenFilePicker) throw new Error("File System Access API unavailable");
    const [handle] = await win.showOpenFilePicker({ multiple: false });
    if (!handle) throw new Error("no file selected");
    this.vm.makeDir(this.base);
    const path = `${this.base}/${handle.name}`;
    const file = await handle.getFile();
    this.vm.addFile(path, new Uint8Array(await file.arrayBuffer()));
    this.fileHandles.set(path, handle);
    return path;
  }

  /** True if `path` is backed by a mapped local file or lies in a mapped folder. */
  isMapped(path: string): boolean {
    return this.fileHandles.has(path) || !!this.folderOf(path);
  }

  /**
   * Persist an editor save. A single mapped file is written directly; inside a
   * mapped folder, every file changed in the VM since the last save is written
   * (not only `path`).
   */
  async writeBack(path: string, content: string | Uint8Array): Promise<SaveResult> {
    const handle = this.fileHandles.get(path);
    if (handle) return this.writeFileHandle(handle, content);
    const folder = this.folderOf(path);
    if (!folder) return { ok: false, written: 0, failed: 0, unmapped: true };
    return this.saveFolder(folder);
  }

  /** Write all added/changed files of every mapped folder back to disk. */
  async saveAll(): Promise<SaveResult> {
    const total: SaveResult = { ok: true, written: 0, failed: 0 };
    if (!this.folders.length) return { ...total, unmapped: true };
    for (const f of this.folders) {
      const r = await this.saveFolder(f);
      total.ok &&= r.ok;
      total.written += r.written;
      total.failed += r.failed;
    }
    return total;
  }

  private async saveFolder(folder: MountedFolder): Promise<SaveResult> {
    // Other mounts nested inside this one belong to their own folders.
    const skip = this.folders.filter((f) => f !== folder && folder.contains(f.at)).map((f) => f.at);
    let report: WriteBackReport;
    try {
      report = await folder.writeBack({ skip });
    } catch (err) {
      console.warn("[localfs] write back failed:", err);
      return { ok: false, written: 0, failed: 0 };
    }
    for (const f of report.failed) console.warn(`[localfs] ${f.path}: ${f.error}`);
    return { ok: !report.failed.length, written: report.written.length, failed: report.failed.length };
  }

  /** The innermost mapped folder containing `path`. */
  private folderOf(path: string): MountedFolder | undefined {
    let best: MountedFolder | undefined;
    for (const f of this.folders) {
      if (f.relative(path) !== null && (!best || f.at.length > best.at.length)) best = f;
    }
    return best;
  }

  /** `/work` when it is missing or empty, else a free `/work/<name>[-n]`. */
  private pickMountPath(name: string): string {
    const work = this.vm.listDir(FOLDER_BASE);
    if (!work || work.length === 0) return FOLDER_BASE;
    const safe = name.replace(/[/\0]/g, "_") || "folder";
    let at = `${FOLDER_BASE}/${safe}`;
    for (let n = 2; this.vm.listDir(at) || this.vm.readFileString(at) !== null; n++) {
      at = `${FOLDER_BASE}/${safe}-${n}`;
    }
    return at;
  }

  private async writeFileHandle(
    handle: FsFileHandleLike,
    content: string | Uint8Array,
  ): Promise<SaveResult> {
    if (handle.queryPermission) {
      let perm = await handle.queryPermission({ mode: "readwrite" });
      if (perm !== "granted" && handle.requestPermission) {
        perm = await handle.requestPermission({ mode: "readwrite" });
      }
      if (perm !== "granted") return { ok: false, written: 0, failed: 1 };
    }
    const writable = await handle.createWritable();
    await writable.write(content);
    await writable.close();
    return { ok: true, written: 1, failed: 0 };
  }
}
