// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run terminal; dual-licensed - see LICENSE.md.

// WebMCP: expose the same VM tool registry to Chrome's built-in agent via
// `document.modelContext` (the `navigator.modelContext` spelling is the older,
// deprecated entry point — we accept either). This is a *second* front-end over
// the one registry: the in-page Prompt-API session and Chrome's agent both drive
// the identical tools. Origin-trial / flag-gated, so it silently no-ops when the
// API is absent. Returns an unregister to call on teardown.

import type { AssistantTool } from "./types";

export function registerWebMcpTools(tools: AssistantTool[]): () => void {
  const ctx =
    (typeof document !== "undefined" ? document.modelContext : undefined) ??
    (typeof navigator !== "undefined" ? navigator.modelContext : undefined);
  if (!ctx || typeof ctx.registerTool !== "function") return () => {};

  const controller = new AbortController();
  for (const tool of tools) {
    try {
      ctx.registerTool(
        {
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          async execute(args: Record<string, unknown>): Promise<string> {
            const res = await tool.execute(args ?? {});
            return res.output;
          },
          annotations: {
            readOnlyHint: !!tool.readOnly,
            // Guest output is untrusted (it's whatever the sandboxed program printed).
            untrustedContentHint: true,
          },
        },
        { signal: controller.signal },
      );
    } catch (e) {
      console.warn("[assistant] WebMCP registerTool failed:", tool.name, e);
    }
  }
  return () => controller.abort();
}
