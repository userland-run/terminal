// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run terminal; dual-licensed - see LICENSE.md.

// Playwright reporter that emits a userland.run results contract (v1) file,
// consumed by the status hub's publish-results action. Feature ids are read
// from each test's Playwright tags of the form `@feat:<id>` (the `@feat:`
// prefix is stripped). See registry/features/terminal.yaml in the status repo
// for the set of valid ids.

import { writeFileSync } from "node:fs";
import { relative } from "node:path";
import type {
  FullConfig,
  FullResult,
  Reporter,
  TestCase,
  TestResult,
} from "@playwright/test/reporter";

type ContractStatus = "passed" | "failed" | "skipped" | "flaky";

interface ResultEntry {
  test_id: string;
  features: string[];
  status: ContractStatus;
  duration_ms: number;
  retries: number;
}

const OUT_FILE = process.env.RESULTS_FILE ?? "userland-results.json";
const FEAT_PREFIX = "@feat:";

function featureIds(test: TestCase): string[] {
  return test.tags
    .filter((t) => t.startsWith(FEAT_PREFIX))
    .map((t) => t.slice(FEAT_PREFIX.length));
}

// Map Playwright's per-run status + the test's overall outcome onto the
// contract's four states. `outcome() === "flaky"` means it failed then passed
// on retry, which the contract reports as "flaky" rather than "passed".
function contractStatus(test: TestCase, result: TestResult): ContractStatus {
  if (test.outcome() === "flaky") return "flaky";
  switch (result.status) {
    case "passed":
      return "passed";
    case "skipped":
      return "skipped";
    case "failed":
    case "timedOut":
    case "interrupted":
    default:
      return "failed";
  }
}

export default class ResultsReporter implements Reporter {
  private readonly entries = new Map<string, ResultEntry>();

  onBegin(_config: FullConfig): void {
    this.entries.clear();
  }

  // Called once per attempt; the last attempt (highest retry) wins, so the
  // stored entry always reflects the final outcome and retry count.
  onTestEnd(test: TestCase, result: TestResult): void {
    const spec = relative(process.cwd(), test.location.file);
    const testId = `${spec}::${test.title}`;
    this.entries.set(testId, {
      test_id: testId,
      features: featureIds(test),
      status: contractStatus(test, result),
      duration_ms: Math.round(result.duration),
      retries: result.retry,
    });
  }

  onEnd(_result: FullResult): void {
    const sha = process.env.GITHUB_SHA ?? "local";
    const doc = {
      contract: 1,
      source: "terminal",
      suite: "playwright-e2e",
      commit: sha.slice(0, 7),
      branch: process.env.GITHUB_REF_NAME ?? "main",
      run_id: process.env.GITHUB_RUN_ID ?? "local",
      finished_at: new Date().toISOString(),
      results: [...this.entries.values()],
    };
    writeFileSync(OUT_FILE, JSON.stringify(doc, null, 2) + "\n");
    console.log(`\n[results-reporter] wrote ${doc.results.length} result(s) → ${OUT_FILE}`);
  }
}
