// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run terminal; dual-licensed - see LICENSE.md.

// Engine worker for the local WebGPU model ("Local GPU" adapter): owns the
// nanoinfer wasm session and its GPUDevice, caches model bytes in OPFS, and
// streams generation deltas back over postMessage. The frame shapes mirror
// @userland-run/nanoinfer's engine protocol; this worker is replaced by that
// package's engine-worker host once it ships on npm.

interface InitMsg {
  type: "init";
  ggufUrl: string;
  tokenizerUrl: string;
  engineBase: string;
  maxSeq: number;
}

interface ChatMsg {
  type: "chat";
  id: number;
  /** Full raw prompt (chat template applied by the adapter). */
  prompt: string;
  steps: number;
}

type InMsg = InitMsg | ChatMsg;

interface QwenSessionLike {
  adapter(): string;
  reset(): void;
  generate(
    prompt: string,
    steps: number,
    raw: boolean,
    onToken: (piece: string) => void,
  ): Promise<string>;
}

let session: QwenSessionLike | null = null;

const post = (msg: unknown) => (self as unknown as Worker).postMessage(msg);

/** Fetch with OPFS caching: one download per browser profile, ever. */
async function cachedFetch(url: string, label: string): Promise<Uint8Array> {
  const name = url.split("/").pop() ?? "model.bin";
  let dir: FileSystemDirectoryHandle | null = null;
  try {
    const root = await navigator.storage.getDirectory();
    dir = await root.getDirectoryHandle("nanoinfer-models", { create: true });
    const handle = await dir.getFileHandle(name);
    const file = await handle.getFile();
    if (file.size > 0) {
      post({ type: "progress", phase: "download", label, loaded: file.size, total: file.size });
      return new Uint8Array(await file.arrayBuffer());
    }
  } catch {
    // Not cached (or OPFS unavailable) — fall through to the network.
  }

  const resp = await fetch(url);
  if (!resp.ok || !resp.body) throw new Error(`${url}: HTTP ${resp.status}`);
  const total = Number(resp.headers.get("content-length") ?? 0);
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    post({ type: "progress", phase: "download", label, loaded: received, total });
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.length;
  }

  if (dir) {
    try {
      const handle = await dir.getFileHandle(name, { create: true });
      const writable = await handle.createWritable();
      await writable.write(bytes);
      await writable.close();
    } catch {
      // Cache write failure is non-fatal (quota, private browsing).
    }
  }
  return bytes;
}

async function init(msg: InitMsg): Promise<void> {
  const engine = (await import(/* @vite-ignore */ `${msg.engineBase}/nanoinfer_wasm.js`)) as {
    default: (opts: { module_or_path: string }) => Promise<unknown>;
    QwenSession: {
      load(
        gguf: Uint8Array,
        tokenizer: Uint8Array,
        maxSeq: number,
        onProgress: (done: number, total: number) => void,
      ): Promise<QwenSessionLike>;
    };
  };
  await engine.default({ module_or_path: `${msg.engineBase}/nanoinfer_wasm_bg.wasm` });

  const gguf = await cachedFetch(msg.ggufUrl, "model");
  const tokenizer = await cachedFetch(msg.tokenizerUrl, "tokenizer");

  session = await engine.QwenSession.load(gguf, tokenizer, msg.maxSeq, (done, total) => {
    post({ type: "progress", phase: "upload", loaded: done, total });
  });
  post({ type: "ready", adapter: session.adapter() });
}

async function chat(msg: ChatMsg): Promise<void> {
  if (!session) throw new Error("session not initialized");
  session.reset();
  const stats = await session.generate(msg.prompt, msg.steps, true, (piece) => {
    post({ type: "delta", id: msg.id, text: piece });
  });
  post({ type: "done", id: msg.id, stats: JSON.parse(stats) as Record<string, number> });
}

self.addEventListener("message", (event: MessageEvent<InMsg>) => {
  const msg = event.data;
  const fail = (e: unknown) =>
    post({
      type: "error",
      id: msg.type === "chat" ? msg.id : undefined,
      message: e instanceof Error ? e.message : String(e),
    });
  if (msg.type === "init") void init(msg).catch(fail);
  else if (msg.type === "chat") void chat(msg).catch(fail);
});
