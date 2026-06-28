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

  /** Install one app ("name" or "name@version") into the guest + record it. */
  async install(ref: string): Promise<void> {
    this.echo(`\ninstalling ${ref} from the catalog…\n`);
    try {
      const m = await this.catalog.install(this.target(), ref);
      const exact = `${m.name}@${m.version}`;
      saveRecord([...loadRecord(), exact]);
      this.echo(`installed ${exact} → ${m.files.map((f: any) => f.path).join(", ")}\n`);
    } catch (e: any) {
      this.echo(`install failed: ${e?.message ?? e}\n`);
    }
  }

  /** Install a whole topic bundle into the guest + record each member. */
  async installBundle(slug: string): Promise<void> {
    this.echo(`\ninstalling the ${slug} bundle from the catalog…\n`);
    try {
      const r = await this.catalog.installBundle(this.target(), slug);
      const refs = r.installed.map((m: any) => `${m.name}@${m.version}`);
      saveRecord([...loadRecord(), ...refs]);
      this.echo(`installed ${r.installed.length} app(s) from ${r.topic}` +
        (r.failed.length ? ` (${r.failed.length} failed)` : "") + `\n`);
    } catch (e: any) {
      this.echo(`bundle install failed: ${e?.message ?? e}\n`);
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
}
