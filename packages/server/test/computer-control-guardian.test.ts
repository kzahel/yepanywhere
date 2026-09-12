import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  guardianSource,
  stopGuardian,
} from "../src/computer-control/native.js";

afterEach(() => vi.useRealTimers());
describe("resident guardian deadlines", () => {
  it("refreshes near inactivity expiry, then bounds a hung native stop", async () => {
    vi.useFakeTimers();
    const parent = Object.assign(new EventEmitter(), {
      env: {},
      send: vi.fn(),
      exit: vi.fn(),
    });
    const child = Object.assign(new EventEmitter(), {
      exitCode: null,
      kill: vi.fn(),
      stdin: Object.assign(new EventEmitter(), { write: vi.fn() }),
      stdout: new EventEmitter(),
    });
    const socket = Object.assign(new EventEmitter(), {
      destroy: vi.fn(),
      write: vi.fn(),
    });
    runInNewContext(guardianSource, {
      process: parent,
      setTimeout,
      clearTimeout,
      require: (name: string) => {
        if (name === "node:child_process") return { spawn: () => child };
        if (name === "node:net") return { createConnection: () => socket };
        if (name === "node:crypto") return { randomUUID: () => "probe" };
        if (name === "node:path")
          return { join: (...parts: string[]) => parts.join("/") };
        throw new Error("Unexpected guardian dependency");
      },
    });
    parent.emit("message", {
      type: "start",
      executable: "owned",
      instance: "owned",
      pipe: "owned",
    });
    child.stdout.emit("data", '{"pid":123}\n');
    await vi.advanceTimersByTimeAsync(299_000);
    parent.emit("message", { type: "activity" });
    await vi.advanceTimersByTimeAsync(299_000);
    expect(child.kill).not.toHaveBeenCalled();
    expect(parent.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(11_001);
    expect(child.kill).toHaveBeenCalled();
    expect(parent.exit).toHaveBeenCalled();
  });
  it("reports missing guardian exit confirmation within a bounded deadline", async () => {
    vi.useFakeTimers();
    const guard = Object.assign(new EventEmitter(), {
      exitCode: null,
      connected: true,
      send: vi.fn(),
      disconnect: vi.fn(),
    });
    const stopped = expect(
      stopGuardian(guard as unknown as ChildProcess),
    ).rejects.toThrow("did not confirm exit");
    await vi.advanceTimersByTimeAsync(12_001);
    await stopped;
    expect(guard.send).toHaveBeenCalledWith({ type: "stop" });
    expect(guard.disconnect).toHaveBeenCalledOnce();
  });
});
