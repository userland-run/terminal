// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run terminal; dual-licensed - see LICENSE.md.

// A pub/sub tap over the interactive shell's stdout. main.ts passes the bus's
// `push` as the `onStdout` of the long-lived `sh -i` run, so the assistant sees
// exactly the byte stream the terminal renders. `runShellCommand` injects a
// command as if typed and resolves with its clean output + exit code, delimited
// by unique BEGIN/END sentinels emitted as **OSC escape sequences**
// (`ESC ] 5470 ; … BEL`). The terminal's VT parser swallows OSC, so the markers
// are invisible on the grid, yet they still arrive in this raw byte stream for
// matching. Crucially, the shell's tty *echo* of our typed line shows the
// sentinels only as the literal text `\033]…\007` (no real ESC byte), so the
// echo never collides with the emitted (real-ESC) markers we match on.

import type { NanoVM } from "@container/nanovm.mjs";

export class StdoutBus {
  private listeners = new Set<(chunk: string) => void>();

  /** Feed a stdout chunk from the guest shell (wired as `vm.run`'s onStdout). */
  push = (chunk: string): void => {
    for (const fn of this.listeners) {
      try {
        fn(chunk);
      } catch {
        /* a listener throwing must not break the render/output path */
      }
    }
  };

  /** Subscribe to raw stdout chunks; returns an unsubscribe. */
  subscribe(fn: (chunk: string) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

export interface ShellRunResult {
  /** Clean command output (ANSI stripped, sentinels removed). */
  output: string;
  /** Exit code, or null if the command timed out. */
  exitCode: number | null;
  timedOut: boolean;
}

let SEQ = 0;

/**
 * Run a single-line shell command in the live interactive session and capture
 * its output. Drives the guest exactly like a user typing, so it never contends
 * with the shell's run loop (unlike `vm.run`, which would cancel it). `command`
 * must be a single line (no embedded newlines) — write files with `vm.addFile`
 * rather than heredocs.
 */
export function runShellCommand(
  vm: NanoVM,
  bus: StdoutBus,
  command: string,
  opts: { timeoutMs?: number } = {},
): Promise<ShellRunResult> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const id = ++SEQ;
  // OSC sentinels: ESC ] 5470 ; B<id> BEL  /  ESC ] 5470 ; E<id>:<code> BEL.
  const OSC = "\\x1b\\]5470;";
  const BEL = "\\x07";
  const beginRe = new RegExp(`${OSC}B${id}${BEL}`);
  const endRe = new RegExp(`${OSC}E${id}:(-?\\d+)${BEL}`);
  let captured = "";

  return new Promise<ShellRunResult>((resolve) => {
    let settled = false;
    const finish = (r: ShellRunResult) => {
      if (settled) return;
      settled = true;
      unsub();
      clearTimeout(timer);
      resolve(r);
    };
    const unsub = bus.subscribe((chunk) => {
      captured += chunk;
      const bm = beginRe.exec(captured);
      if (!bm) return;
      const rest = captured.slice(bm.index + bm[0].length);
      const em = endRe.exec(rest);
      if (!em) return;
      finish({
        output: cleanOutput(rest.slice(0, em.index)),
        exitCode: Number(em[1]),
        timedOut: false,
      });
    });
    const timer = setTimeout(() => {
      const bm = beginRe.exec(captured);
      const partial = bm ? captured.slice(bm.index + bm[0].length) : "";
      finish({ output: cleanOutput(partial), exitCode: null, timedOut: true });
    }, timeoutMs);

    // `$?` after `command` is the command's own exit code (the leading BEGIN
    // printf sits before it, so it doesn't clobber the value the END printf reads).
    // `\033`/`\007` are printf octal escapes → real ESC/BEL only when executed.
    vm.writeStdin(
      `printf '\\033]5470;B${id}\\007'; ${command}; printf '\\033]5470;E${id}:%d\\007' "$?"\r`,
    );
  });
}

/**
 * Strip ANSI escape sequences (CSI + OSC + two-char), carriage returns, and any
 * stray ESC; collapse to plain text suitable for a chat bubble or the model.
 */
export function cleanOutput(s: string): string {
  const ESC = "\x1b";
  return s
    .split(ESC)
    .map((seg, i) => (i === 0 ? seg : stripLeadingEscape(seg)))
    .join("")
    .replace(/\r/g, "")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");
}

// Given the text immediately after an ESC byte, drop the escape sequence it
// begins and return the remainder. Handles CSI ("[ … final"), OSC ("] … BEL/ST"),
// and simple two-char escapes.
function stripLeadingEscape(seg: string): string {
  if (seg.startsWith("[")) {
    const m = /^\[[0-9;?]*[ -/]*[@-~]/.exec(seg);
    return m ? seg.slice(m[0].length) : seg.slice(1);
  }
  if (seg.startsWith("]")) {
    const bel = seg.indexOf("\x07");
    if (bel >= 0) return seg.slice(bel + 1);
    return ""; // ST would be the next ESC boundary, already consumed by split
  }
  // Two-char escape: drop the single following byte.
  return seg.slice(1);
}
