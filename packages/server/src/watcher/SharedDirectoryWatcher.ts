import { EventEmitter } from "node:events";
import { type FSWatcher, realpathSync, statSync, watch } from "node:fs";
import { sep } from "node:path";
import { runOutsideRequestContext } from "../lib/outsideRequestContext.js";
import { FocusedDirectoryWorker } from "./FocusedDirectoryWorker.js";

type Listener = (event: string, filename: string | null) => void;
interface WatchEntry {
  path: string;
  recursive: boolean;
  native: FSWatcher | null;
  identity: string;
  offThread: boolean;
  ready: boolean;
  leases: Set<DirectoryWatchLease>;
}

export interface SharedDirectoryWatchOptions {
  recursive?: boolean;
  persistent?: boolean;
  /** Off-thread macOS lease that bridges async attachment via `("rename", null)`. */
  focused?: boolean;
  /** Off-thread macOS lease whose caller awaits native readiness before reading. */
  asyncReady?: boolean;
}

class DirectoryWatchLease extends EventEmitter implements FSWatcher {
  closed = false;
  persistent: boolean;
  private everReady = false;
  private readyState: "pending" | "ready" | "failed" = "pending";
  private readyPromise: Promise<boolean> | undefined;
  private resolveReady: ((ready: boolean) => void) | null = null;

  constructor(
    readonly recursive: boolean,
    readonly focused: boolean,
    readonly asyncReady: boolean,
    persistent: boolean,
    private readonly release: () => void,
    private readonly updateReferences: () => void,
    private readonly isWorkerBooting: () => boolean,
    private readonly isEntryStalled: () => boolean,
    private readonly getEntryStallGeneration: () => number,
    private readonly getEntryIdentity: () => string,
  ) {
    super();
    this.persistent = persistent;
  }

  isPendingReady(): boolean {
    return !this.closed && this.readyState === "pending";
  }

  wasEverReady(): boolean {
    return this.everReady;
  }

  isStalled(): boolean {
    return !this.closed && this.isEntryStalled();
  }

  getStallGeneration(): number {
    return this.closed ? 0 : this.getEntryStallGeneration();
  }

  getIdentity(): string {
    return this.getEntryIdentity();
  }

  resetPendingReady(): void {
    if (this.closed) return;
    this.readyState = "pending";
  }

  settleReady(ready: boolean): void {
    if (ready) {
      if (this.closed) return;
      this.everReady = true;
      this.readyState = "ready";
    } else {
      this.readyState = "failed";
    }
    const resolve = this.resolveReady;
    this.resolveReady = null;
    this.readyPromise = undefined;
    resolve?.(ready);
  }

  async waitUntilReady(
    timeoutMs: number,
    bootTimeoutMs?: number,
  ): Promise<boolean> {
    if (this.closed || this.readyState === "failed") return false;
    if (this.readyState === "ready") return true;
    if (!this.readyPromise) {
      this.readyPromise = new Promise<boolean>((resolve) => {
        this.resolveReady = resolve;
      });
    }
    const effectiveTimeoutMs =
      bootTimeoutMs !== undefined && this.isWorkerBooting()
        ? Math.max(timeoutMs, bootTimeoutMs)
        : timeoutMs;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.readyPromise,
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), effectiveTimeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.settleReady(false);
    this.release();
    this.emit("close");
  }

  ref(): this {
    this.persistent = true;
    this.updateReferences();
    return this;
  }

  unref(): this {
    this.persistent = false;
    this.updateReferences();
    return this;
  }
}

/** One native watch per canonical directory; consumers own independent leases. */
export class SharedDirectoryWatcher {
  private readonly entries = new Map<string, WatchEntry>();

  private readonly focusedWorker = new FocusedDirectoryWorker();
  private slots = 0;

