// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run terminal; dual-licensed - see LICENSE.md.

import { NanoVM } from "@container/nanovm.mjs";
import { CanvasRenderer } from "./renderer";

const COLS = 80;
const ROWS = 25;

async function main() {
  const canvas = document.getElementById("screen") as HTMLCanvasElement;
  const renderer = new CanvasRenderer(canvas, 15);

  // Wait for JetBrains Mono so cell metrics are measured against the real font.
  try {
    await document.fonts.load(`15px "JetBrains Mono"`);
    await document.fonts.load(`700 15px "JetBrains Mono"`);
  } catch {
    /* fall back to system monospace */
  }
  renderer.measure();
  renderer.resize(COLS, ROWS);

  const vm = await NanoVM.create({ ramMB: 256, wasm: "/nano.wasm" });
  vm.termInit(COLS, ROWS);

  // Render loop — full redraw per frame; violet cursor blinks at 530ms.
  const tick = () => {
    const snap = vm.termSnapshot();
    if (snap) renderer.draw(snap, Date.now() % 1060 < 530);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  // Input — Phase-0 front-end cooked mode: buffer a line, echo locally into the
  // grid, send the whole line to the guest on Enter. Real echo / line discipline
  // / SIGINT move into the VM in Phase 1.
  let line = "";
  window.addEventListener("keydown", (e) => {
    if (e.ctrlKey && (e.key === "c" || e.key === "C")) {
      vm.termEcho("^C\r\n");
      vm.writeStdin("\n"); // fresh prompt (real SIGINT is Phase 1)
      line = "";
      e.preventDefault();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    if (e.key === "Enter") {
      vm.termEcho("\r\n");
      vm.writeStdin(line + "\n");
      line = "";
      e.preventDefault();
    } else if (e.key === "Backspace") {
      if (line) {
        line = line.slice(0, -1);
        vm.termEcho("\b \b");
      }
      e.preventDefault();
    } else if (e.key.length === 1) {
      line += e.key;
      vm.termEcho(e.key);
      e.preventDefault();
    }
  });

  // Boot an interactive shell. The run loop yields to the event loop (and parks
  // on empty stdin), so rendering and keystrokes keep flowing.
  vm.run("sh -i", { maxSteps: 5_000_000_000 }).then((r) => {
    vm.termEcho(`\r\n[shell exited: ${r.exitCode}]\r\n`);
  });
}

main();
