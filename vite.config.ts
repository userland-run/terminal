// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run terminal; dual-licensed - see LICENSE.md.

import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const workspaceRoot = fileURLToPath(new URL("..", import.meta.url));

// COOP/COEP enable cross-origin isolation, required for the SharedArrayBuffer
// that NanoVM allocates. `credentialless` lets cross-origin assets (e.g. the
// JetBrains Mono webfont) load without needing CORP headers.
export default defineConfig({
  resolve: {
    // The browser NanoVM module lives in the sibling `nano/` repo; the catalog
    // client (Catalog/installer) comes from the built SDK bundle.
    alias: {
      "@container": fileURLToPath(new URL("../nano/runners/riscv/host", import.meta.url)),
      "@sdk": fileURLToPath(new URL("../sdk/dist/index.js", import.meta.url)),
    },
  },
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "credentialless",
    },
    // Allow Vite to serve the cross-repo @container files.
    fs: { allow: [here, workspaceRoot] },
  },
  preview: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "credentialless",
    },
  },
});
