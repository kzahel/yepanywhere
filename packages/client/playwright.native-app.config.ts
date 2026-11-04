import { randomUUID } from "node:crypto";
import { defineConfig } from "@playwright/test";

delete process.env.NO_COLOR;
process.env.YEP_NATIVE_APP_RESULTS_DIR ??= `test-results/native-app-${randomUUID()}`;
export default defineConfig({
  testDir: "./e2e",
  testMatch: "native-app-reload.spec.ts",
  outputDir: process.env.YEP_NATIVE_APP_RESULTS_DIR,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  // Six native app/browser runs took 16.3–17.7s per case on macOS arm64;
  // round 3x the observed maximum up to one minute.
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    browserName: "chromium",
    viewport: { width: 1000, height: 600 },
    serviceWorkers: "block",
    trace: "retain-on-failure",
  },
});
