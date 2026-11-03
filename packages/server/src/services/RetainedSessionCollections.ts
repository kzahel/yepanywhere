import { getProjectIdentityKey } from "../projects/paths.js";
import { stat } from "node:fs/promises";
import {
  fromUrlProjectId,
  type UrlProjectId,
  type RetainedSessionCollectionState,
} from "@yep-anywhere/shared";
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
import {
  catalogProjects,
  catalogStoreKey,
  type CatalogProjectsView,
  type CatalogProjectStore,
} from "../projects/catalog-projects.js";
import {
  SessionCatalogService,
  type SessionCatalogSnapshot,
} from "./SessionCatalogService.js";

export interface RetainedSessionCollectionsOptions {
  dataDir: string;
  adapters: (
    rows: readonly Readonly<SessionCatalogRow>[],
    signal: AbortSignal,
    changedPaths?: ReadonlySet<string>,
    sources?: readonly CatalogProjectStore[],
  ) => Promise<NativeSessionCatalogAdapter[]>;
  eventBus?: EventBus;
  projectStores?: () => readonly CatalogProjectStore[];
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
  private projectView: CatalogProjectsView = {
    projects: [],
    complete: false,
    version: "uninitialized",
  };
  private projectProjectionKey?: string;
  private projectStoresKey?: string;
  private projectedStoresKey?: string;

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

  /** Restore one accepted project shard without discovery, enrichment or adoption. */
  async readPublishedProjectRows(
    projectId: UrlProjectId,
  ): Promise<readonly Readonly<SessionCatalogRow>[]> {
    this.controller.signal.throwIfAborted();
    await this.initialize();
    this.controller.signal.throwIfAborted();
    const accepted = await this.catalog.readProjectRows(
      getProjectIdentityKey(fromUrlProjectId(projectId)),
      { recoverUnreadable: false },
    );
    this.controller.signal.throwIfAborted();
    return accepted.rows;
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

  peekProjects(): CatalogProjectsView {
    const stores = this.options.projectStores?.() ?? [];
    if (!stores.length)
      return { projects: [], complete: true, version: "unused" };
    if (this.projectedStoresKey !== JSON.stringify(stores.map(catalogStoreKey)))
      return {
        projects: [],
        complete: false,
        version: "uninitialized",
        refreshing: Boolean(this.work || this.timer),
      };
    return {
      ...this.projectView,
      refreshing: Boolean(this.work || this.timer),
      ...(this.refreshError ? { refreshError: this.refreshError } : {}),
    };
  }

  async readProjects(refresh = false): Promise<CatalogProjectsView> {
    if (!this.options.projectStores?.().length) return this.peekProjects();
    await this.initialize();
    this.controller.signal.throwIfAborted();
    const storesKey = JSON.stringify(
      this.options.projectStores!().map(catalogStoreKey),
    );
    if (storesKey !== this.projectStoresKey) {
      this.projectStoresKey = storesKey;
      this.invalidate();
    }
    if (refresh && (this.work || (this.dirty && Date.now() >= this.retryAfter)))
      await this.refresh();
    const accepted = await this.catalog.readRows();
    this.controller.signal.throwIfAborted();
    this.updateProjects(accepted);
    this.schedule();
    return this.peekProjects();
  }

  private updateProjects(accepted: {
    snapshot: SessionCatalogSnapshot;
    rows: readonly Readonly<SessionCatalogRow>[];
  }): void {
    const token = this.catalog.getToken();
    if (
      accepted.snapshot.catalogEpoch !== token.catalogEpoch ||
      accepted.snapshot.catalogGeneration !== token.catalogGeneration
    )
      return;
    const stores = this.options.projectStores?.() ?? [];
    const key = JSON.stringify([
      accepted.snapshot.catalogEpoch,
      accepted.snapshot.catalogGeneration,
      stores.map(catalogStoreKey),
    ]);
    if (key === this.projectProjectionKey) return;
    const next = catalogProjects(
      accepted.rows,
      accepted.snapshot.providerSources,
      stores,
    );
    if (next.version !== this.projectView.version) this.projectView = next;
    this.projectProjectionKey = key;
    this.projectedStoresKey = JSON.stringify(stores.map(catalogStoreKey));
    this.projectStoresKey = this.projectedStoresKey;
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
      previous.snapshot.providerSources,
    );
    this.controller.signal.throwIfAborted();
    await this.catalog.reconcile(adapters);

    // The first publication is usable before any optional tail is opened.
    const accepted = await this.catalog.readRows();
    this.updateProjects(accepted);
    this.publish();
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
      await this.catalog.reconcile(
        catalogAdaptersForRows(enriched, accepted.snapshot.providerSources),
      );
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
