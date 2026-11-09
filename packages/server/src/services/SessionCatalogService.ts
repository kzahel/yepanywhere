import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { SourceVersionedSingleFlight } from "../lib/sourceVersionedSingleFlight.js";
import type { ProviderCatalogFamily } from "../sessions/provider-catalog-family.js";
import {
  type NativeSessionCatalogAdapter,
  type SessionCatalogRow,
  type SessionCatalogRowKey,
  type SessionCatalogScanMode,
  SESSION_CATALOG_TITLE_MAX_LENGTH,
} from "../sessions/catalog-types.js";
import {
  type CatalogRowsValue,
  GenerationWriter,
  type ProjectRowsValue,
  SessionCatalogCorruptionError,
  type ShardLine,
  isMissingFile,
  projectBucket,
  projectSlice,
  readProjectRowsFromShard,
  readShardLines,
  readShardRows,
} from "./session-catalog-shards.js";

const MANIFEST_SCHEMA_VERSION = 1;
const DEFAULT_BUCKET_COUNT = 64;
const DEFAULT_HOT_BYTES = 8 * 1024 * 1024;
const DEFAULT_DELTA_BYTES = 1024 * 1024;
const DEFAULT_DELTA_AGE_MS = 15 * 60 * 1000;
const DEFAULT_DELTA_COMPARE_SHARD_BYTES = 8 * 1024 * 1024;
const DEFAULT_RECENT_ROWS = 200;
const DEFAULT_RECENT_BYTES = 256 * 1024;
const DEFAULT_MAX_ROW_BYTES = 64 * 1024;
const DEFAULT_RETAINED_GENERATIONS = 2;
const MAX_PROJECT_READ_RETARGETS = 4;

export interface SessionCatalogToken {
  catalogEpoch: string;
  catalogGeneration: number;
}

export interface SessionCatalogShardSnapshot {
  bucket: number;
  file: string;
  rowCount: number;
  bytes: number;
  /** Digest of this shard's rows, so an unchanged bucket is never re-read. */
  contentHash: string;
  /** Catalog generation in which this shard's content last changed. */
  generation: number;
}

export interface SessionCatalogProviderSourceSnapshot {
  catalogFamily: ProviderCatalogFamily;
  storeKey: string;
  sourceVersion: string;
  rowCount: number;
  metrics: Readonly<Record<string, number>>;
}

export type SessionCatalogDeltaChange =
  | { type: "upsert"; row: SessionCatalogRow }
  | { type: "delete"; key: SessionCatalogRowKey };

export interface SessionCatalogDelta {
  fromGeneration: number;
  toGeneration: number;
  createdAt: string;
  replacementRequired: boolean;
  changes: SessionCatalogDeltaChange[];
  bytes: number;
}

export interface SessionCatalogSnapshot extends SessionCatalogToken {
  completedAt: string;
  rowCount: number;
  rowsBytes: number;
  shards: SessionCatalogShardSnapshot[];
  providerSources: SessionCatalogProviderSourceSnapshot[];
  recentRows: SessionCatalogRow[];
}

interface PersistedSessionCatalogManifest extends SessionCatalogSnapshot {
  schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  bucketCount: number;
  generationDirectory: string | null;
  deltas: SessionCatalogDelta[];
}

export type SessionCatalogConditionalResult =
  | { status: "no-change"; token: SessionCatalogToken }
  | {
      status: "deltas";
      token: SessionCatalogToken;
      deltas: SessionCatalogDelta[];
    }
  | { status: "replacement"; snapshot: SessionCatalogSnapshot };

/**
 * One component of the catalog's generation vector. `catalogGeneration`
 * orders global publication; `shardGeneration` moves only when this project's
 * bucket actually changed, so an unrelated write does not invalidate it.
 */
export interface SessionCatalogShardToken extends SessionCatalogToken {
  bucket: number;
  shardGeneration: number;
}

export interface SessionCatalogProjectRows extends SessionCatalogShardToken {
  rows: ReadonlyArray<Readonly<SessionCatalogRow>>;
}

export type SessionCatalogProjectConditionalResult =
  | { status: "no-change"; token: SessionCatalogShardToken }
  | { status: "changed"; token: SessionCatalogShardToken };

export interface SessionCatalogReconcileMetrics {
  durationMs: number;
  adapterScans: number;
  rowsWritten: number;
  bytesWritten: number;
  deltaBytes: number;
  deltaChanges: number;
  deltaReplacementRequired: boolean;
  cleanupFailures: number;
}

export interface SessionCatalogReconcileResult {
  status: "computed" | "joined";
  snapshot: SessionCatalogSnapshot;
  metrics: SessionCatalogReconcileMetrics;
}

export interface SessionCatalogServiceMetrics {
  reconciliationRequests: number;
  reconciliationStarts: number;
  reconciliationJoins: number;
  reconciliationQueuedBehindDifferentScope: number;
  reconciliationFailures: number;
  projectReadRequests: number;
  projectDiskReads: number;
  /** Whole-generation reads that walked shard files rather than memory. */
  catalogDiskReads: number;
  projectShardNoChange: number;
  deltaShardsCompared: number;
  deltaShardsSkippedByHash: number;
  /**
   * Publications whose previous generation had an unreadable changed shard.
   * The new generation replaces it; clients are sent a replacement.
   */
  deltaBaseUnreadable: number;
  resetFailures: number;
  lastResetReason: string | null;
  catalogEpoch: string | null;
  catalogGeneration: number;
  rowCount: number;
  rowsBytes: number;
  hotSet: ReturnType<
    SourceVersionedSingleFlight<string, ProjectRowsValue>["getStats"]
  >;
}

