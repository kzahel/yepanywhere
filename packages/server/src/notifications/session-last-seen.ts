import { readFile, rm } from "node:fs/promises";
import type { SqliteDatabase, SqliteStatement } from "../storage/sqlite.js";
import type {
  LastSeenEntry,
  NotificationState,
} from "./NotificationService.js";

/** Canonical seen rows. Fixed lazy statements; no resident corpus or miss cache. */
export class SessionLastSeen {
  private readonly statements = new Map<string, SqliteStatement>();
  constructor(readonly database: SqliteDatabase) {}
  private prepare(sql: string) {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.database.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }
  get(id: string): LastSeenEntry | undefined {
    const row = this.prepare(
      "SELECT entry_json FROM session_last_seen WHERE session_id=?",
    ).get<{ entry_json: string }>(id);
    return row && (JSON.parse(row.entry_json) as LastSeenEntry);
  }
  put(id: string, value: LastSeenEntry) {
    this.prepare(
      "INSERT INTO session_last_seen VALUES(?,?) ON CONFLICT(session_id) DO UPDATE SET entry_json=excluded.entry_json",
    ).run(id, JSON.stringify(value));
  }
  remove(id: string): boolean {
    return (
      this.prepare("DELETE FROM session_last_seen WHERE session_id=?").run(id)
        .changes > 0
    );
  }
  all(): Record<string, LastSeenEntry> {
    const statement = this.database.prepare(
      "SELECT session_id,entry_json FROM session_last_seen",
    );
    try {
      return Object.fromEntries(
        statement
          .all<{ session_id: string; entry_json: string }>()
          .map((row) => [
            row.session_id,
            JSON.parse(row.entry_json) as LastSeenEntry,
          ]),
      );
    } finally {
      statement.finalize();
    }
  }
  async importLegacy(file: string): Promise<void> {
    const marker = this.database.prepare(
      "SELECT source FROM session_last_seen_import WHERE id=1",
    );
    try {
      if (marker.get()) return;
      let content: string | undefined;
      try {
        content = await readFile(file, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          throw new Error(`Cannot read ${file} for seen-state import`, {
            cause: error,
          });
      }
      let entries: Array<[string, LastSeenEntry]> = [];
      if (content !== undefined) {
        try {
          const parsed = JSON.parse(content) as NotificationState;
          if (
            !parsed?.lastSeen ||
            typeof parsed.lastSeen !== "object" ||
            Array.isArray(parsed.lastSeen)
          )
            throw new Error("Expected a lastSeen object");
          entries = Object.entries(parsed.lastSeen);
          for (const [, value] of entries)
            if (
              !value ||
              typeof value.timestamp !== "string" ||
              (value.messageId !== undefined &&
                typeof value.messageId !== "string")
            )
              throw new Error("Invalid lastSeen entry");
        } catch (error) {
          throw new Error(
            `Cannot import ${file}: invalid seen-state JSON; repair it and restart`,
            { cause: error },
          );
        }
      }
      const insert = this.database.prepare(
        "INSERT INTO session_last_seen_import VALUES(1,?)",
      );
      try {
        this.database.transaction(() => {
          if (marker.get()) return;
          for (const [id, entry] of entries) this.put(id, entry);
          insert.run(content === undefined ? "none" : "json");
        });
      } finally {
        insert.finalize();
      }
      // Delete only after committed adoption. The marker makes crash/retry safe.
      if (content !== undefined)
        await rm(file, { force: true }).catch(() => undefined);
    } finally {
      marker.finalize();
    }
  }
  dispose() {
    for (const statement of this.statements.values()) statement.finalize();
    this.statements.clear();
  }
}
