// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run terminal; dual-licensed - see LICENSE.md.

// The resizable split-layout controller. #app is a five-track grid — sidebar ·
// left-gutter · terminal · right-gutter · assistant — whose sidebar/assistant
// track widths are CSS custom properties (--sidebar-w / --assistant-w). This
// module is the single authority over those widths and the two collapse classes
// (`sidebar-collapsed` / `assistant-collapsed`): it drives the gutters (Pointer
// Events + setPointerCapture, so a drag survives crossing the WebGPU canvas and
// the preview <iframe>), clamps against #app's own width (embedded instances
// keep a usable terminal), persists everything to localStorage, and re-fits the
// terminal grid via the injected onResize.

const KEY_SIDEBAR_W = "nano:layout:sidebar-w";
const KEY_ASSISTANT_W = "nano:layout:assistant-w";
const KEY_SIDEBAR_COLLAPSED = "nano:layout:sidebar-collapsed";
const KEY_ASSISTANT_OPEN = "nano:layout:assistant-open";

const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 480;
const ASSISTANT_MIN = 320;
const TERM_MIN = 320; // keep at least this much terminal when dragging the assistant

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function lsSet(key: string, val: string): void {
  try {
    localStorage.setItem(key, val);
  } catch {
    /* private mode / disabled storage — layout just won't persist */
  }
}
function readNum(key: string): number | null {
  const v = lsGet(key);
  if (v == null) return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}
function readBool(key: string): boolean | null {
  const v = lsGet(key);
  return v == null ? null : v === "true";
}

export interface SplitLayout {
  toggleSidebar(): void;
  /** Open/close the assistant pane. `force` sets an explicit state. */
  toggleAssistant(force?: boolean): void;
  isAssistantOpen(): boolean;
}

export function installSplitLayout(opts: {
  app: HTMLElement;
  gutterLeft: HTMLElement;
  gutterRight: HTMLElement;
  onResize: () => void;
}): SplitLayout {
  const { app, gutterLeft, gutterRight, onResize } = opts;

  const cssPx = (name: string): number =>
    parseFloat(getComputedStyle(app).getPropertyValue(name)) || 0;

  // The assistant can grow until the terminal would fall below TERM_MIN (and
  // never past 40% of the window), measured against #app, not the viewport.
  const assistantMax = (): number =>
    Math.max(
      ASSISTANT_MIN,
      Math.min(app.clientWidth * 0.4, app.clientWidth - cssPx("--sidebar-w") - TERM_MIN),
    );

  // Re-fit now and again after any width transition settles.
  const settle = (): void => {
    onResize();
    setTimeout(onResize, 200);
  };

  // Apply persisted widths + collapse state over the CSS defaults.
  const sw = readNum(KEY_SIDEBAR_W);
  if (sw != null) app.style.setProperty("--sidebar-w", `${clamp(sw, SIDEBAR_MIN, SIDEBAR_MAX)}px`);
  const aw = readNum(KEY_ASSISTANT_W);
  if (aw != null) app.style.setProperty("--assistant-w", `${Math.max(ASSISTANT_MIN, aw)}px`);
  if (readBool(KEY_SIDEBAR_COLLAPSED) === true) app.classList.add("sidebar-collapsed");
  // The scaffold ships #app.assistant-collapsed; open only if last left open.
  if (readBool(KEY_ASSISTANT_OPEN) === true) app.classList.remove("assistant-collapsed");

  /** Wire one gutter. `sign` maps rightward drag (+dx) to a width delta. */
  function installGutter(
    gutter: HTMLElement,
    varName: string,
    sign: 1 | -1,
    minOf: () => number,
    maxOf: () => number,
    storeKey: string,
  ): void {
    gutter.addEventListener("pointerdown", (e) => {
      gutter.setPointerCapture(e.pointerId);
      gutter.classList.add("dragging");
      app.classList.add("dragging");
      const startX = e.clientX;
      const startW = cssPx(varName);
      const move = (ev: PointerEvent) => {
        const next = clamp(startW + sign * (ev.clientX - startX), minOf(), maxOf());
        app.style.setProperty(varName, `${next}px`);
        onResize();
      };
      const up = (ev: PointerEvent) => {
        try {
          gutter.releasePointerCapture(ev.pointerId);
        } catch {
          /* pointer already released */
        }
        gutter.classList.remove("dragging");
        app.classList.remove("dragging");
        gutter.removeEventListener("pointermove", move);
        gutter.removeEventListener("pointerup", up);
        lsSet(storeKey, String(cssPx(varName)));
        onResize();
      };
      gutter.addEventListener("pointermove", move);
      gutter.addEventListener("pointerup", up);
      e.preventDefault();
    });

    // Keyboard resize when the gutter is focused (Arrow Left/Right).
    gutter.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const step = e.key === "ArrowRight" ? 16 : -16;
      const next = clamp(cssPx(varName) + sign * step, minOf(), maxOf());
      app.style.setProperty(varName, `${next}px`);
      lsSet(storeKey, String(next));
      onResize();
      e.preventDefault();
    });
  }

  installGutter(gutterLeft, "--sidebar-w", 1, () => SIDEBAR_MIN, () => SIDEBAR_MAX, KEY_SIDEBAR_W);
  installGutter(gutterRight, "--assistant-w", -1, () => ASSISTANT_MIN, assistantMax, KEY_ASSISTANT_W);

  const isAssistantOpen = (): boolean => !app.classList.contains("assistant-collapsed");

  return {
    toggleSidebar(): void {
      const collapsed = app.classList.toggle("sidebar-collapsed");
      lsSet(KEY_SIDEBAR_COLLAPSED, String(collapsed));
      settle();
    },
    toggleAssistant(force?: boolean): void {
      const open = force === undefined ? !isAssistantOpen() : force;
      app.classList.toggle("assistant-collapsed", !open);
      lsSet(KEY_ASSISTANT_OPEN, String(open));
      settle();
    },
    isAssistantOpen,
  };
}
