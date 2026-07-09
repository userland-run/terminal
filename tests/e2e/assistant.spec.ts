// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run terminal; dual-licensed - see LICENSE.md.

// End-to-end checks for the assistant UX overhaul: the resizable right-dock
// pane + draggable gutters, and the redesigned chat composer (model dropdown,
// mode pill, footer stat). The on-device / WebGPU model isn't available in
// headless Chromium, so these assert the UI plumbing and interaction logic
// (which don't need a live model), not a generated reply.

import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

async function boot(page: Page): Promise<void> {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto("/");
  await expect(page.locator("#stat-status")).toHaveText("live");
  // Stash collected errors on the page for a per-test assertion.
  (page as unknown as { __errors: string[] }).__errors = errors;
}

const cssVarPx = (app: Locator, name: string): Promise<number> =>
  app.evaluate((el, n) => parseFloat(getComputedStyle(el).getPropertyValue(n)) || 0, name);

test(
  "assistant pane opens, resizes, and the composer renders",
  { tag: ["@feat:terminal.assistant.panel"] },
  async ({ page }) => {
    await boot(page);
    const app = page.locator("#app");
    const pane = page.locator("#assistant-pane");
    const toggle = page.locator("#assistant-toggle");

    // Starts docked-closed (scaffold ships #app.assistant-collapsed).
    await expect(app).toHaveClass(/assistant-collapsed/);
    await expect(pane).toBeHidden();

    // The top-bar toggle opens the right-dock pane.
    await toggle.click();
    await expect(app).not.toHaveClass(/assistant-collapsed/);
    await expect(pane).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");

    // The redesigned composer + its controls are present.
    await expect(page.locator("#assistant-pane .asst-composer")).toBeVisible();
    await expect(page.locator("#assistant-pane .asst-text")).toBeVisible();
    await expect(page.locator("#assistant-pane .asst-send")).toContainText(/Send/);
    await expect(page.locator("#assistant-pane .asst-mode-pill")).toBeVisible();
    await expect(page.locator("#assistant-pane .asst-model-btn")).toBeVisible();

    // Drag the right gutter left by 80px → the assistant track grows.
    const before = await cssVarPx(app, "--assistant-w");
    const g = page.locator("#gutter-right");
    const box = (await g.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x - 80, box.y + box.height / 2, { steps: 6 });
    await page.mouse.up();
    const after = await cssVarPx(app, "--assistant-w");
    expect(after).toBeGreaterThan(before + 40);

    // ⌘J closes it again.
    await page.keyboard.press("Meta+j");
    await expect(app).toHaveClass(/assistant-collapsed/);

    // No real JS errors during mount/interaction (benign offline network noise
    // from the local model's availability probe is filtered out).
    const real = (page as unknown as { __errors: string[] }).__errors.filter(
      (e) => !/Failed to load resource|net::|ERR_|huggingface|Access-Control|CORS|favicon/i.test(e),
    );
    expect(real).toEqual([]);
  },
);

test(
  "mode pill cycles Plan → Ask → Accept-Edits → Auto",
  { tag: ["@feat:terminal.assistant.modes"] },
  async ({ page }) => {
    await boot(page);
    await page.locator("#assistant-toggle").click();
    const pill = page.locator("#assistant-pane .asst-mode-pill");

    // Default mode is Ask.
    await expect(pill).toHaveAttribute("data-mode", "ask");
    await expect(pill).toContainText("Ask");

    await pill.click();
    await expect(pill).toHaveAttribute("data-mode", "acceptEdits");
    await pill.click();
    await expect(pill).toHaveAttribute("data-mode", "auto");
    await pill.click();
    await expect(pill).toHaveAttribute("data-mode", "plan");
    await pill.click();
    await expect(pill).toHaveAttribute("data-mode", "ask");
  },
);

test(
  "model dropdown opens and lists backends",
  { tag: ["@feat:terminal.assistant.modelpicker"] },
  async ({ page }) => {
    await boot(page);
    await page.locator("#assistant-toggle").click();
    const btn = page.locator("#assistant-pane .asst-model-btn");
    const menu = page.locator("#assistant-pane .asst-model-menu");

    await expect(menu).toBeHidden();
    await btn.click();
    await expect(menu).toBeVisible();
    // At least the always-present Nano backend is listed.
    await expect(menu.locator(".asst-model-opt")).not.toHaveCount(0);
    await expect(menu).toContainText(/Gemini Nano/);

    // Clicking an option selects it and closes the menu.
    await menu.locator(".asst-model-opt").first().click();
    await expect(menu).toBeHidden();
  },
);

test(
  "sidebar gutter resizes the sidebar track",
  { tag: ["@feat:terminal.layout.split"] },
  async ({ page }) => {
    await boot(page);
    const app = page.locator("#app");
    const before = await cssVarPx(app, "--sidebar-w");
    const g = page.locator("#gutter-left");
    const box = (await g.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 60, box.y + box.height / 2, { steps: 6 });
    await page.mouse.up();
    const after = await cssVarPx(app, "--sidebar-w");
    expect(after).toBeGreaterThan(before + 30);
  },
);

test(
  "footer assistant stat + toggle command exist",
  { tag: ["@feat:terminal.assistant.footer"] },
  async ({ page }) => {
    await boot(page);
    // Idle: the assistant footer stat is present but hidden until generating.
    await expect(page.locator("#stat-asst")).toBeHidden();
    await expect(page.locator("#stat-asst-tps")).toHaveCount(1);

    // The palette exposes the assistant toggle command. Click #screen first so
    // #app holds focus (main.ts routes ⌘K only while the terminal is focused).
    await page.locator("#screen").click();
    await page.keyboard.press("Meta+k");
    await expect(page.locator("#palette-overlay")).toBeVisible();
    await page.locator("#palette-input").fill("assistant");
    await expect(page.locator("#palette-list")).toContainText("Toggle assistant");
  },
);
