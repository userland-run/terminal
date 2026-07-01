// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run terminal; dual-licensed - see LICENSE.md.

// Ambient types for Chrome's built-in AI surfaces we use: the Prompt API
// (`LanguageModel`, Gemini Nano) and WebMCP (`document.modelContext`). Both are
// origin-trial / flag-gated as of this writing, so the shapes are intentionally
// permissive and every use site feature-detects. This is a subset — not the full
// @types/dom-chromium-ai — covering only what the assistant touches.

export {};

declare global {
  // — Prompt API (Gemini Nano) —

  type LanguageModelAvailability =
    | "unavailable"
    | "downloadable"
    | "downloading"
    | "available"
    // legacy vocab seen on older builds:
    | "readily"
    | "after-download"
    | "no";

  interface LanguageModelExpected {
    type: "text" | "image" | "audio";
    languages?: string[];
  }

  interface LanguageModelMessage {
    role: "system" | "user" | "assistant";
    content: string;
  }

  interface LanguageModelCreateOptions {
    initialPrompts?: LanguageModelMessage[];
    temperature?: number;
    topK?: number;
    expectedInputs?: LanguageModelExpected[];
    expectedOutputs?: LanguageModelExpected[];
    monitor?: (m: EventTarget) => void;
    signal?: AbortSignal;
  }

  interface LanguageModelPromptOptions {
    responseConstraint?: unknown;
    omitResponseConstraintInput?: boolean;
    signal?: AbortSignal;
  }

  interface LanguageModelSession extends EventTarget {
    prompt(input: string, opts?: LanguageModelPromptOptions): Promise<string>;
    promptStreaming(input: string, opts?: LanguageModelPromptOptions): AsyncIterable<string>;
    append(input: LanguageModelMessage[]): Promise<void>;
    clone(opts?: { signal?: AbortSignal }): Promise<LanguageModelSession>;
    measureInputUsage(input: string, opts?: LanguageModelPromptOptions): Promise<number>;
    destroy(): void;
    readonly inputUsage: number;
    readonly inputQuota: number;
  }

  interface LanguageModelStatic {
    availability(opts?: Partial<LanguageModelCreateOptions>): Promise<LanguageModelAvailability>;
    create(opts?: LanguageModelCreateOptions): Promise<LanguageModelSession>;
    params(): Promise<{
      defaultTopK: number;
      maxTopK: number;
      defaultTemperature: number;
      maxTemperature: number;
    }>;
  }

  // Present only where the Prompt API is enabled.
  var LanguageModel: LanguageModelStatic | undefined;

  // — WebMCP (document.modelContext) —

  interface WebMcpToolAnnotations {
    readOnlyHint?: boolean;
    untrustedContentHint?: boolean;
  }

  interface WebMcpToolDescriptor {
    name: string;
    description: string;
    inputSchema: unknown;
    execute: (args: Record<string, unknown>) => Promise<string> | string;
    annotations?: WebMcpToolAnnotations;
  }

  interface WebMcpRegisterOptions {
    signal?: AbortSignal;
    exposedTo?: string[];
  }

  interface ModelContext extends EventTarget {
    registerTool(tool: WebMcpToolDescriptor, opts?: WebMcpRegisterOptions): void;
    getTools(opts?: { fromOrigins?: string[] }): Promise<unknown[]>;
    executeTool(tool: unknown, args: string, opts?: { signal?: AbortSignal }): Promise<unknown>;
  }

  interface Document {
    modelContext?: ModelContext;
  }

  interface Navigator {
    modelContext?: ModelContext;
  }
}
