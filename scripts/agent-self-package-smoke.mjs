import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { removeFixtureDirectory } from "./remove-fixture-directory.mjs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argument = (name) =>
  process.argv
    .find((arg) => arg.startsWith(`${name}=`))
    ?.slice(name.length + 1);
const release = process.argv.includes("--release");
const productionStartup =
  release || process.argv.includes("--production-startup");
const artifactDir = argument("--artifact-dir")
  ? resolve(argument("--artifact-dir"))
  : undefined;
if (artifactDir) {
  mkdirSync(artifactDir, { recursive: true });
  // A failed rerun must never leave a previous successful acceptance receipt.
  for (const name of ["acceptance.json", "failure.log", "server.log"])
    rmSync(join(artifactDir, name), { force: true });
}
const directory = mkdtempSync(join(tmpdir(), "ya-agent installed package "));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const options = {
  cwd: directory,
  // Package-manager environment settings are not portable npm configuration.
  env: Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^(npm_config_|pnpm_)/i.test(key),
    ),
  ),
  encoding: "utf8",
  shell: process.platform === "win32",
};
let receipt;
try {
  let tarball = argument("--tarball");
  if (tarball) tarball = resolve(tarball);
  else {
    cpSync(resolve(root, "dist/npm-package"), join(directory, "package"), {
      recursive: true,
      filter: (source) => !source.split(/[\\/]/).includes("node_modules"),
    });
    const packed = JSON.parse(
      execFileSync(
        npm,
        ["pack", "./package", "--json", "--ignore-scripts"],
        options,
      ),
    );
    tarball = join(directory, packed[0].filename);
  }
  // Retain exactly the bytes being installed; publishing must use this archive.
  if (artifactDir) {
    const candidate = join(artifactDir, "candidate.tgz");
    if (tarball !== candidate) cpSync(tarball, candidate);
    tarball = candidate;
  }
  const sha256 = createHash("sha256")
    .update(readFileSync(tarball))
    .digest("hex");
  // npm.cmd runs through the Windows shell. Keep its argument relative and
  // space-free even when the owned directory or supplied archive has spaces.
  const installTarball = join(directory, "candidate.tgz");
  cpSync(tarball, installTarball);
  assert.equal(
    createHash("sha256").update(readFileSync(installTarball)).digest("hex"),
    sha256,
  );
  execFileSync(
    npm,
    [
      "install",
      "--ignore-scripts",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      "candidate.tgz",
    ],
    { ...options, stdio: "inherit" },
  );
  const installed = join(directory, "node_modules", "yepanywhere");
  const manifest = JSON.parse(
    readFileSync(join(installed, "package.json"), "utf8"),
  );
  const expectedVersion = argument("--expected-version") ?? manifest.version;
  assert.equal(manifest.name, "yepanywhere");
  assert.equal(manifest.version, expectedVersion);
  let acceptance;
  if (productionStartup) {
    const report = join(directory, "production-acceptance.json");
    try {
      execFileSync(
        process.execPath,
        [
          "--import",
          import.meta.resolve("tsx"),
          "--conditions=source",
          join(root, "packages/server/test/native-provider/package-smoke.ts"),
          installed,
          expectedVersion,
          `--report=${report}`,
          ...(release ? [] : ["--startup-only"]),
        ],
        { stdio: "inherit", env: options.env },
      );
      acceptance = JSON.parse(readFileSync(report, "utf8"));
      if (artifactDir) cpSync(`${report}.log`, join(artifactDir, "server.log"));
    } catch (error) {
      if (artifactDir && existsSync(`${report}.failure.log`))
        cpSync(`${report}.failure.log`, join(artifactDir, "failure.log"));
      throw error;
    }
  }
  // Historical artifacts can be checked for production startup independently
  // of newer agent-self APIs they never shipped.
  if (!productionStartup || release) {
    execFileSync(
      process.execPath,
      [join(root, "scripts/agent-self-smoke.mjs"), installed],
      { stdio: "inherit", timeout: 30000 },
    );
  }
  if (process.argv.includes("--startup")) {
    for (const [script, args] of [
      ["test-runtime-preflight.mjs", [installed]],
      ["test-sqlite-startup.mjs", ["ready", installed]],
    ]) {
      execFileSync(process.execPath, [join(root, "scripts", script), ...args], {
        stdio: "inherit",
        timeout: 180000,
        env: options.env,
      });
    }
  }
  const bunRuntime = process.argv
    .find((arg) => arg.startsWith("--bun-runtime="))
    ?.slice("--bun-runtime=".length);
  if (bunRuntime) {
    execFileSync(
      resolve(bunRuntime),
      [join(root, "scripts/agent-self-smoke.mjs"), installed],
      {
        stdio: "inherit",
        timeout: 30000,
        env: options.env,
      },
    );
    execFileSync(
      resolve(bunRuntime),
      [join(root, "scripts/test-runtime-renderer.mjs"), installed],
      {
        stdio: "inherit",
        timeout: 30000,
        env: options.env,
      },
    );
    execFileSync(
      resolve(bunRuntime),
      [
        join(root, "scripts/test-sqlite-startup.mjs"),
        "ready",
        installed,
        "bunx",
      ],
      {
        stdio: "inherit",
        timeout: 180000,
        // On Unix, prove the forced Bun executable does not rely on a PATH Node.
        env: {
          ...options.env,
          ...(process.platform === "win32" ? {} : { PATH: "/usr/bin:/bin" }),
        },
      },
    );
  }
  assert.equal(
    createHash("sha256").update(readFileSync(tarball)).digest("hex"),
    sha256,
    "Candidate archive changed during acceptance",
  );
  if (artifactDir && acceptance) {
    receipt = {
      name: manifest.name,
      ...acceptance,
      platform: process.platform,
      arch: process.arch,
      sourceRevision: process.env.GITHUB_SHA,
      sha256,
      tarball: "candidate.tgz",
      release,
    };
  }
} finally {
  await removeFixtureDirectory(directory);
}
if (receipt) {
  writeFileSync(
    join(artifactDir, "acceptance.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
  console.log(
    `Accepted ${receipt.name}@${receipt.version}, SHA-256 ${receipt.sha256}`,
  );
}
