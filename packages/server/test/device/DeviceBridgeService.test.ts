import { afterEach, describe, expect, it, vi } from "vitest";
import { DeviceBridgeService } from "../../src/device/DeviceBridgeService.js";

type DeviceBridgeOverrides = {
  activeBinaryPath?: DeviceBridgeService["activeBinaryPath"];
  available?: DeviceBridgeService["available"];
  downloadAndroidServerAPK?: DeviceBridgeService["downloadAndroidServerAPK"];
  downloadBinary?: DeviceBridgeService["downloadBinary"];
  ensureAndroidServerAPK?: DeviceBridgeService["ensureAndroidServerAPK"];
  ensureStarted?: DeviceBridgeService["ensureStarted"];
  findBinaryCandidate?: DeviceBridgeService["findBinaryCandidate"];
  getInstalledBinaryVersion?: DeviceBridgeService["getInstalledBinaryVersion"];
  port?: DeviceBridgeService["port"];
  sendToSidecar?: DeviceBridgeService["sendToSidecar"];
  shutdown?: DeviceBridgeService["shutdown"];
};

function createBridge(overrides: DeviceBridgeOverrides): DeviceBridgeService {
  const service = new DeviceBridgeService({
    adbPath: "adb",
    dataDir: "/tmp/yep-anywhere-test",
  });
  return Object.assign(
    service,
    { ensureStarted: async () => undefined },
    overrides,
  );
}

