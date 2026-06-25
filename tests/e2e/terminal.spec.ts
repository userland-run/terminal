// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run terminal; dual-licensed - see LICENSE.md.

// End-to-end gate for the userland.run terminal. The WebGPU/2D canvas (#screen)
// is opaque to the test runner, so every assertion targets the renderer-agnostic
// DOM text mirror (<pre aria-label="Terminal screen">, see src/a11y.ts) which is
// driven from the same TermSnapshot the renderer consumes. Tags of the form
// `@feat:<id>` map each test to a feature in the status registry.

import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

const mirrorOf = (page: Page): Locator =>
  page.locator('pre[aria-label="Terminal screen"]');

// Wait for the boot indicator (#stat-status flips "booting" → "live" once the VM
// is created in src/main.ts) and for the shell prompt to render into the mirror.
async function bootShell(page: Page): Promise<Locator> {
  await page.goto("/");
  await expect(page.locator("#stat-status")).toHaveText("live");
  const mirror = mirrorOf(page);
  // The interactive `sh -i` prompt is the first thing painted into the mirror.
  await expect(mirror).not.toBeEmpty();
  return mirror;
}

// Type into the guest tty. main.ts forwards window keydown → vm.writeStdin; the
// guest echoes and line-edits (setTty(true)), so focusing the page is enough.
async function typeCommand(page: Page, cmd: string): Promise<void> {
  await page.locator("#screen").click();
  await page.keyboard.type(cmd);
  await page.keyboard.press("Enter");
}

test(
  "shell boots and echoes a typed command",
  { tag: ["@feat:terminal.boot.shell", "@feat:terminal.cli.echo"] },
  async ({ page }) => {
    const mirror = await bootShell(page);
    await typeCommand(page, "echo hello-e2e");
    await expect(mirror).toContainText("hello-e2e");
  },
);

test(
  "a11y mirror reflects the screen",
  { tag: ["@feat:terminal.a11y.mirror"] },
  async ({ page }) => {
    const mirror = await bootShell(page);
    // The mirror is the assistive-tech surface: a read-only multiline textbox.
    await expect(mirror).toHaveAttribute("aria-readonly", "true");
    await expect(mirror).toHaveAttribute("role", "textbox");
    // It must update live as the guest produces output.
    await typeCommand(page, "echo mirror-reflects");
    await expect(mirror).toContainText("mirror-reflects");
  },
);

test(
  "Cmd-K command palette filters and runs",
  { tag: ["@feat:terminal.palette.command"] },
  async ({ page }) => {
    await bootShell(page);
    const overlay = page.locator("#palette-overlay");
    const items = page.locator("#palette-list li");

    // Open with Cmd-K (main.ts intercepts metaKey+k and never forwards it).
    await page.keyboard.press("Meta+k");
    await expect(overlay).toBeVisible();
    const total = await items.count();
    expect(total).toBeGreaterThan(1);

    // Typing filters the list by command title (the three font commands).
    await page.locator("#palette-input").fill("font");
    await expect(items).toHaveCount(3);

    // Narrow to a single safe entry and run it via Enter; the palette closes.
    await page.locator("#palette-input").fill("sidebar");
    await expect(items).toHaveCount(1);
    await expect(items.first()).toContainText("Toggle sidebar");
    await page.locator("#palette-input").press("Enter");
    await expect(overlay).toBeHidden();
  },
);
