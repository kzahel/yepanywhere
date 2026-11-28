import { ok } from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  register: vi.fn(),
  terminate: vi.fn(),
  stopHost: vi.fn(),
  unregister: vi.fn(),
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: mocks.spawn,
}));
vi.mock("../../../client/e2e/support/process-registry.js", () => ({
  registerProcess: mocks.register,
  unregisterProcess: mocks.unregister,
  readRegisteredProcess: () => undefined,
}));
vi.mock("../../../client/e2e/support/process-lifecycle.js", () => ({
  terminateChildProcess: mocks.terminate,
}));
vi.mock("../../../client/e2e/support/provider-host-runtime.js", () => ({
  stopProviderHostRuntime: mocks.stopHost,
}));
import {
  startYaServerProcess,
  restartYaServerProcess,
  type YaServerProcess,
} from "../../../client/e2e/support/ya-server-process.js";
import { startWorkerRelay } from "../../../client/e2e/support/worker-services.js";
import { registerSharedServiceProcess } from "../../../client/e2e/support/shared-service-process.js";

let root: string;
let child: ChildProcess;
beforeEach(() => {
  vi.resetAllMocks();
  mkdirSync(process.env.YEP_DATA_DIR!, { recursive: true });
  root = mkdtempSync(join(process.env.YEP_DATA_DIR!, "startup-"));
  vi.stubEnv("YEP_E2E_RUN_DIR", root);
  vi.stubEnv("YEP_E2E_SERVER_SCOPE", "run");
  const handle = Object.assign(new EventEmitter(), {
    pid: 123456,
    exitCode: null,
    signalCode: null,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    unref: vi.fn(),
  });
  child = handle as unknown as ChildProcess;
  mocks.spawn.mockReturnValue(child);
  mocks.register.mockRejectedValue(new Error("registry write failed"));
  mocks.terminate.mockResolvedValue(undefined);
  mocks.stopHost.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe("E2E startup failure ownership", () => {
  it("reaps coordinator-owned frontends when registration fails", async () => {
    await expect(
      registerSharedServiceProcess(child, {
        label: "shared frontend",
        pidFile: join(root, "remote-pid"),
      }),
    ).rejects.toThrow("registry write failed");
    expect(mocks.terminate).toHaveBeenCalledWith(child, "shared frontend");
  });
  it("reaps a YA child and private host when registration fails", async () => {
    await expect(
      startYaServerProcess({ label: "registration regression" }),
    ).rejects.toThrow("registry write failed");
    expect(mocks.terminate).toHaveBeenCalledWith(
      child,
      "registration regression",
      undefined,
    );
    expect(mocks.stopHost).toHaveBeenCalledOnce();
    expect(existsSync(mocks.stopHost.mock.calls[0]![0])).toBe(false);
  });

  it("keeps startup evidence and both errors if reclamation also fails", async () => {
    mocks.terminate.mockRejectedValue(new Error("owned group did not exit"));
    const error = await startYaServerProcess({
      label: "cleanup regression",
    }).catch((failure: unknown) => failure);
    ok(error instanceof AggregateError);
    const [registrationError, cleanupError]: unknown[] = error.errors;
    ok(registrationError instanceof Error);
    ok(cleanupError instanceof AggregateError);
    const [reclamationError]: unknown[] = cleanupError.errors;
    ok(reclamationError instanceof Error);
    expect(registrationError.message).toContain("registry write failed");
    expect(reclamationError.message).toBe("owned group did not exit");
    expect(existsSync(mocks.stopHost.mock.calls[0]![0])).toBe(true);
  });

  it("arms ownership for a replacement child before re-registering it", async () => {
    const runtime = mkdtempSync(join(root, "h-"));
    const server: YaServerProcess = {
      serverExecutable: process.execPath,
      claudeSessionsDir: join(root, "claude"),
      codexSessionsDir: join(root, "codex"),
      geminiSessionsDir: join(root, "gemini"),
      dataDir: join(root, "data"),
      wsUrl: "ws://127.0.0.1:1234",
      baseUrl: "http://127.0.0.1:1234",
      port: 1234,
      label: "restart regression",
      tempDir: root,
      portFile: join(root, "port"),
      process: child,
      restartEnv: { YEP_PROVIDER_HOST_RUNTIME_DIR: runtime },
      registryFile: join(root, "previous.json"),
      output: { stdout: [], stderr: [] },
      ownsTempDir: false,
    };
    await expect(restartYaServerProcess(server)).rejects.toThrow(
      "registry write failed",
    );
    expect(mocks.terminate).toHaveBeenCalledTimes(2);
    expect(mocks.stopHost).toHaveBeenCalledWith(runtime);
    expect(existsSync(runtime)).toBe(false);
  });

  it("reaps a relay child when registration fails", async () => {
    await expect(startWorkerRelay()).rejects.toThrow("registry write failed");
    expect(mocks.terminate).toHaveBeenCalledWith(
      child,
      "worker relay",
      undefined,
    );
  });
});
