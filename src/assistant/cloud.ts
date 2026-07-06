// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run terminal; dual-licensed - see LICENSE.md.

// Host-injected cloud model adapter. Dependency-free and keyless: the embedder
// supplies either a `generate` callback (preferred — API keys live in the host's
// proxy) or a plain JSON `endpoint`. Unlike Nano, the cloud path can author real
// multi-file projects, so `generateProject` returns a full project the
// build-and-run pipeline compiles in the VM.

import type {
  AssistantTool,
  AvailabilityInfo,
  ChatTurn,
  CloudModelConfig,
  CloudRequest,
  GeneratedFile,
  GeneratedProject,
  ModelAdapter,
  RouteDecision,
} from "./types";

const SYSTEM_PROMPT =
  "You are the assistant inside a browser terminal that runs a real Linux/Node.js " +
  "userland (a RISC-V emulator). You drive the terminal by choosing tools and you " +
  "write real, runnable code that is compiled and executed inside the sandbox. Be concise.";

export function createCloudAdapter(config: CloudModelConfig): ModelAdapter {
  const label = config.label ?? "Cloud model";

  async function call(req: Omit<CloudRequest, "system"> & { system?: string }): Promise<string> {
    const full: CloudRequest = { system: req.system ?? SYSTEM_PROMPT, messages: req.messages, responseSchema: req.responseSchema, signal: req.signal };
    if (config.generate) return config.generate(full);
    if (config.endpoint) {
      const res = await fetch(config.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", ...(config.headers ?? {}) },
        body: JSON.stringify(full),
        signal: req.signal,
      });
      if (!res.ok) throw new Error(`cloud endpoint ${res.status}`);
      const data = (await res.json()) as { text?: string };
      return data.text ?? "";
    }
    throw new Error("cloud adapter has neither generate nor endpoint");
  }

  function parseJson<T>(raw: string): T {
    // Cloud models sometimes fence JSON; extract the first {...} or [...] block.
    const trimmed = raw.trim();
    try {
      return JSON.parse(trimmed) as T;
    } catch {
      const m = /[[{][\s\S]*[\]}]/.exec(trimmed);
      if (m) return JSON.parse(m[0]) as T;
      throw new Error("cloud model did not return JSON");
    }
  }

  /**
   * Phase 2 of routing: fill the chosen tool's arguments under *its own*
   * inputSchema. A generic `args:{type:"object"}` in the route schema leaves the
   * model free to emit `{}`; constraining to the tool's schema (with its
   * `required` fields) forces the real arguments. No-arg tools skip the call.
   */
  async function fillArgs(
    tool: AssistantTool,
    userText: string,
    history: ChatTurn[],
  ): Promise<Record<string, unknown>> {
    const props = (tool.inputSchema as { properties?: Record<string, unknown> }).properties;
    if (!props || Object.keys(props).length === 0) return {};
    const messages: ChatTurn[] = [
      ...history,
      {
        role: "user",
        content:
          `The user said: "${userText}"\n` +
          `You are calling the tool "${tool.name}" (${tool.description}). ` +
          `Return ONLY its arguments as JSON.`,
      },
    ];
    try {
      const args = parseJson<Record<string, unknown>>(
        await call({ messages, responseSchema: tool.inputSchema }),
      );
      return args && typeof args === "object" ? args : {};
    } catch {
      return {};
    }
  }

  return {
    id: "cloud",
    label,

    async availability(): Promise<AvailabilityInfo> {
      return config.generate || config.endpoint
        ? { state: "available" }
        : { state: "unavailable", detail: "no cloud model configured" };
    },

    async route(userText, tools, history): Promise<RouteDecision> {
      const names = tools.map((t) => t.name);
      // Phase 1: pick the tool only; phase 2 (fillArgs) fills args under the
      // tool's own schema so `required` fields are actually produced.
      const routeSchema = {
        type: "object",
        properties: {
          tool: { type: "string", enum: [...names, "chat"] },
          say: { type: "string" },
        },
        required: ["tool"],
      };
      const toolLines = tools.map((t) => `- ${t.name}: ${t.description}`).join("\n");
      const messages: ChatTurn[] = [
        ...history,
        {
          role: "user",
          content:
            `User said: "${userText}"\n\nChoose ONE tool, or "chat" to reply.\n${toolLines}\n\n` +
            `Return JSON {tool, say}. Put a chat reply in "say".`,
        },
      ];
      try {
        const obj = parseJson<Partial<RouteDecision>>(await call({ messages, responseSchema: routeSchema }));
        const toolName = typeof obj.tool === "string" ? obj.tool : "chat";
        const picked = tools.find((t) => t.name === toolName);
        return {
          tool: toolName,
          args: picked ? await fillArgs(picked, userText, history) : {},
          say: typeof obj.say === "string" ? obj.say : undefined,
        };
      } catch {
        return { tool: "chat", args: {} };
      }
    },

    async generateProject(spec): Promise<GeneratedProject> {
      const schema = {
        type: "object",
        properties: {
          files: {
            type: "array",
            items: {
              type: "object",
              properties: { path: { type: "string" }, content: { type: "string" } },
              required: ["path", "content"],
            },
          },
          entry: { type: "string" },
          toolchain: { type: "string" },
          port: { type: "number" },
          notes: { type: "string" },
        },
        required: ["files", "entry"],
      };
      const messages: ChatTurn[] = [
        {
          role: "user",
          content:
            `Create a small project that: ${spec}\n\n` +
            `Constraints: it must build and run inside a browser RISC-V Linux VM with Node.js ` +
            `and (optionally) TypeScript available from a catalog. Prefer plain Node or TypeScript. ` +
            `Return JSON {files:[{path,content}], entry, toolchain?, port?, notes?}. ` +
            `Use absolute paths under /app. Set "port" only for servers.`,
        },
      ];
      const obj = parseJson<GeneratedProject>(await call({ messages, responseSchema: schema }));
      const files: GeneratedFile[] = Array.isArray(obj.files) ? obj.files : [];
      const first = files[0];
      if (!first) throw new Error("cloud model returned no files");
      const entry = obj.entry && files.some((f) => f.path === obj.entry) ? obj.entry : first.path;
      return { files, entry, toolchain: obj.toolchain, port: obj.port, notes: obj.notes };
    },

    async chat(userText, history, onDelta): Promise<string> {
      const messages: ChatTurn[] = [...history, { role: "user", content: userText }];
      const text = await call({ messages });
      onDelta?.(text);
      return text;
    },
  };
}
