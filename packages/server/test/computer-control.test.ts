import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComputerControlService } from "../src/computer-control/service.js";
import {
  callComputerPipe,
  ComputerDeliveryError,
} from "../src/computer-control/pipe.js";
import { readComputerImage } from "../src/computer-control/native.js";
import { ServerSettingsService } from "../src/services/ServerSettingsService.js";

const generation = "a".repeat(32);
describe("computer-control authority and lifecycle", () => {
  let directory: string;
  let settings: ServerSettingsService;
  let service: ComputerControlService;
  const stop = vi.fn(async () => {});
  const activity = vi.fn();
  const start = vi.fn(async () => ({
    generation,
    owner: {
      sid: "test",
      instance: "test",
      sessionId: 1,
      pipe: "injected",
      artifactRoot: "injected",
    },
    stop,
    activity,
  }));
  const call = vi.fn(
    async (_pipe: string, request: Record<string, unknown>) => ({
      ...request,
      schema: "machine-control/v0",
      accepted: true,
      sessionId: 1,
      generation,
      delivery: "confirmed",
      effect: "not_applicable",
      actualRoute: "windows.user_session/native",
      data: { elements: [{ reference: "owned", hwnd: 42 }] },
    }),
  );
  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "ya-computer-"));
    settings = new ServerSettingsService({ dataDir: directory });
    await settings.initialize();
    vi.clearAllMocks();
    service = new ComputerControlService(settings, directory, {
      platform: "win32",
      start,
      call,
    });
  });
  afterEach(async () => {
    vi.useRealTimers();
    await service.close();
    await rm(directory, { recursive: true, force: true });
  });
  const enable = async () =>
    settings.updateSettings({
      computerControl: {
        enabled: true,
        preview: {
          packageDirectory: "authenticated-fixture",
          trustedPublisher: "Independent fixture publisher",
        },
        idleMs: 5000,
        grantMs: 30_000,
      },
    });
  it("vanilla has no tool surface, resident, or timer; refuses other OS/provider", async () => {
    expect(service.select("plain", false, "codex")).toBeUndefined();
    expect(service.status().enabled).toBe(false);
    expect(start).not.toHaveBeenCalled();
    await enable();
    expect(() => service.select("remote", true, "codex", "remote")).toThrow();
    expect(() => service.select("claude", true, "claude")).toThrow();
    const unsupported = new ComputerControlService(settings, directory, {
      platform: "linux",
      start,
    });
    expect(() => unsupported.select("linux", true, "codex")).toThrow("Windows");
    await unsupported.close();
  });
  it("registers deferred tools without starting, cold-starts once and reuses", async () => {
    await enable();
    const grant = service.select("selected", true, "codex")!;
    expect(grant.tools).toEqual([
      expect.objectContaining({ deferLoading: true }),
    ]);
    expect(start).not.toHaveBeenCalled();
    expect(
      (await grant.call("computer_control", { operation: "windows" })).success,
    ).toBe(true);
    await grant.call("computer_control", { operation: "snapshot", hwnd: 42 });
    expect(start).toHaveBeenCalledTimes(1);
    expect(activity).toHaveBeenCalledTimes(4);
    await grant.close();
    expect(stop).toHaveBeenCalledTimes(1);
  });
  it("refreshes inactivity near expiry then cold-starts after idle stop", async () => {
    await enable();
    vi.useFakeTimers();
    const grant = service.select("selected", true, "codex")!;
    await grant.call("computer_control", { operation: "windows" });
    await vi.advanceTimersByTimeAsync(4900);
    await grant.call("computer_control", { operation: "windows" });
    await vi.advanceTimersByTimeAsync(4900);
    expect(stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(101);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(
      (
        await grant.call("computer_control", {
          operation: "key",
          key: "ENTER",
          expectedGeneration: generation,
        })
      ).success,
    ).toBe(false);
    await grant.call("computer_control", { operation: "windows" });
    expect(start).toHaveBeenCalledTimes(2);
  });
  it("revokes one session without stopping another; disables all immediately", async () => {
    await enable();
    const first = service.select("first", true, "codex")!;
    const second = service.select("second", true, "codex")!;
    await first.call("computer_control", { operation: "windows" });
    await service.revoke("first");
    expect(stop).not.toHaveBeenCalled();
    expect(
      (await first.call("computer_control", { operation: "windows" })).success,
    ).toBe(false);
    expect(
      (await second.call("computer_control", { operation: "windows" })).success,
    ).toBe(true);
    await service.configure({ ...service.config(), enabled: false });
    expect(
      (await second.call("computer_control", { operation: "windows" })).success,
    ).toBe(false);
    expect(stop).toHaveBeenCalledTimes(1);
  });
  it("expires grants, refuses malformed/stale/cross-session references before dispatch", async () => {
    await enable();
    vi.useFakeTimers();
    const first = service.select("first", true, "codex")!;
    const second = service.select("second", true, "codex")!;
    await first.call("computer_control", { operation: "snapshot", hwnd: 42 });
    await second.call("computer_control", {
      operation: "screenshot",
      hwnd: 42,
    });
    const count = call.mock.calls.length;
    for (const request of [
      { operation: "snapshot", hwnd: 42, secretPipe: "forbidden" },
      {
        operation: "invoke",
        reference: "unknown",
        expectedGeneration: generation,
      },
      {
        operation: "invoke",
        reference: "owned",
        expectedGeneration: "b".repeat(32),
      },
      { operation: "snapshot", hwnd: 42, maxElements: 100000 },
    ])
      expect((await first.call("computer_control", request)).success).toBe(
        false,
      );
    expect(
      (
        await second.call("computer_control", {
          operation: "invoke",
          reference: "owned",
          expectedGeneration: generation,
        })
      ).success,
    ).toBe(false);
    expect(call).toHaveBeenCalledTimes(count);
    await vi.advanceTimersByTimeAsync(30_001);
    expect(
      (await first.call("computer_control", { operation: "windows" })).success,
    ).toBe(false);
  });
  it("never replays unknown input and preserves its uncertainty", async () => {
    await enable();
    const grant = service.select("selected", true, "codex")!;
    await grant.call("computer_control", { operation: "windows" });
    call.mockRejectedValueOnce(
      new ComputerDeliveryError("lost response", "unknown"),
    );
    const result = await grant.call("computer_control", {
      operation: "key",
      key: "ENTER",
      expectedGeneration: generation,
    });
    expect(result.success).toBe(false);
    expect(result.contentItems[0]).toMatchObject({
      text: expect.stringContaining('"delivery":"unknown"'),
    });
    expect(call).toHaveBeenCalledTimes(2);
  });
  it("bounds concurrency and preserves an in-flight effect across revocation without replay", async () => {
    await enable();
    const first = service.select("first", true, "codex")!;
    const second = service.select("second", true, "codex")!;
    await first.call("computer_control", { operation: "windows" });
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    call.mockImplementationOnce(async (_pipe, request) => {
      await pending;
      return {
        ...request,
        schema: "machine-control/v0",
        accepted: true,
        sessionId: 1,
        generation,
        delivery: "confirmed",
        effect: "observed",
        actualRoute: "windows.user_session/native",
        data: { elements: [{ reference: "owned", hwnd: 42 }] },
      };
    });
    const operation = first.call(
      "computer_control",
      { operation: "key", key: "ENTER", expectedGeneration: generation },
      "mutation",
    );
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(2));
    expect(
      (await second.call("computer_control", { operation: "windows" })).success,
    ).toBe(false);
    await service.revoke("first");
    finish();
    const result = await operation;
    expect(result.success).toBe(false);
    expect(
      JSON.parse((result.contentItems[0] as { text: string }).text),
    ).toMatchObject({ delivery: "confirmed", effect: "observed" });
    expect(
      (
        await first.call(
          "computer_control",
          { operation: "windows" },
          "mutation",
        )
      ).success,
    ).toBe(false);
    expect(call).toHaveBeenCalledTimes(2);
    expect(stop).not.toHaveBeenCalled();
  });
  it("rejects duplicate provider call IDs and persists settings without persisting grants", async () => {
    await enable();
    const grant = service.select("selected", true, "codex")!;
    await grant.call("computer_control", { operation: "windows" }, "same-id");
    expect(
      (
        await grant.call(
          "computer_control",
          { operation: "windows" },
          "same-id",
        )
      ).success,
    ).toBe(false);
    expect(call).toHaveBeenCalledTimes(1);
    const reloadedSettings = new ServerSettingsService({ dataDir: directory });
    await reloadedSettings.initialize();
    const reloaded = new ComputerControlService(reloadedSettings, directory, {
      platform: "win32",
      start,
    });
    expect(reloaded.status()).toMatchObject({
      enabled: true,
      running: false,
      sessions: [],
    });
    await reloaded.close();
  });
  it("keeps the installed manager locator disabled after failed uninstall so removal can be retried", async () => {
    await enable();
    await service.close();
    const manage = vi
      .fn()
      .mockRejectedValueOnce(new Error("file in use"))
      .mockResolvedValueOnce({});
    service = new ComputerControlService(settings, directory, {
      platform: "win32",
      start,
      manage,
    });
    const preview = service.config().preview;
    await expect(service.uninstall()).rejects.toThrow("file in use");
    expect(service.config()).toMatchObject({ enabled: false, preview });
    const reloaded = new ServerSettingsService({ dataDir: directory });
    await reloaded.initialize();
    expect(reloaded.getSetting("computerControl")).toMatchObject({
      enabled: false,
      preview,
    });
    await service.uninstall();
    expect(manage).toHaveBeenLastCalledWith(
      preview,
      service.instance,
      "Uninstall",
    );
    expect(service.config().preview).toBeUndefined();
  });
  it("persists disable and refuses new grants even when owned teardown cannot be confirmed", async () => {
    await enable();
    const grant = service.select("selected", true, "codex")!;
    await grant.call("computer_control", { operation: "windows" });
    stop.mockRejectedValue(new Error("exit not confirmed"));
    try {
      await expect(
        service.configure({ ...service.config(), enabled: false }),
      ).rejects.toThrow("exit not confirmed");
      expect(service.status()).toMatchObject({
        enabled: false,
        running: true,
        sessions: [],
      });
      expect(() => service.select("new", true, "codex")).toThrow("disabled");
      expect(
        (await grant.call("computer_control", { operation: "windows" }))
          .success,
      ).toBe(false);
      expect(call).toHaveBeenCalledTimes(1);
    } finally {
      stop.mockImplementation(async () => {});
    }
  });
});

