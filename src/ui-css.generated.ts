// AUTO-GENERATED from src/ui.css by scripts/gen-ui-css.mjs — do not edit by hand.
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
/* eslint-disable */
const css: string = `/* SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
   Copyright (C) 2026 And The Next GmbH - https://userland.run
   Part of the userland.run terminal; dual-licensed - see LICENSE.md. */

/* Design tokens. Source of truth: style-guide/terminal/Userland Terminal.dc.html
   (the hi-fidelity terminal comp), grounded in the Paged \`.dark\` system. The
   comp uses a four-tone surface ramp — desk → card → sidebar → chrome — rather
   than a single panel grey. Console CSS references these via var(--token). */
/* Scoped to the host + #app (not :root) so the variables can't leak onto, or be
   clobbered by, an embedding page — the terminal lives in a shadow root. */
:host, #app {
  /* surface ramp (comp) */
  --ground: #0e0e10;        /* the desk behind the window            */
  --surface: #15151a;       /* the terminal window / scrollback pane */
  --sidebar-bg: #191920;    /* session + file rail                   */
  --chrome-bg: #1b1b20;     /* top bar + footer                      */
  --border: #2c2c31;        /* window hairline / dividers            */
  --elevated: #232328;      /* popovers, command bar                 */
  --popover-border: #34343b;/* popover edge + scrollbar thumb        */

  /* ink */
  --fg: #edecf3;            /* command text, wordmark                */
  --muted-fg: #9b9ba4;      /* footer text, secondary                */
  --label: #7e7e8a;         /* uppercase section labels              */
  --primary: #a984f5;       /* violet — caret, prompt, .run, active  */
  --icon: #b6b6c0;          /* idle icon-button glyph                */
  --sep: #3f3f48;           /* footer middot separators              */
  --stat-label: #6c6c76;    /* footer metric labels (up, ln)         */
  --ok: #57b87a;            /* status dot — WASM ready / live         */
  --ok-text: #8fcca5;       /* status text                           */

  /* interaction */
  --hover: rgba(255, 255, 255, 0.07);   /* icon-button hover wash */
  --row-hover: rgba(255, 255, 255, 0.045);
  --selected: rgba(169, 132, 245, 0.14); /* active session row fill */

  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --radius-sm: 4px;
  --radius-md: 6px;
  --radius-lg: 8px;
  --radius-card: 10px;
  --shadow-card: 0 18px 50px rgba(0, 0, 0, 0.5);
  --shadow-pop: 0 6px 20px rgba(0, 0, 0, 0.45);
  --caret-rate: 530ms;

  /* resizable split-layout track widths (mutated by src/split.ts) */
  --sidebar-w: 248px;
  --assistant-w: 420px;
  --gutter-w: 6px;

  /* All UI type is JetBrains Mono (chrome labels included), per the brand. */
  --font-sans: "JetBrains Mono", ui-monospace, "SFMono-Regular", monospace;
  --font-mono: "JetBrains Mono", ui-monospace, "SFMono-Regular", monospace;
}

/* The web-component host fills the box the consumer sizes (height set by the
   embedding page / standalone shell); #app then fills the host. */
:host {
  display: block;
  height: 100%;
  /* Reset inherited text properties. Shadow DOM encapsulates *selectors*, but
     INHERITED properties still cross the boundary from the host's context — so
     an embedding page that sets e.g. text-align:center on a centered hero would
     otherwise center the terminal's file-tree labels and other left-aligned UI.
     Establish a neutral baseline here; the terminal's own rules override it. */
  text-align: left;
  letter-spacing: normal;
  word-spacing: normal;
  text-transform: none;
  text-indent: 0;
  font-style: normal;
}

/* Reset + base ink/type scoped to the terminal subtree (the host page keeps its
   own box-sizing, background and fonts — nothing here applies outside #app). */
#app, #app * { box-sizing: border-box; }

#app ::selection { background: rgba(169, 132, 245, 0.32); }

/* Slim violet-grey scrollbars (comp) — chrome panes only; the canvas paints
   its own scrollback. */
#app ::-webkit-scrollbar { width: 9px; height: 9px; }
#app ::-webkit-scrollbar-thumb {
  background: var(--popover-border);
  border-radius: 999px;
  border: 2px solid transparent;
  background-clip: padding-box;
}
#app ::-webkit-scrollbar-thumb:hover { background: #46464f; background-clip: padding-box; }
#app ::-webkit-scrollbar-track { background: transparent; }

#app {
  position: relative;
  /* Fill the host (the <nano-terminal> element / standalone container) rather
     than the viewport, so the terminal embeds at any size. */
  height: 100%;
  display: grid;
  grid-template-rows: auto 1fr auto;
  /* Five columns: sidebar · left-gutter · terminal · right-gutter · assistant.
     Each collapsible track is its own var so the two collapse classes compose
     without a combinatorial explosion. The middle track is minmax(0,1fr) so it
     can shrink below the canvas's intrinsic width when a gutter is dragged in. */
  --_sidebar-track: var(--sidebar-w);
  --_lgutter-track: var(--gutter-w);
  --_rgutter-track: var(--gutter-w);
  --_assistant-track: var(--assistant-w);
  grid-template-columns:
    var(--_sidebar-track) var(--_lgutter-track)
    minmax(0, 1fr)
    var(--_rgutter-track) var(--_assistant-track);
  background: var(--surface);
  color: var(--fg);
  font-family: var(--font-sans);
  -webkit-font-smoothing: antialiased;
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  box-shadow: var(--shadow-card);
  overflow: hidden;
}
#app.sidebar-collapsed { --_sidebar-track: 0px; --_lgutter-track: 0px; }
#app.assistant-collapsed { --_assistant-track: 0px; --_rgutter-track: 0px; }
#app.sidebar-collapsed #sidebar,
#app.sidebar-collapsed #gutter-left { display: none; }
#app.assistant-collapsed #assistant-pane,
#app.assistant-collapsed #gutter-right { display: none; }
/* During a gutter drag, suppress selection + show the resize cursor everywhere. */
#app.dragging { cursor: col-resize; user-select: none; }

/* — shared icon button (comp .ut-btn) — */
.icon-btn {
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: none;
  color: var(--icon);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
}
.icon-btn:hover { background: var(--hover); color: var(--fg); }

kbd {
  font-family: var(--font-mono);
  font-size: 11px;
  background: var(--ground);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 1px 5px;
  color: var(--muted-fg);
}

/* — top bar — */
#topbar {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  height: 34px;
  padding: 0 10px 0 8px;
  background: var(--chrome-bg);
  border-bottom: 1px solid var(--border);
}
#topbar .brand {
  font-family: var(--font-mono);
  font-weight: 700;
  font-size: 13px;
  letter-spacing: -0.03em;
  color: var(--fg);
  line-height: 1;
}
#topbar .brand .dot { color: var(--primary); }
#topbar .spacer { flex: 1; }
#topbar .badge {
  font-family: var(--font-mono);
  font-size: 9.5px;
  color: #a7a7b2;
  padding: 4px 9px;
  border: 1px solid var(--popover-border);
  border-radius: 999px;
  letter-spacing: 0.01em;
  white-space: nowrap;
}
#topbar .actions { display: flex; align-items: center; gap: 2px; }

/* — sidebar (VS Code-style: activity rail + single active view) — */
#sidebar {
  grid-row: 2;
  grid-column: 1;
  display: flex;
  min-width: 0;
  background: var(--sidebar-bg);
  border-right: 1px solid var(--border);
  overflow: hidden;
}

.activity-bar {
  flex: none;
  width: 46px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 8px 0;
  background: var(--chrome-bg);
  border-right: 1px solid var(--border);
}
.activity-btn {
  position: relative;
  width: 34px;
  height: 34px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: none;
  color: var(--icon);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
}
.activity-btn:hover { background: var(--hover); color: var(--fg); }
.activity-btn.active { color: var(--fg); }
.activity-btn svg { width: 20px; height: 20px; }
.activity-btn.active::before {
  content: "";
  position: absolute;
  left: -8px;
  top: 7px;
  bottom: 7px;
  width: 2px;
  border-radius: 2px;
  background: var(--primary);
}

.sidebar-views {
  flex: 1;
  min-width: 0;
  overflow: hidden auto;
  padding: var(--space-2) var(--space-2) 14px;
}

.panel { display: none; flex-direction: column; height: 100%; }
.panel.active { display: flex; }
.panel-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 4px 6px 8px 4px;
  user-select: none;
}
.panel-label {
  font-size: 9.5px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  font-weight: 700;
  color: var(--label);
  flex: 1;
}
.panel-hint {
  font-family: var(--font-mono);
  font-size: 9px;
  color: #5a5a64;
}
.panel-body { flex: 1; min-height: 0; overflow-y: auto; padding: 2px 0 var(--space-2); }
.panel.collapsed .panel-body { display: none; }

.list { list-style: none; margin: 0; padding: 0; }
.session-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 6px 8px;
  margin: 1px 0;
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: background 0.1s;
}
.session-row:hover { background: var(--row-hover); }
.session-row.active { background: var(--selected); }
.session-row .session-ico { color: var(--label); flex: none; }
.session-row.active .session-ico { color: var(--primary); }
.session-meta { flex: 1; min-width: 0; }
.session-name {
  font-size: 11px;
  color: #c4c4cc;
  line-height: 1.2;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.session-row.active .session-name { color: #d9ccfb; }
.session-cwd {
  font-family: var(--font-mono);
  font-size: 9.5px;
  color: #6c6c76;
  line-height: 1.25;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.muted-note {
  font-family: var(--font-mono);
  font-size: 10px;
  color: #6c6c76;
  line-height: 1.5;
  padding: 2px 6px;
}

/* — catalog panel — */
.catalog-filter {
  width: 100%;
  margin: 0 0 6px;
  padding: 5px 8px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  color: var(--fg);
  font-family: var(--font-sans);
  font-size: 11px;
  outline: none;
}
.catalog-filter:focus { border-color: var(--primary); }
.catalog-filter::placeholder { color: #5a5a64; }

.catalog-list {
  display: flex;
  flex-direction: column;
}
.catalog-sub {
  font-size: 9px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  font-weight: 700;
  color: var(--stat-label);
  padding: 8px 6px 3px;
}
.catalog-sub:first-child { padding-top: 2px; }
.catalog-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  padding: 5px 8px;
  margin: 1px 0;
  border: none;
  background: none;        /* install progress paints background-image (a left→right fill) */
  border-radius: var(--radius-md);
  cursor: pointer;
  text-align: left;
  font-family: var(--font-sans);
  transition: background-color 0.1s;
}
/* indeterminate (bundle) install — gently pulse the row fill */
.catalog-row.installing { animation: catalog-pulse 1.1s ease-in-out infinite; }
@keyframes catalog-pulse {
  0%, 100% { background-color: transparent; }
  50% { background-color: var(--selected); }
}
.catalog-row:hover:not(:disabled) { background: var(--row-hover); }
.catalog-row:disabled { cursor: default; }
.catalog-name {
  flex: 1;
  min-width: 0;
  font-size: 11px;
  color: #c4c4cc;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.catalog-row.installed .catalog-name { color: #9aa0aa; }
.catalog-ver {
  flex: none;
  font-family: var(--font-mono);
  font-size: 9px;
  color: #6c6c76;
}
.catalog-state {
  flex: none;
  width: 14px;
  text-align: center;
  font-size: 12px;
  color: var(--label);
}
.catalog-row:hover:not(:disabled):not(.installed) .catalog-state { color: var(--primary); }
.catalog-row.installing .catalog-state { color: var(--primary); }
.catalog-row.installed .catalog-state { color: var(--ok); }

/* category chips (browse facet) */
.catalog-cats {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 2px 4px 4px;
}
.catalog-chip {
  font-family: var(--font-sans);
  font-size: 9.5px;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: none;
  color: var(--muted-fg);
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.1s, color 0.1s, border-color 0.1s;
}
.catalog-chip:hover { background: var(--row-hover); color: var(--fg); }
.catalog-chip.active {
  background: var(--selected);
  border-color: var(--primary);
  color: #d9ccfb;
}

/* curated bundle rows (two lines: title + description) */
.catalog-curated { align-items: flex-start; }
.catalog-meta { flex: 1; min-width: 0; }
.catalog-curated .catalog-name { font-weight: 500; color: #cfcfe0; }
.catalog-desc {
  font-family: var(--font-mono);
  font-size: 9px;
  color: var(--muted-fg);
  line-height: 1.3;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.catalog-curated .catalog-state { margin-top: 1px; }

/* — files panel — */
.files-body { padding: 2px 0 var(--space-2); }
.files-toolbar {
  display: flex;
  gap: 3px;
  padding: 0 4px 5px;
}
.files-tool {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 26px;
  border: none;
  background: none;
  color: var(--muted-fg);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: background 0.1s, color 0.1s;
}
.files-tool:hover { background: var(--hover); color: var(--fg); }
.files-tool-gap { flex: 1; }
.file-row.mapped > .file-name::after {
  content: "⤓";
  margin-left: 4px;
  color: var(--primary);
  font-size: 9px;
}
.files-tree {
  display: flex;
  flex-direction: column;
}
.file-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 5px;
  min-height: 20px;
  padding: 1px 4px 1px 6px;
  border-radius: var(--radius-md);
  cursor: pointer;
  font-family: var(--font-sans);
  font-size: 10.5px;
  color: #c4c4cc;
  user-select: none;
  transition: background-color 0.1s;
}
.file-row:hover { background: var(--row-hover); }
.file-row.selected { background: var(--selected); color: #e7defc; }
.file-row.active-dir > .file-name { color: var(--fg); }
.file-row > svg { flex: none; color: var(--label); }
.file-row.dir > svg:last-of-type { color: #8d86a8; }
.file-twist {
  flex: none;
  color: var(--label);
  transition: transform 0.12s ease;
}
.file-twist.open { transform: rotate(90deg); }
.file-twist-spacer { width: 16px; flex: none; }
.file-name {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* Absolutely positioned so revealing them on hover never reflows/shifts the tree. */
.file-actions {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  display: none;
  align-items: center;
  gap: 1px;
  padding: 0 4px 0 8px;
  background: var(--row-hover);
}
.file-actions::before {
  content: "";
  position: absolute;
  left: -14px;
  top: 0;
  bottom: 0;
  width: 14px;
  background: linear-gradient(to right, transparent, var(--row-hover));
}
.file-row.selected .file-actions { background: var(--selected); }
.file-row.selected .file-actions::before { background: linear-gradient(to right, transparent, var(--selected)); }
.file-row:hover .file-actions { display: inline-flex; }
.file-act {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 20px;
  border: none;
  background: none;
  color: var(--label);
  border-radius: 4px;
  cursor: pointer;
}
.file-act:hover { background: var(--hover); color: var(--fg); }
.file-row.arming-delete { background: rgba(238, 96, 96, 0.16); }
.file-row.arming-delete .file-act:last-child { color: #f06a6a; }
.file-input {
  flex: 1;
  min-width: 0;
  padding: 1px 5px;
  background: var(--surface);
  border: 1px solid var(--primary);
  border-radius: 4px;
  color: var(--fg);
  font-family: var(--font-sans);
  font-size: 11px;
  outline: none;
}
.file-create { gap: 5px; }
.file-create::before {
  content: attr(data-label);
  font-family: var(--font-mono);
  font-size: 9px;
  color: var(--muted-fg);
  flex: none;
}

/* — tooltip — */
#tooltip {
  position: fixed;
  left: 0;
  top: 0;
  z-index: 10000;
  pointer-events: none;
  max-width: 240px;
  padding: 2px 6px;
  background: var(--elevated);
  border: 1px solid var(--popover-border);
  border-radius: 5px;
  box-shadow: var(--shadow-pop);
  color: var(--fg);
  font-family: var(--font-sans);
  font-size: 9.5px;
  line-height: 1.4;
  letter-spacing: 0.01em;
  white-space: nowrap;
  opacity: 0;
  transform: translateY(-3px);
  transition: opacity 0.12s ease, transform 0.12s ease;
}
#tooltip.above { transform: translateY(3px); }
#tooltip.show { opacity: 1; transform: translateY(0); }

/* — terminal area (tabbed: Terminal / Editor / Preview) — */
#terminal-area {
  grid-row: 2;
  grid-column: 3;
  background: var(--surface);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

/* — resizable split gutters (drag controller: src/split.ts) — */
.gutter {
  grid-row: 2;
  background: var(--border);
  cursor: col-resize;
  touch-action: none; /* pointer-drag, never scroll */
  transition: background 0.12s;
}
.gutter:hover,
.gutter.dragging { background: var(--primary); }
.gutter:focus-visible { outline: 2px solid var(--primary); outline-offset: -2px; }
#gutter-left { grid-column: 2; }
#gutter-right { grid-column: 4; }

/* — assistant right-dock pane — */
#assistant-pane {
  grid-row: 2;
  grid-column: 5;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--sidebar-bg);
  border-left: 1px solid var(--border);
}
.assistant-pane-head {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 8px 8px 8px 12px;
  border-bottom: 1px solid var(--border);
  user-select: none;
}
.assistant-pane-head .assistant-pane-ico { width: 15px; height: 15px; color: var(--primary); flex: none; }
.assistant-pane-head .panel-label { flex: none; }
.assistant-pane-head .panel-hint { flex: 1; }
#assistant-pane #assistant-host { flex: 1; min-height: 0; display: flex; }
.tabstrip {
  flex: none;
  display: flex;
  align-items: stretch;
  height: 34px;
  background: var(--chrome-bg);
  border-bottom: 1px solid var(--border);
  padding: 0 4px;
  gap: 1px;
}
.tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0 12px;
  border: none;
  background: none;
  color: var(--muted-fg);
  font-family: var(--font-sans);
  font-size: 11.5px;
  cursor: pointer;
  border-top: 2px solid transparent;
  transition: background 0.1s, color 0.1s;
}
.tab[hidden] { display: none; }
.tab:hover { background: var(--row-hover); color: var(--fg); }
.tab > svg { flex: none; color: var(--label); }
.tab.active {
  color: var(--fg);
  background: var(--surface);
  border-top-color: var(--primary);
}
.tab.active > svg { color: var(--primary); }
.tab-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 15px;
  height: 15px;
  margin-left: 2px;
  border-radius: 3px;
  color: var(--label);
  font-size: 13px;
  line-height: 1;
}
.tab-close:hover { background: var(--hover); color: var(--fg); }

.tab-host { flex: 1; position: relative; min-height: 0; }
.tab-pane { position: absolute; inset: 0; display: none; }
.tab-pane.active { display: block; }
#term-pane { padding: var(--space-3); }
/* ID-specific layout must be scoped to .active, or it overrides display:none. */
.tab-pane.active#editor-host { overflow: hidden; background: var(--surface); }
.tab-pane.active#preview-host { display: flex; flex-direction: column; background: #fff; }
#editor-host .cm-editor { height: 100%; }
#screen { display: block; }

/* — preview tab — */
.preview-bar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 32px;
  padding: 0 8px;
  background: var(--chrome-bg);
  border-bottom: 1px solid var(--border);
}
.preview-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 22px;
  border: none;
  background: none;
  color: var(--icon);
  border-radius: var(--radius-md);
  cursor: pointer;
}
.preview-btn:hover { background: var(--hover); color: var(--fg); }
.preview-port {
  background: var(--surface);
  color: var(--fg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  font-size: 11px;
  padding: 2px 4px;
}
.preview-address {
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--muted-fg);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.preview-status {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--primary);
}
.preview-framewrap { flex: 1; position: relative; min-height: 0; }
.preview-frame {
  width: 100%;
  height: 100%;
  border: none;
  background: #fff;
}
.preview-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  text-align: center;
  padding: 24px;
  background: var(--surface);
  color: var(--fg);
  font-family: var(--font-sans);
}
.preview-overlay[hidden] { display: none; }
.preview-overlay-title { font-size: 15px; font-weight: 600; color: var(--fg); }
.preview-overlay-hint { font-family: var(--font-mono); font-size: 11.5px; color: var(--muted-fg); }

/* — footer — */
#footer {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  height: 30px;
  padding: 0 14px;
  background: var(--chrome-bg);
  border-top: 1px solid var(--border);
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--muted-fg);
  font-variant-numeric: tabular-nums;
  overflow: hidden;
}
#footer .spacer { flex: 1; }
#footer .sep { color: var(--sep); padding: 0 10px; }
#footer .lbl { color: var(--stat-label); }
#footer .stat.run { color: var(--primary); }
#footer .stat.status { display: inline-flex; align-items: center; gap: 5px; color: var(--ok-text); }
#footer .stat.status .dot {
  width: 6px; height: 6px; border-radius: 999px; background: var(--ok);
}
#footer .stat.port { color: var(--ok); font-variant-numeric: tabular-nums; }
#footer .stat.port[hidden] { display: none; }
#footer .stat.asst { color: var(--primary); font-variant-numeric: tabular-nums; }
#footer .stat.asst[hidden], #footer .sep.asst-sep[hidden] { display: none; }

/* — settings popover (comp) — */
#settings-popover {
  position: absolute;
  top: 40px;
  right: 10px;
  width: 248px;
  background: var(--elevated);
  border: 1px solid var(--popover-border);
  border-radius: var(--radius-card);
  box-shadow: var(--shadow-pop);
  padding: var(--space-2);
  z-index: 30;
}
#settings-popover[hidden] { display: none; }
.settings-label {
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--label);
  padding: 6px 8px 8px;
}
.settings-row {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 8px;
  border: none;
  background: none;
  border-radius: var(--radius-md);
  font-family: var(--font-sans);
  font-size: 12px;
  color: #d4d4dc;
  cursor: pointer;
  text-align: left;
}
.settings-row:hover { background: var(--row-hover); }
.settings-row svg { flex: none; color: var(--icon); }
.settings-row svg.accent { color: var(--primary); }
.settings-row kbd { margin-left: auto; }
.settings-div { height: 1px; background: var(--popover-border); margin: 6px 8px; }
.settings-note {
  font-family: var(--font-mono);
  font-size: 10px;
  color: #5a5a64;
  padding: 4px 8px 4px;
  line-height: 1.5;
}

/* — Cmd-K palette (a console addition, styled to the popover family) — */
#palette-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 14vh;
  z-index: 50;
}
#palette-overlay[hidden] { display: none; }
#palette {
  width: min(520px, 90vw);
  background: var(--elevated);
  border: 1px solid var(--popover-border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-pop);
  overflow: hidden;
}
#palette-input {
  width: 100%;
  border: none;
  outline: none;
  background: transparent;
  color: var(--fg);
  font-family: var(--font-sans);
  font-size: 15px;
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--border);
}
#palette-list { list-style: none; margin: 0; padding: var(--space-1); max-height: 320px; overflow: auto; }
#palette-list li {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  font-size: 13px;
  cursor: pointer;
}
#palette-list li .pl-hint { margin-left: auto; color: var(--muted-fg); font-family: var(--font-mono); font-size: 11px; }
#palette-list li.sel { background: var(--primary); color: var(--ground); }
#palette-list li.sel .pl-hint { color: var(--ground); }

/* ── AI assistant chat ──────────────────────────────────────────────────────
   A ChatGPT/Claude-style chat over the model-agnostic orchestrator: an
   availability banner, message log, codegen chips, a rounded composer (model
   dropdown + mode pill + Send/Stop + live tok/s), and inline approval cards.
   Fills the right-dock #assistant-pane as a flex column with the log scrolling. */
.asst { flex: 1; min-height: 0; display: flex; flex-direction: column; }

.asst-banner {
  font-size: 12px;
  color: var(--muted-fg);
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--border);
  background: rgba(169, 132, 245, 0.06);
}
.asst-dl {
  margin-left: var(--space-1);
  font: inherit;
  color: var(--ground);
  background: var(--primary);
  border: 0;
  border-radius: var(--radius-sm);
  padding: 2px 8px;
  cursor: pointer;
}

.asst-log {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-3);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  font-size: 13px;
  line-height: 1.5;
}
.asst-note { color: var(--muted-fg); font-size: 12px; }
.asst-msg {
  max-width: 92%;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  white-space: pre-wrap;
  word-break: break-word;
}
.asst-msg.user { align-self: flex-end; background: var(--selected); color: var(--fg); }
.asst-msg.bot { align-self: flex-start; background: var(--elevated); color: var(--fg); }
.asst-status { color: var(--label); font-size: 11px; font-family: var(--font-mono); }
.asst-error { color: #f0a0a0; font-size: 12px; }
/* — Agent transcript: reasoning disclosure + tool status cards — */
.asst-reason {
  align-self: stretch;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: rgba(255, 255, 255, 0.015);
}
.asst-reason > summary {
  list-style: none;
  cursor: pointer;
  user-select: none;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  color: var(--muted-fg);
  font-family: var(--font-mono);
  font-size: 11px;
}
.asst-reason > summary::-webkit-details-marker { display: none; }
.asst-reason > summary::after {
  content: "\\203A";
  margin-left: auto;
  opacity: 0.55;
  transition: transform 0.15s ease;
}
.asst-reason[open] > summary::after { transform: rotate(90deg); }
.asst-reason.done { opacity: 0.8; }
.asst-reason-ic { color: var(--primary); font-size: 10px; }
.asst-reason-ic::before { content: "\\2726"; }
.asst-reason-body {
  margin: 0 var(--space-3) var(--space-2);
  padding-top: var(--space-2);
  border-top: 1px solid var(--border);
  color: var(--muted-fg);
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 240px;
  overflow: auto;
}

.asst-tool {
  align-self: stretch;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--elevated);
  overflow: hidden;
}
.asst-tool-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  font-size: 12px;
}
.asst-tool-label { color: var(--fg); word-break: break-word; }
.asst-tool-label code {
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--primary);
  background: rgba(169, 132, 245, 0.1);
  padding: 1px 5px;
  border-radius: var(--radius-sm);
}
.asst-tool-ic {
  flex: none;
  width: 14px;
  height: 14px;
  display: inline-grid;
  place-items: center;
  box-sizing: border-box;
}
.asst-tool[data-status="running"] .asst-tool-ic {
  border: 1.5px solid var(--border);
  border-top-color: var(--primary);
  border-radius: 50%;
  animation: asst-spin 0.7s linear infinite;
}
.asst-tool[data-status="done"] .asst-tool-ic::before { content: "\\2713"; color: var(--ok); font-size: 12px; }
.asst-tool[data-status="fail"] .asst-tool-ic::before { content: "\\2715"; color: #e0685f; font-size: 12px; }
.asst-tool[data-status="fail"] { border-color: rgba(224, 104, 95, 0.5); }
@keyframes asst-spin { to { transform: rotate(360deg); } }

.asst-tool-out { border-top: 1px solid var(--border); }
.asst-tool-out > summary {
  list-style: none;
  cursor: pointer;
  user-select: none;
  padding: var(--space-1) var(--space-3);
  color: var(--muted-fg);
  font-family: var(--font-mono);
  font-size: 11px;
}
.asst-tool-out > summary::-webkit-details-marker { display: none; }
.asst-tool-out > summary::before { content: "\\203A  "; opacity: 0.55; }
.asst-tool-out[open] > summary::before { content: "\\2304  "; }
.asst-tool-out.fail > summary { color: #e6a5a5; }
.asst-tool-out pre {
  margin: 0;
  padding: var(--space-2) var(--space-3);
  background: var(--surface);
  border-top: 1px solid var(--border);
  font-family: var(--font-mono);
  font-size: 11px;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 220px;
  overflow: auto;
}

.asst-templates {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
  padding: var(--space-2) var(--space-3) 0;
}
/* \`display: flex\` above would otherwise defeat the \`hidden\` attribute. */
.asst-templates[hidden] { display: none; }
.asst-chip {
  font: inherit;
  font-size: 11px;
  color: var(--fg);
  background: var(--elevated);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 3px 10px;
  cursor: pointer;
}
.asst-chip:hover { background: var(--hover); }

/* — composer (rounded card: textarea + a control bar) — */
.asst-composer {
  position: relative;
  margin: var(--space-2) var(--space-3) var(--space-3);
  padding: var(--space-2);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  transition: border-color 0.12s;
}
.asst-composer:focus-within { border-color: var(--primary); }
/* A slim shimmer along the top edge while a turn is streaming. */
.asst-composer.busy { border-color: var(--primary); }
.asst-composer.busy::before {
  content: "";
  position: absolute;
  left: 0; right: 0; top: -1px; height: 2px;
  border-radius: 2px;
  background: linear-gradient(90deg, transparent, var(--primary), transparent);
  background-size: 40% 100%;
  animation: asst-shimmer 1.1s linear infinite;
}
@keyframes asst-shimmer {
  from { background-position: -40% 0; }
  to { background-position: 140% 0; }
}
.asst-text {
  display: block;
  width: 100%;
  resize: none;
  border: none;
  outline: none;
  background: transparent;
  font: inherit;
  font-size: 13px;
  line-height: 1.45;
  color: var(--fg);
  max-height: 160px;
  overflow-y: auto;
  padding: var(--space-1) var(--space-1) var(--space-2);
}
.asst-text:disabled { opacity: 0.5; }

.asst-composer-bar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-1);
}
.asst-bar-right { margin-left: auto; display: flex; align-items: center; gap: var(--space-2); }

/* Small pill-shaped bar controls (mode pill, model button, codegen toggle). */
.asst-mode-pill,
.asst-model-btn,
.asst-codegen {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font: inherit;
  font-size: 11px;
  color: var(--fg);
  background: var(--elevated);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 3px 9px;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.12s, border-color 0.12s, color 0.12s;
}
.asst-mode-pill:hover,
.asst-model-btn:hover,
.asst-codegen:hover { background: var(--hover); }
.asst-codegen.active { color: var(--primary); border-color: var(--primary); }

/* Mode pill: a per-mode accent dot via ::before. */
.asst-mode-pill::before {
  content: "";
  width: 7px; height: 7px; border-radius: 999px;
  background: var(--muted-fg);
}
.asst-mode-pill[data-mode="plan"]::before { background: #6aa5ff; }
.asst-mode-pill[data-mode="ask"]::before { background: var(--muted-fg); }
.asst-mode-pill[data-mode="acceptEdits"]::before { background: #e0b447; }
.asst-mode-pill[data-mode="auto"]::before { background: #e0685f; }
.asst-mode-pill[data-mode="plan"] { border-color: rgba(106, 165, 255, 0.5); }
.asst-mode-pill[data-mode="auto"] { border-color: rgba(224, 104, 95, 0.5); }

/* Model dropdown. */
.asst-model { position: relative; display: inline-flex; }
.asst-model-btn > svg { color: var(--muted-fg); }
.asst-dot {
  width: 8px; height: 8px; border-radius: 999px; flex: none;
  background: var(--muted-fg);
}
.asst-dot[data-state="available"] { background: var(--ok); }
.asst-dot[data-state="downloadable"],
.asst-dot[data-state="downloading"] { background: #e0b447; }
.asst-dot[data-state="unavailable"] { background: var(--muted-fg); }
.asst-model-menu {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 0;
  min-width: 200px;
  z-index: 20;
  background: var(--elevated);
  border: 1px solid var(--popover-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-pop);
  padding: var(--space-1);
  display: flex;
  flex-direction: column;
}
.asst-model-menu[hidden] { display: none; }
.asst-model-opt {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  font: inherit;
  font-size: 12px;
  color: var(--fg);
  background: none;
  border: none;
  border-radius: var(--radius-sm);
  padding: 6px 8px;
  cursor: pointer;
  text-align: left;
}
.asst-model-opt:hover,
.asst-model-opt:focus-visible { background: var(--row-hover); outline: none; }
.asst-model-opt[aria-selected="true"] { background: var(--selected); }
.asst-model-optname { flex: 1; }
.asst-model-detail { color: var(--muted-fg); font-size: 10.5px; font-family: var(--font-mono); }
.asst-model-opt > svg { color: var(--primary); flex: none; }

/* Live tok/s + context usage. */
.asst-tok {
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--primary);
  font-variant-numeric: tabular-nums;
}
.asst-tok[hidden] { display: none; }
.asst-usage { font-family: var(--font-mono); font-size: 10.5px; color: var(--stat-label); }

/* Send / Stop button. */
.asst-send {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  color: var(--ground);
  background: var(--primary);
  border: 0;
  border-radius: var(--radius-md);
  cursor: pointer;
}
.asst-send:disabled { opacity: 0.45; cursor: default; }
.asst-send.stop {
  color: var(--fg);
  background: var(--elevated);
  border: 1px solid var(--border);
}

/* — inline tool-approval card — */
.asst-approval {
  border: 1px solid var(--popover-border);
  border-left: 3px solid var(--primary);
  border-radius: var(--radius-md);
  background: var(--elevated);
  padding: var(--space-2) var(--space-3);
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.asst-approval[data-kind="exec"] { border-left-color: #e0685f; }
.asst-approval[data-kind="edit"] { border-left-color: #e0b447; }
.asst-approval-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--fg);
}
.asst-approval-head > svg { color: var(--primary); flex: none; }
.asst-approval-summary {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--muted-fg);
  white-space: pre-wrap;
  word-break: break-word;
}
.asst-approval-acts { display: flex; flex-wrap: wrap; gap: var(--space-2); margin-top: 2px; }
.asst-approve,
.asst-reject,
.asst-always {
  font: inherit;
  font-size: 11.5px;
  border-radius: var(--radius-sm);
  padding: 4px 10px;
  cursor: pointer;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--fg);
}
.asst-approve { background: var(--primary); color: var(--ground); border-color: var(--primary); font-weight: 600; }
.asst-approve:hover { filter: brightness(1.06); }
.asst-reject:hover,
.asst-always:hover { background: var(--hover); }
.asst-approval-done { font-size: 11px; color: var(--muted-fg); font-family: var(--font-mono); }
`;
export default css;
