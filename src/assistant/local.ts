// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run terminal; dual-licensed - see LICENSE.md.

// "Local GPU" model adapter: fully in-browser inference on WebGPU via the
// nanoinfer engine (Qwen2.5-Coder-1.5B, W4-quantized). Nothing leaves the
// machine — weights are fetched once (OPFS-cached) and the model runs on the
// user's GPU in a dedicated worker, next to (not inside) the VM.

import type {
  AgentMessage,
  AgentTurn,
  AssistantTool,
  AvailabilityInfo,
  ChatTurn,
  GeneratedProject,
  ModelAdapter,
  RouteDecision,
  TurnMetrics,
} from "./types";

export interface LocalModelConfig {
  /** "qwen" (default, 1.5B GGUF) or "ornith" (the 9B GDN hybrid, packed Q4). */
  engine?: "qwen" | "ornith";
  /** Model URL: GGUF for qwen, packed Q4 safetensors for ornith. */
  ggufUrl?: string;
  /** tokenizer.json URL. */
  tokenizerUrl?: string;
  /** Base URL of the nanoinfer wasm-bindgen bundle (js + wasm). */
  engineBase?: string;
  /** KV capacity in tokens (bounds prompt + generation). Default 2048. */
  maxSeq?: number;
  label?: string;
}

// Default weights: the userland-run Hugging Face repo. HF `resolve` URLs
// send `Access-Control-Allow-Origin: *`, so they load from our
// cross-origin-isolated pages; the engine worker's OPFS cache (keyed by
// filename) makes it a one-time download per browser profile. Deployments
// therefore need no local model assets; self-hosters can still point
// `TerminalAssistantConfig.local` at their own URLs.
const HF_MODEL_BASE =
  "https://huggingface.co/userland-run/qwen2.5-coder-1.5b-instruct-q4-nanoinfer/resolve/main";

const HF_ORNITH_BASE =
  "https://huggingface.co/userland-run/ornith-1.0-9b-q4-nanoinfer/resolve/main";

const DEFAULTS = {
  engine: "qwen" as "qwen" | "ornith",
  ggufUrl: `${HF_MODEL_BASE}/qwen2.5-coder-1.5b-instruct-q4_0.gguf`,
  tokenizerUrl: `${HF_MODEL_BASE}/tokenizer.json`,
  engineBase: "/nanoinfer-engine",
  maxSeq: 2048,
};

const ORNITH_DEFAULTS = {
  ggufUrl: `${HF_ORNITH_BASE}/ornith-9b-q4.safetensors`,
  tokenizerUrl: `${HF_ORNITH_BASE}/tokenizer.json`,
};

/**
 * Ornith / Qwen3.5 ChatML: same im_start/im_end framing as Qwen2.5, but the
 * assistant cue opens a <think> block (reasoning model). The panel closes it
 * immediately — an empty think block skips reasoning for snappy replies.
 */
export function buildOrnithPrompt(
  system: string,
  history: ChatTurn[],
  userText: string,
  budget: number,
): string {
  const head = `<|im_start|>system\n${system}<|im_end|>\n`;
  const tail =
    `<|im_start|>user\n${userText}<|im_end|>\n` +
    `<|im_start|>assistant\n<think>\n\n</think>\n\n`;
  let used = estimateTokens(head) + estimateTokens(tail);
  const kept: string[] = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const turn = history[i];
    const block = `<|im_start|>${turn.role}\n${turn.content}<|im_end|>\n`;
    const cost = estimateTokens(block);
    if (used + cost > budget) break;
    used += cost;
    kept.unshift(block);
  }
  return head + kept.join("") + tail;
}

const SYSTEM_PROMPT =
  "You are the assistant inside a browser terminal that runs a real Linux/Node.js " +
  "userland (a RISC-V emulator). You drive the terminal by choosing tools and you " +
  "write real, runnable code that is executed inside the sandbox. Be concise.";

// --- Ornith-1 native agentic path (§ "how the model was trained") -----------
// Ornith-1 is a reasoning + native-`<tool_call>` agentic model. Unlike the
// forced-choice router, the agentic path lets it OPEN a `<think>` block, reason,
// then emit a Qwen3-style `<tool_call>` XML block; the orchestrator feeds each
// tool result back as a `<tool_response>` turn and re-enters generation.

/** The Ornith-1 recommended agentic sampling profile (from the model card). */
export const ORNITH_AGENT_SAMPLING = { temperature: 0.6, topP: 0.95, topK: 20 };

const ORNITH_AGENT_SYSTEM_BASE =
  "You are a coding agent operating a real Linux/Node.js userland (a RISC-V " +
  "emulator) inside a browser terminal. You accomplish tasks ONLY by calling " +
  "tools — never write code, file contents, or command output directly in your " +
  "reply. Think briefly in <think>…</think>, then emit exactly ONE <tool_call> " +
  "and stop; you will receive its <tool_response> and continue. File contents " +
  "and code MUST go in the write_file tool's `content` argument, never in prose. " +
  "When every step is finished, reply with a one-line plain-text summary and no " +
  "tool call.";

/** Qwen3-style system block: the base prompt, a `<tools>` schema list, and a
 *  worked example — few-shot format priming lifts a 9B's tool-call adherence
 *  far more than instructions alone. */
