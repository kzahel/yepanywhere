import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captureProcessIdentity,
  isOwnedProcessGroupAlive,
  processGroupAlive,
  processIdentityState,
  providerHostCapability,
  providerHostEnabled,
  readProcessStartTime,
} from "../../../../scripts/provider-process-identity.mjs";
import {
  acquireProviderHostLock,
  discoverProviderHost,
  ensurePrivateProviderHostDirectory,
  finishLegacyProviderHostMigration,
  recoverProviderHost,
  resolveProviderHostPaths,
  writeProviderHostDescriptor,
} from "../../../../scripts/provider-runtime-discovery.mjs";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});
afterEach(() => {
  vi.mocked(execFileSync).mockClear();
  vi.unstubAllEnvs();
});

it("keeps unsupported platforms and Mac Bun on the ordinary provider path", () => {
  expect(
    providerHostCapability({ platform: "win32", probe: false }).supported,
  ).toBe(false);
  expect(
    providerHostCapability({ platform: "darwin", bun: true, probe: false })
      .supported,
  ).toBe(false);
  expect(resolveProviderHostPaths({}, { platform: "win32" })).toBeNull();
});
it("defaults the provider host off on Mac and on for Linux", () => {
  expect(providerHostEnabled({ env: {}, platform: "darwin" })).toBe(false);
  expect(providerHostEnabled({ env: {}, platform: "linux" })).toBe(true);
  expect(providerHostEnabled({ env: {}, platform: "win32" })).toBe(false);
});
it("lets explicit provider-host configuration override platform defaults", () => {
  expect(
    providerHostEnabled({
      env: { YEP_PROVIDER_HOST_ENABLED: "true" },
      platform: "darwin",
    }),
  ).toBe(true);
  expect(
    providerHostEnabled({
      env: { YEP_PROVIDER_HOST_ENABLED: "false" },
      platform: "linux",
    }),
  ).toBe(false);
  expect(() =>
    providerHostEnabled({
      env: { YEP_PROVIDER_HOST_ENABLED: "sometimes" },
      platform: "linux",
    }),
  ).toThrow("must be true or false");
});
it("shares the Mac default across profiles and respects explicit directory overrides", () => {
  const mac = { platform: "darwin", homeDir: "/Users/test", uid: 501 };
  const defaultDir = resolve(mac.homeDir, ".yep-anywhere", "provider-host");
  expect(resolveProviderHostPaths({}, mac)).toMatchObject({
    runtimeDir: defaultDir,
    legacyPaths: {
      runtimeDir: join("/tmp", "yep-anywhere-501", "provider-host"),
    },
  });
  expect(
    resolveProviderHostPaths(
      {
        XDG_RUNTIME_DIR: "/ignored",
        YEP_DATA_DIR: "/another-data-directory",
        YEP_PROFILE: "dev",
      },
      mac,
    ).runtimeDir,
  ).toBe(defaultDir);
  const longHome = { ...mac, homeDir: join(mac.homeDir, "x".repeat(80)) };
  expect(() => resolveProviderHostPaths({}, longHome)).toThrow(
    "shorter private directory",
  );
  const explicit = resolveProviderHostPaths(
    { YEP_PROVIDER_HOST_RUNTIME_DIR: "/tmp/custom-host" },
    longHome,
  );
  expect(explicit.runtimeDir).toBe(resolve("/tmp/custom-host"));
  expect(explicit.legacyPaths).toBeUndefined();
  expect(() =>
    resolveProviderHostPaths(
      { YEP_PROVIDER_HOST_RUNTIME_DIR: `/tmp/${"x".repeat(80)}` },
      { platform: "darwin" },
    ),
  ).toThrow("shorter private directory");
});

