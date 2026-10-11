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
  // Surface boot failures: NanoVM.create() allocates a shared WebAssembly.Memory,
  // which needs cross-origin isolation. If that rejects, #stat-status stays
  // "booting"; log the cause and the isolation state so CI failures are legible.
  page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") console.log(`[console.error] ${m.text()}`);
  });
  await page.addInitScript(() => {
    addEventListener("unhandledrejection", (e) =>
      console.error(`[unhandledrejection] ${(e.reason && e.reason.message) || String(e.reason)}`),
    );
  });

  await page.goto("/");
  const env = await page.evaluate(() => ({
    isolated: crossOriginIsolated,
    sab: typeof SharedArrayBuffer,
  }));
  console.log(`[boot] crossOriginIsolated=${env.isolated} SharedArrayBuffer=${env.sab}`);

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
  "a11y mirror lives inside the terminal's shadow root and is removed on dispose",
  { tag: ["@feat:terminal.a11y.mirror"] },
  async ({ page }) => {
    await bootShell(page);
    const placement = await page.evaluate(() => {
      const host = document.querySelector("nano-terminal")!;
      (window as unknown as { __term: Element }).__term = host;
      return {
        // document.querySelector does not pierce shadow roots: the mirror must
        // not leak into the page's light DOM (e.g. appended to <body>).
        inLight: document.querySelectorAll('pre[aria-label="Terminal screen"], [role="log"][aria-live]').length,
        inShadow: host.shadowRoot!.querySelectorAll('pre[aria-label="Terminal screen"], [role="log"][aria-live]').length,
      };
    });
    expect(placement).toEqual({ inLight: 0, inShadow: 2 });

    // Removing the element disposes the instance; the mirror goes with it.
    await page.evaluate(() => document.querySelector("nano-terminal")!.remove());
    await expect
      .poll(() =>
        page.evaluate(() => {
          const host = (window as unknown as { __term: Element }).__term;
          return (
            host.shadowRoot!.querySelectorAll('pre[aria-label="Terminal screen"], [role="log"][aria-live]').length +
            document.querySelectorAll('pre[aria-label="Terminal screen"], [role="log"][aria-live]').length
          );
        }),
      )
      .toBe(0);
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
    // Keyboard input is scoped to the focused terminal (an embedded element must
    // not capture the host page's keys), so focus it first.
    await page.locator("#screen").click();
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

test(
  "Map local folder mounts at /work and Save to folder writes every change back",
  { tag: ["@feat:terminal.files.localfs"] },
  async ({ page }) => {
    // Stand in for the user's picked folder with an OPFS directory (Chromium
    // supports createWritable on it, and it reports readwrite as granted).
    await page.addInitScript(() => {
      (window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker =
        async () => {
          const root = await navigator.storage.getDirectory();
          await root.removeEntry("proj", { recursive: true }).catch(() => {});
          const dir = await root.getDirectoryHandle("proj", { create: true });
          const put = async (d: FileSystemDirectoryHandle, name: string, text: string) => {
            const w = await (await d.getFileHandle(name, { create: true })).createWritable();
            await w.write(text);
            await w.close();
          };
          await put(dir, "a.txt", "original\n");
          await put(dir, "keep.txt", "keep\n");
          await put(await dir.getDirectoryHandle("sub", { create: true }), "s.txt", "s\n");
          return dir;
        };
    });
    const mirror = await bootShell(page);
    await page.locator('.activity-btn[data-view="files"]').click();
    await page.getByRole("button", { name: "Map local folder…" }).click();
    const save = page.getByRole("button", { name: "Save to folder" });
    await expect(save).toBeVisible();

    await typeCommand(
      page,
      "cd /work/proj 2>/dev/null || cd /work; cat sub/s.txt >/dev/null && echo edited > a.txt && echo fresh > sub/new.txt && rm keep.txt && echo MAP-$((40+2))",
    );
    await expect(mirror).toContainText("MAP-42");
    await save.click();

    const readBack = () =>
      page.evaluate(async () => {
        const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("proj");
        const text = async (d: FileSystemDirectoryHandle, n: string) =>
          d.getFileHandle(n).then((h) => h.getFile()).then((f) => f.text(), () => null);
        const sub = await dir.getDirectoryHandle("sub");
        return {
          a: await text(dir, "a.txt"),
          keep: await text(dir, "keep.txt"),
          s: await text(sub, "s.txt"),
          n: await text(sub, "new.txt"),
        };
      });
    // Changed and new files are written; a file deleted in the VM stays on disk.
    await expect.poll(readBack).toEqual({ a: "edited\n", keep: "keep\n", s: "s\n", n: "fresh\n" });
  },
);