describe("DeviceBridgeService", () => {
  const originalFetch = global.fetch;
  const originalUseApkForEmulator =
    process.env.DEVICE_BRIDGE_USE_APK_FOR_EMULATOR;

  afterEach(() => {
    vi.restoreAllMocks();
    global.fetch = originalFetch;
    if (originalUseApkForEmulator === undefined) {
      process.env.DEVICE_BRIDGE_USE_APK_FOR_EMULATOR = undefined;
    } else {
      process.env.DEVICE_BRIDGE_USE_APK_FOR_EMULATOR =
        originalUseApkForEmulator;
    }
  });

  it("sends session.start with deviceId only (no legacy emulatorId)", async () => {
    const sendToSidecar = vi.fn<DeviceBridgeService["sendToSidecar"]>();
    const service = createBridge({ sendToSidecar });

    await service.startStream(
      {
        type: "device_stream_start",
        sessionId: "session-1",
        deviceId: "emulator-5554",
        options: { maxFps: 20, maxWidth: 480, quality: 28 },
      },
      vi.fn(),
    );

    expect(sendToSidecar).toHaveBeenCalledTimes(1);
    const payload = sendToSidecar.mock.calls[0]?.[0];
    expect(payload).toEqual({
      type: "session.start",
      sessionId: "session-1",
      deviceId: "emulator-5554",
      options: { maxFps: 20, maxWidth: 480, quality: 28 },
    });
    expect(payload).not.toHaveProperty("emulatorId");
  });

  it("does not fall back to /emulators when /devices returns 404", async () => {
    const service = createBridge({ port: 48765 });

    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("not found", { status: 404 }));
    global.fetch = fetchMock;

    await expect(service.listDevices()).rejects.toThrow("Sidecar error: 404");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestedUrls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(requestedUrls).toEqual(["http://127.0.0.1:48765/devices"]);
    expect(requestedUrls.some((url) => url.includes("/emulators"))).toBe(false);
  });

  it("ensures Android APK before starting a physical Android stream", async () => {
    const sendToSidecar = vi.fn<DeviceBridgeService["sendToSidecar"]>();
    const ensureAndroidServerAPK = vi.fn(
      async () => "/tmp/yep-device-server.apk",
    );
    const ensureStarted = vi.fn(async () => undefined);
    const service = createBridge({
      ensureAndroidServerAPK,
      ensureStarted,
      sendToSidecar,
    });

    await service.startStream(
      {
        type: "device_stream_start",
        sessionId: "session-android",
        deviceId: "R3CN90ABCDE",
      },
      vi.fn(),
    );

    expect(ensureAndroidServerAPK).toHaveBeenCalledTimes(1);
    expect(ensureStarted).toHaveBeenCalledTimes(1);
    expect(ensureAndroidServerAPK.mock.invocationCallOrder[0]).toBeLessThan(
      ensureStarted.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
    expect(sendToSidecar).toHaveBeenCalledWith({
      type: "session.start",
      sessionId: "session-android",
      deviceId: "R3CN90ABCDE",
      options: undefined,
    });
  });

  it("does not ensure Android APK for default emulator streams", async () => {
    process.env.DEVICE_BRIDGE_USE_APK_FOR_EMULATOR = undefined;

    const ensureAndroidServerAPK = vi.fn(
      async () => "/tmp/yep-device-server.apk",
    );
    const service = createBridge({
      ensureAndroidServerAPK,
      sendToSidecar: vi.fn<DeviceBridgeService["sendToSidecar"]>(),
    });

    await service.startStream(
      {
        type: "device_stream_start",
        sessionId: "session-emu",
        deviceId: "emulator-5554",
      },
      vi.fn(),
    );

    expect(ensureAndroidServerAPK).not.toHaveBeenCalled();
  });

  it("ensures Android APK for emulator streams when APK override mode is enabled", async () => {
    process.env.DEVICE_BRIDGE_USE_APK_FOR_EMULATOR = "true";

    const ensureAndroidServerAPK = vi.fn(
      async () => "/tmp/yep-device-server.apk",
    );
    const service = createBridge({
      ensureAndroidServerAPK,
      sendToSidecar: vi.fn<DeviceBridgeService["sendToSidecar"]>(),
    });

    await service.startStream(
      {
        type: "device_stream_start",
        sessionId: "session-emu-apk",
        deviceId: "emulator-5554",
      },
      vi.fn(),
    );

    expect(ensureAndroidServerAPK).toHaveBeenCalledTimes(1);
  });

  it("reports update-available for stale managed binaries", async () => {
    const service = createBridge({
      findBinaryCandidate: () => ({
        path: "/tmp/yep-anywhere-test/bin/device-bridge-darwin-arm64",
        source: "prod",
      }),
      getInstalledBinaryVersion: async () => "0.1.0",
    });

    global.fetch = vi.fn((url) => {
      if (String(url) === "https://updates.yepanywhere.com/bridge/version") {
        return Promise.resolve(
          new Response(JSON.stringify({ version: "0.2.0" }), { status: 200 }),
        );
      }
      throw new Error(`Unexpected fetch: ${String(url)}`);
    });

    await expect(service.getBridgeStatus()).resolves.toEqual({
      state: "update-available",
      installedVersion: "0.1.0",
      latestVersion: "0.2.0",
    });
  });

  it("reports update-available when managed binary version probe fails", async () => {
    const service = createBridge({
      findBinaryCandidate: () => ({
        path: "/tmp/yep-anywhere-test/bin/device-bridge-darwin-arm64",
        source: "prod",
      }),
      getInstalledBinaryVersion: async () => null,
    });

    global.fetch = vi.fn((url) => {
      if (String(url) === "https://updates.yepanywhere.com/bridge/version") {
        return Promise.resolve(
          new Response(JSON.stringify({ version: "0.2.0" }), { status: 200 }),
        );
      }
      throw new Error(`Unexpected fetch: ${String(url)}`);
    });

    await expect(service.getBridgeStatus()).resolves.toEqual({
      state: "update-available",
      installedVersion: null,
      latestVersion: "0.2.0",
    });
  });

  it("restarts a running managed sidecar after downloading updates", async () => {
    const shutdown = vi.fn(async () => undefined);
    const ensureStarted = vi.fn(async () => undefined);
    const getProdBinaryPath = "getProdBinaryPath";
    const service = createBridge({
      ensureStarted,
      available: true,
      shutdown,
    });
    const prodBinaryPath = service[getProdBinaryPath]();
    const apkPath = "/tmp/yep-anywhere-test/bin/yep-device-server.apk";
    Object.assign(service, {
      activeBinaryPath: prodBinaryPath,
      downloadBinary: async () => prodBinaryPath,
      downloadAndroidServerAPK: async () => apkPath,
    } satisfies DeviceBridgeOverrides);

    await expect(service.downloadRuntimeDependencies()).resolves.toEqual({
      binaryPath: prodBinaryPath,
      apkPath,
    });

    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(ensureStarted).toHaveBeenCalledTimes(1);
    expect(shutdown.mock.invocationCallOrder[0]).toBeLessThan(
      ensureStarted.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
  });
});
