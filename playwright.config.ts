// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run terminal; dual-licensed - see LICENSE.md.

import { defineConfig, devices } from "@playwright/test";

// The terminal needs cross-origin isolation (COOP/COEP) for the SharedArrayBuffer
// NanoVM allocates. `vite preview` sends those headers (see vite.config.ts), so
// we test against the built+previewed app rather than the dev server.
export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  // `list` for humans; the results-reporter emits userland-results.json for the
  // status hub (override the path with RESULTS_FILE).
  reporter: [["list"], ["./tools/results-reporter.ts"]],
  // Booting the RISC-V VM + busybox in-browser is not instant; be generous.
  timeout: 90_000,
  expect: { timeout: 60_000 },
  use: {
    baseURL: "http://localhost:4173",
    trace: "on-first-retry",
  },
  // `npm run build` also pulls in the sibling `../nano/container` via the
  // @container vite alias, so that checkout must exist (CI handles this with a
  // second actions/checkout — see .github/workflows/e2e.yml).
  webServer: {
    command: "npm run build && npm run preview -- --port 4173 --strictPort",
    url: "http://localhost:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
  // The gate: a single headless Chromium project. We assert against the DOM text
  // mirror (<pre aria-label="Terminal screen">), not GPU pixels, so the suite
  // passes even where headless WebGPU is unavailable (main.ts falls back to 2D).
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
