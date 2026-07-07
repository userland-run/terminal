// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run terminal; dual-licensed - see LICENSE.md.

// The conversational agent loop. Model-agnostic: it takes the active adapter (via
// a getter so the model picker can switch it live) and the shared tool registry,
// maps a user turn to at most one tool call (Gemini Nano can't reliably chain),
// executes it, and produces a short reply. Chat/none turns stream a plain reply.
// Codegen is handled separately (codegen.ts) since it needs the build pipeline.
//
// Permission modes (Claude-Code-style) gate the single tool call: `plan` blocks
// mutation, `ask` (default) confirms edit/exec/network tools via the UI's
// approval hook, `acceptEdits` auto-runs edits but confirms exec/network, and
// `auto` runs everything. A UI without an approval hook (WebMCP, the guest
// bridge, headless callers) auto-approves — those paths carry their own trust
// boundary and have no surface to render a prompt.

import type {
  AgentMessage,
  AgentTurn,
  ApprovalDecision,
  AssistantMode,
  AssistantTool,
  ChatTurn,
  ModelAdapter,
  ToolKind,
  ToolResult,
  TurnMetrics,
} from "./types";

/** UI sink the panel implements to render the turn as it unfolds. */
export interface AssistantUI {
  onToolStart(name: string, args: Record<string, unknown>): void;
  onToolResult(name: string, res: ToolResult): void;
  onReplyDelta(delta: string): void;
  onReplyDone(text: string): void;
  onError(message: string): void;
  /** Streaming `<think>` reasoning (native agentic models). Rendered in a
   *  dimmed, collapsible block separate from the answer. */
  onReasoning?(delta: string): void;
  /** The current step's reasoning is complete — collapse its block. */
  onReasoningDone?(): void;
  /** A decomposed plan (ordered step descriptions), rendered as a checklist. */
  onPlan?(steps: string[]): void;
  /** Live generation speed for the tok/s readouts (optional). */
  onMetrics?(m: TurnMetrics): void;
  /**
   * Ask the user to approve a mutating tool call. Resolves to their choice.
   * Absent → the caller has no approval surface, so the call auto-approves.
   */
  requestApproval?(req: {
    tool: string;
    kind: ToolKind;
    args: Record<string, unknown>;
    summary: string;
  }): Promise<ApprovalDecision>;
}

/** Whether a tool call runs freely, needs confirmation, or is blocked. */
export type Gate = "allow" | "ask" | "block";

/** Pure policy: how `mode` treats a tool of capability `kind`. */
export function gateFor(mode: AssistantMode, kind: ToolKind): Gate {
  if (kind === "read") return "allow"; // reads never mutate — always fine
  if (mode === "auto") return "allow";
  if (mode === "plan") return "block";
  if (mode === "acceptEdits") return kind === "edit" ? "allow" : "ask";
  return "ask"; // "ask": confirm every mutation
}

export class Assistant {
  private history: ChatTurn[] = [];
  private mode: AssistantMode = "ask";
  private readonly alwaysAllow = new Set<string>();

  constructor(
    private readonly tools: AssistantTool[],
    private readonly getAdapter: () => ModelAdapter,
  ) {}

  get turns(): ReadonlyArray<ChatTurn> {
    return this.history;
  }

  getMode(): AssistantMode {
    return this.mode;
  }

  setMode(mode: AssistantMode): void {
    this.mode = mode;
  }

  reset(): void {
    this.history = [];
  }