it("keeps the Linux XDG location and migrates only the old temp fallback", () => {
  vi.stubEnv(process.platform === "win32" ? "TEMP" : "TMPDIR", "/tmp");
  const linux = {
    platform: "linux",
    homeDir: "/home/test",
    uid: 1000,
    readLinuxScope: () => ({ bootId: "fixture" }),
  };
  const xdg = { XDG_RUNTIME_DIR: "/run/user/1000" };
  const temp = join(tmpdir(), "yep-anywhere-1000", "provider-host");
  const xdgPaths = resolveProviderHostPaths(xdg, linux);
  expect(xdgPaths.runtimeDir).toBe(
    resolve(xdg.XDG_RUNTIME_DIR, "yep-anywhere", "provider-host"),
  );
  expect(xdgPaths.legacyPaths).toBeUndefined();
  expect(
    resolveProviderHostPaths(
      { YEP_PROFILE: "dev", YEP_DATA_DIR: "/other-data" },
      linux,
    ),
  ).toMatchObject({
    runtimeDir: resolve(linux.homeDir, ".yep-anywhere", "provider-host"),
    legacyPaths: { runtimeDir: temp },
  });
  const unscoped = resolveProviderHostPaths(
    {},
    { ...linux, readLinuxScope: () => null },
  );
  expect(unscoped.runtimeDir).toBe(temp);
  expect(unscoped.legacyPaths).toBeUndefined();
  const explicit = resolveProviderHostPaths(
    { ...xdg, YEP_PROVIDER_HOST_RUNTIME_DIR: "/local/host" },
    linux,
  );
  expect(explicit.runtimeDir).toBe(resolve("/local/host"));
  expect(explicit.legacyPaths).toBeUndefined();
});

it.skipIf(process.platform !== "linux")(
  "recovers records from a previous Linux boot without signaling matching local processes",
  async () => {
    const home = await mkdtemp("/tmp/ya-host-scope-");
    vi.stubEnv("HOME", home);
    const paths = resolveProviderHostPaths({});
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      {
        detached: true,
        stdio: "ignore",
      },
    );
    const exited = once(child, "exit");
    try {
      const owner = captureProcessIdentity(child.pid);
      const identity = { sourceIdentity: {}, buildIdentity: "test" };
      const release = acquireProviderHostLock(paths, owner);
      const lock = JSON.parse(await readFile(paths.lockPath, "utf8"));
      release();
      writeProviderHostDescriptor(paths, {
        ...identity,
        descriptorId: "previous-boot",
        hostProtocolVersion: 3,
        features: [],
        controlSocketPath: paths.controlSocketPath,
        tokenFilePath: paths.tokenPath,
        owner,
        startedAt: new Date().toISOString(),
        processGroups: [
          { processGroupId: owner.pid, leaderStartTime: owner.startTime },
        ],
      });
      const descriptor = JSON.parse(
        await readFile(paths.descriptorPath, "utf8"),
      );
      const previousScope = {
        ...descriptor.linuxHostScope,
        bootId: "11111111-1111-4111-8111-111111111111",
      };
      const foreign = {
        ...descriptor,
        linuxHostScope: { ...previousScope, machineId: "f".repeat(64) },
      };
      await writeFile(paths.descriptorPath, JSON.stringify(foreign));
      await expect(
        discoverProviderHost(paths, { expectedIdentity: identity }),
      ).resolves.toMatchObject({ state: "ownership-unknown" });

      await writeFile(
        paths.descriptorPath,
        JSON.stringify({
          ...descriptor,
          linuxHostScope: previousScope,
        }),
      );
      const previousLock =
        JSON.stringify({
          ...lock,
          linuxHostScope: previousScope,
        }) + "\n";
      await writeFile(paths.lockPath, previousLock, { mode: 0o600 });
      await writeFile(paths.recoveryLockPath, previousLock, { mode: 0o600 });
      const discovery = await discoverProviderHost(paths, {
        expectedIdentity: identity,
      });
      expect(discovery.state).toBe("unresponsive");
      expect(discovery.error).toContain("earlier Linux boot");
      await recoverProviderHost(paths, discovery.descriptor);
      expect(processIdentityState(owner)).toBe("same");
      await expect(
        discoverProviderHost(paths, { expectedIdentity: identity }),
      ).resolves.toEqual({ state: "absent" });
    } finally {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGTERM");
      await exited;
      await rm(home, { recursive: true, force: true });
    }
  },
);

