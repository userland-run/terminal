// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run terminal; dual-licensed - see LICENSE.md.

// The conversational agent loop. Model-agnostic: it takes the active adapter (via
// a getter so the model picker can switch it live) and the shared tool registry,
// maps a user turn to at most one tool call (Gemini Nano can't reliably chain),
// executes it, and produces a short reply. Chat/none turns stream a plain reply.
// Codegen is handled separately (codegen.ts) since it needs the build pipeline.

import type { AssistantTool, ChatTurn, ModelAdapter, ToolResult } from "./types";

/** UI sink the panel implements to render the turn as it unfolds. */
export interface AssistantUI {
  onToolStart(name: string, args: Record<string, unknown>): void;
  onToolResult(name: string, res: ToolResult): void;
  onReplyDelta(delta: string): void;
  onReplyDone(text: string): void;
  onError(message: string): void;
}

export class Assistant {
  private history: ChatTurn[] = [];

  constructor(
    private readonly tools: AssistantTool[],
    private readonly getAdapter: () => ModelAdapter,
  ) {}

  get turns(): ReadonlyArray<ChatTurn> {
    return this.history;
  }

  reset(): void {
    this.history = [];
  }

  /** Handle one user message end-to-end, driving `ui` as it progresses. */
  async send(text: string, ui: AssistantUI): Promise<void> {
    const adapter = this.getAdapter();
    this.history.push({ role: "user", content: text });
    let reply = "";
    try {
      const decision = await adapter.route(text, this.tools, this.history.slice(0, -1));
      const tool = this.tools.find((t) => t.name === decision.tool);

      if (!tool) {
        // "chat" / "none" / unknown → plain reply (prefer the model's `say`).
        if (decision.say && decision.say.trim()) {
          reply = decision.say.trim();
          ui.onReplyDelta(reply);
        } else {
          reply = await adapter.chat(text, this.history.slice(0, -1), (d) => ui.onReplyDelta(d));
        }
      } else {
        ui.onToolStart(tool.name, decision.args);
        const res = await tool.execute(decision.args ?? {});
        ui.onToolResult(tool.name, res);
        reply = (decision.say && decision.say.trim()) || summarize(tool.name, res);
        ui.onReplyDelta(reply);
      }
    } catch (e) {
      const msg = (e as Error).message || "the assistant errored";
      ui.onError(msg);
      this.history.push({ role: "assistant", content: `error: ${msg}` });
      return;
    }
    this.history.push({ role: "assistant", content: reply });
    ui.onReplyDone(reply);
  }
}

/** A terse, honest confirmation for a completed tool call. */
function summarize(name: string, res: ToolResult): string {
  if (!res.ok) return `\`${name}\` didn't succeed — see the output above.`;
  switch (name) {
    case "run_shell":
    case "run_node":
      return "Done — output is above.";
    case "list_dir":
      return "Here's the listing.";
    case "read_file":
      return "Here's the file.";
    case "write_file":
      return "File written.";
    case "install_app":
      return "Installed.";
    case "serve":
      return "Server started — check the Preview tab.";
    case "open_file":
      return "Opened it in the editor.";
    default:
      return "Done.";
  }
}
