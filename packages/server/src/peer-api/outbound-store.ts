import { createHash, randomUUID } from "node:crypto";
import type { SqliteDatabase, SqliteStatement } from "../storage/sqlite.js";
import {
  outboundSchema,
  type ApiOutbound,
  type ApiReceipt,
} from "../core-api/command-contracts.js";
import { CoreApiError } from "../core-api/errors.js";

/** Durable intent before network I/O. Stores hashes and outcomes, never prompt bodies. */
export class PeerOutboundStore {
  private readonly statements = new Map<string, SqliteStatement>();
  constructor(private readonly database: SqliteDatabase) {}
  private statement(sql: string) {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.database.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }
  reserve(
    input: Omit<ApiOutbound, "id" | "state" | "createdAt" | "receipt">,
    payload: unknown,
  ) {
    const scope = JSON.stringify([
      input.sourceServerId,
      input.sourceSessionId,
      input.destinationServerId,
      input.operation,
      input.resource,
      input.requestId,
    ]);
    const hash = createHash("sha256")
      .update(JSON.stringify(payload))
      .digest("hex");
    return this.database.transaction(() => {
      const previous = this.statement(
        "SELECT payload_hash, record_json FROM peer_api_outbound WHERE scope_key = ?",
      ).get<{ payload_hash: string; record_json: string }>(scope);
      if (previous) {
        if (previous.payload_hash !== hash)
          throw new CoreApiError(
            "request_id_conflict",
            "Retry key already names a different outbound request",
            409,
          );
        return outboundSchema.parse(JSON.parse(previous.record_json));
      }
      const count = this.statement(
        "SELECT COUNT(*) AS total FROM peer_api_outbound",
      ).get<{ total: number }>()!.total;
      if (count >= 10000)
        throw new CoreApiError(
          "receipt_capacity",
          "Outbound receipt capacity reached",
          503,
        );
      const record: ApiOutbound = {
        ...input,
        id: randomUUID(),
        state: "uncertain",
        createdAt: new Date().toISOString(),
        receipt: null,
      };
      this.statement(
        "INSERT INTO peer_api_outbound (id, scope_key, payload_hash, source_session_id, record_json) VALUES (?, ?, ?, ?, ?)",
      ).run(
        record.id,
        scope,
        hash,
        record.sourceSessionId,
        JSON.stringify(record),
      );
      return record;
    });
  }
  confirm(record: ApiOutbound, receipt: ApiReceipt) {
    const row = this.statement(
      "SELECT record_json FROM peer_api_outbound WHERE id = ?",
    ).get<{ record_json: string }>(record.id);
    if (!row)
      throw new CoreApiError(
        "receipt_not_found",
        "Outbound record not found",
        404,
      );
    const current = outboundSchema.parse(JSON.parse(row.record_json));
    this.statement(
      "UPDATE peer_api_outbound SET record_json = ? WHERE id = ?",
    ).run(
      JSON.stringify({ ...current, state: "confirmed", receipt }),
      record.id,
    );
  }
  list(sourceSessionId: string, offset: number, limit: number) {
    const rows = this.statement(
      "SELECT record_json FROM peer_api_outbound WHERE source_session_id = ? ORDER BY id LIMIT ? OFFSET ?",
    ).all<{ record_json: string }>(sourceSessionId, limit + 1, offset);
    return {
      items: rows
        .slice(0, limit)
        .map((r) => outboundSchema.parse(JSON.parse(r.record_json))),
      nextCursor: rows.length > limit ? String(offset + limit) : null,
    };
  }
  /** Called alongside the local receipt store's canonical identity remap. */
  remap(oldId: string, newId: string) {
    this.database.transaction(() => {
      const rows = this.statement(
        "SELECT id, scope_key, record_json FROM peer_api_outbound WHERE source_session_id = ?",
      ).all<{ id: string; scope_key: string; record_json: string }>(oldId);
      for (const row of rows) {
        const scope = JSON.parse(row.scope_key) as unknown[];
        scope[1] = newId;
        const record = outboundSchema.parse(JSON.parse(row.record_json));
        this.statement(
          "UPDATE peer_api_outbound SET scope_key = ?, source_session_id = ?, record_json = ? WHERE id = ?",
        ).run(
          JSON.stringify(scope),
          newId,
          JSON.stringify({ ...record, sourceSessionId: newId }),
          row.id,
        );
      }
    });
  }
  close() {
    for (const statement of this.statements.values()) statement.finalize();
    this.statements.clear();
  }
}
