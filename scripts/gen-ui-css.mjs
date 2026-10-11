// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run

// Generate src/ui-css.generated.ts (the stylesheet as a TS string) from
// src/ui.css. createTerminal injects this string into its shadow root, so the
// CSS travels with the bundle the same way in both builds (Vite standalone and
// the SDK's tsup bundle) — no CSS-loader behaviour to reconcile.

//
// The generated file IS checked in: the SDK's tsup build bundles this repo's
// src/ directly (without running our scripts), so it must be present and current
// in git. `npm run build`/`dev` regenerate it; `--check` (npm run check:css, run
// by `npm test`) fails if the committed copy has drifted from ui.css.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
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

const target = here + "../src/ui-css.generated.ts";

if (process.argv.includes("--check")) {
  const current = existsSync(target) ? readFileSync(target, "utf8") : "";
  if (current !== out) {
    console.error("gen-ui-css: src/ui-css.generated.ts is out of date with src/ui.css — run `npm run gen:css` and commit it.");
    process.exit(1);
  }
  console.log("gen-ui-css: src/ui-css.generated.ts is up to date");
} else {
  writeFileSync(target, out);
  console.log(`gen-ui-css: wrote src/ui-css.generated.ts (${css.length} bytes)`);
}
