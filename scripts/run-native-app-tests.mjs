import { spawn } from "node:child_process";
import {
  readHostCapacity,
  readHostSample,
  summarizeHostWindow,
} from "./perf-suite/host-profile.mjs";

if (!["linux", "darwin"].includes(process.platform) || process.versions.bun)
  throw Error(
    "Native app reload qualification requires the supported POSIX Node provider host",
  );
const pnpm = process.env.npm_execpath;
if (!pnpm) throw Error("Invoke through pnpm test:providers:app");
const args = process.argv.slice(2);
const browser = args[0] === "--browser";
if (browser) args.shift();
const command = browser
  ? [
      "--filter",
      "@yep-anywhere/client",
      "exec",
      "playwright",
      "test",
      "--config",
      "playwright.native-app.config.ts",
    ]
  : [
      "--filter",
      "@yep-anywhere/server",
      "test",
      "test/native-app",
      // Agent/minimal reporters otherwise withhold successful-case evidence.
      "--reporter=default",
      ...(process.env.GITHUB_ACTIONS === "true"
        ? ["--reporter=github-actions"]
        : []),
      "--silent=false",
    ];
const capacity = await readHostCapacity();
const start = await readHostSample(capacity);
console.info(JSON.stringify({ nativeAppHost: { capacity, start } }));
try {
  process.exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [pnpm, ...command, ...args], {
      stdio: "inherit",
      env: { ...process.env, YEP_NATIVE_APP_TESTS: "1" },
    });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
} finally {
  const end = await readHostSample(capacity);
  console.info(
    JSON.stringify({
      nativeAppHost: {
        capacityKey: capacity.capacityKey,
        end,
        summary: summarizeHostWindow(capacity, start, end),
      },
    }),
  );
}
