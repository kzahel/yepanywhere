import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
  symlink,
  unlink,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CliInstallationService,
  type CliCandidate,
  type CliInstallationAdapter,
} from "../../src/services/CliInstallationService.js";
import { fnmCodexPaths } from "../../src/sdk/fnm-codex-discovery.js";
import { describeAntigravityCandidate } from "../../src/sdk/providers/antigravity-launch.js";
import { antigravityInstallationAdapter } from "../../src/sdk/cli-installation-adapters.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const coordinator = {
  withReadLease: async <T>(_family: string, run: () => Promise<T>) => run(),
  getSourceVersion: () => "generation-1",
};
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ya-cli-selection-"));
  roots.push(root);
  const good = join(root, "good");
  const bad = join(root, "bad");
  const helper = join(root, "tool-host");
  await Promise.all([
    writeFile(good, "good", { mode: 0o755 }),
    writeFile(bad, "bad", { mode: 0o755 }),
    writeFile(helper, "helper"),
  ]);
  const candidate = (path: string): CliCandidate => ({
    path,
    launch: { command: path, args: [] },
    watchPaths: [helper],
    source: "fixture",
  });
  return { root, good, bad, helper, candidate };
}

describe("installation selection and verification", () => {
  it("deduplicates concurrent probes, persists successes and invalidates helpers and missing explicit paths", async () => {
    const f = await fixture();
    let selection: string | undefined;
    let calls = 0;
    const adapter: CliInstallationAdapter = {
      family: "codex",
      installationFamily: "codex-cli",
      probeRevision: "test-1",
      contextKey: () => "controlled",
      discover: async (explicit) => [f.candidate(explicit ?? f.good)],
      verify: async (candidate) => {
        calls++;
        await new Promise((resolve) => setImmediate(resolve));
        if (candidate.path === f.bad) throw Error("missing host");
      },
    };
    const create = () =>
      new CliInstallationService(
        f.root,
        [adapter],
        () => ({ codex: selection }),
        undefined,
        coordinator,
      );
    const service = create();
    await Promise.all([service.resolve("codex"), service.resolve("codex")]);
    expect(calls).toBe(1);
    await create().resolve("codex");
    expect(calls).toBe(1);
    await writeFile(f.helper, "replaced helper with different contents");
    await service.resolve("codex");
    expect(calls).toBe(2);
    selection = f.bad;
    await expect(service.resolve("codex")).rejects.toThrow("missing host");
    await expect(service.resolve("codex")).rejects.toThrow("missing host");
    expect(calls).toBe(3);
    await expect(service.resolve("codex", undefined, true)).rejects.toThrow(
      "missing host",
    );
    expect(calls).toBe(4);
    selection = f.good;
    const oldLaunch = await service.resolve("codex");
    selection = f.bad;
    expect(oldLaunch.command).toBe(f.good);
    await unlink(f.good);
    // A vanished formerly verified command must never retain a valid cache key.
    selection = f.good;
    await expect(service.resolve("codex")).rejects.toThrow("no longer exists");
    expect(calls).toBe(4);
  });

  it("auto skips execution failures, while an explicit broken choice never falls back", async () => {
    const f = await fixture();
    let selection: string | undefined;
    const tried: string[] = [];
    const adapter: CliInstallationAdapter = {
      family: "codex",
      installationFamily: "codex-cli",
      probeRevision: "test-1",
      contextKey: () => "controlled",
      discover: async (explicit) =>
        (explicit ? [explicit] : [f.bad, f.good]).map(f.candidate),
      verify: async (candidate) => {
        tried.push(candidate.path);
        if (candidate.path === f.bad)
          throw Error("version worked; tool host missing");
      },
    };
    const service = new CliInstallationService(
      f.root,
      [adapter],
      () => ({ codex: selection }),
      undefined,
      coordinator,
    );
    expect((await service.resolve("codex")).command).toBe(f.good);
    expect(tried).toEqual([f.bad, f.good]);
    expect(
      (await service.inventory("codex")).candidates.find((c) => c.selected)
        ?.path,
    ).toBe(f.good);
    selection = f.bad;
    await expect(service.resolve("codex")).rejects.toThrow("tool host missing");
    expect(tried).toEqual([f.bad, f.good]);
    expect(
      (await service.inventory("codex")).candidates.find((c) => c.selected)
        ?.path,
    ).toBe(f.bad);
  });

  it("bounds a hung verification and joins abort cleanup before returning", async () => {
    const f = await fixture();
    let cleaned = false;
    const adapter: CliInstallationAdapter = {
      family: "codex",
      installationFamily: "codex-cli",
      probeRevision: "test-1",
      contextKey: () => "controlled",
      discover: async () => [f.candidate(f.good)],
      verify: async (_candidate, signal) => {
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        cleaned = true;
        signal.throwIfAborted();
      },
    };
    const service = new CliInstallationService(
      f.root,
      [adapter],
      () => ({}),
      undefined,
      coordinator,
      10,
    );
    await expect(service.resolve("codex")).rejects.toThrow("timed out");
    expect(cleaned).toBe(true);
  });
});

it.each(["darwin", "linux", "win32"] as const)(
  "discovers only fnm's default on %s without shell initialization",
  async (platform) => {
    const f = await fixture();
    const root = join(f.root, "fnm");
    const active = join(root, "node-versions", "v24", "installation");
    await mkdir(join(root, "aliases"), { recursive: true });
    await mkdir(platform === "win32" ? active : join(active, "bin"), {
      recursive: true,
    });
    const command = join(
      active,
      platform === "win32" ? "codex.cmd" : "bin/codex",
    );
    await writeFile(command, "launcher");
    await symlink(
      join(root, "node-versions", "v24"),
      join(root, "aliases", "default"),
      process.platform === "win32" ? "junction" : "dir",
    );
    expect(
      fnmCodexPaths(platform, f.root, { FNM_DIR: root, PATH: "" }),
    ).toEqual([await realpath(command)]);
  },
);

it.skipIf(process.platform === "win32")(
  "launches agy's ACP server from its symlink target and flags a version below the floor",
  async () => {
    const f = await fixture();
    const launcher = join(f.root, "agy");
    await symlink(f.good, launcher);
    expect(describeAntigravityCandidate(launcher)).toMatchObject({
      launch: { command: await realpath(f.good), args: ["acp"] },
      watchPaths: [],
    });
    const reporting = async (version: string) => {
      const path = join(f.root, `agy-${version}`);
      await writeFile(path, `#!/bin/sh\necho ${version}\n`, { mode: 0o755 });
      return (await antigravityInstallationAdapter.discover(path))[0];
    };
    const current = await reporting("1.5.13");
    expect(current).toMatchObject({ version: "1.5.13" });
    expect(current?.error).toBeUndefined();
    expect(await reporting("1.4.12")).toMatchObject({
      version: "1.4.12",
      error:
        "Antigravity requires agy 1.5.13 or later; the installed runtime reports version 1.4.12. Run `agy update`, or install the agy CLI.",
    });
  },
);
