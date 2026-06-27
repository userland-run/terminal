// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run terminal; dual-licensed - see LICENSE.md.

import "./ui.css";
import type { TermSnapshot } from "@container/nanovm.mjs";
import { NanoVM } from "@container/nanovm.mjs";
import { CanvasRenderer, type TermRenderer } from "./renderer";
import { GpuRenderer } from "./gpu/renderer";
import { Chrome } from "./chrome";
import { CommandBar } from "./commandbar";
import { TerminalCatalog } from "./catalog";
import { A11yMirror } from "./a11y";
import {
  pixelToCell,
  isEmptySelection,
  extractText,
  type Selection,
} from "./selection";

const DEFAULT_FONT_PX = 12; // matches the style-guide comp's terminal text scale
const MIN_FONT_PX = 9;
const MAX_FONT_PX = 28;
const MAX_COLS = 200; // must match src/term.rs MAX_COLS
const MAX_ROWS = 64; // must match src/term.rs MAX_ROWS
const PAD = 12; // #terminal-area padding (var(--space-3)) — keep in sync with ui.css

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

async function main() {
  const chrome = new Chrome();
  const area = document.getElementById("terminal-area") as HTMLElement;
  const canvas = document.getElementById("screen") as HTMLCanvasElement;
  const a11y = new A11yMirror(document.body);

  // Cell metrics depend on the real font; wait for it before measuring.
  try {
    await document.fonts.load(`${DEFAULT_FONT_PX}px "JetBrains Mono"`);
    await document.fonts.load(`700 ${DEFAULT_FONT_PX}px "JetBrains Mono"`);
  } catch {
    /* fall back to system monospace */
  }

  // Prefer WebGPU; fall back to the 2D canvas.
  let renderer: TermRenderer;
  try {
    renderer = await GpuRenderer.create(canvas, DEFAULT_FONT_PX);
    chrome.setRenderer("WebGPU");
  } catch (e) {
    console.warn("[console] WebGPU unavailable — falling back to 2D canvas:", e);
    renderer = new CanvasRenderer(canvas, DEFAULT_FONT_PX);
    chrome.setRenderer("Canvas2D");
  }

  let fontPx = DEFAULT_FONT_PX;
  renderer.measure();

  // Grid that fits the terminal pane at the current cell metrics.
  const computeGrid = () => ({
    cols: clamp(Math.floor((area.clientWidth - 2 * PAD) / renderer.cellW), 1, MAX_COLS),
    rows: clamp(Math.floor((area.clientHeight - 2 * PAD) / renderer.cellH), 1, MAX_ROWS),
  });

  let cols = 80;
  let rows = 25;
  ({ cols, rows } = computeGrid());
  renderer.resize(cols, rows);
  chrome.setGrid(cols, rows);

  const vm = await NanoVM.create({ ramMB: 256, wasm: "/nano.wasm" });
  vm.termInit(cols, rows);
  vm.setTty(true); // real guest tty: isatty=true, in-VM echo + line discipline

  // Catalog: re-install anything the user installed in a prior session (chunks
  // come from the OPFS cache, so this is fast/offline). Non-blocking — the shell
  // is usable immediately; installed binaries appear in the VFS as they land.
  const catalog = new TerminalCatalog(vm);
  catalog.bindVm();        // scripts can `await nano.catalog.install(...)`
  void catalog.rehydrate();
  chrome.setSession("running");
  chrome.setStatus("live");
  chrome.setCwd("/");

  // Live uptime in the footer (the one stat we can source honestly client-side;
  // MIPS/heap/proc need VM introspection the host doesn't yet expose).
  const bootedAt = Date.now();
  const fmtUptime = (ms: number) => {
    const s = Math.floor(ms / 1000);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
  };
  setInterval(() => chrome.setUptime(fmtUptime(Date.now() - bootedAt)), 1000);

  // Re-fit the grid to the pane (and the guest, via SIGWINCH). `force` resizes
  // the surface even when cols×rows is unchanged (after a font-size change).
  let refitQueued = false;
  const refit = (force: boolean) => {
    refitQueued = false;
    const next = computeGrid();
    const gridChanged = next.cols !== cols || next.rows !== rows;
    if (!gridChanged && !force) return;
    cols = next.cols;
    rows = next.rows;
    renderer.resize(cols, rows); // resize the GPU surface (handles font change too)
    if (gridChanged) vm.termResize(cols, rows); // grid + guest winsize + SIGWINCH
    chrome.setGrid(cols, rows);
  };
  const relayoutSoon = () => {
    if (refitQueued) return;
    refitQueued = true;
    requestAnimationFrame(() => refit(false));
  };

  new ResizeObserver(relayoutSoon).observe(area);

  const setFont = (px: number) => {
    px = clamp(px, MIN_FONT_PX, MAX_FONT_PX);
    if (px === fontPx) return;
    fontPx = px;
    renderer.setFontSize(px);
    refit(true); // cell metrics changed — resize the surface even if cols×rows held
  };

  const toggleSidebar = () => {
    chrome.toggleSidebar();
    relayoutSoon(); // pane width changed
  };
  chrome.onSidebarToggle(toggleSidebar);

  // Render loop — draw is internally damage-gated, so idle frames are cheap.
  let lastSnap: TermSnapshot | null = null;
  let lastCur = -1;
  let scrollOffset = 0; // scrollback lines scrolled up from the live bottom (0 = live)
  let lastShownOffset = 0;
  const tick = () => {
    const snap = vm.termSnapshot(scrollOffset);
    if (snap) {
      lastSnap = snap;
      if (scrollOffset > snap.scrollMax) scrollOffset = snap.scrollMax;
      // Hide the (blinking) cursor while scrolled back — it isn't on screen.
      renderer.draw(snap, snap.cursorRow >= 0 && Date.now() % 1060 < 530);
      const cur = snap.cursorRow * 1000 + snap.cursorCol;
      if (cur !== lastCur) {
        lastCur = cur;
        if (snap.cursorRow >= 0) chrome.setCursor(snap.cursorRow, snap.cursorCol);
      }
      if (scrollOffset !== lastShownOffset) {
        lastShownOffset = scrollOffset;
        chrome.setStatus(scrollOffset > 0 ? `↑ ${scrollOffset}/${snap.scrollMax}` : "live");
      }
      a11y.update(snap, Date.now());
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  // Scrollback navigation: positive delta scrolls toward older output.
  const scrollBy = (delta: number) => {
    const max = lastSnap?.scrollMax ?? 0;
    scrollOffset = Math.max(0, Math.min(max, scrollOffset + delta));
  };

  // Mouse-wheel scrollback over the terminal pane.
  area.addEventListener("wheel", (e) => {
    const step = e.deltaMode === 1 ? 3 : Math.max(1, Math.round(Math.abs(e.deltaY) / 24));
    const before = scrollOffset;
    scrollBy(e.deltaY < 0 ? step : -step); // wheel up → older output
    if (scrollOffset !== before) e.preventDefault();
  }, { passive: false });

  // — selection (mouse drag over the grid) —
  let selection: Selection | null = null;
  let selecting = false;
  const setSel = (s: Selection | null) => {
    selection = s;
    renderer.setSelection?.(s);
  };
  canvas.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    selecting = true;
    const at = pixelToCell(e, canvas, renderer.cellW, renderer.cellH, cols, rows);
    setSel({ anchor: at, head: at });
    e.preventDefault();
  });
  window.addEventListener("mousemove", (e) => {
    if (!selecting || !selection) return;
    const head = pixelToCell(e, canvas, renderer.cellW, renderer.cellH, cols, rows);
    setSel({ anchor: selection.anchor, head });
  });
  window.addEventListener("mouseup", () => {
    if (!selecting) return;
    selecting = false;
    if (selection && isEmptySelection(selection)) setSel(null); // a plain click clears
  });

  // — clipboard —
  const copyText = async (text: string) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      chrome.setStatus("copied");
      setTimeout(() => chrome.setStatus("live"), 1200);
    } catch (err) {
      console.warn("[console] clipboard write failed:", err);
    }
  };
  const copySelection = () => {
    if (selection && !isEmptySelection(selection) && lastSnap)
      copyText(extractText(lastSnap, selection));
  };
  const copyAll = () => {
    if (lastSnap)
      copyText(
        extractText(lastSnap, {
          anchor: { row: 0, col: 0 },
          head: { row: lastSnap.rows - 1, col: lastSnap.cols - 1 },
        })
      );
  };

  // — Cmd-K command palette —
  const palette = new CommandBar([
    { id: "clear", title: "Clear screen", hint: "clear", run: () => vm.writeStdin("clear\r") },
    { id: "copy-sel", title: "Copy selection", hint: "⌘C", run: copySelection },
    { id: "copy-all", title: "Copy all visible", run: copyAll },
    { id: "font-inc", title: "Increase font size", hint: "⌘+", run: () => setFont(fontPx + 1) },
    { id: "font-dec", title: "Decrease font size", hint: "⌘-", run: () => setFont(fontPx - 1) },
    { id: "font-reset", title: "Reset font size", hint: "⌘0", run: () => setFont(DEFAULT_FONT_PX) },
    { id: "sidebar", title: "Toggle sidebar", hint: "⌘B", run: toggleSidebar },
  ]);

  // Catalog actions (browse / show-installed + one install entry per index app).
  // Fetched async so the palette is usable immediately; entries appear when the
  // signed index loads.
  void catalog.commands().then((cmds) => palette.addCommands(cmds));

  // Top-bar ⊘/⟳/⚙ + settings-popover rows. Restart fully re-creates the VM by
  // reloading — the honest "reboot" until the host exposes a soft reset.
  chrome.bindActions({
    onClear: () => vm.writeStdin("clear\r"),
    onRestart: () => location.reload(),
    onPalette: () => palette.show(),
  });

  // — input —
  window.addEventListener("keydown", (e) => {
    // While the palette is open it owns the keyboard (its input handles nav).
    if (palette.open) return;

    // UI shortcuts (⌘ on mac). ⌘ keystrokes are never forwarded to the guest.
    if (e.metaKey) {
      const k = e.key.toLowerCase();
      if (k === "k") palette.toggle();
      else if (k === "b") toggleSidebar();
      else if (k === "c") copySelection();
      else if (k === "=" || k === "+") setFont(fontPx + 1);
      else if (k === "-") setFont(fontPx - 1);
      else if (k === "0") setFont(DEFAULT_FONT_PX);
      else return; // leave other ⌘ combos to the browser
      e.preventDefault();
      return;
    }
    if (e.altKey) return;

    // Scrollback navigation (Shift+PageUp/Down/Home/End) — not forwarded to the guest.
    if (e.shiftKey && (e.key === "PageUp" || e.key === "PageDown" || e.key === "Home" || e.key === "End")) {
      if (e.key === "PageUp") scrollBy(rows - 1);
      else if (e.key === "PageDown") scrollBy(-(rows - 1));
      else if (e.key === "Home") scrollBy(lastSnap?.scrollMax ?? 0);
      else scrollOffset = 0; // End
      e.preventDefault();
      return;
    }

    // Forward raw keystrokes to the guest tty (the guest echoes / line-edits).
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
    scrollOffset = 0; // any typed input snaps back to the live bottom
    vm.writeStdin(bytes);
    e.preventDefault();
  });

  // Boot an interactive shell. The run loop yields to the event loop (and parks
  // on empty stdin), so rendering and keystrokes keep flowing.
  vm.run("sh -i", { maxSteps: 5_000_000_000 }).then((r) => {
    vm.termEcho(`\r\n[shell exited: ${r.exitCode}]\r\n`);
    chrome.setSession(`exited ${r.exitCode}`);
    chrome.setStatus("done");
  });
}

main();
