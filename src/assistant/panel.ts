// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run terminal; dual-licensed - see LICENSE.md.

// The Assistant chat panel: a ChatGPT/Claude-style chat over the model-agnostic
// orchestrator. It renders availability state, a model dropdown, a permission
// mode pill (Plan / Ask / Accept-Edits / Auto), a rounded composer with a
// visible Send button that becomes Stop while streaming, live tokens/sec, inline
// tool actions and approval cards, and an optional codegen mode. All model
// access goes through the injected adapters; VM work goes through the shared
// tools; footer stats are forwarded via `onStat`.

import type { TerminalHandle } from "../main";
import { StdoutBus } from "./stdout-bus";
import { Assistant, type AssistantUI } from "./orchestrator";
import { runCodegen, CODEGEN_TEMPLATES, type CodegenUI } from "./codegen";
import type {
  ApprovalDecision,
  AssistantMode,
  AssistantTool,
  ModelAdapter,
  ModelAvailabilityState,
  ToolResult,
  TurnMetrics,
} from "./types";
import { icon, I } from "../icons";
import { domRoot } from "../dom";

export interface AssistantPanelOptions {
  handle: TerminalHandle;
  bus: StdoutBus;
  tools: AssistantTool[];
  nano: ModelAdapter;
  cloud?: ModelAdapter;
  local?: ModelAdapter;
  /** Model selected on first open ("nano" | "cloud" | "local"). Default "nano". */
  defaultModel?: string;
  /** Permission mode the chat starts in. Default "ask". */
  defaultMode?: AssistantMode;
  /** Footer readout sink while generating (model + tok/s); null clears it. */
  onStat?: (info: { model: string; toksPerSec: number } | null) => void;
}

const MODES: { id: AssistantMode; label: string }[] = [
  { id: "plan", label: "Plan" },
  { id: "ask", label: "Ask" },
  { id: "acceptEdits", label: "Accept Edits" },
  { id: "auto", label: "Auto" },
];

export class AssistantPanel {
  private readonly handle: TerminalHandle;
  private readonly bus: StdoutBus;
  private readonly assistant: Assistant;
  private readonly nano: ModelAdapter;
  private readonly cloud?: ModelAdapter;
  private readonly local?: ModelAdapter;
  private readonly onStat?: AssistantPanelOptions["onStat"];
  private activeId: string;
  private mode: AssistantMode;

  private root!: HTMLElement;
  private banner!: HTMLElement;
  private log!: HTMLElement;
  private templates!: HTMLElement;
  private composer!: HTMLElement;
  private text!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private modePill!: HTMLButtonElement;
  private modelWrap!: HTMLElement;
  private modelBtn!: HTMLButtonElement;
  private modelDot!: HTMLElement;
  private modelName!: HTMLElement;
  private modelMenu!: HTMLElement;
  private codegenBtn!: HTMLButtonElement;
  private tokEl!: HTMLElement;
  private usageEl!: HTMLElement;

  private readonly availState = new Map<string, ModelAvailabilityState>();
  private codegenMode = false;
  private busy = false;
  private available = false;
  private cancelled = false;
  private abort: AbortController | null = null;
  private pendingApproval?: (d: ApprovalDecision) => void;
  // Per-turn agent-transcript state (reasoning disclosure + the tool card whose
  // result is still pending).
  private reasonEl: HTMLDetailsElement | null = null;
  private reasonBody: HTMLElement | null = null;
  private reasonRaw = ""; // accumulated raw reasoning for the current block
  private activeTool: HTMLElement | null = null;

  constructor(opts: AssistantPanelOptions) {
    this.handle = opts.handle;
    this.bus = opts.bus;
    this.nano = opts.nano;
    this.cloud = opts.cloud;
    this.local = opts.local;
    this.onStat = opts.onStat;
    const wanted = opts.defaultModel ?? "nano";
    this.activeId =
      (wanted === "cloud" && !this.cloud) || (wanted === "local" && !this.local) ? "nano" : wanted;
    this.mode = opts.defaultMode ?? "ask";
    this.assistant = new Assistant(opts.tools, () => this.activeAdapter());
    this.assistant.setMode(this.mode);
  }

