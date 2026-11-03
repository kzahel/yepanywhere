import { defineConfig } from "@playwright/test";

// Explicit credentialed integration run; ordinary CI uses the deterministic
// production-worker test and never launches a real provider.
export default defineConfig({
  testDir: "./e2e",
  testMatch: "provider-host-live.spec.ts",
  timeout: 180_000,
  workers: 1,
  use: {
    launchOptions: { chromiumSandbox: true },
    browserName: "chromium",
    viewport: { width: 1000, height: 600 },
  },
});
