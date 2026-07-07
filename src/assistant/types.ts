// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run terminal; dual-licensed - see LICENSE.md.

// Shared types for the AI assistant: the model-agnostic ModelAdapter surface,
// the VM tool interface (one registry drives both the in-page router and the
// WebMCP registration), and the host-injected cloud-model config. Kept free of
// any Chrome-API or VM specifics so nano.ts / cloud.ts / tools.ts each depend on
// only this.

/** A JSON Schema fragment (arguments / structured output constraints). */
export type JsonSchema = Record<string, unknown>;

/**
 * Capability class of a tool, used by the chat modes to decide whether a call
 * runs freely, needs confirmation, or is blocked. `read` never mutates the VM;
 * `edit` writes files; `exec` runs commands / installs / servers; `network`
 * reaches off-machine. Absent → treated as `exec` (the safe default).
 */
export type ToolKind = "read" | "edit" | "exec" | "network";

/**
 * The assistant's permission mode (mirrors Claude Code). `plan` blocks every
 * mutating tool and just states the intended action; `ask` (default) confirms
 * before edit/exec/network tools; `acceptEdits` auto-runs edits but still
 * confirms exec/network; `auto` runs everything without asking.
 */
export type AssistantMode = "plan" | "ask" | "acceptEdits" | "auto";

/** Live generation metrics for a turn (drives the tok/s readouts). */
export interface TurnMetrics {
  /** Tokens generated so far this turn. */
  tokens: number;
  elapsedMs: number;
  tokPerSec: number;
  /** Prompt tokens prefilled, when the backend reports it. */
  prefillTokens?: number;
}

/** A pending tool call the user is asked to approve (Ask / Accept-Edits modes). */
export interface ApprovalRequest {
  tool: string;
  kind: ToolKind;
  args: Record<string, unknown>;
  /** A short human summary (command / path) for the approval card. */
  summary: string;
}

/** The user's answer to an {@link ApprovalRequest}. */
export type ApprovalDecision = "approve" | "reject" | "always";

/** Result of running a tool. `output` is the human/agent-readable text. */
export interface ToolResult {
  ok: boolean;
  output: string;
  /** Optional structured payload for programmatic callers. */
  data?: unknown;
}

/**
 * A capability the assistant can invoke against the VM. The same objects are
 * offered to the in-page model (as an enum of names + a JSON-schema args) and to
 * Chrome's agent via `document.modelContext.registerTool`.
 */
export interface AssistantTool {
  name: string;
  description: string;
  /** JSON Schema describing the `args` object passed to {@link execute}. */
  inputSchema: JsonSchema;
  /** True when the tool only reads state (drives WebMCP `readOnlyHint`). */
  readOnly?: boolean;
  /** Capability class for the chat modes' approval gate (default `exec`). */
  kind?: ToolKind;
  execute(args: Record<string, unknown>): Promise<ToolResult>;
}

/** One generated source file. */
export interface GeneratedFile {
  path: string;
  content: string;
}

/** A project the model proposes to write, build, and run in the VM. */
export interface GeneratedProject {
  files: GeneratedFile[];
  /** Entrypoint path (must be one of `files`). */
  entry: string;
  /** "node" | "typescript" | "zig" | … — auto-detected from `entry` if omitted. */
  toolchain?: string;
  /** Override the derived build command (e.g. a custom tsc invocation). */
  buildCmd?: string;
  /** Override the derived run command. */
  runCmd?: string;
  /** Port to reveal in the Preview tab when this is a server. */
  port?: number;
  /** Short model note shown to the user. */
  notes?: string;
}

/** The model's decision for one conversational turn. */
export interface RouteDecision {
  /** A tool name, or "chat" / "none" for a plain reply. */
  tool: string;
  args: Record<string, unknown>;
  /** A natural-language reply when `tool` is "chat"/"none". */
  say?: string;
}

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export type ModelAvailabilityState =
  | "unavailable"
  | "downloadable"
  | "downloading"
  | "available";

export interface AvailabilityInfo {
  state: ModelAvailabilityState;
  /** User-facing hint, e.g. how to enable the flag. */
  detail?: string;
}

/**
 * A model backend. Two ship: {@link createNanoAdapter} (on-device Gemini Nano via
 * the Chrome Prompt API) and {@link createCloudAdapter} (host-injected). The
 * orchestrator and panel depend only on this interface, so model choice is
 * orthogonal to the VM tools and to WebMCP.
 */
/** One entry in a native tool-calling transcript (Ornith agentic loop). */
export interface AgentMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  /** For role "tool": the function whose result `content` holds. */
  name?: string;
}

/**
 * The outcome of one native agentic step: the model's reasoning plus EITHER a
 * tool call to execute OR a final answer. `raw` is the untouched assistant text
 * (reasoning + tool_call/answer) the orchestrator appends to the transcript.
 */
export interface AgentTurn {
  reasoning?: string;
  toolCall?: { name: string; args: Record<string, unknown> };
  answer?: string;
  raw: string;
}

export interface ModelAdapter {
  readonly id: string;
  readonly label: string;
  availability(): Promise<AvailabilityInfo>;
  /** Ensure the model is ready (may trigger a download); reports 0..1 progress. */
  prepare?(onProgress?: (fraction: number) => void): Promise<void>;
  /** Map a user turn to a tool call (or a chat reply). */
  route(
    userText: string,
    tools: AssistantTool[],
    history: ChatTurn[],
    signal?: AbortSignal,
  ): Promise<RouteDecision>;
  /** Generate a project for a codegen spec. `multiFile` hints richer output. */
  generateProject(spec: string, opts?: { multiFile?: boolean }): Promise<GeneratedProject>;
  /**
   * Free-form reply; streams deltas via `onDelta`, reports live generation
   * speed via `onMetrics`, and resolves the full text. `signal` aborts backends
   * that support it (Nano / cloud); the local worker isn't abortable mid-flight.
   */
  chat(
    userText: string,
    history: ChatTurn[],
    onDelta?: (delta: string) => void,
    onMetrics?: (m: TurnMetrics) => void,
    signal?: AbortSignal,
  ): Promise<string>;
  /** Current context usage, when the backend reports it (for a UI meter). */
  usage?(): { used: number; quota: number } | null;
  /**
   * Native agentic step (Ornith-1: `<think>` reasoning + `<tool_call>` XML),
   * present only on models trained for it. The orchestrator runs a multi-step
   * loop around it, feeding each tool's output back as a `<tool_response>` turn
   * until the model answers without a tool call. `onVisible` streams the
   * reasoning/answer text with the tags and tool-call JSON stripped.
   */
  agentStep?(
    transcript: AgentMessage[],
    tools: AssistantTool[],
    onVisible?: (kind: "reasoning" | "answer", text: string) => void,
    onMetrics?: (m: TurnMetrics) => void,
  ): Promise<AgentTurn>;
  /** Release any held session/resources. */
  destroy?(): void;
}

/** A request handed to a host-injected cloud `generate` callback. */
export interface CloudRequest {
  system: string;
  messages: ChatTurn[];
  /** When set, the model must return JSON conforming to this schema. */
  responseSchema?: JsonSchema;
  signal?: AbortSignal;
}

/**
 * Host-injected cloud wiring. Prefer `generate` (keys live in the host's proxy,
 * so the component ships no secrets); `endpoint` is a convenience for a plain
 * JSON HTTP proxy that accepts `{ system, messages, responseSchema }` and returns
 * `{ text }`.
 */
export interface CloudModelConfig {
  label?: string;
  generate?: (req: CloudRequest) => Promise<string>;
  endpoint?: string;
  headers?: Record<string, string>;
}
