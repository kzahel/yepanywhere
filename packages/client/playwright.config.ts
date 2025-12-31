import { defineConfig } from "@playwright/test";

// Port configuration for unified server architecture:
// - E2E_SERVER_PORT: Backend server port (default: 3401, different from dev's 3400)
// - E2E_VITE_PORT: Vite dev server port (default: 5174, different from dev's 5555)
// - E2E_REUSE_DEV: Set to "true" to run against existing dev server on port 3400
//   (skips starting mock server - tests run against real Claude SDK)
const reuseDevServer = process.env.E2E_REUSE_DEV === "true";
// When reusing dev server, use dev's port 3400; otherwise use isolated ports
const serverPort = Number.parseInt(
  process.env.E2E_SERVER_PORT || (reuseDevServer ? "3400" : "3401"),
);
const vitePort = Number.parseInt(process.env.E2E_VITE_PORT || "5174");

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
    // Access through the backend port (unified server)
    baseURL: `http://localhost:${serverPort}`,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    actionTimeout: 5000, // 5s for actions like click
  },
  webServer: reuseDevServer
    ? [] // When reusing dev server, don't start any servers
    : [
        // Start Vite first (backend will proxy to it)
        {
          command: `pnpm --filter @claude-anywhere/client dev --port ${vitePort}`,
          port: vitePort,
          reuseExistingServer: !process.env.CI,
        },
        // Start backend mock server (serves API + proxies to Vite)
        {
          command: `PORT=${serverPort} VITE_PORT=${vitePort} pnpm --filter @claude-anywhere/server dev:mock`,
          port: serverPort,
          reuseExistingServer: !process.env.CI,
        },
      ],
});
