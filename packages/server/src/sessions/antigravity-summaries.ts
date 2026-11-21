import { type Stats, realpathSync, statSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { antigravitySummariesPath } from "../sdk/providers/antigravity-runtime.js";
import {
  loadSqliteDriver,
  type SqliteDatabase,
  type SqliteStatement,
} from "../storage/sqlite.js";
import type { ProviderSessionWatcherSpec } from "../watcher/ProviderSessionWatcherRegistry.js";
import { catalogFileVersion } from "./catalog-adapters/row.js";

/** `agy` writes `0001-01-01 00:00:00+00:00` while a subagent is still running. */
const MIN_VALID_SUMMARY_TIMESTAMP_MS = Date.UTC(2000, 0, 1);
export const ANTIGRAVITY_RELATIONSHIP_MAX_SEEDS = 256;
export const ANTIGRAVITY_RELATIONSHIP_MAX_DEPTH = 32;
export const ANTIGRAVITY_RELATIONSHIP_MAX_ROWS = 4_096;
export const ANTIGRAVITY_RELATIONSHIP_MAX_SCAN_ROWS = 8_192;

export interface AntigravitySummaryRow {
  conversationId: string;
  cwd?: string;
  title?: string;
  agentName?: string;
  parentConversationId?: string;
  /** True whenever the native parent column is non-empty, independent of length/format validation. */
  isChild: boolean;
  nestingDepth?: number;
  status?: string;
  notFullyIdle?: boolean;
  killed?: boolean;
  lastModifiedMs?: number;
}

export interface AntigravitySummaryRawRow {
  conversation_id: unknown;
  workspace_uris: unknown;
  title: unknown;
  agent_name: unknown;
  parent_conversation_id: unknown;
  is_child: unknown;
  nesting_depth: unknown;
  status: unknown;
  not_fully_idle: unknown;
  killed: unknown;
  last_modified_time: unknown;
}

export interface AntigravityRelationshipSnapshot {
  hasParentIds: boolean;
  rows: AntigravitySummaryRawRow[];
  /** True when seed, depth, or row bounds prevented a complete lineage read. */
  truncated: boolean;
}

export interface AntigravityChildStatus {
  conversationId: string;
  status?: string;
  notFullyIdle: boolean;
  killed: boolean;
}

/**
 * Watch the physical Antigravity `conversations/` directory (non-recursively)
 * plus a bounded non-recursive companion watch on the sibling
 * `conversation_summaries.db` and `-wal` files, so lineage-only commits
 * invalidate both the retained catalog and provider-child relationships
 * without recursively watching sibling directories like `brain/`.
 */
export function antigravitySessionWatcherSpec(
  sessionsDir: string,
): ProviderSessionWatcherSpec {
  let physicalDir = sessionsDir;
  try {
    physicalDir = realpathSync(sessionsDir);
  } catch {
    // Keep configured path when the store has not been created yet.
  }
  const summariesName = basename(antigravitySummariesPath(physicalDir));
  const walName = `${summariesName}-wal`;
  return {
    family: "antigravity",
    provider: "antigravity",
    watchDir: physicalDir,
    recursive: false,
    companionWatchDir: {
      dir: dirname(physicalDir),
      files: [summariesName, walName],
    },
    debounceMs: 200,
  };
}

/** Parse `agy` SQLite timestamps like `2026-11-21 17:10:18.409203+00:00`. */
export function parseAntigravitySummaryTime(
  value: unknown,
): number | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const normalized = trimmed.includes("T")
    ? trimmed
    : trimmed.replace(" ", "T");
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed) || parsed < MIN_VALID_SUMMARY_TIMESTAMP_MS)
    return undefined;
  return parsed;
}

/**
 * `agy` lists the resolved path first and the cwd it was given last
 * (`["file:///private/tmp/x", "file:///tmp/x"]`). YA binds the given cwd.
 */
export function parseAntigravityWorkspaceUri(
  workspaceUris: unknown,
): string | undefined {
  if (typeof workspaceUris !== "string" || !workspaceUris) return undefined;
  try {
    const uris = JSON.parse(workspaceUris) as unknown;
    if (!Array.isArray(uris)) return undefined;
    const given = uris
      .filter(
        (uri): uri is string =>
          typeof uri === "string" && uri.startsWith("file://"),
      )
      .at(-1);
    return given ? fileURLToPath(given) : undefined;
  } catch {
    return undefined;
  }
}

