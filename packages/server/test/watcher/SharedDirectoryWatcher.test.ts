import { AsyncLocalStorage } from "node:async_hooks";
import { EventEmitter } from "node:events";
import { sep } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  SharedDirectoryWatcher,
  isDirectoryWatchPending,
  isDirectoryWatchStalled,
  waitForDirectoryWatchReady,
  wasDirectoryWatchAttached,
} from "../../src/watcher/SharedDirectoryWatcher.js";

const native = vi.hoisted(() => ({ watch: vi.fn(), ino: 1 }));
vi.mock("node:fs", async () => ({
  ...(await vi.importActual<typeof import("node:fs")>("node:fs")),
  realpathSync: (path: string) => (path === "/alias" ? "/project" : path),
  statSync: () => ({ dev: 1, ino: native.ino }),
  watch: native.watch,
}));

class NativeWatch extends EventEmitter {
  close = vi.fn(() => this.emit("close"));
  ref = vi.fn(() => this);
  unref = vi.fn(() => this);
}

afterEach(() => {
  vi.resetAllMocks();
  native.ino = 1;
});

it("shares one canonical directory watch and closes it only after the last lease", () => {
  const watcher = new NativeWatch();
  native.watch.mockImplementation((_path, _options, listener) => {
    watcher.on("change", listener);
    return watcher;
  });
  const registry = new SharedDirectoryWatcher();
  const a = vi.fn();
  const b = vi.fn();
  const first = registry.watch("/project", { persistent: false }, a);
  const second = registry.watch("/alias", { persistent: false }, b);
  expect(native.watch).toHaveBeenCalledTimes(1);
  watcher.emit("change", "rename", "new.txt");
  expect(a).toHaveBeenCalledWith("rename", "new.txt");
  expect(b).toHaveBeenCalledWith("rename", "new.txt");
  first.close();
  expect(watcher.close).not.toHaveBeenCalled();
  watcher.emit("change", "change", "new.txt");
  expect(a).toHaveBeenCalledTimes(1);
  expect(b).toHaveBeenCalledTimes(2);
  second.close();
  second.close();
  expect(watcher.close).toHaveBeenCalledTimes(1);
});

it("changes recursive coverage without overlapping native watches and invalidates the observation gap", () => {
  const watches: NativeWatch[] = [];
  let live = 0;
  native.watch.mockImplementation((_path, _options, listener) => {
    expect(live).toBe(0);
    live++;
    const watcher = new NativeWatch();
    watcher.on("change", listener);
    watcher.on("close", () => live--);
    watches.push(watcher);
    return watcher;
  });
  const registry = new SharedDirectoryWatcher();
  const flat = vi.fn();
  const deep = vi.fn();
  const first = registry.watch("/project", {}, flat);
  const second = registry.watch("/project", { recursive: true }, deep);
  expect(flat).toHaveBeenCalledWith("rename", null);
  watches[1]?.emit("change", "rename", "nested/file");
  expect(deep).toHaveBeenCalledWith("rename", "nested/file");
  expect(flat).toHaveBeenCalledTimes(1);
  second.close();
  expect(native.watch).toHaveBeenCalledTimes(3);
  first.close();
  expect(live).toBe(0);
});

it("fans native failures out to all leases and permits a fresh shared watch", () => {
  const watches: NativeWatch[] = [];
  native.watch.mockImplementation(() => {
    const watcher = new NativeWatch();
    watches.push(watcher);
    return watcher;
  });
  const registry = new SharedDirectoryWatcher();
  const errors = [vi.fn(), vi.fn()];
  const first = registry.watch("/project", {}, vi.fn()).on("error", errors[0]!);
  const second = registry
    .watch("/project", {}, vi.fn())
    .on("error", errors[1]!);
  const failure = new Error("watch lost");
  watches[0]?.emit("error", failure);
  for (const listener of errors) expect(listener).toHaveBeenCalledWith(failure);
  const next = registry.watch("/project", {}, vi.fn());
  first.close();
  second.close();
  expect(watches[1]?.close).not.toHaveBeenCalled();
  next.close();
});

