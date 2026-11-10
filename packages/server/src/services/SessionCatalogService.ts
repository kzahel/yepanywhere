import { randomUUID } from "node:crypto";
import { rm, stat } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { getLogger } from "../logging/logger.js";
import type {
  NativeSessionCatalogAdapter,
  SessionCatalogRow,
  SessionCatalogScanMode,
} from "../sessions/catalog-types.js";
import type { SqliteDatabase } from "../storage/sqlite.js";
import {
  LegacyCatalogCorruptionError,
  readLegacyCatalogManifest,
  readLegacyCatalogRows,
} from "./session-catalog-legacy.js";
import { normalizeRow, requireNonEmpty } from "./session-catalog-rows.js";
import {
  type SessionCatalogSqliteChange,
  type SessionCatalogSqliteKey,
  type SessionCatalogSqliteSource,
  type SessionCatalogSqliteState,
  SessionCatalogRowError,
  SessionCatalogSqliteStore,
  type SessionCatalogSqliteWrite,
  rowKey,
  sessionCatalogJsonHash,
} from "./session-catalog-sqlite.js";

const DEFAULT_MAX_ROW_BYTES = 64 * 1024;
/**
 * Generations a tombstone outlives before it is purged. A change reader at
 * least this close to the current generation sees every deletion; one
 * further behind reads in full. Purges run in steps of a tenth of it, so
 * each publication does not scan for them.
 */
const DEFAULT_TOMBSTONE_GENERATIONS = 10_000;

export interface SessionCatalogToken {
  catalogEpoch: string;
  catalogGeneration: number;
}

/** A provider store the published generation covers, even with no rows. */
export type SessionCatalogProviderSourceSnapshot = SessionCatalogSqliteSource;

export interface SessionCatalogSnapshot extends SessionCatalogToken {
  completedAt: string;
  rowCount: number;
  providerSources: SessionCatalogProviderSourceSnapshot[];
}

/**
 * What a change reader needs to catch up from its token: the rows written
 * since and the keys removed since, or every row (`full`) when the change log
 * cannot answer: no token, another epoch, or a token behind the floor.
 */
export interface SessionCatalogChanges extends SessionCatalogToken {
  full: boolean;
  /** Live rows written after the reader's token; every row when `full`. */
  rows: ReadonlyArray<Readonly<SessionCatalogRow>>;
  /** Keys tombstoned after the reader's token; empty when `full`. */
  removed: readonly SessionCatalogSqliteKey[];
}

export interface SessionCatalogProjectRows extends SessionCatalogToken {
  /** Newest first. */
  rows: ReadonlyArray<Readonly<SessionCatalogRow>>;
}

export interface SessionCatalogReconcileMetrics {
  durationMs: number;
  adapterScans: number;
  rowsScanned: number;
  /** False when nothing changed and the generation stayed. */
  changed: boolean;
  rowsWritten: number;
  rowsTombstoned: number;
  /** Synchronous time of the SQLite transaction, 0 when nothing changed. */
  writeMs: number;
}

export interface SessionCatalogReconcileResult {
  status: "computed" | "joined";
  snapshot: SessionCatalogSnapshot;
  metrics: SessionCatalogReconcileMetrics;
}

export interface SessionCatalogLegacyImport {
  /**
   * `imported`: the files' generation was written to the tables.
   * `superseded`: the tables already held it or a later one.
   * `unreadable`: the files were damaged and a new lineage starts.
   */
  status: "imported" | "superseded" | "unreadable";
  rows: number;
  durationMs: number;
  deleted: boolean;
}

export interface SessionCatalogWrite extends SessionCatalogSqliteWrite {
  generation: number;
  durationMs: number;
}

