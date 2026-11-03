import { defineConfig } from "@playwright/test";
if (process.env.NO_COLOR) delete process.env.NO_COLOR;
export default defineConfig({
  testDir: "./e2e",
  testMatch: "router-pools.spec.ts",
  workers: 1,
  // The focused cold run takes about 5s including Vite startup.
  timeout: 15_000,
  reporter: "list",
  use: {
    launchOptions: { chromiumSandbox: true },
    browserName: "chromium",
    serviceWorkers: "block",
  },
});
