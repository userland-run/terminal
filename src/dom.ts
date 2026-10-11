// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run terminal; dual-licensed - see LICENSE.md.

// Scoped DOM access so the terminal can live inside a shadow root (the SDK
// <nano-terminal> web component) instead of the global document. Every element
// lookup, scoped event listener, and overlay append goes through a DomScope.
//
// One DomScope per terminal instance (not a module singleton): two terminals on
// a page — or one booting while another is disposed — must never resolve each
// other's elements. createTerminal builds the scope and hands it to every
// controller (Chrome, Tabs, CommandBar, tooltips, …).
//
// Why this matters under Shadow DOM: a shadow root is NOT reachable via
// document.getElementById, and events that cross the shadow boundary are
// retargeted (e.target becomes the host) — so listeners that inspect the real
// target (popover-dismiss, tooltips) must be attached to the root itself.
//
// `signal` is the instance's teardown signal: listeners attached to anything
// that outlives the instance (document, window) pass it so dispose() removes them.

export class DomScope {
  constructor(
    /** The event root (Document or ShadowRoot) — attach scoped listeners here. */
    readonly root: Document | ShadowRoot,
    /** Where to append floating overlays (tooltips). Always inside the instance. */
    readonly overlay: HTMLElement,
    /** Aborted when the terminal instance is disposed. */
    readonly signal: AbortSignal,
    /** Where element lookups search — the instance's own subtree, so two
     *  light-DOM terminals on one page never resolve each other's #ids. */
    readonly scope: ParentNode = root,
  ) {}

  byId<T extends HTMLElement = HTMLElement>(id: string): T | null {
    return this.scope.querySelector<T>(`#${CSS.escape(id)}`);
  }

  qs<T extends Element = Element>(sel: string): T | null {
    return this.scope.querySelector<T>(sel);
  }

  qsa<T extends Element = Element>(sel: string): NodeListOf<T> {
    return this.scope.querySelectorAll<T>(sel);
  }

  /** Active element within this root (shadow-aware). */
  activeEl(): Element | null {
    return this.root.activeElement;
  }
}
