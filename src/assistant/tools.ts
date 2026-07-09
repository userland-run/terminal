// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run terminal; dual-licensed - see LICENSE.md.

// The shared VM tool registry. Every capability the assistant can invoke lives
// here, expressed against the TerminalHandle only (UI-agnostic, model-agnostic),
// so the *same* AssistantTool objects drive the in-page router and the WebMCP
// registration. Reads/writes use the synchronous VFS methods (safe alongside the
// live shell); command execution goes through the stdout-bus sentinel path
// (never `vm.run`, which would cancel the interactive session).

import type { TerminalHandle } from "../main";
import { StdoutBus, runShellCommand, cleanOutput } from "./stdout-bus";
import { rowsToText } from "../a11y";
import type { AssistantTool, ToolResult } from "./types";

const ok = (output: string, data?: unknown): ToolResult => ({ ok: true, output, data });
const err = (output: string): ToolResult => ({ ok: false, output });

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const int = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : undefined;

/** POSIX single-quote a path/argument so spaces & metacharacters are literal. */
const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Ensure a guest binary is present, installing its catalog app on demand. Uses
 * `command -v` so a warm VM never re-installs. Returns true when available.
 */
export async function ensureBinary(
  handle: TerminalHandle,
  bus: StdoutBus,
  bin: string,
  appRef: string,
): Promise<boolean> {
  const probe = await runShellCommand(handle.vm, bus, `command -v ${bin}`, { timeoutMs: 8_000 });
  if (probe.exitCode === 0 && probe.output.trim()) return true;
  try {
    await handle.installApp(appRef, { quiet: true });
  } catch {
    return false;
  }
  const recheck = await runShellCommand(handle.vm, bus, `command -v ${bin}`, { timeoutMs: 8_000 });
  return recheck.exitCode === 0 && !!recheck.output.trim();
}

/** Read the current terminal screen as text (trailing blank lines trimmed). */
export function readScreen(handle: TerminalHandle): string {
  const snap = handle.vm.termSnapshot(0);
  if (!snap) return "";
  return rowsToText(snap).join("\n").replace(/\n+$/, "");
}

/**
 * Build the VM tool registry for `handle`. `bus` is the shared shell stdout tap
 * (wired in main.ts). `onFsChange` refreshes the Files panel after writes.
 */
