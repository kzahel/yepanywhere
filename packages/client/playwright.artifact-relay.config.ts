import { defineConfig } from "@playwright/test";

if (process.env.NO_COLOR) delete process.env.NO_COLOR;

export default defineConfig({
  testDir: "./e2e",
  testMatch: "artifact-relay.spec.ts",
  outputDir: "../../.artifacts/artifact-relay-results",
  workers: 1,
  timeout: 60000,
  reporter: "list",
  use: {
    browserName: "chromium",
    launchOptions: { chromiumSandbox: true },
    actionTimeout: 10000,
    screenshot: "only-on-failure",
    // The test's private HTTPS gateway uses a disposable self-signed certificate.
    ignoreHTTPSErrors: true,
  },
});
