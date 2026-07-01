// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run terminal; dual-licensed - see LICENSE.md.

// The Assistant sidebar panel: a chat UI over the model-agnostic orchestrator.
// Renders availability state (unavailable / downloadable → download button /
// downloading / ready), a model picker (Nano ↔ Cloud when configured), a codegen
// mode, and the running conversation with inline tool actions. All model access
// goes through the injected adapters; the VM work goes through the shared tools.

import type { TerminalHandle } from "../main";
import { StdoutBus } from "./stdout-bus";
import { Assistant, type AssistantUI } from "./orchestrator";
import { runCodegen, CODEGEN_TEMPLATES, type CodegenUI } from "./codegen";
import type { AssistantTool, ModelAdapter, ToolResult } from "./types";
import { icon, I } from "../icons";

export interface AssistantPanelOptions {
  handle: TerminalHandle;
  bus: StdoutBus;
  tools: AssistantTool[];
  nano: ModelAdapter;
  cloud?: ModelAdapter;
}

export class AssistantPanel {
  private readonly handle: TerminalHandle;
  private readonly bus: StdoutBus;
  private readonly assistant: Assistant;
  private readonly nano: ModelAdapter;
  private readonly cloud?: ModelAdapter;
  private activeId: string;

  private root!: HTMLElement;
  private banner!: HTMLElement;
  private log!: HTMLElement;
  private templates!: HTMLElement;
  private text!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private usageEl!: HTMLElement;
  private codegenMode = false;
  private busy = false;

  constructor(opts: AssistantPanelOptions) {
    this.handle = opts.handle;
    this.bus = opts.bus;
    this.nano = opts.nano;
    this.cloud = opts.cloud;
    this.activeId = "nano";
    this.assistant = new Assistant(opts.tools, () => this.activeAdapter());
  }

  private activeAdapter(): ModelAdapter {
    return this.activeId === "cloud" && this.cloud ? this.cloud : this.nano;
  }

