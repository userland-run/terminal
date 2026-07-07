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
  /** "qwen" (default) or "ornith" (the 9B GDN hybrid). */
  engine?: "qwen" | "ornith";
  /** Qwen path: GGUF; Ornith path: the packed Q4 safetensors artifact. */
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

/** L3 forced-choice: return exactly one of `choices` (guaranteed-valid routing). */
interface ChooseMsg {
  type: "choose";
  id: number;
  prompt: string;
  choices: string[];
  /** True when `prompt` is already fully templated (no chat wrapper). */
  raw?: boolean;
}

/**
 * Append-only continuation (L1): prefill `text` (raw, caller-templated) at the
 * current KV position and stream up to `steps` tokens. `reset` starts a fresh
 * conversation first. Unlike "chat", the KV is retained across calls so a long
 * conversation only ever prefills its newest turn.
 */
interface AppendMsg {
  type: "generateAppend";
  id: number;
  text: string;
  steps: number;
  reset?: boolean;
}

/**
 * JSON-schema grammar-constrained generation: the reply is GUARANTEED to be a
 * JSON document conforming to `schema` (engine L3 full grammar) — used for
 * tool-argument filling.
 */
interface JsonMsg {
  type: "json";
  id: number;
  prompt: string;
  /** JSON Schema as a JSON string (engine subset: object of typed props). */
  schema: string;
  /** True when `prompt` is already fully templated (no chat wrapper). */
  raw?: boolean;
}

/** L1 checkpoint ops so the adapter can run scratch work (routing) KV-neutrally. */
interface SnapshotMsg {
  type: "snapshot";
  id: number;
}

interface RestoreMsg {
  type: "restore";
  id: number;
  ckpt: number;
}

interface DropCkptMsg {
  type: "dropCkpt";
  id: number;
  ckpt: number;
}

type InMsg =
  | InitMsg
  | ChatMsg
  | ChooseMsg
  | JsonMsg
  | AppendMsg
  | SnapshotMsg
  | RestoreMsg
  | DropCkptMsg;

interface OrnithSessionLike {
  adapter(): string;
  reset(): void;
  generate(prompt: string, steps: number, onToken: (piece: string) => void): Promise<string>;
  /** Append-only continuation at the live state (L1); stats include kv_pos. */
  generateAppend(text: string, steps: number, onToken: (piece: string) => void): Promise<string>;
  /** L3 forced choice (clobbers the conversation state). */
  generateChoice(prompt: string, choices: string[], raw: boolean): Promise<string>;
  /** L3 JSON-schema grammar generation (clobbers the conversation state). */
  generateJson(prompt: string, schemaJson: string, raw: boolean): Promise<string>;
  snapshot(): number;
  restore(id: number): void;
  dropCheckpoint(id: number): void;
}

interface QwenSessionLike {
  adapter(): string;
  reset(): void;
  generate(
    prompt: string,
    steps: number,
    raw: boolean,
    onToken: (piece: string) => void,
  ): Promise<string>;
  generateChoice(prompt: string, choices: string[], raw: boolean): Promise<string>;
  generateJson(prompt: string, schemaJson: string, raw: boolean): Promise<string>;
  generateAppend(text: string, steps: number, onToken: (piece: string) => void): Promise<string>;
  snapshot(): number;
  restore(id: number): void;
  dropCheckpoint(id: number): void;
}

let session: QwenSessionLike | null = null;
let ornith: OrnithSessionLike | null = null;

const post = (msg: unknown) => (self as unknown as Worker).postMessage(msg);

/** Fetch with OPFS caching: one download per browser profile, ever. */
/** OPFS cache key: the full URL, sanitized. Basenames alone collide — the
 *  Qwen and Ornith artifacts are both served as `tokenizer.json`. */
function cacheKey(url: string): string {
  return encodeURIComponent(new URL(url, self.location.href).href);
}