it("filters nested paths using the host's filename semantics", () => {
  const watcher = new NativeWatch();
  native.watch.mockImplementation((_path, _options, listener) => {
    watcher.on("change", listener);
    return watcher;
  });
  const changed = vi.fn();
  const lease = new SharedDirectoryWatcher().watch("/project", {}, changed);
  try {
    watcher.emit("change", "rename", `nested${sep}file.txt`);
    expect(changed).not.toHaveBeenCalled();
    watcher.emit("change", "rename", "a\\b.txt");
    if (sep === "/") {
      expect(changed).toHaveBeenCalledWith("rename", "a\\b.txt");
    } else {
      expect(changed).not.toHaveBeenCalled();
    }
    watcher.emit("change", "rename", "ordinary.txt");
    expect(changed).toHaveBeenLastCalledWith("rename", "ordinary.txt");
  } finally {
    lease.close();
  }
});

it("replaces an old directory inode before sharing a newly acquired lease", () => {
  const watches: NativeWatch[] = [];
  native.watch.mockImplementation(() => {
    const watcher = new NativeWatch();
    watches.push(watcher);
    return watcher;
  });
  const registry = new SharedDirectoryWatcher();
  const changed = vi.fn();
  const first = registry.watch("/project", {}, changed);
  native.ino = 2;
  const second = registry.watch("/project", {}, vi.fn());
  expect(watches[0]?.close).toHaveBeenCalledTimes(1);
  expect(native.watch).toHaveBeenCalledTimes(2);
  expect(changed).toHaveBeenCalledWith("rename", null);
  first.close();
  second.close();
});

it("creates native watches outside the caller's async context", () => {
  const requestContext = new AsyncLocalStorage<{ messages: unknown[] }>();
  const storesAtCreation: unknown[] = [];
  native.watch.mockImplementation(() => {
    storesAtCreation.push(requestContext.getStore());
    return new NativeWatch();
  });
  const registry = new SharedDirectoryWatcher();
  const lease = requestContext.run({ messages: [] }, () =>
    registry.watch("/project", { persistent: false }, vi.fn()),
  );
  expect(native.watch).toHaveBeenCalledTimes(1);
  expect(storesAtCreation).toEqual([undefined]);
  lease.close();
});

it.runIf(process.platform === "darwin")(
  "preserves focused coverage at the budget and transfers leases on a synchronous claim",
  async () => {
    const { FocusedDirectoryWorker } = await import(
      "../../src/watcher/FocusedDirectoryWorker.js"
    );
    const offThread: NativeWatch[] = [];
    const retirements: (() => void)[] = [];
    const worker = vi
      .spyOn(FocusedDirectoryWorker.prototype, "watch")
      .mockImplementation((_path, retire) => {
        const handle = new NativeWatch();
        offThread.push(handle);
        retirements.push(retire);
        return handle as unknown as import("node:fs").FSWatcher;
      });
    native.watch.mockImplementation((_p, _opts, listener) =>
      new NativeWatch().on("change", listener),
    );
    const registry = new SharedDirectoryWatcher();
    const changed = vi.fn();
    const focused = registry.watch("/project", { focused: true }, changed);
    const others = Array.from({ length: 1023 }, (_, i) =>
      registry.watch("/other-" + i, {}, vi.fn()),
    );
    try {
      expect(() => registry.watch("/alias", {}, vi.fn())).toThrow("budget");
      expect(offThread[0]?.close).not.toHaveBeenCalled();
      others.pop()?.close();
      const sync = registry.watch("/alias", {}, vi.fn());
      expect(offThread[0]?.close).toHaveBeenCalledOnce();
      expect(changed).toHaveBeenCalledWith("rename", null);
      expect(() => registry.watch("/extra", {}, vi.fn())).toThrow("budget");
      retirements[0]?.();
      registry.watch("/extra", {}, vi.fn()).close();
      sync.close();
      expect(offThread.length).toBe(2);
      const before = changed.mock.calls.length;
      offThread[0]?.emit("change", "change", "old");
      expect(changed).toHaveBeenCalledTimes(before);
      offThread[1]?.emit("change", "change", "current");
      expect(changed).toHaveBeenLastCalledWith("change", "current");
    } finally {
      focused.close();
      for (const lease of others) lease.close();
      worker.mockRestore();
    }
  },
);