export interface SessionCatalogServiceOptions {
  /** YA app-data root. Catalog files live below session-catalog/. */
  dataDir: string;
  bucketCount?: number;
  maxHotBytes?: number;
  maxDeltaBytes?: number;
  maxDeltaAgeMs?: number;
  maxDeltaCompareShardBytes?: number;
  maxRecentRows?: number;
  maxRecentBytes?: number;
  maxRowBytes?: number;
  retainedGenerations?: number;
  now?: () => number;
  createEpoch?: () => string;
  /**
   * Called when a read finds the current generation unreadable and ends the
   * lineage. The catalog is then empty until its owner reconciles, and
   * nothing else will ask it to.
   */
  onLineageReset?: () => void;
}

interface ReconcileInFlight {
  signature: string;
  controller: AbortController;
  promise: Promise<Omit<SessionCatalogReconcileResult, "status">>;
}

const WHOLE_CATALOG_KEY = "all";

/**
 * Newest-first window of rows under a row and byte budget, maintained by
 * bounded insertion so one scanned row never costs a sort of the window.
 */
class RecentRowWindow {
  private readonly rows: SessionCatalogRow[] = [];
  private readonly updatedAtMs: number[] = [];
  private bytes = 0;

  constructor(
    private readonly maxRows: number,
    private readonly maxBytes: number,
  ) {}

  add(row: SessionCatalogRow): void {
    if (this.maxRows === 0 || this.maxBytes === 0) return;
    const updatedAtMs = Date.parse(row.updatedAt);
    const rowBytes = Buffer.byteLength(JSON.stringify(row)) + 1;
    if (
      this.rows.length >= this.maxRows &&
      updatedAtMs <= (this.updatedAtMs[this.rows.length - 1] ?? 0)
    ) {
      return;
    }
    const index = this.insertionIndex(updatedAtMs);
    this.rows.splice(index, 0, row);
    this.updatedAtMs.splice(index, 0, updatedAtMs);
    this.bytes += rowBytes;
    while (
      this.rows.length > 0 &&
      (this.rows.length > this.maxRows || this.bytes > this.maxBytes)
    ) {
      const dropped = this.rows.pop();
      this.updatedAtMs.pop();
      if (dropped) this.bytes -= Buffer.byteLength(JSON.stringify(dropped)) + 1;
    }
  }

  snapshot(): SessionCatalogRow[] {
    return [...this.rows];
  }

  private insertionIndex(updatedAtMs: number): number {
    let low = 0;
    let high = this.updatedAtMs.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if ((this.updatedAtMs[middle] ?? 0) >= updatedAtMs) low = middle + 1;
      else high = middle;
    }
    return low;
  }
}

/**
 * Owns one complete, durable catalog generation. Provider scans run outside
 * request paths. The current generation's rows stay parsed in RAM, seeded by
 * the publication that wrote them; project reads slice them, or stream one
 * deterministic shard when they are absent, into a byte-bounded hot set.
 */
export class SessionCatalogService {
  private readonly catalogDir: string;
  private readonly generationsDir: string;
  private readonly manifestPath: string;
  private readonly bucketCount: number;
  private readonly maxDeltaBytes: number;
  private readonly maxDeltaAgeMs: number;
  private readonly maxDeltaCompareShardBytes: number;
  private readonly maxRecentRows: number;
  private readonly maxRecentBytes: number;
  private readonly maxRowBytes: number;
  private readonly retainedGenerations: number;
  /** Generation directories with in-flight readers, by reader count. */
  private readonly pinnedGenerations = new Map<string, number>();
  private readonly now: () => number;
  private readonly createEpoch: () => string;
  private readonly onLineageReset?: () => void;
  private readonly projectRowsOwner: SourceVersionedSingleFlight<
    string,
    ProjectRowsValue
  >;
  /**
   * The current generation's parsed rows, outside the project hot budget.
   * Whole-catalog reads are the common path (every list and reconciliation),
   * and the catalog outgrows any fixed byte budget: counted against one, a
   * full read evicted every project entry and then itself, so each caller
   * re-read and re-parsed every shard. One fixed key keeps exactly one
   * generation, replaced at publication by the rows that publication wrote.
   */
  private readonly catalogRowsOwner = new SourceVersionedSingleFlight<
    string,
    CatalogRowsValue
  >({ maxRetainedBytes: Number.POSITIVE_INFINITY, estimateBytes: () => 0 });
  private manifest: PersistedSessionCatalogManifest | null = null;
  private reconcileInFlight: ReconcileInFlight | null = null;
  private stopped = false;
  private reconciliationRequests = 0;
  private reconciliationStarts = 0;
  private reconciliationJoins = 0;
  private reconciliationQueuedBehindDifferentScope = 0;
  private reconciliationFailures = 0;
  private projectReadRequests = 0;
  private projectDiskReads = 0;
  private catalogDiskReads = 0;
  private projectShardNoChange = 0;
  private deltaShardsCompared = 0;
  private deltaShardsSkippedByHash = 0;
  private deltaBaseUnreadable = 0;
  private resetFailures = 0;
  private lastResetReason: string | null = null;

