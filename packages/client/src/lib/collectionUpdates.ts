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
  path: string;
  rows: number;
  publish(body: Record<string, unknown>): Promise<void>;
  fallback(): void;
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
class CollectionUpdateOwner {
  readonly transport;
  private readonly entries = new Map<string, Entry>();
  private stream?: ManagedStream;
  private queued = false;
  private disposed = false;
  private signature = "";
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
    const entry = this.entry(key);
    entry.holds++;
    entry.active = false;
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
      const signature = JSON.stringify([...queries.keys()].sort());
      if (signature === this.signature) return;
      this.signature = signature;
      this.stream?.close();
      this.stream = undefined;
      for (const entry of this.entries.values()) {
        entry.active = false;
        entry.decoded = undefined;
      }
      if (!queries.size || queries.size > 8) return;
      this.stream = createManagedStream(this.transport, {
        subscribe: ({ transport, handlers }) => {
          const epochs = new Map(
            [...queries.values()].map((entry) => [entry, entry.epoch]),
          );
          const abort = new AbortController();
          const path =
            "/activity/collections?queries=" + encodeURIComponent(signature);
          let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
          for (const entry of queries.values()) {
            entry.active = false;
            entry.decoded = undefined;
          }
          void (async () => {
            const response = await (transport.fetchStream
              ? transport.fetchStream(path, { signal: abort.signal })
              : transport.fetchResponse(path, { signal: abort.signal }));
            if (
              !response.ok ||
              !response.headers
                .get("Content-Type")
                ?.includes("application/x-ndjson") ||
              !response.body
            )
              throw new Error("Collection updates unavailable");
            reader = response.body.getReader();
            handlers.onOpen?.();
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
                  if (entry && epochs.get(entry) === entry.epoch)
                    handlers.onEvent("collection", undefined, update);
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
          entry.active = true;
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
    for (const entry of queries.values()) {
      entry.active = false;
      entry.expanding = false;
      [...entry.consumers][0]?.fallback();
    }
  }
  refresh() {
    this.stream?.restart();
  }
  close() {
    if (this.disposed) return;
    this.disposed = true;
    this.stream?.close();
    this.stream = undefined;
    this.removeVisibility?.();
    this.removeReconnect?.();
    window.removeEventListener("pagehide", this.hide);
    window.removeEventListener("pageshow", this.show);
    owners.delete(this.runtime);
    for (const entry of this.entries.values()) entry.active = false;
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
