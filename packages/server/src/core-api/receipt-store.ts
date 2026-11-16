import { createHash, randomUUID } from "node:crypto";
import type { SqliteDatabase, SqliteStatement } from "../storage/sqlite.js";
import { CoreApiError } from "./errors.js";
import { profileSessionRelationships } from "../sessions/SessionRelationshipWriter.js";
import {
  receiptSchema,
  type ApiReceipt,
  type ApiCreator,
} from "./command-contracts.js";

/** Receipts retained per process; only completed ones are evicted. */
export const API_RECEIPT_CAPACITY = 10_000;

type ReceiptPatch = Partial<
  Pick<
    ApiReceipt,
    | "state"
    | "sessionId"
    | "queueId"
    | "delivery"
    | "completion"
    | "input"
    | "failure"
    | "result"
  >
>;
interface Entry {
  receipt: ApiReceipt;
  scope: string;
  hash: string;
}

/**
 * A receipt can still change while its admission is unresolved, its input
 * awaits consumption evidence, or a consumed compaction awaits its outcome.
 */
function inFlight(receipt: ApiReceipt): boolean {
  if (receipt.state === "dispatching" || receipt.state === "queued")
    return true;
  if (receipt.state !== "accepted") return false;
  if (!["createSession", "prompt", "input"].includes(receipt.kind))
    return false;
  if (receipt.delivery === "unknown") return true;
  return (
    receipt.input?.type === "compact" &&
    receipt.delivery === "consumed" &&
    receipt.completion === "unknown"
  );
}

/**
 * Retry identity and outcomes for the life of this server process; a restart
 * forgets every receipt. Never stores prompts or bearer credentials. The
 * creator relationship a createSession receipt names is the durable part, and
 * is committed to the profile graph before the receipt itself changes.
 */
