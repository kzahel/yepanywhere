import { randomUUID } from "node:crypto";
import { defineConfig } from "@playwright/test";
if (process.env.NO_COLOR) delete process.env.NO_COLOR;
export default defineConfig({
  testDir: "./e2e",
  testMatch: "computer-control.spec.ts",
  outputDir: `../../.artifacts/computer-control-results/${randomUUID()}`,
  globalTeardown: "./e2e/global-teardown.ts",
  workers: 1,
  reporter: "list",
  use: { browserName: "chromium", locale: "en-US", trace: "retain-on-failure" },
});
