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

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
}

export class CommandBar {
  private overlay = el("palette-overlay");
  private input = el<HTMLInputElement>("palette-input");
  private list = el<HTMLUListElement>("palette-list");
  private filtered: Command[] = [];
  private sel = 0;

  constructor(private commands: Command[]) {
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
    this.overlay.hidden = false;
    this.input.value = "";
    this.render();
    this.input.focus();
  }

  close() {
    this.overlay.hidden = true;
  }

  toggle() {
    this.open ? this.close() : this.show();
  }

  private onKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
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
  }

  private paintSelection() {
    [...this.list.children].forEach((li, i) =>
      li.classList.toggle("sel", i === this.sel)
    );
    this.list.children[this.sel]?.scrollIntoView({ block: "nearest" });
  }
}
