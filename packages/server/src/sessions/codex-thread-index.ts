import { realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { getLogger } from "../logging/logger.js";
import { loadSqliteDriver } from "../storage/sqlite.js";
import type { FileWatcherChangeHints } from "../watcher/FileWatcher.js";
import type { ProviderSessionWatcherSpec } from "../watcher/ProviderSessionWatcherRegistry.js";

/**
 * Codex's own thread index beside a conventional `sessions/` root. An explicit
 * SQLite-home override is not borrowed: it may belong to a different scope.
 */
export function codexStateDatabasePath(
  sessionsDir: string,
): string | undefined {
  return basename(sessionsDir).toLowerCase() === "sessions"
    ? join(dirname(sessionsDir), "state_5.sqlite")
    : undefined;
}

// Pinned rust-v0.167.0 state/migrations: 0025 adds updated_at_ms, which
// triggers backfill from the indexed whole-second updated_at. Naming the index
// turns a schema change into a failed read (a full rescan), never a quiet miss.
const CHANGED_THREADS = `SELECT id, rollout_path AS rolloutPath,
  COALESCE(updated_at_ms, updated_at * 1000) AS updatedAtMs
  FROM threads INDEXED BY idx_threads_updated_at WHERE updated_at >= ?`;

/**
 * Codex writes a row's timestamp before committing it, and concurrent writers
 * can commit out of order, so each read re-covers this much history.
 */
const OVERLAP_MS = 60_000;

interface ChangedThreadRow {
  id: string;
  rolloutPath: string;
  updatedAtMs: number;
}

function suffixWithin(root: string, path: string): string | undefined {
  const suffix = relative(root, path);
  return !suffix ||
    suffix === ".." ||
    suffix.startsWith(`..${sep}`) ||
    isAbsolute(suffix)
    ? undefined
    : suffix;
}

async function fileStamp(path: string): Promise<string | null> {
  try {
    const s = await stat(path);
    return `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Change hints from Codex's `threads` table. Codex updates a thread's row
 * whenever it persists that thread's rollout (non-metadata appends at most
 * every five seconds), so rows updated since the last read name the rollouts
 * worth re-checking. An unchanged database and WAL cost two `stat`s; a change
 * costs one short read-only connection. A missing, replaced or unreadable
 * database returns null so the watcher falls back to a full rescan.
 */
export function createCodexThreadChangeHints(
  sessionsDir: string,
  databasePath = codexStateDatabasePath(sessionsDir),
): FileWatcherChangeHints {
  let identity: string | undefined;
  let stamp: string | undefined;
  let highWaterMs: number | undefined;
  let roots: { real: string; archived: string[] } | undefined;
  const seen = new Map<string, number>();
  const reset = () => {
    identity = stamp = highWaterMs = roots = undefined;
    seen.clear();
  };
  let reported: string | undefined;
  const report = (state: string, error?: unknown) => {
    if (state === reported) return;
    reported = state;
    getLogger().info(
      {
        event: "codex_thread_index_hints",
        sessionsDir,
        databasePath,
        state,
        ...(error ? { error: String(error) } : {}),
      },
      `CODEX_THREAD_INDEX: ${state}`,
    );
  };

  const readRows = (sinceMs: number): ChangedThreadRow[] => {
    const driver = loadSqliteDriver();
    if (!driver || !databasePath) throw new Error("SQLite unavailable");
    const database = driver.open(databasePath, { readOnly: true });
    try {
      const query = database.prepare(CHANGED_THREADS);
      try {
        return query.all<ChangedThreadRow>(Math.floor(sinceMs / 1000));
      } finally {
        query.finalize();
      }
    } finally {
      database.close();
    }
  };

  /**
   * Codex records canonical paths, so a sessions root reached through an
   * alias is matched by its real path too and mapped back under the watched
   * root. Archived rollouts lie outside the watched tree by design; any other
   * outside path means this index describes a different tree.
   */
  const locate = async (
    rolloutPath: string,
  ): Promise<string | "outside" | undefined> => {
    if (!roots) {
      const real = await realpath(sessionsDir).catch(() => sessionsDir);
      roots = {
        real,
        archived: [sessionsDir, real].map((root) =>
          join(dirname(root), "archived_sessions"),
        ),
      };
    }
    const known = roots;
    const suffix =
      suffixWithin(sessionsDir, rolloutPath) ??
      suffixWithin(known.real, rolloutPath);
    if (!suffix)
      return known.archived.some((root) => suffixWithin(root, rolloutPath))
        ? undefined
        : "outside";
    // Codex keeps naming the plain rollout after compressing it.
    const plain = join(sessionsDir, suffix);
    for (const candidate of [plain, `${plain}.zst`])
      if (await fileStamp(candidate)) return candidate;
    return undefined;
  };

  return {
    async changedPaths() {
      if (!databasePath) return null;
      try {
        const database = await fileStamp(databasePath);
        if (!database) {
          reset();
          report("unavailable: no database beside the sessions root");
          return null;
        }
        const databaseIdentity = database.split(":").slice(0, 2).join(":");
        if (databaseIdentity !== identity) {
          reset();
          identity = databaseIdentity;
        }
        // Read before querying: a commit landing mid-read changes the stamp
        // again, so the next tick re-reads rather than skipping it.
        const next = `${database}|${await fileStamp(`${databasePath}-wal`)}`;
        if (highWaterMs !== undefined && next === stamp) return [];
        const baseline = highWaterMs === undefined;
        const sinceMs = (highWaterMs ?? Date.now()) - OVERLAP_MS;
        const rows = readRows(sinceMs);
        let maxMs = highWaterMs ?? sinceMs;
        const changed: string[] = [];
        let foreign = false;
        for (const row of rows) {
          maxMs = Math.max(maxMs, row.updatedAtMs);
          if (seen.get(row.id) === row.updatedAtMs) continue;
          seen.set(row.id, row.updatedAtMs);
          if (!baseline) {
            const path = await locate(row.rolloutPath);
            if (path === "outside") foreign = true;
            else if (path) changed.push(path);
          }
        }
        // A row stamped by a fast clock must not hide later rows for as long
        // as that clock was ahead.
        highWaterMs = Math.min(maxMs, Date.now());
        for (const [id, updatedAtMs] of seen)
          if (updatedAtMs < highWaterMs - 2 * OVERLAP_MS) seen.delete(id);
        stamp = next;
        if (foreign) {
          report("unavailable: rows name rollouts outside the sessions root");
          return null;
        }
        // The first read only establishes where to resume; the interval
        // before it is covered by one full rescan.
        if (baseline) return null;
        report("active");
        return changed;
      } catch (error) {
        reset();
        report("unavailable: read failed", error);
        return null;
      }
    },
  };
}

/** The Codex sessions-tree watcher, hinted by the thread index when rescanning. */
export function codexSessionWatcherSpec(
  watchDir: string,
  periodicRescanMs: number,
): ProviderSessionWatcherSpec {
  return {
    family: "codex",
    provider: "codex",
    watchDir,
    debounceMs: 200,
    periodicRescanMs,
    ...(periodicRescanMs > 0
      ? { periodicRescanHints: () => createCodexThreadChangeHints(watchDir) }
      : {}),
  };
}