  /** Handle one user message end-to-end, driving `ui` as it progresses. */
  async send(text: string, ui: AssistantUI, signal?: AbortSignal): Promise<void> {
    const adapter = this.getAdapter();
    // Ornith and other natively-agentic models run the multi-step `<tool_call>`
    // loop; everyone else uses the single-shot route-then-execute flow below.
    if (adapter.agentStep) return this.sendAgentic(adapter, text, ui, signal);
    this.history.push({ role: "user", content: text });
    let reply = "";
    try {
      const decision = await adapter.route(text, this.tools, this.history.slice(0, -1), signal);
      const tool = this.tools.find((t) => t.name === decision.tool);

      if (!tool) {
        // "chat" / "none" / unknown → plain reply (prefer the model's `say`).
        if (decision.say && decision.say.trim()) {
          reply = decision.say.trim();
          ui.onReplyDelta(reply);
        } else {
          reply = await adapter.chat(
            text,
            this.history.slice(0, -1),
            (d) => ui.onReplyDelta(d),
            (m) => ui.onMetrics?.(m),
            signal,
          );
        }
      } else {
        const kind = tool.kind ?? "exec";
        const args = decision.args ?? {};
        let gate = gateFor(this.mode, kind);
        if (gate === "ask" && this.alwaysAllow.has(tool.name)) gate = "allow";

        if (gate === "block") {
          // Plan mode: describe the intended action, don't run it.
          const hint = summarizeArgs(tool.name, args);
          reply =
            `Plan mode — I'd run \`${tool.name}\`${hint ? " " + hint : ""}. ` +
            `Switch to Ask, Accept Edits, or Auto to execute it.`;
          ui.onReplyDelta(reply);
        } else {
          if (gate === "ask") {
            const choice = ui.requestApproval
              ? await ui.requestApproval({
                  tool: tool.name,
                  kind,
                  args,
                  summary: summarizeArgs(tool.name, args),
                })
              : "approve";
            if (choice === "reject") {
              reply = `Skipped \`${tool.name}\` — you rejected it.`;
              ui.onReplyDelta(reply);
              this.history.push({ role: "assistant", content: reply });
              ui.onReplyDone(reply);
              return;
            }
            if (choice === "always") this.alwaysAllow.add(tool.name);
          }
          ui.onToolStart(tool.name, args);
          const res = await tool.execute(args);
          ui.onToolResult(tool.name, res);
          reply = (decision.say && decision.say.trim()) || summarize(tool.name, res);
          ui.onReplyDelta(reply);
        }
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

  /**
   * Native `<tool_call>` agent loop for models that reason + call tools (Ornith).
   * Each step the model thinks and either calls one tool or answers. A tool call
   * is gated (plan/ask/auto) exactly like the single-shot path, executed, and its
   * output fed back as a `<tool_response>` turn so the model observes it and
   * continues — a read→edit→run→fix loop, bounded by MAX_STEPS.
   */
  private async sendAgentic(
    adapter: ModelAdapter,
    text: string,
    ui: AssistantUI,
    _signal?: AbortSignal,
  ): Promise<void> {
    this.history.push({ role: "user", content: text });
    const transcript: AgentMessage[] = this.history.slice(0, -1).map((t) => ({
      role: t.role as "user" | "assistant",
      content: t.content,
    }));

    // Decompose the request into ordered single-action steps. A 9B sequences
    // "write file A → write file B → serve" far more reliably as separate
    // focused turns than as one self-planned loop (where it fixates on one
    // file). Falls back to the whole request as a single step.
    let steps: string[] = [text];
    if (adapter.plan) {
      try {
        const p = await adapter.plan(text, this.tools);
        if (Array.isArray(p) && p.length > 1) steps = p;
      } catch {
        /* keep the single-step fallback */
      }
    }
    if (steps.length > 1) ui.onPlan?.(steps);

    let budget = 16; // hard cap on total tool-producing agent actions
    let finalReply = "";
    try {
      for (const step of steps) {
        if (budget <= 0) break;
        // Push the step as the active instruction; give it up to 2 agent turns
        // to land its action (one retry if the first doesn't call a tool).
        transcript.push({ role: "user", content: step });
        for (let attempt = 0; attempt < 2 && budget > 0; attempt++) {
          budget--;
          const turn = await adapter.agentStep!(
            transcript,
            this.tools,
            (kind, piece) =>
              kind === "reasoning" ? ui.onReasoning?.(piece) : ui.onReplyDelta(piece),
            (m) => ui.onMetrics?.(m),
          );
          ui.onReasoningDone?.();
          if (!turn.toolCall) {
            if (turn.answer && turn.answer !== "(done)") {
              transcript.push({ role: "assistant", content: turn.answer });
            }
            break; // no tool for this step → move on
          }
          const outcome = await this.runToolCall(turn, ui, transcript);
          if (outcome === "blocked") {
            finalReply = "Plan mode — switch to Ask, Accept Edits, or Auto to execute tools.";
            ui.onReplyDelta(finalReply);
            budget = 0;
            break;
          }
          if (outcome === "rejected") continue; // let it pick a different action
          break; // executed → this step is done
        }
      }
      if (!finalReply) finalReply = steps.length > 1 ? "All steps done." : "Done.";
    } catch (e) {
      const msg = (e as Error).message || "the assistant errored";
      ui.onError(msg);
      this.history.push({ role: "assistant", content: `error: ${msg}` });
      return;
    }
    this.history.push({ role: "assistant", content: finalReply });
    ui.onReplyDone(finalReply);
  }

  /** Gate + execute one tool call, stream it to `ui`, and append the assistant
   *  turn + tool result to `transcript`. Returns the outcome. */
  private async runToolCall(
    turn: AgentTurn,
    ui: AssistantUI,
    transcript: AgentMessage[],
  ): Promise<"executed" | "rejected" | "blocked" | "unknown"> {
    const call = turn.toolCall!;
    const tool = this.tools.find((t) => t.name === call.name);
    if (!tool) {
      transcript.push({ role: "assistant", content: this.compactAssistant(turn) });
      transcript.push({ role: "tool", name: call.name, content: `error: no such tool "${call.name}".` });
      return "unknown";
    }
    const kind = tool.kind ?? "exec";
    let gate = gateFor(this.mode, kind);
    if (gate === "ask" && this.alwaysAllow.has(tool.name)) gate = "allow";
    if (gate === "block") return "blocked";
    if (gate === "ask") {
      const choice = ui.requestApproval
        ? await ui.requestApproval({
            tool: tool.name,
            kind,
            args: call.args,
            summary: summarizeArgs(tool.name, call.args),
          })
        : "approve";
      if (choice === "reject") {
        transcript.push({ role: "assistant", content: this.compactAssistant(turn) });
        transcript.push({ role: "tool", name: tool.name, content: "The user rejected this call." });
        return "rejected";
      }
      if (choice === "always") this.alwaysAllow.add(tool.name);
    }
    ui.onToolStart(tool.name, call.args);
    const res = await tool.execute(call.args);
    ui.onToolResult(tool.name, res);
    transcript.push({ role: "assistant", content: this.compactAssistant(turn) });
    transcript.push({
      role: "tool",
      name: tool.name,
      content: (res.output || (res.ok ? "ok" : "error")).slice(0, 600),
    });
    return "executed";
  }

  /** Compact an assistant turn for the transcript: keep a short reasoning trace
   *  and the tool call, but elide large string args (written file bodies) so the
   *  re-prefilled transcript stays within the KV budget across steps. */
  private compactAssistant(turn: AgentTurn): string {
    if (!turn.toolCall) return turn.answer ?? "";
    const args: Record<string, unknown> = { ...turn.toolCall.args };
    for (const k of Object.keys(args)) {
      const v = args[k];
      if (typeof v === "string" && v.length > 120) args[k] = v.slice(0, 40) + "…(written)";
    }
    const think = turn.reasoning ? `<think>\n${turn.reasoning.slice(0, 240)}\n</think>\n` : "";
    return `${think}<tool_call>\n${JSON.stringify({
      name: turn.toolCall.name,
      arguments: args,
    })}\n</tool_call>`;
  }
}

/** A short, human hint for a tool call (path/command), for action + approval lines. */
export function summarizeArgs(name: string, args: Record<string, unknown>): string {
  const a = args ?? {};
  if (name === "run_shell" && typeof a.command === "string") return "`" + a.command + "`";
  if (typeof a.path === "string") return a.path;
  if (typeof a.from === "string" && typeof a.to === "string") return `${a.from} → ${a.to}`;
  if (typeof a.file === "string") return a.file;
  if (typeof a.ref === "string") return a.ref;
  return "";
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
    case "make_dir":
      return "Directory created.";
    case "move_path":
      return "Moved.";
    case "delete_path":
      return "Deleted.";
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