export function normalizeAntigravitySummaryRow(
  row: AntigravitySummaryRawRow,
): AntigravitySummaryRow | undefined {
  if (typeof row.conversation_id !== "string" || !row.conversation_id)
    return undefined;
  const cwd = parseAntigravityWorkspaceUri(row.workspace_uris);
  const title =
    typeof row.title === "string" && row.title.length > 0
      ? row.title
      : undefined;
  const agentName =
    typeof row.agent_name === "string" && row.agent_name.length > 0
      ? row.agent_name
      : undefined;
  const parentConversationId =
    typeof row.parent_conversation_id === "string" &&
    row.parent_conversation_id.length > 0
      ? row.parent_conversation_id
      : undefined;
  const isChild =
    row.is_child === 1 ||
    row.is_child === true ||
    parentConversationId !== undefined;
  const nestingDepth =
    typeof row.nesting_depth === "number" &&
    Number.isSafeInteger(row.nesting_depth) &&
    row.nesting_depth >= 0
      ? row.nesting_depth
      : undefined;
  const status =
    typeof row.status === "string" && row.status.length > 0
      ? row.status
      : undefined;
  const notFullyIdle = row.not_fully_idle === 1 || row.not_fully_idle === true;
  const killed = row.killed === 1 || row.killed === true;
  const lastModifiedMs = parseAntigravitySummaryTime(row.last_modified_time);
  return {
    conversationId: row.conversation_id,
    ...(cwd ? { cwd } : {}),
    ...(title ? { title } : {}),
    ...(agentName ? { agentName } : {}),
    ...(parentConversationId ? { parentConversationId } : {}),
    isChild,
    ...(nestingDepth !== undefined ? { nestingDepth } : {}),
    ...(status ? { status } : {}),
    notFullyIdle,
    killed,
    ...(lastModifiedMs !== undefined ? { lastModifiedMs } : {}),
  };
}

function assertInStoreSync(
  storeDir: string,
  filePath: string,
  required: boolean,
): Stats | undefined {
  let physical: string;
  try {
    physical = realpathSync(filePath);
  } catch (error) {
    if (!required && (error as NodeJS.ErrnoException).code === "ENOENT")
      return undefined;
    throw error;
  }
  const expectedName = basename(filePath);
  if (dirname(physical) !== storeDir || basename(physical) !== expectedName)
    throw new Error("Antigravity summaries database escapes its native store");
  const info = statSync(physical);
  if (!info.isFile())
    throw new Error("Invalid Antigravity summaries database file");
  return info;
}

async function assertInStoreAsync(
  storeDir: string,
  filePath: string,
  required: boolean,
): Promise<Stats | undefined> {
  let physical: string;
  try {
    physical = await realpath(filePath);
  } catch (error) {
    if (!required && (error as NodeJS.ErrnoException).code === "ENOENT")
      return undefined;
    throw error;
  }
  const expectedName = basename(filePath);
  if (dirname(physical) !== storeDir || basename(physical) !== expectedName)
    throw new Error("Antigravity summaries database escapes its native store");
  const info = await stat(physical);
  if (!info.isFile())
    throw new Error("Invalid Antigravity summaries database file");
  return info;
}

/**
 * Validates that `conversation_summaries.db` and any existing `-wal`/`-shm`
 * sidecars stay physically inside their parent store directory and returns a
 * combined DB+WAL version string, or `undefined` when the DB does not exist.
 */
