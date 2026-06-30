// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run terminal; dual-licensed - see LICENSE.md.

// Scoped DOM access so the terminal can live inside a shadow root (the SDK
// <nano-terminal> web component) instead of the global document. Every element
// lookup, scoped event listener, and overlay append goes through here. Both the
// standalone app and the embedded element call setDomRoot() once at boot.
//
// Why this matters under Shadow DOM: a shadow root is NOT reachable via
// document.getElementById, and events that cross the shadow boundary are
// retargeted (e.target becomes the host) — so listeners that inspect the real
// target (popover-dismiss, tooltips) must be attached to the root itself.

let root: Document | ShadowRoot = document;
let overlay: HTMLElement | null = null;

export function setDomRoot(r: Document | ShadowRoot): void {
  root = r;
  overlay = r instanceof ShadowRoot ? r.querySelector<HTMLElement>("#app") : document.body;
}

/** The scoped root (Document or ShadowRoot) — attach scoped listeners here. */
export function domRoot(): Document | ShadowRoot {
  return root;
}

/** Where to append floating overlays (tooltips, the a11y mirror). */
export function overlayHost(): HTMLElement {
  return overlay ?? document.body;
}

export function byId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return root.querySelector<T>(`#${CSS.escape(id)}`);
}

export function qs<T extends Element = Element>(sel: string): T | null {
  return root.querySelector<T>(sel);
}

export function qsa<T extends Element = Element>(sel: string): NodeListOf<T> {
  return root.querySelectorAll<T>(sel);
}

/** Active element within the current root (shadow-aware). */
export function activeEl(): Element | null {
  return root.activeElement;
}
