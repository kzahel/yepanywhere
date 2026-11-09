import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  compareCodexCliVersions,
  detectCodexCli,
  findCodexCliPath,
  getCodexCommonPaths,
  getCodexCliVersion,
  isCodexCliAuthenticated,
  normalizeCodexCliVersion,
  parseCommandLookupOutput,
  probeCodexCliVersion,
  selectCommandLookupTarget,
} from "../../src/sdk/cli-detection.js";

const tempDirs: string[] = [];
const originalPath = process.env.PATH;

afterEach(() => {
  process.env.PATH = originalPath;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createFakeCodex(dir: string, version: string): string {
  if (process.platform === "win32") {
    const path = join(dir, "codex.cmd");
    writeFileSync(path, `@echo off\r\necho codex-cli ${version}\r\n`, "utf-8");
    return path;
  }

  const path = join(dir, "codex");
  writeFileSync(path, `#!/bin/sh\necho codex-cli ${version}\n`, "utf-8");
  chmodSync(path, 0o755);
  return path;
}

function prependPath(...dirs: string[]): void {
  process.env.PATH = [dirs.join(delimiter), originalPath ?? ""]
    .filter(Boolean)
    .join(delimiter);
}

describe("command lookup output", () => {
  it("parses ordered CRLF candidates and ignores blank lines", () => {
    expect(
      parseCommandLookupOutput("  C:\\npm\\pi  \r\nC:\\npm\\pi.cmd\r\n\r\n"),
    ).toEqual(["C:\\npm\\pi", "C:\\npm\\pi.cmd"]);
  });

  it("also accepts ordinary LF-delimited which output", () => {
    expect(
      parseCommandLookupOutput("/opt/homebrew/bin/pi\n/usr/local/bin/pi\n"),
    ).toEqual(["/opt/homebrew/bin/pi", "/usr/local/bin/pi"]);
  });

  it("selects a Windows command shim only for shell-owned launches", () => {
    const output = "C:\\npm\\gemini\r\nC:\\npm\\gemini.cmd\r\n";
    const exists = () => true;

    expect(selectCommandLookupTarget(output, "shell", "win32", exists)).toBe(
      "C:\\npm\\gemini.cmd",
    );
    expect(
      selectCommandLookupTarget(output, "direct", "win32", exists),
    ).toBeNull();
  });

  it("selects a native Windows executable for shell-free launches", () => {
    const output =
      "C:\\npm\\grok\r\nC:\\npm\\grok.cmd\r\nC:\\bin\\grok.exe\r\n";

    expect(
      selectCommandLookupTarget(output, "direct", "win32", () => true),
    ).toBe("C:\\bin\\grok.exe");
  });

  it("keeps the first existing POSIX candidate for either launch mode", () => {
    const output = "/stale/gemini\n/usr/local/bin/gemini\n";
    const exists = (path: string) => path.startsWith("/usr/local");

    expect(selectCommandLookupTarget(output, "shell", "linux", exists)).toBe(
      "/usr/local/bin/gemini",
    );
  });
});

describe("Codex CLI detection", () => {
  it("includes current and legacy macOS desktop app executables", () => {
    expect(
      getCodexCommonPaths({
        platform: "darwin",
        homeDir: "/Users/test",
      }),
    ).toEqual(
      expect.arrayContaining([
        "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
        "/Users/test/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
        "/Applications/ChatGPT.app/Contents/Resources/codex",
        "/Users/test/Applications/ChatGPT.app/Contents/Resources/codex",
        "/Applications/Codex.app/Contents/Resources/codex",
        "/Users/test/Applications/Codex.app/Contents/Resources/codex",
      ]),
    );
  });

  it("normalizes and compares Codex CLI semver output", () => {
    expect(normalizeCodexCliVersion("codex-cli 0.144.1")).toBe("0.144.1");
    expect(normalizeCodexCliVersion("v0.144.1-beta.1")).toBe("0.144.1-beta.1");
    expect(normalizeCodexCliVersion("no version")).toBeNull();

    expect(compareCodexCliVersions("0.144.1", "0.142.0")).toBeGreaterThan(0);
    expect(compareCodexCliVersions("0.144.1-beta.1", "0.144.1")).toBeLessThan(
      0,
    );
  });

  it("probes the version of a runnable codex candidate", async () => {
    const dir = makeTempDir("codex-version-");
    const codexPath = createFakeCodex(dir, "99.5.0");

    await expect(getCodexCliVersion(codexPath)).resolves.toBe(
      "codex-cli 99.5.0",
    );
  });

  it("keeps runtime and authentication probes separate", async () => {
    const dir = makeTempDir("codex-auth-");
    const authenticated = createFakeCodex(dir, "99.5.0");
    const loggedOut = join(
      dir,
      process.platform === "win32" ? "logged-out.cmd" : "logged-out",
    );
    writeFileSync(
      loggedOut,
      process.platform === "win32"
        ? "@echo off\r\nexit /b 1\r\n"
        : "#!/bin/sh\nexit 1\n",
      "utf8",
    );
    if (process.platform !== "win32") chmodSync(loggedOut, 0o755);

    await expect(isCodexCliAuthenticated(authenticated)).resolves.toBe(true);
    await expect(isCodexCliAuthenticated(loggedOut)).resolves.toBe(false);
  });

  it("classifies empty and failed Codex version probes", async () => {
    const dir = makeTempDir("codex-probe-failure-");
    const emptyPath = join(
      dir,
      process.platform === "win32" ? "codex-empty.cmd" : "codex-empty",
    );
    writeFileSync(
      emptyPath,
      process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\nexit 0\n",
      "utf8",
    );
    if (process.platform !== "win32") chmodSync(emptyPath, 0o755);
    await expect(probeCodexCliVersion(emptyPath)).resolves.toMatchObject({
      ok: false,
      reason: "empty-output",
    });

    const missingPath = join(dir, "missing-codex");
    await expect(probeCodexCliVersion(missingPath)).resolves.toEqual({
      ok: false,
      reason: "not-found",
    });
  });

  it("keeps an explicit codex path authoritative", async () => {
    const explicitDir = makeTempDir("codex-explicit-");
    const pathDir = makeTempDir("codex-path-");
    const explicitCodex = createFakeCodex(explicitDir, "1.0.0");
    createFakeCodex(pathDir, "99.9.0");
    prependPath(pathDir);

    await expect(findCodexCliPath(explicitCodex)).resolves.toBe(explicitCodex);
    await expect(detectCodexCli(explicitCodex)).resolves.toMatchObject({
      found: true,
      path: explicitCodex,
      version: "codex-cli 1.0.0",
    });
  });

  it("retries a bounded explicit-path replacement miss", async () => {
    const dir = makeTempDir("codex-replacement-retry-");
    const codexPath = join(
      dir,
      process.platform === "win32" ? "codex.cmd" : "codex",
    );
    const detection = findCodexCliPath(codexPath);

    await new Promise((resolve) => setTimeout(resolve, 25));
    createFakeCodex(dir, "7.8.9");

    await expect(detection).resolves.toBe(codexPath);
  });

  it("auto-detects the highest version rather than the first PATH hit", async () => {
    const oldDir = makeTempDir("codex-old-");
    const newDir = makeTempDir("codex-new-");
    createFakeCodex(oldDir, "99.1.0");
    const newerCodex = createFakeCodex(newDir, "99.2.0");
    prependPath(oldDir, newDir);

    await expect(findCodexCliPath()).resolves.toBe(newerCodex);
    await expect(detectCodexCli()).resolves.toMatchObject({
      found: true,
      path: newerCodex,
      version: "codex-cli 99.2.0",
    });
  });

  it("keeps a desktop app's bundled prerelease from replacing a stable install", async () => {
    const stableDir = makeTempDir("codex-stable-");
    const appDir = join(
      makeTempDir("codex-app-"),
      "ChatGPT.app",
      "Contents",
      "Resources",
      "codex-cli",
      "bin",
    );
    mkdirSync(appDir, { recursive: true });
    const stableCodex = createFakeCodex(stableDir, "98.0.0");
    createFakeCodex(appDir, "99.0.0-alpha.1");
    prependPath(appDir, stableDir);

    await expect(findCodexCliPath()).resolves.toBe(stableCodex);
  });
});