  /** The three model backends, in display order (cloud/local only when wired). */
  private models(): { id: string; label: string; adapter: ModelAdapter }[] {
    const out = [{ id: "nano", label: "Gemini Nano", adapter: this.nano }];
    if (this.cloud) out.push({ id: "cloud", label: this.cloud.label || "Cloud", adapter: this.cloud });
    if (this.local) out.push({ id: "local", label: this.local.label || "Local GPU", adapter: this.local });
    return out;
  }

  private activeAdapter(): ModelAdapter {
    if (this.activeId === "cloud" && this.cloud) return this.cloud;
    if (this.activeId === "local" && this.local) return this.local;
    return this.nano;
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

    this.buildComposer();

    // Codegen template chips (shown when codegen mode is on).
    for (const t of CODEGEN_TEMPLATES) {
      const chip = button("asst-chip", t.label);
      chip.addEventListener("click", () => {
        this.text.value = t.spec;
        void this.submit();
      });
      this.templates.append(chip);
    }

    this.root.append(this.banner, this.log, this.templates, this.composer);
    body.append(this.root);

    // Close the model menu on an outside click (mousedown on the scoped root:
    // under shadow DOM document events are retargeted to the host).
    domRoot().addEventListener("mousedown", (e) => {
      if (this.modelMenu.hidden) return;
      if (!this.modelWrap.contains(e.target as Node)) this.toggleModelMenu(false);
    });

    this.setMode(this.mode);
    this.renderModelButton();
    this.addNote(
      "Hi! I can drive this terminal — try “list the files” or “write a fibonacci script and run it”. Pick a mode (Shift+Tab) and toggle Codegen to build a small app.",
    );
    void this.refreshAvailability();
    void this.refreshDots();
  }

  // — composer —

