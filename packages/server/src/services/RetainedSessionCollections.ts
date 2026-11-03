import { stat } from "node:fs/promises";
import type { RetainedSessionCollectionState } from "@yep-anywhere/shared";
import {
  catalogAdaptersForRows,
  catalogFileVersion,
} from "../sessions/catalog-adapters/row.js";
import type {
  NativeSessionCatalogAdapter,
  SessionCatalogRow,
} from "../sessions/catalog-types.js";
import { readCodexAsyncQuestions } from "../sessions/codex-async-questions.js";
import type { EventBus } from "../watcher/EventBus.js";
import { SessionCatalogService } from "./SessionCatalogService.js";

export interface RetainedSessionCollectionsOptions {
  dataDir: string;
  adapters: (
    rows: readonly Readonly<SessionCatalogRow>[],
    signal: AbortSignal,
    changedPaths?: ReadonlySet<string>,
  ) => Promise<NativeSessionCatalogAdapter[]>;
  eventBus?: EventBus;
  shouldReadQuestions?: (row: Readonly<SessionCatalogRow>) => boolean;
}

/** One durable catalog and one finite refresh, shared by every collection query. */
export class RetainedSessionCollections {
  private readonly catalog: SessionCatalogService;
  private initialization?: Promise<void>;
  private work?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly controller = new AbortController();
  private unsubscribe?: () => void;
  private dirty = true;
  private discover = true;
  private readonly changedPaths = new Set<string>();
  private retryAfter = 0;
  private refreshError?: string;
  private initialized = false;

  constructor(private readonly options: RetainedSessionCollectionsOptions) {
    this.catalog = new SessionCatalogService({
      dataDir: options.dataDir,
      maxRowBytes: 256 * 1024,
      // An unreadable generation empties the catalog; rebuild it from every
      // provider store rather than from the rows it just lost.
      onLineageReset: () => this.invalidate(),
    });
  }

  private initialize(): Promise<void> {
    this.initialization ??= this.catalog.initialize().then(() => {
      this.initialized = true;
      if (this.controller.signal.aborted) return;
      this.unsubscribe = this.options.eventBus?.subscribe((event) => {
        if (event.type === "session-created") {
          this.invalidate();
        } else if (
          event.type === "file-change" &&
          event.fileType === "session"
        ) {
          this.invalidate(event.path);
        } else if (
          event.type === "session-metadata-changed" &&
          event.archived === false
        ) {
          // Reconsider deferred questions without rediscovering unchanged files.
          this.dirty = true;
          this.schedule();
        }
      });
    });
    return this.initialization;
  }

  private state(): RetainedSessionCollectionState {
    const snapshot = this.catalog.getSnapshot();
    return {
      catalogEpoch: snapshot.catalogEpoch,
      catalogGeneration: snapshot.catalogGeneration,
      complete: snapshot.catalogGeneration > 0,
      refreshing: Boolean(this.work || this.timer),
      ...(this.refreshError ? { refreshError: this.refreshError } : {}),
    };
  }

  /** Cache invalidation follows accepted catalog publications, not raw events. */
  getVersion(): string | undefined {
    if (!this.initialized) return undefined;
    const token = this.catalog.getToken();
    return `${token.catalogEpoch}:${token.catalogGeneration}`;
  }

  /** Optional projections cannot initialize discovery or schedule a refresh. */
  async readPublishedRows() {
    this.controller.signal.throwIfAborted();
    return this.initialized
      ? this.catalog.readRows({ recoverUnreadable: false })
      : { rows: [] };
  }

  async read() {
    await this.initialize();
    this.controller.signal.throwIfAborted();
    this.schedule();
    const result = await this.catalog.readRows();
    return {
      rows: result.rows,
      catalog: {
        ...this.state(),
        catalogEpoch: result.snapshot.catalogEpoch,
        catalogGeneration: result.snapshot.catalogGeneration,
        complete: result.snapshot.catalogGeneration > 0,
      },
    };
  }

  invalidate(path?: string): void {
    this.dirty = true;
    if (path && this.changedPaths.size < 1024) this.changedPaths.add(path);
    else this.discover = true;
    this.schedule();
  }

  private schedule(): void {
    if (
      !this.initialization ||
      !this.dirty ||
      this.work ||
      this.timer ||
      this.controller.signal.aborted ||
      Date.now() < this.retryAfter
    )
      return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.refresh();
    }, 300);
    this.timer.unref?.();
  }

  /** Explicit refresh is also the finite operation joined by lifecycle tests. */
  refresh(): Promise<void> {
    if (this.controller.signal.aborted) return Promise.resolve();
    if (this.work) return this.work;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const changedPaths = this.discover ? undefined : new Set(this.changedPaths);
    this.discover = false;
    this.changedPaths.clear();
    this.dirty = false;
    this.refreshError = undefined;
    this.work = this.initialize()
      .then(() => this.reconcile(changedPaths))
      .catch((error: unknown) => {
        if (this.controller.signal.aborted) return;
        this.dirty = true;
        this.discover = true;
        this.retryAfter = Date.now() + 5_000;
        this.refreshError =
          error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        this.work = undefined;
        if (!this.controller.signal.aborted && this.initialized) {
          this.publish();
          this.schedule();
        }
      });
    return this.work;
  }

  private publish(): void {
    this.options.eventBus?.emit({
      type: "session-catalog-updated",
      catalog: this.state(),
      timestamp: new Date().toISOString(),
    });
  }

  private async reconcile(changedPaths?: ReadonlySet<string>): Promise<void> {
    const previous = await this.catalog.readRows();
    const adapters = await this.options.adapters(
      previous.rows,
      this.controller.signal,
      changedPaths,
    );
    this.controller.signal.throwIfAborted();
    await this.catalog.reconcile(adapters);
    this.publish();

    // The first publication is usable before any optional tail is opened.
    const accepted = await this.catalog.readRows();
    const enriched: SessionCatalogRow[] = [];
    let changed = false;
    for (const row of accepted.rows) {
      this.controller.signal.throwIfAborted();
      if (
        row.catalogFamily !== "codex" ||
        row.location.kind !== "file" ||
        row.asyncQuestions !== undefined ||
        !this.options.shouldReadQuestions?.(row)
      ) {
        enriched.push(row);
        continue;
      }
      const filePath = row.location.path;
      try {
        const before = catalogFileVersion(await stat(filePath));
        if (before !== row.sourceVersion) {
          this.invalidate(filePath);
          enriched.push(row);
          continue;
        }
        const asyncQuestions = await readCodexAsyncQuestions(filePath);
        if (catalogFileVersion(await stat(filePath)) !== before) {
          this.invalidate(filePath);
          enriched.push(row);
          continue;
        }
        enriched.push(
          asyncQuestions === undefined ? row : { ...row, asyncQuestions },
        );
        changed ||= asyncQuestions !== undefined;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        this.invalidate(filePath);
        enriched.push(row);
      }
    }
    if (changed) {
      this.controller.signal.throwIfAborted();
      await this.catalog.reconcile(catalogAdaptersForRows(enriched));
    }
  }

  async dispose(): Promise<void> {
    this.controller.abort();
    this.unsubscribe?.();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.catalog.stop();
    await this.work;
  }
}
