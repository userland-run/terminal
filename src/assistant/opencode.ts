// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run terminal; dual-licensed - see LICENSE.md.

// opencode-in-the-VM as a ModelAdapter: the real coding agent (opencode's
// Node bundle, catalog app "opencode") runs INSIDE the guest as
// `opencode serve`, and this adapter is a thin HTTP client over
// vm.virtualServer.injectConnection() — no service worker, no CORS, no
// network; requests are in-process calls into the WASM VM.
//
// opencode drives its own agent loop server-side (its tools edit guest files
// and run guest commands directly), so the panel-side tool registry is
// bypassed: route() always says "chat", and chat() posts the user turn to an
// opencode session. Its LLM traffic leaves the guest through the in-guest
// loopback proxy (127.0.0.1:8787 → /dev/__net__ → nanoinfer.internal or a
// cloud base URL — see catalog/recipes/opencode/nano-net-proxy.cjs).
//
// Known limitation (vendored container): injectConnection buffers the whole
// response, so a turn resolves only when opencode finishes it — no
// incremental streaming of opencode's SSE. chat() therefore emits one delta
// with the final text.

// @ts-ignore — @sdk resolves to the built SDK bundle (vite alias); tsc can't see it.
import { parseHttpResponse } from "@sdk";
import type { TerminalHandle } from "../main";
import type {
  AvailabilityInfo,
  ChatTurn,
  GeneratedProject,
  ModelAdapter,
  RouteDecision,
} from "./types";

const PORT = 4096;
/** Provider/model ids from the recipe's default /root/.config/opencode/opencode.json. */
const PROVIDER_ID = "nano";
const MODEL_ID = "nanoinfer-local";
/** The recipe's default config + bin wrapper, inlined for the dev seed below. */
const OPENCODE_CONFIG_JSON = JSON.stringify(
  {
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    provider: {
      nano: {
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: "http://127.0.0.1:8787/v1", apiKey: "nano-local" },
        models: { "nanoinfer-local": { name: "nanoinfer (local)", limit: { context: 2048, output: 512 } } },
      },
    },
  },
  null,
  2,
);
// --single-threaded-gc is required for `serve`: V8's parallel GC helper threads
// thrash the emulator scheduler, turning serve's startup into an 11+min wall;
// single-threaded GC collapses it to ~63s to listening (see the catalog recipe).
const OPENCODE_BIN_WRAPPER =
  "#!/bin/sh\nexec node --single-threaded-gc --conditions=node --require /usr/local/lib/opencode/nano-net-proxy.cjs /usr/local/lib/opencode/index-nano.js \"$@\"\n";

/**
 * Dev-only: seed the opencode guest tree from the vite-served `/opencode/` bundle
 * (terminal/public/opencode — the *patched* recipe out/ tree + a nano-files.json
 * manifest) when the catalog has no published opencode recipe. Mirrors what
 * installApp would materialize: the Node bundle under /usr/local/lib/opencode,
 * the default config, and the /usr/local/bin/opencode wrapper. node + ripgrep
 * still come from the published catalog.
 */
async function devSeedOpencode(vm: TerminalHandle["vm"]): Promise<void> {
  const base = new URL("opencode/", document.baseURI).href;
  let files: string[];
  try {
    const res = await fetch(base + "nano-files.json");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    files = (await res.json()) as string[];
  } catch (e) {
    throw new Error(
      `opencode is not in the catalog and the dev bundle is unavailable ` +
        `(GET ${base}nano-files.json failed: ${(e as Error).message}). Publish the opencode ` +
        `recipe, or stage terminal/public/opencode from the patched recipe out/ (+ nano-files.json).`,
    );
  }
  vm.makeDir("/usr/local/lib/opencode");
  for (const rel of files) {
    const buf = new Uint8Array(await (await fetch(base + rel)).arrayBuffer());
    const guestPath = `/usr/local/lib/opencode/${rel}`;
    const slash = guestPath.lastIndexOf("/");
    if (slash > 0) vm.makeDir(guestPath.slice(0, slash));
    vm.addFile(guestPath, buf, 0o644);
  }
  vm.makeDir("/root/.config/opencode");
  vm.addFile("/root/.config/opencode/opencode.json", OPENCODE_CONFIG_JSON, 0o644);
  vm.makeDir("/usr/local/bin");
  vm.addFile("/usr/local/bin/opencode", OPENCODE_BIN_WRAPPER, 0o755);
}
/** Cold-loading the 16 MB bundle in the emulator is slow until the recipe
 *  ships a warm snapshot; be generous before declaring the launch dead. */
const LAUNCH_TIMEOUT_MS = 180_000;
/** The container's virtual-server scratch buffer is 32 KB; stay safely under. */
const SCRATCH_LIMIT = 30_000;

interface HttpReply {
  status: number;
  body: string;
}

