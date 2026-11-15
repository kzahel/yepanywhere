import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  loadSqliteDriver,
  type SqliteDatabase,
  type SqliteDriver,
} from "./sqlite.js";

/**
 * One change to the rebuildable cache schema (topics/required-sqlite.md).
 *
 * A plain step alters a database at the previous version and keeps its rows.
 * A `rebuild` step carries the complete schema instead: a database older than
 * it is deleted and starts again empty. Choose per change. Steps before the
 * latest rebuild can never run again and may be removed.
 */
export interface CacheSchemaStep {
  version: number;
  sql: string;
  rebuild?: true;
}

/** Claude transcript source facts, positions and writer state. */
const CLAUDE_TRANSCRIPT_SCHEMA = `
CREATE TABLE claude_transcript_generations (generation TEXT PRIMARY KEY,path TEXT NOT NULL,owner TEXT NOT NULL,lease_until INTEGER NOT NULL);
CREATE INDEX claude_transcript_generations_path ON claude_transcript_generations(path,lease_until,generation);
CREATE TABLE claude_transcript_sources (
 path TEXT PRIMARY KEY, generation TEXT NOT NULL, revision INTEGER NOT NULL,
 header TEXT NOT NULL);
CREATE UNIQUE INDEX claude_transcript_sources_generation ON claude_transcript_sources(generation);
CREATE TABLE claude_transcript_records (
 generation TEXT NOT NULL, ordinal INTEGER NOT NULL, record TEXT NOT NULL,
 PRIMARY KEY(generation, ordinal)) WITHOUT ROWID;
CREATE TABLE claude_transcript_visible (
 generation TEXT NOT NULL, position INTEGER NOT NULL, message_id TEXT,
 compact_ordinal INTEGER, group_id TEXT, delivered_ms REAL, record TEXT NOT NULL,
 PRIMARY KEY(generation, position)) WITHOUT ROWID;
CREATE INDEX claude_transcript_visible_id ON claude_transcript_visible(generation,message_id,position);
CREATE INDEX claude_transcript_visible_compact ON claude_transcript_visible(generation,compact_ordinal) WHERE compact_ordinal IS NOT NULL;
CREATE INDEX claude_transcript_visible_boundary_position ON claude_transcript_visible(generation,position) WHERE compact_ordinal IS NOT NULL;
CREATE INDEX claude_transcript_visible_group ON claude_transcript_visible(generation,group_id,position);
CREATE INDEX claude_transcript_visible_delivery ON claude_transcript_visible(generation,delivered_ms,position) WHERE delivered_ms IS NOT NULL;
CREATE TABLE claude_transcript_orphans (
 generation TEXT NOT NULL, tool_id TEXT NOT NULL,
 PRIMARY KEY(generation,tool_id)) WITHOUT ROWID;
CREATE TABLE claude_transcript_nodes(generation TEXT NOT NULL,uuid TEXT NOT NULL,active INTEGER NOT NULL,
 PRIMARY KEY(generation,uuid)) WITHOUT ROWID;
CREATE TABLE claude_transcript_tools(generation TEXT NOT NULL,tool_id TEXT NOT NULL,owner_uuid TEXT,
 has_result INTEGER NOT NULL,is_task INTEGER NOT NULL,PRIMARY KEY(generation,tool_id)) WITHOUT ROWID;
CREATE TABLE claude_transcript_offsets(generation TEXT NOT NULL,source_offset INTEGER NOT NULL,position INTEGER NOT NULL,
 PRIMARY KEY(generation,source_offset)) WITHOUT ROWID;
CREATE INDEX claude_transcript_offsets_position ON claude_transcript_offsets(generation,position);
CREATE TABLE claude_transcript_tasks(generation TEXT PRIMARY KEY,state TEXT NOT NULL);
CREATE TABLE claude_transcript_queues(generation TEXT NOT NULL,source_offset INTEGER NOT NULL,
 position INTEGER,record TEXT NOT NULL,PRIMARY KEY(generation,source_offset)) WITHOUT ROWID;
`;

export const CACHE_SCHEMA_STEPS: readonly CacheSchemaStep[] = [
  { version: 1, sql: CLAUDE_TRANSCRIPT_SCHEMA, rebuild: true },
];

// YA cache file identity (ASCII YACA).
const APPLICATION_ID = 0x59414341;
const CACHE_FILE = "cache.sqlite";

