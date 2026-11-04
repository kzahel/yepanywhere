import { spawn } from "node:child_process";

// Run the same selected suite on POSIX and Windows without shell env syntax.
const pnpm = process.env.npm_execpath;
if (!pnpm) throw Error("Invoke through pnpm test:providers:all");
const child = spawn(
  process.execPath,
  [pnpm, "test:providers", ...process.argv.slice(2)],
  {
    stdio: "inherit",
    env: { ...process.env, YEP_NATIVE_TEST_PROVIDERS: "all" },
  },
);
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
