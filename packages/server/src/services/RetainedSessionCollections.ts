import { getLogger } from "../logging/logger.js";
import { getProjectIdentityKey } from "../projects/paths.js";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
  fromUrlProjectId,
  isYaSessionId,
  type UrlProjectId,
  type RetainedSessionCollectionState,
} from "@yep-anywhere/shared";
import type { SessionIdentityStore } from "../sessions/SessionIdentityStore.js";
import { catalogFileVersion } from "../sessions/catalog-adapters/row.js";
import type {
  NativeSessionCatalogAdapter,
  CatalogFileLookup,
  SessionCatalogRow,
} from "../sessions/catalog-types.js";
import { readCodexAsyncQuestions } from "../sessions/codex-async-questions.js";
import type { SqliteDatabase } from "../storage/sqlite.js";
import type { EventBus } from "../watcher/EventBus.js";
import {
  catalogStoreKey,
  type CatalogProjectsView,
  type CatalogProjectStore,
} from "../projects/catalog-projects.js";
import {
  type SessionCatalogChanges,
  type SessionCatalogReconcilePlan,
  SessionCatalogService,
  type SessionCatalogToken,
} from "./SessionCatalogService.js";

export interface RetainedSessionCollectionsOptions {
  /** YA app-data root; an earlier version's catalog files are below it. */
  dataDir: string;
  /** Profile database holding the catalog tables. */
  database: SqliteDatabase;
  adapters: ((
    rows: readonly Readonly<SessionCatalogRow>[],
    signal: AbortSignal,
    changedPaths?: ReadonlySet<string>,
    sources?: readonly CatalogProjectStore[],
    lookup?: CatalogFileLookup,
  ) => Promise<NativeSessionCatalogAdapter[] | SessionCatalogReconcilePlan>) & {
    /** Explicit opt-in: previous rows contain only the changed files. */
    scoped?: boolean;
  };
  eventBus?: EventBus;
  projectStores?: () => readonly CatalogProjectStore[];
  shouldReadQuestions?: (row: Readonly<SessionCatalogRow>) => boolean;
  /** The native id an event's session id names; undefined while unbound. */
  nativeSessionId?: (sessionId: string) => string | undefined;
  /** How long a created session may take to arrive by its own file. */
  createdSessionGraceMs?: number;
}

/**
 * Families whose provider watcher reports only internally
 * (`internalOnly` in server-main's watcher specs), so their file changes never
 * reach `invalidate(path)`. Every other family's watcher does.
 */
const INTERNALLY_OBSERVED_FAMILIES = new Set(["grok", "opencode"]);

/**
 * The native id an event's session id names. A public YA id resolves through
 * its identity (undefined while unbound); any other id is already native.
 * `isYaSessionId` accepts every opaque id, so only a registered identity
 * distinguishes the two.
 */