export interface SessionCatalogServiceMetrics {
  reconciliationRequests: number;
  reconciliationStarts: number;
  reconciliationJoins: number;
  reconciliationQueuedBehindDifferentScope: number;
  reconciliationFailures: number;
  /** Writes that advanced the generation. */
  publications: number;
  /** Reconciliations that found nothing to write. */
  unchangedReconciliations: number;
  /** Rows an adapter yielded twice in one scan; the later one is kept. */
  duplicateRows: number;
  lastWrite: SessionCatalogWrite | null;
  resetFailures: number;
  lastResetReason: string | null;
  legacyImport: SessionCatalogLegacyImport | null;
  catalogEpoch: string | null;
  catalogGeneration: number;
  rowCount: number;
}

export interface SessionCatalogServiceOptions {
  /** The profile database; its catalog tables are the catalog. */
  database: SqliteDatabase;
  /**
   * `session-catalog/` below the data directory, where earlier versions kept
   * the catalog as files. Imported once if the tables are behind it, then
   * deleted.
   */
  legacyCatalogDir?: string;
  maxRowBytes?: number;
  tombstoneGenerations?: number;
  now?: () => number;
  createEpoch?: () => string;
}

interface ReconcileInFlight {
  signature: string;
  controller: AbortController;
  promise: Promise<Omit<SessionCatalogReconcileResult, "status">>;
}

export interface SessionCatalogReconcilePlan {
  adapters: readonly NativeSessionCatalogAdapter[];
  /** False replaces only scanned stores; partial scans name explicit removals. */
  replaceAll: boolean;
}
interface Published {
  epoch: string;
  generation: number;
  completedAt: string;
  tombstoneHorizon: number;
  changeFloor: number;
  rowCount: number;
  sources: readonly SessionCatalogSqliteSource[];
}

/**
 * Owns the session catalog in `discovery.sqlite` (plan 189 step 3). Provider
 * scans run outside request paths; a publication diffs the scanned rows
 * against the published ones by row hash and writes only what changed, in one
 * transaction that advances the generation. A scan that changes nothing
 * advances nothing. SQLite owns the published rows; only bounded point reads stay parsed.
 * Complete reads materialize caller-owned results, outside the retained cache.
 */
export class SessionCatalogService {
  private readonly database: SqliteDatabase;
  private readonly legacyCatalogDir?: string;
  private readonly maxRowBytes: number;
  private readonly tombstoneGenerations: number;
  private readonly now: () => number;
  private readonly createEpoch: () => string;
  private published: Published | null = null;
  private initialization?: Promise<void>;
  private reconcileInFlight: ReconcileInFlight | null = null;
  private stopped = false;
  private reconciliationRequests = 0;
  private reconciliationStarts = 0;
  private reconciliationJoins = 0;
  private reconciliationQueuedBehindDifferentScope = 0;
  private reconciliationFailures = 0;
  private publications = 0;
  private unchangedReconciliations = 0;
  private duplicateRows = 0;
  private lastWrite: SessionCatalogWrite | null = null;
  private resetFailures = 0;
  private lastResetReason: string | null = null;
  private legacyImport: SessionCatalogLegacyImport | null = null;

  constructor(options: SessionCatalogServiceOptions) {
    this.database = options.database;
    this.legacyCatalogDir = options.legacyCatalogDir;
    this.maxRowBytes = positiveInteger(
      options.maxRowBytes ?? DEFAULT_MAX_ROW_BYTES,
      "maxRowBytes",
    );
    this.tombstoneGenerations = positiveInteger(
      options.tombstoneGenerations ?? DEFAULT_TOMBSTONE_GENERATIONS,
      "tombstoneGenerations",
    );
    this.now = options.now ?? Date.now;
    this.createEpoch = options.createEpoch ?? randomUUID;
  }

  async initialize(): Promise<SessionCatalogSnapshot> {
    // A failed start (an I/O error reading the legacy files, a busy
    // database) is retried by the next caller rather than kept.
    this.initialization ??= this.load().catch((error: unknown) => {
      this.initialization = undefined;
      throw error;
    });
    await this.initialization;
    return this.getSnapshot();
  }

