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

interface IndexEntry {
  position: number;
  hash: string;
}

/** The published generation, as stored, kept parsed in memory. */
interface Published {
  epoch: string;
  generation: number;
  completedAt: string;
  tombstoneHorizon: number;
  /**
   * The oldest generation the change log answers from: the tombstone
   * horizon, or a generation stored whole over tables that had moved, whose
   * `changed_gen` values say nothing about what memory published before it.
   */
  changeFloor: number;
  rows: readonly Readonly<SessionCatalogRow>[];
  /** Row key to its position in `rows` and its stored hash. */
  index: ReadonlyMap<string, IndexEntry>;
  sources: readonly SessionCatalogSqliteSource[];
  /** Built on the first project read of this generation. */
  byProject?: Map<string, readonly Readonly<SessionCatalogRow>[]>;
}

/**
 * Owns the session catalog in `discovery.sqlite` (plan 189 step 3). Provider
 * scans run outside request paths; a publication diffs the scanned rows
 * against the published ones by row hash and writes only what changed, in one
 * transaction that advances the generation. A scan that changes nothing
 * advances nothing. The published generation's rows stay parsed in memory,
 * loaded from the tables at startup, so reads never query SQLite.
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
      const { rows, sources } = this.withStore((store) => ({
        rows: store.readRowsWithHashes(),
        sources: store.readSources(),
      }));
      const index = new Map<string, IndexEntry>();
      const published: Readonly<SessionCatalogRow>[] = [];
      for (const { row, hash } of rows) {
        index.set(rowKey(row.catalogFamily, row.storeKey, row.sessionId), {
          position: published.length,
          hash,
        });
        published.push(Object.freeze(row));
      }
      this.published = {
        epoch: stored.epoch,
        generation: stored.generation,
        completedAt: stored.completedAt,
        tombstoneHorizon: stored.tombstoneHorizon,
        changeFloor: stored.tombstoneHorizon,
        rows: Object.freeze(published),
        index,
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
      rows: Object.freeze([]),
      index: new Map(),
      sources: Object.freeze([]),
    };
  }

  getSnapshot(): SessionCatalogSnapshot {
    const published = this.requirePublished();
    return {
      ...tokenFrom(published),
      completedAt: published.completedAt,
      rowCount: published.rows.length,
      providerSources: published.sources.map((source) => ({ ...source })),
    };
  }

  /** Fixed-cost publication identity without copying rows. */
  getToken(): SessionCatalogToken {
    return tokenFrom(this.requirePublished());
  }

  /** The published generation's rows, from memory. */
  async readRows(): Promise<{
    snapshot: SessionCatalogSnapshot;
    rows: ReadonlyArray<Readonly<SessionCatalogRow>>;
  }> {
    this.ensureRunning();
    const published = this.requirePublished();
    return { snapshot: this.getSnapshot(), rows: published.rows };
  }

  /** The published row stored under `key` (`sessionCatalogRowKey`). */
  readRow(key: string): Readonly<SessionCatalogRow> | undefined {
    this.ensureRunning();
    const published = this.requirePublished();
    const entry = published.index.get(key);
    return entry && published.rows[entry.position];
  }

  /** Position in the accepted publication, for duplicate native/public views. */
  rowOrder(key: string): number | undefined {
    return this.requirePublished().index.get(key)?.position;
  }

  /**
   * The rows written and the keys removed after `since`, from the
   * `changed_gen` index, so a consumer that follows publications reads what
   * changed rather than every row. Every row comes back (`full`) when the
   * log cannot answer for `since`.
   */
  readChanges(since?: SessionCatalogToken): SessionCatalogChanges {
    this.ensureRunning();
    const published = this.requirePublished();
    const token = tokenFrom(published);
    const everything = {
      ...token,
      full: true,
      rows: published.rows,
      removed: [],
    };
    if (
      !since ||
      since.catalogEpoch !== published.epoch ||
      since.catalogGeneration > published.generation ||
      since.catalogGeneration < published.changeFloor
    )
      return everything;
    if (since.catalogGeneration === published.generation)
      return { ...token, full: false, rows: [], removed: [] };
    let changed: ReturnType<SessionCatalogSqliteStore["readChangedKeys"]>;
    try {
      const read = this.withStore((store) => {
        const stored = store.readState();
        return stored?.epoch === published.epoch &&
          stored.generation === published.generation
          ? store.readChangedKeys(since.catalogGeneration)
          : undefined;
      });
      if (!read) return everything;
      changed = read;
    } catch {
      // A busy or failing database costs this reader a full read from
      // memory, never the refresh it runs in.
      return everything;
    }
    const rows: Readonly<SessionCatalogRow>[] = [];
    const removed: SessionCatalogSqliteKey[] = [];
    for (const { key, deleted } of changed) {
      const entry = published.index.get(
        rowKey(key.catalogFamily, key.storeKey, key.sessionId),
      );
      // The tables and memory are written in one synchronous step, so they
      // agree; if they ever do not, the reader starts over.
      if (deleted ? entry : !entry) return everything;
      if (entry) rows.push(published.rows[entry.position]!);
      else removed.push(key);
    }
    return { ...token, full: false, rows, removed };
  }

  /** One project's rows of the published generation, newest first. */
  async readProjectRows(
    projectIdentityKey: string,
  ): Promise<SessionCatalogProjectRows> {
    this.ensureRunning();
    const published = this.requirePublished();
    published.byProject ??= groupByProject(published.rows);
    return {
      ...tokenFrom(published),
      rows: published.byProject.get(projectIdentityKey) ?? [],
    };
  }

  async reconcile(
    adapters: readonly NativeSessionCatalogAdapter[],
    mode: SessionCatalogScanMode = { kind: "complete" },
  ): Promise<SessionCatalogReconcileResult> {
    this.ensureRunning();
    this.reconciliationRequests += 1;
    const normalizedAdapters = normalizeAdapters(adapters);
    const signature = reconciliationSignature(normalizedAdapters, mode);
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
    const next = [...current.rows];
    const index = new Map(current.index);
    for (const candidate of rows) {
      const { row, key, hash } = this.prepareRow(candidate, candidate);
      const entry = index.get(key);
      if (!entry || entry.hash === hash) continue;
      if (next[entry.position]!.sourceVersion !== row.sourceVersion) continue;
      next[entry.position] = row;
      index.set(key, { position: entry.position, hash });
    }
    this.commit(next, index, current.sources);
    return this.getToken();
  }

  stop(): void {
    this.stopped = true;
    this.reconcileInFlight?.controller.abort();
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
      rowCount: this.published?.rows.length ?? 0,
    };
  }

  private async buildGeneration(
    adapters: readonly NativeSessionCatalogAdapter[],
    mode: SessionCatalogScanMode,
    signal: AbortSignal,
  ): Promise<Omit<SessionCatalogReconcileResult, "status">> {
    const basis = this.requirePublished();
    const startedAt = this.now();
    const rows: Readonly<SessionCatalogRow>[] = [];
    const index = new Map<string, IndexEntry>();
    const sources: SessionCatalogSqliteSource[] = [];
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
        const { row, key, hash } = this.prepareRow(candidate, adapter, basis);
        rowsScanned += 1;
        const existing = index.get(key);
        if (existing) {
          // The store keeps one row per key, so memory keeps the same one.
          this.duplicateRows += 1;
          rows[existing.position] = row;
          index.set(key, { position: existing.position, hash });
        } else {
          index.set(key, { position: rows.length, hash });
          rows.push(row);
        }
      }
      sources.push({
        catalogFamily: adapter.catalogFamily,
        storeKey: adapter.storeKey,
      });
    }
    throwIfAborted(signal);
    // Diffed against the generation published now, not the scan's basis, so
    // a publication that landed meanwhile is not undone by key.
    const write = this.commit(rows, index, sources);
    const metrics: SessionCatalogReconcileMetrics = {
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

  /**
   * Validate and key one row. A row equal to the published row of its key
   * reuses that row and its hash: most of a scan is unchanged rows, and
   * serializing and hashing all of them cost about 30 ms of event loop per
   * publication on 7,500 rows.
   */
  private prepareRow(
    candidate: SessionCatalogRow,
    adapter: Pick<NativeSessionCatalogAdapter, "catalogFamily" | "storeKey">,
    published?: Published,
  ): { row: Readonly<SessionCatalogRow>; key: string; hash: string } {
    const normalized = normalizeRow(candidate, adapter);
    const key = rowKey(
      normalized.catalogFamily,
      normalized.storeKey,
      normalized.sessionId,
    );
    const entry = published?.index.get(key);
    const previous = entry && published!.rows[entry.position];
    if (entry && previous && sameRow(previous, normalized))
      return { row: previous, key, hash: entry.hash };
    const row = Object.freeze(normalized);
    const json = JSON.stringify(row);
    if (Buffer.byteLength(json) + 1 > this.maxRowBytes) {
      throw new Error(
        `Session catalog row exceeds ${this.maxRowBytes} bytes: ${row.catalogFamily}:${row.storeKey}:${row.sessionId}`,
      );
    }
    return { row, key, hash: sessionCatalogJsonHash(json) };
  }

  /**
   * Publish `rows` as the next generation if they or the store coverage
   * differ from the published generation: one synchronous transaction, then
   * memory. Returns null when nothing changed.
   */
  private commit(
    rows: readonly Readonly<SessionCatalogRow>[],
    index: ReadonlyMap<string, IndexEntry>,
    sources: readonly SessionCatalogSqliteSource[],
  ): SessionCatalogWrite | null {
    this.ensureRunning();
    const current = this.requirePublished();
    const changes: SessionCatalogSqliteChange[] = [];
    for (const [key, entry] of index) {
      if (current.index.get(key)?.hash !== entry.hash)
        changes.push({ type: "upsert", row: rows[entry.position]! });
    }
    for (const [key, entry] of current.index) {
      if (index.has(key)) continue;
      const row = current.rows[entry.position]!;
      changes.push({
        type: "delete",
        key: {
          catalogFamily: row.catalogFamily,
          storeKey: row.storeKey,
          sessionId: row.sessionId,
        },
      });
    }
    if (
      changes.length === 0 &&
      sourceSetKey(sources) === sourceSetKey(current.sources)
    ) {
      this.unchangedReconciliations += 1;
      return null;
    }
    const state = {
      epoch: current.epoch,
      generation: current.generation + 1,
      completedAt: new Date(this.now()).toISOString(),
    };
    const purgeTo = state.generation - this.tombstoneGenerations;
    const horizon =
      purgeTo - current.tombstoneHorizon >=
      Math.max(1, Math.floor(this.tombstoneGenerations / 10))
        ? purgeTo
        : 0;
    const startedAt = performance.now();
    const { written, tombstoneHorizon, follows } = this.withStore((store) => {
      const stored = store.readState();
      const follows =
        stored?.epoch === current.epoch &&
        stored.generation === current.generation;
      const written = follows
        ? store.applyChanges(
            state,
            current.generation,
            changes,
            sources,
            horizon,
          )
        : // The tables no longer hold what this process published (changed
          // from outside, or restored): store the whole generation instead.
          store.writeGeneration(state, rows, sources);
      return {
        written,
        follows,
        tombstoneHorizon: store.readState()?.tombstoneHorizon ?? 0,
      };
    });
    const write: SessionCatalogWrite = {
      ...written,
      generation: state.generation,
      durationMs: performance.now() - startedAt,
    };
    this.published = {
      ...state,
      tombstoneHorizon,
      changeFloor: follows
        ? Math.max(current.changeFloor, tombstoneHorizon)
        : state.generation,
      rows: Object.freeze([...rows]),
      index,
      sources: Object.freeze([...sources]),
    };
    this.publications += 1;
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

function groupByProject(
  rows: readonly Readonly<SessionCatalogRow>[],
): Map<string, readonly Readonly<SessionCatalogRow>[]> {
  const groups = new Map<string, Readonly<SessionCatalogRow>[]>();
  for (const row of rows) {
    const group = groups.get(row.projectIdentityKey);
    if (group) group.push(row);
    else groups.set(row.projectIdentityKey, [row]);
  }
  for (const group of groups.values()) {
    group.sort(
      (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
    );
    Object.freeze(group);
  }
  return groups;
}

/**
 * Whether two normalized rows serialize identically: the same keys, in the
 * order normalization fixes, with equal values.
 */
function sameRow(
  left: Readonly<SessionCatalogRow>,
  right: Readonly<SessionCatalogRow>,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  for (let index = 0; index < leftKeys.length; index += 1) {
    const key = leftKeys[index]!;
    if (key !== rightKeys[index]) return false;
    const a = (left as Record<string, unknown>)[key];
    const b = (right as Record<string, unknown>)[key];
    if (a === b) continue;
    if (typeof a !== "object" || typeof b !== "object" || !a || !b)
      return false;
    if (JSON.stringify(a) !== JSON.stringify(b)) return false;
  }
  return true;
}

function sourceSetKey(sources: readonly SessionCatalogSqliteSource[]): string {
  return [
    ...new Set(
      sources.map((source) => rowKey(source.catalogFamily, source.storeKey)),
    ),
  ]
    .sort()
    .join("\n");
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
