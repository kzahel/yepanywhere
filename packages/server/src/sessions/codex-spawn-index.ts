import { realpath, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  loadSqliteDriver,
  type SqliteDatabase,
  type SqliteStatement,
} from "../storage/sqlite.js";

/** Positive locators only. Native child headers still prove scoped parentage. */
export interface CodexSpawnLocator {
  parentId: string;
  parentPath: string;
  childId: string | null;
  childPath: string | null;
}

/** One finite acquisition owns this read-only connection and its statement. */
export interface CodexSpawnIndexLease {
  read(parentId: string): CodexSpawnLocator[];
  isCurrent(): Promise<boolean>;
  close(): void;
}

// Pinned rust-v0.166.0 state/sqlite.rs and state/runtime/threads.rs. Requiring
// the native parent index prevents a schema mismatch becoming a corpus scan.
const QUERY = `SELECT p.id AS parentId, p.rollout_path AS parentPath,
  e.child_thread_id AS childId, c.rollout_path AS childPath
  FROM threads AS p
  LEFT JOIN thread_spawn_edges AS e INDEXED BY idx_thread_spawn_edges_parent_status
    ON e.parent_thread_id = p.id
  LEFT JOIN threads AS c ON c.id = e.child_thread_id
  WHERE p.id = ? ORDER BY e.child_thread_id`;

/**
 * No directory enumeration, native row writes, migrations or checkpoints.
 * SQLite may create WAL/SHM reader sidecars even on a read-only connection.
 */
export async function openCodexSpawnIndex(
  sessionsDir: string,
  databasePath?: string,
): Promise<CodexSpawnIndexLease | undefined> {
  // An explicit locator belongs to the caller's native profile. Never borrow
  // a process-wide CODEX_SQLITE_HOME for a different private session scope.
  const path =
    databasePath ??
    (basename(sessionsDir).toLowerCase() === "sessions"
      ? join(dirname(sessionsDir), "state_5.sqlite")
      : undefined);
  if (!path) return undefined;
  let database: SqliteDatabase | undefined;
  let query: SqliteStatement | undefined;
  try {
    const physical = await realpath(path),
      before = await stat(physical);
    if (!before.isFile()) return undefined;
    const driver = loadSqliteDriver();
    if (!driver) return undefined;
    database = driver.open(physical, { readOnly: true });
    query = database.prepare(QUERY);
    const openedDatabase = database,
      openedQuery = query;
    let closed = false;
    const isCurrent = async () => {
      if (closed) return false;
      try {
        if ((await realpath(path)) !== physical) return false;
        const current = await stat(physical);
        return (
          current.isFile() &&
          current.dev === before.dev &&
          current.ino === before.ino
        );
      } catch {
        return false;
      }
    };
    if (!(await isCurrent())) {
      openedQuery.finalize();
      openedDatabase.close();
      return undefined;
    }
    return {
      read(parentId) {
        if (closed) throw new Error("Codex native spawn index retired");
        // A missing parent, missing child locator or unsupported schema is
        // unavailable/partial evidence, never an authoritative empty set.
        return openedQuery.all<CodexSpawnLocator>(parentId);
      },
      isCurrent,
      close() {
        if (closed) return;
        closed = true;
        openedQuery.finalize();
        openedDatabase.close();
      },
    };
  } catch {
    query?.finalize();
    database?.close();
    return undefined;
  }
}