  constructor(options: SessionCatalogServiceOptions) {
    this.catalogDir = join(options.dataDir, "session-catalog");
    this.generationsDir = join(this.catalogDir, "generations");
    this.manifestPath = join(this.catalogDir, "manifest.json");
    this.bucketCount = positiveInteger(
      options.bucketCount ?? DEFAULT_BUCKET_COUNT,
      "bucketCount",
      1_024,
    );
    this.maxDeltaBytes = nonNegativeInteger(
      options.maxDeltaBytes ?? DEFAULT_DELTA_BYTES,
      "maxDeltaBytes",
    );
    this.maxDeltaAgeMs = nonNegativeInteger(
      options.maxDeltaAgeMs ?? DEFAULT_DELTA_AGE_MS,
      "maxDeltaAgeMs",
    );
    this.maxDeltaCompareShardBytes = nonNegativeInteger(
      options.maxDeltaCompareShardBytes ?? DEFAULT_DELTA_COMPARE_SHARD_BYTES,
      "maxDeltaCompareShardBytes",
    );
    this.maxRecentRows = nonNegativeInteger(
      options.maxRecentRows ?? DEFAULT_RECENT_ROWS,
      "maxRecentRows",
    );
    this.maxRecentBytes = nonNegativeInteger(
      options.maxRecentBytes ?? DEFAULT_RECENT_BYTES,
      "maxRecentBytes",
    );
    this.maxRowBytes = positiveInteger(
      options.maxRowBytes ?? DEFAULT_MAX_ROW_BYTES,
      "maxRowBytes",
    );
    this.retainedGenerations = positiveInteger(
      options.retainedGenerations ?? DEFAULT_RETAINED_GENERATIONS,
      "retainedGenerations",
      16,
    );
    this.now = options.now ?? Date.now;
    this.createEpoch = options.createEpoch ?? randomUUID;
    this.onLineageReset = options.onLineageReset;
    this.projectRowsOwner = new SourceVersionedSingleFlight({
      maxRetainedBytes: nonNegativeInteger(
        options.maxHotBytes ?? DEFAULT_HOT_BYTES,
        "maxHotBytes",
      ),
      estimateBytes: (value) => Math.max(64, value.bytes),
    });
  }

  async initialize(): Promise<SessionCatalogSnapshot> {
    if (this.manifest) return this.snapshotFrom(this.manifest);
    await mkdir(this.generationsDir, { recursive: true });
    try {
      const parsed = JSON.parse(
        await readFile(this.manifestPath, "utf-8"),
      ) as unknown;
      this.manifest = validateManifest(parsed, this.bucketCount);
      return this.snapshotFrom(this.manifest);
    } catch (error) {
      // A cache must never be able to keep the server from starting. Anything
      // unreadable or incompatible ends this lineage: the catalog restarts at
      // a fresh epoch and reconciliation refills it.
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") this.recordReset(error);
    }
    return this.snapshotFrom(await this.startLineage());
  }

  private recordReset(reason: unknown): void {
    this.resetFailures += 1;
    this.lastResetReason =
      reason instanceof Error ? reason.message : String(reason);
  }

  /**
   * End the current lineage at a fresh epoch and generation 0. The in-memory
   * manifest is replaced before any await, so concurrent callers observe the
   * reset at once and no reader returns to the abandoned generation.
   */
  private async startLineage(): Promise<PersistedSessionCatalogManifest> {
    const manifest: PersistedSessionCatalogManifest = {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      bucketCount: this.bucketCount,
      catalogEpoch: this.createEpoch(),
      catalogGeneration: 0,
      completedAt: new Date(this.now()).toISOString(),
      generationDirectory: null,
      rowCount: 0,
      rowsBytes: 0,
      shards: [],
      providerSources: [],
      recentRows: [],
      deltas: [],
    };
    this.manifest = manifest;
    this.catalogRowsOwner.invalidate(WHOLE_CATALOG_KEY);
    await this.persistManifest(manifest);
    await this.cleanupGenerationDirectories(null);
    return manifest;
  }

  /**
   * A shard the current manifest names but cannot be read back (a torn or
   * interrupted write, a full disk, outside damage) is the same unreadable
   * cache state `initialize` recovers from. Rethrowing it would fail every
   * collection read and, because reconciliation starts with a read, keep the
   * catalog from ever rebuilding itself.
   */
  private async resetUnreadableGeneration(
    manifest: PersistedSessionCatalogManifest,
    error: unknown,
  ): Promise<boolean> {
    if (
      !(error instanceof SessionCatalogCorruptionError || isMissingFile(error))
    )
      return false;
    // Concurrent readers of one generation fail together; one reset serves all.
    if (this.manifest !== manifest) return true;
    this.recordReset(error);
    try {
      await this.startLineage();
    } finally {
      // The empty generation is already current even if persisting it failed.
      this.onLineageReset?.();
    }
    return true;
  }

  getSnapshot(): SessionCatalogSnapshot {
    return this.snapshotFrom(this.requireManifest());
  }

  /** Fixed-cost publication identity without copying rows or touching disk. */
  getToken(): SessionCatalogToken {
    return this.tokenFrom(this.requireManifest());
  }

