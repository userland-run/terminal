// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run terminal; dual-licensed - see LICENSE.md.

// On-device model adapter over Chrome's Prompt API (Gemini Nano). Nano is a
// small model with a ~6K-token context and weak instruction-following, so we
// play to its strengths: intent routing (emulated function-calling via a
// JSON-schema `responseConstraint` enum) and short single-file snippets. Every
// entry point feature-detects `LanguageModel`; when it's absent the adapter
// reports "unavailable" and the panel degrades.

import type {
  AssistantTool,
  AvailabilityInfo,
  ChatTurn,
  GeneratedProject,
  ModelAdapter,
  ModelAvailabilityState,
  RouteDecision,
  TurnMetrics,
} from "./types";

/** Rough token estimate for the tok/s readout (~3.5 chars/token). */
const estTokens = (s: string) => Math.ceil(s.length / 3.5);

const SYSTEM_PROMPT =
  "You are the assistant inside a browser terminal that runs a real Linux/Node.js " +
  "userland. You help by choosing tools that inspect and drive the terminal, and by " +
  "writing short scripts. Be concise. Prefer running a tool over guessing.";

const FLAG_HINT = "enable chrome://flags/#prompt-api-for-gemini-nano and #optimization-guide-on-device-model";

function present(): boolean {
  return typeof LanguageModel !== "undefined" && !!LanguageModel;
}

function mapState(a: string): ModelAvailabilityState {
  if (a === "available" || a === "readily") return "available";
  if (a === "downloading") return "downloading";
  if (a === "downloadable" || a === "after-download") return "downloadable";
  return "unavailable";
}

export function createNanoAdapter(): ModelAdapter {
  let session: LanguageModelSession | null = null;
  let creating: Promise<LanguageModelSession> | null = null;

  async function ensureSession(onProgress?: (f: number) => void): Promise<LanguageModelSession> {
    if (session) return session;
    if (creating) return creating;
    if (!present()) throw new Error("Prompt API unavailable");
    creating = LanguageModel!.create({
      initialPrompts: [{ role: "system", content: SYSTEM_PROMPT }],
      expectedOutputs: [{ type: "text", languages: ["en"] }],
      monitor(m) {
        m.addEventListener("downloadprogress", (e) => {
          const loaded = (e as unknown as { loaded?: number }).loaded ?? 0;
          onProgress?.(loaded);
        });
      },
    }).then((s) => {
      session = s;
      creating = null;
      return s;
    });
    return creating;
  }

  async function promptJson(input: string, schema: unknown): Promise<unknown> {
    const s = await ensureSession();
    const raw = await s.prompt(input, { responseConstraint: schema });
    return JSON.parse(raw);
  }

  /**
   * Phase 2 of routing: fill the chosen tool's arguments under *its own*
   * inputSchema. Nano can't do this in one shot — a generic `args:{type:"object"}`
   * satisfies the constraint with `{}`, so `command`/`path`/… never get produced.
   * Constraining to the tool's schema (with its `required` fields) forces them.
   * No-arg tools (e.g. read_terminal) skip the round-trip.
   */
  async function fillArgs(
    tool: AssistantTool,
    userText: string,
  ): Promise<Record<string, unknown>> {
    const props = (tool.inputSchema as { properties?: Record<string, unknown> }).properties;
    if (!props || Object.keys(props).length === 0) return {};
    const input =
      `The user said: "${userText}"\n` +
      `You are calling the tool "${tool.name}" (${tool.description}). ` +
      `Produce ONLY its arguments.`;
    try {
      const args = await promptJson(input, tool.inputSchema);
      return args && typeof args === "object" ? (args as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  return {
    id: "nano",
    label: "Gemini Nano (on-device)",

    async availability(): Promise<AvailabilityInfo> {
      if (!present()) return { state: "unavailable", detail: FLAG_HINT };
      try {
        const a = await LanguageModel!.availability({
          expectedOutputs: [{ type: "text", languages: ["en"] }],
        });
        const state = mapState(a);
        return { state, detail: state === "unavailable" ? FLAG_HINT : undefined };
      } catch {
        return { state: "unavailable", detail: FLAG_HINT };
      }
    },

    async prepare(onProgress) {
      await ensureSession(onProgress);
    },

    async route(userText, tools): Promise<RouteDecision> {
      const names = tools.map((t) => t.name);
      // Phase 1: pick the tool only. Args are filled in phase 2 under the tool's
      // own schema — asking Nano for a generic `args` object here just yields `{}`.
      const routeSchema = {
        type: "object",
        properties: {
          tool: { type: "string", enum: [...names, "chat"] },
          say: { type: "string" },
        },
        required: ["tool"],
        additionalProperties: false,
      };
      const toolLines = tools.map((t) => `- ${t.name}: ${t.description}`).join("\n");
      const input =
        `User said: "${userText}"\n\n` +
        `Choose ONE tool to fulfil it, or "chat" to just reply.\n${toolLines}\n\n` +
        `Return the tool name. For "chat", put your reply in "say".`;
      try {
        const obj = (await promptJson(input, routeSchema)) as Partial<RouteDecision>;
        const toolName = typeof obj.tool === "string" ? obj.tool : "chat";
        const picked = tools.find((t) => t.name === toolName);
        return {
          tool: toolName,
          args: picked ? await fillArgs(picked, userText) : {},
          say: typeof obj.say === "string" ? obj.say : undefined,
        };
      } catch {
        // Overflow / parse failure → fall back to a plain reply.
        return { tool: "chat", args: {} };
      }
    },

    async generateProject(spec): Promise<GeneratedProject> {
      const schema = {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
        additionalProperties: false,
      };
      const input =
        `Write ONE short, self-contained Node.js script (CommonJS, no external packages) that: ${spec}\n\n` +
        `Return JSON with "path" (e.g. /app/main.js) and "content" (the full script).`;
      const obj = (await promptJson(input, schema)) as { path?: string; content?: string };
      const path = obj.path && obj.path.startsWith("/") ? obj.path : "/app/main.js";
      const content = typeof obj.content === "string" ? obj.content : "";
      return { files: [{ path, content }], entry: path, toolchain: "node" };
    },

    async chat(userText, _history, onDelta, onMetrics, signal): Promise<string> {
      const s = await ensureSession();
      let full = "";
      const t0 = performance.now();
      try {
        for await (const chunk of s.promptStreaming(userText, signal ? { signal } : undefined)) {
          full += chunk;
          onDelta?.(chunk);
          if (onMetrics) {
            const elapsedMs = performance.now() - t0;
            const tokens = estTokens(full);
            onMetrics({ tokens, elapsedMs, tokPerSec: tokens / (elapsedMs / 1000 || 1) });
          }
        }
      } catch (e) {
        if ((e as Error).name === "AbortError") return full; // user hit Stop
        const msg = `⚠️ ${(e as Error).message || "the on-device model errored"}`;
        onDelta?.(msg);
        return msg;
      }
      return full;
    },

    usage() {
      if (!session) return null;
      const used = session.inputUsage ?? 0;
      const quota = session.inputQuota ?? 0;
      return quota ? { used, quota } : null;
    },

    destroy() {
      session?.destroy();
      session = null;
    },
  };
}