function ornithToolsSystem(tools: AssistantTool[]): string {
  const defs = tools
    .map((t) =>
      JSON.stringify({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      }),
    )
    .join("\n");
  const example =
    "Example — creating a file looks EXACTLY like this:\n" +
    "<tool_call>\n" +
    '{"name": "write_file", "arguments": {"path": "/app/hello.js", "content": "console.log(\\"hi\\")\\n"}}\n' +
    "</tool_call>";
  return (
    `${ORNITH_AGENT_SYSTEM_BASE}\n\n# Tools\n\n` +
    "Emit a call as one block (and nothing else after it):\n" +
    '<tool_call>\n{"name": <function-name>, "arguments": <arguments-object>}\n</tool_call>\n\n' +
    `Available functions (JSON schemas inside <tools>):\n<tools>\n${defs}\n</tools>\n\n${example}`
  );
}

/** Build the full ChatML prompt for one agentic step; the assistant cue is left
 *  OPEN so the model emits its own `<think>` reasoning before acting. */
function buildOrnithAgentPrompt(tools: AssistantTool[], transcript: AgentMessage[]): string {
  let s = `<|im_start|>system\n${ornithToolsSystem(tools)}<|im_end|>\n`;
  for (const m of transcript) {
    if (m.role === "tool") {
      s += `<|im_start|>user\n<tool_response>\n${m.content}\n</tool_response><|im_end|>\n`;
    } else {
      s += `<|im_start|>${m.role}\n${m.content}<|im_end|>\n`;
    }
  }
  return s + "<|im_start|>assistant\n"; // open <think>
}

/** Parse a `{ … }` object from the first brace, matching to its close AND
 *  tolerating raw control characters inside string values — small models often
 *  emit unescaped newlines/tabs in a file's `content`, which strict JSON.parse
 *  rejects. Returns null if no balanced object parses. */
function parseLooseJsonObject(s: string): Record<string, unknown> | null {
  const start = s.indexOf("{");
  if (start < 0) return null;
  let out = "";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i]!;
    if (inStr) {
      if (esc) {
        out += c;
        esc = false;
      } else if (c === "\\") {
        out += c;
        esc = true;
      } else if (c === '"') {
        out += c;
        inStr = false;
      } else if (c === "\n") out += "\\n";
      else if (c === "\r") out += "\\r";
      else if (c === "\t") out += "\\t";
      else out += c;
    } else {
      out += c;
      if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(out) as Record<string, unknown>;
          } catch {
            return null;
          }
        }
      }
    }
  }
  return null;
}

/** Find a tool-call object `{"name": …, "arguments": …}` anywhere in `region`,
 *  with OR without a `<tool_call>` wrapper (Ornith emits both). */
