import { openCodexStateQuery } from "./codex-thread-index.js";

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

/** A missing database, driver or unsupported schema returns undefined. */
export async function openCodexSpawnIndex(
  sessionsDir: string,
  databasePath?: string,
): Promise<CodexSpawnIndexLease | undefined> {
  const lease = await openCodexStateQuery(sessionsDir, QUERY, databasePath);
  if (!lease) return undefined;
  let closed = false;
  return {
    read(parentId) {
      if (closed) throw new Error("Codex native spawn index retired");
      // A missing parent, missing child locator or unsupported schema is
      // unavailable/partial evidence, never an authoritative empty set.
      return lease.query.all<CodexSpawnLocator>(parentId);
    },
    isCurrent: lease.isCurrent,
    close() {
      closed = true;
      lease.close();
    },
  };
}
