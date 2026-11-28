import type {
  HostAwakeFeatureSupport,
  HostAwakeStatus,
} from "@yep-anywhere/shared";
import { describe, expect, it, vi } from "vitest";
import type {
  HostAwakeBackend,
  HostAwakeBackendStatus,
  HostAwakeLease,
  HostAwakeRequest,
  HostPowerSnapshot,
} from "../../src/services/host-awake/HostAwakeBackend.js";
import { HostAwakeUnsupportedError } from "../../src/services/host-awake/HostAwakeBackend.js";
import { HostAwakeService } from "../../src/services/host-awake/HostAwakeService.js";

const SUPPORT: HostAwakeFeatureSupport = {
  idleSleepPrevention: true,
  batteryFloor: true,
  closedLidOnExternalPower: false,
};

function snapshot(
  overrides: Partial<HostPowerSnapshot> = {},
): HostPowerSnapshot {
  return {
    hasInternalBattery: false,
    powerSource: "external",
    powerObservedAt: 1_000,
    ...overrides,
  };
}

class FakeLease implements HostAwakeLease {
  readonly release = vi.fn(async () => undefined);

  constructor(private current: HostAwakeBackendStatus) {}

  status(): HostAwakeBackendStatus {
    return { ...this.current };
  }
}

class FakeBackend implements HostAwakeBackend {
  readonly platform = "darwin" as const;
  readonly support = SUPPORT;
  readonly probe = vi.fn(async () => snapshot());
  readonly leases: FakeLease[] = [];
  onStatus: ((status: HostAwakeBackendStatus) => void) | null = null;
  acquireError: Error | null = null;

  acquire = vi.fn(
    async (
      _request: HostAwakeRequest,
      onStatus: (status: HostAwakeBackendStatus) => void,
    ): Promise<HostAwakeLease> => {
      if (this.acquireError) throw this.acquireError;
      this.onStatus = onStatus;
      const lease = new FakeLease({ ...snapshot(), state: "active" });
      this.leases.push(lease);
      return lease;
    },
  );
}

describe("HostAwakeService", () => {
  it("probes once while disabled and reports a useful desktop backend", async () => {
    const backend = new FakeBackend();
    const service = new HostAwakeService({ backend });

    const status = await service.initialize({
      mode: "off",
      batteryFloorPercent: 10,
    });

    expect(backend.probe).toHaveBeenCalledTimes(1);
    expect(status).toMatchObject({
      state: "disabled",
      hasInternalBattery: false,
      support: SUPPORT,
    });
  });

  it("refuses enablement when battery presence cannot be classified", async () => {
    const backend = new FakeBackend();
    backend.probe.mockResolvedValue(
      snapshot({ hasInternalBattery: "unknown", powerSource: "unknown" }),
    );
    const service = new HostAwakeService({ backend });

    const check = await service.checkSupport("idle");

    expect(check.ok).toBe(false);
    expect(check.status).toMatchObject({
      state: "unsupported",
      hasInternalBattery: "unknown",
    });
    expect(backend.acquire).not.toHaveBeenCalled();
  });

  it("serially replaces and releases the single live policy lease", async () => {
    const backend = new FakeBackend();
    const service = new HostAwakeService({ backend });

    await service.apply("idle", 10);
    await service.apply("idle", 20);

    expect(backend.acquire).toHaveBeenCalledTimes(2);
    expect(backend.leases[0]?.release).toHaveBeenCalledTimes(1);
    expect(backend.leases[1]?.release).not.toHaveBeenCalled();
    expect(service.status()).toMatchObject({
      state: "active",
      batteryFloorPercent: 20,
    });

    await service.shutdown();
    expect(backend.leases[1]?.release).toHaveBeenCalledTimes(1);
  });

  it("preserves low-battery pause updates from the policy lease", async () => {
    const backend = new FakeBackend();
    const service = new HostAwakeService({ backend });
    await service.apply("idle", 10);

    backend.onStatus?.({
      ...snapshot({
        hasInternalBattery: true,
        powerSource: "battery",
        batteryPercent: 10,
      }),
      state: "paused-low-battery",
    });

    expect(service.status()).toMatchObject({
      state: "paused-low-battery",
      batteryPercent: 10,
    });
  });

  it("does not disturb an active lease when a stronger mode is rejected", async () => {
    const backend = new FakeBackend();
    const service = new HostAwakeService({ backend });
    await service.apply("idle", 10);

    const check = await service.checkSupport(
      "idle-and-closed-lid-on-external-power",
    );

    expect(check).toMatchObject({
      ok: false,
      status: { state: "unsupported" },
    });
    expect(service.status().state).toBe("active");
    expect(backend.probe).not.toHaveBeenCalled();
    expect(backend.leases[0]?.release).not.toHaveBeenCalled();
  });

  it("downgrades a policy-blocked backend to unsupported", async () => {
    const backend = new FakeBackend();
    backend.acquireError = new HostAwakeUnsupportedError(
      "PowerShell policy blocked the helper",
    );
    const service = new HostAwakeService({ backend });

    const status = await service.apply("idle", 10);

    expect(status.state).toBe("unsupported");
    expect(status.support.idleSleepPrevention).toBe(false);
    expect(status.reason).toContain("PowerShell policy");
  });

  it("coalesces concurrent stale status probes", async () => {
    let now = 1_000;
    const firstProbe = Promise.withResolvers<HostPowerSnapshot>();
    const nextProbe = Promise.withResolvers<HostPowerSnapshot>();
    const backend = new FakeBackend();
    backend.probe
      .mockReturnValueOnce(firstProbe.promise)
      .mockReturnValueOnce(nextProbe.promise);
    const service = new HostAwakeService({
      backend,
      now: () => now,
      disabledSampleMaxAgeMs: 30_000,
    });

    const first = service.getStatus();
    const second = service.getStatus();
    expect(backend.probe).toHaveBeenCalledTimes(1);
    firstProbe.resolve(snapshot({ powerObservedAt: now }));
    await Promise.all([first, second]);

    now += 31_000;
    const third = service.getStatus();
    const fourth = service.getStatus();
    expect(backend.probe).toHaveBeenCalledTimes(2);
    nextProbe.resolve(snapshot({ powerObservedAt: now }));
    const statuses: HostAwakeStatus[] = await Promise.all([third, fourth]);
    expect(statuses.every((status) => status.state === "disabled")).toBe(true);
  });
});