function findToolCallObject(region: string): Record<string, unknown> | null {
  const at = region.search(/\{\s*"name"\s*:/);
  return at < 0 ? null : parseLooseJsonObject(region.slice(at));
}

/** Last-resort extraction of the `content` string from a tool-call wrapper whose
 *  JSON won't parse — file bodies (HTML/code) full of unescaped quotes defeat a
 *  strict parse, but `content` is the final field, so take from `"content": "`
 *  to the trailing `"}}` and JSON-unescape. Returns null if no such field. */
function extractWrappedContent(text: string): string | null {
  const m = text.match(/"content"\s*:\s*"/);
  if (!m || m.index === undefined) return null;
  let s = text.slice(m.index + m[0].length);
  s = s.replace(/"\s*\}\s*\}\s*$/, "").replace(/"\s*$/, ""); // strip trailing "}} / "
  return s
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\\//g, "/")
    .replace(/\\\\/g, "\\");
}

/** Split one assistant generation into reasoning + (a tool call | a final answer). */
export function parseOrnithAgentTurn(raw: string): AgentTurn {
  const thinkM = raw.match(/<think>([\s\S]*?)<\/think>/);
  const reasoning = thinkM ? thinkM[1]!.trim() : undefined;
  const closeThink = raw.indexOf("</think>");
  const rest = closeThink >= 0 ? raw.slice(closeThink + "</think>".length) : raw;
  const obj = findToolCallObject(rest);
  if (obj && typeof obj.name === "string") {
    const args = (obj.arguments ?? obj.args ?? {}) as Record<string, unknown>;
    return { reasoning, toolCall: { name: obj.name as string, args }, raw };
  }
  const answer = rest
    .replace(/<\/?think>/g, "")
    .replace(/<\/?tool_call>/g, "")
    .trim();
  return { reasoning, answer: answer || "(done)", raw };
}

/** Streaming filter that classifies the live token stream so the UI can render
 *  it as a modern agent transcript: everything up to `</think>` is "reasoning";
 *  after it is the plain "answer"; the `<tool_call>` JSON is suppressed (it's
 *  shown as a tool card, never dumped as text). `<think>`/`</think>` tags are
 *  stripped. A short tail is held back so a partial tag never leaks. */
function makeVisibleStreamer(
  onVisible?: (kind: "reasoning" | "answer", text: string) => void,
  initialPhase: "reasoning" | "answer" = "reasoning",
): (piece: string) => void {
  const HOLD = 12;
  let buf = "";
  let cursor = 0; // chars of `buf` already forwarded
  let phase: "reasoning" | "answer" = initialPhase;
  let stopped = false;

  const emitReasoning = (s: string) => {
    const t = s.replace(/<\/?think>/g, "");
    if (t && onVisible) onVisible("reasoning", t);
  };
  const emitAnswer = (s: string) => {
    if (s && onVisible) onVisible("answer", s);
  };

  const feed = (upto: number) => {
    while (cursor < upto) {
      if (phase === "reasoning") {
        const close = buf.indexOf("</think>", cursor);
        if (close >= 0 && close + 8 <= upto) {
          emitReasoning(buf.slice(cursor, close));
          cursor = close + 8; // consume "</think>"
          phase = "answer";
          continue;
        }
        emitReasoning(buf.slice(cursor, upto));
        cursor = upto;
      } else {
        emitAnswer(buf.slice(cursor, upto));
        cursor = upto;
      }
    }
  };

  return (piece: string) => {
    if (stopped) return;
    buf += piece;
    const tc = buf.indexOf("<tool_call>");
    const nameM = buf.search(/\{\s*"name"\s*:/); // a bare (untagged) tool-call JSON
    const cut = Math.min(tc < 0 ? Infinity : tc, nameM < 0 ? Infinity : nameM);
    if (cut !== Infinity) {
      feed(cut); // flush prose before the call, then suppress the JSON body
      stopped = true;
      return;
    }
    feed(Math.max(cursor, buf.length - HOLD));
  };
}

interface WorkerEvent {
  type: "progress" | "ready" | "delta" | "done" | "error";
  id?: number;
  phase?: "download" | "upload";
  label?: string;
  loaded?: number;
  total?: number;
  text?: string;
  message?: string;
  adapter?: string;
  stats?: Record<string, number>;
  /** Result of a "choose" (L3 forced-choice) request. */
  choice?: string;
  /** Result of a "snapshot" request (L1 checkpoint id). */
  ckpt?: number;
  /** Result of a "json" (schema-constrained) request. */
  json?: string;
}

/** Rough token estimate for history trimming (~3.5 chars/token for code). */
export const estimateTokens = (s: string) => Math.ceil(s.length / 3.5);

/**
 * Build the Qwen ChatML template: system block, as many recent turns as fit the
 * token `budget`, then the user turn and the assistant cue. Shared by the panel
 * adapter and the guest-facing LLM bridge (llm-bridge.ts) so both produce the
 * exact prompt shape the model was tuned for.
 */
export function buildQwenPrompt(
  system: string,
  history: ChatTurn[],
  userText: string,
  budget: number,
): string {
  const head = `<|im_start|>system\n${system}<|im_end|>\n`;
  const tail = `<|im_start|>user\n${userText}<|im_end|>\n<|im_start|>assistant\n`;
  let used = estimateTokens(head) + estimateTokens(tail);
  const kept: string[] = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const turn = history[i];
    const block = `<|im_start|>${turn.role}\n${turn.content}<|im_end|>\n`;
    const cost = estimateTokens(block);
    if (used + cost > budget) break;
    used += cost;
    kept.unshift(block);
  }
  return head + kept.join("") + tail;
}

/**
 * Lower-level handle around the engine worker: the panel-facing
 * {@link ModelAdapter} plus raw-prompt streaming access for the guest-facing
 * OpenAI facade (llm-bridge.ts), which needs its own chat template and SSE
 * framing rather than the adapter's route/chat semantics.
 */
export interface LocalModel {
  /** The panel-facing adapter (unchanged public surface). */
  adapter: ModelAdapter;
  /** KV capacity in tokens (bounds prompt + generation). */
  readonly maxSeq: number;
  /** True once the engine is initialized (weights on the GPU). */
  isReady(): boolean;
  /** True while a generation is in flight (single-session engine). */
  isBusy(): boolean;
  /** Initialize the engine (may download weights); same as adapter.prepare. */
  ensureReady(onProgress?: (fraction: number) => void): Promise<void>;
  /** Stream a completion for a fully-templated raw prompt. */
  rawGenerate(prompt: string, steps: number, onDelta?: (delta: string) => void): Promise<string>;
  /** Forced choice over a fully-templated raw prompt (guaranteed-valid pick). */
  rawChoose(prompt: string, choices: string[]): Promise<string>;
  /** Schema-constrained JSON for a fully-templated raw prompt (guaranteed to parse + conform). */
  rawJson(prompt: string, schema: object): Promise<string>;
}

export function createLocalModel(config: LocalModelConfig = {}): LocalModel {
  const cfg = {
    ...DEFAULTS,
    ...(config.engine === "ornith" ? ORNITH_DEFAULTS : {}),
    ...config,
  };
  const isOrnith = cfg.engine === "ornith";
  let worker: Worker | null = null;
  let ready = false;
  let preparing = false;
  let inFlight = 0;
  let nextId = 1;
  let lastUsage: { used: number; quota: number } | null = null;
  let agentSeed = 0; // varies the sampler seed per agentic step

  // --- Append-only conversation KV (spec §4.1 L1) ---
  // The engine retains the KV across turns, so a continuing conversation only
  // prefills its NEWEST turn (never the history). `kvTurns` is the turn list
  // the KV currently represents (system prompt implied); null = no live
  // conversation in the KV. Between turns the KV sits mid-assistant-turn (no
  // closing <|im_end|>), so every appended delta starts by closing it.
  let kvTurns: ChatTurn[] | null = null;
  let kvPos = 0;
  // >0 while routing runs inside a snapshot/restore window: one-shot "chat"
  // generations in that window reset the KV but the checkpoint restores it,
  // so they must not invalidate `kvTurns`.
  let kvProtected = 0;

  const handlers = new Map<number, (ev: WorkerEvent) => void>();

  function spawn(): Worker {
    if (worker) return worker;
    worker = new Worker(new URL("./local-worker.ts", import.meta.url), { type: "module" });
    worker.addEventListener("message", (event: MessageEvent<WorkerEvent>) => {
      const ev = event.data;
      if (ev.id !== undefined) handlers.get(ev.id)?.(ev);
      else handlers.get(0)?.(ev); // init-phase events
    });
    return worker;
  }

  /** Build the engine's chat template, trimming old turns to fit the KV. */
  const buildPrompt = (userText: string, history: ChatTurn[], budget: number) =>
    isOrnith
      ? buildOrnithPrompt(SYSTEM_PROMPT, history, userText, budget)
      : buildQwenPrompt(SYSTEM_PROMPT, history, userText, budget);

  /** Send one worker request; resolves on "done" with accumulated delta text.
   *  When `onMetrics` is set, reports live tok/s (one delta == one token) and a
   *  precise final rate from the engine's `done` stats. */
  function request(
    msg: Record<string, unknown>,
    onDelta?: (d: string) => void,
    onMetrics?: (m: TurnMetrics) => void,
  ): Promise<WorkerEvent & { text: string }> {
    const w = spawn();
    const id = nextId++;
    inFlight++;
    const t0 = performance.now();
    let gen = 0;
    return new Promise((resolve, reject) => {
      let text = "";
      handlers.set(id, (ev) => {
        if (ev.type === "delta") {
          text += ev.text ?? "";
          onDelta?.(ev.text ?? "");
          if (onMetrics) {
            gen += 1; // the worker posts exactly one delta per generated token
            const elapsedMs = performance.now() - t0;
            onMetrics({ tokens: gen, elapsedMs, tokPerSec: gen / (elapsedMs / 1000 || 1) });
          }
        } else if (ev.type === "done") {
          handlers.delete(id);
          inFlight--;
          if (onMetrics) {
            const s = ev.stats ?? {};
            const elapsedMs = performance.now() - t0;
            const tokens = s.generated ?? gen;
            onMetrics({
              tokens,
              elapsedMs,
              tokPerSec: tokens / (elapsedMs / 1000 || 1),
              prefillTokens: s.prefill_tokens,
            });
          }
          resolve({ ...ev, text });
        } else if (ev.type === "error") {
          handlers.delete(id);
          inFlight--;
          reject(new Error(ev.message ?? "local model error"));
        }
      });
      w.postMessage({ ...msg, id });
    });
  }

  async function generate(
    prompt: string,
    steps: number,
    onDelta?: (d: string) => void,
  ): Promise<string> {
    // A one-shot generation resets the session KV; outside a snapshot window
    // that kills any live append-only conversation.
    if (kvProtected === 0) kvTurns = null;
    const ev = await request({ type: "chat", prompt, steps }, onDelta);
    const s = ev.stats ?? {};
    lastUsage = {
      used: (s.prefill_tokens ?? 0) + (s.generated ?? 0),
      quota: cfg.maxSeq,
    };
    return ev.text;
  }

  // --- Append-only chat path ---

  const sysBlock = () => `<|im_start|>system\n${SYSTEM_PROMPT}<|im_end|>\n`;
  // Ornith (Qwen3.5) is a reasoning model: the assistant cue force-closes an
  // empty <think> block so replies start immediately.
  const assistantCue = isOrnith
    ? "<|im_start|>assistant\n<think>\n\n</think>\n\n"
    : "<|im_start|>assistant\n";
  /** A turn appended onto a KV that sits mid-assistant-turn. */
  const midTurn = (role: string, content: string) =>
    `<|im_end|>\n<|im_start|>${role}\n${content}`;

  const isPrefix = (prefix: ChatTurn[], full: ChatTurn[]) =>
    prefix.length <= full.length &&
    prefix.every((t, i) => full[i]!.role === t.role && full[i]!.content === t.content);

  /** Most recent history turns that fit `budget` estimated tokens. */
  function trimHistory(history: ChatTurn[], budget: number): ChatTurn[] {
    let used = 0;
    let start = history.length;
    while (start > 0 && used + estimateTokens(history[start - 1]!.content) + 8 <= budget) {
      used += estimateTokens(history[start - 1]!.content) + 8;
      start--;
    }
    return history.slice(start);
  }

  /**
   * Streamed chat that keeps the conversation KV across turns. If the KV holds
   * a prefix of `history`, only the missing turns (e.g. a routed tool turn's
   * user text + canned reply) and the new user turn are prefilled — the L1
   * append-only win. Otherwise (first turn, adapter switch, KV clobbered by a
   * raw generation, or near-capacity KV) the conversation is rebuilt once from
   * trimmed history and appends from there.
   */
  async function appendChat(
    userText: string,
    history: ChatTurn[],
    onDelta?: (d: string) => void,
    onMetrics?: (m: TurnMetrics) => void,
  ): Promise<string> {
    const steps = 512;
    if (kvTurns && isPrefix(kvTurns, history)) {
      let delta = "";
      for (const t of history.slice(kvTurns.length)) delta += midTurn(t.role, t.content);
      delta += `${midTurn("user", userText)}<|im_end|>\n${assistantCue}`;
      if (kvPos + estimateTokens(delta) + steps + 64 <= cfg.maxSeq) {
        try {
          return await runAppend(delta, false, userText, history, steps, onDelta, onMetrics);
        } catch {
          kvTurns = null; // fall through to a fresh rebuild
        }
      } else {
        kvTurns = null; // near capacity — rebuild from trimmed history
      }
    }

    const trimmed = trimHistory(
      history,
      cfg.maxSeq - steps - 256 - estimateTokens(userText),
    );
    let text = sysBlock();
    for (const t of trimmed) text += `<|im_start|>${t.role}\n${t.content}<|im_end|>\n`;
    text += `<|im_start|>user\n${userText}<|im_end|>\n${assistantCue}`;
    return runAppend(text, true, userText, trimmed, steps, onDelta, onMetrics);
  }

  async function runAppend(
    text: string,
    reset: boolean,
    userText: string,
    baseTurns: ChatTurn[],
    steps: number,
    onDelta?: (d: string) => void,
    onMetrics?: (m: TurnMetrics) => void,
  ): Promise<string> {
    const ev = await request({ type: "generateAppend", text, steps, reset }, onDelta, onMetrics);
    const s = ev.stats ?? {};
    console.debug(
      `[assistant] local kv ${reset ? "rebuild" : "append"}: prefill ${s.prefill_tokens} tok, ` +
        `kv_pos ${kvPos} -> ${s.kv_pos}`,
    );
    kvPos = s.kv_pos ?? 0;
    lastUsage = { used: kvPos, quota: cfg.maxSeq };
    kvTurns = [
      ...baseTurns,
      { role: "user", content: userText },
      { role: "assistant", content: ev.text },
    ];
    return ev.text;
  }

  /**
   * Run `work` (routing prompts, arg-fill — anything that clobbers the KV)
   * inside an L1 snapshot/restore window so a live conversation KV survives.
   * Snapshot and restore are sub-millisecond GPU-GPU copies.
   */
  async function kvNeutral<T>(work: () => Promise<T>): Promise<T> {
    if (kvTurns === null) return work();
    let ckpt: number | undefined;
    try {
      ckpt = (await request({ type: "snapshot" })).ckpt;
    } catch {
      kvTurns = null; // can't protect the KV — treat conversation as lost
      return work();
    }
    kvProtected++;
    try {
      return await work();
    } finally {
      kvProtected--;
      try {
        await request({ type: "restore", ckpt });
        await request({ type: "dropCkpt", ckpt });
      } catch {
        kvTurns = null; // restore failed — conversation KV is gone
      }
    }
  }

  /**
   * L3 forced choice: return exactly one of `choices` (the engine masks the
   * sampler to the tokenized options, so the result is guaranteed valid). Used
   * for reliable tool routing — no JSON parsing, no invalid-tool fallback.
   */
  function chooseOne(prompt: string, choices: string[], raw = false): Promise<string> {
    if (kvProtected === 0) kvTurns = null; // constrained decode resets the KV
    const w = spawn();
    const id = nextId++;
    inFlight++;
    return new Promise((resolve, reject) => {
      handlers.set(id, (ev) => {
        if (ev.type === "done") {
          handlers.delete(id);
          inFlight--;
          resolve(ev.choice ?? choices[0]!);
        } else if (ev.type === "error") {
          handlers.delete(id);
          inFlight--;
          reject(new Error(ev.message ?? "local model choose error"));
        }
      });
      w.postMessage({ type: "choose", id, prompt, choices, raw });
    });
  }

  /**
   * L3 full-grammar generation: the result is GUARANTEED to be a JSON
   * document conforming to `schema` (engine-side byte-level masking). Used
   * for tool-argument filling; rejects when the schema falls outside the
   * engine's subset, in which case callers fall back to free-form JSON.
   */
  async function jsonOne(prompt: string, schema: object, raw = false): Promise<string> {
    if (kvProtected === 0) kvTurns = null; // constrained decode resets the KV
    const ev = await request({ type: "json", prompt, schema: JSON.stringify(schema), raw });
    if (typeof ev.json !== "string") throw new Error("no json result");
    return ev.json;
  }

  /** Legacy single-shot JSON routing (fallback when forced-choice errors). */
  async function routeViaJson(
    userText: string,
    tools: AssistantTool[],
    history: ChatTurn[],
  ): Promise<RouteDecision> {
    const names = tools.map((t) => t.name);
    const toolLines = tools.map((t) => `- ${t.name}: ${t.description}`).join("\n");
    const ask =
      `Available tools:\n${toolLines}\n\nThe user said: "${userText}"\n` +
      `Reply with ONLY a JSON object: {"tool": <one of ${JSON.stringify([...names, "chat"])}>, ` +
      `"args": <arguments object for that tool, {} if none>, ` +
      `"say": <your reply text, only when tool is "chat">}`;
    const raw = await generate(buildPrompt(ask, history, cfg.maxSeq - 512), 384);
    try {
      const parsed = parseJson<Partial<RouteDecision>>(raw);
      if (!parsed.tool || (parsed.tool !== "chat" && !names.includes(parsed.tool))) {
        return { tool: "chat", args: {}, say: raw };
      }
      return { tool: parsed.tool, args: parsed.args ?? {}, say: parsed.say };
    } catch {
      return { tool: "chat", args: {}, say: raw };
    }
  }

  async function ensureReady(onProgress?: (fraction: number) => void): Promise<void> {
    if (ready) return;
    preparing = true;
    const w = spawn();
    try {
      await new Promise<void>((resolve, reject) => {
        handlers.set(0, (ev) => {
          if (ev.type === "progress" && ev.total) {
            const f = (ev.loaded ?? 0) / ev.total;
            // download 0..0.8, GPU upload 0.8..1.0
            onProgress?.(ev.phase === "download" ? f * 0.8 : 0.8 + f * 0.2);
          } else if (ev.type === "ready") {
            handlers.delete(0);
            resolve();
          } else if (ev.type === "error") {
            handlers.delete(0);
            reject(new Error(ev.message ?? "engine init failed"));
          }
        });
        w.postMessage({
          type: "init",
          engine: cfg.engine,
          ggufUrl: cfg.ggufUrl,
          tokenizerUrl: cfg.tokenizerUrl,
          engineBase: cfg.engineBase,
          maxSeq: cfg.maxSeq,
        });
      });
      ready = true;
      onProgress?.(1);
    } finally {
      preparing = false;
    }
  }

  function parseJson<T>(raw: string): T {
    const trimmed = raw.trim();
    try {
      return JSON.parse(trimmed) as T;
    } catch {
      const m = /[[{][\s\S]*[\]}]/.exec(trimmed);
      if (m) return JSON.parse(m[0]) as T;
      throw new Error("local model did not return JSON");
    }
  }

  /** Extract the first fenced code block (project fallback). */
  function fencedBlock(raw: string): { lang: string; code: string } | null {
    const m = /```(\w*)\n([\s\S]*?)```/.exec(raw);
    return m ? { lang: m[1] || "js", code: m[2] } : null;
  }

  const adapter: ModelAdapter = {
    id: "local",
    label: cfg.label ?? (isOrnith ? "Ornith 9B (local)" : "Local GPU"),

    async availability(): Promise<AvailabilityInfo> {
      if (!("gpu" in navigator)) {
        return { state: "unavailable", detail: "WebGPU is not available in this browser" };
      }
      if (ready) return { state: "available" };
      if (preparing) return { state: "downloading" };
      // Cheap reachability probe so a deployment without model assets says so.
      try {
        const head = await fetch(cfg.tokenizerUrl, { method: "HEAD" });
        if (!head.ok) {
          return { state: "unavailable", detail: "local model assets not deployed" };
        }
      } catch {
        return { state: "unavailable", detail: "local model assets not reachable" };
      }
      return {
        state: "downloadable",
        detail: isOrnith
          ? "~5.6 GB one-time download, cached in this browser"
          : "~1.1 GB one-time download, cached in this browser",
      };
    },

    prepare: ensureReady,

    async route(userText, tools: AssistantTool[], history): Promise<RouteDecision> {
      const names = tools.map((t) => t.name);
      const toolLines = tools.map((t) => `- ${t.name}: ${t.description}`).join("\n");

      // Routing prompts clobber the KV, so the whole decision runs inside an
      // L1 snapshot/restore window (kvNeutral) — a live append-only
      // conversation survives untouched. The chat reply itself happens AFTER
      // the window, through the append path.
      const decision = await kvNeutral(async (): Promise<RouteDecision> => {
        // Phase 1: pick the tool under an L3 forced-choice mask, so the result
        // is GUARANTEED to be a real tool name (or "chat") — no JSON parsing,
        // no invalid-tool fallback. Falls back to the JSON path if masking
        // errors (e.g. a tool name that doesn't tokenize cleanly).
        // Prompt shape picked by nanoinfer's `route-eval` harness: the shipped
        // ask scored 3/16 on the 1.5B (it answered "chat" for everything);
        // this 12-exemplar few-shot form scores 14/16. Exemplars name the
        // stock terminal tools — with a custom tool registry they are mild
        // prompt noise at worst (the forced choice only allows real names).
        const choicePrompt = buildPrompt(
          `Pick the ONE action that fulfills the user's request.\n\nActions:\n${toolLines}\n` +
            `- chat: reply in plain language (questions, explanations, conversation)\n\n` +
            `Examples:\n` +
            `"read the file /app/readme.md" -> read_file\n` +
            `"what's inside /etc/passwd" -> read_file\n` +
            `"run ls /tmp" -> run_shell\n` +
            `"run rm -rf /tmp/junk" -> run_shell\n` +
            `"remove the old log files" -> run_shell\n` +
            `"show me the files" -> list_dir\n` +
            `"save hello to /tmp/a.txt" -> write_file\n` +
            `"launch web.js as a server" -> serve\n` +
            `"what is the capital of Japan?" -> chat\n` +
            `"who wrote Hamlet?" -> chat\n` +
            `"explain how promises work" -> chat\n` +
            `"hello!" -> chat\n\n` +
            `User request: "${userText}"\n` +
            `Reply with the action name only.`,
          history,
          cfg.maxSeq - 256,
        );
        let tool: string;
        try {
          tool = await chooseOne(choicePrompt, [...names, "chat"]);
        } catch {
          return routeViaJson(userText, tools, history);
        }

        if (tool === "chat" || !names.includes(tool)) {
          return { tool: "chat", args: {} };
        }

        // Phase 2: fill the chosen tool's arguments (free-form JSON under its
        // own schema); a no-arg tool skips the call.
        const selected = tools.find((t) => t.name === tool)!;
        const props = (selected.inputSchema as { properties?: Record<string, unknown> })
          .properties;
        if (!props || Object.keys(props).length === 0) {
          return { tool, args: {} };
        }
        const argAsk =
          `The user said: "${userText}"\nYou are calling the tool "${tool}" ` +
          `(${selected.description}). Reply with ONLY its arguments as a JSON object.`;
        // Grammar-constrained arg fill (engine L3 full JSON schema): the
        // result is guaranteed to parse and match the tool's inputSchema.
        try {
          const out = await jsonOne(
            buildPrompt(argAsk, history, cfg.maxSeq - 512),
            selected.inputSchema,
          );
          console.debug(`[assistant] local grammar args for ${tool}: ${out}`);
          return { tool, args: JSON.parse(out) as Record<string, unknown> };
        } catch {
          // Schema outside the engine subset (or engine error) — free-form.
        }
        try {
          const args = parseJson<Record<string, unknown>>(
            await generate(buildPrompt(argAsk, history, cfg.maxSeq - 512), 384),
          );
          return { tool, args: args && typeof args === "object" ? args : {} };
        } catch {
          return { tool, args: {} };
        }
      });

      // A "chat" decision returns WITHOUT a pre-generated reply, so the
      // orchestrator streams it through chat() (the append-only KV path) with
      // live tok/s — rather than blocking here for the whole reply.
      return decision;
    },

    async generateProject(spec, opts): Promise<GeneratedProject> {
      const ask =
        `Write a small ${opts?.multiFile ? "multi-file " : ""}project for this spec:\n${spec}\n\n` +
        `Reply with ONLY JSON: {"files":[{"path":"...","content":"..."}],"entry":"<path>",` +
        `"notes":"<one line>"}. JavaScript (Node) preferred; keep it self-contained.`;
      const prompt = buildPrompt(ask, [], cfg.maxSeq - 1200);
      const raw = await generate(prompt, 1024);
      try {
        const project = parseJson<GeneratedProject>(raw);
        if (!project.files?.length || !project.entry) throw new Error("incomplete project");
        return project;
      } catch {
        const block = fencedBlock(raw);
        if (!block) throw new Error("local model did not return a project");
        const path = block.lang === "ts" || block.lang === "typescript" ? "main.ts" : "main.js";
        return { files: [{ path, content: block.code }], entry: path, notes: "single-file fallback" };
      }
    },

    // `signal` is accepted for interface parity but the worker generation isn't
    // abortable mid-flight; the panel freezes the UI on Stop and lets the KV
    // finish so the next turn's append-only prefix stays consistent.
    async chat(userText, history, onDelta, onMetrics): Promise<string> {
      return appendChat(userText, history, onDelta, onMetrics);
    },

    // Native agentic step — only Ornith is trained for `<tool_call>` + `<think>`;
    // left undefined on the Qwen bring-up model so the orchestrator keeps using
    // the forced-choice router there.
    agentStep: isOrnith
      ? async (
          transcript: AgentMessage[],
          tools: AssistantTool[],
          onVisible?: (kind: "reasoning" | "answer", text: string) => void,
          onMetrics?: (m: TurnMetrics) => void,
        ): Promise<AgentTurn> => {
          const clip = (str: string, n: number) => (str.length > n ? str.slice(0, n) + "…" : str);
          // Compact transcript context shared by the constrained-decode stages.
          const ctx = transcript
            .map((m) =>
              m.role === "user"
                ? `USER: ${m.content}`
                : m.role === "tool"
                  ? `RESULT of ${m.name}: ${clip(m.content, 220)}`
                  : `ASSISTANT: ${clip(m.content, 160)}`,
            )
            .join("\n");
          agentSeed = (agentSeed + 1) & 0xffff;
          kvTurns = null;

          // 1) REASON in an open <think> block (streamed live), capped so the
          //    model can't ramble indefinitely.
          const reasonPrompt = buildOrnithAgentPrompt(tools, transcript);
          const rBudget = cfg.maxSeq - estimateTokens(reasonPrompt) - 96;
          const reasonCap = Math.max(64, Math.min(240, rBudget));
          const r1 = await request(
            {
              type: "generateAppend",
              text: reasonPrompt,
              steps: reasonCap,
              reset: true,
              temperature: ORNITH_AGENT_SAMPLING.temperature,
              topP: ORNITH_AGENT_SAMPLING.topP,
              topK: ORNITH_AGENT_SAMPLING.topK,
              seed: agentSeed + 1,
            },
            makeVisibleStreamer(onVisible, "reasoning"),
            onMetrics,
          );
          const reasoning = (r1.text.match(/<think>([\s\S]*)/)?.[1] ?? r1.text)
            .replace(/<\/?think>/g, "")
            .trim();
          lastUsage = { used: (r1.stats?.kv_pos as number) ?? 0, quota: cfg.maxSeq };

          // 2) CHOOSE the next tool (or finish) via engine forced-choice — the
          //    result is GUARANTEED to be a real tool name or "reply".
          const names = tools.map((t) => t.name);
          const toolLines = tools.map((t) => `- ${t.name}: ${t.description}`).join("\n");
          // Only allow "reply" (finish) once at least one tool has actually run —
          // otherwise a 9B tends to narrate its intent instead of acting. This
          // forces the first step to make a real tool call.
          const canReply = transcript.some((m) => m.role === "tool");
          const options = canReply ? [...names, "reply"] : names;
          const choicePrompt = buildPrompt(
            `${ctx}\n\nMy reasoning:\n${clip(reasoning, 500)}\n\nTools:\n${toolLines}\n\n` +
              `The RESULT lines above are tools that ALREADY ran — do NOT repeat them ` +
              `(never re-read or re-write a file that already succeeded). Pick the SINGLE ` +
              `next tool that makes NEW progress toward the goal.` +
              (canReply ? ` Choose "reply" once every step of the task is done.` : ""),
            [],
            cfg.maxSeq - 320,
          );
          const choice = await chooseOne(choicePrompt, options, true);

          if (!names.includes(choice)) {
            // 3a) Finished — stream a short natural-language summary.
            const ansPrompt = buildPrompt(
              `${ctx}\n\nThe task is complete. Give the user a one-line summary of what was done.`,
              [],
              cfg.maxSeq - 200,
            );
            const answer = (await generate(ansPrompt, 160, (d) => onVisible?.("answer", d))).trim();
            return { reasoning, answer: answer || "Done.", raw: r1.text };
          }

          const tool = tools.find((t) => t.name === choice)!;

          // 3b-i) write_file specially: its `content` is long code, and greedy
          //   grammar arg-fill emits an EMPTY string for it. So grammar-fill the
          //   short `path`, generate `content` with SAMPLED free-form decode
          //   (which produces real code), and build the args ourselves so JSON
          //   escaping is correct.
          if (choice === "write_file") {
            let path = "";
            try {
              const pj = JSON.parse(
                await jsonOne(
                  buildPrompt(
                    `${ctx}\n\nMy reasoning:\n${clip(reasoning, 400)}\n\nWhich file path is written next?`,
                    [],
                    cfg.maxSeq - 300,
                  ),
                  { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
                  true,
                ),
              ) as { path?: string };
              if (typeof pj.path === "string") path = pj.path.trim();
            } catch {
              /* fall back to a path parsed from context */
            }
            if (!path) path = (ctx.match(/\/[\w./-]+\.\w+/) ?? ["/app/index.js"])[0];

            agentSeed = (agentSeed + 5) & 0xffff;
            const contentPrompt = buildPrompt(
              `${ctx}\n\nMy reasoning:\n${clip(reasoning, 400)}\n\n` +
                `Write the COMPLETE, runnable contents of the file ${path}. ` +
                `Output ONLY the raw file contents — no explanation, no markdown code fences.`,
              [],
              cfg.maxSeq - 400,
            );
            const cev = await request(
              {
                type: "generateAppend",
                text: contentPrompt,
                steps: 1000,
                reset: true,
                temperature: ORNITH_AGENT_SAMPLING.temperature,
                topP: ORNITH_AGENT_SAMPLING.topP,
                topK: ORNITH_AGENT_SAMPLING.topK,
                seed: agentSeed + 1,
              },
              undefined, // don't stream the file body into the chat
              onMetrics,
            );
            // The agentic model sometimes wraps the file in a <tool_call>/JSON
            // (name+arguments.content) instead of emitting raw text — unwrap it.
            let content = cev.text.trim();
            const obj = findToolCallObject(content) ?? parseLooseJsonObject(content);
            const argContent = (obj?.arguments as { content?: unknown } | undefined)?.content;
            if (typeof argContent === "string" && argContent.trim()) {
              content = argContent;
            } else if (obj && typeof obj.content === "string" && obj.content.trim()) {
              content = obj.content;
            } else if (/^\s*(<tool_call>|\{\s*"name")/.test(content)) {
              // A wrapper whose inner JSON didn't parse (unescaped quotes in the
              // HTML/code body) — pull the `content` string out directly.
              content = extractWrappedContent(content) ?? content;
            } else {
              content = content.replace(/^```[\w-]*\n?/, "").replace(/\n?```\s*$/, "");
            }
            return { reasoning, toolCall: { name: "write_file", args: { path, content } }, raw: r1.text };
          }

          // 3b-ii) other tools have short args — grammar arg-fill is reliable and
          //   guarantees valid, schema-conforming JSON.
          const argPrompt = buildPrompt(
            `${ctx}\n\nMy reasoning:\n${clip(reasoning, 500)}\n\n` +
              `Provide the arguments for the tool "${choice}" (${tool.description}) for the next step.`,
            [],
            cfg.maxSeq - 700,
          );
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(await jsonOne(argPrompt, tool.inputSchema, true)) as Record<
              string,
              unknown
            >;
          } catch {
            /* leave args empty on a grammar/parse miss */
          }
          return { reasoning, toolCall: { name: choice, args }, raw: r1.text };
        }
      : undefined,

    // Decompose a multi-step goal into an ordered list of single-action steps.
    // Only meaningful for the agentic (Ornith) path; the orchestrator runs one
    // focused turn per step.
    plan: isOrnith
      ? async (goal: string, tools: AssistantTool[]): Promise<string[]> => {
          const toolNames = tools.map((t) => t.name).join(", ");
          const prompt = buildPrompt(
            `Goal:\n${goal}\n\nBreak this into an ordered list of concrete single-action steps ` +
              `for a coding agent to execute one at a time — ONE file write or ONE command per ` +
              `step (e.g. "write /app/server.js: a node http server on port 8080", then ` +
              `"serve /app/server.js on port 8080"). Tools: ${toolNames}. Reply with ONLY a ` +
              `numbered list, one step per line, at most 6 steps, no other prose.`,
            [],
            cfg.maxSeq - 400,
          );
          const raw = await generate(prompt, 320);
          return raw
            .split("\n")
            .map((l) => l.replace(/^\s*(?:\d+[.)]|[-*])\s*/, "").trim())
            .filter((l) => l.length > 4 && !/^```/.test(l) && !/^(here|sure|ok\b|the )/i.test(l))
            .slice(0, 8);
        }
      : undefined,

    usage(): { used: number; quota: number } | null {
      return lastUsage;
    },

    destroy(): void {
      worker?.terminate();
      worker = null;
      ready = false;
      inFlight = 0;
      kvTurns = null;
      kvPos = 0;
      kvProtected = 0;
      handlers.clear();
    },
  };

  return {
    adapter,
    maxSeq: cfg.maxSeq,
    isReady: () => ready,
    isBusy: () => inFlight > 0,
    ensureReady,
    rawGenerate: generate,
    rawChoose: (prompt, choices) => chooseOne(prompt, choices, true),
    rawJson: (prompt, schema) => jsonOne(prompt, schema, true),
  };
}

/** Back-compat convenience: just the panel-facing adapter. */
export function createLocalAdapter(config: LocalModelConfig = {}): ModelAdapter {
  return createLocalModel(config).adapter;
}
