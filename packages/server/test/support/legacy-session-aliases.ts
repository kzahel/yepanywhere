import type {
  SqliteDatabase,
  SqliteStatement,
} from "../../src/storage/sqlite.js";
import {
  receiptSchema,
  outboundSchema,
} from "../../src/core-api/command-contracts.js";

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
export function seedHistoricalReceiptAlias(
  store: unknown,
  oldId: string,
  newId: string,
) {
  seed(store, (database, statement) => {
    if (oldId === newId) return;

    database.transaction(() => {
      const rows = statement(
        "SELECT id, scope_key, receipt_json FROM agent_api_receipts WHERE session_id = ? OR source_session_id = ? LIMIT 10000",
      ).all<{ id: string; scope_key: string; receipt_json: string }>(
        oldId,
        oldId,
      );
      if (!rows.length) return;
      statement(
        "INSERT INTO agent_api_session_aliases (id,target) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET target=excluded.target",
      ).run(oldId, newId);
      for (const row of rows) {
        const previous = receiptSchema.parse(JSON.parse(row.receipt_json));
        const next = {
          ...previous,
          updatedAt: new Date().toISOString(),
          sessionId: previous.sessionId === oldId ? newId : previous.sessionId,
          creator: {
            ...previous.creator,
            sessionId:
              previous.creator.principal.kind !== "peer" &&
              previous.creator.sessionId === oldId
                ? newId
                : previous.creator.sessionId,
          },
        };
        const scope = JSON.parse(row.scope_key) as unknown[];
        if (previous.creator.principal.kind !== "peer" && scope[1] === oldId)
          scope[1] = newId;
        if (previous.kind === "sendMessage" && scope[4] === oldId)
          scope[4] = newId;
        statement(
          "UPDATE agent_api_receipts SET scope_key = ?, session_id = ?, source_session_id = ?, receipt_json = ? WHERE id = ?",
        ).run(
          JSON.stringify(scope),
          next.sessionId,
          next.creator.sessionId,
          JSON.stringify(next),
          row.id,
        );
      }
    });
  });
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
