// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run terminal; dual-licensed - see LICENSE.md.

// The stylesheet as a string (generated from ui.css). createTerminal injects it
// into its shadow root, so the CSS travels with the bundle identically in both
// the standalone Vite build and the SDK's tsup bundle.
import uiCss from "./ui-css.generated";
import type { TermSnapshot } from "@container/nanovm.mjs";
import { NanoVM } from "@container/nanovm.mjs";
import { existingScaffold, injectScaffold } from "./scaffold";
import { installSplitLayout } from "./split";
import { ensureStyles } from "./styles";
import { DomScope } from "./dom";
import { CanvasRenderer, type TermRenderer } from "./renderer";
import { GpuRenderer } from "./gpu/renderer";
import { Chrome } from "./chrome";
import { CommandBar } from "./commandbar";
import { TerminalCatalog, type InstallProgress } from "./catalog";
import { A11yMirror } from "./a11y";
import { FilesPanel } from "./files";
import { LocalMounts } from "./localfs";
import { Tabs } from "./tabs";
import { renderChromeIcons } from "./icons";
import { installTooltips } from "./tooltip";
import { normalizeConfig, type TerminalConfig } from "./config";
import {
  pixelToCell,
  isEmptySelection,
  extractText,
  ordered,
  toBuffer,
  toViewport,
  type Selection,
} from "./selection";
import { rowText } from "./cells";
import { isMacPlatform, keyToBytes, normalizePaste, uiShortcut, type UiAction } from "./keys";
import { StdoutBus } from "./assistant/stdout-bus";
import { createVmTools } from "./assistant/tools";
import { createBuildTool } from "./assistant/build";
import { createNanoAdapter } from "./assistant/nano";
import { createCloudAdapter } from "./assistant/cloud";
import { createLocalModel } from "./assistant/local";
import { createOpencodeAdapter } from "./assistant/opencode";
import { installLlmBridge } from "./assistant/llm-bridge";
import { AssistantPanel } from "./assistant/panel";
import { registerWebMcpTools } from "./assistant/webmcp";

const MIN_FONT_PX = 9;
const MAX_FONT_PX = 28;
const MAX_COLS = 200; // must match src/term.rs MAX_COLS
const MAX_ROWS = 64; // must match src/term.rs MAX_ROWS
const PAD = 12; // #terminal-area padding (var(--space-3)) — keep in sync with ui.css

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Options for {@link TerminalHandle.installApp}. */
export interface InstallAppOptions {
  /** Receives the installer's phase/chunk events (e.g. to drive a progress bar). */
  onProgress?: (e: InstallProgress) => void;
  /** Suppress the in-terminal install echo — keep the shell pane clean. */
  quiet?: boolean;
}

/** Handle returned by {@link createTerminal} for programmatic control. */
export interface TerminalHandle {
  /** The running NanoVM instance (read/write the VFS, run commands). */
  vm: NanoVM;
  /**
   * Install a catalog app ("name" or "name@version") into the running guest's
   * VFS — the SDK's verified, OPFS-cached, persisted installer (the same path
   * the catalog sidebar uses). `onProgress` receives phase/chunk events; `quiet`
   * suppresses the in-terminal echo (for host-driven provisioning that reports
   * progress elsewhere, keeping the shell clean). Resolves `true` on success;
   * rejects if the catalog feature is disabled. Use it to provision a toolchain
   * (e.g. node + tsc) on boot without leaving the SDK.
   */
  installApp: (ref: string, opts?: InstallAppOptions) => Promise<boolean>;
  /** Open a guest file in the Editor tab (no-op if the editor is disabled). */
  openFile: (path: string) => void;
  /** Reveal the Preview tab on a port (no-op if preview is disabled). */
  showPreview: (port?: number) => void;
  /** Re-list the Files panel tree (after external FS changes). */
  refreshFiles: () => void;
  /**
   * Tear the terminal down: stop the render loop, timers and observers, remove
   * window/document listeners, destroy the VM and renderer, and remove the
   * scaffold this instance injected. Idempotent. <nano-terminal> calls it from
   * disconnectedCallback.
   */
  dispose: () => void;
}

