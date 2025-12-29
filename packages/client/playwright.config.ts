import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false, // Run sequentially - we're hitting one server
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: "list",
  timeout: 15000, // 15s per test
  expect: {
    timeout: 5000, // 5s for assertions
  },
  use: {
    baseURL: "http://localhost:5173",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    actionTimeout: 5000, // 5s for actions like click
  },
  webServer: [
    {
      command: "pnpm --filter @claude-anywhere/server dev:mock",
      port: 3400,
      reuseExistingServer: !process.env.CI,
    },
    {
      command: "pnpm --filter @claude-anywhere/client dev",
      port: 5173,
      reuseExistingServer: !process.env.CI,
    },
  ],
});