export async function antigravitySummariesVersion(
  databasePath: string,
): Promise<string | undefined> {
  let storeDir: string;
  try {
    storeDir = await realpath(dirname(databasePath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const dbInfo = await assertInStoreAsync(storeDir, databasePath, false);
  if (!dbInfo) return undefined;
  const walInfo = await assertInStoreAsync(
    storeDir,
    `${databasePath}-wal`,
    false,
  );
  await assertInStoreAsync(storeDir, `${databasePath}-shm`, false);
  return `${catalogFileVersion(dbInfo)}|${walInfo ? catalogFileVersion(walInfo) : ""}`;
}

interface StatementSlot {
  sql?: string;
  stmt?: SqliteStatement;
}

/**
 * Direct read-only reader for `agy` 1.5+ `conversation_summaries.db`.
 * Keeps one replaceable prepared statement per operation, checks SQLite
 * `schema_version` so WAL-only schema upgrades are picked up on reused
 * handles, enforces in-store symlink boundaries on the DB and sidecars, and
 * never writes, checkpoints, or mutates PRAGMAs.
 */
export class AntigravitySummariesReader {
  private db: SqliteDatabase | null | undefined = undefined;
  private dbStamp: string | undefined;
  private closed = false;
  private schemaVersionStmt: SqliteStatement | undefined;
  private tableInfoStmt: SqliteStatement | undefined;
  private cachedSchemaVersion: number | undefined;
  private cachedColumns: Set<string> | undefined;
  private readonly rowSlot: StatementSlot = {};
  private readonly allRowsSlot: StatementSlot = {};
  private readonly byIdsSlot: StatementSlot = {};
  private readonly childrenPlanSlot: StatementSlot = {};
  private readonly childrenByParentsSlot: StatementSlot = {};
  private readonly allChildrenSlot: StatementSlot = {};
  private readonly statusSlot: StatementSlot = {};

  constructor(private readonly databasePath: string) {}

  private ensureDb(strict: boolean): SqliteDatabase | null {
    if (this.closed) return null;
    let physicalPath: string;
    let stamp: string;
    try {
      const storeDir = realpathSync(dirname(this.databasePath));
      const info = assertInStoreSync(storeDir, this.databasePath, true)!;
      assertInStoreSync(storeDir, `${this.databasePath}-wal`, false);
      assertInStoreSync(storeDir, `${this.databasePath}-shm`, false);
      physicalPath = join(storeDir, basename(this.databasePath));
      stamp = `${info.dev}:${info.ino}:${info.mtimeMs}:${info.ctimeMs}:${info.size}`;
    } catch (error) {
      this.closeHandle();
      if (strict) throw error;
      return null;
    }
    if (this.db && this.dbStamp === stamp) return this.db;
    if (this.db && this.dbStamp !== stamp) this.closeHandle();
    const driver = loadSqliteDriver();
    if (!driver) {
      this.db = null;
      if (strict) throw new Error("SQLite is unavailable");
      return null;
    }
    try {
      this.db = driver.open(physicalPath, { readOnly: true });
      this.dbStamp = stamp;
      return this.db;
    } catch (error) {
      this.db = null;
      this.dbStamp = undefined;
      if (strict) throw error;
      return null;
    }
  }

  private useSlot(
    db: SqliteDatabase,
    slot: StatementSlot,
    sql: string,
  ): SqliteStatement {
    if (slot.sql === sql && slot.stmt) return slot.stmt;
    slot.stmt?.finalize();
    slot.stmt = undefined;
    slot.sql = undefined;
    slot.stmt = db.prepare(sql);
    slot.sql = sql;
    return slot.stmt;
  }

  private readColumns(db: SqliteDatabase): Set<string> {
    this.schemaVersionStmt ??= db.prepare("PRAGMA schema_version");
    const versionRow = this.schemaVersionStmt.get<{
      schema_version?: unknown;
    }>();
    const schemaVersion =
      typeof versionRow?.schema_version === "number"
        ? versionRow.schema_version
        : undefined;
    if (
      this.cachedColumns &&
      schemaVersion !== undefined &&
      this.cachedSchemaVersion === schemaVersion
    ) {
      return this.cachedColumns;
    }
    this.tableInfoStmt ??= db.prepare(
      "PRAGMA table_info(conversation_summaries)",
    );
    const rows = this.tableInfoStmt.all<{ name?: unknown }>();
    const columns = new Set(
      rows.flatMap((row) => (typeof row.name === "string" ? [row.name] : [])),
    );
    this.cachedColumns = columns;
    this.cachedSchemaVersion = schemaVersion;
    return columns;
  }

  private planUsesParentIndex(
    db: SqliteDatabase,
    childrenSql: string,
    parents: readonly string[],
    limit: number,
  ): boolean {
    try {
      // Explain the exact wave-BFS query (including all selected columns) inside
      // the active read transaction so covering-index vs full-table-lookup plan
      // divergence and ANALYZE statistics are reflected accurately.
      const plan = this.useSlot(
        db,
        this.childrenPlanSlot,
        `EXPLAIN QUERY PLAN ${childrenSql}`,
      ).all<{ detail?: unknown }>(JSON.stringify(parents), "[]", limit);
      const details = plan
        .map((row) => (typeof row.detail === "string" ? row.detail : ""))
        .filter(Boolean);
      const usesIndex = details.some((detail) =>
        /\bSEARCH conversation_summaries USING (?:COVERING )?INDEX\b/i.test(
          detail,
        ),
      );
      const scansTable = details.some((detail) =>
        /\bSCAN conversation_summaries\b/i.test(detail),
      );
      return usesIndex && !scansTable;
    } catch {
      return false;
    }
  }

  private selectColumns(columns: Set<string>): string {
    const str = (column: string, limit: number) =>
      columns.has(column)
        ? `CASE WHEN length(${column}) <= ${limit} THEN ${column} ELSE NULL END AS ${column}`
        : `NULL AS ${column}`;
    const trunc = (column: string, limit: number) =>
      columns.has(column)
        ? `substr(${column}, 1, ${limit}) AS ${column}`
        : `NULL AS ${column}`;
    const raw = (column: string) =>
      columns.has(column) ? column : `NULL AS ${column}`;
    const isChild = columns.has("parent_conversation_id")
      ? "CASE WHEN parent_conversation_id IS NOT NULL AND parent_conversation_id != '' THEN 1 ELSE 0 END AS is_child"
      : "0 AS is_child";
    return [
      str("conversation_id", 1024),
      str("workspace_uris", 8192),
      trunc("title", 512),
      trunc("agent_name", 256),
      str("parent_conversation_id", 1024),
      isChild,
      raw("nesting_depth"),
      str("status", 128),
      raw("not_fully_idle"),
      raw("killed"),
      str("last_modified_time", 128),
    ].join(", ");
  }

  /** Tolerant point read for one conversation; returns undefined if unavailable. */
  readRow(conversationId: string): AntigravitySummaryRow | undefined {
    try {
      return this.readRowStrict(conversationId);
    } catch {
      return undefined;
    }
  }

  /** Strict point read: throws on DB/schema/store errors; undefined only on genuine miss. */
  readRowStrict(conversationId: string): AntigravitySummaryRow | undefined {
    const db = this.ensureDb(true);
    if (!db) throw new Error("Antigravity summaries database unavailable");
    const columns = this.readColumns(db);
    if (!columns.has("conversation_id") || !columns.has("workspace_uris"))
      throw new Error("Antigravity summaries schema unavailable");
    const sql = `SELECT ${this.selectColumns(columns)} FROM conversation_summaries WHERE conversation_id = ?`;
    const row = this.useSlot(
      db,
      this.rowSlot,
      sql,
    ).get<AntigravitySummaryRawRow>(conversationId);
    return row ? normalizeAntigravitySummaryRow(row) : undefined;
  }

  /**
   * Bounded full-table metadata read for catalog scans. Throws on SQLite failure.
   * Returns `complete: false` when more than `limit` rows exist so callers can
   * perform a targeted point read on a cache miss rather than assuming absence.
   */
  readAllRows(limit: number): {
    rows: Map<string, AntigravitySummaryRow>;
    complete: boolean;
  } {
    const db = this.ensureDb(true);
    if (!db) throw new Error("Antigravity summaries database unavailable");
    const columns = this.readColumns(db);
    if (!columns.has("conversation_id") || !columns.has("workspace_uris"))
      throw new Error("Antigravity summaries schema unavailable");
    const sql = `SELECT ${this.selectColumns(columns)} FROM conversation_summaries LIMIT ?`;
    const rawRows = this.useSlot(
      db,
      this.allRowsSlot,
      sql,
    ).all<AntigravitySummaryRawRow>(limit + 1);
    const complete = rawRows.length <= limit;
    const rows = new Map<string, AntigravitySummaryRow>();
    for (const raw of rawRows.slice(0, limit)) {
      const normalized = normalizeAntigravitySummaryRow(raw);
      if (normalized) rows.set(normalized.conversationId, normalized);
    }
    return { rows, complete };
  }

  /**
   * Strict acquisition boundary: failure is never an authoritative empty set.
   * Reads selected parents, bounded descendants, and bounded ancestors inside
   * one read-only SQLite transaction (single committed WAL snapshot). Each
   * wave passes `LIMIT remaining + 1` directly to SQLite so wide fan-out stops
   * scanning immediately instead of enumerating all siblings.
   */
  readRelationshipSnapshot(
    parentIds: readonly string[],
    relatedIds: readonly string[] = [],
    limits: {
      maxSeeds?: number;
      maxDepth?: number;
      maxRows?: number;
      maxScanRows?: number;
    } = {},
  ): AntigravityRelationshipSnapshot {
    const db = this.ensureDb(true);
    if (!db)
      throw new Error("Antigravity native relationship store unavailable");
    const columns = this.readColumns(db);
    if (!columns.has("conversation_id") || !columns.has("workspace_uris"))
      throw new Error("Antigravity native relationship schema unavailable");
    const maxSeeds = limits.maxSeeds ?? ANTIGRAVITY_RELATIONSHIP_MAX_SEEDS;
    const maxDepth = limits.maxDepth ?? ANTIGRAVITY_RELATIONSHIP_MAX_DEPTH;
    const maxRows = limits.maxRows ?? ANTIGRAVITY_RELATIONSHIP_MAX_ROWS;
    const maxScanRows =
      limits.maxScanRows ??
      Math.max(maxRows * 2, ANTIGRAVITY_RELATIONSHIP_MAX_SCAN_ROWS);
    const uniqueParents = [...new Set(parentIds)];
    const uniqueRelated = [...new Set(relatedIds)];
    let truncated =
      uniqueParents.length > maxSeeds || uniqueRelated.length > maxSeeds;
    const boundedParents = uniqueParents.slice(0, maxSeeds);
    const boundedRelated = uniqueRelated.slice(0, maxSeeds);
    const hasParentIds = columns.has("parent_conversation_id");
    const selectCols = this.selectColumns(columns);
    const byIdsSql = `SELECT ${selectCols} FROM conversation_summaries WHERE conversation_id IN (SELECT value FROM json_each(?)) LIMIT ?`;
    const childrenSql = `SELECT ${selectCols} FROM conversation_summaries WHERE parent_conversation_id IN (SELECT value FROM json_each(?)) AND conversation_id NOT IN (SELECT value FROM json_each(?)) LIMIT ?`;
    // Cap source rows examined BEFORE filtering for children so unindexed
    // schemas never perform an unbounded full-table scan. The UNION ALL
    // sentinel reports truncation when the source table exceeds maxScanRows.
    const allChildrenSql = `WITH bounded AS MATERIALIZED (
        SELECT ${selectCols} FROM conversation_summaries LIMIT ?
      )
      SELECT conversation_id, workspace_uris, title, agent_name, parent_conversation_id, is_child, nesting_depth, status, not_fully_idle, killed, last_modified_time, 0 AS _overflow
      FROM bounded WHERE is_child = 1
      UNION ALL
      SELECT NULL, NULL, NULL, NULL, NULL, 0, NULL, NULL, NULL, NULL, NULL, 1 AS _overflow
      WHERE (SELECT count(*) FROM bounded) > ?`;

    const visited = new Map<string, AntigravitySummaryRawRow>();
    const addRows = (batch: readonly AntigravitySummaryRawRow[]): string[] => {
      const added: string[] = [];
      for (const row of batch) {
        if (typeof row.conversation_id !== "string" || !row.conversation_id)
          continue;
        if (visited.has(row.conversation_id)) continue;
        if (visited.size >= maxRows) {
          truncated = true;
          break;
        }
        visited.set(row.conversation_id, row);
        added.push(row.conversation_id);
      }
      return added;
    };

    const byIdsStmt = this.useSlot(db, this.byIdsSlot, byIdsSql);

    let inTransaction = false;
    db.exec("BEGIN");
    inTransaction = true;
    try {
      // Load parent seeds first: `BEGIN` is deferred and `EXPLAIN QUERY PLAN`
      // alone does not establish a WAL read snapshot, so running the seed read
      // first pins both schema and data for the planner probe and traversal.
      if (boundedParents.length > 0) {
        const parents = byIdsStmt.all<AntigravitySummaryRawRow>(
          JSON.stringify(boundedParents),
          maxRows + 1,
        );
        if (parents.length > maxRows) truncated = true;
        addRows(parents);
      }

      if (hasParentIds && boundedParents.length > 0) {
        const hasParentIndex = this.planUsesParentIndex(
          db,
          childrenSql,
          boundedParents,
          maxRows + 1,
        );
        const childrenStmt = hasParentIndex
          ? this.useSlot(db, this.childrenByParentsSlot, childrenSql)
          : undefined;
        const allChildrenStmt = !hasParentIndex
          ? this.useSlot(db, this.allChildrenSlot, allChildrenSql)
          : undefined;
        if (childrenStmt) {
          // Indexed parent_conversation_id: bounded BFS wave by wave.
          let frontier = [...boundedParents];
          const expandedParents = new Set<string>();
          for (let depth = 0; frontier.length > 0 && !truncated; depth++) {
            const toExpand = frontier.filter((id) => !expandedParents.has(id));
            if (!toExpand.length) break;
            for (const id of toExpand) expandedParents.add(id);
            const remaining = maxRows - visited.size;
            const probeLimit = depth >= maxDepth ? 1 : remaining + 1;
            const batch = childrenStmt.all<AntigravitySummaryRawRow>(
              JSON.stringify(toExpand),
              JSON.stringify([...visited.keys()]),
              probeLimit,
            );
            if (depth >= maxDepth) {
              if (batch.length > 0) truncated = true;
              break;
            }
            if (batch.length > remaining) truncated = true;
            frontier = addRows(batch);
          }
        } else if (allChildrenStmt) {
          // Unindexed schema (agy 1.5.x): read at most maxScanRows + 1 source
          // rows before filtering so large root-heavy tables stay bounded.
          const scanned = allChildrenStmt.all<
            AntigravitySummaryRawRow & { _overflow?: unknown }
          >(maxScanRows + 1, maxScanRows);
          const byParent = new Map<string, AntigravitySummaryRawRow[]>();
          for (const { _overflow, ...row } of scanned) {
            if (_overflow === 1) {
              truncated = true;
              continue;
            }
            if (
              typeof row.parent_conversation_id !== "string" ||
              !row.parent_conversation_id
            )
              continue;
            let list = byParent.get(row.parent_conversation_id);
            if (!list) {
              list = [];
              byParent.set(row.parent_conversation_id, list);
            }
            list.push(row);
          }
          let frontier = [...boundedParents];
          const expandedParents = new Set<string>();
          for (let depth = 0; frontier.length > 0; depth++) {
            const toExpand = frontier.filter((id) => !expandedParents.has(id));
            if (!toExpand.length) break;
            for (const id of toExpand) expandedParents.add(id);
            const nextBatch: AntigravitySummaryRawRow[] = [];
            for (const parentId of toExpand) {
              for (const child of byParent.get(parentId) ?? []) {
                if (
                  typeof child.conversation_id === "string" &&
                  !visited.has(child.conversation_id)
                ) {
                  nextBatch.push(child);
                }
              }
            }
            if (depth >= maxDepth) {
              if (nextBatch.length > 0) truncated = true;
              break;
            }
            frontier = addRows(nextBatch);
            if (visited.size >= maxRows && nextBatch.length > frontier.length) {
              truncated = true;
              break;
            }
          }
        }
      }

      // Now load any unvisited relatedIds for ancestor resolution.
      const missingRelated = boundedRelated.filter((id) => !visited.has(id));
      if (missingRelated.length > 0 && !truncated) {
        const remaining = maxRows - visited.size;
        const related = byIdsStmt.all<AntigravitySummaryRawRow>(
          JSON.stringify(missingRelated),
          remaining + 1,
        );
        if (related.length > remaining) truncated = true;
        addRows(related);
      }

      if (hasParentIds && !truncated) {
        // Bounded ancestor walk starting at hop 0 independently of descendant depth.
        let pendingParents = new Set<string>();
        for (const row of visited.values()) {
          if (
            typeof row.parent_conversation_id === "string" &&
            row.parent_conversation_id &&
            !visited.has(row.parent_conversation_id)
          ) {
            pendingParents.add(row.parent_conversation_id);
          }
        }
        for (let depth = 0; pendingParents.size > 0 && !truncated; depth++) {
          const ids = [...pendingParents];
          pendingParents = new Set<string>();
          const remaining = maxRows - visited.size;
          const probeLimit = depth >= maxDepth ? 1 : remaining + 1;
          const batch = byIdsStmt.all<AntigravitySummaryRawRow>(
            JSON.stringify(ids),
            probeLimit,
          );
          if (depth >= maxDepth) {
            if (batch.length > 0) truncated = true;
            break;
          }
          if (batch.length > remaining) truncated = true;
          const added = addRows(batch);
          for (const id of added) {
            const row = visited.get(id);
            if (
              row &&
              typeof row.parent_conversation_id === "string" &&
              row.parent_conversation_id &&
              !visited.has(row.parent_conversation_id)
            ) {
              pendingParents.add(row.parent_conversation_id);
            }
          }
        }
      }

      db.exec("COMMIT");
      inTransaction = false;
    } catch (error) {
      if (inTransaction) {
        try {
          db.exec("ROLLBACK");
        } catch {
          this.closeHandle();
        }
      }
      throw error;
    }

    const rows = [...visited.values()].sort((a, b) =>
      String(a.conversation_id).localeCompare(String(b.conversation_id)),
    );
    return { hasParentIds, rows, truncated };
  }

  /** Bounded status lookup for known active child ids (background retention). */
  readChildStatuses(
    childIds: readonly string[],
  ): Map<string, AntigravityChildStatus> {
    const out = new Map<string, AntigravityChildStatus>();
    if (!childIds.length) return out;
    const db = this.ensureDb(false);
    if (!db) return out;
    try {
      const columns = this.readColumns(db);
      if (!columns.has("conversation_id")) return out;
      const statusCol = columns.has("status")
        ? "CASE WHEN length(status) <= 128 THEN status ELSE NULL END AS status"
        : "NULL AS status";
      const idleCol = columns.has("not_fully_idle")
        ? "not_fully_idle"
        : "0 AS not_fully_idle";
      const killedCol = columns.has("killed") ? "killed" : "0 AS killed";
      const sql = `SELECT conversation_id, ${statusCol}, ${idleCol}, ${killedCol}
        FROM conversation_summaries
        WHERE conversation_id IN (SELECT value FROM json_each(?))`;
      const rows = this.useSlot(db, this.statusSlot, sql).all<{
        conversation_id: unknown;
        status: unknown;
        not_fully_idle: unknown;
        killed: unknown;
      }>(JSON.stringify([...new Set(childIds)]));
      for (const row of rows) {
        if (typeof row.conversation_id !== "string") continue;
        out.set(row.conversation_id, {
          conversationId: row.conversation_id,
          ...(typeof row.status === "string" && row.status
            ? { status: row.status }
            : {}),
          notFullyIdle: row.not_fully_idle === 1 || row.not_fully_idle === true,
          killed: row.killed === 1 || row.killed === true,
        });
      }
      return out;
    } catch {
      return out;
    }
  }

  private clearSlot(slot: StatementSlot): void {
    slot.stmt?.finalize();
    slot.stmt = undefined;
    slot.sql = undefined;
  }

  private closeHandle(): void {
    this.schemaVersionStmt?.finalize();
    this.schemaVersionStmt = undefined;
    this.tableInfoStmt?.finalize();
    this.tableInfoStmt = undefined;
    this.clearSlot(this.rowSlot);
    this.clearSlot(this.allRowsSlot);
    this.clearSlot(this.byIdsSlot);
    this.clearSlot(this.childrenPlanSlot);
    this.clearSlot(this.childrenByParentsSlot);
    this.clearSlot(this.allChildrenSlot);
    this.clearSlot(this.statusSlot);
    this.cachedColumns = undefined;
    this.cachedSchemaVersion = undefined;
    if (this.db) {
      try {
        this.db.close();
      } catch {
        // ignore close errors on read-only native handles
      }
    }
    this.db = undefined;
    this.dbStamp = undefined;
  }

  close(): void {
    this.closed = true;
    this.closeHandle();
  }
}