  private buildComposer(): void {
    this.composer = div("asst-composer");

    this.text = document.createElement("textarea");
    this.text.className = "asst-text";
    this.text.rows = 1;
    this.text.placeholder = "Ask the assistant…";
    this.text.spellcheck = false;
    this.text.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void this.submit();
      } else if (e.key === "Tab" && e.shiftKey) {
        e.preventDefault();
        this.cycleMode();
      }
      e.stopPropagation(); // don't leak keystrokes to the terminal grid
    });
    this.text.addEventListener("input", () => this.autoGrow());

    const bar = div("asst-composer-bar");

    // Mode pill.
    this.modePill = button("asst-mode-pill");
    this.modePill.addEventListener("click", () => this.cycleMode());

    // Model dropdown.
    this.modelWrap = div("asst-model");
    this.modelBtn = button("asst-model-btn");
    this.modelBtn.setAttribute("aria-haspopup", "listbox");
    this.modelBtn.setAttribute("aria-expanded", "false");
    this.modelDot = span("asst-dot");
    this.modelName = span("asst-model-name");
    this.modelBtn.append(this.modelDot, this.modelName, icon(I.chevronDown, 13));
    this.modelBtn.addEventListener("click", () => this.toggleModelMenu());
    this.modelBtn.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        this.toggleModelMenu(true);
        (this.modelMenu.firstElementChild as HTMLElement | null)?.focus();
      }
    });
    this.modelMenu = div("asst-model-menu");
    this.modelMenu.setAttribute("role", "listbox");
    this.modelMenu.hidden = true;
    this.modelMenu.addEventListener("keydown", (e) => this.onMenuKey(e));
    this.modelWrap.append(this.modelBtn, this.modelMenu);

    // Codegen toggle.
    this.codegenBtn = button("asst-codegen", "Codegen");
    this.codegenBtn.title = "Build a small app from a description";
    this.codegenBtn.addEventListener("click", () => this.setCodegen(!this.codegenMode));

    const right = div("asst-bar-right");
    this.usageEl = span("asst-usage");
    this.tokEl = span("asst-tok");
    this.tokEl.hidden = true;
    this.sendBtn = button("asst-send");
    this.sendBtn.addEventListener("click", () => (this.busy ? this.cancel() : void this.submit()));
    right.append(this.usageEl, this.tokEl, this.sendBtn);

    bar.append(this.modePill, this.modelWrap, this.codegenBtn, right);
    this.composer.append(this.text, bar);
    this.updateInputState();
  }

  private autoGrow(): void {
    this.text.style.height = "auto";
    this.text.style.height = `${Math.min(this.text.scrollHeight, 160)}px`;
  }

  // — mode pill —

  private cycleMode(): void {
    const idx = MODES.findIndex((m) => m.id === this.mode);
    this.setMode(MODES[(idx + 1) % MODES.length]!.id);
  }

  private setMode(m: AssistantMode): void {
    this.mode = m;
    this.assistant.setMode(m);
    const meta = MODES.find((x) => x.id === m)!;
    this.modePill.textContent = meta.label;
    this.modePill.dataset.mode = m;
    this.modePill.title = `Mode: ${meta.label} — Shift+Tab to cycle`;
  }

  // — model dropdown —

  private toggleModelMenu(open?: boolean): void {
    const willOpen = open === undefined ? this.modelMenu.hidden : open;
    if (willOpen) this.buildModelMenu();
    this.modelMenu.hidden = !willOpen;
    this.modelBtn.setAttribute("aria-expanded", String(willOpen));
  }

  private buildModelMenu(): void {
    this.modelMenu.textContent = "";
    for (const m of this.models()) {
      const opt = button("asst-model-opt");
      opt.setAttribute("role", "option");
      opt.setAttribute("aria-selected", String(m.id === this.activeId));
      const dot = span("asst-dot");
      dot.dataset.state = this.availState.get(m.id) ?? "unknown";
      const name = span("asst-model-optname");
      name.textContent = m.label;
      const detail = span("asst-model-detail");
      detail.textContent = availLabel(this.availState.get(m.id));
      opt.append(dot, name, detail);
      if (m.id === this.activeId) opt.append(icon(I.check, 14));
      opt.addEventListener("click", () => this.selectModel(m.id));
      this.modelMenu.append(opt);
    }
  }

  private onMenuKey(e: KeyboardEvent): void {
    const opts = [...this.modelMenu.querySelectorAll<HTMLElement>(".asst-model-opt")];
    const i = opts.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      opts[Math.min(i + 1, opts.length - 1)]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      opts[Math.max(i - 1, 0)]?.focus();
    } else if (e.key === "Escape") {
      e.preventDefault();
      this.toggleModelMenu(false);
      this.modelBtn.focus();
    }
  }

  private selectModel(id: string): void {
    this.activeId = id;
    this.toggleModelMenu(false);
    this.modelBtn.focus();
    this.renderModelButton();
    void this.refreshAvailability();
  }

  private renderModelButton(): void {
    const m = this.models().find((x) => x.id === this.activeId) ?? this.models()[0]!;
    this.modelDot.dataset.state = this.availState.get(m.id) ?? "unknown";
    this.modelName.textContent = m.label;
  }

  // — availability / gating —

  private async refreshDots(): Promise<void> {
    await Promise.all(
      this.models().map(async (m) => {
        try {
          this.availState.set(m.id, (await m.adapter.availability()).state);
        } catch {
          this.availState.set(m.id, "unavailable");
        }
      }),
    );
    this.renderModelButton();
    if (!this.modelMenu.hidden) this.buildModelMenu();
  }

  private async refreshAvailability(): Promise<void> {
    const adapter = this.activeAdapter();
    const info = await adapter.availability();
    this.availState.set(this.activeId, info.state);
    this.renderModelButton();
    this.banner.textContent = "";
    if (info.state === "available") {
      this.banner.hidden = true;
      this.setEnabled(true);
      return;
    }
    this.banner.hidden = false;
    if (info.state === "downloadable") {
      this.banner.append(
        text(
          adapter.id === "local"
            ? `${info.detail ?? "The local model needs a one-time download"}. `
            : "The on-device model needs a one-time download. ",
        ),
      );
      const btn = button("asst-dl", "Download model");
      btn.addEventListener("click", () => void this.download());
      this.banner.append(btn);
      this.setEnabled(false);
    } else if (info.state === "downloading") {
      this.banner.append(text("Downloading the on-device model…"));
      this.setEnabled(false);
    } else {
      const others = [
        this.cloud && adapter.id !== "cloud" ? "Cloud" : null,
        this.local && adapter.id !== "local" ? this.local.label || "Local GPU" : null,
      ].filter(Boolean);
      const alt = others.length ? ` Switch to ${others.join(" or ")} to use the assistant now.` : "";
      this.banner.append(text(`${adapter.label} unavailable. ${info.detail ?? ""}.${alt}`));
      this.setEnabled(false);
    }
  }

  private async download(): Promise<void> {
    const adapter = this.activeAdapter();
    this.banner.textContent = "";
    const label = text("Downloading… 0%");
    this.banner.append(label);
    try {
      await adapter.prepare?.((f) => (label.textContent = `Downloading… ${Math.round(f * 100)}%`));
    } catch (e) {
      this.banner.textContent = `Download failed: ${(e as Error).message}`;
      return;
    }
    await this.refreshAvailability();
    void this.refreshDots();
  }

  private setEnabled(on: boolean): void {
    this.available = on;
    this.updateInputState();
  }

  private setCodegen(on: boolean): void {
    this.codegenMode = on;
    this.templates.hidden = !on;
    this.codegenBtn.classList.toggle("active", on);
    this.codegenBtn.setAttribute("aria-pressed", String(on));
    this.text.placeholder = on ? "Describe a small app to build…" : "Ask the assistant…";
  }

  // — turn handling —

  private async submit(): Promise<void> {
    const value = this.text.value.trim();
    if (!value || this.busy || !this.available) return;
    this.text.value = "";
    this.autoGrow();
    this.cancelled = false;
    this.abort = new AbortController();
    this.setBusy(true);
    this.addUser(value);
    try {
      if (this.codegenMode) await this.runCodegenFlow(value);
      else await this.runChat(value);
    } finally {
      this.setBusy(false);
      this.updateUsage();
      this.tokEl.hidden = true;
      this.onStat?.(null);
      this.abort = null;
    }
  }

  /** Stop the current turn: freeze the UI + abort abortable backends. The local
   *  worker isn't abortable, so its KV finishes in the background (bounded) and
   *  the button stays "Stopping…" until the turn's promise settles. */
  private cancel(): void {
    if (!this.busy || this.cancelled) return;
    this.cancelled = true;
    this.abort?.abort();
    this.pendingApproval?.("reject");
    this.updateInputState();
  }

  private async runChat(text: string): Promise<void> {
    // Fresh per-turn transcript state.
    this.reasonEl = null;
    this.reasonBody = null;
    this.activeTool = null;
    let bubble: HTMLElement | null = null;
    // A tool call or a new reasoning block ends the current answer bubble, so the
    // next answer text starts its own bubble instead of concatenating.
    const endBubble = () => {
      bubble = null;
    };
    const ui: AssistantUI = {
      onReasoning: (d) => {
        if (this.cancelled) return;
        endBubble();
        this.appendReasoning(d);
      },
      onReasoningDone: () => this.collapseReasoning(),
      onPlan: (steps) => this.addPlan(steps),
      onToolStart: (name, args) => {
        this.collapseReasoning();
        endBubble();
        this.addTool(name, args);
      },
      onToolResult: (name, res) => this.addToolResult(name, res),
      onReplyDelta: (d) => {
        if (this.cancelled) return;
        const clean = d.replace(/<\/?(think|tool_call)>/g, "");
        if (!clean || (!bubble && !clean.trim())) return; // skip leading blanks
        (bubble ??= this.startAssistant()).textContent += clean;
        this.scroll();
      },
      onReplyDone: (t) => {
        // Safety net: if the final answer never streamed into a bubble (e.g. it
        // came from the parsed turn rather than the token stream), render it.
        const clean = (t ?? "").replace(/<\/?(think|tool_call)>/g, "").trim();
        if (clean && !bubble) {
          this.startAssistant().textContent = clean;
          this.scroll();
        }
      },
      onError: (m) => this.addError(m),
      onMetrics: (m) => {
        if (this.cancelled) return;
        this.showTok(m);
      },
      requestApproval: (req) => this.addApproval(req),
    };
    await this.assistant.send(text, ui, this.abort?.signal);
    this.collapseReasoning();
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
    this.composer.classList.toggle("busy", on);
    this.updateInputState();
  }

  /** Reflect availability + busy state on the input + send/stop button. */
  private updateInputState(): void {
    this.text.disabled = this.busy || !this.available;
    this.sendBtn.textContent = "";
    if (this.busy) {
      this.sendBtn.append(icon(I.stop, 13), spanText(this.cancelled ? "Stopping…" : "Stop"));
      this.sendBtn.classList.add("stop");
      this.sendBtn.disabled = this.cancelled;
    } else {
      this.sendBtn.append(icon(I.send, 14), spanText("Send"));
      this.sendBtn.classList.remove("stop");
      this.sendBtn.disabled = !this.available;
    }
  }

  private showTok(m: TurnMetrics): void {
    this.tokEl.textContent = `${m.tokPerSec.toFixed(1)} tok/s`;
    this.tokEl.hidden = false;
    this.onStat?.({ model: this.activeAdapter().label, toksPerSec: m.tokPerSec });
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

  /** A tool call becomes a status card: spinner + a humanized action; the
   *  result later swaps the spinner for ✓/✗ and folds any output away. */
  private addTool(name: string, args: Record<string, unknown>): void {
    const h = humanizeTool(name, args);
    const card = div("asst-tool");
    card.dataset.status = "running";
    card.dataset.verbDone = h.done;
    const row = div("asst-tool-row");
    const label = span("asst-tool-label");
    label.append(text(h.running + " "));
    if (h.target) {
      const code = document.createElement("code");
      code.textContent = h.target;
      label.append(code);
    }
    row.append(span("asst-tool-ic"), label);
    card.append(row);
    this.activeTool = card;
    this.log.append(card);
    this.scroll();
  }

  private addToolResult(name: string, res: ToolResult): void {
    let card = this.activeTool;
    if (!card) {
      // No paired addTool (e.g. the codegen build_and_run path) — synth a card.
      card = div("asst-tool");
      const row = div("asst-tool-row");
      const label = span("asst-tool-label");
      label.textContent = name;
      row.append(span("asst-tool-ic"), label);
      card.append(row);
      this.log.append(card);
    }
    card.dataset.status = res.ok ? "done" : "fail";
    // Swap the running verb → past tense, keeping the <code> target intact.
    const label = card.querySelector<HTMLElement>(".asst-tool-label");
    if (label && card.dataset.verbDone) {
      const codeEl = label.querySelector("code");
      label.textContent = card.dataset.verbDone + (codeEl ? " " : "");
      if (codeEl) label.append(codeEl);
    }
    // Fold the output away; skip trivial success chatter.
    const out = (res.output ?? "").trim();
    const trivial =
      res.ok && (out.length < 3 || /^(ok|file written|opened|created|done|wrote)\b/i.test(out));
    if (out && !trivial) {
      const det = document.createElement("details");
      det.className = "asst-tool-out" + (res.ok ? "" : " fail");
      const sum = document.createElement("summary");
      sum.textContent = res.ok ? "output" : "error";
      const pre = document.createElement("pre");
      pre.textContent = out.length > 4000 ? out.slice(0, 4000) + "\n…" : out;
      det.append(sum, pre);
      card.append(det);
    }
    this.activeTool = null;
    this.scroll();
  }

  /** Render a decomposed plan as a compact checklist above the steps. */
  private addPlan(steps: string[]): void {
    if (!steps.length) return;
    const box = div("asst-plan");
    const head = div("asst-plan-head");
    head.append(span("asst-plan-ic"), text("Plan"));
    box.append(head);
    for (const s of steps) {
      const row = div("asst-plan-step");
      row.append(span("asst-plan-dot"), spanText(s));
      box.append(row);
    }
    this.log.append(box);
    this.scroll();
  }

  /** Stream `<think>` reasoning into a dimmed, collapsible disclosure. Renders
   *  from the accumulated raw text with the (possibly token-split) `<think>`
   *  tags stripped, so no stray tag survives regardless of chunk boundaries. */
  private appendReasoning(d: string): void {
    if (!this.reasonEl) {
      const det = document.createElement("details");
      det.className = "asst-reason";
      det.open = true;
      const sum = document.createElement("summary");
      sum.append(span("asst-reason-ic"), text("Thinking…"));
      const body = div("asst-reason-body");
      det.append(sum, body);
      this.log.append(det);
      this.reasonEl = det;
      this.reasonBody = body;
      this.reasonRaw = "";
    }
    this.reasonRaw += d;
    this.reasonBody!.textContent = this.reasonRaw.replace(/<\/?think>/g, "").replace(/^\s+/, "");
    this.scroll();
  }

  /** Collapse the current reasoning block once its step is done. */
  private collapseReasoning(): void {
    if (!this.reasonEl) return;
    if (!this.reasonBody || !this.reasonBody.textContent!.trim()) {
      this.reasonEl.remove(); // nothing was reasoned — drop the empty block
    } else {
      const sum = this.reasonEl.querySelector("summary");
      if (sum) {
        sum.textContent = "";
        sum.append(span("asst-reason-ic"), text("Thought"));
      }
      this.reasonEl.open = false;
      this.reasonEl.classList.add("done");
    }
    this.reasonEl = null;
    this.reasonBody = null;
  }

  /** Render an inline approval card and resolve with the user's choice. */
  private addApproval(req: {
    tool: string;
    kind: string;
    args: Record<string, unknown>;
    summary: string;
  }): Promise<ApprovalDecision> {
    return new Promise((resolve) => {
      const card = div("asst-approval");
      card.dataset.kind = req.kind;
      const head = div("asst-approval-head");
      head.append(icon(I.shield, 14), spanText(`Run ${req.tool}?`));
      const sum = div("asst-approval-summary");
      sum.textContent = req.summary || `${req.kind} action`;
      const acts = div("asst-approval-acts");
      const approve = button("asst-approve", "Approve");
      const reject = button("asst-reject", "Reject");
      const always = button("asst-always", `Always allow ${req.tool}`);

      let done = false;
      const finish = (d: ApprovalDecision): void => {
        if (done) return;
        done = true;
        this.pendingApproval = undefined;
        acts.remove();
        const tag = div("asst-approval-done");
        tag.textContent =
          d === "reject" ? "✗ Rejected" : d === "always" ? "✓ Always allowed" : "✓ Approved";
        card.append(tag);
        resolve(d);
      };

      approve.addEventListener("click", () => finish("approve"));
      reject.addEventListener("click", () => finish("reject"));
      always.addEventListener("click", () => finish("always"));
      card.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          finish("reject");
        }
      });
      acts.append(approve, reject, always);
      card.append(head, sum, acts);
      this.log.append(card);
      this.scroll();
      this.pendingApproval = finish;
      approve.focus();
    });
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

