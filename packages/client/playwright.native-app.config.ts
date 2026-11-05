import { randomUUID } from "node:crypto";
import { defineConfig } from "@playwright/test";

delete process.env.NO_COLOR;
process.env.YEP_NATIVE_APP_RESULTS_DIR ??= `test-results/native-app-${randomUUID()}`;
export default defineConfig({
  testDir: "./e2e",
  testMatch: ["native-app-reload.spec.ts", "native-input-identity.spec.ts"],
  outputDir: process.env.YEP_NATIVE_APP_RESULTS_DIR,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  // Hosted run 42047227082 reaches 43.829s through fixture cleanup on Linux
  // (macOS max 39.085s), before the added command. 120s is 2.74x that maximum;
  // requalify the extended case hosted. Input stays <100ms.
  timeout: 120_000,
  expect: { timeout: 15_000 },
  use: {
    launchOptions: { chromiumSandbox: true },
    browserName: "chromium",
    viewport: { width: 1000, height: 600 },
    serviceWorkers: "block",
    trace: "retain-on-failure",
  },
});
