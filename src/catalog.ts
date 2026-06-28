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

/** A curated bundle: a hand-picked workflow set, distinct from the auto-derived
 *  topic categories. Members are app NAMES (version-resolved at install time).
 *  Interim source of truth — the catalog will carry these canonically later. */
export interface CuratedBundle {
  slug: string;
  title: string;
  description: string;
  members: string[];
}

const CURATED_BUNDLES: CuratedBundle[] = [
  {
    slug: "node-dev",
    title: "Node dev toolchain",
    description: "Node.js, TypeScript, ESLint, Prettier",
    members: ["node", "typescript", "eslint", "prettier"],
  },
  {
    slug: "git",
    title: "Git workflow",
    description: "gitoxide + delta diffs",
    members: ["gix", "delta"],
  },
];

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
   * Render the catalog into the sidebar panel as three distinct sections:
   *  - Categories: browse facets (topics), derived live from the topic-bundle
   *    manifests; clicking one filters the app list.
   *  - Bundles: hand-curated workflow sets (e.g. a Node dev toolchain) that
   *    install all their members.
   *  - Apps: every index app, filtered by the active category + the search box.
   * The app list + bundles render immediately; category chips light up once the
   * bundle manifests resolve. Falls back to a note if the index is unreachable.
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

    // --- filter state: active category chip + the search box, combined ---
    let activeCat = "";
    const applyFilter = () => {
      const q = (refs.filter?.value || "").trim().toLowerCase();
      for (const el of list.querySelectorAll<HTMLElement>(".catalog-app")) {
        const matchesQ = !q || (el.dataset.search || "").includes(q);
        const matchesCat = !activeCat || (el.dataset.cats || "").split(" ").includes(activeCat);
        el.style.display = matchesQ && matchesCat ? "" : "none";
      }
    };

    // --- Categories (browse facet) — chips populated once manifests resolve ---
    sub("Categories");
    const chips = document.createElement("div");
    chips.className = "catalog-cats";
    list.appendChild(chips);
    const chipEls: HTMLButtonElement[] = [];
    const setActive = (slug: string) => {
      activeCat = slug;
      for (const c of chipEls) c.classList.toggle("active", c.dataset.cat === activeCat);
      applyFilter();
    };
    const addChip = (slug: string, label: string) => {
      const c = document.createElement("button");
      c.className = "catalog-chip";
      c.dataset.cat = slug;
      c.textContent = label;
      c.addEventListener("click", () => setActive(activeCat === slug ? "" : slug));
      chipEls.push(c);
      chips.appendChild(c);
    };
    addChip("", "All");
    setActive("");

    // --- Bundles (curated workflow sets) ---
    const appNames = new Set(Object.keys(idx.apps).map((k: string) => k.split("@")[0]));
    const curated = CURATED_BUNDLES
      .map((cb) => ({ cb, members: cb.members.filter((m) => appNames.has(m)) }))
      .filter((x) => x.members.length > 0);
    if (curated.length) {
      sub("Bundles");
      for (const { cb, members } of curated) list.appendChild(this.curatedRow(cb, members, list));
    }

    // --- Apps (filtered by category + search) ---
    sub("Apps");
    const appRowByRef = new Map<string, HTMLElement>();
    for (const appKey of Object.keys(idx.apps).sort()) {
      const at = appKey.lastIndexOf("@");
      const name = at > 0 ? appKey.slice(0, at) : appKey;
      const version = at > 0 ? appKey.slice(at + 1) : "";
      const row = this.appRow(name, version, appKey, installed.has(appKey), list);
      appRowByRef.set(appKey, row);
      list.appendChild(row);
    }

    if (refs.filter) refs.filter.addEventListener("input", applyFilter);

    // --- derive category membership from the topic-bundle manifests (the index
    //     carries no per-app topics) and light up the chips + app data-cats ---
    for (const slug of Object.keys(idx.bundles || {}).sort()) {
      this.catalog.bundleManifest(slug).then((bm: any) => {
        addChip(slug, bm.topic || slug);
        for (const ref of bm.apps || []) {
          const row = appRowByRef.get(ref);
          if (!row) continue;
          row.dataset.cats = `${row.dataset.cats || ""} ${slug}`.trim();
        }
      }).catch(() => { /* skip a bad/unreachable bundle */ });
    }
  }

  /** An installable app row with determinate install progress (background fill +
   *  % in the version slot). */
  private appRow(name: string, version: string, ref: string, isInstalled: boolean, list: HTMLElement): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.className = "catalog-row catalog-app" + (isInstalled ? " installed" : "");
    btn.dataset.search = `${name} ${version}`.toLowerCase();
    btn.dataset.ref = ref;
    btn.dataset.cats = "";
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
      const fill = (pct: number) => {
        btn.style.backgroundImage =
          `linear-gradient(to right, rgba(169,132,245,0.22) ${pct}%, transparent ${pct}%)`;
        verEl.textContent = `${pct}%`;
      };
      fill(0);
      const ok = await this.install(ref, (e) => fill(installPct(e)));
      btn.style.backgroundImage = "";
      verEl.textContent = version;
      if (ok) {
        btn.classList.add("installed");
        stateEl.textContent = "✓";
        btn.title = `${name} — installed`;
      } else {
        btn.disabled = false;
        stateEl.textContent = "!";
        btn.title = `install ${name} (failed — click to retry)`;
      }
    });
    return btn;
  }

  /** A curated-bundle row (title + description) that installs every member app. */
  private curatedRow(cb: CuratedBundle, members: string[], list: HTMLElement): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.className = "catalog-row catalog-curated";
    btn.dataset.search = `${cb.title} ${cb.slug} ${members.join(" ")}`.toLowerCase();
    btn.title = `install ${cb.title}: ${members.join(", ")}`;

    const meta = document.createElement("div");
    meta.className = "catalog-meta";
    const nameEl = document.createElement("div");
    nameEl.className = "catalog-name";
    nameEl.textContent = cb.title;
    const descEl = document.createElement("div");
    descEl.className = "catalog-desc";
    descEl.textContent = cb.description;
    meta.append(nameEl, descEl);
    const stateEl = document.createElement("span");
    stateEl.className = "catalog-state";
    stateEl.textContent = "+";
    btn.append(meta, stateEl);

    btn.addEventListener("click", async () => {
      if (btn.disabled) return;
      btn.disabled = true;
      btn.classList.add("installing");
      stateEl.textContent = "·";
      this.echo(`\ninstalling the ${cb.title} bundle (${members.join(", ")})…\n`);
      let okCount = 0;
      for (const m of members) if (await this.install(m)) okCount++;
      btn.classList.remove("installing");
      this.refreshInstalled(list);
      if (okCount === members.length) {
        btn.classList.add("installed");
        stateEl.textContent = "✓";
        btn.title = `${cb.title} — installed`;
      } else {
        btn.disabled = false;
        stateEl.textContent = okCount ? "✓" : "!";
        btn.title = `${cb.title} — ${okCount}/${members.length} installed (click to retry)`;
      }
    });
    return btn;
  }

  /** Re-mark app rows now present in the persisted record (e.g. after a curated
   *  bundle pulled several apps in at once). */
  private refreshInstalled(list: HTMLElement): void {
    const installed = new Set(loadRecord());
    for (const el of list.querySelectorAll<HTMLButtonElement>(".catalog-app")) {
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
