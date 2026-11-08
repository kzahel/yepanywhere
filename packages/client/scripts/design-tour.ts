// acli: 1 +commentary
/**
 * Run the on-demand screen tour (plan 182): the main screens in dark and
 * light at 1000×600 and 375×812, against the E2E suite's isolated server and
 * fixture profile, presented through the capture helper by the suite's
 * global teardown.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { clientRoot } from "./design-index";

const help = `Usage: pnpm -s design:tour [--label <name>] [--grep <pattern>]

Capture the main screens (projects, a session, new session, file viewer,
source control and every settings section) in dark and light at desktop
and phone sizes, against a fresh isolated E2E server with fixture data.

  --label <name>    Output directory name under .artifacts/design-tour/,
                    for example before or after (default: a timestamp)
  --grep <pattern>  Only screens whose name matches, for example settings
  -h, --help        Show this help

The run builds the client and server first, so expect a few minutes.`;

const { values } = parseArgs({
  options: {
    label: { type: "string" },
    grep: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});
if (values.help) {
  console.log(help);
  process.exit(0);
}

const label =
  values.label ?? new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15);
if (!/^[\w.-]+$/.test(label)) {
  console.error(
    JSON.stringify({ error: "--label may use letters, digits, . _ - only" }),
  );
  process.exit(2);
}
const out = resolve(clientRoot, "..", "..", ".artifacts", "design-tour", label);
if (existsSync(out)) {
  console.error(JSON.stringify({ error: `${out} already exists` }));
  process.exit(2);
}

const result = spawnSync(
  "pnpm",
  [
    "exec",
    "playwright",
    "test",
    "--config",
    join(clientRoot, "playwright.tour.config.ts"),
    ...(values.grep ? ["--grep", values.grep] : []),
  ],
  {
    cwd: clientRoot,
    stdio: "inherit",
    // pnpm is a .cmd shim on Windows, which spawn cannot run directly.
    shell: process.platform === "win32",
    env: {
      ...process.env,
      YEP_E2E_UI_CAPTURE_DIR: out,
      YEP_E2E_START_RELAY: "0",
    },
  },
);
if (result.error) {
  console.error(JSON.stringify({ error: String(result.error) }));
}
process.exit(result.status === 0 ? 0 : 3);
