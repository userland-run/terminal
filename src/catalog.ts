// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run terminal; dual-licensed - see LICENSE.md.
//
// Catalog client for the terminal: browse the signed index, install apps into
// the running guest's VFS, and persist what's installed so it survives reloads.
// Reuses the SDK's Catalog (Ed25519-verified manifests, OPFS-cached chunks); the
// InstallTarget is a thin adapter over the container's addFile.

// @ts-ignore — @sdk resolves to the built SDK bundle (vite alias)
import { Catalog } from "@sdk";

const STORE_KEY = "nano:catalog:installed";

function loadRecord(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(STORE_KEY) || "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function saveRecord(refs: string[]): void {
  localStorage.setItem(STORE_KEY, JSON.stringify([...new Set(refs)]));
}

export interface PaletteCommand {
  id: string;
  title: string;
  hint?: string;
  run: () => void;
}

// Mirror of the SDK's InstallProgress (the @sdk alias points at the built bundle,
// whose types aren't on the TS path — so we keep a local shape).
type InstallProgress = {
  phase: "index" | "manifest" | "chunk" | "write" | "done";
  file?: string;
  chunk?: string;
  fetched?: number;
  total?: number;
};

/** Map an installer progress event to a 0–100 bar percentage. The chunk phase
 *  (the bulk of the work) maps fetched/total into a 10–92% band; the framing
 *  phases bookend it so the bar always moves forward. */
function installPct(e: InstallProgress): number {
  switch (e.phase) {
    case "index": return 4;
    case "manifest": return 10;
    case "chunk": return e.total ? 10 + Math.round((e.fetched! / e.total) * 82) : 50;
    case "write": return 94;
    case "done": return 100;
    default: return 0;
  }
}

export class TerminalCatalog {
  private readonly catalog = new Catalog();

  constructor(private readonly vm: any) {}

  /** InstallTarget over the container's VFS — write installed files via addFile.
   *  The manifest's mode (0o755 for binaries) must flow through so installed
   *  apps land executable and the guest shell can actually run them. */
  private target() {
    return {
      writeFile: (path: string, bytes: Uint8Array, mode?: number) =>
        this.vm.addFile(path, bytes, mode),
    };
  }

  /** Wire this catalog into the VM so scripts can `await nano.catalog.install(...)`. */
  bindVm(): void {
    if (typeof this.vm.useCatalog === "function") this.vm.useCatalog(this.catalog);
  }

  private echo(s: string): void {
    this.vm.termEcho(s.replace(/\n/g, "\r\n"));
  }

  /** Install one app ("name" or "name@version") into the guest + record it.
   *  `onProgress` receives the installer's phase/chunk events (so the sidebar
   *  can drive a progress bar). Returns true on success. */
  async install(ref: string, onProgress?: (e: InstallProgress) => void): Promise<boolean> {
    this.echo(`\ninstalling ${ref} from the catalog…\n`);
    try {
      const m = await this.catalog.install(this.target(), ref, onProgress ? { onProgress } : undefined);
      const exact = `${m.name}@${m.version}`;
      saveRecord([...loadRecord(), exact]);
      this.echo(`installed ${exact} → ${m.files.map((f: any) => f.path).join(", ")}\n`);
      return true;
    } catch (e: any) {
      this.echo(`install failed: ${e?.message ?? e}\n`);
      return false;
    }
  }

  /** Install a whole topic bundle into the guest + record each member.
   *  Returns true if the bundle installed (some members may still fail). */
  async installBundle(slug: string): Promise<boolean> {
    this.echo(`\ninstalling the ${slug} bundle from the catalog…\n`);
    try {
      const r = await this.catalog.installBundle(this.target(), slug);
      const refs = r.installed.map((m: any) => `${m.name}@${m.version}`);
      saveRecord([...loadRecord(), ...refs]);
      this.echo(`installed ${r.installed.length} app(s) from ${r.topic}` +
        (r.failed.length ? ` (${r.failed.length} failed)` : "") + `\n`);
      return true;
    } catch (e: any) {
      this.echo(`bundle install failed: ${e?.message ?? e}\n`);
      return false;
    }
  }

  /** Print the signed index, marking what's already installed. */
  async browse(): Promise<void> {
    try {
      const idx = await this.catalog.index();
      const installed = new Set(loadRecord());
      this.echo(`\ncatalog (generation ${idx.generation}):\n`);
      for (const app of Object.keys(idx.apps).sort()) {
        this.echo(`  ${installed.has(app) ? "✓" : " "} ${app}\n`);
      }
    } catch (e: any) {
      this.echo(`catalog unreachable: ${e?.message ?? e}\n`);
    }
  }

  /** Print the locally-persisted installed-apps record. */
  showInstalled(): void {
    const refs = loadRecord();
    this.echo(`\ninstalled apps:\n${refs.length ? refs.map((r) => `  ${r}`).join("\n") : "  (none)"}\n`);
  }

  /**
   * Re-install the persisted apps into a fresh guest on boot. Chunks come from
   * the OPFS cache when present, so this is fast (and works offline) after the
   * first install. Failures are skipped so one bad app can't block boot.
   */
  async rehydrate(): Promise<number> {
    const refs = loadRecord();
    let n = 0;
    for (const ref of refs) {
      try {
        await this.catalog.install(this.target(), ref);
        n++;
      } catch {
        /* skip — e.g. offline with no cached chunks */
      }
    }
    return n;
  }

