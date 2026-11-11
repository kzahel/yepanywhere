import { defineConfig } from "@playwright/test";
if (process.env.NO_COLOR) delete process.env.NO_COLOR;
export default defineConfig({
  testDir: "./e2e",
  testMatch: "design-audit.spec.ts",
  workers: 1,
  timeout: 30000,
  reporter: "list",
  use: {
    channel: "chrome",
    launchOptions: { chromiumSandbox: true },
    headless: true,
  },
});
