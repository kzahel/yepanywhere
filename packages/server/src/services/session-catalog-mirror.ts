import { performance } from "node:perf_hooks";
import { getLogger } from "../logging/logger.js";
import type { SessionCatalogRow } from "../sessions/catalog-types.js";
import type { SqliteDatabase } from "../storage/sqlite.js";
import {
  type SessionCatalogSqliteChange,
  type SessionCatalogSqliteMismatch,
  type SessionCatalogSqliteSource,
  type SessionCatalogSqliteState,
  type SessionCatalogSqliteWrite,
  SessionCatalogSqliteStore,
  compareSessionCatalogRows,
  isSessionCatalogMatch,
  readSessionCatalogState,
} from "./session-catalog-sqlite.js";

export interface SessionCatalogMirrorWrite extends SessionCatalogSqliteWrite {
  /** `copy` at startup; `changes` or `generation` for a publication. */
  kind: "copy" | "changes" | "generation";
  generation: number;
  durationMs: number;
  /** Null when this write was not read back (see the compare interval). */
  compareMs: number | null;
}

export interface SessionCatalogMirrorMetrics {
  sqliteWrites: number;
  sqliteWriteFailures: number;
  sqliteComparisons: number;
  sqliteCompareFailures: number;
  /** Comparisons whose read-back differed from the published rows. */
  sqliteMismatches: number;
  /** Mismatches whose rows were rewritten from the published ones. */
  sqliteRepairs: number;
  lastSqliteWrite: SessionCatalogMirrorWrite | null;
  lastSqliteMismatch:
    | (SessionCatalogSqliteMismatch & { generation: number })
    | null;
}

type MirrorState = Omit<SessionCatalogSqliteState, "tombstoneHorizon">;

/**
 * Reading every row back costs 55–190 ms on a 7,500-row catalog, too much for
 * every publication. A change write is checked cheaply instead: each changed
 * key against its published hash, and the live row count. The full read-back
 * of a change write that passed runs at most this often; copies,
 * whole-generation writes and failed checks are always read back.
 * `YEP_CATALOG_SQLITE_COMPARE_MS` overrides it (0 reads back every write) for
 * the second-server gate.
 */
const DEFAULT_COMPARE_INTERVAL_MS = 10 * 60 * 1000;

function compareIntervalMs(): number {
  const value = Number(process.env.YEP_CATALOG_SQLITE_COMPARE_MS);
  return Number.isFinite(value) && value >= 0
    ? value
    : DEFAULT_COMPARE_INTERVAL_MS;
}

/**
 * Keeps the catalog tables in step with the published files while the files
 * stay authoritative (plan 189 step 3, second commit). Writes are followed by
 * reading every stored row back and comparing it with the published rows, so
 * the switch to SQLite reads can be gated on a mismatch count of zero.
 * Nothing here throws: a failure is counted and logged and the files keep
 * serving.
 */
export class SessionCatalogSqliteMirror {
  private writes = 0;
  private failures = 0;
  private comparisons = 0;
  private compareFailures = 0;
  private mismatches = 0;
  private repairs = 0;
  private lastComparedAt = Number.NEGATIVE_INFINITY;
  private lastWrite: SessionCatalogMirrorWrite | null = null;
  private lastMismatch: SessionCatalogMirrorMetrics["lastSqliteMismatch"] =
    null;

  constructor(
    private readonly database: SqliteDatabase,
    private readonly compareInterval = compareIntervalMs(),
    private readonly now: () => number = () => performance.now(),
  ) {}

  /** The stored lineage, or undefined when unreadable. */
  storedState(): SessionCatalogSqliteState | undefined {
    try {
      return readSessionCatalogState(this.database);
    } catch {
      return undefined;
    }
  }

  /**
   * Store a whole published generation at startup, diffed against the stored
   * rows, unless the stored generation of the same epoch is already at or
   * past it: a publication wrote it while the rows were being read. (A start
   * that finds SQLite ahead of the files ends the lineage before copying.)
   */
  copy(
    state: MirrorState,
    rows: readonly Readonly<SessionCatalogRow>[],
    sources: readonly SessionCatalogSqliteSource[],
  ): void {
    const stored = this.storedState();
    if (stored?.epoch === state.epoch && stored.generation >= state.generation)
      return;
    this.write("copy", state, rows, sources, (store) => ({
      written: store.writeGeneration(state, rows, sources),
      checked: false,
    }));
  }

