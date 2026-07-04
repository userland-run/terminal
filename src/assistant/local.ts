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
}

/** Rough token estimate for history trimming (~3.5 chars/token for code). */
const estimateTokens = (s: string) => Math.ceil(s.length / 3.5);

export function createLocalAdapter(config: LocalModelConfig = {}): ModelAdapter {
  const cfg = { ...DEFAULTS, ...config };
  let worker: Worker | null = null;
  let ready = false;
  let preparing = false;
  let nextId = 1;
  let lastUsage: { used: number; quota: number } | null = null;

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
  function buildPrompt(userText: string, history: ChatTurn[], budget: number): string {
    const head = `<|im_start|>system\n${SYSTEM_PROMPT}<|im_end|>\n`;
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

  function generate(prompt: string, steps: number, onDelta?: (d: string) => void): Promise<string> {
    const w = spawn();
    const id = nextId++;
    return new Promise((resolve, reject) => {
      let text = "";
      handlers.set(id, (ev) => {
        if (ev.type === "delta") {
          text += ev.text ?? "";
          onDelta?.(ev.text ?? "");
        } else if (ev.type === "done") {
          handlers.delete(id);
          const s = ev.stats ?? {};
          lastUsage = {
            used: (s.prefill_tokens ?? 0) + (s.generated ?? 0),
            quota: cfg.maxSeq,
          };
          resolve(text);
        } else if (ev.type === "error") {
          handlers.delete(id);
          reject(new Error(ev.message ?? "local model error"));
        }
      });
      w.postMessage({ type: "chat", id, prompt, steps });
    });
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

  return {
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

    async prepare(onProgress?: (fraction: number) => void): Promise<void> {
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
    },

    async route(userText, tools: AssistantTool[], history): Promise<RouteDecision> {
      const names = tools.map((t) => t.name);
      const toolLines = tools.map((t) => `- ${t.name}: ${t.description}`).join("\n");
      const ask =
        `Available tools:\n${toolLines}\n\nThe user said: "${userText}"\n` +
        `Reply with ONLY a JSON object: {"tool": <one of ${JSON.stringify([...names, "chat"])}>, ` +
        `"args": <arguments object for that tool, {} if none>, ` +
        `"say": <your reply text, only when tool is "chat">}`;
      const prompt = buildPrompt(ask, history, cfg.maxSeq - 512);
      const raw = await generate(prompt, 384);
      try {
        const parsed = parseJson<Partial<RouteDecision>>(raw);
        if (!parsed.tool || (parsed.tool !== "chat" && !names.includes(parsed.tool))) {
          return { tool: "chat", args: {}, say: raw };
        }
        return { tool: parsed.tool, args: parsed.args ?? {}, say: parsed.say };
      } catch {
        // Not JSON — treat the whole reply as chat.
        return { tool: "chat", args: {}, say: raw };
      }
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
      const prompt = buildPrompt(userText, history, cfg.maxSeq - 640);
      return generate(prompt, 512, onDelta);
    },

    usage(): { used: number; quota: number } | null {
      return lastUsage;
    },

    destroy(): void {
      worker?.terminate();
      worker = null;
      ready = false;
      handlers.clear();
    },
  };
}
