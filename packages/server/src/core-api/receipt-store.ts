import { createHash, randomUUID } from "node:crypto";
import type { SqliteDatabase, SqliteStatement } from "../storage/sqlite.js";
import { CoreApiError } from "./errors.js";
import { profileSessionRelationships } from "../sessions/SessionRelationshipWriter.js";
import {
  receiptSchema,
  type ApiReceipt,
  type ApiCreator,
} from "./command-contracts.js";

/** Durable identity/outcomes only; never stores prompts or bearer credentials. */
export class ApiReceiptStore {
  private statements = new Map<string, SqliteStatement>();
  private readonly listeners = new Map<
    string,
    Set<(receipt: ApiReceipt) => void>
  >();
  private listenerCount = 0;
  subscribe(id: string, listener: (receipt: ApiReceipt) => void) {
    if (this.listenerCount >= 128)
      throw new CoreApiError(
        "controller_unavailable",
        "Receipt observation capacity reached",
        503,
      );
    let listeners = this.listeners.get(id);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(id, listeners);
    }
    listeners.add(listener);
    this.listenerCount++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      listeners!.delete(listener);
      this.listenerCount--;
      if (!listeners!.size) this.listeners.delete(id);
    };
  }
  private publish(receipt: ApiReceipt) {
    for (const listener of [...(this.listeners.get(receipt.id) ?? [])]) {
      try {
        listener(receipt);
      } catch {
        /* Observation cannot undo committed admission. */
      }
    }
  }

  forPeer(serverId: string) {
    return this.statement(
      "SELECT receipt_json FROM agent_api_receipts WHERE kind = 'createSession' AND json_extract(receipt_json, '$.creator.principal.kind') = 'peer' AND json_extract(receipt_json, '$.creator.serverId') = ? ORDER BY json_extract(receipt_json, '$.createdAt') DESC, id DESC LIMIT 20",
    )
      .all<{ receipt_json: string }>(serverId)
      .map((row) => {
        const record = receiptSchema.parse(JSON.parse(row.receipt_json));
        return {
          id: record.id,
          sessionId: record.sessionId,
          projectId: record.projectId,
          createdAt: record.createdAt,
          state: record.state,
          sourceSessionId: record.creator.sessionId,
        };
      });
  }
  constructor(
    private readonly database: SqliteDatabase,
    readonly relationshipWriter = profileSessionRelationships(database),
  ) {
    relationshipWriter.assertProfileConnection(database);
  }
  private statement(sql: string) {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.database.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }
  private decode(row: { receipt_json: string } | undefined) {
    return row ? receiptSchema.parse(JSON.parse(row.receipt_json)) : undefined;
  }
  get(id: string) {
    return this.decode(
      this.statement(
        "SELECT receipt_json FROM agent_api_receipts WHERE id = ?",
      ).get<{ receipt_json: string }>(id),
    );
  }
  resolveId(id: string): string {
    const seen = new Set<string>();
    for (let hop = 0; hop < 32; hop++) {
      if (seen.has(id)) throw new Error("Cyclic API session alias");
      seen.add(id);
      const row = this.statement(
        "SELECT target FROM agent_api_session_aliases WHERE id = ?",
      ).get<{ target: string }>(id);
      if (!row) return id;
      id = row.target;
    }
    throw new Error("API session alias depth exceeded");
  }
  lookup(
    input: {
      requestId: string;
      kind: ApiReceipt["kind"];
      projectId: string;
      sessionId: string | null;
      creator: ApiCreator;
      payload: unknown;
    },
    checkPayload = true,
  ) {
    const scope = JSON.stringify([
      input.creator.serverId,
      input.creator.sessionId && input.creator.principal.kind !== "peer"
        ? this.resolveId(input.creator.sessionId)
        : input.creator.sessionId,
      input.creator.principal,
      input.kind,
      input.sessionId ? this.resolveId(input.sessionId) : input.projectId,
      input.requestId,
    ]);
    const previous = this.statement(
      "SELECT payload_hash, receipt_json FROM agent_api_receipts WHERE scope_key = ?",
    ).get<{ payload_hash: string; receipt_json: string }>(scope);
    if (!previous) return;
    const hash = createHash("sha256")
      .update(JSON.stringify(input.payload))
      .digest("hex");
    if (checkPayload && previous.payload_hash !== hash)
      throw new CoreApiError(
        "request_id_conflict",
        "Retry key already names a different request",
        409,
      );
    return this.decode(previous)!;
  }
  reserve(input: {
    requestId: string;
    kind: ApiReceipt["kind"];
    projectId: string;
    sessionId: string | null;
    creator: ApiCreator;
    destinationServerId: string;
    payload: unknown;
  }) {
    input = {
      ...input,
      sessionId: input.sessionId ? this.resolveId(input.sessionId) : null,
      creator: {
        ...input.creator,
        sessionId:
          input.creator.sessionId && input.creator.principal.kind !== "peer"
            ? this.resolveId(input.creator.sessionId)
            : input.creator.sessionId,
      },
    };
    const scope = JSON.stringify([
      input.creator.serverId,
      input.creator.sessionId,
      input.creator.principal,
      input.kind,
      input.sessionId ?? input.projectId,
      input.requestId,
    ]);
    const hash = createHash("sha256")
      .update(JSON.stringify(input.payload))
      .digest("hex");
    return this.database.transaction(() => {
      const previous = this.statement(
        "SELECT payload_hash, receipt_json FROM agent_api_receipts WHERE scope_key = ?",
      ).get<{ payload_hash: string; receipt_json: string }>(scope);
      if (previous) {
        if (previous.payload_hash !== hash)
          throw new CoreApiError(
            "request_id_conflict",
            "Retry key already names a different request",
            409,
          );
        return { created: false, receipt: this.decode(previous)! };
      }
      const count = this.statement(
        "SELECT COUNT(*) AS total FROM agent_api_receipts",
      ).get<{ total: number }>()!.total;
      if (count >= 10000)
        throw new CoreApiError(
          "receipt_capacity",
          "Durable API receipt capacity reached",
          503,
        );
      const now = new Date().toISOString();
      const receipt: ApiReceipt = {
        id: randomUUID(),
        requestId: input.requestId,
        kind: input.kind,
        state: "dispatching",
        projectId: input.projectId,
        sessionId: input.sessionId,
        creator: input.creator,
        destinationServerId: input.destinationServerId,
        createdAt: now,
        updatedAt: now,
        delivery: "unknown",
        completion: "unknown",
      };
      this.statement(
        "INSERT INTO agent_api_receipts (id, scope_key, payload_hash, kind, project_id, session_id, source_session_id, state, receipt_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        receipt.id,
        scope,
        hash,
        receipt.kind,
        receipt.projectId,
        receipt.sessionId,
        receipt.creator.sessionId,
        receipt.state,
        JSON.stringify(receipt),
      );
      this.relationshipWriter.receiptWithinTransaction(receipt, (id) =>
        this.resolveId(id),
      );
      return { created: true, receipt };
    });
  }
  update(
    id: string,
    patch: Partial<
      Pick<
        ApiReceipt,
        "state" | "sessionId" | "queueId" | "delivery" | "failure" | "result"
      >
    >,
  ) {
    const result = this.database.transaction(() =>
      this.updateWithinTransaction(id, patch),
    );
    if (result?.changed) this.publish(result.receipt);
    return result?.receipt;
  }
  private updateWithinTransaction(
    id: string,
    patch: Partial<
      Pick<
        ApiReceipt,
        "state" | "sessionId" | "queueId" | "delivery" | "failure" | "result"
      >
    >,
  ) {
    const previous = this.get(id);
    if (!previous) return;
    const next = receiptSchema.parse({ ...previous, ...patch });
    if (JSON.stringify(next) === JSON.stringify(previous))
      return { receipt: previous, changed: false };
    next.updatedAt = new Date().toISOString();
    this.statement(
      "UPDATE agent_api_receipts SET session_id = ?, state = ?, receipt_json = ? WHERE id = ?",
    ).run(next.sessionId, next.state, JSON.stringify(next), id);
    this.relationshipWriter.receiptWithinTransaction(next, (id) =>
      this.resolveId(id),
    );
    return { receipt: next, changed: true };
  }
  /** A crash/reload cannot prove whether an external startup crossed its boundary. */
  recoverInterrupted() {
    const recovered: ApiReceipt[] = [];
    this.database.transaction(() => {
      const rows = this.statement(
        "SELECT receipt_json FROM agent_api_receipts WHERE state IN ('dispatching', 'queued', 'accepted') LIMIT 10000",
      ).all<{ receipt_json: string }>();
      for (const row of rows) {
        const receipt = this.decode(row)!;
        // Accepted input still awaits consumption evidence. An accepted
        // control already recorded its outcome and delivers no input.
        if (
          receipt.state === "accepted" &&
          (receipt.delivery === "consumed" ||
            (receipt.kind !== "createSession" && receipt.kind !== "prompt"))
        )
          continue;
        const next = this.updateWithinTransaction(
          receipt.id,
          receipt.state === "accepted"
            ? {
                delivery: "uncertain",
                failure: {
                  code: "delivery_uncertain",
                  message:
                    "Server restarted without durable input-consumption evidence; no automatic resend is performed",
                },
              }
            : { state: "uncertain", delivery: "uncertain" },
        );
        if (next?.changed) recovered.push(next.receipt);
      }
    });
    for (const receipt of recovered) this.publish(receipt);
  }
  relationships(sessionId: string, offset: number, limit: number) {
    const creation =
      this.decode(
        this.statement(
          "SELECT receipt_json FROM agent_api_receipts WHERE session_id = ? AND kind = 'createSession' ORDER BY rowid LIMIT 1",
        ).get<{ receipt_json: string }>(sessionId),
      ) ?? null;
    const rows = this.statement(
      "SELECT receipt_json FROM agent_api_receipts WHERE source_session_id = ? AND json_extract(receipt_json, '$.creator.principal.kind') != 'peer' ORDER BY id LIMIT ? OFFSET ?",
    ).all<{ receipt_json: string }>(sessionId, limit + 1, offset);
    return {
      sessionId,
      creation,
      initiated: rows.slice(0, limit).map((row) => this.decode(row)!),
      nextCursor: rows.length > limit ? String(offset + limit) : null,
    };
  }
  close() {
    this.listeners.clear();
    for (const statement of this.statements.values()) statement.finalize();
    this.statements.clear();
  }
}
