import {
  applyCollectionUpdate,
  type CollectionUpdate,
  type CollectionView,
} from "@yep-anywhere/shared/collection-updates";
import type { YaSourceRuntime } from "./sourceRuntime";
import {
  createManagedStream,
  type ManagedStream,
} from "./transport/ManagedStream";
import { activityBus } from "./activityBus";
import { cancelPendingQueryRevalidation } from "./clientQueryRevalidation";

interface Consumer {
  metadataFields?: boolean;
  path: string;
  rows: number;
  publish(body: Record<string, unknown>): Promise<void>;
  fallback(): void;
  onLiveChange?(live: boolean): void;
}
interface Entry {
  key: string;
  consumers: Set<Consumer>;
  holds: number;
  minimumRows: number;
  disabled: boolean;
  active: boolean;
  expanding?: boolean;
  decoded?: { revision: number; view: CollectionView };
  epoch: number;
}
/** Weak source owner; entries and stream disappear with the final mounted query. */
const owners = new WeakMap<YaSourceRuntime, CollectionUpdateOwner>();

function waitForRetry(deadline: number, signal: AbortSignal): Promise<void> {
  const delay = deadline - Date.now();
  if (delay <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, delay);
    signal.addEventListener("abort", finish, { once: true });
  });
}
class CollectionUpdateOwner {
  readonly transport;
  private readonly entries = new Map<string, Entry>();
  private stream?: ManagedStream;
  private queued = false;
  private disposed = false;
  private signature = "";
  // Source-owned cooldown survives REST pause/resume and query-set rebuilds.
  private retryAt = 0;
  private failures = 0;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private removeVisibility?: () => void;
  private removeReconnect?: () => void;
  private readonly hide = () => {
    this.suspended = true;
    this.rebuild();
  };
  private readonly show = () => {
    this.suspended = false;
    this.signature = "";
    this.rebuild();
  };
  private suspended = false;
  constructor(private readonly runtime: YaSourceRuntime) {
    this.transport = runtime.transport;
    this.removeVisibility = this.transport.status.subscribeVisibilityRestored?.(
      () => this.refresh(),
    );
    this.removeReconnect = activityBus.onSource(
      runtime.sourceKey,
      "reconnect",
      () => this.refresh(),
    );
    window.addEventListener("pagehide", this.hide);
    window.addEventListener("pageshow", this.show);
  }
  private entry(key: string) {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        key,
        consumers: new Set(),
        holds: 0,
        minimumRows: 0,
        disabled: false,
        active: false,
        epoch: 0,
      };
      this.entries.set(key, entry);
    }
    return entry;
  }
  retain(key: string, consumer: Consumer) {
    const entry = this.entry(key);
    entry.consumers.add(consumer);
    consumer.onLiveChange?.(entry.active);
    this.rebuild();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      entry.consumers.delete(consumer);
      this.retireUnused(entry);
      this.rebuild();
    };
  }
  private retireUnused(entry: Entry) {
    if (entry.consumers.size || entry.holds) return;
    // React may replace a consumer's coverage in the same effect flush. Keep
    // the entry and pending expansion until that synchronous handover finishes.
    queueMicrotask(() => {
      if (
        this.disposed ||
        entry.consumers.size ||
        entry.holds ||
        this.entries.get(entry.key) !== entry
      )
        return;
      this.entries.delete(entry.key);
      this.signature = "";
      if (!this.entries.size) this.close();
      else this.rebuild();
    });
  }
  private setLive(entry: Entry, live: boolean) {
    if (entry.active === live) return;
    entry.active = live;
    for (const consumer of entry.consumers) consumer.onLiveChange?.(live);
  }
  live(key: string) {
    return this.entries.get(key)?.active === true;
  }
  coverage(key: string) {
    return this.entries.get(key)?.minimumRows ?? 0;
  }
  expand(key: string, rows: number) {
    const entry = this.entries.get(key);
    if (
      !entry ||
      entry.holds ||
      entry.disabled ||
      rows > 500 ||
      (!entry.active && !entry.expanding)
    )
      return false;
    entry.minimumRows = Math.max(rows, entry.minimumRows);
    entry.expanding = true;
    this.rebuild();
    return true;
  }
  pause(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return () => {};
    entry.holds++;
    this.setLive(entry, false);
    entry.epoch++;
    this.signature = "";
    this.rebuild();
    let resumed = false;
    return (rows = 0) => {
      if (resumed || this.disposed) return;
      resumed = true;
      entry.minimumRows = Math.max(rows, entry.minimumRows);
      entry.disabled ||= entry.minimumRows > 500;
      entry.holds--;
      this.retireUnused(entry);
      this.rebuild();
    };
  }
  private selected() {
    const queries = new Map<string, Entry>();
    if (this.suspended) return queries;
    for (const entry of this.entries.values()) {
      if (entry.holds || entry.disabled || !entry.consumers.size) continue;
      const consumer = [...entry.consumers].sort((a, b) => b.rows - a.rows)[0]!;
      const url = new URL(consumer.path, "http://collection.invalid");
      if (url.pathname === "/sessions")
        url.searchParams.set(
          "limit",
          String(Math.max(entry.minimumRows, consumer.rows)),
        );
      queries.set(url.pathname + url.search, entry);
    }
    return queries;
  }
  private rebuild() {
    if (this.queued || this.disposed) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      if (this.disposed) return;
      const queries = this.selected();
      const queryNames = JSON.stringify([...queries.keys()].sort());
      const metadataFields = [...queries.values()].every((entry) =>
        [...entry.consumers].every((consumer) => consumer.metadataFields),
      );
      const signature = JSON.stringify([queryNames, metadataFields]);
      if (signature === this.signature) return;
      this.signature = signature;
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
      this.stream?.close();
      this.stream = undefined;
      for (const entry of this.entries.values()) {
        this.setLive(entry, false);
        entry.decoded = undefined;
      }
      if (!queries.size || queries.size > 8) return;
      if (this.retryAt > Date.now()) {
        this.retryTimer = setTimeout(() => {
          this.retryTimer = undefined;
          this.signature = "";
          this.rebuild();
        }, this.retryAt - Date.now());
        return;
      }
      this.stream = createManagedStream(this.transport, {
        subscribe: ({ transport, handlers }) => {
          const epochs = new Map(
            [...queries.values()].map((entry) => [entry, entry.epoch]),
          );
          const abort = new AbortController();
          const path =
            "/activity/collections?queries=" +
            encodeURIComponent(queryNames) +
            (metadataFields ? "&metadata=fields" : "");
          let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
          for (const entry of queries.values()) {
            this.setLive(entry, false);
            entry.decoded = undefined;
          }
          void (async () => {
            await waitForRetry(this.retryAt, abort.signal);
            if (abort.signal.aborted) return;
            const response = await (transport.fetchStream
              ? transport.fetchStream(path, { signal: abort.signal })
              : transport.fetchResponse(path, { signal: abort.signal }));
            if (abort.signal.aborted) {
              await response.body?.cancel().catch(() => {});
              return;
            }
            if (
              !response.ok ||
              !response.headers
                .get("Content-Type")
                ?.includes("application/x-ndjson") ||
              !response.body
            )
              throw new Error("Collection updates unavailable");
            reader = response.body.getReader();
            let opened = false;
            const initializing = new Set(queries.keys());
            const decoder = new TextDecoder();
            let buffer = "";
            for (;;) {
              const chunk = await reader.read();
              if (chunk.done) break;
              buffer += decoder.decode(chunk.value, { stream: true });
              let end = buffer.indexOf("\n");
              while (end >= 0) {
                if (end > 2 * 1024 ** 2)
                  throw new Error("Oversized collection update frame");
                const line = buffer.slice(0, end);
                buffer = buffer.slice(end + 1);
                if (!abort.signal.aborted) {
                  const update = JSON.parse(line) as CollectionUpdate;
                  const entry = queries.get(update.query);
                  if (entry && epochs.get(entry) === entry.epoch) {
                    handlers.onEvent("collection", undefined, update);
                    initializing.delete(update.query);
                    if (!opened && !initializing.size) {
                      this.failures = 0;
                      this.retryAt = 0;
                      opened = true;
                      handlers.onOpen?.();
                    }
                  }
                }
                end = buffer.indexOf("\n");
              }
              if (buffer.length > 2 * 1024 ** 2)
                throw new Error("Oversized collection update frame");
            }
            if (!abort.signal.aborted) handlers.onClose?.();
          })()
            .catch((error: unknown) => {
              if (!abort.signal.aborted)
                handlers.onError?.(
                  error instanceof Error ? error : new Error(String(error)),
                );
            })
            .finally(() => {
              void reader?.cancel().catch(() => {});
              reader?.releaseLock();
            });
          return {
            close: () => {
              abort.abort();
              void reader?.cancel().catch(() => {});
            },
          };
        },
        onEvent: ({ data }) => {
          const update = data as CollectionUpdate;
          const entry = queries.get(update.query);
          if (
            !entry ||
            entry.holds ||
            entry.disabled ||
            !entry.consumers.size ||
            this.entries.get(entry.key) !== entry
          )
            return;
          const decoded = applyCollectionUpdate(entry.decoded, update);
          entry.decoded = decoded;
          this.setLive(entry, true);
          entry.expanding = false;
          cancelPendingQueryRevalidation(this.runtime.sourceKey, entry.key);
          const consumer = [...entry.consumers][0]!;
          void consumer.publish(decoded.body).catch(() => this.refresh());
        },
        onError: () => this.unavailable(queries),
        onClose: () => this.unavailable(queries),
      });
    });
  }
  private unavailable(queries: Map<string, Entry>) {
    this.retryAt =
      Date.now() + Math.min(5_000, 250 * 2 ** Math.min(this.failures++, 5));
    for (const entry of queries.values()) {
      this.setLive(entry, false);
      entry.expanding = false;
      [...entry.consumers][0]?.fallback();
    }
  }
  refresh() {
    this.retryAt = 0;
    this.signature = "";
    this.rebuild();
  }
  close() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.stream?.close();
    this.stream = undefined;
    this.removeVisibility?.();
    this.removeReconnect?.();
    window.removeEventListener("pagehide", this.hide);
    window.removeEventListener("pageshow", this.show);
    owners.delete(this.runtime);
    for (const entry of this.entries.values()) this.setLive(entry, false);
    this.entries.clear();
  }
}
function owner(runtime: YaSourceRuntime) {
  let current = owners.get(runtime);
  if (current && current.transport !== runtime.transport) {
    current.close();
    current = undefined;
  }
  if (!current) {
    current = new CollectionUpdateOwner(runtime);
    owners.set(runtime, current);
  }
  return current;
}
export function retainCollectionUpdates(
  runtime: YaSourceRuntime,
  key: string,
  consumer: Consumer,
) {
  return owner(runtime).retain(key, consumer);
}
export function collectionQueryIsLive(runtime: YaSourceRuntime, key: string) {
  return owners.get(runtime)?.live(key) ?? false;
}
/** REST refresh/pagination owns the query until accepted; reopening reads fresh SQL. */
export function pauseCollectionUpdates(runtime: YaSourceRuntime, key: string) {
  return owners.get(runtime)?.pause(key) ?? (() => {});
}

/** Grow the authoritative first window without timestamp-cursor pagination. */
export function expandCollectionUpdates(
  runtime: YaSourceRuntime,
  key: string,
  rows: number,
) {
  return owners.get(runtime)?.expand(key, rows) ?? false;
}

/** Pending live-window coverage must also be fulfilled by REST fallback. */
export function collectionQueryCoverage(runtime: YaSourceRuntime, key: string) {
  return owners.get(runtime)?.coverage(key) ?? 0;
}