/**
 * Mount a composable terminal into `target` (a selector or element; defaults to
 * `#app`). Every feature is gated by `config.features.*` — see {@link TerminalConfig}.
 * Resolves once the VM has booted and the interactive session has launched,
 * returning a {@link TerminalHandle} for programmatic control.
 */
export async function createTerminal(
  target: string | HTMLElement | ShadowRoot = "#app",
  userConfig: TerminalConfig = {},
): Promise<TerminalHandle> {
  const mount: HTMLElement | ShadowRoot | null =
    typeof target === "string" ? document.querySelector<HTMLElement>(target) : target;
  if (!mount) throw new Error(`createTerminal: target not found: ${String(target)}`);
  return mountTerminal(mount, userConfig);
}

/**
 * Boot one terminal instance into `mount`. `handle` is filled in place (so a
 * restart can re-mount into the same handle object the embedder already holds).
 */
export async function mountTerminal(
  mount: HTMLElement | ShadowRoot,
  userConfig: TerminalConfig,
  handle: TerminalHandle = {} as TerminalHandle,
): Promise<TerminalHandle> {
  const cfg = normalizeConfig(userConfig);

  // Per-instance teardown: everything that outlives the instance's own DOM
  // (window/document listeners, timers, rAF, observers, the VM) registers here.
  const ac = new AbortController();
  const { signal } = ac;
  const cleanups: (() => void)[] = [];
  const dispose = () => {
    if (signal.aborted) return;
    ac.abort();
    for (const fn of cleanups.splice(0).reverse()) {
      try {
        fn();
      } catch (err) {
        console.warn("[console] dispose step failed:", err);
      }
    }
  };
  /** Register teardown; runs at once if the instance was already disposed
   *  (dispose() can land mid-boot, e.g. the element was removed while booting). */
  const onDispose = (fn: () => void) => {
    if (signal.aborted) fn();
    else cleanups.push(fn);
  };
  handle.dispose = dispose;

  // Self-contained mount: scope every DOM lookup to `mount` (a shadow root when
  // embedded as <nano-terminal>, else the global document), inject the scoped
  // stylesheet, and build the scaffold inside it. The scaffold no-ops when a
  // standalone page already shipped #app.
  const scoped: Document | ShadowRoot = mount instanceof ShadowRoot ? mount : document;
  ensureStyles(uiCss, mount instanceof ShadowRoot ? mount : document.head);
  const injected = !existingScaffold(mount);
  const appEl = injectScaffold(mount);
  if (injected) onDispose(() => appEl.remove());
  const dom = new DomScope(scoped, appEl, signal, mount);
  const byId = <T extends HTMLElement = HTMLElement>(id: string) => dom.byId<T>(id);

  renderChromeIcons(dom); // swap the static [data-lucide] placeholders for Lucide SVGs
  installTooltips(dom); // styled tooltips for every titled control
  const chrome = new Chrome(dom);
  onDispose(() => chrome.dispose());
  // The terminal lives in one tab of the main pane; its tab-pane (#term-pane),
  // not #terminal-area, is what sizes the grid (the tab strip takes height too).
  const area = byId("term-pane") as HTMLElement;
  const canvas = byId("screen") as HTMLCanvasElement;
  // The screen-reader mirror lives inside #app, so focusing it keeps keystrokes
  // flowing to the shell (they bubble to #app's keydown handler).
  const a11y = new A11yMirror(appEl);
  onDispose(() => a11y.destroy());
  // Make the terminal focusable (and reachable with Tab) so keyboard input is
  // scoped to it — an embedded <nano-terminal> must not capture the host page's
  // keystrokes when unfocused.
  appEl.tabIndex = 0;
  const isMac = isMacPlatform();
  /** Shortcut label for the UI: ⌘K on mac, Ctrl+Shift+K elsewhere. */
  const kbd = (k: string) => (isMac ? `⌘${k}` : `Ctrl+Shift+${k}`);
  const paletteKbd = dom.qs<HTMLElement>("#set-palette kbd");
  if (paletteKbd) paletteKbd.textContent = kbd("K");

  // Cell metrics depend on the real font; wait for it before measuring.
  try {
    await document.fonts.load(`${cfg.fontPx}px "JetBrains Mono"`);
    await document.fonts.load(`700 ${cfg.fontPx}px "JetBrains Mono"`);
  } catch {
    /* fall back to system monospace */
  }

  // Prefer WebGPU; fall back to the 2D canvas.
  let renderer: TermRenderer;
  try {
    renderer = await GpuRenderer.create(canvas, cfg.fontPx);
  } catch (e) {
    console.warn("[console] WebGPU unavailable — falling back to 2D canvas:", e);
    renderer = new CanvasRenderer(canvas, cfg.fontPx);
  }
  onDispose(() => renderer.destroy?.());
  if (signal.aborted) return handle;

  let fontPx = cfg.fontPx;
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

  const vm = await NanoVM.create({ ramMB: cfg.ramMB, wasm: cfg.wasmUrl });
  onDispose(() => {
    vm.cancelRun(); // unpark the run loop so it can observe the abort
    vm.destroy?.();
  });
  if (signal.aborted) return handle;
  vm.termInit(cols, rows);
  vm.setTty(true); // real guest tty: isatty=true, in-VM echo + line discipline

  // Catalog: re-install anything the user installed in a prior session (chunks
  // come from the OPFS cache, so this is fast/offline). Non-blocking — the shell
  // is usable immediately; installed binaries appear in the VFS as they land.
  let catalog: TerminalCatalog | null = null;
  if (cfg.features.catalog) {
    catalog = new TerminalCatalog(vm);
    catalog.bindVm();        // scripts can `await nano.catalog.install(...)`
    void catalog.rehydrate();
    // Catalog sidebar: a searchable, installable app list. Renders when the signed
    // index loads (non-blocking); each row installs into the running guest.
    void catalog.mountSidebar({
      list: byId("catalog")!,
      hint: byId("catalog-hint")!,
      filter: byId("catalog-filter") as HTMLInputElement,
    });
  } else {
    chrome.setViewEnabled("catalog", false);
  }

  // Files panel: a lazy file tree over the guest VFS with CRUD, plus (where the
  // browser supports the File System Access API) mapping local files/folders in.
  // Row clicks route to the Editor tab once it exists (wired in via openInEditor).
  let openInEditor: (path: string) => void = () => {};
  // Editor tab (CodeMirror) — the module + its bundle load lazily on first open,
  // so they never weigh on boot. Declared here so the Files panel + tab-close
  // handler can reach it.
  let editor: import("./editor").EditorTab | null = null;
  let files: FilesPanel | null = null;
  const localMounts = cfg.features.files ? new LocalMounts(vm) : null;
  if (cfg.features.files) {
    files = new FilesPanel(vm, {
      onOpenFile: (path) => openInEditor(path),
      localMounts: localMounts ?? undefined,
      // Keep the open editor document pointed at the right path.
      onRenamed: (from, to) => editor?.renamed(from, to),
      onDeleted: (path) => void editor?.deleted(path),
      onStatus: (s) => chrome.flashStatus(s, 2400),
    });
    files.mount(byId("files")!);
  } else {
    chrome.setViewEnabled("files", false);
  }

  // Single active sidebar view (VS Code-style activity bar).
  chrome.activateDefaultView();

  chrome.setSession("running");
  chrome.setStatus("live");
  chrome.setCwd("/");

  /** Interval tied to this instance's lifetime. */
  const every = (ms: number, fn: () => void) => {
    const id = window.setInterval(fn, ms);
    onDispose(() => clearInterval(id));
  };

  // Reflect the guest's real working directory in the Files header + footer.
  // cwd() is a cheap SAB read; poll on an interval (not per frame) since it can
  // flicker between the shell and a foreground child.
  let lastCwd = "/";
  let lastInsns = 0;
  let lastSampleAt = Date.now();
  const fmtIps = (ips: number): string => {
    if (ips >= 1e9) return `${(ips / 1e9).toFixed(1)}G`;
    if (ips >= 1e6) return `${Math.round(ips / 1e6)}M`;
    if (ips >= 1e3) return `${Math.round(ips / 1e3)}K`;
    return String(Math.round(ips));
  };
  every(1000, () => {
    // Live working directory (cheap SAB read; can flicker shell↔child).
    try {
      const cwd = vm.cwd();
      if (cwd && cwd !== lastCwd) {
        lastCwd = cwd;
        chrome.setCwd(cwd);
      }
    } catch {
      /* transient */
    }
    // Guest instructions/sec.
    const now = Date.now();
    const insns = vm.instructionCount();
    const dt = (now - lastSampleAt) / 1000;
    if (dt > 0 && lastInsns > 0) chrome.setMips(fmtIps((insns - lastInsns) / dt));
    lastInsns = insns;
    lastSampleAt = now;
    // Open-port / serving indicator.
    if (vm.serving) {
      const p = vm.servingPort;
      chrome.setServing(p != null ? `:${p}` : "serving");
    } else {
      chrome.setServing(null);
    }
  });

  // Live uptime in the footer (the one stat we can source honestly client-side;
  // MIPS/heap/proc need VM introspection the host doesn't yet expose).
  const bootedAt = Date.now();
  const fmtUptime = (ms: number) => {
    const s = Math.floor(ms / 1000);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
  };
  every(1000, () => chrome.setUptime(fmtUptime(Date.now() - bootedAt)));

  // Re-fit the grid to the pane (and the guest, via SIGWINCH). `force` resizes
  // the surface even when cols×rows is unchanged (after a font-size change).
  let refitQueued = false;
  const refit = (force: boolean) => {
    refitQueued = false;
    // The Terminal tab may be hidden (Editor/Preview active) → 0-width pane.
    // computeGrid would clamp to a 1×1 grid and SIGWINCH-corrupt the live shell,
    // so skip while hidden; we refit(true) when the tab is shown again.
    if (area.clientWidth === 0 || area.offsetParent === null) return;
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
    requestAnimationFrame(() => {
      if (!signal.aborted) refit(false);
    });
  };

  const resizeObs = new ResizeObserver(relayoutSoon);
  resizeObs.observe(area);
  onDispose(() => resizeObs.disconnect());

  // Resizable split layout: draggable gutters resize the sidebar + assistant
  // tracks; this owns the collapse classes + width persistence.
  const split = installSplitLayout({
    app: appEl,
    gutterLeft: byId("gutter-left") as HTMLElement,
    gutterRight: byId("gutter-right") as HTMLElement,
    onResize: relayoutSoon,
  });

  onDispose(() => editor?.close(true));
  // Preview tab (server-app iframe). Declared here so the tab handlers reach it.
  let preview: import("./preview").PreviewPanel | null = null;

  // Tab strip over the main pane. Switching back to Terminal returns keyboard
  // focus to the guest (blur any editor/iframe) and refits the now-visible grid.
  const tabs = new Tabs(dom, {
    onSwitch: (t) => {
      if (t === "terminal") {
        (dom.activeEl() as HTMLElement | null)?.blur();
        requestAnimationFrame(() => {
          if (!signal.aborted) refit(true);
        });
      } else if (t === "preview") {
        preview?.ensureLoaded();
      }
    },
    onClose: (t) => {
      // Closing asks first if there are unsaved edits; keep the tab if declined.
      if (t === "editor" && (editor?.close() ?? true)) tabs.hide("editor");
    },
  });

  // Preview tab (server-app iframe over the in-VM HTTP server). The serve bridge
  // (service worker) registers early so it's controlling before the first load.
  if (cfg.features.preview.enabled) {
    const { PreviewPanel } = await import("./preview");
    if (signal.aborted) return handle;
    preview = new PreviewPanel({
      host: byId("preview-host")!,
      vm,
      serviceWorkerUrl: cfg.serviceWorkerUrl,
      ports: cfg.features.preview.ports,
      defaultPort: cfg.features.preview.defaultPort,
      reveal: () => {
        tabs.reveal("preview");
        tabs.show("preview");
      },
    });
    void preview.init();
    tabs.reveal("preview"); // visible so the user can open a preview anytime
  }

  // Wire file-open → Editor tab (gated by config.features.editor).
  if (cfg.features.editor) {
    openInEditor = async (path: string) => {
      if (!editor) {
        const { EditorTab } = await import("./editor");
        editor = new EditorTab({
          host: byId("editor-host")!,
          vm,
          localMounts: localMounts ?? undefined,
          reveal: (label) => {
            tabs.reveal("editor");
            tabs.setEditorLabel(label);
            tabs.show("editor");
          },
          setLabel: (label) => tabs.setEditorLabel(label),
          setStatus: (s) => chrome.flashStatus(s, 2400),
        });
      }
      if (signal.aborted) return;
      if (!editor.open(path)) {
        // Refused (missing / binary / user kept unsaved edits): keep the Files
        // selection on what's actually open.
        files?.setSelected(editor.openPath);
      }
    };
  }

  const setFont = (px: number) => {
    px = clamp(px, MIN_FONT_PX, MAX_FONT_PX);
    if (px === fontPx) return;
    fontPx = px;
    renderer.setFontSize(px);
    refit(true); // cell metrics changed — resize the surface even if cols×rows held
  };

  chrome.onSidebarToggle(() => split.toggleSidebar());

  // Render loop — draw is internally damage-gated, so idle frames are cheap.
  let lastSnap: TermSnapshot | null = null;
  let lastCur = -1;
  let scrollOffset = 0; // scrollback lines scrolled up from the live bottom (0 = live)
  let lastShownOffset = 0;
  let rafId = 0;
  onDispose(() => cancelAnimationFrame(rafId));
  const tick = () => {
    if (signal.aborted) return;
    const snap = vm.termSnapshot(scrollOffset);
    if (snap) {
      lastSnap = snap;
      if (scrollOffset > snap.scrollMax) scrollOffset = snap.scrollMax;
      syncSelection(snap);
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
    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);

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
    if (scrollOffset !== before) {
      e.preventDefault();
      if (selecting && lastMouse) extendSelection(lastMouse); // keep dragging across the scroll
    }
  }, { passive: false });

  // — selection (mouse drag over the grid) —
  // Stored in *buffer* coordinates (see selection.ts) so scrolling mid-drag, or
  // output scrolling the screen, keeps the anchor on its line; projected onto
  // the viewport for the renderer each frame.
  let selection: Selection | null = null;
  let selecting = false;
  let lastMouse: MouseEvent | null = null;
  let shownSel = "";
  const scrollMax = () => lastSnap?.scrollMax ?? 0;
  const bufferCellAt = (e: MouseEvent) =>
    toBuffer(pixelToCell(e, canvas, renderer.cellW, renderer.cellH, cols, rows), scrollOffset, scrollMax());
  function syncSelection(snap: TermSnapshot) {
    const view = selection ? toViewport(selection, snap.scrollOffset, snap.scrollMax, snap.rows, snap.cols) : null;
    const key = view ? `${view.anchor.row},${view.anchor.col},${view.head.row},${view.head.col}` : "";
    if (key === shownSel) return;
    shownSel = key;
    renderer.setSelection?.(view);
  }
  const setSel = (s: Selection | null) => {
    selection = s;
    if (lastSnap) syncSelection(lastSnap);
  };
  const extendSelection = (e: MouseEvent) => {
    if (selection) setSel({ anchor: selection.anchor, head: bufferCellAt(e) });
  };
  canvas.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    appEl.focus(); // clicking the grid focuses the terminal so it receives keys
    selecting = true;
    lastMouse = e;
    const at = bufferCellAt(e);
    setSel({ anchor: at, head: at });
    e.preventDefault();
  });
  window.addEventListener(
    "mousemove",
    (e) => {
      if (!selecting || !selection) return;
      lastMouse = e;
      extendSelection(e);
    },
    { signal },
  );
  window.addEventListener(
    "mouseup",
    () => {
      if (!selecting) return;
      selecting = false;
      lastMouse = null;
      if (selection && isEmptySelection(selection)) setSel(null); // a plain click clears
    },
    { signal },
  );

  /** Text of a buffer-coordinate selection, including parts scrolled out of view. */
  const selectionText = (sel: Selection): string => {
    const { start, end } = ordered(sel);
    const lines: string[] = [];
    let row = start.row;
    while (row <= end.row) {
      const max = scrollMax();
      // Scroll so `row` is the top viewport row (or as close as scrollback allows).
      const snap = vm.termSnapshot(clamp(max - row, 0, max));
      if (!snap) break;
      let vr = row - snap.scrollMax + snap.scrollOffset;
      if (vr < 0) {
        row -= vr; // older than the scrollback still holds — skip what's gone
        vr = 0;
      }
      if (vr >= snap.rows) break;
      for (; vr < snap.rows && row <= end.row; vr++, row++) {
        const c0 = row === start.row ? start.col : 0;
        const c1 = row === end.row ? end.col : snap.cols - 1;
        lines.push(rowText(snap, vr, c0, c1));
      }
    }
    return lines.join("\n");
  };

  // — clipboard —
  const copyText = async (text: string) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      chrome.flashStatus("copied", 1200);
    } catch (err) {
      console.warn("[console] clipboard write failed:", err);
    }
  };
  const copySelection = () => {
    if (selection && !isEmptySelection(selection)) void copyText(selectionText(selection));
  };

  /** Send user input to the guest tty (typing snaps back to the live bottom). */
  const sendInput = (bytes: string) => {
    if (!bytes) return;
    scrollOffset = 0;
    vm.writeStdin(bytes);
  };
  // The VM exposes no bracketed-paste (DECSET 2004) mode, so pastes go in as
  // plain keystrokes with newlines normalised to CR (what Enter sends).
  const pasteText = (text: string) => sendInput(normalizePaste(text));
  const pasteFromClipboard = async () => {
    try {
      pasteText(await navigator.clipboard.readText());
    } catch (err) {
      console.warn("[console] clipboard read failed:", err);
    }
  };

  // Clear the display client-side, keeping the cursor line (the prompt) — never
  // type `clear` into whatever is running in the foreground. Scrollback stays.
  const clearScreen = () => {
    scrollOffset = 0;
    setSel(null);
    const snap = vm.termSnapshot(0);
    if (!snap || snap.cursorRow < 0) return;
    const line = rowText(snap, snap.cursorRow);
    vm.termEcho(`\x1b[2J\x1b[H${line}\x1b[1;${snap.cursorCol + 1}H`);
  };
  const copyAll = () => {
    if (lastSnap)
      void copyText(
        extractText(lastSnap, {
          anchor: { row: 0, col: 0 },
          head: { row: lastSnap.rows - 1, col: lastSnap.cols - 1 },
        })
      );
  };

  // — Cmd-K command palette —
  let palette: CommandBar | null = null;
  if (cfg.features.palette) {
    palette = new CommandBar(
      dom,
      [
        { id: "clear", title: "Clear screen", run: clearScreen },
        { id: "copy-sel", title: "Copy selection", hint: kbd("C"), run: copySelection },
        { id: "copy-all", title: "Copy all visible", run: copyAll },
        { id: "paste", title: "Paste", hint: kbd("V"), run: () => void pasteFromClipboard() },
        { id: "font-inc", title: "Increase font size", hint: kbd("+"), run: () => setFont(fontPx + 1) },
        { id: "font-dec", title: "Decrease font size", hint: kbd("-"), run: () => setFont(fontPx - 1) },
        { id: "font-reset", title: "Reset font size", hint: kbd("0"), run: () => setFont(cfg.fontPx) },
        { id: "sidebar", title: "Toggle sidebar", hint: kbd("B"), run: () => split.toggleSidebar() },
        { id: "assistant-toggle", title: "Toggle assistant", hint: kbd("J"), run: () => split.toggleAssistant() },
      ],
      (e) => uiShortcut(e, isMac) === "palette",
    );

    // Catalog actions (browse / show-installed + one install entry per index app).
    // Fetched async so the palette is usable immediately; entries appear when the
    // signed index loads.
    if (catalog) void catalog.commands().then((cmds) => palette!.addCommands(cmds));
  }

  // Top-bar ⊘/⟳/⚙ + settings-popover rows. Restart re-creates the VM: tear this
  // instance down and re-mount into the same target + handle (no page reload, so
  // an embedding page keeps its state). Only when the host page shipped its own
  // #app scaffold (which we can't rebuild) do we fall back to a full reload.
  const restart = () => {
    if (!injected) {
      location.reload();
      return;
    }
    dispose();
    mountTerminal(mount, userConfig, handle).catch((err) =>
      console.error("[console] restart failed:", err),
    );
  };
  chrome.bindActions({
    onClear: clearScreen,
    onRestart: restart,
    onPalette: () => palette?.show(),
  });

  // — input —
  // Listen on the focusable #app, not window: an embedded terminal must only
  // capture keystrokes while it (or a child) holds focus.
  const isTextField = (el: Element | null) =>
    !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || (el as HTMLElement).isContentEditable);
  const runAction = (a: UiAction) => {
    switch (a) {
      case "palette":
        palette?.toggle();
        break;
      case "sidebar":
        split.toggleSidebar();
        break;
      case "assistant":
        split.toggleAssistant();
        break;
      case "copy":
        copySelection();
        break;
      case "font-inc":
        setFont(fontPx + 1);
        break;
      case "font-dec":
        setFont(fontPx - 1);
        break;
      case "font-reset":
        setFont(cfg.fontPx);
        break;
      case "paste":
        break; // handled by the native paste event (see below)
    }
  };
  appEl.addEventListener("keydown", (e) => {
    // While the palette is open it owns the keyboard (its input handles nav).
    if (palette?.open) return;

    // Don't steal keystrokes while a chrome input (e.g. the catalog search) is
    // focused — let the field handle them instead of forwarding to the guest tty.
    if (isTextField(dom.activeEl())) return;
    if (e.isComposing) return;

    // UI shortcuts: ⌘ on mac, Ctrl+Shift elsewhere (plain Ctrl belongs to the guest).
    const action = uiShortcut(e, isMac);
    if (action === "paste") return; // let the browser fire `paste` (handled below)
    if (action) {
      runAction(action);
      e.preventDefault();
      return;
    }
    if (isMac && e.metaKey) return; // leave other ⌘ combos to the browser

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
    // keys.ts owns the encoding (Option/AltGr chars, Ctrl controls, xterm keys).
    const bytes = keyToBytes({
      key: e.key,
      code: e.code,
      ctrlKey: e.ctrlKey,
      altKey: e.altKey,
      shiftKey: e.shiftKey,
      metaKey: e.metaKey,
      altGraph: e.getModifierState?.("AltGraph") ?? false,
    });
    if (bytes === null) return;
    sendInput(bytes);
    e.preventDefault();
  });

  // Paste (⌘V / Ctrl+Shift+V / the context menu) arrives as a native `paste`
  // event on the focused terminal; editors and inputs inside #app keep theirs.
  appEl.addEventListener("paste", (e) => {
    if (palette?.open || isTextField(dom.activeEl())) return;
    const text = e.clipboardData?.getData("text/plain");
    if (!text) return;
    e.preventDefault();
    pasteText(text);
  });

  // Shared handle (also returned) so the assistant panel and its VM tools can
  // drive the terminal exactly like an external caller would. Filled in place:
  // after a restart, an embedder's reference sees the new VM.
  Object.assign(handle, {
    dispose,
    vm,
    installApp: (ref, opts) =>
      catalog
        ? catalog.install(ref, opts?.onProgress, opts?.quiet)
        : Promise.reject(new Error("installApp: the catalog feature is disabled")),
    openFile: (path: string) => void openInEditor(path),
    showPreview: (port?: number) => preview?.open(port),
    refreshFiles: () => files?.refresh(),
  } satisfies TerminalHandle);

  // AI assistant: a tap on the shell's stdout (so the assistant reads the same
  // bytes the grid renders) + a model-agnostic panel. Gated by config.features.
  const stdoutBus = new StdoutBus();
  if (cfg.features.assistant) {
    const nano = createNanoAdapter();
    const cloud = cfg.assistant.cloud ? createCloudAdapter(cfg.assistant.cloud) : undefined;
    const localModel =
      cfg.assistant.local === false
        ? undefined
        : createLocalModel(cfg.assistant.local ?? {});
    const local = localModel?.adapter;
    // Guest-facing OpenAI facade: processes INSIDE the VM reach the local
    // WebGPU model at http://nanoinfer.internal/v1/... via /dev/__net__.
    // (typeof guard: tolerate an older vendored container without the hook.)
    if (localModel && typeof vm.setLlmBridge === "function") {
      installLlmBridge(vm, localModel);
      onDispose(() => vm.setLlmBridge(null));
    }
    for (const a of [nano, cloud, local]) if (a?.destroy) onDispose(() => a.destroy!());
    // opencode-in-the-VM: a real coding agent as a backend. Needs the catalog
    // (to install the app) and the serve injector (to drive its HTTP API).
    const opencode =
      catalog && vm.virtualServer ? createOpencodeAdapter(handle) : undefined;
    if (opencode?.destroy) onDispose(() => opencode.destroy!());
    // One shared registry drives both the in-page router and WebMCP.
    const tools = [...createVmTools(handle, stdoutBus), createBuildTool(handle, stdoutBus)];
    const host = byId("assistant-host");
    const panel = host
      ? new AssistantPanel({
        dom,
        handle,
        bus: stdoutBus,
        tools,
        nano,
        cloud,
        local,
        opencode,
        defaultModel: cfg.assistant.defaultModel,
        defaultMode: cfg.assistant.defaultMode,
        onStat: (s) => chrome.setAssistantStat(s),
      })
      : undefined;
    if (host) panel?.mount(host);
    // Expose the same tools to Chrome's built-in agent, gated by the panel's
    // mode (no panel → nothing can confirm, so mutating calls are rejected).
    onDispose(
      registerWebMcpTools(tools, (req) =>
        panel
          ? panel.approveExternal(req, () => {
              if (!split.isAssistantOpen()) {
                split.toggleAssistant();
                chrome.setAssistantPressed(true);
              }
            })
          : false,
      ),
    );
    // Dev-only handle for debugging / e2e (stripped from production bundles).
    if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV) {
      (globalThis as Record<string, unknown>).__nanoAssistant = { handle, bus: stdoutBus, tools };
    }
    // Right-dock assistant pane: top-bar toggle + pane close button + ⌘J.
    chrome.onAssistantToggle(() => {
      split.toggleAssistant();
      chrome.setAssistantPressed(split.isAssistantOpen());
    });
    chrome.onAssistantClose(() => {
      split.toggleAssistant(false);
      chrome.setAssistantPressed(false);
    });
    chrome.setAssistantPressed(split.isAssistantOpen());
    palette?.addCommands([
      {
        id: "assistant",
        title: "Open assistant",
        hint: kbd("J"),
        run: () => {
          split.toggleAssistant(true);
          chrome.setAssistantPressed(true);
        },
      },
    ]);
  } else {
    chrome.setAssistantEnabled(false);
    split.toggleAssistant(false);
  }

  // Boot the interactive session and keep it alive. The run loop yields to the
  // event loop (and parks on empty stdin), so rendering and keystrokes keep
  // flowing. Crucially, when the shell exits we relaunch it: an interactive `sh`
  // boots with "job control turned off" (no controlling tty), so Ctrl-C at the
  // prompt delivers a fatal SIGINT that *exits the shell* rather than just
  // interrupting the foreground command — without a relaunch the pane would be
  // dead and every later keystroke would do nothing.
  void (async () => {
    let booted = false;
    while (!signal.aborted) {
      let r;
      try {
        r = await vm.run(cfg.shellCommand, { maxSteps: 5_000_000_000, onStdout: stdoutBus.push });
      } catch {
        return; // VM destroyed (element removed / disposed) — stop relaunching.
      }
      if (signal.aborted) return; // disposed: the VM is gone
      if (booted) vm.termEcho(`\r\n[session ended (exit ${r.exitCode}) — new shell]\r\n`);
      booted = true;
      chrome.setStatus("live");
      chrome.setSession("ready");
      await new Promise((res) => setTimeout(res, 80)); // guard against a hot crash-loop
    }
  })();

  // Standalone (full-page) autofocus so typing works immediately; an embedded
  // terminal waits for a click so it never grabs the host page's focus on load.
  if (!(scoped instanceof ShadowRoot)) appEl.focus();

  return handle;
}
