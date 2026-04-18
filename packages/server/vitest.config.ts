import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const configDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@yep-anywhere/shared": resolve(configDir, "../shared/src/index.ts"),
    },
    conditions: ["source"],
  },
  test: {
    exclude: ["node_modules/**", "dist/**"],
    passWithNoTests: true,
    maxWorkers: 4,
    minWorkers: 1,
  },
});
