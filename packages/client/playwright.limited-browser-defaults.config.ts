import { defineConfig } from "@playwright/test";
if (process.env.NO_COLOR) delete process.env.NO_COLOR;
export default defineConfig({
  testDir: "./e2e",
  testMatch: "limited-browser-defaults.spec.ts",
  workers: 1,
  timeout: 45_000,
  reporter: "list",
  use: { launchOptions: { chromiumSandbox: true }, browserName: "chromium" },
});