  /** Read one coherent compact generation without consulting provider storage. */
  /**
   * Hold a generation directory against cleanup while a reader walks it.
   *
   * Retention counts directories, not readers: with two generations
   * published back to back, the directory a whole-catalog read started from
   * is the one cleanup removes, and the read then failed mid-walk with
   * ENOENT on a later bucket. A pinned directory outlives retention until
   * its last reader releases it; the next publication's cleanup removes it.
   */
  pinGeneration(directory: string): () => void {
    this.pinnedGenerations.set(
      directory,
      (this.pinnedGenerations.get(directory) ?? 0) + 1,
    );
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.pinnedGenerations.get(directory) ?? 1) - 1;
      if (remaining > 0) this.pinnedGenerations.set(directory, remaining);
      else this.pinnedGenerations.delete(directory);
    };
  }

  async readRows(options?: { recoverUnreadable?: boolean }): Promise<{
    snapshot: SessionCatalogSnapshot;
    rows: ReadonlyArray<Readonly<SessionCatalogRow>>;
  }> {
    for (let attempt = 0; attempt < MAX_PROJECT_READ_RETARGETS; attempt += 1) {
      this.ensureRunning();
      const manifest = this.requireManifest();
      let result: Awaited<ReturnType<typeof this.catalogRowsOwner.run>>;
      try {
        result = await this.catalogRowsOwner.run({
          key: WHOLE_CATALOG_KEY,
          sourceVersion: catalogRowsVersion(manifest),
          compute: async () => {
            const rows: Readonly<SessionCatalogRow>[] = [];
            const rowBytes: number[] = [];
            if (manifest.generationDirectory) {
              this.catalogDiskReads += 1;
              const release = this.pinGeneration(manifest.generationDirectory);
              try {
                for (const shard of manifest.shards) {
                  const path = this.shardPath(
                    manifest.generationDirectory,
                    shard.file,
                  );
                  for await (const { row, line } of readShardRows(path)) {
                    rows.push(Object.freeze(row));
                    rowBytes.push(Buffer.byteLength(line) + 1);
                  }
                }
              } finally {
                release();
              }
            }
            return {
              rows: Object.freeze(rows),
              rowBytes: Object.freeze(rowBytes),
            };
          },
          isCurrent: () => this.manifest === manifest && !this.stopped,
        });
      } catch (error) {
        // A shard that vanished under a superseded manifest is a retarget;
        // under the current manifest it is corruption, and ends the lineage.
        if (options?.recoverUnreadable === false) throw error;
        if (await this.resetUnreadableGeneration(manifest, error)) continue;
        throw error;
      }
      if (result.status !== "stale") {
        return {
          snapshot: this.snapshotFrom(manifest),
          rows: result.value.rows,
        };
      }
    }
    throw new Error(
      "Session catalog generation kept moving during collection read",
    );
  }

  getConditional(token: SessionCatalogToken): SessionCatalogConditionalResult {
    const manifest = this.requireManifest();
    const current = this.tokenFrom(manifest);
    if (
      token.catalogEpoch !== manifest.catalogEpoch ||
      token.catalogGeneration < 0 ||
      token.catalogGeneration > manifest.catalogGeneration
    ) {
      return { status: "replacement", snapshot: this.snapshotFrom(manifest) };
    }
    if (token.catalogGeneration === manifest.catalogGeneration) {
      return { status: "no-change", token: current };
    }

    const deltas: SessionCatalogDelta[] = [];
    let nextGeneration = token.catalogGeneration;
    for (const delta of manifest.deltas) {
      if (delta.fromGeneration !== nextGeneration) continue;
      if (delta.replacementRequired) {
        return {
          status: "replacement",
          snapshot: this.snapshotFrom(manifest),
        };
      }
      deltas.push(cloneDelta(delta));
      nextGeneration = delta.toGeneration;
      if (nextGeneration === manifest.catalogGeneration) {
        return { status: "deltas", token: current, deltas };
      }
    }
    return { status: "replacement", snapshot: this.snapshotFrom(manifest) };
  }

  /**
   * Generation vector component for one project's shard. A caller holding a
   * matching `shardGeneration` needs no rows even when the global generation
   * has moved for unrelated projects.
   */
  getProjectToken(projectIdentityKey: string): SessionCatalogShardToken {
    const manifest = this.requireManifest();
    return this.projectTokenFrom(manifest, projectIdentityKey);
  }

  /**
   * `changed` means the caller should read rows; it does not carry them, so a
   * revalidation that needs nothing costs no row work.
   */
  getProjectConditional(
    projectIdentityKey: string,
    token: SessionCatalogShardToken,
  ): SessionCatalogProjectConditionalResult {
    const current = this.getProjectToken(projectIdentityKey);
    if (
      token.catalogEpoch === current.catalogEpoch &&
      token.bucket === current.bucket &&
      token.shardGeneration === current.shardGeneration
    ) {
      this.projectShardNoChange += 1;
      return { status: "no-change", token: current };
    }
    return { status: "changed", token: current };
  }

  async readProjectRows(
    projectIdentityKey: string,
    options: { recoverUnreadable?: boolean } = {},
  ): Promise<SessionCatalogProjectRows> {
    this.projectReadRequests += 1;
    // A generation published between admission and completion retargets the
    // read. The bound keeps a pathological publish rate from recursing freely.
    for (let attempt = 0; attempt < MAX_PROJECT_READ_RETARGETS; attempt += 1) {
      const attempted = await this.readProjectRowsOnce(
        projectIdentityKey,
        options,
      );
      if (attempted) return attempted;
    }
    throw new Error(
      `Session catalog generation kept moving under ${projectIdentityKey}`,
    );
  }

  private async readProjectRowsOnce(
    projectIdentityKey: string,
    options: { recoverUnreadable?: boolean },
  ): Promise<SessionCatalogProjectRows | null> {
    this.ensureRunning();
    const manifest = this.requireManifest();
    const token = this.projectTokenFrom(manifest, projectIdentityKey);
    if (!manifest.generationDirectory || manifest.catalogGeneration === 0) {
      return { ...token, rows: [] };
    }
    const shard = manifest.shards.find(
      (candidate) => candidate.bucket === token.bucket,
    );
    if (!shard) return { ...token, rows: [] };

    const filePath = this.shardPath(manifest.generationDirectory, shard.file);
    // Keyed by shard content, not by generation: a new generation that leaves
    // this bucket byte-identical reuses the retained rows instead of re-reading.
    const key = `${manifest.catalogEpoch}:${projectIdentityKey}`;
    let result: Awaited<ReturnType<typeof this.projectRowsOwner.run>>;
    try {
      result = await this.projectRowsOwner.run({
        key,
        sourceVersion: shard.contentHash,
        compute: async () => {
          const retained = this.catalogRowsOwner.getAccepted(WHOLE_CATALOG_KEY);
          if (retained?.sourceVersion === catalogRowsVersion(manifest)) {
            return projectSlice(retained.value, projectIdentityKey);
          }
          this.projectDiskReads += 1;
          const release = this.pinGeneration(manifest.generationDirectory!);
          try {
            return await readProjectRowsFromShard(filePath, projectIdentityKey);
          } finally {
            release();
          }
        },
        isCurrent: (candidate) =>
          this.currentShardContentHash(token.bucket) === candidate,
      });
    } catch (error) {
      if (
        options.recoverUnreadable !== false &&
        (await this.resetUnreadableGeneration(manifest, error))
      )
        return null;
      throw error;
    }
    if (result.status === "stale") {
      if (this.requireManifest() !== manifest) return null;
      throw new Error(`Session catalog shard disappeared: ${filePath}`);
    }
    return { ...token, rows: result.value.rows };
  }

  private currentShardContentHash(bucket: number): string | null {
    const manifest = this.manifest;
    if (!manifest) return null;
    return (
      manifest.shards.find((shard) => shard.bucket === bucket)?.contentHash ??
      null
    );
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

  stop(): void {
    this.stopped = true;
    this.reconcileInFlight?.controller.abort();
    this.projectRowsOwner.clear();
    this.catalogRowsOwner.clear();
  }

  getMetrics(): SessionCatalogServiceMetrics {
    return {
      reconciliationRequests: this.reconciliationRequests,
      reconciliationStarts: this.reconciliationStarts,
      reconciliationJoins: this.reconciliationJoins,
      reconciliationQueuedBehindDifferentScope:
        this.reconciliationQueuedBehindDifferentScope,
      reconciliationFailures: this.reconciliationFailures,
      projectReadRequests: this.projectReadRequests,
      projectDiskReads: this.projectDiskReads,
      catalogDiskReads: this.catalogDiskReads,
      projectShardNoChange: this.projectShardNoChange,
      deltaShardsCompared: this.deltaShardsCompared,
      deltaShardsSkippedByHash: this.deltaShardsSkippedByHash,
      deltaBaseUnreadable: this.deltaBaseUnreadable,
      resetFailures: this.resetFailures,
      lastResetReason: this.lastResetReason,
      catalogEpoch: this.manifest?.catalogEpoch ?? null,
      catalogGeneration: this.manifest?.catalogGeneration ?? 0,
      rowCount: this.manifest?.rowCount ?? 0,
      rowsBytes: this.manifest?.rowsBytes ?? 0,
      hotSet: this.projectRowsOwner.getStats(),
    };
  }

  private async buildGeneration(
    adapters: readonly NativeSessionCatalogAdapter[],
    mode: SessionCatalogScanMode,
    signal: AbortSignal,
  ): Promise<Omit<SessionCatalogReconcileResult, "status">> {
    const previous = this.requireManifest();
    const targetGeneration = previous.catalogGeneration + 1;
    const startedAt = this.now();
    const stagingDirectoryName = `.staging-${targetGeneration}-${randomUUID()}`;
    const stagingDirectory = join(this.generationsDir, stagingDirectoryName);
    const finalDirectoryName = `gen-${targetGeneration}-${randomUUID()}`;
    const finalDirectory = join(this.generationsDir, finalDirectoryName);
    await mkdir(stagingDirectory, { recursive: false });
    const writer = new GenerationWriter(
      stagingDirectory,
      this.bucketCount,
      this.maxRowBytes,
    );
    const recentRows = new RecentRowWindow(
      this.maxRecentRows,
      this.maxRecentBytes,
    );
    const providerSources: SessionCatalogProviderSourceSnapshot[] = [];
    let rowCount = 0;
    let rowsBytes = 0;
    let finalDirectoryCreated = false;
    let cleanupFailures = 0;

    try {
      for (const adapter of adapters) {
        throwIfAborted(signal);
        const scan = await adapter.scan({
          catalogEpoch: previous.catalogEpoch,
          targetGeneration,
          mode,
          signal,
        });
        requireNonEmpty(scan.sourceVersion, "adapter sourceVersion");
        let adapterRows = 0;
        for await (const candidate of scan.rows) {
          throwIfAborted(signal);
          const row = normalizeRow(candidate, adapter);
          rowsBytes += await writer.write(row);
          rowCount += 1;
          adapterRows += 1;
          recentRows.add(row);
        }
        providerSources.push({
          catalogFamily: adapter.catalogFamily,
          storeKey: adapter.storeKey,
          sourceVersion: scan.sourceVersion,
          rowCount: adapterRows,
          metrics: { ...scan.metrics },
        });
      }
      await writer.close();
      throwIfAborted(signal);
      await rename(stagingDirectory, finalDirectory);
      finalDirectoryCreated = true;

      const completedAt = new Date(this.now()).toISOString();
      const nextWithoutDeltas: PersistedSessionCatalogManifest = {
        schemaVersion: MANIFEST_SCHEMA_VERSION,
        bucketCount: this.bucketCount,
        catalogEpoch: previous.catalogEpoch,
        catalogGeneration: targetGeneration,
        completedAt,
        generationDirectory: finalDirectoryName,
        rowCount,
        rowsBytes,
        shards: carryShardGenerations(
          writer.snapshots(),
          previous.shards,
          targetGeneration,
        ),
        providerSources,
        recentRows: recentRows.snapshot(),
        deltas: [],
      };
      const delta = await this.computeDelta(previous, nextWithoutDeltas);
      const manifest = {
        ...nextWithoutDeltas,
        deltas: retainDeltas(
          [...previous.deltas, delta],
          this.now(),
          this.maxDeltaAgeMs,
          this.maxDeltaBytes,
        ),
      };
      // A reader that found this pass's base generation unreadable ended its
      // lineage; publishing onto the abandoned epoch would resurrect it.
      if (this.manifest !== previous) {
        throw new Error("Session catalog lineage was reset during reconcile");
      }
      await this.persistManifest(manifest);
      this.manifest = manifest;
      // Admitted before any await, so a reader arriving now joins these rows
      // instead of reading back the generation this pass just wrote.
      const written = writer.writtenRows();
      const retaining = this.catalogRowsOwner.run({
        key: WHOLE_CATALOG_KEY,
        sourceVersion: catalogRowsVersion(manifest),
        compute: async () => written,
        isCurrent: () => this.manifest === manifest && !this.stopped,
      });
      cleanupFailures =
        await this.cleanupGenerationDirectories(finalDirectoryName);
      await retaining;

      return {
        snapshot: this.snapshotFrom(manifest),
        metrics: {
          durationMs: this.now() - startedAt,
          adapterScans: adapters.length,
          rowsWritten: rowCount,
          bytesWritten: rowsBytes,
          deltaBytes: delta.bytes,
          deltaChanges: delta.changes.length,
          deltaReplacementRequired: delta.replacementRequired,
          cleanupFailures,
        },
      };
    } catch (error) {
      await writer.close().catch(() => {});
      await rm(finalDirectoryCreated ? finalDirectory : stagingDirectory, {
        recursive: true,
        force: true,
      }).catch(() => {});
      throw error;
    }
  }

  private async computeDelta(
    previous: PersistedSessionCatalogManifest,
    next: PersistedSessionCatalogManifest,
  ): Promise<SessionCatalogDelta> {
    const delta: SessionCatalogDelta = {
      fromGeneration: previous.catalogGeneration,
      toGeneration: next.catalogGeneration,
      createdAt: next.completedAt,
      replacementRequired: false,
      changes: [],
      bytes: 0,
    };
    const previousShards = new Map(
      previous.shards.map((shard) => [shard.bucket, shard]),
    );
    const nextShards = new Map(
      next.shards.map((shard) => [shard.bucket, shard]),
    );
    const buckets = new Set([...previousShards.keys(), ...nextShards.keys()]);

    for (const bucket of [...buckets].sort((left, right) => left - right)) {
      const previousShard = previousShards.get(bucket);
      const nextShard = nextShards.get(bucket);
      // The writer digested every shard, so an unchanged bucket is provably
      // change-free without reading either generation back off disk.
      if (previousShard?.contentHash === nextShard?.contentHash) {
        this.deltaShardsSkippedByHash += 1;
        continue;
      }
      if (
        (previousShard?.bytes ?? 0) > this.maxDeltaCompareShardBytes ||
        (nextShard?.bytes ?? 0) > this.maxDeltaCompareShardBytes
      ) {
        return replacementDelta(delta);
      }
      this.deltaShardsCompared += 1;
      let before = new Map<string, ShardLine>();
      if (previousShard) {
        try {
          before = await readShardLines(
            this.shardPath(
              requireGenerationDirectory(previous),
              previousShard.file,
            ),
          );
        } catch (error) {
          // Reads serve the retained rows, so damage to the previous
          // generation's files is met here, if at all. The new generation
          // rewrote every shard and is complete without them; clients just
          // cannot be given a delta.
          if (
            error instanceof SessionCatalogCorruptionError ||
            isMissingFile(error)
          ) {
            this.deltaBaseUnreadable += 1;
            this.lastResetReason =
              error instanceof Error ? error.message : String(error);
            return replacementDelta(delta);
          }
          throw error;
        }
      }
      const after = nextShard
        ? await readShardLines(
            this.shardPath(requireGenerationDirectory(next), nextShard.file),
          )
        : new Map<string, ShardLine>();

      for (const [key, entry] of after) {
        const old = before.get(key);
        if (old?.line === entry.line) continue;
        if (
          !appendDeltaChange(
            delta,
            { type: "upsert", row: entry.row },
            this.maxDeltaBytes,
          )
        ) {
          return replacementDelta(delta);
        }
      }
      for (const [key, entry] of before) {
        if (after.has(key)) continue;
        if (
          !appendDeltaChange(
            delta,
            {
              type: "delete",
              key: {
                catalogFamily: entry.row.catalogFamily,
                storeKey: entry.row.storeKey,
                sessionId: entry.row.sessionId,
              },
            },
            this.maxDeltaBytes,
          )
        ) {
          return replacementDelta(delta);
        }
      }
    }
    return delta;
  }

  /**
   * `currentDirectory` is null when the lineage was abandoned, in which case
   * no generation directory survives.
   */
  private async cleanupGenerationDirectories(
    currentDirectory: string | null,
  ): Promise<number> {
    let entries: string[];
    try {
      entries = await readdir(this.generationsDir);
    } catch {
      return 1;
    }
    const retained = new Set<string>();
    if (currentDirectory) {
      const generationDirectories = entries
        .filter((entry) => /^gen-\d+-[0-9a-f-]+$/.test(entry))
        .map((entry) => ({ entry, generation: generationFromDirectory(entry) }))
        .sort((left, right) => right.generation - left.generation);
      for (const { entry } of generationDirectories.slice(
        0,
        this.retainedGenerations,
      )) {
        retained.add(entry);
      }
      retained.add(currentDirectory);
    }
    let failures = 0;
    for (const entry of entries) {
      const removable =
        entry.startsWith(".staging-") ||
        (/^gen-\d+-[0-9a-f-]+$/.test(entry) &&
          !retained.has(entry) &&
          !this.pinnedGenerations.has(entry));
      if (!removable) continue;
      try {
        await rm(join(this.generationsDir, entry), {
          recursive: true,
          force: true,
        });
      } catch {
        failures += 1;
      }
    }
    return failures;
  }

  private async persistManifest(
    manifest: PersistedSessionCatalogManifest,
  ): Promise<void> {
    const temporaryPath = `${this.manifestPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, JSON.stringify(manifest), "utf-8");
      await rename(temporaryPath, this.manifestPath);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  private snapshotFrom(
    manifest: PersistedSessionCatalogManifest,
  ): SessionCatalogSnapshot {
    return {
      ...this.tokenFrom(manifest),
      completedAt: manifest.completedAt,
      rowCount: manifest.rowCount,
      rowsBytes: manifest.rowsBytes,
      shards: manifest.shards.map((shard) => ({ ...shard })),
      providerSources: manifest.providerSources.map((source) => ({
        ...source,
        metrics: { ...source.metrics },
      })),
      recentRows: manifest.recentRows.map(cloneRow),
    };
  }

  private tokenFrom(
    manifest: PersistedSessionCatalogManifest,
  ): SessionCatalogToken {
    return {
      catalogEpoch: manifest.catalogEpoch,
      catalogGeneration: manifest.catalogGeneration,
    };
  }

  private projectTokenFrom(
    manifest: PersistedSessionCatalogManifest,
    projectIdentityKey: string,
  ): SessionCatalogShardToken {
    const bucket = projectBucket(projectIdentityKey, manifest.bucketCount);
    const shard = manifest.shards.find(
      (candidate) => candidate.bucket === bucket,
    );
    return {
      ...this.tokenFrom(manifest),
      bucket,
      shardGeneration: shard?.generation ?? 0,
    };
  }

  private shardPath(directory: string, file: string): string {
    if (!/^gen-\d+-[0-9a-f-]+$/.test(directory)) {
      throw new Error(
        `Invalid session catalog generation directory: ${directory}`,
      );
    }
    if (!/^bucket-\d{3}\.jsonl$/.test(file)) {
      throw new Error(`Invalid session catalog shard file: ${file}`);
    }
    return join(this.generationsDir, directory, file);
  }

  private requireManifest(): PersistedSessionCatalogManifest {
    if (!this.manifest) {
      throw new Error(
        "SessionCatalogService not initialized. Call initialize() first.",
      );
    }
    return this.manifest;
  }

  private ensureRunning(): void {
    this.requireManifest();
    if (this.stopped) throw new Error("SessionCatalogService is stopped");
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

function normalizeRow(
  row: SessionCatalogRow,
  adapter: NativeSessionCatalogAdapter,
): SessionCatalogRow {
  if (row.catalogFamily !== adapter.catalogFamily) {
    throw new Error(
      `Catalog adapter ${adapter.catalogFamily}:${adapter.storeKey} yielded ${row.catalogFamily}`,
    );
  }
  if (row.storeKey !== adapter.storeKey) {
    throw new Error(
      `Catalog adapter ${adapter.catalogFamily}:${adapter.storeKey} yielded store ${row.storeKey}`,
    );
  }
  requireBoundedString(row.sessionId, "row sessionId", 4_096);
  if (row.nativeStorageScope !== undefined)
    requireBoundedString(
      row.nativeStorageScope,
      "row nativeStorageScope",
      4_096,
    );
  if (row.nativeDirectoryProjectId !== undefined)
    requireBoundedString(
      row.nativeDirectoryProjectId,
      "row nativeDirectoryProjectId",
      32_768,
    );
  requireBoundedString(row.projectId, "row projectId", 32_768);
  requireBoundedString(row.projectPath, "row projectPath", 32_768);
  requireBoundedString(
    row.projectIdentityKey,
    "row projectIdentityKey",
    32_768,
  );
  requireTimestamp(row.updatedAt, "row updatedAt");
  if (row.createdAt !== undefined)
    requireTimestamp(row.createdAt, "row createdAt");
  if (row.lastHumanTurnAt !== undefined)
    requireTimestamp(row.lastHumanTurnAt, "row lastHumanTurnAt");
  if (row.title !== undefined && row.title !== null) {
    requireBoundedString(
      row.title,
      "row title",
      SESSION_CATALOG_TITLE_MAX_LENGTH,
      true,
    );
  }
  if (!(["identity", "head", "tail"] as const).includes(row.fidelity)) {
    throw new Error(
      `Invalid session catalog fidelity: ${String(row.fidelity)}`,
    );
  }
  requireBoundedString(row.sourceVersion, "row sourceVersion", 16_384);
  if (
    row.rowFormat !== undefined &&
    !(Number.isSafeInteger(row.rowFormat) && row.rowFormat > 0)
  ) {
    throw new Error(
      `Invalid session catalog rowFormat: ${String(row.rowFormat)}`,
    );
  }
  validateLocation(row);
  return cloneRow(row);
}

function validateLocation(row: SessionCatalogRow): void {
  const location = row.location;
  switch (location.kind) {
    case "file":
      requireBoundedString(location.path, "row file path", 32_768);
      return;
    case "database":
      requireBoundedString(location.path, "row database path", 32_768);
      requireBoundedString(location.recordId, "row database recordId", 4_096);
      return;
    case "provider":
      requireBoundedString(location.recordId, "row provider recordId", 4_096);
      return;
  }
}

function cloneRow(row: SessionCatalogRow): SessionCatalogRow {
  return {
    catalogFamily: row.catalogFamily,
    storeKey: row.storeKey,
    sessionId: row.sessionId,
    ...(row.nativeStorageScope !== undefined
      ? { nativeStorageScope: row.nativeStorageScope }
      : {}),
    ...(row.nativeDirectoryProjectId !== undefined
      ? { nativeDirectoryProjectId: row.nativeDirectoryProjectId }
      : {}),
    projectId: row.projectId,
    projectPath: row.projectPath,
    projectIdentityKey: row.projectIdentityKey,
    updatedAt: row.updatedAt,
    ...(row.createdAt !== undefined ? { createdAt: row.createdAt } : {}),
    ...(row.lastHumanTurnAt !== undefined
      ? { lastHumanTurnAt: row.lastHumanTurnAt }
      : {}),
    ...(row.title !== undefined ? { title: row.title } : {}),
    ...(row.provider !== undefined ? { provider: row.provider } : {}),
    ...(row.projectName !== undefined ? { projectName: row.projectName } : {}),
    ...(row.asyncQuestions !== undefined
      ? { asyncQuestions: structuredClone(row.asyncQuestions) }
      : {}),
    fidelity: row.fidelity,
    sourceVersion: row.sourceVersion,
    ...(row.rowFormat !== undefined ? { rowFormat: row.rowFormat } : {}),
    location: { ...row.location },
  };
}

function cloneDelta(delta: SessionCatalogDelta): SessionCatalogDelta {
  return {
    ...delta,
    changes: delta.changes.map((change) =>
      change.type === "upsert"
        ? { type: "upsert", row: cloneRow(change.row) }
        : { type: "delete", key: { ...change.key } },
    ),
  };
}

/**
 * Assign each shard the generation in which its content last changed, so an
 * unrelated project's write does not invalidate a client's shard token.
 */
function carryShardGenerations(
  shards: ReadonlyArray<Omit<SessionCatalogShardSnapshot, "generation">>,
  previous: readonly SessionCatalogShardSnapshot[],
  targetGeneration: number,
): SessionCatalogShardSnapshot[] {
  const previousByBucket = new Map(
    previous.map((shard) => [shard.bucket, shard]),
  );
  return shards.map((shard) => {
    const before = previousByBucket.get(shard.bucket);
    return {
      ...shard,
      generation:
        before && before.contentHash === shard.contentHash
          ? before.generation
          : targetGeneration,
    };
  });
}

function appendDeltaChange(
  delta: SessionCatalogDelta,
  change: SessionCatalogDeltaChange,
  maxBytes: number,
): boolean {
  const bytes = Buffer.byteLength(JSON.stringify(change));
  if (delta.bytes + bytes > maxBytes) return false;
  delta.changes.push(change);
  delta.bytes += bytes;
  return true;
}

function replacementDelta(delta: SessionCatalogDelta): SessionCatalogDelta {
  return {
    ...delta,
    replacementRequired: true,
    changes: [],
    bytes: 0,
  };
}

function retainDeltas(
  deltas: SessionCatalogDelta[],
  now: number,
  maxAgeMs: number,
  maxBytes: number,
): SessionCatalogDelta[] {
  const minimumCreatedAt = now - maxAgeMs;
  const retained: SessionCatalogDelta[] = [];
  let retainedBytes = 0;
  for (let index = deltas.length - 1; index >= 0; index -= 1) {
    const delta = deltas[index];
    if (!delta || Date.parse(delta.createdAt) < minimumCreatedAt) continue;
    const bytes = Buffer.byteLength(JSON.stringify(delta));
    if (retainedBytes + bytes > maxBytes) break;
    retained.unshift(cloneDelta(delta));
    retainedBytes += bytes;
  }
  return retained;
}

function catalogRowsVersion(manifest: PersistedSessionCatalogManifest): string {
  return `${manifest.catalogEpoch}:${manifest.catalogGeneration}`;
}

function generationFromDirectory(directory: string): number {
  const match = /^gen-(\d+)-/.exec(directory);
  return match?.[1] ? Number(match[1]) : -1;
}

function requireGenerationDirectory(
  manifest: PersistedSessionCatalogManifest,
): string {
  if (!manifest.generationDirectory) {
    throw new Error(
      `Session catalog generation ${manifest.catalogGeneration} has no directory`,
    );
  }
  return manifest.generationDirectory;
}

function validateManifest(
  value: unknown,
  expectedBucketCount: number,
): PersistedSessionCatalogManifest {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid session catalog manifest: expected object");
  }
  const manifest = value as Partial<PersistedSessionCatalogManifest>;
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported session catalog manifest schema: ${String(manifest.schemaVersion)}`,
    );
  }
  if (manifest.bucketCount !== expectedBucketCount) {
    throw new Error(
      `Session catalog bucket count changed: ${String(manifest.bucketCount)} != ${expectedBucketCount}`,
    );
  }
  requireNonEmpty(manifest.catalogEpoch, "manifest catalogEpoch");
  nonNegativeInteger(manifest.catalogGeneration, "manifest catalogGeneration");
  requireTimestamp(manifest.completedAt, "manifest completedAt");
  if (!Array.isArray(manifest.shards)) {
    throw new Error("Invalid session catalog manifest shards");
  }
  if (!Array.isArray(manifest.providerSources)) {
    throw new Error("Invalid session catalog manifest providerSources");
  }
  if (!Array.isArray(manifest.recentRows)) {
    throw new Error("Invalid session catalog manifest recentRows");
  }
  if (!Array.isArray(manifest.deltas)) {
    throw new Error("Invalid session catalog manifest deltas");
  }
  if (
    manifest.generationDirectory !== null &&
    (typeof manifest.generationDirectory !== "string" ||
      !/^gen-\d+-[0-9a-f-]+$/.test(manifest.generationDirectory))
  ) {
    throw new Error("Invalid session catalog generation directory");
  }
  nonNegativeInteger(manifest.rowCount, "manifest rowCount");
  nonNegativeInteger(manifest.rowsBytes, "manifest rowsBytes");
  return manifest as PersistedSessionCatalogManifest;
}

function positiveInteger(
  value: unknown,
  name: string,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value <= 0 ||
    value > maximum
  ) {
    throw new RangeError(`${name} must be a positive integer <= ${maximum}`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer`);
  }
  return value;
}

function requireNonEmpty(
  value: unknown,
  name: string,
): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
}

function requireBoundedString(
  value: unknown,
  name: string,
  maxLength: number,
  allowEmpty = false,
): asserts value is string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    value.length > maxLength
  ) {
    throw new Error(`${name} must be a string of at most ${maxLength} chars`);
  }
}

function requireTimestamp(
  value: unknown,
  name: string,
): asserts value is string {
  requireNonEmpty(value, name);
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`${name} must be an ISO-compatible timestamp`);
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const error = new Error("Session catalog reconciliation aborted");
  error.name = "AbortError";
  throw error;
}
