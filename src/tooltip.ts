// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run terminal; dual-licensed - see LICENSE.md.

// A single styled tooltip, driven by hover/focus. It reuses each control's
// existing `title` (moving it to `data-tip` so the OS tooltip never shows), so
// every button gets a tooltip for free — including dynamically-created ones,
// via event delegation on the document.

import { domRoot, overlayHost } from "./dom";

const SHOW_DELAY = 350;

let installed = false;

export function installTooltips(): void {
  if (installed) return;
  installed = true;

  const tip = document.createElement("div");
  tip.id = "tooltip";
  tip.setAttribute("role", "tooltip");
  overlayHost().appendChild(tip);

  let current: HTMLElement | null = null;
  let timer = 0;

  // Pull the label text, converting a native `title` into `data-tip` once so the
  // browser's own tooltip is suppressed.
  const labelFor = (el: HTMLElement): string | null => {
    const title = el.getAttribute("title");
    if (title != null) {
      el.dataset.tip = title;
      el.removeAttribute("title");
    }
    return el.dataset.tip || null;
  };

  const position = (target: HTMLElement): void => {
    const r = target.getBoundingClientRect();
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    const gap = 7;
    let top = r.bottom + gap;
    let above = false;
    if (top + th > window.innerHeight - 8) {
      top = r.top - th - gap; // flip above when there's no room below
      above = true;
    }
    let left = r.left + r.width / 2 - tw / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - tw - 8));
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
    tip.classList.toggle("above", above);
  };

  const reveal = (target: HTMLElement, text: string): void => {
    tip.textContent = text;
    tip.classList.remove("show"); // measure at rest, then place + fade in
    position(target);
    tip.classList.add("show");
  };

  const hide = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = 0;
    }
    current = null;
    tip.classList.remove("show");
  };

  const onEnter = (target: HTMLElement | null, immediate: boolean): void => {
    if (!target || target === current) return;
    const text = labelFor(target);
    if (!text) return;
    current = target;
    if (timer) clearTimeout(timer);
    if (immediate) reveal(target, text);
    else timer = window.setTimeout(() => reveal(target, text), SHOW_DELAY);
  };

  // Delegated on the scoped root: under shadow DOM, document-level events are
  // retargeted to the host, so `e.target` here would never be the real control.
  const r = domRoot();
  r.addEventListener("pointerover", (e) => {
    const el = ((e as PointerEvent).target as HTMLElement | null)?.closest<HTMLElement>("[title], [data-tip]");
    onEnter(el ?? null, false);
  });
  r.addEventListener("pointerout", (e) => {
    const el = ((e as PointerEvent).target as HTMLElement | null)?.closest<HTMLElement>("[data-tip]");
    if (el && el === current) hide();
  });
  // Dismiss aggressively so a tooltip never lingers.
  r.addEventListener("pointerdown", hide, true);
  window.addEventListener("scroll", hide, true);
  window.addEventListener("blur", hide);
  // Keyboard focus shows the tooltip immediately (a11y).
  r.addEventListener("focusin", (e) => {
    onEnter(((e as FocusEvent).target as HTMLElement | null)?.closest<HTMLElement>("[title], [data-tip]") ?? null, true);
  });
  r.addEventListener("focusout", hide);
}
