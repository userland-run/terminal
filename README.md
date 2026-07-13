# Console — the terminal front-end for userland.run

A GPU-composited terminal for [NanoVM](https://github.com/userland-run/nano), the multi-runner
platform — it renders real BusyBox / Node.js output from the in-browser RISC-V runner, and grows
into a full mini-IDE (file tree, code editor, live preview) when you turn those panels on.

> 📚 **Documentation: <https://userland.run/docs/sdk-terminal>** (embedded terminal) and the
> [SDK reference](https://userland.run/docs/). This repo is the UI; you normally consume it through
> the SDK — see [Part of userland.run](#part-of-userlandrun).

Spec: [`specs/terminal/base-concept.md`](https://github.com/userland-run/specs/blob/main/terminal/base-concept.md).
Design tokens: [`style-guide/terminal`](https://github.com/userland-run/style-guide/tree/main/terminal).
All monospace is **JetBrains Mono**.

## What it is

The terminal ships as a **Shadow-DOM `<nano-terminal>` custom element** plus an imperative
`createTerminal()` factory. The ANSI/`vte` parser and cell grid live **inside `nano.wasm`**
(`nano/runners/riscv/src/term.rs`); this package reads the grid out of linear memory and paints it with a
**WebGPU renderer** (with a 2D-canvas fallback when WebGPU is unavailable). A DOM text mirror
backs accessibility (and makes the screen assertable in tests).

```
guest stdout ──► console_write tap ──► vte parser ──► cell grid   (all in nano.wasm)
                                                          │
keystrokes ──► real guest tty (writeStdin) ◄──┐    grid snapshot ──► WebGPU / 2D renderer
                                              └────────────────────────────  a11y <pre> mirror
```

Line discipline, echo, and SIGINT are handled by the **real tty inside the VM** (`setTty(true)`),
not a front-end cooked mode.

### Composable panels

Each feature is opt-in via `TerminalConfig.features`:

| Feature | What it adds |
| ------- | ------------ |
| `palette`  | ⌘K command palette (font size, sidebar, actions) |
| `files`    | File-tree sidebar with CRUD over the guest VFS, plus local-folder mapping (File System Access API) |
| `editor`   | CodeMirror 6 editor tabs (lazy-loaded, themed) |
| `preview`  | Iframe preview of in-VM HTTP servers via the SDK serve bridge |
| `catalog`  | Browse + install apps from the [app catalog](https://github.com/userland-run/catalog) |
| `assistant`| AI sidebar that drives the terminal in natural language + a codegen playground (see below) |

The bare terminal (no features) is a plain shell; enabling `files` + `editor` + `preview` turns it
into a VS-Code-style IDE that can edit a project and preview a dev server running inside the VM.

### AI assistant

The `assistant` panel lets you steer the terminal conversationally ("list the files", "write a
fibonacci script and run it") and, in **Codegen** mode, generate a small app that is written into the
VFS, compiled with an in-VM toolchain, and run — the browser VM as an offline, sandboxed build+run
target. It's built on a single **VM tool registry** (`write_file`, `run_shell`, `run_node`, `serve`,
`build_and_run`, …) exposed to two front-ends:

- **In-page** — Chrome's on-device [Prompt API](https://developer.chrome.com/docs/ai/prompt-api)
  (Gemini Nano). Zero server, no API keys, fully offline. Nano is a small model — great at intent
  routing and short snippets, not at authoring large apps.
- **[WebMCP](https://developer.chrome.com/docs/ai/webmcp)** — the same tools are registered on
  `document.modelContext`, so Chrome's built-in agent can drive the terminal too.

**Pluggable cloud model (optional).** For real multi-file / compiled projects, inject a cloud model.
It's keyless-by-default — supply a `generate` callback so API keys stay in your proxy:

```ts
await createTerminal(el, {
  features: { assistant: true },
  assistant: {
    cloud: {
      label: "Gemini",
      generate: async ({ system, messages, responseSchema }) => {
        const r = await fetch("/api/ai", { method: "POST", body: JSON.stringify({ system, messages, responseSchema }) });
        return (await r.json()).text; // your proxy holds the key
      },
    },
  },
});
```

**Enabling on-device AI (Chrome).** The Prompt API and WebMCP are flag/origin-trial gated as of
early 2026. For local dev, enable in `chrome://flags`: `#prompt-api-for-gemini-nano`,
`#optimization-guide-on-device-model`, and (for WebMCP) `#enable-webmcp-testing`; confirm the model
at `chrome://on-device-internals`. When built-in AI is unavailable the panel degrades gracefully —
it shows how to enable it, and the terminal is otherwise fully functional. Disable the panel entirely
with the `no-assistant` attribute or `features: { assistant: false }`.

## Use it (as a consumer)

The terminal is published as the **`/terminal` subpath of the SDK**, so most apps never touch this
repo directly:

```ts
import { defineNanoTerminal, createTerminal } from "@userland-run/nano-sdk/terminal";

// Declarative: a custom element configured by attributes.
defineNanoTerminal();
// <nano-terminal wasm-url="/nano.wasm" service-worker-url="/nano-sw.js"
//                shell-command="sh -i" font-px="14" ram-mb="512"></nano-terminal>

// Or imperative, with full feature config:
const term = await createTerminal(document.querySelector("#root"), {
  wasmUrl: "/nano.wasm",
  features: { files: true, editor: true, preview: true, palette: true, catalog: true },
});
await term.openFile("/work/index.js");
```

Requires a **SharedArrayBuffer-capable, cross-origin-isolated** page (COOP/COEP). The SDK ships a
service worker that injects the headers if you can't set them at the server.

## Develop this repo

```bash
# 1. Build a nano.wasm with the terminal exports + a bundled busybox, in the sibling nano repo:
cd ../nano
cargo build --release --no-default-features --features busybox --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/release/nanovm.wasm ../terminal/public/nano.wasm
# (or grab a prebuilt nano.busybox.wasm from a nano release and save it as public/nano.wasm)

# 2. Run the dev server (sends COOP/COEP headers; @container resolves to ../nano/runners/riscv/host):
cd ../terminal
npm install
npm run dev
```

`public/nano.wasm` and `public/nano-sw.js` are build artifacts (gitignored); `npm run dev`/`build`
sync the service worker from the sibling SDK automatically.

### Tests

```bash
npx playwright install chromium
npm run test:e2e        # Playwright e2e against the built+previewed app (boot, echo, a11y, ⌘K palette)
```

The e2e suite asserts against the DOM text mirror (`pre[aria-label="Terminal screen"]`), since the
WebGPU/canvas surface is opaque to the test runner.

## Part of userland.run

This is one repo in the **[userland.run](https://userland.run)** workspace:

| Repo | What it is |
| ---- | ---------- |
| [nano](https://github.com/userland-run/nano) | The multi-runner platform — RV64GC emulator core + node/wasm/boa runners |
| [sdk](https://github.com/userland-run/sdk) | `@userland-run/nano-sdk` — the SDK; re-exports this terminal at `@userland-run/nano-sdk/terminal` |
| **[terminal](https://github.com/userland-run/terminal)** | `<nano-terminal>` web component — **this repo** |
| [catalog](https://github.com/userland-run/catalog) | Signed app marketplace (node, typescript, eslint, …) |
| [website](https://github.com/userland-run/website) | Landing page + the hosted docs at [userland.run/docs](https://userland.run/docs/) |

Licensed `AGPL-3.0-only OR LicenseRef-UEL` — see [LICENSE.md](./LICENSE.md).
