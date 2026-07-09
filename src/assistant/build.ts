// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run terminal; dual-licensed - see LICENSE.md.

// The compile-and-run pipeline: write a (possibly multi-file) project into the
// VFS, provision the needed toolchain from the catalog, build, then run — the
// browser VM as a universal, offline, sandboxed build+run target for whatever a
// model writes. Proven today: Node.js and TypeScript (tsc in-VM → node). Native
// (Zig/C) is auto-detected but gated on the catalog toolchain and fails
// gracefully when it isn't published yet.

import type { TerminalHandle } from "../main";
import { StdoutBus, runShellCommand } from "./stdout-bus";
import { ensureBinary } from "./tools";
import type { AssistantTool, GeneratedFile, GeneratedProject, ToolResult } from "./types";

interface Toolchain {
  /** Display name / catalog ref used to provision the compiler/runtime. */
  bin: string;
  appRef: string;
  /** Whether the toolchain is proven in-VM (else a graceful stretch-goal note). */
  supported: boolean;
  /** Derive build + run commands for an entry file (build is "" when none). */
  commands(entry: string): { build: string; run: string; artifact?: string };
}

const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const stem = (p: string) => base(p).replace(/\.[^.]+$/, "");

function detectToolchain(entry: string, override?: string): Toolchain {
  const ext = entry.slice(entry.lastIndexOf(".") + 1).toLowerCase();
  const kind = (override || "").toLowerCase() || extKind(ext);
  switch (kind) {
    case "typescript":
    case "ts":
      return {
        bin: "tsc",
        appRef: "typescript",
        supported: true,
        commands: (e) => ({
          build: `tsc ${e} --outDir /app/dist --target es2020 --module commonjs --moduleResolution node --skipLibCheck`,
          run: `node /app/dist/${stem(e)}.js`,
        }),
      };
    case "zig":
      return {
        bin: "zig",
        appRef: "zig",
        supported: false,
        commands: (e) => ({
          build: `zig build-exe ${e} -O ReleaseSafe -femit-bin=/app/out`,
          run: `/app/out`,
          artifact: "/app/out",
        }),
      };
    case "c":
      return {
        bin: "zig",
        appRef: "zig",
        supported: false,
        commands: (e) => ({
          build: `zig cc ${e} -o /app/out`,
          run: `/app/out`,
          artifact: "/app/out",
        }),
      };
    default:
      return {
        bin: "node",
        appRef: "node",
        supported: true,
        commands: (e) => ({ build: "", run: `node ${e}` }),
      };
  }
}

function extKind(ext: string): string {
  if (ext === "ts" || ext === "tsx") return "typescript";
  if (ext === "zig") return "zig";
  if (ext === "c") return "c";
  return "node";
}

/**
 * Write `project` into the VFS, provision its toolchain, build, and run. `log`
 * streams progress lines (used by the codegen panel). Returns the run output.
 */
export async function buildAndRunProject(
  handle: TerminalHandle,
  bus: StdoutBus,
  project: GeneratedProject,
  log: (line: string) => void = () => {},
): Promise<ToolResult> {
  const files: GeneratedFile[] = project.files ?? [];
  for (const f of files) {
    try {
      handle.vm.addFile(f.path, f.content);
    } catch (e) {
      return { ok: false, output: `write ${f.path}: ${(e as Error).message}` };
    }
  }
  handle.refreshFiles();
  if (files[0]) handle.openFile(project.entry || files[0].path);

  const tc = detectToolchain(project.entry, project.toolchain);
  const { build, run } = { build: project.buildCmd ?? "", run: project.runCmd ?? "" };
  const derived = tc.commands(project.entry);
  const buildCmd = build || derived.build;
  const runCmd = run || derived.run;

  log(`toolchain: ${tc.appRef}`);
  if (!(await ensureBinary(handle, bus, tc.bin, tc.appRef))) {
    return {
      ok: false,
      output: tc.supported
        ? `could not provision the ${tc.appRef} toolchain from the catalog.`
        : `the ${tc.appRef} toolchain isn't available in the catalog yet — ${project.entry} can't be built in the VM. Try Node.js or TypeScript.`,
    };
  }

  if (buildCmd) {
    log(`building: ${buildCmd}`);
    const b = await runShellCommand(handle.vm, bus, buildCmd, { timeoutMs: 90_000 });
    if (b.exitCode !== 0 || b.timedOut) {
      return {
        ok: false,
        output: `build failed${b.timedOut ? " (timed out)" : ""}:\n${b.output}`,
        data: { stage: "build" },
      };
    }
  }

  log(`running: ${runCmd}`);
  const r = await runShellCommand(handle.vm, bus, runCmd, { timeoutMs: 60_000 });
  const benign = r.exitCode === 134; // warm Node exits 134 after correct output
  if (project.port != null) handle.showPreview(project.port);
  return {
    ok: !r.timedOut && (r.exitCode === 0 || benign),
    output: r.output || "(no output)",
    data: { stage: "run", exitCode: r.exitCode },
  };
}

/** The `build_and_run` registry tool: an inline project → build → run. */
export function createBuildTool(handle: TerminalHandle, bus: StdoutBus): AssistantTool {
  return {
    name: "build_and_run",
    description:
      "Write a project (one or more files) into the VM, compile it with the right toolchain (Node.js or TypeScript today), run it, and return the output.",
    kind: "exec",
    inputSchema: {
      type: "object",
      properties: {
        files: {
          type: "array",
          items: {
            type: "object",
            properties: { path: { type: "string" }, content: { type: "string" } },
            required: ["path", "content"],
          },
        },
        entry: { type: "string", description: "Entrypoint path (one of files)." },
        toolchain: { type: "string", description: '"node" | "typescript" | "zig".' },
        port: { type: "number", description: "Port to reveal in Preview (servers only)." },
      },
      required: ["files", "entry"],
      additionalProperties: false,
    },
    async execute(args) {
      const files = Array.isArray(args.files) ? (args.files as GeneratedFile[]) : [];
      const entry = typeof args.entry === "string" ? args.entry : files[0]?.path;
      if (!files.length || !entry) return { ok: false, output: "build_and_run: no files/entry" };
      return buildAndRunProject(
        handle,
        bus,
        {
          files,
          entry,
          toolchain: typeof args.toolchain === "string" ? args.toolchain : undefined,
          port: typeof args.port === "number" ? args.port : undefined,
        },
      );
    },
  };
}