  private async load(): Promise<void> {
    let stored = this.withStore((store) => store.readState());
    if (this.legacyCatalogDir)
      stored = await this.importLegacy(this.legacyCatalogDir, stored);
    if (!stored) {
      this.startLineage();
      return;
    }
    try {
      const sources = this.withStore((store) => {
        if (store.hasInvalidRows())
          throw new SessionCatalogRowError(
            "Unreadable session catalog questions",
          );
        return store.readSources();
      });
      this.published = {
        epoch: stored.epoch,
        generation: stored.generation,
        completedAt: stored.completedAt,
        tombstoneHorizon: stored.tombstoneHorizon,
        changeFloor: stored.tombstoneHorizon,
        rowCount: stored.rowCount,
        sources: Object.freeze(sources),
      };
    } catch (error) {
      // A row the store cannot reassemble ends the lineage; the catalog is a
      // cache and reconciliation refills it. A database error (busy, I/O)
      // fails the start instead, to be retried.
      if (!(error instanceof SessionCatalogRowError)) throw error;
      this.recordReset(error);
      this.startLineage();
    }
  }

  /**
   * Import the generation an earlier version left in files, unless the
   * tables already hold it or a later one, then delete the folder. The folder
   * is deleted only once the tables hold a generation at least as new, or the
   * files are proven damaged; any other read error keeps it and fails the
   * start, to be retried.
   */
  private async importLegacy(
    catalogDir: string,
    stored: SessionCatalogSqliteState | undefined,
  ): Promise<SessionCatalogSqliteState | undefined> {
    const startedAt = performance.now();
    let status: SessionCatalogLegacyImport["status"];
    let rows = 0;
    try {
      const manifest = await readLegacyCatalogManifest(catalogDir);
      if (!manifest) {
        // A folder without a manifest holds nothing a reader could use.
        if (!(await exists(catalogDir))) return stored;
        status = "superseded";
      } else if (
        stored &&
        (stored.epoch !== manifest.epoch ||
          stored.generation >= manifest.generation)
      ) {
        status = "superseded";
      } else {
        const legacyRows = await readLegacyCatalogRows(catalogDir, manifest);
        // Nothing else writes the tables before initialization completes.
        this.withStore((store) =>
          store.writeGeneration(
            {
              epoch: manifest.epoch,
              generation: manifest.generation,
              completedAt: manifest.completedAt,
            },
            legacyRows,
            manifest.sources,
          ),
        );
        stored = this.withStore((store) => store.readState());
        status = "imported";
        rows = legacyRows.length;
      }
    } catch (error) {
      if (!(error instanceof LegacyCatalogCorruptionError)) throw error;
      this.recordReset(error);
      status = "unreadable";
      // The tables were behind the damaged files, or their lineage is
      // unknown: continuing from them could reuse generations clients have
      // seen, so a fresh lineage starts.
      stored = undefined;
    }
    let deleted = true;
    try {
      await rm(catalogDir, { recursive: true, force: true });
    } catch (error) {
      deleted = false;
      getLogger().warn(
        { err: error, catalogDir },
        "SESSION_CATALOG: deleting the catalog files failed",
      );
    }
    this.legacyImport = {
      status,
      rows,
      durationMs: performance.now() - startedAt,
      deleted,
    };
    getLogger().info(
      { legacyImport: this.legacyImport },
      "SESSION_CATALOG: moved the catalog files into SQLite",
    );
    return stored;
  }

  private recordReset(reason: unknown): void {
    this.resetFailures += 1;
    this.lastResetReason =
      reason instanceof Error ? reason.message : String(reason);
  }

  /** Start a fresh epoch at generation 0 with no rows, in memory and stored. */
  private startLineage(): void {
    const state = {
      epoch: this.createEpoch(),
      generation: 0,
      completedAt: new Date(this.now()).toISOString(),
    };
    this.withStore((store) => store.writeGeneration(state, [], []));
    this.published = {
      ...state,
      tombstoneHorizon: 0,
      changeFloor: 0,
      rowCount: 0,
      sources: Object.freeze([]),
    };
  }