export function catalogNativeSessionId(
  identities?: Pick<SessionIdentityStore, "resolveYa">,
): (sessionId: string) => string | undefined {
  return (sessionId) => {
    const identity = isYaSessionId(sessionId)
      ? identities?.resolveYa(sessionId)
      : undefined;
    return identity ? identity.native?.id : sessionId;
  };
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
  private readonly questionIds = new Set<string>();
  /** The catalog generation the project view was last brought to. */
  private projectedToken?: SessionCatalogToken;
  private projectStoresKey?: string;
  private projectedStoresKey?: string;
  /** Created session ids, each with the time its grace period ends. */
  private readonly createdSessions = new Map<string, number>();
  private createdTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly options: RetainedSessionCollectionsOptions) {
    this.catalog = new SessionCatalogService({
      database: options.database,
      legacyCatalogDir: join(options.dataDir, "session-catalog"),
      maxRowBytes: 256 * 1024,
    });
  }

  private initialize(): Promise<void> {
    // A failed start (an I/O error on the legacy files, a busy database) is
    // retried by the next read rather than kept.
    this.initialization ??= this.catalog.initialize().then(
      () => {
        this.initialized = true;
        if (this.controller.signal.aborted) return;
        this.unsubscribe = this.options.eventBus?.subscribe((event) => {
          if (event.type === "session-created") {
            this.awaitCreated(event.session.id);
          } else if (
            event.type === "session-updated" ||
            (event.type === "process-state-changed" &&
              event.activity !== "in-turn")
          ) {
            this.refreshUnwatchedStore(event.sessionId);
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
            const id = this.nativeId(event.sessionId);
            if (id) this.questionIds.add(id);
            this.dirty = true;
            this.schedule();
          }
        });
      },
      (error: unknown) => {
        this.initialization = undefined;
        throw error;
      },
    );
    return this.initialization;
  }

  getState(): RetainedSessionCollectionState {
    const snapshot = this.catalog.getSnapshot();
    return {
      catalogEpoch: snapshot.catalogEpoch,
      catalogGeneration: snapshot.catalogGeneration,
      complete: snapshot.catalogGeneration > 0,
      refreshing: Boolean(this.work || this.timer),
      ...(this.refreshError ? { refreshError: this.refreshError } : {}),
    };
  }

  /** The collection query owner shares this profile's portable SQL connection. */
  get queryDatabase(): SqliteDatabase {
    return this.options.database;
  }
  get querySignal(): AbortSignal {
    return this.controller.signal;
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
    return this.initialized ? this.catalog.readRows() : { rows: [] };
  }

  /** One project's accepted rows without discovery, enrichment or adoption. */
  async readPublishedProjectRows(
    projectId: UrlProjectId,
  ): Promise<readonly Readonly<SessionCatalogRow>[]> {
    this.controller.signal.throwIfAborted();
    await this.initialize();
    this.controller.signal.throwIfAborted();
    const accepted = await this.catalog.readProjectRows(
      getProjectIdentityKey(fromUrlProjectId(projectId)),
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
        ...this.getState(),
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
    this.controller.signal.throwIfAborted();
    this.updateProjects();
    this.schedule();
    return this.peekProjects();
  }

  /**
   * Bring the project view to the published generation from the rows that
   * changed since the generation it shows (gap item 30), rather than folding
   * every row again.
   */
  private updateProjects(): void {
    const stores = this.options.projectStores?.() ?? [];
    const storesKey = JSON.stringify(stores.map(catalogStoreKey));
    const token = this.catalog.getToken();
    const sameStores = storesKey === this.projectedStoresKey;
    if (sameStores && sameToken(token, this.projectedToken)) return;
    const startedAt = performance.now();
    const next = this.catalog.readProjects(stores);
    getLogger().debug(
      {
        projects: next.projects.length,
        durationMs: performance.now() - startedAt,
      },
      "SESSION_CATALOG: projected projects",
    );
    if (next.version !== this.projectView.version) this.projectView = next;
    this.projectedToken = {
      ...token,
    };
    this.projectedStoresKey = storesKey;
    this.projectStoresKey = storesKey;
  }

  /** Rows written and keys removed since `since`; see `SessionCatalogService.readChanges`. */
  async readChanges(
    since?: SessionCatalogToken,
  ): Promise<SessionCatalogChanges> {
    await this.initialize();
    this.controller.signal.throwIfAborted();
    this.schedule();
    return this.catalog.readChanges(since);
  }

  /** The published row under a `sessionCatalogRowKey`, without discovery. */
  async readRow(key: string): Promise<Readonly<SessionCatalogRow> | undefined> {
    await this.initialize();
    this.controller.signal.throwIfAborted();
    return this.catalog.readRow(key);
  }

  compareRowOrder(left: string, right: string): number {
    return this.catalog.compareRowOrder(left, right);
  }

  invalidate(path?: string): void {
    this.dirty = true;
    if (path && this.changedPaths.size < 1024) this.changedPaths.add(path);
    else this.discover = true;
    this.schedule();
  }

  private nativeId(sessionId: string): string | undefined {
    return this.options.nativeSessionId
      ? this.options.nativeSessionId(sessionId)
      : sessionId;
  }

  /**
   * Session activity reaches most rows through their watched files. Stores
   * observed only internally (Grok, OpenCode) are not, so activity on one of
   * their sessions rescans that one store rather than every provider.
   */
  private refreshUnwatchedStore(sessionId: string): void {
    const id = this.nativeId(sessionId);
    if (!id) return;
    if (!this.initialized) return;
    for (const row of this.catalog.readNativeRows(id))
      if (INTERNALLY_OBSERVED_FAMILIES.has(row.catalogFamily))
        this.invalidate(row.storeKey);
  }

  /**
   * A created session normally arrives by its own file within one refresh.
   * Discovery runs only for one still missing when its own grace period ends:
   * its file appeared before its provider's watcher started, or in a store
   * the catalog cannot classify a new file in.
   */
  private awaitCreated(sessionId: string): void {
    if (this.controller.signal.aborted) return;
    if (!this.createdSessions.has(sessionId))
      this.createdSessions.set(
        sessionId,
        Date.now() + (this.options.createdSessionGraceMs ?? 3_000),
      );
    this.armCreatedTimer();
  }

  private armCreatedTimer(): void {
    if (this.createdTimer || !this.createdSessions.size) return;
    const due = Math.min(...this.createdSessions.values());
    this.createdTimer = setTimeout(
      () => {
        this.createdTimer = undefined;
        void this.confirmCreated()
          .catch(() => {
            // Disposed or unreadable: the next publication or reset covers it.
          })
          .finally(() => {
            if (!this.controller.signal.aborted) this.armCreatedTimer();
          });
      },
      Math.max(0, due - Date.now()),
    );
    this.createdTimer.unref?.();
  }

  private async confirmCreated(): Promise<void> {
    const now = Date.now();
    const due: string[] = [];
    for (const [sessionId, deadline] of this.createdSessions)
      if (deadline <= now) {
        due.push(sessionId);
        this.createdSessions.delete(sessionId);
      }
    // Let the refresh carrying the sessions' own files land first. A run
    // already in flight may predate them, so settle until nothing targeted
    // is pending (bounded: a busy catalog falls through to the check).
    for (let pass = 0; pass < 3; pass++) {
      if (this.work) await this.work;
      else if (this.dirty && !this.discover && Date.now() >= this.retryAfter)
        await this.refresh();
      else break;
    }

    if (
      due.some((sessionId) => {
        const id = this.nativeId(sessionId);
        return !id || !this.catalog.readNativeRows(id).length;
      })
    )
      this.invalidate();
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
      catalog: this.getState(),
      timestamp: new Date().toISOString(),
    });
  }

  private async reconcile(changedPaths?: ReadonlySet<string>): Promise<void> {
    const before = this.catalog.getToken();
    const rows =
      changedPaths && this.options.adapters.scoped
        ? this.catalog.readFileRows(changedPaths)
        : (await this.catalog.readRows()).rows;
    const adapters = await this.options.adapters(
      rows,
      this.controller.signal,
      changedPaths,
      this.catalog.getSnapshot().providerSources,
      changedPaths && this.options.adapters.scoped
        ? {
            fileStoreProject: (family, store) =>
              this.catalog.fileStoreProject(family, store),
            readAllRows: async () => (await this.catalog.readRows()).rows,
          }
        : undefined,
    );
    this.controller.signal.throwIfAborted();
    await this.catalog.reconcile(adapters);

    // The first publication is usable before any optional tail is opened.
    const accepted = changedPaths
      ? this.catalog.readChanges(before)
      : { rows: this.catalog.readUnresolvedQuestions() };
    this.updateProjects();
    this.publish();
    // Questions found here are row upserts: one more generation carrying
    // just those rows, not a second publication of every row.
    const enriched: SessionCatalogRow[] = [];
    const questions = new Map(
      accepted.rows.map((row) => [
        JSON.stringify([row.catalogFamily, row.storeKey, row.sessionId]),
        row,
      ]),
    );
    for (const id of this.questionIds)
      for (const row of this.catalog.readNativeRows(id))
        questions.set(
          JSON.stringify([row.catalogFamily, row.storeKey, row.sessionId]),
          row,
        );
    this.questionIds.clear();
    for (const row of questions.values()) {
      this.controller.signal.throwIfAborted();
      if (
        row.catalogFamily !== "codex" ||
        row.location.kind !== "file" ||
        row.asyncQuestions !== undefined ||
        !this.options.shouldReadQuestions?.(row)
      )
        continue;
      const filePath = row.location.path;
      try {
        const before = catalogFileVersion(await stat(filePath));
        if (before !== row.sourceVersion) {
          this.invalidate(filePath);
          continue;
        }
        const asyncQuestions = await readCodexAsyncQuestions(filePath);
        if (catalogFileVersion(await stat(filePath)) !== before) {
          this.invalidate(filePath);
          continue;
        }
        if (asyncQuestions !== undefined)
          enriched.push({ ...row, asyncQuestions });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        this.invalidate(filePath);
      }
    }
    if (enriched.length) {
      this.controller.signal.throwIfAborted();
      await this.catalog.upsertRows(enriched);
    }
  }

  async dispose(): Promise<void> {
    this.controller.abort();
    this.unsubscribe?.();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.createdTimer) clearTimeout(this.createdTimer);
    this.createdTimer = undefined;
    this.catalog.stop();
    await this.work;
  }
}

function sameToken(
  left: SessionCatalogToken,
  right: SessionCatalogToken | undefined,
): boolean {
  return (
    left.catalogEpoch === right?.catalogEpoch &&
    left.catalogGeneration === right.catalogGeneration
  );
}
