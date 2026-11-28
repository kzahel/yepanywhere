import assert from "node:assert/strict";
import {
  ChildProcess,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WINDOWS_HELPER_START_TIMEOUT_MS,
  WINDOWS_HOST_AWAKE_BOOTSTRAP_COMMAND,
  WINDOWS_HOST_AWAKE_HELPER_SOURCE,
  WindowsHostAwakeBackend,
} from "../../src/services/host-awake/WindowsHostAwakeBackend.js";

vi.mock("node:child_process", { spy: true });

type PipedChild = ChildProcessWithoutNullStreams & {
  stdin: PassThrough;
  stdout: PassThrough;
};

function fakeChild(onInput: (child: PipedChild) => void): PipedChild {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdio: ChildProcessWithoutNullStreams["stdio"] = [
    stdin,
    stdout,
    stderr,
    null,
    null,
  ];
  const child = Object.assign(new ChildProcess(), {
    stdin,
    stdout,
    stderr,
    stdio,
    kill: vi.fn(() => {
      child.emit("exit", 0, null);
      return true;
    }),
  });
  stdin.once("finish", () => queueMicrotask(() => onInput(child)));
  return child;
}

describe("WindowsHostAwakeBackend", () => {
  const spawnProcess = vi.mocked(spawn);

  afterEach(() => {
    vi.restoreAllMocks();
    spawnProcess.mockReset();
  });

  it("parses the complete stdin helper without policy bypass or script files", async () => {
    let helperSource = "";
    spawnProcess.mockImplementationOnce(() =>
      fakeChild((process) => {
        helperSource = process.stdin.read()?.toString() ?? "";
        process.stdout.write(
          `${JSON.stringify({
            kind: "snapshot",
            hasInternalBattery: false,
            powerSource: "external",
            powerObservedAt: 123,
          })}\n`,
        );
        process.emit("exit", 0, null);
      }),
    );
    const backend = new WindowsHostAwakeBackend({
      powershellPath: "C:\\Windows\\powershell.exe",
      parentPid: 1234,
    });

    await expect(backend.probe()).resolves.toMatchObject({
      hasInternalBattery: false,
      powerSource: "external",
    });

    const [call] = spawnProcess.mock.calls;
    assert(call, "Expected a PowerShell spawn");
    const [executable, args, options] = call;
    expect(executable).toBe("C:\\Windows\\powershell.exe");
    expect(args).toEqual([
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      WINDOWS_HOST_AWAKE_BOOTSTRAP_COMMAND,
    ]);
    expect(args).not.toContain("-ExecutionPolicy");
    expect(args).not.toContain("-File");
    expect(options).toMatchObject({ windowsHide: true });
    expect(helperSource).toBe(WINDOWS_HOST_AWAKE_HELPER_SOURCE);
  });

  it.skipIf(process.platform !== "win32")(
    "executes the real Windows PowerShell probe",
    async () => {
      const snapshot = await new WindowsHostAwakeBackend().probe();

      expect([true, false, "unknown"]).toContain(snapshot.hasInternalBattery);
      expect(["battery", "external", "unknown"]).toContain(
        snapshot.powerSource,
      );
      expect(snapshot.powerObservedAt).toBeGreaterThan(0);
    },
    WINDOWS_HELPER_START_TIMEOUT_MS + 5_000,
  );

  it("owns a PID-bound SystemRequired request and releases its helper", async () => {
    const child = fakeChild((process) => {
      process.stdout.write(
        `${JSON.stringify({
          kind: "status",
          state: "active",
          hasInternalBattery: true,
          powerSource: "battery",
          batteryPercent: 80,
          powerObservedAt: 456,
        })}\n`,
      );
    });
    spawnProcess.mockReturnValueOnce(child);
    const backend = new WindowsHostAwakeBackend({
      powershellPath: "powershell.exe",
      parentPid: 9876,
    });

    const lease = await backend.acquire(
      { mode: "idle", batteryFloorPercent: 10 },
      vi.fn(),
    );

    expect(lease.status()).toMatchObject({
      state: "active",
      batteryPercent: 80,
    });
    const [call] = spawnProcess.mock.calls;
    assert(call, "Expected a PowerShell spawn");
    const [, , options] = call;
    expect(options.env).toMatchObject({
      YEP_HOST_AWAKE_PROBE_ONLY: "0",
      YEP_HOST_AWAKE_PARENT_PID: "9876",
      YEP_HOST_AWAKE_FLOOR_PERCENT: "10",
    });
    expect(WINDOWS_HOST_AWAKE_HELPER_SOURCE).toContain(
      "PowerRequestSystemRequired",
    );
    expect(WINDOWS_HOST_AWAKE_HELPER_SOURCE).not.toContain(
      "PowerRequestDisplayRequired",
    );

    await lease.release();
    expect(child.kill).toHaveBeenCalled();
  });

  it("reports an unexpected helper failure once without restarting", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const onStatus = vi.fn();
    const child = fakeChild((process) => {
      process.stdout.write(
        `${JSON.stringify({
          kind: "status",
          state: "active",
          hasInternalBattery: false,
          powerSource: "external",
          powerObservedAt: 456,
        })}\n`,
      );
    });
    spawnProcess.mockReturnValueOnce(child);
    const backend = new WindowsHostAwakeBackend({
      powershellPath: "powershell.exe",
    });
    const lease = await backend.acquire(
      { mode: "idle", batteryFloorPercent: 10 },
      onStatus,
    );

    child.emit("error", new Error("helper failed"));
    child.emit("exit", 1, null);

    expect(onStatus).toHaveBeenCalledTimes(1);
    expect(onStatus).toHaveBeenCalledWith(
      expect.objectContaining({ state: "error" }),
    );
    expect(spawnProcess).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    await lease.release();
    warn.mockRestore();
  });
});