  getSnapshot(): SessionCatalogSnapshot {
    const published = this.requirePublished();
    return {
      ...tokenFrom(published),
      completedAt: published.completedAt,
      rowCount: published.rowCount,
      providerSources: published.sources.map((source) => ({ ...source })),
    };
  }

  /** Fixed-cost publication identity without copying rows. */
  getToken(): SessionCatalogToken {
    return tokenFrom(this.requirePublished());
  }

  /** Clean native rows/misses are bounded; SQL remains the publication owner. */
  private readonly hotRows = new Map<
    string,
    { row: Readonly<SessionCatalogRow>; bytes: number; order: number }
  >();
  private hotBytes = 0;
  private remember(entry: { row: SessionCatalogRow; order: number }) {
    const key = rowKey(
      entry.row.catalogFamily,
      entry.row.storeKey,
      entry.row.sessionId,
    );
    const known = this.hotRows.get(key);
    if (known) return known.row;
    const row = Object.freeze(entry.row),
      bytes = JSON.stringify(row).length * 2 + 512;
    if (bytes <= 8 * 1024 * 1024) {
      this.hotRows.set(key, { row, bytes, order: entry.order });
      this.hotBytes += bytes;
      while (this.hotRows.size > 256 || this.hotBytes > 8 * 1024 * 1024) {
        const [old, item] = this.hotRows.entries().next().value!;
        this.hotRows.delete(old);
        this.hotBytes -= item.bytes;
      }
    }
    return row;
  }
  private clearHotRows() {
    this.hotRows.clear();
    this.hotBytes = 0;
  }
  getWorkingSetMetrics() {
    return {
      rows: this.hotRows.size,
      estimatedPayloadBytes: this.hotBytes,
      rowBudget: 256,
      payloadByteBudget: 8 * 1024 * 1024,
    };
  }
  private allRows() {
    return this.withStore((store) => store.readRowsWithHashes())
      .sort((a, b) => sourceOrder(a.row, b.row) || a.order - b.order)
      .map((row) => this.remember(row));
  }
  async readRows(): Promise<{
    snapshot: SessionCatalogSnapshot;
    rows: ReadonlyArray<Readonly<SessionCatalogRow>>;
  }> {
    this.ensureRunning();
    return { snapshot: this.getSnapshot(), rows: this.allRows() };
  }
  readRow(key: string): Readonly<SessionCatalogRow> | undefined {
    this.ensureRunning();
    const known = this.hotRows.get(key);
    if (known) {
      this.hotRows.delete(key);
      this.hotRows.set(key, known);
      return known.row;
    }
    const parts = JSON.parse(key) as [
      SessionCatalogRow["catalogFamily"],
      string,
      string,
    ];
    const found = this.withStore((store) =>
      store.readRow({
        catalogFamily: parts[0],
        storeKey: parts[1],
        sessionId: parts[2],
      }),
    );
    return found && this.remember(found);
  }
  compareRowOrder(left: string, right: string): number {
    const a = JSON.parse(left) as string[],
      b = JSON.parse(right) as string[];
    const bySource = `${a[0]}:${a[1]}`.localeCompare(`${b[0]}:${b[1]}`);
    if (bySource) return bySource;
    const order = (key: string, parts: string[]) =>
      this.hotRows.get(key)?.order ??
      this.withStore((store) =>
        store.readRow({
          catalogFamily: parts[0] as SessionCatalogRow["catalogFamily"],
          storeKey: parts[1]!,
          sessionId: parts[2]!,
        }),
      )?.order ??
      0;
    return order(left, a) - order(right, b);
  }
  readFileRows(paths: ReadonlySet<string>) {
    return this.scopedRows("path", JSON.stringify([...paths]));
  }
  readNativeRows(id: string) {
    return this.scopedRows("native", id);
  }
  readUnresolvedQuestions() {
    return this.scopedRows("questions", "");
  }
  readProjects(
    stores: readonly SessionCatalogSqliteSource[],
  ): import("../projects/catalog-projects.js").CatalogProjectsView {
    const projects = new Map<
      string,
      import("../projects/catalog-projects.js").CatalogProject
    >();
    if (stores.length)
      for (const row of this.withStore((sql) => sql.readProjectFacts(stores))) {
        let project = projects.get(row.project_key);
        if (!project) {
          project = {
            path: row.path,
            provider: row.family,
            counts: {},
            lastActivity: row.latest,
          };
          projects.set(row.project_key, project);
        }
        if (row.family < project.provider) project.provider = row.family;
        project.counts[row.family] = row.members;
        if (row.latest > project.lastActivity)
          project.lastActivity = row.latest;
      }
    for (const p of projects.values())
      p.counts = Object.fromEntries(
        Object.entries(p.counts).sort(([a], [b]) => a.localeCompare(b)),
      );
    const accepted = new Set(
      this.requirePublished().sources.map((s) =>
        JSON.stringify([s.catalogFamily, s.storeKey]),
      ),
    );
    const complete = stores.every((s) =>
      accepted.has(JSON.stringify([s.catalogFamily, s.storeKey])),
    );
    const ordered = [...projects.values()].sort((a, b) =>
      a.path.localeCompare(b.path),
    );
    return {
      projects: ordered,
      complete,
      version: JSON.stringify([complete, ordered]),
    };
  }
  fileStoreProject(family: string, store: string) {
    return this.withStore((sql) => sql.fileStoreProject(family, store));
  }
  private scopedRows(
    kind: "path" | "native" | "questions" | "project",
    value: string,
  ) {
    this.ensureRunning();
    return this.withStore((store) => store.readScopedRows(kind, value)).map(
      (row) => this.remember(row),
    );
  }
  readChanges(since?: SessionCatalogToken): SessionCatalogChanges {
    this.ensureRunning();
    const current = this.requirePublished();
    const token = tokenFrom(current);
    const everything = () => ({
      ...token,
      full: true,
      rows: this.allRows(),
      removed: [],
    });
    if (
      !since ||
      since.catalogEpoch !== current.epoch ||
      since.catalogGeneration > current.generation ||
      since.catalogGeneration < current.changeFloor
    )
      return everything();
    if (since.catalogGeneration === current.generation)
      return { ...token, full: false, rows: [], removed: [] };
    try {
      const keys = this.withStore((store) => {
        const state = store.readState();
        return state?.epoch === current.epoch &&
          state.generation === current.generation
          ? store.readChangedKeys(since.catalogGeneration)
          : undefined;
      });
      if (!keys) return everything();
      const rows: Readonly<SessionCatalogRow>[] = [],
        removed: SessionCatalogSqliteKey[] = [];
      for (const { key, deleted } of keys) {
        if (deleted) removed.push(key);
        else {
          const row = this.readRow(
            rowKey(key.catalogFamily, key.storeKey, key.sessionId),
          );
          if (!row) return everything();
          rows.push(row);
        }
      }
      return { ...token, full: false, rows, removed };
    } catch {
      return everything();
    }
  }
  async readProjectRows(
    projectIdentityKey: string,
  ): Promise<SessionCatalogProjectRows> {
    return {
      ...this.getToken(),
      rows: this.scopedRows("project", projectIdentityKey).sort(
        (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
      ),
    };
  }

  async reconcile(
    input: readonly NativeSessionCatalogAdapter[] | SessionCatalogReconcilePlan,
    mode: SessionCatalogScanMode = { kind: "complete" },
  ): Promise<SessionCatalogReconcileResult> {
    this.ensureRunning();
    this.reconciliationRequests += 1;
    const plan: SessionCatalogReconcilePlan = Array.isArray(input)
      ? { adapters: input, replaceAll: true }
      : (input as SessionCatalogReconcilePlan);
    const normalizedAdapters = normalizeAdapters(plan.adapters);
    const signature =
      reconciliationSignature(normalizedAdapters, mode) +
      (plan.replaceAll ? "full" : randomUUID());
    let existing = this.reconcileInFlight;
    while (existing && existing.signature !== signature) {
      this.reconciliationQueuedBehindDifferentScope += 1;
      try {
        await existing.promise;
      } catch {
        // A distinct requested scope still gets its own attempt.
      }
      this.ensureRunning();
      existing = this.reconcileInFlight;
    }
    if (existing) {
      this.reconciliationJoins += 1;
      const joined = await existing.promise;
      return { ...joined, status: "joined" };
    }

    this.reconciliationStarts += 1;
    const controller = new AbortController();
    const promise = this.buildGeneration(
      normalizedAdapters,
      mode,
      controller.signal,
      plan.replaceAll,
    ).catch((error) => {
      this.reconciliationFailures += 1;
      throw error;
    });
    this.reconcileInFlight = { signature, controller, promise };
    try {
      const computed = await promise;
      return { ...computed, status: "computed" };
    } finally {
      if (this.reconcileInFlight?.promise === promise) {
        this.reconcileInFlight = null;
      }
    }
  }

  /**
   * Replace published rows by key, as one publication if any changed. A row
   * whose key is gone, or whose source version moved since the caller read
   * it, is skipped: the next scan owns it. Waits for a reconciliation in
   * flight, whose scan would not carry these rows.
   */
  async upsertRows(
    rows: readonly SessionCatalogRow[],
  ): Promise<SessionCatalogToken> {
    while (this.reconcileInFlight) {
      await this.reconcileInFlight.promise.catch(() => {});
    }
    this.ensureRunning();
    const current = this.requirePublished();
    const changes: SessionCatalogSqliteChange[] = [];
    for (const candidate of rows) {
      const { row, key } = this.prepareRow(candidate, candidate);
      const previous = this.readRow(key);
      if (previous?.sourceVersion === row.sourceVersion)
        changes.push({ type: "upsert", row });
    }
    this.commitPartial(changes, current.sources);
    return this.getToken();
  }

  stop(): void {
    this.stopped = true;
    this.reconcileInFlight?.controller.abort();
    this.clearHotRows();
  }

  getMetrics(): SessionCatalogServiceMetrics {
    return {
      reconciliationRequests: this.reconciliationRequests,
      reconciliationStarts: this.reconciliationStarts,
      reconciliationJoins: this.reconciliationJoins,
      reconciliationQueuedBehindDifferentScope:
        this.reconciliationQueuedBehindDifferentScope,
      reconciliationFailures: this.reconciliationFailures,
      publications: this.publications,
      unchangedReconciliations: this.unchangedReconciliations,
      duplicateRows: this.duplicateRows,
      lastWrite: this.lastWrite,
      resetFailures: this.resetFailures,
      lastResetReason: this.lastResetReason,
      legacyImport: this.legacyImport,
      catalogEpoch: this.published?.epoch ?? null,
      catalogGeneration: this.published?.generation ?? 0,
      rowCount: this.published?.rowCount ?? 0,
    };
  }

  private async buildGeneration(
    adapters: readonly NativeSessionCatalogAdapter[],
    mode: SessionCatalogScanMode,
    signal: AbortSignal,
    replaceAll: boolean,
  ): Promise<Omit<SessionCatalogReconcileResult, "status">> {
    const basis = this.requirePublished(),
      startedAt = this.now();
    const rows: Readonly<SessionCatalogRow>[] = [],
      index = new Map<string, number>(),
      removed: SessionCatalogSqliteKey[] = [],
      completeStores: SessionCatalogSqliteSource[] = [];
    const sources = replaceAll ? [] : [...basis.sources];
    let rowsScanned = 0;
    for (const adapter of adapters) {
      throwIfAborted(signal);
      const scan = await adapter.scan({
        catalogEpoch: basis.epoch,
        targetGeneration: basis.generation + 1,
        mode,
        signal,
      });
      requireNonEmpty(scan.sourceVersion, "adapter sourceVersion");
      for await (const candidate of scan.rows) {
        throwIfAborted(signal);
        const { row, key } = this.prepareRow(candidate, adapter);
        rowsScanned++;
        const previous = index.get(key);
        if (previous !== undefined) {
          this.duplicateRows++;
          rows[previous] = row;
        } else {
          index.set(key, rows.length);
          rows.push(row);
        }
      }
      for (const key of scan.removed ?? []) {
        if (
          key.catalogFamily !== adapter.catalogFamily ||
          key.storeKey !== adapter.storeKey
        )
          throw new Error("Catalog removal does not belong to adapter");
        requireNonEmpty(key.sessionId, "removed session id");
        removed.push(key);
      }
      const source = {
        catalogFamily: adapter.catalogFamily,
        storeKey: adapter.storeKey,
      };
      if (
        !sources.some(
          (s) =>
            s.catalogFamily === source.catalogFamily &&
            s.storeKey === source.storeKey,
        )
      )
        sources.push(source);
      if (!scan.partial) completeStores.push(source);
    }
    throwIfAborted(signal);
    let write: SessionCatalogWrite | null;
    if (replaceAll) write = this.commitRows(rows, sources);
    else {
      for (const source of completeStores)
        for (const key of this.withStore((store) =>
          store.readStoreKeys(source.catalogFamily, source.storeKey),
        ))
          if (
            !index.has(rowKey(key.catalogFamily, key.storeKey, key.sessionId))
          )
            removed.push(key);
      write = this.commitPartial(
        [
          ...rows.map((row) => ({ type: "upsert" as const, row })),
          ...removed.map((key) => ({ type: "delete" as const, key })),
        ],
        sources,
      );
    }
    const metrics = {
      durationMs: this.now() - startedAt,
      adapterScans: adapters.length,
      rowsScanned,
      changed: write !== null,
      rowsWritten: write?.rowsWritten ?? 0,
      rowsTombstoned: write?.rowsTombstoned ?? 0,
      writeMs: write?.durationMs ?? 0,
    };
    getLogger().debug(
      { metrics, generation: this.published?.generation },
      "SESSION_CATALOG: reconciled",
    );
    return { snapshot: this.getSnapshot(), metrics };
  }
  private prepareRow(
    candidate: SessionCatalogRow,
    adapter: Pick<NativeSessionCatalogAdapter, "catalogFamily" | "storeKey">,
  ) {
    const row = Object.freeze(normalizeRow(candidate, adapter));
    const json = JSON.stringify(row);
    if (Buffer.byteLength(json) + 1 > this.maxRowBytes)
      throw new Error(
        `Session catalog row exceeds ${this.maxRowBytes} bytes: ${row.catalogFamily}:${row.storeKey}:${row.sessionId}`,
      );
    return {
      row,
      key: rowKey(row.catalogFamily, row.storeKey, row.sessionId),
      hash: sessionCatalogJsonHash(json),
    };
  }
  private commitRows(
    rows: readonly Readonly<SessionCatalogRow>[],
    sources: readonly SessionCatalogSqliteSource[],
  ) {
    const current = this.requirePublished(),
      state = {
        epoch: current.epoch,
        generation: current.generation + 1,
        completedAt: new Date(this.now()).toISOString(),
      },
      start = performance.now();
    const result = this.withStore((store) => {
      const previous = store.readState();
      const follows =
        previous?.epoch === current.epoch &&
        previous.generation === current.generation;
      const written = store.writeGeneration(
        state,
        rows,
        sources,
        true,
        this.purgeHorizon(state.generation),
      );
      return { written, state: store.readState()!, follows };
    });
    if (result.state.generation === current.generation && result.follows) {
      this.unchangedReconciliations++;
      return null;
    }
    return this.acceptWrite(
      result.written,
      result.state,
      sources,
      result.follows,
      start,
    );
  }
  private commitPartial(
    changes: readonly SessionCatalogSqliteChange[],
    sources: readonly SessionCatalogSqliteSource[],
  ) {
    const current = this.requirePublished(),
      state = {
        epoch: current.epoch,
        generation: current.generation + 1,
        completedAt: new Date(this.now()).toISOString(),
      },
      start = performance.now();
    const horizon = this.purgeHorizon(state.generation);
    const result = this.withStore((store) => {
      const written = store.applyChanges(
        state,
        current.generation,
        changes,
        sources,
        horizon,
        true,
      );
      return { written, state: store.readState()! };
    });
    if (result.state.generation === current.generation) {
      this.unchangedReconciliations++;
      return null;
    }
    return this.acceptWrite(result.written, result.state, sources, true, start);
  }
  private purgeHorizon(generation: number) {
    const purgeTo = generation - this.tombstoneGenerations;
    return purgeTo - this.requirePublished().tombstoneHorizon >=
      Math.max(1, Math.floor(this.tombstoneGenerations / 10))
      ? purgeTo
      : 0;
  }
  private acceptWrite(
    written: SessionCatalogSqliteWrite,
    state: SessionCatalogSqliteState,
    sources: readonly SessionCatalogSqliteSource[],
    follows: boolean,
    start: number,
  ) {
    const previous = this.requirePublished();
    this.published = {
      epoch: state.epoch,
      generation: state.generation,
      completedAt: state.completedAt,
      tombstoneHorizon: state.tombstoneHorizon,
      rowCount: state.rowCount,
      changeFloor: follows
        ? Math.max(previous.changeFloor, state.tombstoneHorizon)
        : state.generation,
      sources: Object.freeze([...sources]),
    };
    this.clearHotRows();
    this.publications++;
    const write = {
      ...written,
      generation: state.generation,
      durationMs: performance.now() - start,
    };
    this.lastWrite = write;
    return write;
  }

  /** The store's statements are prepared and released within one call. */
  private withStore<T>(use: (store: SessionCatalogSqliteStore) => T): T {
    const store = new SessionCatalogSqliteStore(this.database);
    try {
      return use(store);
    } finally {
      store.dispose();
    }
  }

  private requirePublished(): Published {
    if (!this.published) {
      throw new Error(
        "SessionCatalogService not initialized. Call initialize() first.",
      );
    }
    return this.published;
  }

  private ensureRunning(): void {
    this.requirePublished();
    if (this.stopped) throw new Error("SessionCatalogService is stopped");
  }
}

function tokenFrom(published: Published): SessionCatalogToken {
  return {
    catalogEpoch: published.epoch,
    catalogGeneration: published.generation,
  };
}

function sourceOrder(
  a: Pick<SessionCatalogRow, "catalogFamily" | "storeKey">,
  b: Pick<SessionCatalogRow, "catalogFamily" | "storeKey">,
) {
  return `${a.catalogFamily}:${a.storeKey}`.localeCompare(
    `${b.catalogFamily}:${b.storeKey}`,
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function normalizeAdapters(
  adapters: readonly NativeSessionCatalogAdapter[],
): NativeSessionCatalogAdapter[] {
  const sorted = [...adapters].sort((left, right) =>
    `${left.catalogFamily}:${left.storeKey}`.localeCompare(
      `${right.catalogFamily}:${right.storeKey}`,
    ),
  );
  const seen = new Set<string>();
  for (const adapter of sorted) {
    requireNonEmpty(adapter.storeKey, "adapter storeKey");
    const key = `${adapter.catalogFamily}:${adapter.storeKey}`;
    if (seen.has(key))
      throw new Error(`Duplicate session catalog adapter: ${key}`);
    seen.add(key);
  }
  return sorted;
}

function reconciliationSignature(
  adapters: readonly NativeSessionCatalogAdapter[],
  mode: SessionCatalogScanMode,
): string {
  return JSON.stringify({
    adapters: adapters.map((adapter) => [
      adapter.catalogFamily,
      adapter.storeKey,
    ]),
    mode,
  });
}

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const error = new Error("Session catalog reconciliation aborted");
  error.name = "AbortError";
  throw error;
}
