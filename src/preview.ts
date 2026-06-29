// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run terminal; dual-licensed - see LICENSE.md.

// Server-app preview: an iframe over an in-VM HTTP server. The plumbing already
// exists in the SDK — ServeBridge registers a service worker that routes
// /sw/<port>/* requests to vm.virtualServer.injectConnection(). We just register
// it early and point an iframe at bridge.previewUrl(port).

// @ts-ignore — @sdk resolves to the built SDK bundle (vite alias); tsc can't see it.
import { ServeBridge } from "@sdk";
import type { NanoVM } from "@container/nanovm.mjs";
import { I, icon } from "./icons";

interface Bridge {
  previewUrl(port: number, path?: string): string;
}

export interface PreviewPanelOptions {
  host: HTMLElement;
  vm: NanoVM;
  serviceWorkerUrl: string;
  ports: number[];
  defaultPort: number;
  /** Reveal + activate the Preview tab. */
  reveal: () => void;
}

export class PreviewPanel {
  private bridge: Bridge | null = null;
  private iframe!: HTMLIFrameElement;
  private overlay!: HTMLElement;
  private addressEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private port: number;
  private booted = false;

  constructor(private readonly o: PreviewPanelOptions) {
    this.port = o.defaultPort;
    this.build();
  }

  private build(): void {
    const host = this.o.host;
    host.textContent = "";

    const bar = document.createElement("div");
    bar.className = "preview-bar";

    const reloadBtn = document.createElement("button");
    reloadBtn.className = "preview-btn";
    reloadBtn.title = "Reload";
    reloadBtn.append(icon(I.reload, 16));
    reloadBtn.addEventListener("click", () => this.reload());

    const select = document.createElement("select");
    select.className = "preview-port";
    for (const p of this.o.ports) {
      const opt = document.createElement("option");
      opt.value = String(p);
      opt.textContent = `:${p}`;
      if (p === this.port) opt.selected = true;
      select.append(opt);
    }
    select.addEventListener("change", () => {
      this.port = Number(select.value);
      this.reload();
    });

    this.addressEl = document.createElement("span");
    this.addressEl.className = "preview-address";

    this.statusEl = document.createElement("span");
    this.statusEl.className = "preview-status";

    const openBtn = document.createElement("button");
    openBtn.className = "preview-btn";
    openBtn.title = "Open in a new tab";
    openBtn.append(icon(I.openExternal, 16));
    openBtn.addEventListener("click", () => {
      if (this.bridge) window.open(this.bridge.previewUrl(this.port), "_blank", "noopener");
    });

    bar.append(reloadBtn, select, this.addressEl, this.statusEl, spacer(), openBtn);

    this.iframe = document.createElement("iframe");
    this.iframe.className = "preview-frame";
    // Allow scripts (React etc.) + same-origin (served from our SW scope).
    this.iframe.setAttribute("sandbox", "allow-scripts allow-forms allow-same-origin allow-popups");

    this.overlay = document.createElement("div");
    this.overlay.className = "preview-overlay";
    this.overlay.hidden = true;

    const frameWrap = document.createElement("div");
    frameWrap.className = "preview-framewrap";
    frameWrap.append(this.iframe, this.overlay);

    host.append(bar, frameWrap);
  }

  /**
   * Register the serve bridge early (so the SW is controlling before the first
   * preview) — Risk 3 in the plan. Safe to call once during terminal init.
   */
  async init(): Promise<void> {
    try {
      this.bridge = (await ServeBridge.register({
        swUrl: this.o.serviceWorkerUrl,
        injector: this.o.vm.virtualServer,
      })) as Bridge;
      // Make sure the SW is actually controlling this page before the first load.
      if (navigator.serviceWorker && !navigator.serviceWorker.controller) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 1500);
          navigator.serviceWorker.addEventListener(
            "controllerchange",
            () => {
              clearTimeout(t);
              resolve();
            },
            { once: true },
          );
        });
      }
    } catch (err) {
      console.warn("[preview] serve bridge unavailable:", err);
      this.setStatus("service worker unavailable");
    }
  }

  /** Reveal the Preview tab and (re)load the current port. */
  open(port?: number): void {
    if (port != null) this.port = port;
    this.o.reveal();
    this.reload();
  }

  /** Load the iframe the first time the tab is shown (no-op afterwards). */
  ensureLoaded(): void {
    if (!this.booted) this.reload();
  }

  reload(): void {
    if (!this.bridge) {
      this.setStatus("registering…");
      this.addressEl.textContent = "";
      return;
    }
    const url = this.bridge.previewUrl(this.port);
    this.addressEl.textContent = `localhost${url}`;
    this.setStatus("loading…");
    this.overlay.hidden = true;
    // Cache-bust so a reload re-hits the guest server.
    this.iframe.src = `${url}?_t=${this.booted ? Date.now() : "init"}`;
    this.booted = true;
    this.iframe.onload = () => {
      this.setStatus("");
      // The iframe is same-origin (our SW scope), so we can detect the bridge's
      // "no server" 502 and show a friendly hint instead of raw gateway text.
      try {
        const doc = this.iframe.contentDocument;
        const text = doc?.body?.textContent ?? "";
        const empty = !doc || (doc.body?.childElementCount === 0 && text.trim() === "");
        if (/inject_connection failed|no server|bad gateway/i.test(text) || empty) {
          this.showNoServer();
        }
      } catch {
        /* cross-origin (shouldn't happen) — leave the iframe as-is */
      }
    };
  }

  private showNoServer(): void {
    this.overlay.innerHTML = "";
    const h = document.createElement("div");
    h.className = "preview-overlay-title";
    h.textContent = `Nothing is serving on :${this.port}`;
    const p = document.createElement("div");
    p.className = "preview-overlay-hint";
    p.textContent = "Start a server in the terminal (e.g. node server.js), then reload.";
    this.overlay.append(h, p);
    this.overlay.hidden = false;
    this.setStatus("no server");
  }

  private setStatus(text: string): void {
    this.statusEl.textContent = text;
  }
}

function spacer(): HTMLElement {
  const s = document.createElement("span");
  s.style.flex = "1";
  return s;
}
