// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run terminal; dual-licensed - see LICENSE.md.

// Unit tests for the guest-facing OpenAI facade (src/assistant/llm-bridge.ts):
// SSE chunk framing, non-streaming completions, and the error paths — no VM,
// no worker, no model; the engine is a fake LocalModel. Run: npm run test:bridge

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

let createLlmBridgeHandler;

before(async () => {
  // The source is TypeScript with extensionless imports — bundle it for Node
  // with the same esbuild vite uses (type-only imports are stripped, so the
  // @container ambient module never needs resolving).
  const { build } = await import("esbuild");
  const entry = fileURLToPath(new URL("../src/assistant/llm-bridge.ts", import.meta.url));
  const outfile = join(mkdtempSync(join(tmpdir(), "llm-bridge-test-")), "llm-bridge.mjs");
  await build({ entryPoints: [entry], outfile, bundle: true, format: "esm", platform: "neutral" });
  ({ createLlmBridgeHandler } = await import(pathToFileURL(outfile).href));
});

/** A fake LocalModel whose rawGenerate emits fixed deltas. */
function fakeLocal({ ready = true, busy = false, deltas = ["Hel", "lo", " world"] } = {}) {
  const calls = [];
  return {
    calls,
    adapter: {},
    maxSeq: 2048,
    isReady: () => ready,
    isBusy: () => busy,
    ensureReady: async () => {},
    rawGenerate: async (prompt, steps, onDelta) => {
      calls.push({ prompt, steps });
      for (const d of deltas) onDelta?.(d);
      return deltas.join("");
    },
  };
}

const chatReq = (body) => ({
  method: "POST",
  url: "http://nanoinfer.internal/v1/chat/completions",
  headers: { "content-type": "application/json" },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

async function readAll(stream) {
  const reader = stream.getReader();
  let text = "";
  const dec = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += dec.decode(value, { stream: true });
  }
  return text;
}

test("stream:true → OpenAI SSE: role, deltas, finish, [DONE]", async () => {
  const local = fakeLocal();
  const handler = createLlmBridgeHandler(local);
  const res = await handler(chatReq({ messages: [{ role: "user", content: "hi" }], stream: true }));

  assert.equal(res.status, 200);
  assert.equal(res.headers["content-type"], "text/event-stream");
  assert.ok(typeof res.body?.getReader === "function", "body must be a ReadableStream");

  const text = await readAll(res.body);
  const frames = text.split("\n\n").filter(Boolean);
  assert.ok(frames.every((f) => f.startsWith("data: ")), "every frame is a data: line");
  const payloads = frames.map((f) => f.slice(6));

  assert.equal(payloads.length, 6, "role + 3 deltas + finish + [DONE]");
  assert.equal(payloads[5], "[DONE]");

  const chunks = payloads.slice(0, 5).map((p) => JSON.parse(p));
  for (const c of chunks) {
    assert.equal(c.object, "chat.completion.chunk");
    assert.equal(c.model, "nanoinfer-local");
    assert.equal(c.choices[0].index, 0);
    assert.equal(c.id, chunks[0].id, "one id across the stream");
  }
  assert.equal(chunks[0].choices[0].delta.role, "assistant");
  assert.deepEqual(
    chunks.slice(1, 4).map((c) => c.choices[0].delta.content),
    ["Hel", "lo", " world"],
  );
  assert.equal(chunks[4].choices[0].finish_reason, "stop");
  assert.deepEqual(chunks[4].choices[0].delta, {});

  // The Qwen template made it to the engine.
  assert.match(local.calls[0].prompt, /<\|im_start\|>user\nhi<\|im_end\|>\n<\|im_start\|>assistant\n$/);
});

test("non-streaming → a single chat.completion JSON", async () => {
  const handler = createLlmBridgeHandler(fakeLocal());
  const res = await handler(chatReq({ messages: [{ role: "user", content: "hi" }], max_tokens: 32 }));
  assert.equal(res.status, 200);
  assert.equal(res.headers["content-type"], "application/json");
  const body = JSON.parse(res.body);
  assert.equal(body.object, "chat.completion");
  assert.equal(body.choices[0].message.content, "Hello world");
  assert.equal(body.choices[0].finish_reason, "stop");
  assert.ok(body.usage.total_tokens > 0);
});

test("model not prepared → 503 model_not_loaded (no auto-download)", async () => {
  const local = fakeLocal({ ready: false });
  const handler = createLlmBridgeHandler(local);
  const res = await handler(chatReq({ messages: [{ role: "user", content: "hi" }] }));
  assert.equal(res.status, 503);
  const err = JSON.parse(res.body).error;
  assert.equal(err.type, "model_not_loaded");
  assert.match(err.message, /Assistant panel/);
  assert.equal(local.calls.length, 0, "must not touch the engine");
});

test("bad JSON body → 400 invalid_request_error", async () => {
  const handler = createLlmBridgeHandler(fakeLocal());
  const res = await handler(chatReq("{nope"));
  assert.equal(res.status, 400);
  assert.equal(JSON.parse(res.body).error.type, "invalid_request_error");
});

test("GET /v1/models → the local model entry", async () => {
  const handler = createLlmBridgeHandler(fakeLocal());
  const res = await handler({ method: "GET", url: "http://nanoinfer.internal/v1/models", headers: {}, body: "" });
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.object, "list");
  assert.equal(body.data[0].id, "nanoinfer-local");
});

test("unknown path → 404; busy engine → 429", async () => {
  const handler = createLlmBridgeHandler(fakeLocal());
  const notFound = await handler({ method: "GET", url: "http://nanoinfer.internal/v2/x", headers: {}, body: "" });
  assert.equal(notFound.status, 404);

  const busyHandler = createLlmBridgeHandler(fakeLocal({ busy: true }));
  const busy = await busyHandler(chatReq({ messages: [{ role: "user", content: "hi" }] }));
  assert.equal(busy.status, 429);
});