async function cachedFetch(url: string, label: string): Promise<Uint8Array> {
  const name = cacheKey(url);
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

/** Bytes streamed between explicit flushes while a download runs. A sync
 *  access handle persists on flush(), so a dropped connection, crashed tab,
 *  or reload loses at most this much — and Range-resume picks up from the
 *  flushed size. */
const FLUSH_BYTES = 64 << 20;

/** Worker-only OPFS sync access handle (lib.dom lacks the type). */
interface SyncHandle {
  read(buffer: Uint8Array, opts?: { at?: number }): number;
  write(buffer: Uint8Array, opts?: { at?: number }): number;
  getSize(): number;
  flush(): void;
  close(): void;
}

const syncHandle = (h: FileSystemFileHandle): Promise<SyncHandle> =>
  (h as FileSystemFileHandle & { createSyncAccessHandle(): Promise<SyncHandle> })
    .createSyncAccessHandle();

/**
 * Stream a URL into an OPFS file (skip when cached); return its handle.
 * Resumable: data lands in `<name>.part` through a sync access handle
 * (positional writes + periodic flush — no writable-stream swap-file
 * semantics, which both copy the whole file per reopen and race the
 * handle's cached state) and is renamed to `<name>` only when complete, so
 * a partial download is never mistaken for a finished one. On retry (up to
 * 5 attempts, or a fresh call after a crash/reload) the fetch resumes from
 * the flushed size with an HTTP Range request; servers that ignore Range
 * restart from zero.
 */
async function fetchToOpfs(url: string, label: string): Promise<FileSystemFileHandle> {
  const name = cacheKey(url);
  const partName = `${name}.part`;
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle("nanoinfer-models", { create: true });
  try {
    const handle = await dir.getFileHandle(name);
    const file = await handle.getFile();
    if (file.size > 0) {
      post({ type: "progress", phase: "download", label, loaded: file.size, total: file.size });
      return handle;
    }
  } catch {
    // not cached
  }

  let lastError: unknown = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1000 * attempt));
    let sync: SyncHandle | null = null;
    try {
      const part = await dir.getFileHandle(partName, { create: true });
      sync = await syncHandle(part);
      let have = sync.getSize();
      const resp = await fetch(
        url,
        have > 0 ? { headers: { Range: `bytes=${have}-` } } : undefined,
      );
      if (!resp.ok || !resp.body) throw new Error(`${url}: HTTP ${resp.status}`);
      let total: number;
      if (have > 0 && resp.status === 206) {
        // Content-Range: bytes <from>-<to>/<total>
        total = Number(resp.headers.get("content-range")?.split("/")[1] ?? 0);
      } else {
        // Full response (fresh, or the server ignored the Range) — restart.
        have = 0;
        total = Number(resp.headers.get("content-length") ?? 0);
      }
      const reader = resp.body.getReader();
      let sinceFlush = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        sync.write(value, { at: have });
        have += value.length;
        sinceFlush += value.length;
        post({ type: "progress", phase: "download", label, loaded: have, total });
        if (sinceFlush >= FLUSH_BYTES) {
          sync.flush();
          sinceFlush = 0;
        }
      }
      sync.flush();
      sync.close();
      sync = null;
      if (total > 0 && have !== total) {
        throw new Error(`${url}: got ${have} of ${total} bytes`);
      }
      await (
        part as FileSystemFileHandle & { move(name: string): Promise<void> }
      ).move(name);
      return await dir.getFileHandle(name);
    } catch (e) {
      lastError = e;
      try {
        sync?.close();
      } catch {
        // already closed
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function initOrnith(msg: InitMsg): Promise<void> {
  const engine = (await import(/* @vite-ignore */ `${msg.engineBase}/nanoinfer_wasm.js`)) as {
    default: (opts: { module_or_path: string }) => Promise<unknown>;
    OrnithSession: {
      load(
        readFn: (offset: number, len: number) => Uint8Array,
        totalLen: number,
        tokenizer: Uint8Array,
        maxSeq: number,
        onProgress: (done: number, total: number) => void,
      ): Promise<OrnithSessionLike>;
    };
  };
  await engine.default({ module_or_path: `${msg.engineBase}/nanoinfer_wasm_bg.wasm` });

  // The 5.6 GB artifact NEVER enters RAM: it streams into OPFS, then a
  // worker-only FileSystemSyncAccessHandle serves synchronous reads to the
  // wasm loader through a reused scratch buffer.
  const handle = await fetchToOpfs(msg.ggufUrl, "model");
  const sync = await syncHandle(handle);
  const size = sync.getSize();
  const scratch = new Uint8Array(1 << 20);
  const readFn = (offset: number, len: number): Uint8Array => {
    const n = Math.min(len, scratch.length);
    const got = sync.read(scratch.subarray(0, n), { at: offset });
    return scratch.subarray(0, got);
  };
  const tokenizer = await cachedFetch(msg.tokenizerUrl, "tokenizer");
  ornith = await engine.OrnithSession.load(readFn, size, tokenizer, msg.maxSeq, (done, total) => {
    post({ type: "progress", phase: "upload", loaded: done, total });
  });
  sync.close();
  post({ type: "ready", adapter: ornith.adapter() });
}

async function init(msg: InitMsg): Promise<void> {
  if (msg.engine === "ornith") {
    return initOrnith(msg);
  }
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
  if (ornith) {
    ornith.reset();
    const stats = await ornith.generate(msg.prompt, msg.steps, (piece) => {
      post({ type: "delta", id: msg.id, text: piece });
    });
    post({ type: "done", id: msg.id, stats: JSON.parse(stats) as Record<string, number> });
    return;
  }
  if (!session) throw new Error("session not initialized");
  session.reset();
  const stats = await session.generate(msg.prompt, msg.steps, true, (piece) => {
    post({ type: "delta", id: msg.id, text: piece });
  });
  post({ type: "done", id: msg.id, stats: JSON.parse(stats) as Record<string, number> });
}

async function choose(msg: ChooseMsg): Promise<void> {
  if (ornith) {
    const choice = await ornith.generateChoice(msg.prompt, msg.choices, !!msg.raw);
    post({ type: "done", id: msg.id, choice });
    return;
  }
  if (!session) throw new Error("session not initialized");
  const choice = await session.generateChoice(msg.prompt, msg.choices, !!msg.raw);
  post({ type: "done", id: msg.id, choice });
}

async function json(msg: JsonMsg): Promise<void> {
  if (ornith) {
    const out = await ornith.generateJson(msg.prompt, msg.schema, !!msg.raw);
    post({ type: "done", id: msg.id, json: out });
    return;
  }
  if (!session) throw new Error("session not initialized");
  const out = await session.generateJson(msg.prompt, msg.schema, !!msg.raw);
  post({ type: "done", id: msg.id, json: out });
}

async function generateAppend(msg: AppendMsg): Promise<void> {
  if (ornith) {
    if (msg.reset) ornith.reset();
    const stats = await ornith.generateAppend(msg.text, msg.steps, (piece) => {
      post({ type: "delta", id: msg.id, text: piece });
    });
    post({ type: "done", id: msg.id, stats: JSON.parse(stats) as Record<string, number> });
    return;
  }
  if (!session) throw new Error("session not initialized");
  if (msg.reset) session.reset();
  const stats = await session.generateAppend(msg.text, msg.steps, (piece) => {
    post({ type: "delta", id: msg.id, text: piece });
  });
  post({ type: "done", id: msg.id, stats: JSON.parse(stats) as Record<string, number> });
}

function snapshot(msg: SnapshotMsg): void {
  if (ornith) {
    post({ type: "done", id: msg.id, ckpt: ornith.snapshot() });
    return;
  }
  if (!session) throw new Error("session not initialized");
  post({ type: "done", id: msg.id, ckpt: session.snapshot() });
}

function restore(msg: RestoreMsg): void {
  if (ornith) {
    ornith.restore(msg.ckpt);
    post({ type: "done", id: msg.id });
    return;
  }
  if (!session) throw new Error("session not initialized");
  session.restore(msg.ckpt);
  post({ type: "done", id: msg.id });
}

function dropCkpt(msg: DropCkptMsg): void {
  if (ornith) {
    ornith.dropCheckpoint(msg.ckpt);
    post({ type: "done", id: msg.id });
    return;
  }
  if (!session) throw new Error("session not initialized");
  session.dropCheckpoint(msg.ckpt);
  post({ type: "done", id: msg.id });
}

self.addEventListener("message", (event: MessageEvent<InMsg>) => {
  const msg = event.data;
  const fail = (e: unknown) =>
    post({
      type: "error",
      id: msg.type === "init" ? undefined : msg.id,
      message: e instanceof Error ? e.message : String(e),
    });
  if (msg.type === "init") void init(msg).catch(fail);
  else if (msg.type === "chat") void chat(msg).catch(fail);
  else if (msg.type === "choose") void choose(msg).catch(fail);
  else if (msg.type === "json") void json(msg).catch(fail);
  else if (msg.type === "generateAppend") void generateAppend(msg).catch(fail);
  else if (msg.type === "snapshot") {
    try {
      snapshot(msg);
    } catch (e) {
      fail(e);
    }
  } else if (msg.type === "restore") {
    try {
      restore(msg);
    } catch (e) {
      fail(e);
    }
  } else if (msg.type === "dropCkpt") {
    try {
      dropCkpt(msg);
    } catch (e) {
      fail(e);
    }
  }
});
