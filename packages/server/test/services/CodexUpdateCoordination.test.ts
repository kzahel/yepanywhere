import { chmod, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexProvider } from "../../src/sdk/providers/codex.js";
import { CodexOSSProvider } from "../../src/sdk/providers/codex-oss.js";
import { CodexUpdateChecker } from "../../src/services/CodexUpdateChecker.js";
import { ProviderInstallationCoordinator } from "../../src/services/ProviderInstallationCoordinator.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => undefined;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function writeFakeCodex(path: string, version: string): Promise<void> {
  const source =
    process.platform === "win32"
      ? `@echo off\r\necho codex-cli ${version}\r\n`
      : `#!/bin/sh\necho codex-cli ${version}\n`;
  await writeFile(path, source, "utf8");
  if (process.platform !== "win32") await chmod(path, 0o755);
}

describe("Codex installation update coordination", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ya-codex-update-race-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("keeps both Codex aliases out of the executable replacement window", async () => {
    const coordinator = new ProviderInstallationCoordinator({
      rootDir: join(tempDir, "coordination"),
      heartbeatMs: 10,
      leaseStaleMs: 100,
      pollMs: 5,
      readWaitMs: 1_000,
    });
    const codexPath = join(
      tempDir,
      process.platform === "win32" ? "codex.cmd" : "codex",
    );
    const retiredPath = `${codexPath}.retired`;
    await writeFakeCodex(codexPath, "0.4.2");

    const replacementOpen = deferred();
    const finishReplacement = deferred();
    const runInstall = vi.fn(async () => {
      await rename(codexPath, retiredPath);
      replacementOpen.resolve();
      await finishReplacement.promise;
      await writeFakeCodex(codexPath, "0.4.3");
      return "installed @openai/codex";
    });
    const checker = new CodexUpdateChecker({
      codexCliPath: codexPath,
      installationCoordinator: coordinator,
      fetchLatest: async () => ({ tagName: "v0.4.3", htmlUrl: null }),
      detectInstallMetadata: async () => ({
        installedPackage: "@openai/codex",
        installSource: "npm",
        updateMethod: "npm",
        manualInstallCommand: "npm install -g @openai/codex@latest",
      }),
      runInstall,
    });
    const codex = new CodexProvider({
      codexPath,
      installationCoordinator: coordinator,
    });
    const codexOss = new CodexOSSProvider({
      codexPath,
      installationCoordinator: coordinator,
    });
    const sourceBefore = codex.getModelCatalogCacheKey();

    const install = checker.install();
    await replacementOpen.promise;

    let codexResolved = false;
    let codexOssResolved = false;
    const codexStatus = codex.getAuthStatus().then((status) => {
      codexResolved = true;
      return status;
    });
    const codexOssInstalled = codexOss.isInstalled().then((installed) => {
      codexOssResolved = true;
      return installed;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(codexResolved).toBe(false);
    expect(codexOssResolved).toBe(false);

    finishReplacement.resolve();
    await expect(install).resolves.toMatchObject({
      success: true,
      status: { installed: "0.4.3", installedPath: codexPath },
    });
    await expect(codexStatus).resolves.toMatchObject({
      installed: true,
      authenticated: true,
    });
    await expect(codexOssInstalled).resolves.toBe(true);
    expect(runInstall).toHaveBeenCalledTimes(1);
    expect(codex.getModelCatalogCacheKey()).not.toBe(sourceBefore);
    expect(codexOss.getModelCatalogCacheKey()).toBe(
      codex.getModelCatalogCacheKey(),
    );
  });

  it("holds reload replacement for an in-flight update transaction", async () => {
    const coordinator = new ProviderInstallationCoordinator({
      rootDir: join(tempDir, "coordination"),
      heartbeatMs: 10,
      leaseStaleMs: 100,
      pollMs: 5,
      readWaitMs: 1_000,
    });
    const codexPath = join(
      tempDir,
      process.platform === "win32" ? "codex.cmd" : "codex",
    );
    const retiredPath = `${codexPath}.retired`;
    await writeFakeCodex(codexPath, "0.4.2");

    const replacementOpen = deferred();
    const finishReplacement = deferred();
    const runInstall = vi.fn(async () => {
      await rename(codexPath, retiredPath);
      replacementOpen.resolve();
      await finishReplacement.promise;
      await writeFakeCodex(codexPath, "0.4.3");
      return "installed @openai/codex";
    });
    const checker = new CodexUpdateChecker({
      codexCliPath: codexPath,
      installationCoordinator: coordinator,
      fetchLatest: async () => ({ tagName: "v0.4.3", htmlUrl: null }),
      detectInstallMetadata: async () => ({
        installedPackage: "@openai/codex",
        installSource: "npm",
        updateMethod: "npm",
        manualInstallCommand: "npm install -g @openai/codex@latest",
      }),
      runInstall,
    });

    // With no update running the shutdown drain is immediate.
    await expect(coordinator.waitForLocalUpdates(10)).resolves.toEqual([]);

    const install = checker.install();
    await replacementOpen.promise;

    // A reload arriving inside the npm replacement window must observe the
    // transaction and hold rather than exit into it.
    await expect(coordinator.waitForLocalUpdates(50)).resolves.toEqual([
      "codex-cli",
    ]);

    finishReplacement.resolve();
    await expect(coordinator.waitForLocalUpdates(5_000)).resolves.toEqual([]);
    await expect(install).resolves.toMatchObject({
      success: true,
      status: { installed: "0.4.3", installedPath: codexPath },
    });
  });

  it("refuses mutation until an active Codex runtime releases its lease", async () => {
    const coordinator = new ProviderInstallationCoordinator({
      rootDir: join(tempDir, "coordination"),
      heartbeatMs: 10,
      leaseStaleMs: 100,
      pollMs: 5,
      readWaitMs: 1_000,
    });
    const codexPath = join(
      tempDir,
      process.platform === "win32" ? "codex.cmd" : "codex",
    );
    await writeFakeCodex(codexPath, "0.4.2");
    const runInstall = vi.fn(async () => {
      await writeFakeCodex(codexPath, "0.4.3");
      return "installed @openai/codex";
    });
    const checker = new CodexUpdateChecker({
      codexCliPath: codexPath,
      installationCoordinator: coordinator,
      fetchLatest: async () => ({ tagName: "v0.4.3", htmlUrl: null }),
      detectInstallMetadata: async () => ({
        installedPackage: "@openai/codex",
        installSource: "npm",
        updateMethod: "npm",
        manualInstallCommand: "npm install -g @openai/codex@latest",
      }),
      runInstall,
    });
    const provider = new CodexProvider({
      codexPath,
      installationCoordinator: coordinator,
    });
    const session = await provider.startSession({ cwd: tempDir });

    const blocked = await checker.install();
    expect(blocked).toMatchObject({ success: false, retryable: true });
    expect(blocked.error).toMatch(/active provider operation/i);
    expect(runInstall).not.toHaveBeenCalled();

    await session.abort();
    await expect(checker.install()).resolves.toMatchObject({
      success: true,
      status: { installed: "0.4.3" },
    });
    expect(runInstall).toHaveBeenCalledTimes(1);
  });
});
