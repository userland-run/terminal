// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run terminal; dual-licensed - see LICENSE.md.

// Guest-facing OpenAI facade for the local WebGPU model: the NanoVM container
// routes any guest request to http://nanoinfer.internal/* (via /dev/__net__)
// to the handler registered with vm.setLlmBridge(). This module implements
// that handler on top of the "Local GPU" engine (local.ts), so a process
// INSIDE the VM can POST /v1/chat/completions — including stream:true, served
// as OpenAI chat.completion.chunk SSE frames flowing to the guest token-by-
// token — with zero network involved.

import { buildQwenPrompt, estimateTokens, type LocalModel } from "./local";
import type { ChatTurn } from "./types";
import type { LlmBridgeRequest, LlmBridgeResult, NanoVM } from "@container/nanovm.mjs";

export const LLM_BRIDGE_MODEL_ID = "nanoinfer-local";

const DEFAULT_SYSTEM =
  "You are a helpful assistant running fully locally, on the user's GPU, " +
  "answering a program inside a browser-hosted Linux VM. Be concise.";

/** OpenAI-ish request body subset we honor. */
interface ChatCompletionRequest {
  model?: string;
  messages?: Array<{
    role?: string;
    content?: unknown;
    name?: string;
    tool_call_id?: string;
    tool_calls?: Array<{ id?: string; type?: string; function?: { name?: string; arguments?: string } }>;
  }>;
  stream?: boolean;
  max_tokens?: number;
  /** L3 grammar: json_schema responses are engine-GUARANTEED to conform. */
  response_format?: {
    type?: string;
    json_schema?: { name?: string; schema?: object };
  };
  /** Function calling: tool pick is forced-choice, arguments are
   * schema-constrained — both guaranteed valid by the engine grammar. */
  tools?: Array<{
    type?: string;
    function?: { name?: string; description?: string; parameters?: object };
  }>;
  tool_choice?:
    | string
    | { type?: string; function?: { name?: string } };
}

function json(status: number, statusText: string, payload: unknown): LlmBridgeResult {
  return {
    status,
    statusText,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  };
}

function errorJson(status: number, statusText: string, message: string, type: string) {
  return json(status, statusText, { error: { message, type, param: null, code: null } });
}

/** Flatten an OpenAI `content` (string or content-part array) to plain text. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) =>
        typeof p === "string"
          ? p
          : typeof (p as { text?: unknown })?.text === "string"
            ? (p as { text: string }).text
            : "",
      )
      .join("");
  }
  return "";
}

/**
 * Build the `{method,url,headers,body}` → `{status,headers,body}` handler the
 * container's setLlmBridge() expects. Routes:
 *   GET  /v1/models            → the one local model
 *   POST /v1/chat/completions  → chat.completion (or SSE chunk stream)
 * Never triggers the weights download itself: an unprepared model answers 503
 * so a guest request can't silently start a ~1 GB fetch.
 */