function span(cls: string): HTMLElement {
  const el = document.createElement("span");
  el.className = cls;
  return el;
}

function spanText(s: string): HTMLElement {
  const el = document.createElement("span");
  el.textContent = s;
  return el;
}

function button(cls: string, label?: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = cls;
  if (label) b.textContent = label;
  return b;
}

function text(s: string): Text {
  return document.createTextNode(s);
}

/** Short label for a model's availability state, shown in the dropdown. */
function availLabel(state: ModelAvailabilityState | undefined): string {
  switch (state) {
    case "available":
      return "ready";
    case "downloadable":
      return "download";
    case "downloading":
      return "downloading…";
    case "unavailable":
      return "unavailable";
    default:
      return "";
  }
}

/** A short, human hint for a tool call (path/command), for the action line. */
/** Map a tool call to a present/past-tense verb + a human target, so a card
 *  reads "Writing `/app/server.js`" → "Wrote `/app/server.js`". */
function humanizeTool(
  name: string,
  args: Record<string, unknown>,
): { running: string; done: string; target: string } {
  const s = (k: string) => (typeof args[k] === "string" ? (args[k] as string) : "");
  const port = typeof args.port === "number" ? args.port : 8080;
  const map: Record<string, [string, string, string]> = {
    write_file: ["Writing", "Wrote", s("path")],
    read_file: ["Reading", "Read", s("path")],
    make_dir: ["Creating", "Created", s("path")],
    run_shell: ["Running", "Ran", s("command")],
    run_node: ["Running", "Ran", s("file")],
    serve: ["Starting server", "Serving", `${s("file") ? s("file") + " " : ""}:${port}`],
    install_app: ["Installing", "Installed", s("ref")],
    list_dir: ["Listing", "Listed", s("path")],
    open_file: ["Opening", "Opened", s("path")],
    delete_path: ["Deleting", "Deleted", s("path")],
    move_path: ["Moving", "Moved", `${s("from")} → ${s("to")}`],
    build_and_run: ["Building", "Built & ran", s("entry")],
  };
  const m = map[name];
  if (m) return { running: m[0], done: m[1], target: m[2] };
  return { running: name, done: name, target: summarizeArgs(name, args) };
}

function summarizeArgs(name: string, args: Record<string, unknown>): string {
  const a = args ?? {};
  if (name === "run_shell" && typeof a.command === "string") return "`" + a.command + "`";
  if (typeof a.path === "string") return a.path;
  if (typeof a.from === "string" && typeof a.to === "string") return `${a.from} → ${a.to}`;
  if (typeof a.file === "string") return a.file;
  if (typeof a.ref === "string") return a.ref;
  return "";
}