describe("native transport and artifact provenance", () => {
  it("uses a real native pipe on Windows and never replays a disconnected mutation", async () => {
    const endpoint =
      process.platform === "win32"
        ? `\\\\.\\pipe\\ya-test-${randomUUID()}`
        : path.join(tmpdir(), `ya-${randomUUID()}.sock`);
    let calls = 0;
    const server = createServer((socket) => {
      socket.once("data", () => {
        calls++;
        socket.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(endpoint, resolve));
    try {
      await expect(
        callComputerPipe(
          endpoint,
          { operation: "key", requestId: "test" },
          1000,
        ),
      ).rejects.toMatchObject({ delivery: "unknown" });
      expect(calls).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it("checks exact artifact identity, extent, hash and bounded reads", async () => {
    // macOS exposes its temporary directory through /var -> /private/var.
    // Use a canonical fixture root without weakening production link checks.
    const root = await realpath(
      await mkdtemp(path.join(tmpdir(), "ya-image-")),
    );
    const artifactId = "b".repeat(32);
    const buffer = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=",
      "base64",
    );
    const data = {
      artifactId,
      targetLocalPath: path.join(root, `${artifactId}.png`),
      bytes: buffer.length,
      width: 1,
      height: 1,
      sha256: createHash("sha256").update(buffer).digest("hex"),
    };
    try {
      await mkdir(root, { recursive: true });
      await writeFile(data.targetLocalPath, buffer);
      expect(await readComputerImage(root, data)).toBe(
        `data:image/png;base64,${buffer.toString("base64")}`,
      );
      for (const change of [
        { bytes: 9 * 1024 * 1024 },
        { sha256: "0".repeat(64) },
        { artifactId: "../escape" },
        { targetLocalPath: path.join(root, "other.png") },
        { width: 99 },
      ])
        await expect(
          readComputerImage(root, { ...data, ...change }),
        ).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