export function createLlmBridgeHandler(
  local: LocalModel,
): (req: LlmBridgeRequest) => Promise<LlmBridgeResult> {
  return async (req) => {
    let path: string;
    try {
      path = new URL(req.url).pathname;
    } catch {
      path = req.url;
    }

    if (path === "/v1/models" && req.method === "GET") {
      return json(200, "OK", {
        object: "list",
        data: [
          { id: LLM_BRIDGE_MODEL_ID, object: "model", created: 0, owned_by: "nanoinfer" },
        ],
      });
    }

    if (path !== "/v1/chat/completions") {
      return errorJson(404, "Not Found", `no route: ${req.method} ${path}`, "invalid_request_error");
    }
    if (req.method !== "POST") {
      return errorJson(405, "Method Not Allowed", "use POST /v1/chat/completions", "invalid_request_error");
    }

    let body: ChatCompletionRequest;
    try {
      body = JSON.parse(req.body || "") as ChatCompletionRequest;
    } catch {
      return errorJson(400, "Bad Request", "request body is not valid JSON", "invalid_request_error");
    }
    const messages = body.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      return errorJson(400, "Bad Request", '"messages" must be a non-empty array', "invalid_request_error");
    }

    if (!local.isReady()) {
      return errorJson(
        503,
        "Service Unavailable",
        'Local model is not loaded. In the terminal page, open the Assistant panel, ' +
          'switch the model to "Local GPU" and let it prepare (one-time ~1.1 GB download, ' +
          "cached in the browser) — then retry this request. Guest requests never start " +
          "the download themselves.",
        "model_not_loaded",
      );
    }
    if (local.isBusy()) {
      return errorJson(
        429,
        "Too Many Requests",
        "the local model is generating for another request; retry shortly",
        "model_busy",
      );
    }

    // Map the OpenAI transcript onto the Qwen template: system messages fold
    // into the system block; assistant tool_calls and tool-role results fold
    // into the transcript as text so an agent loop (assistant→tool→assistant)
    // round-trips instead of 400ing.
    const system =
      messages
        .filter((m) => m.role === "system" || m.role === "developer")
        .map((m) => textOf(m.content))
        .join("\n") || DEFAULT_SYSTEM;
    const turns: ChatTurn[] = [];
    for (const m of messages) {
      if (m.role === "user") {
        turns.push({ role: "user", content: textOf(m.content) });
      } else if (m.role === "assistant") {
        let content = textOf(m.content);
        if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
          const rendered = m.tool_calls
            .map((c) => `[tool call] ${c.function?.name ?? "?"}(${c.function?.arguments ?? ""})`)
            .join("\n");
          content = content ? `${content}\n${rendered}` : rendered;
        }
        turns.push({ role: "assistant", content });
      } else if (m.role === "tool" || m.role === "function") {
        // The Qwen template has no tool role; present results as user turns.
        const tag = m.name ? `[tool result from ${m.name}]` : "[tool result]";
        turns.push({ role: "user", content: `${tag}\n${textOf(m.content)}` });
      }
    }
    // The live turn is the trailing user turn (a trailing tool result maps to
    // user above); a transcript ending in an assistant message asks for a
    // continuation of that answer.
    const last =
      turns.length > 0 && turns[turns.length - 1].role === "user"
        ? turns.pop()!
        : { role: "user" as const, content: "Continue." };

    const steps = Math.min(Math.max(1, Math.floor(body.max_tokens ?? 512)), Math.max(64, local.maxSeq - 256));
    const budget = Math.max(256, local.maxSeq - steps - 64);
    const prompt = buildQwenPrompt(system, turns, last.content, budget);

    const model = typeof body.model === "string" && body.model ? body.model : LLM_BRIDGE_MODEL_ID;
    const id = `chatcmpl-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const created = Math.floor(Date.now() / 1000);

    /** A one-shot SSE body: role frame, one payload delta, finish, [DONE]. */
    const sseOnce = (delta: Record<string, unknown>, finish: string): LlmBridgeResult => {
      const enc = new TextEncoder();
      const chunk = (d: Record<string, unknown>, f: string | null = null) =>
        `data: ${JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta: d, finish_reason: f }],
        })}\n\n`;
      const payload =
        chunk({ role: "assistant" }) + chunk(delta) + chunk({}, finish) + "data: [DONE]\n\n";
      return {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
        body: enc.encode(payload),
      };
    };
    const completion = (message: Record<string, unknown>, finish: string): LlmBridgeResult => {
      const promptTokens = estimateTokens(prompt);
      return json(200, "OK", {
        id,
        object: "chat.completion",
        created,
        model,
        choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason: finish }],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: 0,
          total_tokens: promptTokens,
        },
      });
    };

    // --- Function calling (engine L3 grammar): the tool pick is a forced
    // choice and the arguments are schema-constrained, so both are guaranteed
    // valid. Streaming is served as a single tool_calls frame.
    const tools = (body.tools ?? []).filter(
      (t) => t.type === "function" && typeof t.function?.name === "string",
    );
    if (tools.length > 0 && body.tool_choice !== "none") {
      const names = tools.map((t) => t.function!.name!);
      let picked: string;
      const tc = body.tool_choice;
      if (tc && typeof tc === "object" && tc.function?.name) {
        if (!names.includes(tc.function.name)) {
          return errorJson(400, "Bad Request", `tool_choice names unknown tool "${tc.function.name}"`, "invalid_request_error");
        }
        picked = tc.function.name;
      } else {
        const toolLines = tools
          .map((t) => `- ${t.function!.name}: ${t.function!.description ?? ""}`)
          .join("\n");
        // Instruction shape from nanoinfer's route-eval harness (the plain
        // "which tool best handles this?" ask makes the 1.5B answer "none"
        // for nearly everything). Caller tools are arbitrary, so no
        // terminal-specific exemplars here — just the action-list framing.
        const pickPrompt = buildQwenPrompt(
          system,
          turns,
          `Pick the ONE action that fulfills the user's request.\n\nActions:\n${toolLines}\n` +
            `- none: reply in plain language (only when no tool applies)\n\n` +
            `User request: "${last.content}"\n` +
            `Reply with the action name only.`,
          budget,
        );
        try {
          picked = await local.rawChoose(pickPrompt, [...names, "none"]);
        } catch (e) {
          return errorJson(500, "Internal Server Error", e instanceof Error ? e.message : String(e), "server_error");
        }
      }
      if (picked !== "none") {
        const tool = tools.find((t) => t.function!.name === picked)!;
        const params = tool.function!.parameters ?? { type: "object" };
        const argPrompt = buildQwenPrompt(
          system,
          turns,
          `The user said: "${last.content}"\nYou are calling the tool "${picked}" ` +
            `(${tool.function!.description ?? ""}). Reply with ONLY its arguments as a JSON object.`,
          budget,
        );
        let args: string;
        try {
          args = await local.rawJson(argPrompt, params);
        } catch (e) {
          return errorJson(
            400,
            "Bad Request",
            `tool "${picked}" parameters schema is outside the supported subset: ${e instanceof Error ? e.message : String(e)}`,
            "invalid_request_error",
          );
        }
        const call = {
          id: `call_${id.slice(9)}`,
          type: "function",
          function: { name: picked, arguments: args },
        };
        return body.stream
          ? sseOnce({ tool_calls: [{ index: 0, ...call }] }, "tool_calls")
          : completion({ content: null, tool_calls: [call] }, "tool_calls");
      }
      // picked === "none" → plain reply below.
    }

    // --- response_format (engine L3 grammar): json_schema responses are
    // GUARANTEED to parse and conform. json_object (arbitrary JSON) is not
    // supported — the grammar needs a schema.
    const rf = body.response_format;
    if (rf?.type === "json_schema") {
      const schema = rf.json_schema?.schema;
      if (!schema || typeof schema !== "object") {
        return errorJson(400, "Bad Request", "response_format.json_schema.schema is required", "invalid_request_error");
      }
      try {
        const out = await local.rawJson(prompt, schema);
        return body.stream
          ? sseOnce({ content: out }, "stop")
          : completion({ content: out }, "stop");
      } catch (e) {
        return errorJson(
          400,
          "Bad Request",
          `schema is outside the supported subset (object of string/number/integer/boolean/enum/array-of-scalar): ${e instanceof Error ? e.message : String(e)}`,
          "invalid_request_error",
        );
      }
    }
    if (rf?.type === "json_object") {
      return errorJson(
        400,
        "Bad Request",
        'response_format "json_object" is not supported; use "json_schema" with an explicit schema',
        "invalid_request_error",
      );
    }

    if (body.stream) {
      const enc = new TextEncoder();
      const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta, finish_reason: finish }],
      });
      let cancelled = false;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const send = (frame: unknown) => {
            if (cancelled) return;
            const data = typeof frame === "string" ? frame : JSON.stringify(frame);
            try {
              controller.enqueue(enc.encode(`data: ${data}\n\n`));
            } catch {
              cancelled = true; // guest closed mid-stream; drop further frames
            }
          };
          send(chunk({ role: "assistant", content: "" }));
          local
            .rawGenerate(prompt, steps, (delta) => {
              if (delta) send(chunk({ content: delta }));
            })
            .then(() => {
              send(chunk({}, "stop"));
              send("[DONE]");
            })
            .catch((e: unknown) => {
              send({ error: { message: e instanceof Error ? e.message : String(e), type: "server_error" } });
            })
            .finally(() => {
              try {
                controller.close();
              } catch {
                /* already closed/cancelled */
              }
            });
        },
        cancel() {
          cancelled = true; // generation itself is not abortable; just go quiet
        },
      });
      return {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
        body: stream,
      };
    }

    try {
      const text = await local.rawGenerate(prompt, steps);
      const promptTokens = estimateTokens(prompt);
      const completionTokens = estimateTokens(text);
      return json(200, "OK", {
        id,
        object: "chat.completion",
        created,
        model,
        choices: [
          { index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" },
        ],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
        },
      });
    } catch (e) {
      return errorJson(500, "Internal Server Error", e instanceof Error ? e.message : String(e), "server_error");
    }
  };
}

/**
 * Wire the local model into the VM: from then on, guest processes can reach
 * the in-browser model at http://nanoinfer.internal/v1/... over /dev/__net__.
 */
export function installLlmBridge(vm: NanoVM, local: LocalModel): void {
  vm.setLlmBridge(createLlmBridgeHandler(local));
}
