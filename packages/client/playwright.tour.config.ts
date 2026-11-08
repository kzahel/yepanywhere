/**
 * The on-demand screen tour (plan 182; e2e/tour/screen-tour.tour.ts). It
 * reuses the E2E suite's isolated server and fixture profile, and is never
 * part of `playwright test` with the default config or CI.
 */
import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

export default defineConfig({
  ...base,
  testDir: "./e2e/tour",
  testMatch: "**/*.tour.ts",
  testIgnore: [],
  retries: 0,
});
