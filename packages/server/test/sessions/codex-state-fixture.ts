import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  loadSqliteDriver,
  type SqliteStatement,
} from "../../src/storage/sqlite.js";

// The subset of Codex's threads schema that YA reads: from rust-v0.167.0
// (updated_at_ms), unchanged for these columns at rust-v0.169.0.
export const CODEX_THREADS_SCHEMA = `PRAGMA journal_mode=WAL;
CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL,
  updated_at INTEGER NOT NULL, updated_at_ms INTEGER);
CREATE INDEX idx_threads_updated_at ON threads(updated_at DESC, id DESC);`;

export const codexStateDriver = loadSqliteDriver();

/** A synthetic Codex home: `sessions/` beside a writable `state_5.sqlite`. */
export function createCodexHome(root: string, schema = CODEX_THREADS_SCHEMA) {
  const sessionsDir = join(root, "sessions");
  const databasePath = join(root, "state_5.sqlite");
  mkdirSync(root, { recursive: true });
  const database = codexStateDriver!.open(databasePath);
  database.exec(schema);
  let upsert: SqliteStatement | undefined;
  return {
    sessionsDir,
    databasePath,
    write(id: string, rolloutPath: string, updatedAtMs = Date.now()) {
      upsert ??= database.prepare(
        `INSERT INTO threads (id, rollout_path, updated_at, updated_at_ms)
         VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
         rollout_path = excluded.rollout_path, updated_at = excluded.updated_at,
         updated_at_ms = excluded.updated_at_ms`,
      );
      upsert.run(id, rolloutPath, Math.floor(updatedAtMs / 1000), updatedAtMs);
    },
    close() {
      upsert?.finalize();
      database.close();
    },
  };
}
