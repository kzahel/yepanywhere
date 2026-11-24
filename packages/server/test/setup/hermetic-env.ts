/**
 * Make the server test suite reproducible regardless of the developer's shell.
 *
 * `loadConfig()` reads `process.env`, and `run-with-safe-home.js` passes the
 * full environment through to vitest. So a dev who exports a runtime knob for
 * their live server (e.g. `YEP_DEFERRED_JOIN_WINDOW_S=30` in local.sh) silently
 * changes behavior under test — a test can pass on CI (clean env) and fail
 * locally, or vice versa. This is exactly what made the deferred one-per-boundary
 * test non-reproducible.
 *
 * This setup runs before each test file and removes every env var
 * `packages/server/src/config.ts` consults, so config resolves to its built-in
 * defaults. Tests that exercise a specific var still set it explicitly with
 * `vi.stubEnv(...)`, which takes effect after this and is auto-restored.
 *
 * NOT cleared: test-harness gates the test scripts set deliberately
 * (`REAL_SDK_TESTS`, `FOREGROUND`) and `HOME` (safe-home owns it). Keep
 * CONFIG_ENV_VARS in sync with the `process.env.*` reads in config.ts.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import { drainFixtureApps } from "./app-fixture-lifecycle.js";
import { CONFIG_ENV_VARS } from "./config-env-vars.js";

for (const name of CONFIG_ENV_VARS) {
  delete process.env[name];
}
delete process.env.YEP_PROVIDER_MEMORY_LIMIT_MIB;

/**
 * Give every test file its own data and scratch directories.
 *
 * Clearing `YEP_DATA_DIR` is not enough: the default resolves under `HOME`, and
 * the targeted `pnpm --filter @yep-anywhere/server exec vitest run <file>` form
 * documented for focused runs skips the safe-home wrapper. Server construction
 * then reads and writes the developer's live server state, which has been seen
 * failing tests outright when a running server was mid-write.
 */
const root = mkdtempSync(join(tmpdir(), "ya-server-test-"));
process.env.YEP_DATA_DIR = join(root, "data");
process.env.YEP_SCRATCH_DIR = join(root, "scratch");
process.env.COPILOT_SESSIONS_DIR = join(root, "copilot");
// The speech fingerprint filter reserves a quarter gigabyte by default, which
// is right for a machine learning years of history and wrong for every test
// process. The shape under test is the same at a small size.
process.env.YEP_SPEECH_VOCABULARY_BYTES = "1M";
afterAll(async () => {
  await drainFixtureApps();
  rmSync(root, { recursive: true, force: true });
});
