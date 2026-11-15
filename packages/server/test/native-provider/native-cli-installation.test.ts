import {
  copyFile,
  mkdtemp,
  mkdir,
  rm,
  writeFile,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { nativeExecutable } from "./runtimes.js";
import {
  describeCodexCandidate,
  codexInstallationAdapter,
} from "../../src/sdk/cli-installation-adapters.js";
import { probeCodexCliVersion } from "../../src/sdk/cli-detection.js";
import { CliInstallationService } from "../../src/services/CliInstallationService.js";
import { probeCodexExecution } from "../../src/sdk/codex-execution-probe.js";

it("rejects a versioned Codex with no code-mode host and executes with the next complete installation", async () => {
  const root = await mkdtemp(join(tmpdir(), "ya-native-cli-install-"));
  try {
    const binary = nativeExecutable("codex");
    const broken = join(
      root,
      "incomplete",
      process.platform === "win32" ? "codex.exe" : "codex",
    );
    await mkdir(dirname(broken));
    await copyFile(binary, broken);
    expect((await probeCodexCliVersion(broken)).ok).toBe(true);
    const candidates = [
      describeCodexCandidate(broken),
      describeCodexCandidate(binary),
    ];
    const service = new CliInstallationService(
      root,
      [
        {
          ...codexInstallationAdapter,
          discover: async (explicit) =>
            explicit
              ? candidates.filter((c) => c.path === explicit)
              : candidates,
        },
      ],
      () => ({}),
    );
    const selected = await service.resolve("codex");
    expect(selected.command).toBe(binary);
    const inventory = await service.inventory("codex");
    expect(inventory.candidates[0]?.verification).toBe("failed");
    expect(inventory.candidates[0]?.verificationError).toMatch(
      /code.mode.host|No such file|cannot find/i,
    );
    expect(inventory.candidates[1]?.verification).toBe("verified");
    await expect(service.resolve("codex", broken)).rejects.toThrow(
      "No usable codex installation",
    );
    // A fresh owner reuses successful installation verification from disk.
    const reopened = new CliInstallationService(
      root,
      [
        {
          ...codexInstallationAdapter,
          discover: async () => [describeCodexCandidate(binary)],
          verify: async () => {
            throw new Error("Unexpected repeat execution probe");
          },
        },
      ],
      () => ({}),
    );
    expect((await reopened.resolve("codex")).command).toBe(binary);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

it("aborts and joins an unresponsive app-server and its child", async () => {
  const root = await mkdtemp(join(tmpdir(), "ya-cli-abort-"));
  const controller = new AbortController();
  const peer = join(root, "peer.cjs");
  const pids = join(root, "pids.json");
  const command = join(
    root,
    process.platform === "win32" ? "codex.cmd" : "codex",
  );
  await writeFile(
    peer,
    `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); require('node:fs').writeFileSync(${JSON.stringify(pids)},JSON.stringify([process.pid,child.pid]));process.stdin.resume();setInterval(()=>{},1000);`,
  );
  await writeFile(
    command,
    process.platform === "win32"
      ? `@echo off\r\n"${process.execPath}" "${peer}" %*\r\n`
      : `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${peer.replaceAll("'", "'\\''")}' "$@"\n`,
    { mode: 0o755 },
  );
  const probe = probeCodexExecution(
    describeCodexCandidate(command),
    controller.signal,
  );
  // Attach the rejection handler before aborting, while waiting for native spawn evidence.
  const outcome = probe.then(
    () => null,
    (error: Error) => error,
  );
  try {
    await expect
      .poll(
        async () =>
          readFile(pids, "utf8").then(
            () => true,
            () => false,
          ),
        { timeout: 5000 },
      )
      .toBe(true);
    const owned: number[] = JSON.parse(await readFile(pids, "utf8"));
    controller.abort(new Error("Owned timeout qualification"));
    expect(await outcome).toBeInstanceOf(Error);
    for (const pid of owned) expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    controller.abort();
    await outcome;
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
