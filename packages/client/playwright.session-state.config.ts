import { randomUUID } from "node:crypto";
import { defineConfig } from "@playwright/test";

if (process.env.NO_COLOR) delete process.env.NO_COLOR;

// These tests own their backend and Vite instances; no global provider corpus
// or relay setup is needed to exercise session state in a real browser.
export default defineConfig({
  testDir: "./e2e",
  testMatch: "session-read-state.spec.ts",
  outputDir: `../../.artifacts/session-state-results/${randomUUID()}`,
  globalTeardown: "./e2e/global-teardown.ts",
  workers: 1,
  reporter: "list",
  use: { browserName: "chromium", locale: "en-US", trace: "retain-on-failure" },
});
