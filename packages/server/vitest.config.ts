import { defineConfig } from "vitest/config";

const [nodeMajor = 0, nodeMinor = 0] = process.versions.node
  .split(".")
  .map((part) => Number.parseInt(part, 10));
const supportsDisableWarning =
  nodeMajor > 20 || (nodeMajor === 20 && nodeMinor >= 13);
const testExecArgv = supportsDisableWarning
  ? ["--disable-warning=ExperimentalWarning"]
  : [];

export default defineConfig({
  resolve: {
    conditions: ["source"],
  },
  test: {
    exclude: ["node_modules/**", "dist/**"],
    env: {
      // Fail a caller that prepares SQLite statements per call instead of
      // reusing one. Node cannot show that leak (StatementSync has no
      // finalize), while Bun retains every statement until close, so without
      // this the ordinary test path cannot catch it. Not a config.ts knob, so
      // hermetic-env leaves it alone. See packages/shared/src/sqlite.ts.
      YEP_SQLITE_STATEMENT_CEILING: "64",
    },
    // Strip developer-shell config env (e.g. YEP_DEFERRED_JOIN_WINDOW_S) before
    // each file so the suite reproduces identically everywhere. See the setup file.
    setupFiles: ["./test/setup/hermetic-env.ts"],
    passWithNoTests: true,
    maxWorkers: 4,
    // Root-invoked runs group projects by this order, and projects in one
    // group must share maxWorkers; client, shared and relay use other limits.
    sequence: { groupOrder: 2 },
    // node:sqlite (opencode-db-reader, a deliberate zero-native-dependency
    // choice with guarded fallbacks) makes Node print an ExperimentalWarning
    // per worker. Silence it in test output only, so real warnings stay
    // visible; production server logs still show Node's notice. The flag
    // is supported at the Node 22.16 server floor. Keep the acceptance check
    // for alternate runtimes; this test-only setting never affects the server.
    execArgv: testExecArgv,
  },
});
