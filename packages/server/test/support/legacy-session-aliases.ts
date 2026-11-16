import type {
  SqliteDatabase,
  SqliteStatement,
} from "../../src/storage/sqlite.js";
import { outboundSchema } from "../../src/core-api/command-contracts.js";

/** Frozen pre-admission database fixtures; no current runtime writes aliases. */
function seed(
  store: unknown,
  apply: (
    database: SqliteDatabase,
    statement: (sql: string) => SqliteStatement,
  ) => void,
) {
  const database = (store as { database: SqliteDatabase }).database;
  const prepared = new Map<string, SqliteStatement>();
  const statement = (sql: string) => {
    let value = prepared.get(sql);
    if (!value) {
      value = database.prepare(sql);
      prepared.set(sql, value);
    }
    return value;
  };
  try {
    apply(database, statement);
  } finally {
    for (const value of prepared.values()) value.finalize();
  }
}
/** An alias row as builds before 2026-11-03 wrote it on a public id remap. */
export function seedHistoricalSessionAlias(
  database: SqliteDatabase,
  oldId: string,
  newId: string,
) {
  const insert = database.prepare(
    "INSERT INTO agent_api_session_aliases (id, target) VALUES (?, ?)",
  );
  try {
    insert.run(oldId, newId);
  } finally {
    insert.finalize();
  }
}
export function seedHistoricalOutboundAlias(
  store: unknown,
  oldId: string,
  newId: string,
) {
  seed(store, (database, statement) => {
    database.transaction(() => {
      const rows = statement(
        "SELECT id, scope_key, record_json FROM peer_api_outbound WHERE source_session_id = ?",
      ).all<{ id: string; scope_key: string; record_json: string }>(oldId);
      for (const row of rows) {
        const scope = JSON.parse(row.scope_key) as unknown[];
        scope[1] = newId;
        const record = outboundSchema.parse(JSON.parse(row.record_json));
        statement(
          "UPDATE peer_api_outbound SET scope_key = ?, source_session_id = ?, record_json = ? WHERE id = ?",
        ).run(
          JSON.stringify(scope),
          newId,
          JSON.stringify({ ...record, sourceSessionId: newId }),
          row.id,
        );
      }
    });
  });
}
