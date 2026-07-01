// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run terminal; dual-licensed - see LICENSE.md.

// The codegen playground flow: ask the active model for a project, write it into
// the VFS, build and run it in the VM, and stream progress back. Nano returns a
// single small script (experimental); a cloud adapter returns a real multi-file
// project. On a build/run failure the model gets one "fix" attempt with the
// error fed back (worthwhile for cloud, best-effort for Nano).

import type { TerminalHandle } from "../main";
import { StdoutBus } from "./stdout-bus";
import { buildAndRunProject } from "./build";
import type { GeneratedProject, ModelAdapter, ToolResult } from "./types";

export interface CodegenUI {
  onStatus(line: string): void;
  onProject(project: GeneratedProject): void;
  onOutput(result: ToolResult): void;
}

/** Generate → build → run a project for `spec`, with one fix retry on failure. */
export async function runCodegen(
  adapter: ModelAdapter,
  handle: TerminalHandle,
  bus: StdoutBus,
  spec: string,
  ui: CodegenUI,
): Promise<void> {
  const multiFile = adapter.id !== "nano";

  ui.onStatus("generating…");
  let project: GeneratedProject;
  try {
    project = await adapter.generateProject(spec, { multiFile });
  } catch (e) {
    ui.onOutput({ ok: false, output: `generation failed: ${(e as Error).message}` });
    return;
  }
  ui.onProject(project);

  let result = await buildAndRunProject(handle, bus, project, ui.onStatus);
  ui.onOutput(result);

  // One fix attempt: feed the error back. Skip if it already worked.
  if (!result.ok) {
    ui.onStatus("attempting a fix…");
    try {
      const fixSpec =
        `${spec}\n\nThe previous attempt failed with:\n${result.output}\n\nFix it and return the corrected project.`;
      const fixed = await adapter.generateProject(fixSpec, { multiFile });
      ui.onProject(fixed);
      result = await buildAndRunProject(handle, bus, fixed, ui.onStatus);
      ui.onOutput(result);
    } catch (e) {
      ui.onStatus(`fix failed: ${(e as Error).message}`);
    }
  }
}

/** Starter templates that lift the small on-device model's hit rate. */
export const CODEGEN_TEMPLATES: ReadonlyArray<{ label: string; spec: string }> = [
  { label: "HTTP hello server", spec: "an HTTP server on port 8080 that responds 'hello from the VM'" },
  { label: "CLI arg echo", spec: "a Node CLI that prints its arguments reversed" },
  { label: "FS walk", spec: "a script that lists every file under /app recursively with sizes" },
  { label: "Fibonacci", spec: "a script that prints the first 15 Fibonacci numbers" },
];