  watch(
    directory: string,
    options: SharedDirectoryWatchOptions,
    listener: Listener,
  ): FSWatcher {
    const path = realpathSync(directory);
    const { dev, ino } = statSync(path);
    const identity = `${dev}:${ino}`;
    let entry = this.entries.get(path);
    if (!entry) {
      entry = {
        path,
        identity,
        recursive: false,
        offThread: false,
        ready: false,
        native: null,
        leases: new Set(),
      };
      this.entries.set(path, entry);
    }
    const current = entry;
    const lease = new DirectoryWatchLease(
      options.recursive ?? false,
      options.focused ?? false,
      options.asyncReady ?? false,
      options.persistent ?? true,
      () => this.release(current, lease),
      () => this.updateReferences(current),
      () => this.focusedWorker.isBooting(),
      () => current.offThread && this.focusedWorker.isBlockedInClose(),
      () => (current.offThread ? this.focusedWorker.getStallGeneration() : 0),
      () => current.identity,
    );
    lease.on("change", listener);
    current.leases.add(lease);
    const replacedDirectory = current.identity !== identity;
    try {
      current.identity = identity;
      this.configure(current, lease, replacedDirectory);
    } catch (error) {
      lease.settleReady(false);
      current.leases.delete(lease);
      if (!current.native || replacedDirectory)
        this.fail(
          current,
          error instanceof Error ? error : new Error(String(error)),
        );
      throw error;
    }
    return lease;
  }

  private configure(
    entry: WatchEntry,
    joining?: DirectoryWatchLease,
    replacedDirectory = false,
  ): void {
    const recursive = [...entry.leases].some((lease) => lease.recursive);
    // Synchronous consumers claim coverage before reading a directory. Off-thread
    // leases either bridge attachment via a synthetic change (`focused`) or await
    // native readiness before reading (`asyncReady`).
    const offThread =
      process.platform === "darwin" &&
      !recursive &&
      [...entry.leases].every((lease) => lease.focused || lease.asyncReady);
    if (
      entry.native &&
      entry.recursive === recursive &&
      entry.offThread === offThread &&
      !replacedDirectory
    ) {
      if (entry.ready) joining?.settleReady(true);
      this.updateReferences(entry);
      return;
    }
    // An asynchronous close keeps its slot until acknowledged. Reject a
    // joining claimant before dismantling healthy coverage at saturation.
    if (entry.native && entry.offThread && this.slots >= 1024)
      throw this.budgetError();
    if (
      joining?.asyncReady &&
      offThread &&
      this.focusedWorker.isBlockedInClose()
    )
      throw this.busyError();
    const replaced = entry.native;
    entry.native = null;
    this.closeNative(entry, replaced);
    entry.recursive = recursive;
    entry.offThread = offThread;
    entry.ready = !offThread;
    if (this.slots >= 1024) throw this.budgetError();
    this.slots++;
    const changed: Listener = (event, filename) => {
      if (entry.native !== native) return;
      for (const lease of [...entry.leases]) {
        if (
          !lease.closed &&
          (lease.recursive || !filename || !filename.includes(sep))
        )
          lease.emit("change", event, filename);
      }
    };
    let native: FSWatcher;
    try {
      native = runOutsideRequestContext(() => {
        if (!offThread)
          return watch(entry.path, { recursive, persistent: false }, changed);
        const handle = this.focusedWorker.watch(
          entry.path,
          () => this.slots--,
          { emitChangeOnReady: false },
        );
        handle.once("ready", () => {
          if (entry.native !== handle) return;
          entry.ready = true;
          for (const lease of [...entry.leases]) {
            lease.settleReady(true);
            if (!lease.closed && lease.focused)
              lease.emit("change", "rename", null);
          }
        });
        handle.on("stall-recovered", () => {
          if (entry.native !== handle) return;
          for (const lease of [...entry.leases]) {
            if (!lease.closed) lease.emit("stall-recovered");
          }
        });
        return handle.on("change", changed);
      });
    } catch (error) {
      this.slots--;
      throw error;
    }
    entry.native = native;
    if (entry.ready) {
      for (const lease of [...entry.leases]) lease.settleReady(true);
    } else {
      for (const lease of [...entry.leases]) lease.resetPendingReady();
    }
    native.on("error", (error) => {
      if (entry.native === native) this.fail(entry, error);
    });
    native.on("close", () => {
      if (entry.native === native)
        this.fail(entry, new Error("Directory watcher closed unexpectedly"));
    });
    this.updateReferences(entry);
    // A new directory identity or recursive mode creates an observation gap.
    if (replaced) {
      for (const lease of [...entry.leases]) {
        if (lease !== joining && !lease.closed)
          lease.emit("change", "rename", null);
      }
    }
  }

