import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const configDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@yep-anywhere/shared": resolve(configDir, "../shared/src/index.ts"),
    },
    conditions: ["source"],
  },
  test: {
    environment: "jsdom",
    globals: true,
    exclude: ["e2e/**", "node_modules/**"],
    passWithNoTests: true,
    maxWorkers: 3,
    minWorkers: 1,
  },
});