export function createVmTools(
  handle: TerminalHandle,
  bus: StdoutBus,
): AssistantTool[] {
  const vm = handle.vm;

  const runShell: AssistantTool = {
    name: "run_shell",
    description:
      "Run a single-line shell command in the terminal and return its output and exit code. Use for listing, inspecting, and running programs. One line only.",
    kind: "exec",
    inputSchema: {
      type: "object",
      properties: { command: { type: "string", description: "The shell command (single line)." } },
      required: ["command"],
      additionalProperties: false,
    },
    async execute(args) {
      const command = str(args.command).replace(/[\r\n]+/g, " ").trim();
      if (!command) return err("run_shell: empty command");
      const r = await runShellCommand(vm, bus, command, { timeoutMs: 25_000 });
      const tail = r.timedOut ? "\n[timed out]" : r.exitCode ? `\n[exit ${r.exitCode}]` : "";
      return { ok: !r.timedOut && r.exitCode === 0, output: (r.output || "(no output)") + tail };
    },
  };

  const listDir: AssistantTool = {
    name: "list_dir",
    description: "List the entries of a directory in the guest filesystem.",
    readOnly: true,
    kind: "read",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Directory path, e.g. /app." } },
      required: ["path"],
      additionalProperties: false,
    },
    async execute(args) {
      const path = str(args.path, "/");
      const entries = vm.listDir(path);
      if (!entries) return err(`list_dir: not a directory: ${path}`);
      const lines = entries
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((e) => (e.type === "dir" ? `${e.name}/` : `${e.name}  (${e.size}b)`));
      return ok(lines.join("\n") || "(empty)", entries);
    },
  };

  const readFile: AssistantTool = {
    name: "read_file",
    description: "Read a text file from the guest filesystem.",
    readOnly: true,
    kind: "read",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
    async execute(args) {
      const path = str(args.path);
      const content = vm.readFileString(path);
      if (content == null) return err(`read_file: not found: ${path}`);
      return ok(content);
    },
  };

  const writeFile: AssistantTool = {
    name: "write_file",
    description: "Create or overwrite a text file in the guest filesystem.",
    kind: "edit",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    async execute(args) {
      const path = str(args.path);
      if (!path) return err("write_file: missing path");
      try {
        vm.addFile(path, str(args.content));
        handle.refreshFiles();
        return ok(`wrote ${path} (${str(args.content).length} bytes)`);
      } catch (e) {
        return err(`write_file: ${(e as Error).message}`);
      }
    },
  };

  const makeDir: AssistantTool = {
    name: "make_dir",
    description: "Create a directory (and any missing parent directories) in the guest filesystem.",
    kind: "edit",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Directory path to create." } },
      required: ["path"],
      additionalProperties: false,
    },
    async execute(args) {
      const path = str(args.path);
      if (!path) return err("make_dir: missing path");
      const r = await runShellCommand(vm, bus, `mkdir -p ${shq(path)}`, { timeoutMs: 8_000 });
      handle.refreshFiles();
      return r.exitCode === 0
        ? ok(`created ${path}`)
        : err(r.output || `make_dir: failed (exit ${r.exitCode})`);
    },
  };

  const movePath: AssistantTool = {
    name: "move_path",
    description: "Move or rename a file or directory in the guest filesystem.",
    kind: "edit",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Source path." },
        to: { type: "string", description: "Destination path." },
      },
      required: ["from", "to"],
      additionalProperties: false,
    },
    async execute(args) {
      const from = str(args.from);
      const to = str(args.to);
      if (!from || !to) return err("move_path: missing from/to");
      const r = await runShellCommand(vm, bus, `mv ${shq(from)} ${shq(to)}`, { timeoutMs: 8_000 });
      handle.refreshFiles();
      return r.exitCode === 0
        ? ok(`moved ${from} → ${to}`)
        : err(r.output || `move_path: failed (exit ${r.exitCode})`);
    },
  };

  const deletePath: AssistantTool = {
    name: "delete_path",
    description: "Delete a file or directory (recursively) from the guest filesystem.",
    kind: "edit",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Path to delete." } },
      required: ["path"],
      additionalProperties: false,
    },
    async execute(args) {
      const path = str(args.path);
      if (!path) return err("delete_path: missing path");
      // Guard against catastrophically broad deletes routed from a vague request.
      if (path === "/" || path === "/*" || path.trim() === "")
        return err("delete_path: refusing to delete the filesystem root");
      const r = await runShellCommand(vm, bus, `rm -rf ${shq(path)}`, { timeoutMs: 8_000 });
      handle.refreshFiles();
      return r.exitCode === 0
        ? ok(`deleted ${path}`)
        : err(r.output || `delete_path: failed (exit ${r.exitCode})`);
    },
  };

  const runNode: AssistantTool = {
    name: "run_node",
    description:
      "Run a JavaScript file with Node.js (provisions Node from the catalog if needed) and return its output.",
    kind: "exec",
    inputSchema: {
      type: "object",
      properties: { file: { type: "string", description: "Path to the .js file to run." } },
      required: ["file"],
      additionalProperties: false,
    },
    async execute(args) {
      const file = str(args.file);
      if (!file) return err("run_node: missing file");
      if (!(await ensureBinary(handle, bus, "node", "node")))
        return err("run_node: could not provision Node.js");
      const r = await runShellCommand(vm, bus, `node ${file}`, { timeoutMs: 40_000 });
      // Warm Node exits 134 after correct output — treat as benign (see node recipe).
      const benign = r.exitCode === 134;
      const tail = r.timedOut ? "\n[timed out]" : "";
      return {
        ok: !r.timedOut && (r.exitCode === 0 || benign),
        output: (r.output || "(no output)") + tail,
      };
    },
  };

  const installApp: AssistantTool = {
    name: "install_app",
    description:
      'Install a catalog app into the guest (e.g. "node", "typescript", "fd@10.2.0"). Makes its binaries runnable.',
    kind: "exec",
    inputSchema: {
      type: "object",
      properties: { ref: { type: "string", description: 'App reference, "name" or "name@version".' } },
      required: ["ref"],
      additionalProperties: false,
    },
    async execute(args) {
      const ref = str(args.ref);
      if (!ref) return err("install_app: missing ref");
      try {
        await handle.installApp(ref, { quiet: true });
        return ok(`installed ${ref}`);
      } catch (e) {
        return err(`install_app: ${(e as Error).message}`);
      }
    },
  };

  const serve: AssistantTool = {
    name: "serve",
    description:
      "Start a Node HTTP server file in the foreground and reveal it in the Preview tab. Returns once the server is listening (or after a short wait).",
    kind: "exec",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Server entrypoint (.js)." },
        port: { type: "number", description: "Port the server listens on (default 8080)." },
      },
      required: ["file"],
      additionalProperties: false,
    },
    async execute(args) {
      const file = str(args.file);
      const port = int(args.port) ?? 8080;
      if (!file) return err("serve: missing file");
      if (!(await ensureBinary(handle, bus, "node", "node")))
        return err("serve: could not provision Node.js");
      // Fire-and-forget: a listening server never returns, so don't await it.
      vm.writeStdin(`node ${file}\r`);
      const listening = await waitFor(() => vm.serving, 6_000);
      handle.showPreview(vm.servingPort ?? port);
      return ok(
        listening
          ? `server listening on :${vm.servingPort ?? port} — opened Preview`
          : `started ${file}; opened Preview on :${port} (may still be starting)`,
      );
    },
  };

  const readTerminal: AssistantTool = {
    name: "read_terminal",
    description: "Return the text currently visible on the terminal screen.",
    readOnly: true,
    kind: "read",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      return ok(readScreen(handle) || "(screen empty)");
    },
  };

  const openFile: AssistantTool = {
    name: "open_file",
    description: "Open a guest file in the editor tab for the user to see.",
    kind: "read",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
    async execute(args) {
      const path = str(args.path);
      if (!path) return err("open_file: missing path");
      handle.openFile(path);
      return ok(`opened ${path}`);
    },
  };

  return [
    runShell,
    listDir,
    readFile,
    writeFile,
    makeDir,
    movePath,
    deletePath,
    runNode,
    installApp,
    serve,
    readTerminal,
    openFile,
  ];
}

/** Poll `pred` until true or `timeoutMs` elapses; resolves the final value. */
export function waitFor(pred: () => boolean, timeoutMs: number, stepMs = 150): Promise<boolean> {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      if (pred()) return resolve(true);
      if (Date.now() - start >= timeoutMs) return resolve(false);
      setTimeout(tick, stepMs);
    };
    tick();
  });
}

// Re-export for consumers that build synthetic output.
export { cleanOutput };
