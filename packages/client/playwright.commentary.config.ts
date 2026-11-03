import { defineConfig } from "@playwright/test";

if (process.env.NO_COLOR) delete process.env.NO_COLOR;

export default defineConfig({
  testDir: "./e2e",
  testMatch: "acli-commentary.spec.ts",
  outputDir: "../../.artifacts/acli-browser-results",
  workers: 1,
  timeout: 60000,
  reporter: "list",
  use: {
    browserName: "chromium",
    launchOptions: { chromiumSandbox: true },
    locale: "en-US",
    contextOptions: { reducedMotion: "reduce" },
  },
});
