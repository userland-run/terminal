// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run terminal; dual-licensed - see LICENSE.md.

import type { NanoVM } from "@container/nanovm.mjs";

// The File System Access API (showDirectoryPicker / showOpenFilePicker and the
// directory-handle async iterator) isn't in every TS lib.dom, so we reach for it
// through narrow structural types and `any` casts rather than depend on the lib.
interface FsFileHandleLike {
  kind: "file";
  name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<{ write(data: unknown): Promise<void>; close(): Promise<void> }>;
  queryPermission?(d: { mode: "read" | "readwrite" }): Promise<PermissionState>;
  requestPermission?(d: { mode: "read" | "readwrite" }): Promise<PermissionState>;
}
interface FsDirHandleLike {
  kind: "directory";
  name: string;
  entries(): AsyncIterable<[string, FsFileHandleLike | FsDirHandleLike]>;
}

/** Whether this browser exposes the File System Access pickers (Chromium-only). */
export function isFileSystemAccessSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker ===
      "function"
  );
}

const win = window as unknown as {
  showDirectoryPicker?: (opts?: { mode?: "read" | "readwrite" }) => Promise<FsDirHandleLike>;
  showOpenFilePicker?: (opts?: { multiple?: boolean }) => Promise<FsFileHandleLike[]>;
};

/**
 * Maps local files/directories (picked by the user via the File System Access
 * API) into the guest VFS under a mount base (default `/mnt`). Because imports
 * go through {@link NanoVM.addFile}/`makeDir` — the same MemFS the guest reads —
 * busybox/node inside the VM see the files immediately. Tracks the picked
 * handles so editor saves can write changes back to disk.
 */
export class LocalMounts {
  private readonly handles = new Map<string, FsFileHandleLike>();

  constructor(
    private readonly vm: NanoVM,
    private readonly base = "/mnt",
  ) {}

  /** Pick a folder and import it under `<base>/<name>`. Returns the mount path. */
  async mountDirectory(): Promise<string> {
    if (!win.showDirectoryPicker) throw new Error("File System Access API unavailable");
    const dir = await win.showDirectoryPicker({ mode: "readwrite" });
    this.vm.makeDir(this.base);
    const mountPath = `${this.base}/${dir.name}`;
    await this.importDir(dir, mountPath);
    return mountPath;
  }

  /** Pick a single file and import it under `<base>/<name>`. Returns the path. */
  async openFile(): Promise<string> {
    if (!win.showOpenFilePicker) throw new Error("File System Access API unavailable");
    const [handle] = await win.showOpenFilePicker({ multiple: false });
    if (!handle) throw new Error("no file selected");
    this.vm.makeDir(this.base);
    const path = `${this.base}/${handle.name}`;
    await this.importFile(handle, path);
    return path;
  }

  /** True if `path` is backed by a local file handle (i.e. a mapped file). */
  isMapped(path: string): boolean {
    return this.handles.has(path);
  }

  /**
   * Persist `content` back to the local file `path` maps to. Returns false when
   * the path isn't mapped or write permission was denied.
   */
  async writeBack(path: string, content: string | Uint8Array): Promise<boolean> {
    const handle = this.handles.get(path);
    if (!handle) return false;
    if (handle.queryPermission) {
      let perm = await handle.queryPermission({ mode: "readwrite" });
      if (perm !== "granted" && handle.requestPermission) {
        perm = await handle.requestPermission({ mode: "readwrite" });
      }
      if (perm !== "granted") return false;
    }
    const writable = await handle.createWritable();
    await writable.write(content);
    await writable.close();
    return true;
  }

  private async importDir(dir: FsDirHandleLike, dirPath: string): Promise<void> {
    this.vm.makeDir(dirPath);
    for await (const [name, handle] of dir.entries()) {
      const childPath = `${dirPath}/${name}`;
      if (handle.kind === "file") await this.importFile(handle, childPath);
      else await this.importDir(handle, childPath);
    }
  }

  private async importFile(handle: FsFileHandleLike, path: string): Promise<void> {
    const file = await handle.getFile();
    const bytes = new Uint8Array(await file.arrayBuffer());
    this.vm.addFile(path, bytes);
    this.handles.set(path, handle);
  }
}