  private budgetError(): Error {
    return Object.assign(new Error("Shared directory watcher budget reached"), {
      code: "EMFILE",
    });
  }

  private busyError(): Error {
    return Object.assign(new Error("Shared directory watch worker is busy"), {
      code: "EBUSY",
    });
  }

  private closeNative(entry: WatchEntry, native: FSWatcher | null): void {
    if (!native) return;
    native.close();
    if (!entry.offThread) this.slots--;
  }

  private release(entry: WatchEntry, lease: DirectoryWatchLease): void {
    entry.leases.delete(lease);
    if (!entry.leases.size) {
      this.entries.delete(entry.path);
      const native = entry.native;
      entry.native = null;
      this.closeNative(entry, native);
    } else {
      try {
        this.configure(entry);
      } catch (error) {
        this.fail(
          entry,
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }
  }

  private updateReferences(entry: WatchEntry): void {
    if ([...entry.leases].some((lease) => lease.persistent))
      entry.native?.ref();
    else entry.native?.unref();
  }

  waitForPendingCloses(): Promise<void> {
    return this.focusedWorker.waitForPendingCloses();
  }

  private fail(entry: WatchEntry, error: Error): void {
    this.entries.delete(entry.path);
    const native = entry.native;
    entry.native = null;
    entry.ready = false;
    this.closeNative(entry, native);
    const leases = [...entry.leases];
    entry.leases.clear();
    for (const lease of leases) {
      lease.closed = true;
      lease.settleReady(false);
    }
    for (const lease of leases) {
      lease.emit("error", error);
      lease.emit("close");
    }
  }
}

export function isDirectoryWatchPending(watcher: FSWatcher): boolean {
  return watcher instanceof DirectoryWatchLease && watcher.isPendingReady();
}

export function wasDirectoryWatchAttached(watcher: FSWatcher): boolean {
  return !(watcher instanceof DirectoryWatchLease) || watcher.wasEverReady();
}

export function isDirectoryWatchStalled(watcher: FSWatcher): boolean {
  return watcher instanceof DirectoryWatchLease && watcher.isStalled();
}

export function getDirectoryWatchStallGeneration(watcher: FSWatcher): number {
  return watcher instanceof DirectoryWatchLease
    ? watcher.getStallGeneration()
    : 0;
}

export function getDirectoryWatchIdentity(
  watcher: FSWatcher,
): string | undefined {
  return watcher instanceof DirectoryWatchLease
    ? watcher.getIdentity()
    : undefined;
}

export function waitForDirectoryWatchReady(
  watcher: FSWatcher,
  timeoutMs: number,
  bootTimeoutMs?: number,
): Promise<boolean> {
  return watcher instanceof DirectoryWatchLease
    ? watcher.waitUntilReady(timeoutMs, bootTimeoutMs)
    : Promise.resolve(true);
}

const directoryWatchers = new SharedDirectoryWatcher();
export const watchSharedDirectory =
  directoryWatchers.watch.bind(directoryWatchers);

export function waitForSharedDirectoryWatchCloses(): Promise<void> {
  return directoryWatchers.waitForPendingCloses();
}
