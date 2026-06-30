// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run

// Generate src/ui-css.generated.ts (the stylesheet as a TS string) from
// src/ui.css. createTerminal injects this string into its shadow root, so the
// CSS travels with the bundle the same way in both builds (Vite standalone and
// the SDK's tsup bundle) — no CSS-loader behaviour to reconcile.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const css = readFileSync(here + "../src/ui.css", "utf8");
const esc = css.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");

const out = `// AUTO-GENERATED from src/ui.css by scripts/gen-ui-css.mjs — do not edit by hand.
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
/* eslint-disable */
const css: string = \`${esc}\`;
export default css;
`;

writeFileSync(here + "../src/ui-css.generated.ts", out);
console.log(`gen-ui-css: wrote src/ui-css.generated.ts (${css.length} bytes)`);
