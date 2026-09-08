import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const [expected, packageDir = "dist/npm-package"] = process.argv.slice(2);
assert.ok(
  ["ready", "unsupported"].includes(expected),
  "Pass ready or unsupported",
);
const entry = pathToFileURL(resolve(packageDir, "dist/index.js")).href;
// Windows provider coordination invokes PowerShell and ACL utilities. Keep
// their OS configuration while still isolating application/profile state.
const platformEnvironment = Object.fromEntries(
  [
    "PATH",
    "SystemRoot",
    "SystemDrive",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "USERNAME",
    "USERDOMAIN",
  ]
    .filter((key) => process.env[key] !== undefined)
    .map((key) => [key, process.env[key]]),
);
if (process.platform === "win32") {
  // CI runs under pwsh 7, but YA invokes powershell.exe (Windows PowerShell
  // 5.1). Inheriting pwsh's module path selects incompatible Security modules.
  platformEnvironment.PSModulePath = join(
    process.env.SystemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "Modules",
  );
}
for (const state of [
  "disabled",
  expected,
  ...(expected === "ready" ? ["error"] : []),
]) {
  const temporary = mkdtempSync(join(tmpdir(), "ya-sqlite-startup-"));
  const dataDir = join(temporary, "data");
  const portFile = join(temporary, "port");
  if (state === "error")
    mkdirSync(join(dataDir, "discovery.sqlite"), { recursive: true });
  // A minimal child environment isolates profiles, provider credentials, and
  // operator toggles. Stub outbound fetch so this smoke never contacts updates
  // or providers; parent requests still exercise the real local HTTP server.
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    globalThis.fetch = async () => new Response(null, { status: 503 });
    await import(${JSON.stringify(entry)});
  `,
    ],
    {
      cwd: temporary,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...platformEnvironment,
        TEMP: temporary,
        TMP: temporary,
        HOME: temporary,
        USERPROFILE: temporary,
        APPDATA: join(temporary, "AppData", "Roaming"),
        LOCALAPPDATA: join(temporary, "AppData", "Local"),
        XDG_CONFIG_HOME: join(temporary, "config"),
        XDG_DATA_HOME: join(temporary, "share"),
        NODE_ENV: "production",
        YEP_DATA_DIR: dataDir,
        YEP_SQLITE: state === "disabled" ? "off" : "auto",
        // This uses the mock Claude provider. An explicit absent Codex path
        // avoids unrelated global npm/CLI discovery during startup on Windows.
        YEP_DESKTOP_CODEX_CLI_PATH: join(temporary, "codex-not-installed"),
        AUTH_DISABLED: "true",
        USE_MOCK_SDK: "true",
        ENABLED_PROVIDERS: "claude",
        VOICE_INPUT: "false",
        SERVE_FRONTEND: "false",
        HOST: "127.0.0.1",
        PORT: "0",
        PORT_FILE: portFile,
        MAINTENANCE_PORT: "0",
        OPEN_BROWSER: "false",
      },
    },
  );
  let output = "";
  let exited = false;
  let spawnError;
  const completion = new Promise((resolveExit) => {
    child.once("exit", () => {
      exited = true;
      resolveExit();
    });
    child.once("error", (error) => {
      spawnError = error;
      exited = true;
      resolveExit();
    });
  });
  const collect = (chunk) => {
    output = (output + chunk).slice(-8000);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  try {
    // Cold PowerShell processes used by existing provider ACL checks can make
    // full Windows startup substantially slower than the SQLite initialization.
    const deadline =
      Date.now() + (process.platform === "win32" ? 120_000 : 30_000);
    while (!existsSync(portFile) && !exited && Date.now() < deadline)
      await delay(50);
    assert.ok(
      !exited && existsSync(portFile),
      `Server failed to start: ${spawnError ?? ""}\n${output}`,
    );
    const port = Number(readFileSync(portFile, "utf8"));
    const response = await fetch(`http://127.0.0.1:${port}/api/version`, {
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(response.status, 200, output);
    assert.deepEqual((await response.json()).sqlite, { state });
    if (state === "disabled" || state === "unsupported") {
      assert.equal(existsSync(join(dataDir, "discovery.sqlite")), false);
    }
    console.log(
      `SQLite server startup passed (${process.versions.bun ? "Bun" : "Node"}, ${state})`,
    );
  } finally {
    if (!exited) child.kill("SIGTERM");
    const killTimer = setTimeout(() => {
      if (!exited) child.kill("SIGKILL");
    }, 10_000);
    await completion;
    clearTimeout(killTimer);
    rmSync(temporary, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    });
  }
}