  /**
   * Command-palette entries: browse, show-installed, and one install action per
   * app in the index (fetched once; static fallback if the CDN is unreachable).
   */
  async commands(): Promise<PaletteCommand[]> {
    const cmds: PaletteCommand[] = [
      { id: "catalog-browse", title: "Catalog: browse apps", hint: "catalog", run: () => void this.browse() },
      { id: "catalog-installed", title: "Catalog: show installed", hint: "catalog", run: () => this.showInstalled() },
    ];
    try {
      const idx = await this.catalog.index();
      for (const slug of Object.keys(idx.bundles || {}).sort()) {
        cmds.push({
          id: `catalog-bundle-${slug}`,
          title: `Catalog: install ${slug} bundle`,
          hint: "bundle",
          run: () => void this.installBundle(slug),
        });
      }
      for (const app of Object.keys(idx.apps).sort()) {
        cmds.push({
          id: `catalog-install-${app}`,
          title: `Catalog: install ${app}`,
          hint: "install",
          run: () => void this.install(app),
        });
      }
    } catch {
      /* index unreachable — keep the static commands only */
    }
    return cmds;
  }

  /**
   * Render the catalog into a sidebar panel: a searchable list of installable
   * apps (and topic bundles). Each row installs into the running guest on click
   * (echoing progress to the terminal) and reflects installed state with a ✓.
   * Falls back to a note when the signed index is unreachable.
   */
  async mountSidebar(refs: { list: HTMLElement; hint: HTMLElement; filter?: HTMLInputElement }): Promise<void> {
    const { list, hint } = refs;
    let idx: any;
    try {
      idx = await this.catalog.index();
    } catch (e: any) {
      list.innerHTML = "";
      const note = document.createElement("div");
      note.className = "muted-note";
      note.textContent = `catalog unreachable: ${e?.message ?? e}`;
      list.appendChild(note);
      return;
    }

    const installed = new Set(loadRecord());
    hint.textContent = `gen ${idx.generation}`;
    list.innerHTML = "";

    const sub = (text: string) => {
      const h = document.createElement("div");
      h.className = "catalog-sub";
      h.textContent = text;
      list.appendChild(h);
    };

    // One installable row. `kind` drives the install action; `ref` is the exact
    // index key (name@version) or bundle slug used to install + to track state.
    const row = (name: string, version: string, ref: string, kind: "app" | "bundle", isInstalled: boolean) => {
      const btn = document.createElement("button");
      btn.className = "catalog-row" + (kind === "bundle" ? " catalog-bundle" : "") + (isInstalled ? " installed" : "");
      btn.dataset.search = `${name} ${version}`.toLowerCase();
      btn.dataset.ref = ref;
      btn.disabled = isInstalled;
      btn.title = isInstalled ? `${name} — installed` : `install ${name}`;

      const nameEl = document.createElement("span");
      nameEl.className = "catalog-name";
      nameEl.textContent = name;
      const verEl = document.createElement("span");
      verEl.className = "catalog-ver";
      verEl.textContent = version;
      const stateEl = document.createElement("span");
      stateEl.className = "catalog-state";
      stateEl.textContent = isInstalled ? "✓" : "+";
      btn.append(nameEl, verEl, stateEl);

      btn.addEventListener("click", async () => {
        if (btn.disabled) return;
        btn.disabled = true;
        let ok: boolean;
        if (kind === "bundle") {
          // Indeterminate (member count isn't known up front) — pulse the row.
          btn.classList.add("installing");
          stateEl.textContent = "·";
          ok = await this.installBundle(ref);
          btn.classList.remove("installing");
        } else {
          // Determinate: fill the row background left→right and show the % in the
          // version slot. Both live inside existing boxes, so nothing overflows.
          const fill = (pct: number) => {
            btn.style.backgroundImage =
              `linear-gradient(to right, rgba(169,132,245,0.22) ${pct}%, transparent ${pct}%)`;
            verEl.textContent = `${pct}%`;
          };
          fill(0);
          ok = await this.install(ref, (e) => fill(installPct(e)));
          btn.style.backgroundImage = "";
          verEl.textContent = version; // restore the version label
        }
        if (ok) {
          btn.classList.add("installed");
          stateEl.textContent = "✓";
          btn.title = `${name} — installed`;
          if (kind === "bundle") this.refreshInstalled(list); // a bundle pulls in several apps
        } else {
          btn.disabled = false;
          stateEl.textContent = "!";
          btn.title = `install ${name} (failed — click to retry)`;
        }
      });
      list.appendChild(btn);
    };

    const bundles = Object.keys(idx.bundles || {}).sort();
    if (bundles.length) {
      sub("Bundles");
      for (const slug of bundles) row(slug, "bundle", slug, "bundle", false);
    }

    const apps = Object.keys(idx.apps).sort();
    sub("Apps");
    for (const appKey of apps) {
      const at = appKey.lastIndexOf("@");
      const name = at > 0 ? appKey.slice(0, at) : appKey;
      const version = at > 0 ? appKey.slice(at + 1) : "";
      row(name, version, appKey, "app", installed.has(appKey));
    }

    if (refs.filter) {
      refs.filter.addEventListener("input", () => {
        const q = refs.filter!.value.trim().toLowerCase();
        for (const el of list.querySelectorAll<HTMLElement>(".catalog-row")) {
          el.style.display = !q || (el.dataset.search || "").includes(q) ? "" : "none";
        }
      });
    }
  }

  /** Re-mark app rows now present in the persisted record (e.g. after a bundle
   *  install pulled several apps in at once). */
  private refreshInstalled(list: HTMLElement): void {
    const installed = new Set(loadRecord());
    for (const el of list.querySelectorAll<HTMLButtonElement>(".catalog-row:not(.catalog-bundle)")) {
      const ref = el.dataset.ref;
      if (ref && installed.has(ref) && !el.classList.contains("installed")) {
        el.classList.add("installed");
        el.disabled = true;
        const st = el.querySelector(".catalog-state");
        if (st) st.textContent = "✓";
      }
    }
  }
}
