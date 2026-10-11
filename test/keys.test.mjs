// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run terminal; dual-licensed - see LICENSE.md.

// Unit tests for the keyboard encoder (src/keys.ts): printable / Option / AltGr
// characters, Ctrl control bytes, xterm cursor/editing/function keys, and the
// platform UI shortcuts. Pure functions — no DOM. Run: npm run test:unit

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

let keyToBytes, uiShortcut, normalizePaste;

before(async () => {
  const { build } = await import("esbuild");
  const entry = fileURLToPath(new URL("../src/keys.ts", import.meta.url));
  const outfile = join(mkdtempSync(join(tmpdir(), "keys-test-")), "keys.mjs");
  await build({ entryPoints: [entry], outfile, bundle: true, format: "esm", platform: "neutral" });
  ({ keyToBytes, uiShortcut, normalizePaste } = await import(pathToFileURL(outfile).href));
});

/** Build a KeyLike with all modifiers off by default. */
const k = (key, mods = {}) => ({
  key,
  code: mods.code,
  ctrlKey: !!mods.ctrl,
  altKey: !!mods.alt,
  shiftKey: !!mods.shift,
  metaKey: !!mods.meta,
  altGraph: !!mods.altGraph,
});

test("printable characters pass through", () => {
  assert.equal(keyToBytes(k("a", { code: "KeyA" })), "a");
  assert.equal(keyToBytes(k("A", { code: "KeyA", shift: true })), "A");
  assert.equal(keyToBytes(k(" ", { code: "Space" })), " ");
  assert.equal(keyToBytes(k("é")), "é");
  assert.equal(keyToBytes(k("😀")), "😀"); // astral: one code point, two UTF-16 units
});

test("macOS Option characters are forwarded, not Meta-prefixed", () => {
  assert.equal(keyToBytes(k("∫", { code: "KeyB", alt: true })), "∫");
  assert.equal(keyToBytes(k("@", { code: "KeyL", alt: true })), "@"); // de layout Option+L
  assert.equal(keyToBytes(k("|", { code: "Digit7", alt: true })), "|");
  assert.equal(keyToBytes(k("Dead", { code: "KeyE", alt: true })), null); // dead key
});

test("Alt that leaves the char unchanged acts as Meta (ESC prefix)", () => {
  assert.equal(keyToBytes(k("b", { code: "KeyB", alt: true })), "\x1bb");
  assert.equal(keyToBytes(k("f", { code: "KeyF", alt: true })), "\x1bf");
  assert.equal(keyToBytes(k(".", { code: "Period", alt: true })), "\x1b.");
});

test("AltGr (Ctrl+Alt) characters are forwarded", () => {
  assert.equal(keyToBytes(k("@", { code: "KeyQ", ctrl: true, alt: true })), "@");
  assert.equal(keyToBytes(k("€", { code: "KeyE", ctrl: true, alt: true })), "€");
  assert.equal(keyToBytes(k("{", { code: "Digit7", ctrl: true, alt: true })), "{");
  assert.equal(keyToBytes(k("\\", { code: "Minus", ctrl: true, alt: true, altGraph: true })), "\\");
  // Ctrl+Alt+letter with no AltGr mapping = Meta+Ctrl.
  assert.equal(keyToBytes(k("a", { code: "KeyA", ctrl: true, alt: true })), "\x1b\x01");
});

test("Ctrl letters map to C0 controls", () => {
  assert.equal(keyToBytes(k("a", { code: "KeyA", ctrl: true })), "\x01");
  assert.equal(keyToBytes(k("c", { code: "KeyC", ctrl: true })), "\x03");
  assert.equal(keyToBytes(k("z", { code: "KeyZ", ctrl: true })), "\x1a");
  assert.equal(keyToBytes(k("D", { code: "KeyD", ctrl: true, shift: true })), "\x04");
});

test("Ctrl punctuation: \\ [ ] Space and friends", () => {
  assert.equal(keyToBytes(k("\\", { code: "Backslash", ctrl: true })), "\x1c");
  assert.equal(keyToBytes(k("[", { code: "BracketLeft", ctrl: true })), "\x1b");
  assert.equal(keyToBytes(k("]", { code: "BracketRight", ctrl: true })), "\x1d");
  assert.equal(keyToBytes(k(" ", { code: "Space", ctrl: true })), "\x00");
  assert.equal(keyToBytes(k("@", { code: "Digit2", ctrl: true, shift: true })), "\x00");
  assert.equal(keyToBytes(k("_", { code: "Minus", ctrl: true, shift: true })), "\x1f");
  assert.equal(keyToBytes(k("1", { code: "Digit1", ctrl: true })), null);
});

