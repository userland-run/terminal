// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run terminal; dual-licensed - see LICENSE.md.

// Ambient types for the browser NanoVM module imported from the sibling
// `nano/` repo via the `@container` alias. Mirrors the subset of the API the
// terminal uses (the module itself is plain JS).
declare module "@container/nanovm.mjs" {
  export interface TermSnapshot {
    cols: number;
    rows: number;
    /** Cursor row within the viewport, or -1 when scrolled off the live region. */
    cursorRow: number;
    cursorCol: number;
    cells: Uint8Array;
    /** Scrollback lines scrolled up from the live bottom (0 = live). */
    scrollOffset: number;
    /** Maximum scroll offset available (scrollback depth). */
    scrollMax: number;
  }
  export interface RunResult {
    exitCode: number;
    stdout: string;
    cancelled?: boolean;
  }
  export interface DirEntry {
    name: string;
    type: "file" | "dir" | "symlink";
    size: number;
  }
  /** In-VM HTTP connection injector for the serve bridge (preview feature). */
  export interface ConnectionInjector {
    injectConnection(port: number, httpRequest: string): Promise<Uint8Array>;
  }
  export class NanoVM {
    static create(opts: {
      ramMB?: number;
      wasm: string | ArrayBuffer | Uint8Array;
    }): Promise<NanoVM>;
    termInit(cols?: number, rows?: number): void;
    termResize(cols: number, rows: number): void;
    setTty(on?: boolean): void;
    termSnapshot(scrollOffset?: number): TermSnapshot | null;
    termEcho(data: Uint8Array | string): void;
    /** Write/overwrite a file in the guest VFS (sync, no VM step). */
    addFile(path: string, content: Uint8Array | string, mode?: number): void;
    /** Read a file's contents as text, or null if absent / not a file. */
    readFileString(path: string): string | null;
    /** List a directory's entries, or null if absent / not a directory. */
    listDir(path: string): DirEntry[] | null;
    /** Create a directory and any missing parents (sync, no VM step). */
    makeDir(path: string): void;
    /** Recursively remove a file/symlink/directory (sync, no VM step). */
    removePath(path: string): void;
    /** Rename/move a path, overwriting the destination (sync, no VM step). */
    renamePath(from: string, to: string): void;
    /** Working directory of the process currently in the run loop. */
    cwd(): string;
    /** Total guest instructions retired so far (for an insns/sec readout). */
    instructionCount(): number;
    /** True while a guest server is actively listening. */
    readonly serving: boolean;
    /** Listening port (best-effort) while serving, else null. */
    readonly servingPort: number | null;
    /** In-VM HTTP connection injector (serve mode). */
    readonly virtualServer: ConnectionInjector;
    writeStdin(data: Uint8Array | string): void;
    setInteractiveStdin(on?: boolean): void;
    closeStdin(): void;
    cancelRun(): void;
    run(
      command: string,
      opts?: { onStdout?: (t: string) => void; maxSteps?: number }
    ): Promise<RunResult>;
  }
}