export class ApiReceiptStore {
  private statements = new Map<string, SqliteStatement>();
  /** Insertion order is creation order, which eviction and paging follow. */
  private readonly receipts = new Map<string, Entry>();
  private readonly scopes = new Map<string, string>();
  private readonly listeners = new Map<
    string,
    Set<(receipt: ApiReceipt) => void>
  >();
  private listenerCount = 0;
  private readonly detachLookup: () => void;
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
        listener(structuredClone(receipt));
      } catch {
        /* Observation cannot undo committed admission. */
      }
    }
  }

  forPeer(serverId: string) {
    const matches: ApiReceipt[] = [];
    for (const { receipt } of this.receipts.values())
      if (
        receipt.kind === "createSession" &&
        receipt.creator.principal.kind === "peer" &&
        receipt.creator.serverId === serverId
      )
        matches.push(receipt);
    return matches
      .sort(
        (a, b) =>
          (a.createdAt < b.createdAt
            ? 1
            : a.createdAt > b.createdAt
              ? -1
              : 0) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
      )
      .slice(0, 20)
      .map((record) => ({
        id: record.id,
        sessionId: record.sessionId,
        projectId: record.projectId,
        createdAt: record.createdAt,
        state: record.state,
        sourceSessionId: record.creator.sessionId,
      }));
  }
  constructor(
    private readonly database: SqliteDatabase,
    readonly relationshipWriter = profileSessionRelationships(database),
    private readonly capacity = API_RECEIPT_CAPACITY,
  ) {
    relationshipWriter.assertProfileConnection(database);
    this.detachLookup = relationshipWriter.attachReceiptLookup((id) =>
      this.get(id),
    );
  }
  private statement(sql: string) {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.database.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }
  get(id: string): ApiReceipt | undefined {
    const entry = this.receipts.get(id);
    return entry ? structuredClone(entry.receipt) : undefined;
  }
  /**
   * Public session ids remapped by builds before 2026-11-03 still resolve
   * through their recorded aliases. Nothing writes this table now.
   */
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
  private scopeKey(input: {
    requestId: string;
    kind: ApiReceipt["kind"];
    projectId: string;
    sessionId: string | null;
    creator: ApiCreator;
  }) {
    return JSON.stringify([
      input.creator.serverId,
      input.creator.sessionId && input.creator.principal.kind !== "peer"
        ? this.resolveId(input.creator.sessionId)
        : input.creator.sessionId,
      input.creator.principal,
      input.kind,
      input.sessionId ? this.resolveId(input.sessionId) : input.projectId,
      input.requestId,
    ]);
  }
  private replay(scope: string, payload: unknown, checkPayload: boolean) {
    const id = this.scopes.get(scope);
    const previous = id ? this.receipts.get(id) : undefined;
    if (!previous) return;
    if (checkPayload && previous.hash !== payloadHash(payload))
      throw new CoreApiError(
        "request_id_conflict",
        "Retry key already names a different request",
        409,
      );
    return structuredClone(previous.receipt);
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
    return this.replay(this.scopeKey(input), input.payload, checkPayload);
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
    const scope = this.scopeKey(input);
    const previous = this.replay(scope, input.payload, true);
    if (previous) return { created: false, receipt: previous };
    this.makeRoom();
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
    this.recordCreator(receipt);
    this.receipts.set(receipt.id, {
      receipt,
      scope,
      hash: payloadHash(input.payload),
    });
    this.scopes.set(scope, receipt.id);
    return { created: true, receipt: structuredClone(receipt) };
  }
  /** Evict the oldest completed receipt; in-flight receipts are never dropped. */
  private makeRoom() {
    if (this.receipts.size < this.capacity) return;
    for (const [id, entry] of this.receipts) {
      if (inFlight(entry.receipt)) continue;
      this.receipts.delete(id);
      this.scopes.delete(entry.scope);
      return;
    }
    throw new CoreApiError(
      "receipt_capacity",
      "Every retained API receipt is still in flight",
      503,
    );
  }
  /**
   * The durable creator relationship commits before the in-memory receipt
   * changes, so a failed graph write leaves the receipt as it was.
   */
  private recordCreator(receipt: ApiReceipt) {
    if (
      receipt.kind !== "createSession" ||
      !receipt.sessionId ||
      !receipt.creator.sessionId
    )
      return;
    this.database.transaction(() =>
      this.relationshipWriter.receiptWithinTransaction(receipt, (id) =>
        this.resolveId(id),
      ),
    );
  }
  update(id: string, patch: ReceiptPatch) {
    const entry = this.receipts.get(id);
    if (!entry) return;
    const previous = entry.receipt;
    // A patch clears a field with undefined; the JSON form drops the key.
    const next = receiptSchema.parse(
      JSON.parse(JSON.stringify({ ...previous, ...patch })),
    );
    if (JSON.stringify(next) === JSON.stringify(previous))
      return structuredClone(previous);
    next.updatedAt = new Date().toISOString();
    this.recordCreator(next);
    entry.receipt = next;
    this.publish(next);
    return structuredClone(next);
  }
  /**
   * Receipts from this process only. creation is null for a session created
   * before the last restart; its durable creator remains a created_session
   * relationship.
   */
  relationships(sessionId: string, offset: number, limit: number) {
    let creation: ApiReceipt | null = null;
    const initiated: ApiReceipt[] = [];
    let skipped = 0;
    let more = false;
    for (const { receipt } of this.receipts.values()) {
      if (
        !creation &&
        receipt.kind === "createSession" &&
        receipt.sessionId === sessionId
      )
        creation = receipt;
      if (
        more ||
        receipt.creator.sessionId !== sessionId ||
        receipt.creator.principal.kind === "peer"
      )
        continue;
      if (skipped < offset) skipped++;
      else if (initiated.length < limit) initiated.push(receipt);
      else more = true;
    }
    return {
      sessionId,
      creation: creation && structuredClone(creation),
      initiated: structuredClone(initiated),
      nextCursor: more ? String(offset + limit) : null,
    };
  }
  close() {
    this.detachLookup();
    this.listeners.clear();
    for (const statement of this.statements.values()) statement.finalize();
    this.statements.clear();
  }
}

function payloadHash(payload: unknown) {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
