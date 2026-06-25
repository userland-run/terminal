# Console — terminal front-end for userland.run

The GPU-composited terminal for [NanoVM](https://github.com/userland-run/nano) —
runs real BusyBox/Node.js output from the in-browser RISC-V emulator. Spec:
`specs/terminal/base-concept.md` (in the `specs` repo). Design tokens:
`style-guide/terminal`.

## Status — Phase 0 (harness)

A working interactive `sh` prompt at a fixed 80×25 grid, proving the pipeline:

```
guest stdout ──► console_write tap ──► vte parser ──► cell grid   (all in nano.wasm)
                                                          │
keystrokes ──► writeStdin / local echo ──► guest    grid snapshot ──► canvas renderer
```

The ANSI/`vte` parser and cell grid live **inside nano.wasm** (`nano/src/term.rs`);
this package reads the grid out of linear memory and paints it to a 2D canvas
(a throwaway renderer — Vello/WebGPU lands in Phase 2). Input uses a temporary
front-end cooked mode (local echo); real tty echo / line discipline / SIGINT
move into the VM in Phase 1.

All monospace is **JetBrains Mono**.

## Run it

```bash
# 1. Build a nano.wasm that has the terminal exports + a bundled busybox:
cd ../nano
cargo build --release --no-default-features --features busybox --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/release/nanovm.wasm ../terminal/public/nano.wasm

# 2. Run the dev server:
cd ../terminal
npm install
npm run dev
```

Then type commands at the `/ #` prompt (`ls`, `echo hi`, `cat`, `pwd`, …).

> Requires a WebGPU-less but SharedArrayBuffer-capable browser; the dev server
> sends the COOP/COEP headers for cross-origin isolation. The `@container` alias
> resolves to the sibling `../nano/container` module.