function readRow(database: SqliteDatabase, sql: string) {
  const statement = database.prepare(sql);
  try {
    return statement.get();
  } finally {
    statement.finalize();
  }
}

/**
 * Bring an open cache database to the latest schema. Returns the reason when
 * it cannot be done in place and the file must be replaced by an empty one.
 */
export function prepareCacheDatabase(
  database: SqliteDatabase,
  steps: readonly CacheSchemaStep[] = CACHE_SCHEMA_STEPS,
): string | undefined {
  const first = steps[0];
  const latest = steps[steps.length - 1];
  if (
    !first?.rebuild ||
    !latest ||
    steps.some((step, index) => step.version !== first.version + index)
  ) {
    throw new Error(
      "Cache schema steps must be consecutive and start with a rebuild",
    );
  }
  let rebuildVersion = first.version;
  for (const step of steps) if (step.rebuild) rebuildVersion = step.version;

  return database.transaction(() => {
    const applicationId = readRow(
      database,
      "PRAGMA application_id",
    )?.application_id;
    const version = readRow(database, "PRAGMA user_version")?.user_version;
    const empty =
      applicationId === 0 &&
      version === 0 &&
      !readRow(database, "SELECT name FROM sqlite_schema LIMIT 1");
    if (!empty) {
      if (applicationId !== APPLICATION_ID || typeof version !== "number") {
        return "it is not a YA cache database";
      }
      if (version > latest.version) {
        return `its schema ${version} is newer than this build's ${latest.version}`;
      }
      if (version < rebuildVersion) {
        return `schema ${rebuildVersion} starts from an empty cache`;
      }
    }
    const from = empty ? rebuildVersion - 1 : (version as number);
    for (const step of steps) {
      if (step.version > from) database.exec(step.sql);
    }
    database.exec(`PRAGMA user_version = ${latest.version}`);
    database.exec(`PRAGMA application_id = ${APPLICATION_ID}`);
    return undefined;
  });
}

/**
 * Open YA's rebuildable cache database below the data directory. Everything
 * in it can be recomputed from provider history, so a file that is foreign,
 * malformed, written by a newer build or older than the latest rebuild step
 * is deleted and recreated rather than refused. A locked file is never
 * deleted: another process is using it.
 */
export function openCacheDatabase(options: {
  dataDir: string;
  loadDriver?: () => SqliteDriver | undefined;
  /** Injected by tests; production uses {@link CACHE_SCHEMA_STEPS}. */
  steps?: readonly CacheSchemaStep[];
  /** Called with the reason before the file is replaced. Logs by default. */
  onReset?: (reason: string) => void;
}): SqliteDatabase {
  const path = join(options.dataDir, CACHE_FILE);
  const driver = (options.loadDriver ?? loadSqliteDriver)();
  if (!driver) {
    throw new Error(
      `Cannot open ${path}: this runtime has no built-in SQLite (node:sqlite or bun:sqlite).`,
    );
  }
  mkdirSync(options.dataDir, { recursive: true });

  const attempt = (): SqliteDatabase | string => {
    let database: SqliteDatabase | undefined;
    let reason: string | undefined;
    try {
      database = driver.open(path);
      // The same bounds as the discovery database (topics/required-sqlite.md).
      database.exec("PRAGMA busy_timeout = 250");
      database.exec("PRAGMA cache_spill = OFF");
      reason = prepareCacheDatabase(database, options.steps);
      if (reason === undefined) return database;
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
      if (/database (table )?is locked|SQLITE_(BUSY|LOCKED)/i.test(reason)) {
        closeQuietly(database);
        throw new Error(`Cannot open ${path}: ${reason}`, { cause: error });
      }
    }
    closeQuietly(database);
    return reason;
  };

  const opened = attempt();
  if (typeof opened !== "string") return opened;
  (options.onReset ?? logReset)(`Rebuilding ${path}: ${opened}`);
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    rmSync(path + suffix, { force: true });
  }
  const rebuilt = attempt();
  if (typeof rebuilt !== "string") return rebuilt;
  throw new Error(`Cannot rebuild ${path}: ${rebuilt}`);
}

function closeQuietly(database: SqliteDatabase | undefined): void {
  try {
    database?.close();
  } catch {
    // The caller reports why the open failed; a failed close adds nothing.
  }
}

function logReset(message: string): void {
  console.warn(`[CacheSqlite] ${message}`);
}
