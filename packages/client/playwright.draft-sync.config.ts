import { defineConfig } from "@playwright/test";
if (process.env.NO_COLOR) delete process.env.NO_COLOR;
export default defineConfig({
  testDir: "./e2e",
  testMatch: ["draft-sync.spec.ts", "rendez-composer.spec.ts"],
  workers: 1,
  // Handoff includes real 3s debounce intervals; measured 16s locally.
  timeout: 60000,
  reporter: "list",
  use: { launchOptions: { chromiumSandbox: true }, headless: true },
});
