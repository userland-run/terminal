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
  vm.setTty(true); // real guest tty: isatty=true, in-VM echo + line discipline

  // Render loop — full redraw per frame; violet cursor blinks at 530ms.
  const tick = () => {
    const snap = vm.termSnapshot();
    if (snap) renderer.draw(snap, Date.now() % 1060 < 530);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  // Input — forward raw keystrokes to the guest tty. The guest echoes and
  // line-edits (ash's line editor in raw mode, or the in-VM cooked-mode line
  // discipline), so the front end does no local echo.
  window.addEventListener("keydown", (e) => {
    if (e.metaKey || e.altKey) return;
    let bytes: string | null = null;
    if (e.ctrlKey) {
      const k = e.key.toLowerCase();
      if (k.length === 1 && k >= "a" && k <= "z") {
        bytes = String.fromCharCode(k.charCodeAt(0) - 96); // Ctrl-A..Z -> 0x01..0x1a
      } else {
        return;
      }
    } else if (e.key === "Enter") bytes = "\r";
    else if (e.key === "Backspace") bytes = "\x7f";
    else if (e.key === "Tab") bytes = "\t";
    else if (e.key === "Escape") bytes = "\x1b";
    else if (e.key === "ArrowUp") bytes = "\x1b[A";
    else if (e.key === "ArrowDown") bytes = "\x1b[B";
    else if (e.key === "ArrowRight") bytes = "\x1b[C";
    else if (e.key === "ArrowLeft") bytes = "\x1b[D";
    else if (e.key.length === 1) bytes = e.key;
    else return;
    vm.writeStdin(bytes);
    e.preventDefault();
  });

  // Boot an interactive shell. The run loop yields to the event loop (and parks
  // on empty stdin), so rendering and keystrokes keep flowing.
  vm.run("sh -i", { maxSteps: 5_000_000_000 }).then((r) => {
    vm.termEcho(`\r\n[shell exited: ${r.exitCode}]\r\n`);
  });
}

main();