describe.skipIf(!["linux", "darwin"].includes(process.platform))(
  "native provider identity",
  () => {
    it("blocks migration while a legacy descriptor or socket still has a live owner", async () => {
      const directory = await mkdtemp("/tmp/ya-legacy-host-");
      const paths = resolveProviderHostPaths({
        YEP_PROVIDER_HOST_RUNTIME_DIR: directory,
      });
      const server = createServer((socket) => socket.end());
      try {
        writeProviderHostDescriptor(paths, {
          descriptorId: "legacy",
          hostProtocolVersion: 3,
          features: [],
          controlSocketPath: paths.controlSocketPath,
          tokenFilePath: paths.tokenPath,
          owner: captureProcessIdentity(),
          startedAt: new Date().toISOString(),
          sourceIdentity: {},
          buildIdentity: "test",
        });
        await expect(finishLegacyProviderHostMigration(paths)).rejects.toThrow(
          "Stop the provider host",
        );

        await rm(paths.descriptorPath);
        server.listen(paths.controlSocketPath);
        await once(server, "listening");
        await expect(finishLegacyProviderHostMigration(paths)).rejects.toThrow(
          "Stop the provider host",
        );
        await new Promise((resolve) => server.close(resolve));
        await expect(
          finishLegacyProviderHostMigration(paths),
        ).resolves.toBeUndefined();
      } finally {
        if (server.listening)
          await new Promise((resolve) => server.close(resolve));
        await rm(directory, { recursive: true, force: true });
      }
    });

    it("distinguishes matching, reused and absent identities", async () => {
      const child = spawn(
        process.execPath,
        ["-e", "setInterval(()=>{},1000)"],
        { stdio: "ignore" },
      );
      try {
        const identity = captureProcessIdentity(child.pid);
        expect(processIdentityState(identity)).toBe("same");
        expect(processIdentityState({ ...identity, startTime: "reused" })).toBe(
          "different",
        );
        child.kill("SIGTERM");
        await once(child, "exit");
        expect(processIdentityState(identity)).toBe("absent");
      } finally {
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
      }
    });
    it("cleans up original descendants after their process-group leader exits", async () => {
      const leader = spawn(
        process.execPath,
        [
          "-e",
          `
      const {spawn}=require('node:child_process');
      const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
      child.unref(); process.send({pid:child.pid});
      process.on('message',()=>process.exit(0));
    `,
        ],
        { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] },
      );
      const [{ pid }] = await once(leader, "message");
      const identity = captureProcessIdentity(leader.pid);
      const target = {
        processGroupId: leader.pid,
        leaderStartTime: identity.startTime,
      };
      try {
        leader.send("exit");
        await once(leader, "exit");
        expect(readProcessStartTime(leader.pid)).toBeNull();
        expect(readProcessStartTime(pid)).not.toBeNull();
        expect(isOwnedProcessGroupAlive(target)).toBe(true);
        process.kill(-leader.pid, "SIGTERM");
        await expect
          .poll(() => processGroupAlive(leader.pid), { timeout: 3000 })
          .toBe(false);
      } finally {
        if (processGroupAlive(leader.pid)) process.kill(-leader.pid, "SIGKILL");
      }
    });
    it("rejects insecure and symlink runtime directories", async () => {
      const root = await mkdtemp(join(tmpdir(), "ya-identity-"));
      try {
        const insecure = join(root, "insecure");
        await mkdir(insecure);
        await chmod(insecure, 0o755);
        expect(() => ensurePrivateProviderHostDirectory(insecure)).toThrow(
          "not private",
        );
        await symlink(insecure, join(root, "link"));
        expect(() =>
          ensurePrivateProviderHostDirectory(join(root, "link")),
        ).toThrow("not a directory");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  },
);

describe.skipIf(process.platform !== "darwin")(
  "Darwin identity failures",
  () => {
    it("never mistakes an inaccessible or partial record for absence", () => {
      vi.mocked(execFileSync).mockReturnValueOnce(
        JSON.stringify({ size: 0, data: "" }),
      );
      expect(() => readProcessStartTime(process.pid)).toThrow("Inaccessible");
      vi.mocked(execFileSync).mockReturnValueOnce(
        JSON.stringify({ size: 1, data: "AA==" }),
      );
      expect(() => readProcessStartTime(process.pid)).toThrow("Ambiguous");
      vi.mocked(execFileSync).mockImplementationOnce(() => {
        throw new Error("probe timeout");
      });
      expect(providerHostCapability()).toMatchObject({
        supported: false,
        reason: expect.stringContaining("probe timeout"),
      });
    });
  },
);
