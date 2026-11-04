import { spawn } from "node:child_process";

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
  : ["--filter", "@yep-anywhere/server", "test", "test/native-app"];
const child = spawn(process.execPath, [pnpm, ...command, ...args], {
  stdio: "inherit",
  env: { ...process.env, YEP_NATIVE_APP_TESTS: "1" },
});
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
