// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run terminal; dual-licensed - see LICENSE.md.

// Keyboard → terminal bytes, as pure functions (no DOM) so they're unit-testable
// (test/keys.test.mjs). main.ts feeds them the relevant KeyboardEvent fields.
//
// Encodings follow xterm (the de-facto standard the guest's terminfo expects):
// CSI cursor/editing keys, SS3 F1–F4, `CSI n ~` F5–F12, and the xterm modifier
// parameter (1 + Shift·1 + Alt·2 + Ctrl·4) on modified named keys. The host
// grid (src/term.rs) doesn't implement DECCKM, so cursor keys are always CSI.

/** The subset of KeyboardEvent the encoder reads. */
export interface KeyLike {
  key: string;
  /** Physical key (e.g. "KeyB", "Digit1") — distinguishes Alt-as-Meta from Option chars. */
  code?: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  /** e.getModifierState("AltGraph") — Windows/Linux AltGr layouts. */
  altGraph?: boolean;
}

/** UI actions bound to keyboard shortcuts (never forwarded to the guest). */
export type UiAction =
  | "palette"
  | "sidebar"
  | "assistant"
  | "copy"
  | "paste"
  | "font-inc"
  | "font-dec"
  | "font-reset";

/** True on Apple platforms, where UI shortcuts live on ⌘ instead of Ctrl+Shift. */
export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const p = nav.userAgentData?.platform || nav.platform || nav.userAgent || "";
  return /mac|iphone|ipad|ipod/i.test(p);
}

/** Map a physical key code to the unshifted base character, if it's one we know. */
function baseCharOf(code: string | undefined): string | null {
  if (!code) return null;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  const punct: Record<string, string> = {
    Minus: "-",
    Equal: "=",
    BracketLeft: "[",
    BracketRight: "]",
    Backslash: "\\",
    Semicolon: ";",
    Quote: "'",
    Backquote: "`",
    Comma: ",",
    Period: ".",
    Slash: "/",
    Space: " ",
  };
  return punct[code] ?? null;
}

/**
 * Terminal UI shortcut for a keystroke, or null. ⌘+key everywhere (Meta never
 * reaches the guest anyway — on Windows/Linux it's the Win/Super key). Off-Mac
 * also Ctrl+Shift+key, since plain Ctrl+letter belongs to the guest (^C, ^K, ^B,
 * …); on a Mac, Ctrl+Shift chords are left to the guest.
 */
export function uiShortcut(e: KeyLike, isMac: boolean): UiAction | null {
  let k: string;
  if (e.metaKey) {
    if (e.ctrlKey || e.altKey) return null;
    k = e.key.toLowerCase();
  } else if (!isMac && e.ctrlKey && e.shiftKey && !e.altKey) {
    // Shift changes e.key ("C", "+", "_", ")"), so prefer the physical code.
    k = baseCharOf(e.code) ?? e.key.toLowerCase();
  } else {
    return null;
  }
  switch (k) {
    case "k":
      return "palette";
    case "b":
      return "sidebar";
    case "j":
      return "assistant";
    case "c":
      return "copy";
    case "v":
      return "paste";
    case "=":
    case "+":
      return "font-inc";
    case "-":
    case "_":
      return "font-dec";
    case "0":
    case ")":
      return "font-reset";
    default:
      return null;
  }
}

/** xterm modifier parameter: 1 + Shift(1) + Alt(2) + Ctrl(4). 1 = unmodified. */
function modParam(e: KeyLike): number {
  return 1 + (e.shiftKey ? 1 : 0) + (e.altKey ? 2 : 0) + (e.ctrlKey ? 4 : 0);
}

// Named keys: [unmodified, CSI final-or-tilde form for the modified variant].
const CSI_LETTER: Record<string, string> = {
  ArrowUp: "A",
  ArrowDown: "B",
  ArrowRight: "C",
  ArrowLeft: "D",
  Home: "H",
  End: "F",
};
const CSI_TILDE: Record<string, number> = {
  Insert: 2,
  Delete: 3,
  PageUp: 5,
  PageDown: 6,
  F5: 15,
  F6: 17,
  F7: 18,
  F8: 19,
  F9: 20,
  F10: 21,
  F11: 23,
  F12: 24,
};
const SS3_F: Record<string, string> = { F1: "P", F2: "Q", F3: "R", F4: "S" };

