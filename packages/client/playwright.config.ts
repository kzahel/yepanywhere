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
  retries: 0,
  // Mutable services are worker-owned. Four workers ran the full suite in
  // 7.6 minutes on a 14-core Mac, against about an hour serially; CI passes
  // its own count per shard.
  workers: 4,
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
    // Keep the failing attempt's action timeline. DOM snapshots inject a
    // script into sandboxed export frames and change their console output.
    trace: { mode: "retain-on-failure", snapshots: false, screenshots: false },
    screenshot: "only-on-failure",
    actionTimeout: 5000,
  },
});