it.runIf(process.platform === "darwin")(
  "shares off-thread watches across asyncReady and focused leases and short-circuits when closes stall",
  async () => {
    const { FocusedDirectoryWorker } = await import(
      "../../src/watcher/FocusedDirectoryWorker.js"
    );
    const offThread: NativeWatch[] = [];
    const worker = vi
      .spyOn(FocusedDirectoryWorker.prototype, "watch")
      .mockImplementation((_path, _retire) => {
        const handle = new NativeWatch();
        offThread.push(handle);
        return handle as unknown as import("node:fs").FSWatcher;
      });
    const blockedSpy = vi
      .spyOn(FocusedDirectoryWorker.prototype, "isBlockedInClose")
      .mockReturnValue(false);
    const registry = new SharedDirectoryWatcher();
    const asyncChanged = vi.fn();
    const focusedChanged = vi.fn();
    const asyncLease = registry.watch(
      "/project",
      { asyncReady: true, persistent: false },
      asyncChanged,
    );
    const focusedLease = registry.watch(
      "/alias",
      { focused: true, persistent: false },
      focusedChanged,
    );
    try {
      expect(offThread).toHaveLength(1);
      expect(isDirectoryWatchPending(asyncLease)).toBe(true);
      const readyPromise = waitForDirectoryWatchReady(asyncLease, 1_000);
      offThread[0]?.emit("ready");
      expect(await readyPromise).toBe(true);
      expect(isDirectoryWatchPending(asyncLease)).toBe(false);
      // Focused leases receive the synthetic unnamed change on ready; asyncReady
      // leases do not, since they await native readiness directly.
      expect(focusedChanged).toHaveBeenCalledWith("rename", null);
      expect(asyncChanged).not.toHaveBeenCalled();

      // Joining an already-live entry succeeds immediately even when worker
      // closes are stalled, while opening a brand-new asyncReady entry fails fast.
      blockedSpy.mockReturnValue(true);
      const joined = registry.watch(
        "/project",
        { asyncReady: true, persistent: false },
        vi.fn(),
      );
      expect(isDirectoryWatchPending(joined)).toBe(false);
      joined.close();

      expect(() =>
        registry.watch(
          "/other-dir",
          { asyncReady: true, persistent: false },
          vi.fn(),
        ),
      ).toThrow("busy");
      expect(isDirectoryWatchStalled(asyncLease)).toBe(true);
      blockedSpy.mockReturnValue(false);
      expect(isDirectoryWatchStalled(asyncLease)).toBe(false);

      // Transitioning from a synchronous watch back to an off-thread watch
      // resets lease readiness until the replacement worker handle is ready.
      native.watch.mockImplementation((_p, _opts, listener) =>
        new NativeWatch().on("change", listener),
      );
      const syncLease = registry.watch("/project", {}, vi.fn());
      expect(isDirectoryWatchPending(asyncLease)).toBe(false);
      syncLease.close();
      expect(offThread).toHaveLength(2);
      expect(isDirectoryWatchPending(asyncLease)).toBe(true);
      const reattach = waitForDirectoryWatchReady(asyncLease, 1_000);
      offThread[1]?.emit("ready");
      expect(await reattach).toBe(true);

      // Closing a previously-ready lease reports ready=false immediately.
      asyncLease.close();
      expect(await waitForDirectoryWatchReady(asyncLease, 1_000)).toBe(false);

      // An off-thread lease that errors before ever reaching ready reports
      // wasDirectoryWatchAttached() === false.
      const failing = registry.watch(
        "/failing",
        { asyncReady: true, persistent: false },
        vi.fn(),
      );
      const err = vi.fn();
      failing.on("error", err);
      offThread[2]?.emit(
        "error",
        Object.assign(new Error("no space"), { code: "ENOSPC" }),
      );
      expect(err).toHaveBeenCalledOnce();
      expect(wasDirectoryWatchAttached(failing)).toBe(false);
      expect(wasDirectoryWatchAttached(focusedLease)).toBe(true);
    } finally {
      asyncLease.close();
      focusedLease.close();
      blockedSpy.mockRestore();
      worker.mockRestore();
    }
  },
);
