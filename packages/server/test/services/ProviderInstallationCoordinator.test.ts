import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ProviderInstallationBusyError,
  ProviderInstallationCoordinator,
} from "../../src/services/ProviderInstallationCoordinator.js";
import {
  createDefaultOwnerProbe,
  defaultOwnerProbe,
  type InstallationOwnerProbe,
} from "../../src/services/installationOwnerProbe.js";

const FAMILY = "codex-cli";

describe("ProviderInstallationCoordinator", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "ya-provider-installation-test-"));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  function createCoordinator(
    ownerProbe?: InstallationOwnerProbe,
  ): ProviderInstallationCoordinator {
    return new ProviderInstallationCoordinator({
      rootDir,
      heartbeatMs: 10,
      leaseStaleMs: 100,
      pollMs: 5,
      readWaitMs: 500,
      readerDrainWaitMs: 500,
      ...(ownerProbe ? { ownerProbe } : {}),
    });
  }

  /** Write a lease/writer record whose heartbeat mtime is long past stale. */
  async function writeStaleRecord(
    name: string,
    record: Record<string, unknown>,
  ): Promise<string> {
    const familyDir = join(rootDir, FAMILY);
    await mkdir(familyDir, { recursive: true, mode: 0o700 });
    const recordPath = join(familyDir, name);
    await writeFile(recordPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    const past = new Date(Date.now() - 60_000);
    await utimes(recordPath, past, past);
    return recordPath;
  }

  /** Claim the gate directory the way a process that then died would leave it. */
  async function claimGateWithoutOwner(ageMs: number): Promise<string> {
    const gatePath = join(rootDir, FAMILY, "gate.lock");
    await mkdir(gatePath, { recursive: true, mode: 0o700 });
    const claimedAt = new Date(Date.now() - ageMs);
    await utimes(gatePath, claimedAt, claimedAt);
    return gatePath;
  }

  function probe(
    aliveState: "alive" | "missing" | "other-user",
    startId: string | null,
  ): InstallationOwnerProbe {
    return {
      aliveState: () => aliveState,
      startId: async () => startId,
    };
  }

  it("sweeps abandoned leases when a family is first prepared", async () => {
    const staleLeasePath = await writeStaleRecord("runtime-dead.json", {
      id: "dead",
      family: FAMILY,
      kind: "runtime",
      pid: 12345,
      ownerStartId: "boot-100",
      createdAt: Date.now() - 60_000,
    });
    const coordinator = createCoordinator(probe("missing", null));

    const lease = await coordinator.acquireRuntimeLease(FAMILY);

    await expect(stat(staleLeasePath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await lease.release();
  });

  it("refuses an update while a runtime lease is active", async () => {
    const coordinator = createCoordinator();
    const lease = await coordinator.acquireRuntimeLease(FAMILY);
    const operation = vi.fn(async () => "updated");

    await expect(
      coordinator.runExclusiveUpdate(FAMILY, operation),
    ).rejects.toMatchObject({
      name: "ProviderInstallationBusyError",
      readers: 0,
      runtimes: 1,
      updating: false,
    } satisfies Partial<ProviderInstallationBusyError>);
    expect(operation).not.toHaveBeenCalled();

    await lease.release();
    await expect(
      coordinator.runExclusiveUpdate(FAMILY, operation),
    ).resolves.toBe("updated");
  });

  it("makes readers wait for an admitted update to finish", async () => {
    const coordinator = createCoordinator();
    const updateEntered = Promise.withResolvers<void>();
    const finishUpdate = Promise.withResolvers<void>();
    const update = coordinator.runExclusiveUpdate(FAMILY, async () => {
      updateEntered.resolve();
      await finishUpdate.promise;
      return "updated";
    });
    await updateEntered.promise;

    const read = vi.fn(async () => "read");
    const readResult = coordinator.withReadLease(FAMILY, read);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(read).not.toHaveBeenCalled();

    finishUpdate.resolve();
    await expect(update).resolves.toBe("updated");
    await expect(readResult).resolves.toBe("read");
  });

  it("waits for a bounded reader before admitting an update", async () => {
    const coordinator = createCoordinator();
    const finishRead = Promise.withResolvers<void>();
    const readEntered = Promise.withResolvers<void>();
    const read = coordinator.withReadLease(FAMILY, async () => {
      readEntered.resolve();
      await finishRead.promise;
    });
    await readEntered.promise;

    const operation = vi.fn(async () => "updated");
    const update = coordinator.runExclusiveUpdate(FAMILY, operation);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(operation).not.toHaveBeenCalled();

    finishRead.resolve();
    await read;
    await expect(update).resolves.toBe("updated");
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent in-process update requests", async () => {
    const coordinator = createCoordinator();
    const updateEntered = Promise.withResolvers<void>();
    const finishUpdate = Promise.withResolvers<void>();
    const operation = vi.fn(async () => {
      updateEntered.resolve();
      await finishUpdate.promise;
      return "updated";
    });

    const first = coordinator.runExclusiveUpdate(FAMILY, operation);
    await updateEntered.promise;
    const second = coordinator.runExclusiveUpdate(FAMILY, operation);
    finishUpdate.resolve();

    await expect(Promise.all([first, second])).resolves.toEqual([
      "updated",
      "updated",
    ]);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("shares runtime and writer admission across coordinator instances", async () => {
    const first = createCoordinator();
    const second = createCoordinator();
    const lease = await first.acquireRuntimeLease(FAMILY);

    await expect(
      second.runExclusiveUpdate(FAMILY, async () => "updated"),
    ).rejects.toMatchObject({
      name: "ProviderInstallationBusyError",
      runtimes: 1,
    });

    await lease.release();
    await expect(
      second.runExclusiveUpdate(FAMILY, async () => "updated"),
    ).resolves.toBe("updated");
  });

  it("renews the admission gate while stale-owner probes are slow", async () => {
    for (let index = 0; index < 7; index++) {
      await writeStaleRecord(`read-slow-${index}.json`, {
        id: `slow-${index}`,
        family: FAMILY,
        kind: "read",
        pid: 12345 + index,
        ownerStartId: `boot-${index}`,
        createdAt: Date.now() - 60_000,
      });
    }

    let measure = false;
    let activeProbes = 0;
    let maxActiveProbes = 0;
    const firstMeasuredProbe = Promise.withResolvers<void>();
    const slowProbe: InstallationOwnerProbe = {
      aliveState: () => "alive",
      startId: async (pid) => {
        if (!measure) return `boot-${pid - 12345}`;
        activeProbes++;
        maxActiveProbes = Math.max(maxActiveProbes, activeProbes);
        firstMeasuredProbe.resolve();
        await new Promise((resolve) => setTimeout(resolve, 12));
        activeProbes--;
        return pid >= 12345 && pid < 12352
          ? `boot-${pid - 12345}`
          : "current-owner";
      },
    };
    const coordinatorOptions = {
      rootDir,
      heartbeatMs: 5,
      leaseStaleMs: 10,
      gateStaleMs: 25,
      gateWaitMs: 1_000,
      pollMs: 2,
      ownerProbe: slowProbe,
    };
    const first = new ProviderInstallationCoordinator(coordinatorOptions);
    const second = new ProviderInstallationCoordinator(coordinatorOptions);

    const primingLease = await first.acquireRuntimeLease(FAMILY);
    await primingLease.release();
    measure = true;

    const snapshot = first.getSnapshot(FAMILY);
    await firstMeasuredProbe.promise;
    await new Promise((resolve) => setTimeout(resolve, 35));
    const competingLease = second.acquireRuntimeLease(FAMILY);

    await expect(snapshot).resolves.toMatchObject({ readers: 7 });
    const lease = await competingLease;
    await lease.release();
    expect(maxActiveProbes).toBe(1);
  });

  it("recovers a gate claimed before its owner record was written", async () => {
    const gatePath = await claimGateWithoutOwner(60_000);
    const coordinator = createCoordinator();

    const lease = await coordinator.acquireRuntimeLease(FAMILY);
    await lease.release();

    await expect(stat(gatePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves a just-claimed gate alone until it goes stale", async () => {
    await claimGateWithoutOwner(0);
    const coordinator = new ProviderInstallationCoordinator({
      rootDir,
      heartbeatMs: 10,
      leaseStaleMs: 100,
      pollMs: 5,
      gateStaleMs: 10_000,
      gateWaitMs: 50,
    });

    await expect(coordinator.acquireRuntimeLease(FAMILY)).rejects.toThrow(
      "Timed out acquiring provider installation gate",
    );
  });

  it("drops the gate directory when its owner record vanished", async () => {
    await writeStaleRecord("runtime-vanishing.json", {
      id: "vanishing",
      family: FAMILY,
      kind: "runtime",
      pid: 12345,
      ownerStartId: "boot-100",
      createdAt: Date.now() - 60_000,
    });
    const gatePath = join(rootDir, FAMILY, "gate.lock");
    const coordinator = createCoordinator({
      aliveState: () => "alive",
      startId: async () => {
        await rm(join(gatePath, "owner.json"), { force: true });
        return "boot-100";
      },
    });

    await expect(coordinator.getSnapshot(FAMILY)).resolves.toMatchObject({
      runtimes: 1,
    });
    await expect(stat(gatePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps a delayed-heartbeat runtime lease while its owner is alive", async () => {
    await writeStaleRecord("runtime-sleeping.json", {
      id: "sleeping",
      family: FAMILY,
      kind: "runtime",
      pid: 12345,
      ownerStartId: "boot-100",
      createdAt: Date.now() - 60_000,
    });
    const coordinator = createCoordinator(probe("alive", "boot-100"));

    await expect(
      coordinator.runExclusiveUpdate(FAMILY, async () => "updated"),
    ).rejects.toMatchObject({
      name: "ProviderInstallationBusyError",
      runtimes: 1,
    });
  });

  it("removes a stale runtime lease whose owner PID is gone", async () => {
    await writeStaleRecord("runtime-dead.json", {
      id: "dead",
      family: FAMILY,
      kind: "runtime",
      pid: 12345,
      ownerStartId: "boot-100",
      createdAt: Date.now() - 60_000,
    });
    const coordinator = createCoordinator(probe("missing", null));

    await expect(
      coordinator.runExclusiveUpdate(FAMILY, async () => "updated"),
    ).resolves.toBe("updated");
  });

  it("removes a stale runtime lease whose PID was reused", async () => {
    await writeStaleRecord("runtime-reused.json", {
      id: "reused",
      family: FAMILY,
      kind: "runtime",
      pid: 12345,
      ownerStartId: "boot-100",
      createdAt: Date.now() - 60_000,
    });
    // The PID is occupied again, but by a process started at another time.
    const coordinator = createCoordinator(probe("alive", "boot-999"));

    await expect(
      coordinator.runExclusiveUpdate(FAMILY, async () => "updated"),
    ).resolves.toBe("updated");
  });

  it("removes a stale runtime lease reoccupied by another user's process", async () => {
    await writeStaleRecord("runtime-other.json", {
      id: "other",
      family: FAMILY,
      kind: "runtime",
      pid: 12345,
      ownerStartId: "boot-100",
      createdAt: Date.now() - 60_000,
    });
    const coordinator = createCoordinator(probe("other-user", null));

    await expect(
      coordinator.runExclusiveUpdate(FAMILY, async () => "updated"),
    ).resolves.toBe("updated");
  });

  it("honors a delayed-heartbeat writer while its owner is alive", async () => {
    await writeStaleRecord("writer.json", {
      operationId: "sleeping-writer",
      family: FAMILY,
      pid: 12345,
      ownerStartId: "boot-100",
      createdAt: Date.now() - 60_000,
    });
    const coordinator = createCoordinator(probe("alive", "boot-100"));

    await expect(
      coordinator.withReadLease(FAMILY, async () => "read"),
    ).rejects.toMatchObject({ name: "ProviderInstallationUpdatingError" });
  });

  it("recovers from a stale writer whose owner PID is gone", async () => {
    await writeStaleRecord("writer.json", {
      operationId: "dead-writer",
      family: FAMILY,
      pid: 12345,
      ownerStartId: "boot-100",
      createdAt: Date.now() - 60_000,
    });
    const coordinator = createCoordinator(probe("missing", null));

    await expect(
      coordinator.withReadLease(FAMILY, async () => "read"),
    ).resolves.toBe("read");
  });

  it("probes real process liveness and start identity", async () => {
    expect(defaultOwnerProbe.aliveState(process.pid)).toBe("alive");
    // Far beyond any realistic pid_max, so nothing occupies it.
    expect(defaultOwnerProbe.aliveState(0x7fffffff)).toBe("missing");
    await expect(defaultOwnerProbe.startId(process.pid)).resolves.toBeTruthy();
  });

  it("uses Windows process creation time as the owner generation", async () => {
    const execFile = vi.fn(async () => ({ stdout: "638916751234567890\r\n" }));
    const probe = createDefaultOwnerProbe({ platform: "win32", execFile });

    await expect(probe.startId(4242)).resolves.toBe("638916751234567890");
    expect(execFile).toHaveBeenCalledWith(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[System.Diagnostics.Process]::GetProcessById(4242).StartTime.ToUniversalTime().Ticks",
      ],
      { encoding: "utf8", timeout: 15_000 },
    );
  });

  it("reports a probe failure the same way for any PID", async () => {
    const failure = new Error("PowerShell timed out");
    const windowsProbe = createDefaultOwnerProbe({
      platform: "win32",
      execFile: vi.fn(async () => {
        throw failure;
      }),
    });
    await expect(windowsProbe.startId(4242)).rejects.toBe(failure);
    await expect(windowsProbe.startId(process.pid)).rejects.toBe(failure);

    const posixFailure = new Error("ps is unavailable");
    const posixProbe = createDefaultOwnerProbe({
      platform: "darwin",
      execFile: vi.fn(async () => {
        throw posixFailure;
      }),
    });
    await expect(posixProbe.startId(4242)).rejects.toBe(posixFailure);
    await expect(posixProbe.startId(process.pid)).rejects.toBe(posixFailure);
  });

  it("reports an unusable probe answer as an unknown start identity", async () => {
    const invalidProbe = createDefaultOwnerProbe({
      platform: "win32",
      execFile: vi.fn(async () => ({ stdout: "unexpected output" })),
    });
    await expect(invalidProbe.startId(4242)).resolves.toBeNull();

    const emptyProbe = createDefaultOwnerProbe({
      platform: "darwin",
      execFile: vi.fn(async () => ({ stdout: "  \n" })),
    });
    await expect(emptyProbe.startId(4242)).resolves.toBeNull();
  });

  it("blocks admission and names the probe failure when a start identity is required", async () => {
    const failure = new Error("PowerShell timed out");
    const coordinator = new ProviderInstallationCoordinator({
      rootDir,
      heartbeatMs: 10,
      leaseStaleMs: 100,
      pollMs: 5,
      requireOwnerStartId: true,
      ownerProbe: {
        aliveState: () => "missing",
        startId: async () => {
          throw failure;
        },
      },
    });

    await expect(
      coordinator.runExclusiveUpdate(FAMILY, async () => "updated"),
    ).rejects.toMatchObject({
      message: expect.stringContaining("process start identity"),
      cause: failure,
    });
  });

  it("blocks admission when a required start identity is simply unknown", async () => {
    const coordinator = new ProviderInstallationCoordinator({
      rootDir,
      heartbeatMs: 10,
      leaseStaleMs: 100,
      pollMs: 5,
      requireOwnerStartId: true,
      ownerProbe: probe("missing", null),
    });

    const rejection = await coordinator
      .runExclusiveUpdate(FAMILY, async () => "updated")
      .then(
        () => null,
        (error: unknown) => error as Error,
      );
    expect(rejection).toBeInstanceOf(Error);
    expect(rejection?.message).toContain("process start identity");
    expect(rejection?.cause).toBeUndefined();
  });

  it("admits without a start identity when the platform does not require one", async () => {
    const coordinator = createCoordinator({
      aliveState: () => "missing",
      startId: async () => {
        throw new Error("ps is unavailable");
      },
    });

    await expect(
      coordinator.runExclusiveUpdate(FAMILY, async () => "updated"),
    ).resolves.toBe("updated");
  });

  it("publishes a cross-process source generation after failure", async () => {
    const first = createCoordinator();
    const second = createCoordinator();
    const before = second.getSourceVersion(FAMILY);
    const listener = vi.fn();
    first.onGenerationChange(FAMILY, listener);

    await expect(
      first.runExclusiveUpdate(FAMILY, async () => {
        throw new Error("replacement failed");
      }),
    ).rejects.toThrow("replacement failed");

    expect(listener).toHaveBeenCalledTimes(1);
    expect(first.getSourceVersion(FAMILY)).not.toBe(before);
    expect(second.getSourceVersion(FAMILY)).not.toBe(before);
  });
});
