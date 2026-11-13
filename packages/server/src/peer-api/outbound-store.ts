import { createHash, randomUUID } from "node:crypto";
import type { SqliteDatabase, SqliteStatement } from "../storage/sqlite.js";
import {
  outboundSchema,
  type ApiOutbound,
  type ReceiptBinding,
} from "../core-api/command-contracts.js";
import { CoreApiError } from "../core-api/errors.js";
import { profileSessionRelationships } from "../sessions/SessionRelationshipWriter.js";

/** Durable intent before network I/O. Stores hashes and outcomes, never prompt bodies. */
export class PeerOutboundStore {
  private readonly statements = new Map<string, SqliteStatement>();
  forPeer(serverId: string) {
    return this.statement(
      "SELECT record_json FROM peer_api_outbound WHERE destination_server_id = ? AND json_extract(record_json, '$.operation') = 'createSession' ORDER BY json_extract(record_json, '$.createdAt') DESC, id DESC LIMIT 20",
    )
      .all<{ record_json: string }>(serverId)
      .map((row) => {
        const record = outboundSchema.parse(JSON.parse(row.record_json));
        return {
          id: record.id,
          sessionId: record.destinationSessionId,
          projectId: record.receipt?.projectId ?? null,
          createdAt: record.createdAt,
          state: record.state,
          sourceSessionId: record.sourceSessionId,
        };
      });
  }
  constructor(
    private readonly database: SqliteDatabase,
    readonly relationships = profileSessionRelationships(database),
  ) {
    relationships.assertProfileConnection(database);
  }
  private statement(sql: string) {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.database.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }
  reserve(
    input: Omit<
      ApiOutbound,
      "id" | "state" | "createdAt" | "receipt" | "destinationSessionId"
    >,
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
        destinationSessionId: null,
      };
      this.statement(
        "INSERT INTO peer_api_outbound (id, scope_key, payload_hash, source_session_id, record_json, destination_server_id) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(
        record.id,
        scope,
        hash,
        record.sourceSessionId,
        JSON.stringify(record),
        record.destinationServerId,
      );
      return record;
    });
  }
  confirm(record: ApiOutbound, receipt: ReceiptBinding) {
    return this.database.transaction(() =>
      this.confirmWithinTransaction(record, receipt),
    );
  }
  private confirmWithinTransaction(
    record: ApiOutbound,
    receipt: ReceiptBinding,
  ) {
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
    if (
      receipt.destinationServerId !== current.destinationServerId ||
      receipt.creator.serverId !== current.sourceServerId ||
      receipt.creator.principal.kind !== "peer" ||
      receipt.creator.sessionId !== current.attestedSessionId ||
      receipt.requestId !== current.requestId
    )
      throw new CoreApiError(
        "peer_identity_mismatch",
        "Observed peer receipt attribution does not match",
        502,
      );
    const next: ApiOutbound = {
      ...current,
      operation: receipt.kind,
      state: "confirmed",
      receipt,
      destinationSessionId: receipt.sessionId ?? current.destinationSessionId,
    };
    this.statement(
      "UPDATE peer_api_outbound SET record_json = ?, remote_receipt_id = ? WHERE id = ?",
    ).run(JSON.stringify(next), receipt.id, record.id);
    this.relationships.outboundWithinTransaction(next);
  }
  /** Only an already correlated receipt can enrich its source-side binding. */
  observe(serverId: string, receipt: ReceiptBinding) {
    const rows = this.statement(
      "SELECT record_json FROM peer_api_outbound WHERE destination_server_id = ? AND remote_receipt_id = ? LIMIT 10000",
    ).all<{ record_json: string }>(serverId, receipt.id);
    this.database.transaction(() => {
      for (const row of rows) {
        const record = outboundSchema.parse(JSON.parse(row.record_json));
        if (
          receipt.destinationServerId !== record.destinationServerId ||
          receipt.creator.serverId !== record.sourceServerId ||
          receipt.creator.principal.kind !== "peer" ||
          receipt.creator.sessionId !== record.attestedSessionId ||
          receipt.requestId !== record.requestId
        )
          throw new CoreApiError(
            "peer_identity_mismatch",
            "Observed peer receipt attribution does not match",
            502,
          );
        this.confirmWithinTransaction(record, receipt);
      }
    });
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
  close() {
    for (const statement of this.statements.values()) statement.finalize();
    this.statements.clear();
  }
}
