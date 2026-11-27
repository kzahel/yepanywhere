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
  leases: Set<DirectoryWatchLease>;
}

class DirectoryWatchLease extends EventEmitter implements FSWatcher {
  closed = false;
  persistent: boolean;

  constructor(
    readonly recursive: boolean,
    readonly focused: boolean,
    persistent: boolean,
    private readonly release: () => void,
    private readonly updateReferences: () => void,
  ) {
    super();
    this.persistent = persistent;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
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
    options: { recursive?: boolean; persistent?: boolean; focused?: boolean },
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
        native: null,
        leases: new Set(),
      };
      this.entries.set(path, entry);
    }
    const current = entry;
    const lease = new DirectoryWatchLease(
      options.recursive ?? false,
      options.focused ?? false,
      options.persistent ?? true,
      () => this.release(current, lease),
      () => this.updateReferences(current),
    );
    lease.on("change", listener);
    current.leases.add(lease);
    const replacedDirectory = current.identity !== identity;
    try {
      current.identity = identity;
      this.configure(current, lease, replacedDirectory);
    } catch (error) {
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
    // Synchronous consumers claim coverage before reading a directory. Only
    // focused leases can bridge an asynchronous attachment with a file check.
    const offThread =
      process.platform === "darwin" &&
      !recursive &&
      [...entry.leases].every((lease) => lease.focused);
    if (
      entry.native &&
      entry.recursive === recursive &&
      entry.offThread === offThread &&
      !replacedDirectory
    ) {
      this.updateReferences(entry);
      return;
    }
    // An asynchronous close keeps its slot until acknowledged. Reject a
    // joining claimant before dismantling healthy coverage at saturation.
    if (entry.native && entry.offThread && this.slots >= 1024)
      throw this.budgetError();
    const replaced = entry.native;
    entry.native = null;
    this.closeNative(entry, replaced);
    entry.recursive = recursive;
    entry.offThread = offThread;
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
        const handle = this.focusedWorker.watch(entry.path, () => this.slots--);
        return handle.on("change", changed);
      });
    } catch (error) {
      this.slots--;
      throw error;
    }
    entry.native = native;
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

  private fail(entry: WatchEntry, error: Error): void {
    this.entries.delete(entry.path);
    const native = entry.native;
    entry.native = null;
    this.closeNative(entry, native);
    const leases = [...entry.leases];
    entry.leases.clear();
    for (const lease of leases) lease.closed = true;
    for (const lease of leases) {
      lease.emit("error", error);
      lease.emit("close");
    }
  }
}

const directoryWatchers = new SharedDirectoryWatcher();
export const watchSharedDirectory =
  directoryWatchers.watch.bind(directoryWatchers);
