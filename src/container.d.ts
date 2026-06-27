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
    /** Write a file into the guest VFS (used by the catalog installer). */
    addFile(path: string, content: Uint8Array | string): void;
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
