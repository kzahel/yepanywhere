import { createHash } from "node:crypto";
import { isYaSessionId } from "@yep-anywhere/shared";
import type { ApiOutbound, ApiReceipt } from "../core-api/command-contracts.js";
import { readServerIdentity } from "../core-api/server-identity.js";
import type { SessionMetadata } from "../metadata/SessionMetadataService.js";
import type { SqliteDatabase, SqliteStatement } from "../storage/sqlite.js";
import {
  SessionRelationshipStore,
  type RelationshipFact,
  type RelationshipResource,
} from "./SessionRelationshipStore.js";

/** Server-owned lineage, never accepted from descriptive provenance or prompts. */
export interface CreationLineage {
  asideOf?: string;
  continuedFrom?: string;
}
export interface CreationRelationshipSource {
  id: string;
  sessionId: string;
  createdAt: string;
  /** Correlated server-owned v0 receipt, validated by the admission owner. */
  nativeReceiptId?: string;
  copy?: {
    kind: "fork" | "clone";
    sourceSessionId: string;
    upToMessageId?: string;
    boundary?:
      | { kind: "message"; messageId: string }
      | { kind: "turn"; turnId: string }
      | { kind: "entry"; entryId: string };
  };
  lineage?: CreationLineage;
}
export type ReceiptRelationshipSource = Pick<
  ApiReceipt,
  "id" | "kind" | "sessionId" | "creator" | "destinationServerId" | "createdAt"
>;
export type OutboundRelationshipSource = Pick<
  ApiOutbound,
  | "id"
  | "operation"
  | "state"
  | "sourceSessionId"
  | "sourceServerId"
  | "destinationSessionId"
  | "destinationServerId"
  | "sourceLaunchId"
  | "createdAt"
> & { receipt?: { id: string } | null };

/** Only durable relationship fields, without credential/proof payloads. */
export const receiptRelationshipJson = `json_object('id', id, 'kind', kind, 'sessionId', session_id,
  'destinationServerId', json_extract(receipt_json, '$.destinationServerId'),
  'createdAt', json_extract(receipt_json, '$.createdAt'),
  'creator', json_object('serverId', json_extract(receipt_json, '$.creator.serverId'),
    'sessionId', json_extract(receipt_json, '$.creator.sessionId'),
    'launchId', json_extract(receipt_json, '$.creator.launchId'),
    'principal', json_extract(receipt_json, '$.creator.principal'),
    'authentication', CASE WHEN json_extract(receipt_json, '$.creator.authentication.sessionAttribution') = 'source-attested'
      THEN json_object('sessionAttribution', 'source-attested') ELSE NULL END))`;

// Connection ownership only, never a cache of facts or session identities.
// The required profile database finalizes all statements on close. Weak keys
// let standalone source owners compose without preparing another graph store.
const owners = new WeakMap<SqliteDatabase, SessionRelationshipWriter>();
export function profileSessionRelationships(
  database: SqliteDatabase,
  serverId?: string,
): SessionRelationshipWriter {
  let owner = owners.get(database);
  if (!owner) {
    owner = new SessionRelationshipWriter(database, serverId);
    owners.set(database, owner);
  } else if (serverId && owner.serverId !== serverId)
    throw new Error("Relationship profile identity does not match");
  return owner;
}

/**
 * One profile owner shared by admission, receipts and native acquisition.
 * Call each *WithinTransaction method from its source owner's transaction.
 * There are no provider effects, credentials, grants or public query routes here.
 */
export class SessionRelationshipWriter {
  private store?: SessionRelationshipStore;
  private admissionReceipt?: SqliteStatement;
  readonly serverId: string;

