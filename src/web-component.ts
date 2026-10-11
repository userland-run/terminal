// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run terminal; dual-licensed - see LICENSE.md.

// <nano-terminal> — the terminal as a custom element with its own shadow root.
// Shadow DOM fully encapsulates ui.css (it can neither leak onto the host page
// nor be overridden by it), and createTerminal builds the scaffold + injects the
// stylesheet into that shadow root. This is the shape the SDK re-exports so a
// consumer just drops <nano-terminal> into a page.

import { mountTerminal, type TerminalHandle } from "./main";
import type { TerminalConfig, TerminalFeatureConfig } from "./config";

const FEATURE_KEYS = ["catalog", "palette", "files", "editor", "preview", "assistant"] as const;

export class NanoTerminalElement extends HTMLElement {
  private booted = false;
  private handle: Promise<TerminalHandle> | null = null;
  /** The live handle object; its dispose() is wired synchronously at boot start,
   *  so a disconnect mid-boot can still tear the instance down. */
  private live: TerminalHandle | null = null;
  /** Programmatic config; merged over (and overriding) attribute-derived config. */
  config: TerminalConfig = {};

  /** Resolves to the running {@link TerminalHandle} once booted (null before connect). */
  get ready(): Promise<TerminalHandle> | null {
    return this.handle;
  }

  connectedCallback(): void {
    if (this.booted) return; // boot once; a DOM move (disconnect+reconnect) keeps the VM
    this.booted = true;
    const shadow = this.shadowRoot ?? this.attachShadow({ mode: "open" });
    const cfg: TerminalConfig = { ...this.attrConfig(), ...this.config };
    const live = {} as TerminalHandle;
    this.live = live;
    this.handle = mountTerminal(shadow, cfg, live);
  }

  disconnectedCallback(): void {
    // A DOM move fires disconnect then connect synchronously — only tear down if
    // the element is still detached once the current task's microtasks settle.
    queueMicrotask(() => {
      if (this.isConnected || !this.live) return;
      this.dispose();
    });
  }

  /** Tear the terminal down now (VM, render loop, timers, listeners). A later
   *  re-insert boots a fresh instance. */
  dispose(): void {
    this.live?.dispose?.();
    this.live = null;
    this.handle = null;
    this.booted = false;
  }

  /** Build a TerminalConfig from declarative attributes (so it works from plain
   *  HTML / JSX without touching the property). Feature toggles use `no-*`. */
  private attrConfig(): TerminalConfig {
    const c: TerminalConfig = {};
    const str = (a: string) => this.getAttribute(a) || undefined;
    const num = (a: string) => (this.hasAttribute(a) ? Number(this.getAttribute(a)) : undefined);
    if (str("wasm-url")) c.wasmUrl = str("wasm-url");
    if (str("service-worker-url")) c.serviceWorkerUrl = str("service-worker-url");
    if (str("shell-command")) c.shellCommand = str("shell-command");
    if (num("font-px") !== undefined) c.fontPx = num("font-px");
    if (num("ram-mb") !== undefined) c.ramMB = num("ram-mb");
    const features: TerminalFeatureConfig = {};
    for (const f of FEATURE_KEYS) if (this.hasAttribute(`no-${f}`)) features[f] = false;
    if (Object.keys(features).length) c.features = features;
    return c;
  }
}

/** Register the <nano-terminal> custom element (idempotent). */
export function defineNanoTerminal(tag = "nano-terminal"): void {
  if (typeof customElements === "undefined") return;
  if (!customElements.get(tag)) customElements.define(tag, NanoTerminalElement);
}
