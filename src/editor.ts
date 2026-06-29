// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run terminal; dual-licensed - see LICENSE.md.

// CodeMirror 6 file editor. This whole module (and the CodeMirror bundle it
// statically imports) is loaded lazily — `main.ts` does `await import("./editor")`
// only when the first file is opened, so the editor never weighs on boot.

import { EditorView, basicSetup } from "codemirror";
import { keymap } from "@codemirror/view";
import { type Extension } from "@codemirror/state";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { markdown } from "@codemirror/lang-markdown";
import type { NanoVM } from "@container/nanovm.mjs";
import type { LocalMounts } from "./localfs";

const basename = (p: string): string => p.split("/").pop() || p;

/** Pick a CodeMirror language by file extension. */
function languageFor(filename: string): Extension[] {
  const ext = filename.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return [javascript({ jsx: ext === "jsx" })];
    case "ts":
      return [javascript({ typescript: true })];
    case "tsx":
      return [javascript({ typescript: true, jsx: true })];
    case "json":
      return [json()];
    case "html":
    case "htm":
      return [html()];
    case "css":
      return [css()];
    case "md":
    case "markdown":
      return [markdown()];
    default:
      return [];
  }
}

// Theme matched to the terminal: --surface bg, JetBrains Mono, violet caret/
// selection (palette.ts THEME + the in-brand ANSI palette).
const terminalTheme = EditorView.theme(
  {
    "&": { height: "100%", backgroundColor: "#15151A", color: "#EDECF3" },
    ".cm-scroller": {
      fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, monospace',
      fontSize: "12px",
      lineHeight: "1.5",
      overflow: "auto",
    },
    ".cm-content": { caretColor: "#A984F5" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#A984F5" },
    "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
      { backgroundColor: "rgba(169, 132, 245, 0.25)" },
    ".cm-gutters": { backgroundColor: "#15151A", color: "#4a4a52", border: "none" },
    ".cm-activeLine": { backgroundColor: "rgba(255, 255, 255, 0.03)" },
    ".cm-activeLineGutter": { backgroundColor: "rgba(255, 255, 255, 0.04)", color: "#9b9ba4" },
    ".cm-lineNumbers .cm-gutterElement": { padding: "0 6px 0 12px" },
    "&.cm-focused": { outline: "none" },
  },
  { dark: true },
);

const terminalHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.moduleKeyword, t.controlKeyword], color: "#c4b6f2" },
  { tag: [t.string, t.special(t.string)], color: "#74d493" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "#6c6c76", fontStyle: "italic" },
  { tag: [t.number, t.bool, t.null], color: "#e6b45a" },
  { tag: [t.function(t.variableName), t.labelName], color: "#5fd6d1" },
  { tag: [t.propertyName, t.definition(t.propertyName)], color: "#a984f5" },
  { tag: [t.typeName, t.className, t.namespace], color: "#e6b45a" },
  { tag: [t.operator, t.punctuation, t.bracket], color: "#9b9ba4" },
  { tag: [t.tagName, t.angleBracket], color: "#f0616d" },
  { tag: [t.attributeName], color: "#d39a3e" },
  { tag: [t.variableName], color: "#edecf3" },
]);

export interface EditorTabHost {
  host: HTMLElement;
  vm: NanoVM;
  localMounts?: LocalMounts;
  /** Reveal + activate the Editor tab and set its label. */
  reveal: (label: string) => void;
  /** Surface a short status (footer), e.g. "saved → disk". */
  setStatus?: (text: string) => void;
}

/**
 * The Editor tab. Opens a guest file in CodeMirror; ⌘S/Ctrl-S writes it back to
 * the VFS (and, if the file is mapped from disk via the File System Access API,
 * to the local file too).
 */
export class EditorTab {
  private view: EditorView | null = null;
  private currentPath: string | null = null;

  constructor(private readonly o: EditorTabHost) {}

  get openPath(): string | null {
    return this.currentPath;
  }

  open(path: string): void {
    const content = this.o.vm.readFileString(path) ?? "";
    this.currentPath = path;
    this.view?.destroy();
    this.view = new EditorView({
      doc: content,
      parent: this.o.host,
      extensions: [
        basicSetup,
        ...languageFor(path),
        syntaxHighlighting(terminalHighlight),
        terminalTheme,
        keymap.of([
          {
            key: "Mod-s",
            preventDefault: true,
            run: () => {
              void this.save();
              return true;
            },
          },
        ]),
      ],
    });
    this.o.reveal(basename(path));
    this.view.focus();
  }

  private async save(): Promise<void> {
    if (!this.view || !this.currentPath) return;
    const text = this.view.state.doc.toString();
    const path = this.currentPath;
    this.o.vm.addFile(path, text); // sync MemFS write — guest sees it immediately
    if (this.o.localMounts?.isMapped(path)) {
      const ok = await this.o.localMounts.writeBack(path, text);
      this.o.setStatus?.(ok ? "saved → disk" : "saved (disk denied)");
    } else {
      this.o.setStatus?.("saved");
    }
  }

  close(): void {
    this.view?.destroy();
    this.view = null;
    this.currentPath = null;
  }
}
