// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run terminal; dual-licensed - see LICENSE.md.

// Public configuration for the composable terminal. This mirrors the canonical
// `TerminalConfig` exported from `@sdk` (the @sdk alias points at the built SDK
// bundle, which `tsc` can't resolve — see src/catalog.ts). SDK embedders import
// the type from @sdk; this local copy keeps the terminal's own build typed.

import type { AssistantMode, CloudModelConfig } from "./assistant/types";
import type { LocalModelConfig } from "./assistant/local";

export interface TerminalPreviewConfig {
  /** Ports offered in the preview port selector. Default [8080]. */
  ports?: number[];
  /** Port selected when the Preview tab first opens. Default ports[0]. */
  defaultPort?: number;
}

export interface TerminalFeatureConfig {
  /** Catalog sidebar (searchable, installable app list). Default on. */
  catalog?: boolean;
  /** ⌘K command palette. Default on. */
  palette?: boolean;
  /** Files sidebar panel with CRUD on files/folders. Default on. */
  files?: boolean;
  /** CodeMirror file editor (opens in the Editor tab). Default on. */
  editor?: boolean;
  /** Server-app preview (iframe over the in-VM HTTP server). Default on. */
  preview?: boolean | TerminalPreviewConfig;
  /** AI assistant sidebar panel (Chrome Prompt API + optional cloud). Default on. */
  assistant?: boolean;
}

export interface TerminalAssistantConfig {
  /**
   * Enable the assistant. Defaults to on; set `false` (or `features.assistant:
   * false`, or the `no-assistant` attribute) to hide the panel entirely.
   */
  enabled?: boolean;
  /** Model selected when the panel first opens. Default "nano". */
  defaultModel?: "nano" | "cloud" | "local";
  /**
   * Permission mode the chat starts in (Claude-Code-style). Default "ask"
   * (confirm before mutating tools). "plan" = read-only planning,
   * "acceptEdits" = auto-run edits, "auto" = run everything.
   */
  defaultMode?: AssistantMode;
  /**
   * Optional host-injected cloud model. When present, the assistant offers a
   * "Cloud" model alongside on-device Nano and can generate real multi-file
   * projects. Omit to run Nano-only (fully on-device, no secrets).
   */
  cloud?: CloudModelConfig;
  /**
   * Local WebGPU model (nanoinfer engine): fully in-browser inference, weights
   * OPFS-cached after a one-time download. `false` hides the option; omit to
   * offer it whenever WebGPU + the default same-origin assets are present.
   */
  local?: LocalModelConfig | false;
}

export interface TerminalConfig {
  /** nano.wasm URL. Default "/nano.wasm". */
  wasmUrl?: string;
  /** Guest RAM in MB. Default 1800 (V8/Node OOMs below ~1.8 GB). */
  ramMB?: number;
  /** Command booted as the interactive session. Default "sh -i". */
  shellCommand?: string;
  /** Initial terminal font size in px. Default 12. */
  fontPx?: number;
  /** Service-worker URL backing the preview bridge. Default "/nano-sw.js". */
  serviceWorkerUrl?: string;
  /** Feature toggles; omitted features use the defaults above. */
  features?: TerminalFeatureConfig;
  /** Assistant wiring (e.g. an optional cloud model). */
  assistant?: TerminalAssistantConfig;
}

/** Fully-resolved config: every field present, every feature an object. */
export interface ResolvedConfig {
  wasmUrl: string;
  ramMB: number;
  shellCommand: string;
  fontPx: number;
  serviceWorkerUrl: string;
  features: {
    catalog: boolean;
    palette: boolean;
    files: boolean;
    editor: boolean;
    preview: { enabled: boolean; ports: number[]; defaultPort: number };
    assistant: boolean;
  };
  assistant: TerminalAssistantConfig & {
    defaultModel: "nano" | "cloud" | "local";
    defaultMode: AssistantMode;
  };
}

const DEFAULT_FONT_PX = 12; // matches the style-guide comp's terminal text scale
const DEFAULT_PREVIEW_PORTS = [8080];

/**
 * Deep-merge user config over the built-in defaults and normalize the shorthand
 * (`feature?: boolean | {…}`) into a fully-resolved shape. A feature is enabled
 * unless explicitly set to `false`.
 */
export function normalizeConfig(c: TerminalConfig = {}): ResolvedConfig {
  const f = c.features ?? {};
  const previewRaw = f.preview ?? true;
  const previewObj: TerminalPreviewConfig =
    typeof previewRaw === "object" ? previewRaw : {};
  const ports =
    previewObj.ports && previewObj.ports.length ? previewObj.ports : DEFAULT_PREVIEW_PORTS;
  return {
    wasmUrl: c.wasmUrl ?? "/nano.wasm",
    ramMB: c.ramMB ?? 1800,
    shellCommand: c.shellCommand ?? "sh -i",
    fontPx: c.fontPx ?? DEFAULT_FONT_PX,
    serviceWorkerUrl: c.serviceWorkerUrl ?? "/nano-sw.js",
    features: {
      catalog: f.catalog !== false,
      palette: f.palette !== false,
      files: f.files !== false,
      editor: f.editor !== false,
      preview: {
        enabled: previewRaw !== false,
        ports,
        defaultPort: previewObj.defaultPort ?? (ports[0] as number),
      },
      assistant: f.assistant !== false && c.assistant?.enabled !== false,
    },
    assistant: {
      ...(c.assistant ?? {}),
      defaultModel: c.assistant?.defaultModel ?? "nano",
      defaultMode: c.assistant?.defaultMode ?? "ask",
    },
  };
}
