import { once } from "node:events";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import { runIdleSweeps } from "../../src/lib/processIdleSweep.js";
import { FocusedDirectoryWorker } from "../../src/watcher/FocusedDirectoryWorker.js";

it("retires cancelled interest and attaches a real directory while the old worker exits", async () => {
  const dir = await realpath(
    await mkdtemp(join(tmpdir(), "focused-directory-")),
  );
  const host = new FocusedDirectoryWorker();
  const acquire = () => {
    const retired = Promise.withResolvers<void>();
    return {
      watch: host.watch(dir, retired.resolve).ref(),
      retired: retired.promise,
    };
  };
  const skipped = acquire();
  const stale = vi.fn();
  skipped.watch.on("change", stale);
  skipped.watch.close();
  await skipped.retired;
  runIdleSweeps(Date.now());
  const next = acquire();
  try {
    // The previous worker has finished its last close and may still be exiting.
    expect(await once(next.watch, "change")).toEqual(["rename", null]);
    const retired = Promise.withResolvers<void>();
    const missing = host.watch(join(dir, "missing"), retired.resolve);
    try {
      expect((await once(missing, "error"))[0]).toMatchObject({
        code: "ENOENT",
      });
    } finally {
      missing.close();
      await retired.promise;
    }
    expect(stale).not.toHaveBeenCalled();
  } finally {
    next.watch.close();
    await next.retired;
    runIdleSweeps(Date.now());
    await rm(dir, { recursive: true, force: true });
  }
  // This joins actual native disposal. A single Darwin close was sampled at
  // more than six seconds; this is a cleanup deadline, not the server-loop gate.
}, 20_000);

it("retains in-flight slots until worker exit and delivers failure only to live leases", async () => {
  // This worker holds the registrations without acknowledging release, then
  // crashes. Exercise kernel teardown without depending on native close time.
  const worker = new Worker(
    "require('node:worker_threads').parentPort.on('message', () => {})",
    { eval: true, execArgv: [] },
  );
  const host = new FocusedDirectoryWorker(() => worker);
  const retired = vi.fn();
  const removed = host.watch("/cancelled", retired);
  const live = host.watch("/live", retired).ref();
  const error = once(live, "error");
  removed.close();
  expect(retired).not.toHaveBeenCalled();
  await worker.terminate();
  expect((await error)[0]).toBeInstanceOf(Error);
  expect(retired).toHaveBeenCalledTimes(2);
  live.close();
  expect(() => host.watch("/later", retired)).toThrow(
    "temporarily unavailable",
  );
});
