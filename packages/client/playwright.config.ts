import { randomUUID } from "node:crypto";
import { defineConfig } from "@playwright/test";

// Playwright forces color for its worker output after loading this config. Do
// not pass the contradictory NO_COLOR setting into those workers, which makes
// Node warn before tests run.
if (process.env.NO_COLOR) {
  delete process.env.NO_COLOR;
}

process.env.YEP_E2E_RESULTS_DIR ??= `test-results/${randomUUID()}`;
const outputDir = process.env.YEP_E2E_RESULTS_DIR;

export default defineConfig({
  testDir: "./e2e",
  // Real native app qualification has its own configuration and cost budget.
  testIgnore: [
    "**/native-app-reload.spec.ts",
    "**/native-input-identity.spec.ts",
  ],
  outputDir,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: "list",
  timeout: 15000,
  expect: {
    timeout: 5000,
  },
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  use: {
    launchOptions: { chromiumSandbox: true },
    // baseURL provided by fixtures.ts (reads port from global-setup)
    // Not `retain-on-failure`, which records every test and whose injected
    // recorder script is blocked in a sandboxed `srcdoc` frame — the mockup
    // export spec counts that as a console problem and fails. CI retries
    // twice, so a failure there still produces a trace, which is what carries
    // the requests, responses and DOM snapshots a screenshot cannot. A local
    // failure has no retry: rerun the spec with `--trace on` to get one.
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    actionTimeout: 5000,
  },
});
