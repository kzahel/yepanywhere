import { defineConfig } from "@playwright/test";

if (process.env.NO_COLOR) delete process.env.NO_COLOR;

export default defineConfig({
  testDir: "./e2e",
  testMatch: ["artifact-viewer.spec.ts", "project-app.spec.ts"],
  workers: 1,
  timeout: 45000,
  reporter: "list",
  use: { launchOptions: { chromiumSandbox: true } },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
});