  mount(body: HTMLElement): void {
    body.textContent = "";
    body.classList.remove("muted-note");
    this.root = div("asst");

    this.banner = div("asst-banner");
    this.banner.hidden = true;
    this.log = div("asst-log");
    this.templates = div("asst-templates");
    this.templates.hidden = true;

    // Input row.
    const inputRow = div("asst-input");
    this.text = document.createElement("textarea");
    this.text.className = "asst-text";
    this.text.rows = 2;
    this.text.placeholder = "Ask the assistant…";
    this.text.spellcheck = false;
    this.text.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void this.submit();
      }
      e.stopPropagation(); // don't leak keystrokes to the terminal grid
    });
    this.sendBtn = document.createElement("button");
    this.sendBtn.className = "asst-send";
    this.sendBtn.title = "Send";
    this.sendBtn.setAttribute("aria-label", "Send");
    this.sendBtn.append(icon(I.send, 16));
    this.sendBtn.addEventListener("click", () => void this.submit());
    inputRow.append(this.text, this.sendBtn);

    // Footer: model picker + codegen toggle + usage meter.
    const foot = div("asst-foot");
    const models = div("asst-models");
    models.append(this.modelRadio("nano", "Nano"));
    if (this.cloud) models.append(this.modelRadio("cloud", this.cloud.label || "Cloud"));

    const codegen = document.createElement("label");
    codegen.className = "asst-codegen";
    const cg = document.createElement("input");
    cg.type = "checkbox";
    cg.addEventListener("change", () => this.setCodegen(cg.checked));
    codegen.append(cg, document.createTextNode(" Codegen"));

    this.usageEl = document.createElement("span");
    this.usageEl.className = "asst-usage";

    foot.append(models, codegen, this.usageEl);

    // Codegen template chips.
    for (const t of CODEGEN_TEMPLATES) {
      const chip = document.createElement("button");
      chip.className = "asst-chip";
      chip.textContent = t.label;
      chip.addEventListener("click", () => {
        this.text.value = t.spec;
        void this.submit();
      });
      this.templates.append(chip);
    }

    this.root.append(this.banner, this.log, this.templates, inputRow, foot);
    body.append(this.root);

    this.addNote(
      "Hi! I can drive this terminal — try “list the files” or “write a fibonacci script and run it”. Toggle Codegen to build a small app.",
    );
    void this.refreshAvailability();
  }

  // — model picker —

  private modelRadio(id: string, label: string): HTMLLabelElement {
    const wrap = document.createElement("label");
    wrap.className = "asst-model";
    const r = document.createElement("input");
    r.type = "radio";
    r.name = "asst-model";
    r.value = id;
    r.checked = id === this.activeId;
    r.addEventListener("change", () => {
      if (r.checked) {
        this.activeId = id;
        void this.refreshAvailability();
      }
    });
    wrap.append(r, document.createTextNode(" " + label));
    return wrap;
  }

  private setCodegen(on: boolean): void {
    this.codegenMode = on;
    this.templates.hidden = !on;
    this.text.placeholder = on ? "Describe a small app to build…" : "Ask the assistant…";
  }

  // — availability / gating —

  private async refreshAvailability(): Promise<void> {
    const adapter = this.activeAdapter();
    const info = await adapter.availability();
    this.banner.textContent = "";
    if (info.state === "available") {
      this.banner.hidden = true;
      this.setEnabled(true);
      return;
    }
    this.banner.hidden = false;
    if (info.state === "downloadable") {
      this.banner.append(text("The on-device model needs a one-time download. "));
      const btn = document.createElement("button");
      btn.className = "asst-dl";
      btn.textContent = "Download model";
      btn.addEventListener("click", () => void this.download());
      this.banner.append(btn);
      this.setEnabled(false);
    } else if (info.state === "downloading") {
      this.banner.append(text("Downloading the on-device model…"));
      this.setEnabled(false);
    } else {
      // unavailable
      const alt = this.cloud && adapter.id === "nano" ? " Switch to Cloud to use the assistant now." : "";
      this.banner.append(text(`On-device AI unavailable. ${info.detail ?? ""}.${alt}`));
      this.setEnabled(this.cloud ? this.activeId === "cloud" : false);
    }
  }

  private async download(): Promise<void> {
    this.banner.textContent = "";
    const label = text("Downloading… 0%");
    this.banner.append(label);
    try {
      await this.nano.prepare?.((f) => (label.textContent = `Downloading… ${Math.round(f * 100)}%`));
    } catch (e) {
      this.banner.textContent = `Download failed: ${(e as Error).message}`;
      return;
    }
    await this.refreshAvailability();
  }

  private setEnabled(on: boolean): void {
    this.text.disabled = !on;
    this.sendBtn.disabled = !on;
  }

  // — turn handling —

  private async submit(): Promise<void> {
    const value = this.text.value.trim();
    if (!value || this.busy || this.text.disabled) return;
    this.text.value = "";
    this.setBusy(true);
    this.addUser(value);
    try {
      if (this.codegenMode) await this.runCodegenFlow(value);
      else await this.runChat(value);
    } finally {
      this.setBusy(false);
      this.updateUsage();
    }
  }

  private async runChat(text: string): Promise<void> {
    let bubble: HTMLElement | null = null;
    const ensure = () => (bubble ??= this.startAssistant());
    const ui: AssistantUI = {
      onToolStart: (name, args) => this.addTool(name, args),
      onToolResult: (name, res) => this.addToolResult(name, res),
      onReplyDelta: (d) => {
        ensure().textContent += d;
        this.scroll();
      },
      onReplyDone: () => {},
      onError: (m) => this.addError(m),
    };
    await this.assistant.send(text, ui);
  }

  private async runCodegenFlow(spec: string): Promise<void> {
    const ui: CodegenUI = {
      onStatus: (l) => this.addStatus(l),
      onProject: (p) =>
        this.addStatus(`generated ${p.files.length} file(s): ${p.files.map((f) => f.path).join(", ")}`),
      onOutput: (r) => this.addToolResult("build_and_run", r),
    };
    await runCodegen(this.activeAdapter(), this.handle, this.bus, spec, ui);
  }

  private setBusy(on: boolean): void {
    this.busy = on;
    this.root.classList.toggle("busy", on);
    if (!this.text.disabled) this.sendBtn.disabled = on;
  }

  private updateUsage(): void {
    const u = this.activeAdapter().usage?.();
    this.usageEl.textContent = u ? `${u.used}/${u.quota} ctx` : "";
  }

  // — message rendering —

  private addUser(t: string): void {
    const el = div("asst-msg user");
    el.textContent = t;
    this.log.append(el);
    this.scroll();
  }

  private startAssistant(): HTMLElement {
    const el = div("asst-msg bot");
    this.log.append(el);
    this.scroll();
    return el;
  }

  private addNote(t: string): void {
    const el = div("asst-note");
    el.textContent = t;
    this.log.append(el);
  }

  private addStatus(t: string): void {
    const el = div("asst-status");
    el.textContent = t;
    this.log.append(el);
    this.scroll();
  }

  private addError(t: string): void {
    const el = div("asst-error");
    el.textContent = "⚠️ " + t;
    this.log.append(el);
    this.scroll();
  }

  private addTool(name: string, args: Record<string, unknown>): void {
    const el = div("asst-tool");
    const hint = summarizeArgs(name, args);
    el.textContent = `▸ ${name}${hint ? " " + hint : ""}`;
    this.log.append(el);
    this.scroll();
  }

  private addToolResult(name: string, res: ToolResult): void {
    const pre = document.createElement("pre");
    pre.className = "asst-out" + (res.ok ? "" : " fail");
    pre.textContent = res.output;
    this.log.append(pre);
    this.scroll();
  }

  private scroll(): void {
    this.log.scrollTop = this.log.scrollHeight;
  }
}

function div(cls: string): HTMLElement {
  const el = document.createElement("div");
  el.className = cls;
  return el;
}

function text(s: string): Text {
  return document.createTextNode(s);
}

/** A short, human hint for a tool call (path/command), for the action line. */
function summarizeArgs(name: string, args: Record<string, unknown>): string {
  const a = args ?? {};
  if (name === "run_shell" && typeof a.command === "string") return "`" + a.command + "`";
  if (typeof a.path === "string") return a.path;
  if (typeof a.file === "string") return a.file;
  if (typeof a.ref === "string") return a.ref;
  return "";
}
