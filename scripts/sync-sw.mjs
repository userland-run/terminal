// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run

// Copy the serve-bridge service worker from the sibling SDK checkout into
// public/nano-sw.js. The SDK is the file's only source of truth, so it is NOT
// checked in here (.gitignore) — a build must have either the sibling ../sdk or
// a previously synced copy. Fail loudly when neither exists instead of shipping
// a bundle whose Preview tab 404s on its service worker.

import { copyFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const src = here + "../../sdk/static/nano-sw.js";
const dst = here + "../public/nano-sw.js";

if (existsSync(src)) {
  copyFileSync(src, dst);
  console.log("sync-sw: nano-sw.js synced from ../sdk/static");
} else if (existsSync(dst)) {
  console.warn("sync-sw: sibling ../sdk absent — using the previously synced public/nano-sw.js (may be stale)");
} else {
  console.error(
    "sync-sw: ERROR — public/nano-sw.js is missing and ../sdk/static/nano-sw.js was not found.\n" +
      "  Check out the SDK next to this repo (../sdk), or copy its static/nano-sw.js to public/.",
  );
  process.exit(1);
}
