/** Bundle with esbuild for command-driven qualification on clean testbed guests. */
import {
  copyFile,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CliInstallationService } from "../../src/services/CliInstallationService.js";
import {
  codexInstallationAdapter,
  describeCodexCandidate,
} from "../../src/sdk/cli-installation-adapters.js";
import { probeCodexCliVersion } from "../../src/sdk/cli-detection.js";
import { probeCodexExecution } from "../../src/sdk/codex-execution-probe.js";

const binary = await realpath(process.argv[2] ?? "");
const root = await mkdtemp(join(tmpdir(), "ya cli auto smoke-"));
const original = { ...process.env };
try {
  const home = join(root, "home");
  const fnm =
    process.platform === "win32"
      ? join(home, "AppData", "Roaming", "fnm")
      : join(home, ".local", "share", "fnm");
  const nodeVersion = join(fnm, "node-versions", "v24.22.1");
  const prefix = join(nodeVersion, "installation");
  const aliases = join(fnm, "aliases");
  const fallback = join(
    home,
    ".codex",
    ".sandbox-bin",
    process.platform === "win32" ? "codex.exe" : "codex",
  );
  await Promise.all([
    mkdir(dirname(fallback), { recursive: true }),
    mkdir(aliases, { recursive: true }),
    mkdir(join(prefix, "bin"), { recursive: true }),
  ]);
  await copyFile(binary, fallback);
  const shim =
    process.platform === "win32"
      ? join(prefix, "codex.cmd")
      : join(prefix, "bin", "codex");
  await writeFile(
    shim,
    process.platform === "win32"
      ? `@echo off\r\n"${binary}" %*\r\n`
      : `#!/bin/sh\nexec '${binary.replaceAll("'", "'\\''")}' "$@"\n`,
    { mode: 0o755 },
  );
  await symlink(
    nodeVersion,
    join(aliases, "default"),
    process.platform === "win32" ? "junction" : "dir",
  );
  Object.assign(process.env, {
    HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: join(home, "AppData", "Local"),
    APPDATA: join(home, "AppData", "Roaming"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    PATH:
      process.platform === "win32"
        ? `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0`
        : "/usr/bin:/bin:/usr/sbin:/sbin",
  });
  delete process.env.YEP_DESKTOP_CODEX_CLI_PATH;
  delete process.env.FNM_DIR;
  const version = await probeCodexCliVersion(fallback);
  if (!version.ok)
    throw new Error("Incomplete runtime did not pass its version query");
  let rejected = false;
  try {
    await probeCodexExecution(
      describeCodexCandidate(fallback, version.version),
      AbortSignal.timeout(20_000),
    );
  } catch {
    rejected = true;
  }
  if (!rejected)
    throw new Error("Incomplete runtime unexpectedly passed command execution");
  const service = new CliInstallationService(
    join(root, "data"),
    [codexInstallationAdapter],
    () => ({}),
  );
  const inventory = await service.inventory("codex");
  if (!inventory.candidates.some((candidate) => candidate.path.includes("fnm")))
    throw new Error("fnm default absent from automatic inventory");
  const launch = await service.resolve("codex");
  if (!launch.command.includes("fnm"))
    throw new Error("Auto did not choose the configured fnm default");
  const verified = await service.inventory("codex");
  if (
    !verified.candidates.some(
      (candidate) =>
        candidate.selected && candidate.verification === "verified",
    )
  )
    throw new Error("Missing selected verification result");
  console.log(
    JSON.stringify({
      platform: process.platform,
      architecture: process.arch,
      version: version.version,
      incompleteRejected: rejected,
      fnmAbsentFromPath: !process.env.PATH?.includes("fnm"),
      automaticSelectionVerified: true,
    }),
  );
} finally {
  process.env = original;
  await rm(root, { recursive: true, force: true });
}