  constructor(
    database: SqliteDatabase,
    serverId = readServerIdentity(database),
  ) {
    this.database = database;
    this.serverId = serverId;
  }
  private readonly database: SqliteDatabase;
  get index(): SessionRelationshipStore {
    this.store ??= new SessionRelationshipStore(this.database);
    return this.store;
  }
  assertProfileConnection(database: SqliteDatabase): void {
    if (database !== this.database)
      throw new Error("Relationships require the profile connection");
  }
  session(sessionId: string, serverId = this.serverId): RelationshipResource {
    return { kind: "session", serverId, sessionId };
  }
  private lineageFact(
    type: RelationshipFact["type"],
    sessionId: string,
    sourceSessionId: string | undefined,
    boundaryId?: string,
  ): RelationshipFact[] {
    // Legacy sources can contain values outside the current identity contract.
    // Preserve their owner record without guessing or blocking unrelated writes.
    if (
      !isYaSessionId(sessionId) ||
      !isYaSessionId(sourceSessionId) ||
      sessionId === sourceSessionId
    )
      return [];
    return [
      {
        type,
        source: this.session(sessionId),
        target: this.session(sourceSessionId),
        recordKey: type,
        trust: "local-authenticated",
        ...(boundaryId ? { metadata: { boundaryId } } : {}),
      },
    ];
  }
  creationWithinTransaction(
    source: CreationRelationshipSource,
    resolveId: (id: string) => string = (id) => id,
  ): void {
    const boundary = source.copy?.boundary;
    const facts = [
      ...(source.copy
        ? this.lineageFact(
            source.copy.kind === "fork" ? "forked_from" : "cloned_from",
            source.sessionId,
            source.copy.sourceSessionId,
            source.copy.upToMessageId ??
              (boundary?.kind === "message"
                ? boundary.messageId
                : boundary?.kind === "turn"
                  ? boundary.turnId
                  : boundary?.entryId),
          )
        : []),
      ...this.lineageFact(
        "aside_of",
        source.sessionId,
        source.lineage?.asideOf,
      ),
      ...this.lineageFact(
        "continued_from",
        source.sessionId,
        source.lineage?.continuedFrom,
      ),
    ];
    if (facts.length)
      this.index.recordWithinTransaction(
        {
          producer: "ya-creation-v1",
          sourceKey: source.id,
          sourceVersion: "1",
          extractorVersion: 1,
          observedAt: source.createdAt,
        },
        facts,
      );
    if (source.nativeReceiptId) {
      this.admissionReceipt ??= this.database.prepare(
        `SELECT ${receiptRelationshipJson} AS source FROM agent_api_receipts WHERE id = ? AND kind = 'createSession'`,
      );
      const row = this.admissionReceipt.get<{ source: string }>(
        source.nativeReceiptId,
      );
      if (row) {
        const receipt: ReceiptRelationshipSource = JSON.parse(row.source);
        if (
          receipt.sessionId &&
          resolveId(receipt.sessionId) !== resolveId(source.sessionId)
        )
          throw new Error("Creation receipt already names another session");
        this.receiptWithinTransaction(
          { ...receipt, sessionId: source.sessionId },
          resolveId,
        );
      }
    }
  }
  metadataWithinTransaction(
    sessionId: string,
    metadata:
      | Pick<
          SessionMetadata,
          "parentSessionId" | "parentSessionKind" | "forkedFromSessionId"
        >
      | undefined,
  ): void {
    if (!isYaSessionId(sessionId)) return;
    const aside =
      metadata?.parentSessionKind === "btw-aside"
        ? metadata.parentSessionId
        : undefined;
    const derived = metadata?.forkedFromSessionId;
    // Exact fork/clone facts survive source payload retention. Never weaken one
    // into derived_from just because the saved request body was pruned.
    const exact =
      derived &&
      ["forked_from", "cloned_from"].some((type) =>
        this.index
          .list({
            resource: this.session(sessionId),
            direction: "outgoing",
            type: type as "forked_from" | "cloned_from",
            limit: 200,
          })
          .edges.some(
            (edge) =>
              edge.target.kind === "session" &&
              edge.target.serverId === this.serverId &&
              edge.target.sessionId === derived,
          ),
      );
    const facts = [
      ...this.lineageFact("aside_of", sessionId, aside),
      ...(!exact ? this.lineageFact("derived_from", sessionId, derived) : []),
    ];
    const producer = "ya-metadata-lineage-v1";
    const previous = this.index.checkpoint(producer, sessionId);
    if (!facts.length && !previous) return;
    const version = createHash("sha256")
      .update(JSON.stringify(facts))
      .digest("hex");
    if (previous?.sourceVersion === version) return;
    this.index.publishWithinTransaction({
      observation: {
        producer,
        sourceKey: sessionId,
        sourceVersion: version,
        extractorVersion: 1,
        observedAt: new Date().toISOString(),
      },
      expectedRevision: previous?.revision ?? null,
      facts,
      progress: { state: "complete", cursor: "{}" },
      replaceSource: true,
    });
  }
  receiptWithinTransaction(
    receipt: ReceiptRelationshipSource,
    resolveId: (id: string) => string = (id) => id,
  ): void {
    if (
      receipt.kind !== "createSession" ||
      !receipt.sessionId ||
      !receipt.creator.sessionId
    )
      return;
    const creator = receipt.creator;
    // This is a target's trusted owner record, not a caller-supplied identity.
    if (
      creator.principal.kind === "peer" &&
      creator.authentication?.sessionAttribution !== "source-attested"
    )
      return;
    this.creatorWithinTransaction("v0-receipt-v1", receipt.id, {
      sourceSessionId:
        creator.principal.kind === "peer"
          ? creator.sessionId!
          : resolveId(creator.sessionId!),
      sourceServerId: creator.serverId,
      targetSessionId: resolveId(receipt.sessionId),
      targetServerId: receipt.destinationServerId,
      trust:
        creator.principal.kind === "peer"
          ? "peer-attested"
          : "local-authenticated",
      receiptId: receipt.id,
      launchId: creator.launchId ?? undefined,
      observedAt: receipt.createdAt,
    });
  }
  outboundWithinTransaction(record: OutboundRelationshipSource): void {
    if (
      record.operation !== "createSession" ||
      record.state !== "confirmed" ||
      !record.destinationSessionId ||
      !record.sourceSessionId
    )
      return;
    this.creatorWithinTransaction("v0-outbound-v1", record.id, {
      sourceSessionId: record.sourceSessionId,
      sourceServerId: record.sourceServerId,
      targetSessionId: record.destinationSessionId,
      targetServerId: record.destinationServerId,
      trust: "local-authenticated",
      receiptId: record.receipt?.id,
      launchId: record.sourceLaunchId ?? undefined,
      observedAt: record.createdAt,
    });
  }
  private creatorWithinTransaction(
    producer: string,
    sourceKey: string,
    input: {
      sourceSessionId: string;
      sourceServerId: string;
      targetSessionId: string;
      targetServerId: string;
      trust: "local-authenticated" | "peer-attested";
      receiptId?: string;
      launchId?: string;
      observedAt: string;
    },
  ): void {
    if (
      !isYaSessionId(input.sourceSessionId) ||
      !isYaSessionId(input.targetSessionId) ||
      (input.sourceSessionId === input.targetSessionId &&
        input.sourceServerId === input.targetServerId)
    )
      return;
    const fact: RelationshipFact = {
      type: "created_session",
      source: this.session(input.sourceSessionId, input.sourceServerId),
      target: this.session(input.targetSessionId, input.targetServerId),
      recordKey: "creator",
      trust: input.trust,
      metadata: { receiptId: input.receiptId, launchId: input.launchId },
    };
    const version = createHash("sha256")
      .update(JSON.stringify(fact))
      .digest("hex");
    const previous = this.index.checkpoint(producer, sourceKey);
    if (previous?.sourceVersion === version) return;
    this.index.publishWithinTransaction({
      observation: {
        producer,
        sourceKey,
        sourceVersion: version,
        extractorVersion: 1,
        observedAt: input.observedAt,
      },
      expectedRevision: previous?.revision ?? null,
      facts: [fact],
      progress: { state: "complete", cursor: "{}" },
      replaceSource: true,
    });
  }
  dispose(): void {
    this.admissionReceipt?.finalize();
    this.store?.dispose();
    if (owners.get(this.database) === this) owners.delete(this.database);
  }
}
