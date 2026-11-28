import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    conditions: ["source"],
  },
  test: {
    environment: "jsdom",
    globals: true,
    exclude: ["e2e/**", "node_modules/**"],
    passWithNoTests: true,
    setupFiles: ["./vitest.setup.ts"],
    maxWorkers: 3,
    // Root-invoked runs group projects by this order, and projects in one
    // group must share maxWorkers; the server sets a different limit.
    sequence: { groupOrder: 1 },
    // Vitest 3+ fakes every timer API by default, including
    // requestAnimationFrame and performance.now. Work that module-level
    // schedulers queue on those under fake timers never runs after a test
    // restores real ones, which leaks into later tests. Keep Vitest 2's set.
    fakeTimers: {
      toFake: [
        "setTimeout",
        "clearTimeout",
        "setImmediate",
        "clearImmediate",
        "setInterval",
        "clearInterval",
        "Date",
      ],
    },
  },
});
