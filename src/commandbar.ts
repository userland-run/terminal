// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run terminal; dual-licensed - see LICENSE.md.

// Cmd-K command palette. Drives the #palette-* DOM declared in index.html.

export interface Command {
  id: string;
  title: string;
  hint?: string;
  run: () => void;
}

import type { DomScope } from "./dom";

let paletteSeq = 0;

export class CommandBar {
  private readonly overlay: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly list: HTMLUListElement;
  private filtered: Command[] = [];
  private sel = 0;
  /** Focus owner before the palette opened — restored on close. */
  private returnFocus: HTMLElement | null = null;
  /** Unique option-id prefix (several terminals may share a document). */
  private readonly idPrefix = `pl-opt-${++paletteSeq}-`;

  constructor(
    private readonly dom: DomScope,
    private commands: Command[],
    /** Is this keystroke the palette-toggle shortcut (⌘K / Ctrl+Shift+K)? */
    private readonly isToggleKey: (e: KeyboardEvent) => boolean = () => false,
  ) {
    const el = <T extends HTMLElement = HTMLElement>(id: string): T => {
      const node = dom.byId<T>(id);
      if (!node) throw new Error(`missing #${id}`);
      return node;
    };
    this.overlay = el("palette-overlay");
    this.input = el<HTMLInputElement>("palette-input");
    this.list = el<HTMLUListElement>("palette-list");
    this.input.addEventListener("input", () => this.render());
    this.input.addEventListener("keydown", (e) => this.onKey(e));
    // Click outside the panel closes it.
    this.overlay.addEventListener("mousedown", (e) => {
      if (e.target === this.overlay) this.close();
    });
  }

  get open(): boolean {
    return !this.overlay.hidden;
  }

  /** Append commands after construction (e.g. catalog actions fetched async). */
  addCommands(cmds: Command[]) {
    this.commands.push(...cmds);
    if (this.open) this.render();
  }

  show() {
    if (this.open) return;
    const prev = this.dom.activeEl();
    this.returnFocus = prev instanceof HTMLElement && prev !== this.input ? prev : null;
    this.overlay.hidden = false;
    this.input.value = "";
    this.render();
    this.input.focus();
  }

  close() {
    if (!this.open) return;
    this.overlay.hidden = true;
    this.input.removeAttribute("aria-activedescendant");
    // Hand focus back to whoever had it (normally the terminal), so typing
    // after Escape / running a command goes to the shell again.
    const back = this.returnFocus;
    this.returnFocus = null;
    if (back?.isConnected) back.focus();
  }

  toggle() {
    this.open ? this.close() : this.show();
  }

  private onKey(e: KeyboardEvent) {
    if (e.key === "Escape" || this.isToggleKey(e)) {
      this.close();
    } else if (e.key === "ArrowDown") {
      this.sel = Math.min(this.sel + 1, this.filtered.length - 1);
      this.paintSelection();
    } else if (e.key === "ArrowUp") {
      this.sel = Math.max(this.sel - 1, 0);
      this.paintSelection();
    } else if (e.key === "Enter") {
      this.exec(this.filtered[this.sel]);
    } else {
      return; // let the keystroke edit the input
    }
    e.preventDefault();
    e.stopPropagation();
  }

  private exec(cmd: Command | undefined) {
    if (!cmd) return;
    this.close();
    cmd.run();
  }

  private render() {
    const q = this.input.value.trim().toLowerCase();
    this.filtered = q
      ? this.commands.filter((c) => c.title.toLowerCase().includes(q))
      : this.commands.slice();
    this.sel = 0;
    this.list.replaceChildren(
      ...this.filtered.map((c, i) => {
        const li = document.createElement("li");
        li.id = this.idPrefix + i;
        li.setAttribute("role", "option");
        li.setAttribute("aria-selected", String(i === this.sel));
        if (i === this.sel) li.className = "sel";
        const title = document.createElement("span");
        title.textContent = c.title;
        li.appendChild(title);
        if (c.hint) {
          const hint = document.createElement("span");
          hint.className = "pl-hint";
          hint.textContent = c.hint;
          li.appendChild(hint);
        }
        li.addEventListener("mouseenter", () => {
          this.sel = i;
          this.paintSelection();
        });
        li.addEventListener("click", () => this.exec(c));
        return li;
      })
    );
    this.syncActiveDescendant();
  }

  private paintSelection() {
    [...this.list.children].forEach((li, i) => {
      li.classList.toggle("sel", i === this.sel);
      li.setAttribute("aria-selected", String(i === this.sel));
    });
    this.list.children[this.sel]?.scrollIntoView({ block: "nearest" });
    this.syncActiveDescendant();
  }

  /** Point the combobox input at the highlighted option (screen readers). */
  private syncActiveDescendant() {
    const li = this.list.children[this.sel];
    if (li) this.input.setAttribute("aria-activedescendant", li.id);
    else this.input.removeAttribute("aria-activedescendant");
  }
}
