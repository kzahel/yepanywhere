import { defineConfig } from "vitest/config";

// Without a config here, vitest would find the repository root config and
// run its multi-project setup from this package. tsc emits compiled test
// copies into dist/, which vitest 4 no longer excludes by default.
export default defineConfig({
  test: {
    exclude: ["node_modules/**", "dist/**"],
  },
});
