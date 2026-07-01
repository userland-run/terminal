// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run terminal; dual-licensed - see LICENSE.md.

// The terminal's DOM scaffold, as a string, so {@link createTerminal} can build
// its own UI inside any host element (the SDK-embedded path) instead of relying
// on a prebuilt index.html. The standalone app still ships the same markup in
// index.html; this keeps the two in sync from one source.
//
// Everything lives under #app (the single CSS scope — ui.css variables and the
// box-sizing reset are scoped to #app so nothing leaks onto an embedding page).
// The ⌘K palette overlay, which is position:fixed, sits inside #app too so it
// inherits the scoped custom properties.

export const SCAFFOLD_HTML = `
<div id="app">
  <header id="topbar">
    <button id="sidebar-toggle" class="icon-btn" title="Toggle sidebar (⌘B)" aria-label="Toggle sidebar">
      <i data-lucide="panel-left"></i>
    </button>
    <div class="brand">userland<span class="dot">.run</span></div>
    <div class="spacer"></div>
    <div class="badge">NanoVM</div>
    <div class="actions">
      <button class="icon-btn" id="act-clear" title="Clear screen" aria-label="Clear screen">
        <i data-lucide="trash-2"></i>
      </button>
      <button class="icon-btn" id="act-restart" title="Restart VM" aria-label="Restart VM">
        <i data-lucide="rotate-cw"></i>
      </button>
      <button class="icon-btn" id="act-settings" title="Settings" aria-label="Settings">
        <i data-lucide="ellipsis"></i>
      </button>
    </div>
  </header>

  <aside id="sidebar">
    <nav class="activity-bar" aria-label="Views">
      <button class="activity-btn" data-view="files" title="Files" aria-label="Files">
        <i data-lucide="folder"></i>
      </button>
      <button class="activity-btn" data-view="catalog" title="Catalog" aria-label="Catalog">
        <i data-lucide="layout-grid"></i>
      </button>
      <button class="activity-btn" data-view="sessions" title="Sessions" aria-label="Sessions">
        <i data-lucide="square-terminal"></i>
      </button>
      <button class="activity-btn" data-view="assistant" title="Assistant" aria-label="Assistant">
        <i data-lucide="sparkles"></i>
      </button>
    </nav>
    <div class="sidebar-views">
      <section class="panel" id="panel-files" data-view="files">
        <div class="panel-head">
          <span class="panel-label">Files</span>
          <span class="panel-hint" id="cwd">/</span>
        </div>
        <div class="panel-body">
          <div id="files" class="muted-note">Live file tree — coming in a later phase.</div>
        </div>
      </section>
      <section class="panel" id="panel-catalog" data-view="catalog">
        <div class="panel-head">
          <span class="panel-label">Catalog</span>
          <span class="panel-hint" id="catalog-hint"></span>
        </div>
        <div class="panel-body">
          <input id="catalog-filter" class="catalog-filter" type="text" placeholder="Search apps…" autocomplete="off" spellcheck="false" />
          <div id="catalog" class="catalog-list"><div class="muted-note">loading catalog…</div></div>
        </div>
      </section>
      <section class="panel" id="panel-sessions" data-view="sessions">
        <div class="panel-head">
          <span class="panel-label">Sessions</span>
        </div>
        <div class="panel-body">
          <ul id="sessions" class="list">
            <li class="session-row active">
              <i data-lucide="square-terminal" class="session-ico"></i>
              <div class="session-meta">
                <div class="session-name">sh</div>
                <div class="session-cwd" id="session-state">booting…</div>
              </div>
            </li>
          </ul>
        </div>
      </section>
      <section class="panel" id="panel-assistant" data-view="assistant">
        <div class="panel-head">
          <span class="panel-label">Assistant</span>
          <span class="panel-hint">on-device AI</span>
        </div>
        <div class="panel-body">
          <div id="assistant-host" class="muted-note">Assistant loads when opened.</div>
        </div>
      </section>
    </div>
  </aside>

  <main id="terminal-area">
    <div class="tabstrip" id="tabstrip" role="tablist">
      <button class="tab active" data-tab="terminal" role="tab" aria-selected="true">
        <i data-lucide="square-terminal"></i>
        <span>Terminal</span>
      </button>
      <button class="tab" data-tab="editor" role="tab" aria-selected="false" hidden>
        <i data-lucide="code"></i>
        <span class="tab-label">Editor</span>
        <span class="tab-close" data-close="editor" title="Close" aria-label="Close editor">×</span>
      </button>
      <button class="tab" data-tab="preview" role="tab" aria-selected="false" hidden>
        <i data-lucide="globe"></i>
        <span>Preview</span>
      </button>
    </div>
    <div class="tab-host">
      <div class="tab-pane active" data-tab="terminal" id="term-pane"><canvas id="screen"></canvas></div>
      <div class="tab-pane" data-tab="editor" id="editor-host"></div>
      <div class="tab-pane" data-tab="preview" id="preview-host"></div>
    </div>
  </main>

  <footer id="footer">
    <span class="stat run" id="stat-cwd">/</span>
    <span class="sep">·</span>
    <span class="stat" id="stat-grid">—</span>
    <span class="sep">·</span>
    <span class="stat"><span class="lbl">up</span> <span id="stat-uptime">00:00:00</span></span>
    <span class="sep">·</span>
    <span class="stat" id="stat-ips" title="guest instructions per second">— <span class="lbl">ips</span></span>
    <span class="sep">·</span>
    <span class="stat status"><span class="dot"></span><span id="stat-status">booting</span></span>
    <span class="sep port-sep" id="stat-port-sep" hidden>·</span>
    <span class="stat port" id="stat-port" title="a server is listening" hidden></span>
    <div class="spacer"></div>
    <span class="stat">RV64GC</span>
    <span class="sep">·</span>
    <span class="stat" id="stat-cursor">ln 1:1</span>
  </footer>

  <!-- Settings popover (anchored under the ⚙ action; hidden until invoked). -->
  <div id="settings-popover" hidden role="menu" aria-label="Settings">
    <div class="settings-label">Session</div>
    <button class="settings-row" id="set-clear">
      <i data-lucide="trash-2"></i>
      Clear scrollback
    </button>
    <button class="settings-row" id="set-restart">
      <i data-lucide="rotate-cw"></i>
      Restart VM
    </button>
    <button class="settings-row" id="set-palette">
      <i data-lucide="command" class="accent"></i>
      Command palette<kbd>⌘K</kbd>
    </button>
    <div class="settings-div"></div>
    <div class="settings-note">RV64GC · github.com/userland-run/nano</div>
  </div>

  <!-- Cmd-K command palette (hidden until invoked). -->
  <div id="palette-overlay" hidden>
    <div id="palette" role="dialog" aria-label="Command palette">
      <input id="palette-input" type="text" placeholder="Type a command…" autocomplete="off" spellcheck="false" />
      <ul id="palette-list"></ul>
    </div>
  </div>
</div>`;

/**
 * Build the terminal scaffold inside `host` (idempotent: a no-op if `#app`
 * already exists, e.g. the standalone index.html shipped it). Returns the
 * `#app` root element.
 */
export function injectScaffold(host: Element | ShadowRoot): HTMLElement {
  const existing = host.querySelector<HTMLElement>("#app");
  if (existing) return existing;
  // <template> parses the markup once; works for both Element and ShadowRoot
  // (ShadowRoot has no insertAdjacentHTML).
  const tpl = document.createElement("template");
  tpl.innerHTML = SCAFFOLD_HTML;
  host.appendChild(tpl.content);
  return host.querySelector<HTMLElement>("#app")!;
}