  /**
   * Store one publication. When the stored generation is the one it follows
   * and the delta is complete, only its changes are written and checked by
   * key and live count; otherwise the whole generation is diffed. An empty
   * generation of a new epoch, as a lineage reset publishes, empties it.
   */
  publish(
    state: MirrorState,
    previousGeneration: number,
    changes: readonly SessionCatalogSqliteChange[] | null,
    rows: readonly Readonly<SessionCatalogRow>[],
    sources: readonly SessionCatalogSqliteSource[],
  ): void {
    const stored = this.storedState();
    const follows =
      changes !== null &&
      stored?.epoch === state.epoch &&
      stored.generation === previousGeneration;
    if (follows) {
      this.write("changes", state, rows, sources, (store) => {
        const written = store.applyChanges(
          state,
          previousGeneration,
          changes,
          sources,
        );
        const check = store.checkChanges(changes, rows.length);
        return {
          written,
          checked: check.countMatches && check.wrongKeys.length === 0,
        };
      });
    } else {
      this.write("generation", state, rows, sources, (store) => ({
        written: store.writeGeneration(state, rows, sources),
        checked: false,
      }));
    }
  }

  getMetrics(): SessionCatalogMirrorMetrics {
    return {
      sqliteWrites: this.writes,
      sqliteWriteFailures: this.failures,
      sqliteComparisons: this.comparisons,
      sqliteCompareFailures: this.compareFailures,
      sqliteMismatches: this.mismatches,
      sqliteRepairs: this.repairs,
      lastSqliteWrite: this.lastWrite,
      lastSqliteMismatch: this.lastMismatch,
    };
  }

  /**
   * `apply` writes and reports whether its own cheap check passed. A change
   * write that passed is read back in full only once per interval; any
   * other write, or a failed check, is read back now.
   */
  private write(
    kind: SessionCatalogMirrorWrite["kind"],
    state: MirrorState,
    rows: readonly Readonly<SessionCatalogRow>[],
    sources: readonly SessionCatalogSqliteSource[],
    apply: (store: SessionCatalogSqliteStore) => {
      written: SessionCatalogSqliteWrite;
      checked: boolean;
    },
  ): void {
    let store: SessionCatalogSqliteStore | undefined;
    try {
      const startedAt = performance.now();
      let result: ReturnType<typeof apply>;
      try {
        // Prepared and released within one synchronous step.
        store = new SessionCatalogSqliteStore(this.database);
        result = apply(store);
      } catch (error) {
        this.failures += 1;
        getLogger().warn(
          { err: error, kind, generation: state.generation },
          "SESSION_CATALOG: writing the catalog into SQLite failed",
        );
        return;
      }
      const writtenAt = performance.now();
      this.writes += 1;
      const write: SessionCatalogMirrorWrite = {
        kind,
        generation: state.generation,
        ...result.written,
        durationMs: writtenAt - startedAt,
        compareMs: null,
      };
      this.lastWrite = write;
      if (
        result.checked &&
        this.now() - this.lastComparedAt < this.compareInterval
      )
        return;
      this.compareAndRepair(store, state, rows, sources, write, writtenAt);
    } catch (error) {
      this.compareFailures += 1;
      getLogger().warn(
        { err: error, kind, generation: state.generation },
        "SESSION_CATALOG: comparing the catalog in SQLite failed",
      );
    } finally {
      store?.dispose();
    }
  }

  /**
   * Read every row back and compare. Rows that differ are rewritten from the
   * published ones, so a mismatch is counted once and does not persist into
   * the reads the next step moves to SQLite.
   */
  private compareAndRepair(
    store: SessionCatalogSqliteStore,
    state: MirrorState,
    rows: readonly Readonly<SessionCatalogRow>[],
    sources: readonly SessionCatalogSqliteSource[],
    write: SessionCatalogMirrorWrite,
    writtenAt: number,
  ): void {
    this.lastComparedAt = this.now();
    const compare = () =>
      compareSessionCatalogRows(
        store.readRows(),
        rows,
        store.readSources(),
        sources,
      );
    const { mismatch, keys } = compare();
    this.comparisons += 1;
    write.compareMs = performance.now() - writtenAt;
    getLogger().debug(
      { write, mismatches: this.mismatches },
      "SESSION_CATALOG: SQLite rows compared",
    );
    if (isSessionCatalogMatch(mismatch)) return;
    this.mismatches += 1;
    this.lastMismatch = { ...mismatch, generation: state.generation };
    store.repairRows(state.generation, keys, rows, sources);
    this.repairs += 1;
    const repaired = isSessionCatalogMatch(compare().mismatch);
    getLogger().warn(
      { mismatch: this.lastMismatch, write, repaired },
      "SESSION_CATALOG: SQLite rows differ from the published generation",
    );
  }
}