test("Enter / Backspace / Tab / Escape / Shift+Tab", () => {
  assert.equal(keyToBytes(k("Enter")), "\r");
  assert.equal(keyToBytes(k("Backspace")), "\x7f");
  assert.equal(keyToBytes(k("Backspace", { ctrl: true })), "\x08");
  assert.equal(keyToBytes(k("Backspace", { alt: true })), "\x1b\x7f");
  assert.equal(keyToBytes(k("Tab")), "\t");
  assert.equal(keyToBytes(k("Tab", { shift: true })), "\x1b[Z");
  assert.equal(keyToBytes(k("Escape")), "\x1b");
});

test("arrows (plain + xterm modifier form)", () => {
  assert.equal(keyToBytes(k("ArrowUp")), "\x1b[A");
  assert.equal(keyToBytes(k("ArrowDown")), "\x1b[B");
  assert.equal(keyToBytes(k("ArrowRight")), "\x1b[C");
  assert.equal(keyToBytes(k("ArrowLeft")), "\x1b[D");
  assert.equal(keyToBytes(k("ArrowRight", { ctrl: true })), "\x1b[1;5C");
  assert.equal(keyToBytes(k("ArrowLeft", { alt: true })), "\x1b[1;3D");
  assert.equal(keyToBytes(k("ArrowUp", { shift: true })), "\x1b[1;2A");
});

test("editing keys: Home End Insert Delete PageUp PageDown", () => {
  assert.equal(keyToBytes(k("Home")), "\x1b[H");
  assert.equal(keyToBytes(k("End")), "\x1b[F");
  assert.equal(keyToBytes(k("Insert")), "\x1b[2~");
  assert.equal(keyToBytes(k("Delete")), "\x1b[3~");
  assert.equal(keyToBytes(k("PageUp")), "\x1b[5~");
  assert.equal(keyToBytes(k("PageDown")), "\x1b[6~");
  assert.equal(keyToBytes(k("Delete", { ctrl: true })), "\x1b[3;5~");
});

test("function keys F1–F12", () => {
  const want = {
    F1: "\x1bOP", F2: "\x1bOQ", F3: "\x1bOR", F4: "\x1bOS",
    F5: "\x1b[15~", F6: "\x1b[17~", F7: "\x1b[18~", F8: "\x1b[19~",
    F9: "\x1b[20~", F10: "\x1b[21~", F11: "\x1b[23~", F12: "\x1b[24~",
  };
  for (const [key, bytes] of Object.entries(want)) assert.equal(keyToBytes(k(key)), bytes, key);
  assert.equal(keyToBytes(k("F1", { shift: true })), "\x1b[1;2P");
  assert.equal(keyToBytes(k("F5", { ctrl: true })), "\x1b[15;5~");
});

test("non-producing keys yield null", () => {
  for (const key of ["Shift", "Control", "Alt", "Meta", "CapsLock", "Unidentified", "Process"])
    assert.equal(keyToBytes(k(key)), null, key);
  assert.equal(keyToBytes(k("c", { code: "KeyC", meta: true })), null);
});

test("UI shortcuts: ⌘ on mac, Ctrl+Shift elsewhere", () => {
  assert.equal(uiShortcut(k("k", { meta: true, code: "KeyK" }), true), "palette");
  assert.equal(uiShortcut(k("c", { meta: true, code: "KeyC" }), true), "copy");
  assert.equal(uiShortcut(k("v", { meta: true, code: "KeyV" }), true), "paste");
  assert.equal(uiShortcut(k("k", { ctrl: true, code: "KeyK" }), true), null); // ^K → guest
  assert.equal(uiShortcut(k("C", { ctrl: true, shift: true, code: "KeyC" }), false), "copy");
  assert.equal(uiShortcut(k("V", { ctrl: true, shift: true, code: "KeyV" }), false), "paste");
  assert.equal(uiShortcut(k("K", { ctrl: true, shift: true, code: "KeyK" }), false), "palette");
  assert.equal(uiShortcut(k("+", { ctrl: true, shift: true, code: "Equal" }), false), "font-inc");
  assert.equal(uiShortcut(k("c", { ctrl: true, code: "KeyC" }), false), null); // ^C → guest
  assert.equal(uiShortcut(k("K", { ctrl: true, shift: true, code: "KeyK" }), true), null); // mac: guest
  assert.equal(uiShortcut(k("k", { meta: true, code: "KeyK" }), false), "palette"); // Meta is never guest input
});

test("paste normalisation: CRLF and LF become CR", () => {
  assert.equal(normalizePaste("a\r\nb\nc\rd"), "a\rb\rc\rd");
  assert.equal(normalizePaste("no newline"), "no newline");
});