export function createOpencodeAdapter(handle: TerminalHandle): ModelAdapter {
  let sessionId: string | null = null;
  let launching: Promise<void> | null = null;

  async function request(method: string, path: string, payload?: unknown): Promise<HttpReply> {
    const body = payload === undefined ? "" : JSON.stringify(payload);
    const raw =
      `${method} ${path} HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${PORT}\r\n` +
      `Accept: application/json\r\n` +
      (body ? `Content-Type: application/json\r\nContent-Length: ${new TextEncoder().encode(body).length}\r\n` : "") +
      `Connection: close\r\n\r\n` +
      body;
    // The container writes the request into a fixed 32 KB scratch buffer without
    // bounds-checking, so an oversized request would silently corrupt WASM
    // memory. Fail cleanly instead (a very long user prompt is the only way to
    // hit this on the opencode path — its own agent loop runs server-side).
    if (new TextEncoder().encode(raw).length > SCRATCH_LIMIT) {
      throw new Error(
        `request too large for the in-VM HTTP scratch buffer (${SCRATCH_LIMIT} bytes) — shorten the prompt`,
      );
    }
    const bytes = await handle.vm.virtualServer.injectConnection(PORT, raw);
    const res = parseHttpResponse(bytes);
    return { status: res.status, body: new TextDecoder().decode(res.body) };
  }

  async function serverUp(): Promise<boolean> {
    try {
      return (await request("GET", "/config")).status === 200;
    } catch {
      return false;
    }
  }

  /** Install the apps (idempotent) and start `opencode serve`, once. */
  function ensureServer(onProgress?: (fraction: number) => void): Promise<void> {
    return (launching ??= (async () => {
      if (await serverUp()) {
        onProgress?.(1);
        return;
      }
      // node is required (published catalog). ripgrep powers opencode's grep
      // tools but is not needed to reach listening, so it is best-effort.
      if (!(await handle.installApp("node", { quiet: true }))) {
        throw new Error(`install of "node" from the catalog failed`);
      }
      onProgress?.(0.33);
      await handle.installApp("ripgrep", { quiet: true }); // best-effort
      onProgress?.(0.6);
      // opencode: install from the catalog if the recipe is published, else (dev)
      // seed the tree from the vite-served /opencode/ bundle so the panel works
      // before the recipe ships.
      if (!(await handle.installApp("opencode", { quiet: true }))) {
        await devSeedOpencode(handle.vm);
      }
      onProgress?.(0.9);
      handle.vm.writeStdin(`opencode serve --port ${PORT} --hostname 127.0.0.1\r`);
      const start = Date.now();
      while (Date.now() - start < LAUNCH_TIMEOUT_MS) {
        if (await serverUp()) {
          onProgress?.(1);
          return;
        }
        await new Promise((r) => setTimeout(r, 1_500));
      }
      throw new Error(
        `opencode serve did not answer on 127.0.0.1:${PORT} within ${LAUNCH_TIMEOUT_MS / 1000}s`,
      );
    })().catch((e) => {
      launching = null; // allow a retry after a failed launch
      throw e;
    }));
  }

  async function ensureSession(): Promise<string> {
    if (sessionId) return sessionId;
    const res = await request("POST", "/session", {});
    if (res.status !== 200 && res.status !== 201) {
      throw new Error(`opencode POST /session → ${res.status}: ${res.body.slice(0, 200)}`);
    }
    const s = JSON.parse(res.body) as { id?: string };
    if (!s.id) throw new Error("opencode POST /session returned no id");
    sessionId = s.id;
    return s.id;
  }

  /** Flatten an opencode message-info response to its visible text parts. */
  function textOfMessage(body: string): string {
    try {
      const msg = JSON.parse(body) as {
        parts?: Array<{ type?: string; text?: string }>;
        info?: { error?: { data?: { message?: string } } };
      };
      const err = msg.info?.error?.data?.message;
      if (err) return `opencode error: ${err}`;
      const texts = (msg.parts ?? [])
        .filter((p) => p.type === "text" && typeof p.text === "string")
        .map((p) => p.text as string);
      if (texts.length) return texts.join("\n").trim();
    } catch {
      /* fall through to the raw body */
    }
    return body.trim();
  }

  return {
    id: "opencode",
    label: "opencode (in-VM)",

    async availability(): Promise<AvailabilityInfo> {
      if (await serverUp()) return { state: "available" };
      return {
        state: "downloadable",
        detail:
          "Installs opencode (+ node, ripgrep) from the catalog into the VM and starts its server",
      };
    },

    prepare(onProgress?: (fraction: number) => void): Promise<void> {
      return ensureServer(onProgress);
    },

    // opencode runs its own tools inside the guest; never route to panel tools.
    async route(): Promise<RouteDecision> {
      return { tool: "chat", args: {} };
    },

    async generateProject(): Promise<GeneratedProject> {
      throw new Error(
        "opencode edits files in the VM itself — ask it in chat instead of codegen",
      );
    },

    async chat(
      userText: string,
      _history: ChatTurn[],
      onDelta?: (delta: string) => void,
    ): Promise<string> {
      await ensureServer();
      let id = await ensureSession();
      let res = await request("POST", `/session/${id}/message`, {
        model: { providerID: PROVIDER_ID, modelID: MODEL_ID },
        parts: [{ type: "text", text: userText }],
      });
      if (res.status === 404) {
        // The server restarted since we created the session — start a new one.
        sessionId = null;
        id = await ensureSession();
        res = await request("POST", `/session/${id}/message`, {
          model: { providerID: PROVIDER_ID, modelID: MODEL_ID },
          parts: [{ type: "text", text: userText }],
        });
      }
      if (res.status !== 200) {
        throw new Error(`opencode message → ${res.status}: ${res.body.slice(0, 300)}`);
      }
      const text = textOfMessage(res.body);
      if (text) onDelta?.(text);
      return text;
    },

    destroy(): void {
      // Leave the guest server running — restarting it is the expensive part.
      sessionId = null;
    },
  };
}
