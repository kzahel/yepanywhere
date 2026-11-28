import { EventEmitter } from "node:events";
import type { FSWatcher } from "node:fs";
import { Worker } from "node:worker_threads";
import { runOutsideRequestContext } from "../lib/outsideRequestContext.js";
import { registerIdleSweep } from "../lib/processIdleSweep.js";

type Reply =
  | { id: number; type: "change"; event: string; filename: string | null }
  | { id: number; type: "ready" | "released" }
  | { id: number; type: "error"; message: string; code?: string };

class WorkerWatch extends EventEmitter implements FSWatcher {
  readonly cancelled = new Int32Array(new SharedArrayBuffer(4));
  private persistent = false;
  sent = false;

  constructor(
    readonly id: number,
    readonly path: string,
    readonly retired: () => void,
    private readonly host: FocusedDirectoryWorker,
    readonly emitChangeOnReady: boolean,
  ) {
    super();
  }

  close(): void {
    if (Atomics.exchange(this.cancelled, 0, 1)) return;
    this.unref();
    this.removeAllListeners();
    this.host.release(this);
  }

  ref(): this {
    if (!this.persistent && !Atomics.load(this.cancelled, 0)) {
      this.persistent = true;
      this.host.reference(1);
    }
    return this;
  }

  unref(): this {
    if (this.persistent) {
      this.persistent = false;
      this.host.reference(-1);
    }
    return this;
  }
}

// A retiring handle counts against the shared registry's native budget until
// the worker confirms close. At most one open and one close can queue per slot.
const DEFAULT_CLOSE_STALL_THRESHOLD_MS = 250;

export class FocusedDirectoryWorker {
  private worker: Worker | null = null;
  private booted = false;
  private stopping = false;
  private references = 0;
  private nextId = 1;
  private watches = new Map<number, WorkerWatch>();
  private closing = new Map<number, number>();
  private idleWaiters = new Set<() => void>();
  private inStallEpisode = false;
  private stallGeneration = 0;

  private retryAt = 0;
  private cancelIdleSweep?: () => void;
  constructor(
    private readonly createWorker = () =>
      new Worker(new URL("./focused-directory-worker.mjs", import.meta.url), {
        execArgv: [],
      }),
  ) {}

  watch(
    path: string,
    retired: () => void,
    options?: { emitChangeOnReady?: boolean },
  ): FSWatcher {
    const watch = new WorkerWatch(
      this.nextId++,
      path,
      retired,
      this,
      options?.emitChangeOnReady ?? true,
    );
    this.watches.set(watch.id, watch);
    try {
      if (!this.stopping) this.send(watch);
    } catch (error) {
      this.watches.delete(watch.id);
      throw error;
    }
    return watch;
  }

  /** Whether an in-flight native close has already stalled the worker thread. */
  isBlockedInClose(thresholdMs = DEFAULT_CLOSE_STALL_THRESHOLD_MS): boolean {
    const oldest = this.closing.values().next().value;
    return oldest !== undefined && Date.now() - oldest >= thresholdMs;
  }