/** Ctrl+<printable> → C0 control byte (the classic VT mapping), or null. */
function ctrlChar(ch: string): string | null {
  const c = ch.toLowerCase();
  if (c.length === 1 && c >= "a" && c <= "z") return String.fromCharCode(c.charCodeAt(0) - 96);
  switch (c) {
    case " ":
    case "@":
    case "2":
      return "\x00";
    case "[":
    case "3":
      return "\x1b";
    case "\\":
    case "4":
      return "\x1c";
    case "]":
    case "5":
      return "\x1d";
    case "^":
    case "6":
      return "\x1e";
    case "_":
    case "-":
    case "7":
      return "\x1f";
    case "?":
    case "8":
      return "\x7f";
    default:
      return null;
  }
}

/** True if `key` is exactly one printable character (one code point, not C0/DEL). */
function isPrintable(key: string): boolean {
  const cps = [...key];
  if (cps.length !== 1) return false;
  const cp = cps[0].codePointAt(0)!;
  return cp >= 0x20 && cp !== 0x7f;
}

/**
 * Encode a keystroke as the bytes a terminal sends to the guest, or null if the
 * key produces nothing (bare modifiers, dead keys, ⌘ combos, unknown keys).
 * UI shortcuts must be filtered out by the caller first (see {@link uiShortcut}).
 */
export function keyToBytes(e: KeyLike): string | null {
  if (e.metaKey) return null; // ⌘/Win combos belong to the OS/browser
  const { key } = e;
  const mod = modParam(e);
  const esc = e.altKey ? "\x1b" : ""; // Alt-as-Meta prefix for simple keys

  // --- named keys ---
  switch (key) {
    case "Enter":
      return esc + "\r";
    case "Backspace":
      return esc + (e.ctrlKey ? "\x08" : "\x7f");
    case "Tab":
      return e.shiftKey ? "\x1b[Z" : esc + "\t";
    case "Escape":
      return esc + "\x1b";
  }
  if (key in CSI_LETTER) {
    const f = CSI_LETTER[key];
    return mod > 1 ? `\x1b[1;${mod}${f}` : `\x1b[${f}`;
  }
  if (key in CSI_TILDE) {
    const n = CSI_TILDE[key];
    return mod > 1 ? `\x1b[${n};${mod}~` : `\x1b[${n}~`;
  }
  if (key in SS3_F) {
    const f = SS3_F[key];
    return mod > 1 ? `\x1b[1;${mod}${f}` : `\x1bO${f}`;
  }

  // --- printable characters ---
  if (!isPrintable(key)) return null; // "Shift", "Dead", "Unidentified", "Process", …

  // AltGr (Windows/Linux report it as Ctrl+Alt): the layout already produced the
  // character the user wants (@, €, {, …) — forward it verbatim.
  if (e.altGraph) return key;

  const base = baseCharOf(e.code);
  // Did Alt/Option leave the character unchanged (Linux/Windows Alt+b → "b")?
  // Then it's a Meta chord. On macOS, Option *produces* a different character
  // (Option+b → "∫") — that char is what the user typed, so send it as-is.
  const altUnchanged = e.altKey && (base === null ? /^[\x20-\x7e]$/.test(key) : key.toLowerCase() === base);

  if (e.ctrlKey && e.altKey) {
    // Ctrl+Alt+<char> producing a non-ASCII/different char is AltGr; otherwise
    // it's Meta+Ctrl (ESC + control byte).
    if (!altUnchanged) return key;
    const c = ctrlChar(base ?? key);
    return c === null ? null : "\x1b" + c;
  }
  if (e.ctrlKey) {
    // Prefer the physical key so Ctrl+Shift+2 etc. still map like a VT does.
    return ctrlChar(key) ?? (base ? ctrlChar(base) : null);
  }
  if (e.altKey) return altUnchanged ? "\x1b" + key : key;
  return key;
}

/** Normalise pasted text for a tty: CRLF / LF → CR (what Enter sends). */
export function normalizePaste(text: string): string {
  return text.replace(/\r\n?|\n/g, "\r");
}
