// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run terminal; dual-licensed - see LICENSE.md.

// "Local GPU" model adapter: fully in-browser inference on WebGPU via the
// nanoinfer engine (Qwen2.5-Coder-1.5B, W4-quantized). Nothing leaves the
// machine — weights are fetched once (OPFS-cached) and the model runs on the
// user's GPU in a dedicated worker, next to (not inside) the VM.

import type {
  AssistantTool,
  AvailabilityInfo,
  ChatTurn,
  GeneratedProject,
  ModelAdapter,
  RouteDecision,
} from "./types";

export interface LocalModelConfig {
  /** GGUF model URL. Same-origin or CORS-enabled. */
  ggufUrl?: string;
  /** tokenizer.json URL. */
  tokenizerUrl?: string;
  /** Base URL of the nanoinfer wasm-bindgen bundle (js + wasm). */
  engineBase?: string;
  /** KV capacity in tokens (bounds prompt + generation). Default 2048. */
  maxSeq?: number;
  label?: string;
}

const DEFAULTS = {
  ggufUrl: "/models/qwen2.5-coder-1.5b-instruct-q4_0.gguf",
  tokenizerUrl: "/models/tokenizer.json",
  engineBase: "/nanoinfer-engine",
  maxSeq: 2048,
};

const SYSTEM_PROMPT =
  "You are the assistant inside a browser terminal that runs a real Linux/Node.js " +
  "userland (a RISC-V emulator). You drive the terminal by choosing tools and you " +
  "write real, runnable code that is executed inside the sandbox. Be concise.";

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
  const cfg = { ...DEFAULTS, ...config };
  let worker: Worker | null = null;
  let ready = false;
  let preparing = false;
  let inFlight = 0;
  let nextId = 1;
  let lastUsage: { used: number; quota: number } | null = null;

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

  /** Build the full Qwen chat template, trimming old turns to fit the KV. */
  const buildPrompt = (userText: string, history: ChatTurn[], budget: number) =>
    buildQwenPrompt(SYSTEM_PROMPT, history, userText, budget);

  /** Send one worker request; resolves on "done" with accumulated delta text. */
  function request(
    msg: Record<string, unknown>,
    onDelta?: (d: string) => void,
  ): Promise<WorkerEvent & { text: string }> {
    const w = spawn();
    const id = nextId++;
    inFlight++;
    return new Promise((resolve, reject) => {
      let text = "";
      handlers.set(id, (ev) => {
        if (ev.type === "delta") {
          text += ev.text ?? "";
          onDelta?.(ev.text ?? "");
        } else if (ev.type === "done") {
          handlers.delete(id);
          inFlight--;
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
  ): Promise<string> {
    const steps = 512;
    if (kvTurns && isPrefix(kvTurns, history)) {
      let delta = "";
      for (const t of history.slice(kvTurns.length)) delta += midTurn(t.role, t.content);
      delta += `${midTurn("user", userText)}<|im_end|>\n<|im_start|>assistant\n`;
      if (kvPos + estimateTokens(delta) + steps + 64 <= cfg.maxSeq) {
        try {
          return await runAppend(delta, false, userText, history, steps, onDelta);
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
    text += `<|im_start|>user\n${userText}<|im_end|>\n<|im_start|>assistant\n`;
    return runAppend(text, true, userText, trimmed, steps, onDelta);
  }

  async function runAppend(
    text: string,
    reset: boolean,
    userText: string,
    baseTurns: ChatTurn[],
    steps: number,
    onDelta?: (d: string) => void,
  ): Promise<string> {
    const ev = await request({ type: "generateAppend", text, steps, reset }, onDelta);
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
    label: cfg.label ?? "Local GPU",

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
        detail: "~1.1 GB one-time download, cached in this browser",
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
        const choicePrompt = buildPrompt(
          `Available tools:\n${toolLines}\n\nThe user said: "${userText}"\n` +
            `Which single tool best handles this? Answer "chat" for a plain reply.`,
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

      if (decision.tool === "chat" && decision.say === undefined) {
        // Plain reply through the append-only conversation KV.
        const say = await appendChat(userText, history);
        return { tool: "chat", args: {}, say };
      }
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

    async chat(userText, history, onDelta): Promise<string> {
      return appendChat(userText, history, onDelta);
    },

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
