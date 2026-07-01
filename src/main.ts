// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run terminal; dual-licensed - see LICENSE.md.

// The stylesheet as a string (generated from ui.css). createTerminal injects it
// into its shadow root, so the CSS travels with the bundle identically in both
// the standalone Vite build and the SDK's tsup bundle.
import uiCss from "./ui-css.generated";
import type { TermSnapshot } from "@container/nanovm.mjs";
import { NanoVM } from "@container/nanovm.mjs";
import { injectScaffold } from "./scaffold";
import { ensureStyles } from "./styles";
import { setDomRoot, byId, overlayHost, activeEl } from "./dom";
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
  type Selection,
} from "./selection";
import { StdoutBus } from "./assistant/stdout-bus";
import { createVmTools } from "./assistant/tools";
import { createBuildTool } from "./assistant/build";
import { createNanoAdapter } from "./assistant/nano";
import { createCloudAdapter } from "./assistant/cloud";
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
  const cfg = normalizeConfig(userConfig);
  const mount: HTMLElement | ShadowRoot | null =
    typeof target === "string" ? document.querySelector<HTMLElement>(target) : target;
  if (!mount) throw new Error(`createTerminal: target not found: ${String(target)}`);

  // Self-contained mount: scope every DOM lookup to `mount` (a shadow root when
  // embedded as <nano-terminal>, else the global document), inject the scoped
  // stylesheet, and build the scaffold inside it. All three no-op when a
  // standalone shell already provided them, so the standalone app is unchanged.
  const scoped: Document | ShadowRoot = mount instanceof ShadowRoot ? mount : document;
  setDomRoot(scoped);
  ensureStyles(uiCss, mount instanceof ShadowRoot ? mount : document.head);
  injectScaffold(mount);

  renderChromeIcons(); // swap the static [data-lucide] placeholders for Lucide SVGs
  installTooltips(); // styled tooltips for every titled control
  const chrome = new Chrome();
  // The terminal lives in one tab of the main pane; its tab-pane (#term-pane),
  // not #terminal-area, is what sizes the grid (the tab strip takes height too).
  const area = byId("term-pane") as HTMLElement;
  const canvas = byId("screen") as HTMLCanvasElement;
  const a11y = new A11yMirror(overlayHost());
  // Make the terminal focusable so keyboard input is scoped to it — an embedded
  // <nano-terminal> must not capture the host page's keystrokes when unfocused.
  const appEl = byId("app") as HTMLElement;
  appEl.tabIndex = -1;

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
  let files: FilesPanel | null = null;
  const localMounts = cfg.features.files ? new LocalMounts(vm) : null;
  if (cfg.features.files) {
    files = new FilesPanel(vm, {
      onOpenFile: (path) => openInEditor(path),
      localMounts: localMounts ?? undefined,
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
  setInterval(() => {
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
  }, 1000);

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
    requestAnimationFrame(() => refit(false));
  };

  new ResizeObserver(relayoutSoon).observe(area);

  // Editor tab (CodeMirror) — the module + its bundle load lazily on first open,
  // so they never weigh on boot. Declared here so the tab-close handler can reach it.
  let editor: import("./editor").EditorTab | null = null;
  // Preview tab (server-app iframe). Declared here so the tab handlers reach it.
  let preview: import("./preview").PreviewPanel | null = null;

  // Tab strip over the main pane. Switching back to Terminal returns keyboard
  // focus to the guest (blur any editor/iframe) and refits the now-visible grid.
  const tabs = new Tabs({
    onSwitch: (t) => {
      if (t === "terminal") {
        (activeEl() as HTMLElement | null)?.blur();
        requestAnimationFrame(() => refit(true));
      } else if (t === "preview") {
        preview?.ensureLoaded();
      }
    },
    onClose: (t) => {
      if (t === "editor") {
        editor?.close();
        tabs.hide("editor");
      }
    },
  });

  // Preview tab (server-app iframe over the in-VM HTTP server). The serve bridge
  // (service worker) registers early so it's controlling before the first load.
  if (cfg.features.preview.enabled) {
    const { PreviewPanel } = await import("./preview");
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
          setStatus: (s) => {
            chrome.setStatus(s);
            setTimeout(() => chrome.setStatus(tabs.current === "terminal" ? "live" : s), 1400);
          },
        });
      }
      editor.open(path);
    };
  }

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
    appEl.focus(); // clicking the grid focuses the terminal so it receives keys
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
  let palette: CommandBar | null = null;
  if (cfg.features.palette) {
    palette = new CommandBar([
      { id: "clear", title: "Clear screen", hint: "clear", run: () => vm.writeStdin("clear\r") },
      { id: "copy-sel", title: "Copy selection", hint: "⌘C", run: copySelection },
      { id: "copy-all", title: "Copy all visible", run: copyAll },
      { id: "font-inc", title: "Increase font size", hint: "⌘+", run: () => setFont(fontPx + 1) },
      { id: "font-dec", title: "Decrease font size", hint: "⌘-", run: () => setFont(fontPx - 1) },
      { id: "font-reset", title: "Reset font size", hint: "⌘0", run: () => setFont(cfg.fontPx) },
      { id: "sidebar", title: "Toggle sidebar", hint: "⌘B", run: toggleSidebar },
    ]);

    // Catalog actions (browse / show-installed + one install entry per index app).
    // Fetched async so the palette is usable immediately; entries appear when the
    // signed index loads.
    if (catalog) void catalog.commands().then((cmds) => palette!.addCommands(cmds));
  }

  // Top-bar ⊘/⟳/⚙ + settings-popover rows. Restart fully re-creates the VM by
  // reloading — the honest "reboot" until the host exposes a soft reset.
  chrome.bindActions({
    onClear: () => vm.writeStdin("clear\r"),
    onRestart: () => location.reload(),
    onPalette: () => palette?.show(),
  });

  // — input —
  // Listen on the focusable #app, not window: an embedded terminal must only
  // capture keystrokes while it (or a child) holds focus.
  appEl.addEventListener("keydown", (e) => {
    // While the palette is open it owns the keyboard (its input handles nav).
    if (palette?.open) return;

    // Don't steal keystrokes while a chrome input (e.g. the catalog search) is
    // focused — let the field handle them instead of forwarding to the guest tty.
    const ae = activeEl() as HTMLElement | null;
    if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable)) return;

    // UI shortcuts (⌘ on mac). ⌘ keystrokes are never forwarded to the guest.
    if (e.metaKey) {
      const k = e.key.toLowerCase();
      if (k === "k") palette?.toggle();
      else if (k === "b") toggleSidebar();
      else if (k === "c") copySelection();
      else if (k === "=" || k === "+") setFont(fontPx + 1);
      else if (k === "-") setFont(fontPx - 1);
      else if (k === "0") setFont(cfg.fontPx);
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

  // Shared handle (also returned) so the assistant panel and its VM tools can
  // drive the terminal exactly like an external caller would.
  const handle: TerminalHandle = {
    vm,
    installApp: (ref, opts) =>
      catalog
        ? catalog.install(ref, opts?.onProgress, opts?.quiet)
        : Promise.reject(new Error("installApp: the catalog feature is disabled")),
    openFile: (path: string) => void openInEditor(path),
    showPreview: (port?: number) => preview?.open(port),
    refreshFiles: () => files?.refresh(),
  };

  // AI assistant: a tap on the shell's stdout (so the assistant reads the same
  // bytes the grid renders) + a model-agnostic panel. Gated by config.features.
  const stdoutBus = new StdoutBus();
  if (cfg.features.assistant) {
    const nano = createNanoAdapter();
    const cloud = cfg.assistant.cloud ? createCloudAdapter(cfg.assistant.cloud) : undefined;
    // One shared registry drives both the in-page router and WebMCP.
    const tools = [...createVmTools(handle, stdoutBus), createBuildTool(handle, stdoutBus)];
    const host = byId("assistant-host");
    if (host) new AssistantPanel({ handle, bus: stdoutBus, tools, nano, cloud }).mount(host);
    registerWebMcpTools(tools); // expose the same tools to Chrome's built-in agent
    // Dev-only handle for debugging / e2e (stripped from production bundles).
    if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV) {
      (globalThis as Record<string, unknown>).__nanoAssistant = { handle, bus: stdoutBus, tools };
    }
    palette?.addCommands([
      { id: "assistant", title: "Open assistant", hint: "AI", run: () => chrome.showView("assistant") },
    ]);
  } else {
    chrome.setViewEnabled("assistant", false);
  }

  // Boot the interactive session and keep it alive. The run loop yields to the
  // event loop (and parks on empty stdin), so rendering and keystrokes keep
  // flowing. Crucially, when the shell exits we relaunch it: an interactive `sh`
  // boots with "job control turned off" (no controlling tty), so Ctrl-C at the
  // prompt delivers a fatal SIGINT that *exits the shell* rather than just
  // interrupting the foreground command — without a restart the pane would be
  // dead and every later keystroke would do nothing.
  void (async () => {
    let booted = false;
    for (;;) {
      let r;
      try {
        r = await vm.run(cfg.shellCommand, { maxSteps: 5_000_000_000, onStdout: stdoutBus.push });
      } catch {
        return; // VM destroyed (element removed / disposed) — stop relaunching.
      }
      // Always relaunch: an interactive `sh` boots with "job control turned off"
      // (no controlling tty), so Ctrl-C delivers a fatal SIGINT that EXITS the
      // shell rather than just interrupting the foreground command. Without a
      // relaunch the pane would be dead and every later keystroke a no-op.
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
