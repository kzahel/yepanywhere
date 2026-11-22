import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadSqliteDriver } from "../../src/storage/sqlite.js";

/**
 * Write an `agy` store's summaries index, the only place `agy` records each
 * conversation's workspace. `store` is the `antigravity-cli` directory; the
 * index is replaced, not merged.
 */
export async function writeAntigravitySummaries(
  store: string,
  rows: ReadonlyArray<{ id: string; cwd: string; title?: string }>,
): Promise<void> {
  await mkdir(join(store, "conversations"), { recursive: true });
  const path = join(store, "conversation_summaries.db");
  await rm(path, { force: true });
  const db = loadSqliteDriver()!.open(path);
  try {
    db.exec(
      "CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', workspace_uris TEXT NOT NULL)",
    );
    const insert = db.prepare(
      "INSERT INTO conversation_summaries VALUES (?, ?, ?)",
    );
    for (const row of rows)
      insert.run(
        row.id,
        row.title ?? "",
        JSON.stringify([pathToFileURL(row.cwd).href]),
      );
    insert.finalize();
  } finally {
    db.close();
  }
}