  /** Wait until all in-flight native closes have been acknowledged by the worker. */
  waitForPendingCloses(): Promise<void> {
    if (this.closing.size === 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.idleWaiters.add(resolve);
    });
  }

  /** Monotonic generation that advances once on stall entry and once on recovery. */
  getStallGeneration(): number {
    const stalled = this.isBlockedInClose();
    if (stalled !== this.inStallEpisode) {
      this.inStallEpisode = stalled;
      this.stallGeneration += 1;
    }
    return this.stallGeneration;
  }

  /** Whether a new request must wait for a worker isolate to boot or restart. */
  isBooting(): boolean {
    return !this.booted || this.stopping;
  }

  private send(watch: WorkerWatch): void {
    if (!this.worker) {
      if (Date.now() < this.retryAt)
        throw new Error("Directory watch worker temporarily unavailable");
      let worker: Worker;
      try {
        worker = runOutsideRequestContext(this.createWorker);
      } catch (error) {
        this.retryAt = Date.now() + 30_000;
        throw error;
      }
      this.worker = worker;
      // The worker can serve the next click after its last native handle
      // closes. Share one sweep registration for the lifetime of this thread.
      this.cancelIdleSweep = registerIdleSweep(() => {
        if (this.watches.size || this.stopping) return;
        this.stopping = true;
        void worker.terminate();
      });
      let failure: Error | undefined;
      worker.on("error", (error) => {
        failure = error;
        this.stopping = true;
      });
      worker.on("message", (reply: Reply) => this.receive(reply));
      worker.once("exit", () => {
        if (failure || !this.stopping) this.retryAt = Date.now() + 30_000;
        this.cancelIdleSweep?.();
        this.cancelIdleSweep = undefined;
        this.worker = null;
        this.booted = false;
        this.stopping = false;
        // Only posted watches belonged to this worker. Requests that arrived
        // during termination are dispatched together on its successor.
        const lost = [...this.watches.values()].filter((watch) => watch.sent);
        for (const watch of lost) this.forget(watch);
        for (const watch of lost) {
          if (!Atomics.load(watch.cancelled, 0))
            watch.emit(
              "error",
              failure ?? new Error("Directory watch worker exited"),
            );
        }
        for (const pending of this.watches.values()) {
          if (pending.sent) continue;
          try {
            this.send(pending);
          } catch (error) {
            this.forget(pending);
            pending.emit("error", error);
          }
        }
      });
      this.updateReferences();
    }
    this.worker.postMessage({
      id: watch.id,
      path: watch.path,
      cancelled: watch.cancelled,
    });
    watch.sent = true;
  }

  release(watch: WorkerWatch): void {
    if (!this.watches.has(watch.id)) return;
    if (watch.sent) {
      if (!this.closing.has(watch.id)) this.closing.set(watch.id, Date.now());
      this.worker?.postMessage({ id: watch.id });
    } else this.forget(watch);
  }

  private forget(watch: WorkerWatch): void {
    const closeStartedAt = this.closing.get(watch.id);
    this.watches.delete(watch.id);
    this.closing.delete(watch.id);
    if (this.closing.size === 0 && this.idleWaiters.size > 0) {
      const waiters = [...this.idleWaiters];
      this.idleWaiters.clear();
      for (const resolve of waiters) resolve();
    }
    watch.unref();
    watch.retired();
    if (
      closeStartedAt !== undefined &&
      (this.inStallEpisode ||
        Date.now() - closeStartedAt >= DEFAULT_CLOSE_STALL_THRESHOLD_MS)
    ) {
      this.inStallEpisode = this.isBlockedInClose();
      this.stallGeneration += 1;
      if (!this.inStallEpisode) {
        for (const live of [...this.watches.values()]) {
          if (!Atomics.load(live.cancelled, 0)) live.emit("stall-recovered");
        }
      }
    }
  }

  private receive(reply: Reply): void {
    this.booted = true;
    const watch = this.watches.get(reply.id);
    if (!watch) return;
    if (reply.type === "released") {
      this.forget(watch);
    } else if (!Atomics.load(watch.cancelled, 0)) {
      if (reply.type === "error")
        watch.emit(
          "error",
          Object.assign(new Error(reply.message), { code: reply.code }),
        );
      // Validate any change between taking the first file snapshot and the
      // asynchronous attachment. Callers that await readiness consume "ready"
      // directly instead of receiving a synthetic unnamed change event.
      else if (reply.type === "ready") {
        watch.emit("ready");
        if (watch.emitChangeOnReady) watch.emit("change", "rename", null);
      } else if (reply.type === "change")
        watch.emit("change", reply.event, reply.filename);
    }
  }

  reference(delta: 1 | -1): void {
    this.references += delta;
    this.updateReferences();
  }

  private updateReferences(): void {
    if (this.references) this.worker?.ref();
    else this.worker?.unref();
  }
}
