import { createHash } from "node:crypto";
import {
  nativeSessionRef,
  parseNativeSessionId,
  parseYaSessionId,
  type NativeSessionRef,
} from "@yep-anywhere/shared";
import type { SqliteDatabase } from "../storage/sqlite.js";

export const SESSION_RELATIONSHIP_TYPES = [
  "created_session",
  "provider_child",
  "forked_from",
  "cloned_from",
  "derived_from",
  "aside_of",
  "continued_from",
  "launched_harness",
] as const;
export type SessionRelationshipType =
  (typeof SESSION_RELATIONSHIP_TYPES)[number];

/** Internal references only. Native storage scopes must never enter wire views. */
export type RelationshipResource =
  | { kind: "session"; serverId: string; sessionId: string }
  | { kind: "native"; serverId: string; native: NativeSessionRef };
export type RelationshipTrust =
  | "local-authenticated"
  | "peer-attested"
  | "provider-observed"
  | "command-observed";

/** Small display/anchor facts, never prompts, tool output or credentials. */
export interface RelationshipMetadata {
  title?: string;
  agentType?: string;
  toolUseId?: string;
  spawnDepth?: number;
  receiptId?: string;
  launchId?: string;
  boundaryId?: string;
}
export interface RelationshipFact {
  type: SessionRelationshipType;
  source: RelationshipResource;
  target: RelationshipResource;
  recordKey: string;
  trust: RelationshipTrust;
  metadata?: RelationshipMetadata;
}
export interface RelationshipObservation {
  producer: string;
  sourceKey: string;
  sourceVersion: string;
  extractorVersion: number;
  observedAt: string;
}
export interface RelationshipCheckpoint {
  revision: number;
  sourceVersion: string;
  extractorVersion: number;
  state: "partial" | "complete";
  /** Adapter-owned bounded progress, including unresolved launch ids if needed. */
  cursor: string;
}
export interface StoredRelationship {
  id: string;
  type: SessionRelationshipType;
  source: RelationshipResource;
  target: RelationshipResource;
}
export interface RelationshipEvidence extends RelationshipObservation {
  recordKey: string;
  trust: RelationshipTrust;
  state: "active" | "superseded" | "retracted";
  metadata: RelationshipMetadata;
}
interface EdgeRow {
  id: string;
  type: SessionRelationshipType;
  source: string;
  target: string;
}
interface CheckpointRow {
  revision: number;
  source_version: string;
  extractor_version: number;
  state: "partial" | "complete";
  cursor: string;
}

function bounded(value: string, max: number): string {
  if (
    !value ||
    value.length > max ||
    [...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
    throw new Error("Invalid relationship key");
  return value;
}

/** Tuple encoding avoids delimiter collisions; no parallel identity registry. */
export function relationshipResourceKey(
  resource: RelationshipResource,
): string {
  const server = bounded(resource.serverId, 512);
  if (resource.kind === "session")
    return JSON.stringify([
      "session",
      server,
      parseYaSessionId(resource.sessionId),
    ]);
  const native = nativeSessionRef(
    resource.native.family,
    resource.native.storageScope,
    parseNativeSessionId(resource.native.id),
  );
  return JSON.stringify([
    "native",
    server,
    native.family,
    native.storageScope,
    native.id,
  ]);
}
function decodeResource(key: string): RelationshipResource {
  const parts = JSON.parse(key) as string[];
  return parts[0] === "session"
    ? { kind: "session", serverId: parts[1]!, sessionId: parts[2]! }
    : {
        kind: "native",
        serverId: parts[1]!,
        native: nativeSessionRef(
          parts[2] as NativeSessionRef["family"],
          parts[3]!,
          parseNativeSessionId(parts[4]),
        ),
      };
}
function metadataJson(metadata: RelationshipMetadata = {}): string {
  const result: RelationshipMetadata = {};
  for (const field of [
    "title",
    "agentType",
    "toolUseId",
    "receiptId",
    "launchId",
    "boundaryId",
  ] as const) {
    const value = metadata[field];
    if (value !== undefined) {
      if (typeof value !== "string" || value.length > 1024)
        throw new Error("Invalid relationship metadata");
      result[field] = value;
    }
  }
  if (metadata.spawnDepth !== undefined) {
    if (!Number.isSafeInteger(metadata.spawnDepth) || metadata.spawnDepth < 0)
      throw new Error("Invalid relationship spawn depth");
    result.spawnDepth = metadata.spawnDepth;
  }
  return JSON.stringify(result);
}

/**
 * Internal projection store: callers own evidence authority and endpoint access.
 * Statements are prepared once and finalized by dispose. No process-wide maps.
 */
export class SessionRelationshipStore {
  private readonly insertEdge;
  private readonly insertEvidence;
  private readonly refreshEvidence;
  private readonly retireSource;
  private readonly checkpointRow;
  private readonly writeCheckpoint;
  private readonly outgoing;
  private readonly incoming;
  private readonly outgoingType;
  private readonly incomingType;
  private readonly evidenceRows;
  private disposed = false;

  constructor(private readonly database: SqliteDatabase) {
    this.insertEdge = database.prepare(
      "INSERT INTO session_relationship_edges(id, type, source, target) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
    );
    const insert = `INSERT INTO session_relationship_evidence(producer, source_key, record_key, source_version, extractor_version, edge_id, trust, state, metadata, observed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
       ON CONFLICT(producer, source_key, record_key, edge_id)`;
    // Immutable owner/outbox replay never revives superseded or retracted facts.
    // A matched replay reports a positive change count; a trust conflict is zero.
    this.insertEvidence = database.prepare(`${insert}
       DO UPDATE SET trust = excluded.trust WHERE trust = excluded.trust`);
    this.refreshEvidence = database.prepare(`${insert}
       DO UPDATE SET state = 'active', metadata = excluded.metadata, observed_at = excluded.observed_at,
       source_version = excluded.source_version, extractor_version = excluded.extractor_version
       WHERE trust = excluded.trust`);
    this.retireSource = database.prepare(
      `UPDATE session_relationship_evidence SET state = 'superseded'
       WHERE producer = ? AND source_key = ? AND state = 'active'
       AND (source_version != ? OR extractor_version != ?)`,
    );
    this.checkpointRow = database.prepare(
      "SELECT revision, source_version, extractor_version, state, cursor FROM session_relationship_checkpoints WHERE producer = ? AND source_key = ?",
    );
    this.writeCheckpoint = database.prepare(
      `INSERT INTO session_relationship_checkpoints(producer, source_key, revision, source_version, extractor_version, state, cursor) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(producer, source_key) DO UPDATE SET revision = excluded.revision, source_version = excluded.source_version, extractor_version = excluded.extractor_version, state = excluded.state, cursor = excluded.cursor`,
    );
    // Fixed, indexed SQL variants avoid scanning other types or inactive edges.
    const page = (endpoint: "source" | "target", typed: boolean) =>
      database.prepare(
        `SELECT id, type, source, target FROM session_relationship_edges
       WHERE active = 1 AND ${endpoint} = ? AND id > ? ${typed ? "AND type = ?" : ""}
       ORDER BY id LIMIT ?`,
      );
    this.outgoing = page("source", false);
    this.incoming = page("target", false);
    this.outgoingType = page("source", true);
    this.incomingType = page("target", true);
    this.evidenceRows = database.prepare(
      `SELECT * FROM session_relationship_evidence WHERE edge_id = ? AND (? = 1 OR state = 'active')
       ORDER BY producer, source_key, record_key LIMIT ?`,
    );
  }

  checkpoint(
    producer: string,
    sourceKey: string,
  ): RelationshipCheckpoint | null {
    const row = this.checkpointRow.get<CheckpointRow>(producer, sourceKey);
    return row
      ? {
          revision: row.revision,
          sourceVersion: row.source_version,
          extractorVersion: row.extractor_version,
          state: row.state,
          cursor: row.cursor,
        }
      : null;
  }

  /** Owner must already hold the profile transaction (e.g. common admission). */
  recordWithinTransaction(
    observation: RelationshipObservation,
    facts: readonly RelationshipFact[],
  ): void {
    this.writeFacts(observation, facts, false);
  }

  private writeFacts(
    observation: RelationshipObservation,
    facts: readonly RelationshipFact[],
    refresh: boolean,
  ): void {
    bounded(observation.producer, 128);
    bounded(observation.sourceKey, 8192);
    bounded(observation.sourceVersion, 2048);
    if (
      !Number.isSafeInteger(observation.extractorVersion) ||
      observation.extractorVersion < 1 ||
      !Number.isFinite(Date.parse(observation.observedAt)) ||
      facts.length > 1000
    )
      throw new Error("Invalid relationship observation");
    for (const fact of facts) {
      if (!SESSION_RELATIONSHIP_TYPES.includes(fact.type))
        throw new Error("Unknown relationship type");
      const source = relationshipResourceKey(fact.source);
      const target = relationshipResourceKey(fact.target);
      if (source === target)
        throw new Error("Reflexive relationship is invalid");
      const id = createHash("sha256")
        .update(JSON.stringify([fact.type, source, target]))
        .digest("hex");
      const record = bounded(fact.recordKey, 2048);
      const metadata = metadataJson(fact.metadata);
      this.insertEdge.run(id, fact.type, source, target);
      const written = (
        refresh ? this.refreshEvidence : this.insertEvidence
      ).run(
        observation.producer,
        observation.sourceKey,
        record,
        observation.sourceVersion,
        observation.extractorVersion,
        id,
        fact.trust,
        metadata,
        observation.observedAt,
      );
      // Bun includes trigger writes in this count; only zero means rejection.
      if (written.changes === 0)
        throw new Error("Conflicting relationship evidence trust");
    }
  }

  /** Immutable owner/outbox facts. Reconciliation of this source must use publish. */
  record(
    observation: RelationshipObservation,
    facts: readonly RelationshipFact[],
  ): void {
    this.database.transaction(() =>
      this.recordWithinTransaction(observation, facts),
    );
  }

  /**
   * Compare-and-publish prevents a stale async extractor from replacing newer
   * accepted work. Checkpoints and facts commit together, including known empty.
   * A failed/missing source is never passed as an authoritative replacement.
   */
  publish(input: {
    observation: RelationshipObservation;
    expectedRevision: number | null;
    facts: readonly RelationshipFact[];
    progress: Pick<RelationshipCheckpoint, "state" | "cursor">;
    replaceSource?: boolean;
  }): boolean {
    return this.database.transaction(() => {
      const { observation, progress } = input;
      const previous = this.checkpoint(
        observation.producer,
        observation.sourceKey,
      );
      if ((previous?.revision ?? null) !== input.expectedRevision) return false;
      if (
        progress.cursor.length > 65536 ||
        !["partial", "complete"].includes(progress.state)
      )
        throw new Error("Invalid relationship progress");
      this.writeFacts(observation, input.facts, true);
      // A partial replacement retains the previous accepted set. Re-observed
      // records are marked with this version; completion sweeps only the rest.
      if (input.replaceSource && progress.state === "complete")
        this.retireSource.run(
          observation.producer,
          observation.sourceKey,
          observation.sourceVersion,
          observation.extractorVersion,
        );
      this.writeCheckpoint.run(
        observation.producer,
        observation.sourceKey,
        (previous?.revision ?? 0) + 1,
        observation.sourceVersion,
        observation.extractorVersion,
        progress.state,
        progress.cursor,
      );
      return true;
    });
  }

  list(input: {
    resource: RelationshipResource;
    direction?: "incoming" | "outgoing" | "both";
    type?: SessionRelationshipType;
    after?: string;
    limit?: number;
  }): { edges: StoredRelationship[]; next: string | null } {
    const key = relationshipResourceKey(input.resource);
    const direction = input.direction ?? "both";
    const limit = pageLimit(input.limit);
    const parameters = [
      key,
      input.after ?? "",
      ...(input.type ? [input.type] : []),
      limit + 1,
    ];
    const outgoing = input.type ? this.outgoingType : this.outgoing;
    const incoming = input.type ? this.incomingType : this.incoming;
    const selected = [
      ...(direction === "incoming" ? [] : outgoing.all<EdgeRow>(...parameters)),
      ...(direction === "outgoing" ? [] : incoming.all<EdgeRow>(...parameters)),
    ];
    const rows = [
      ...new Map(selected.map((row) => [row.id, row])).values(),
    ].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return {
      edges: rows.slice(0, limit).map((row) => ({
        id: row.id,
        type: row.type,
        source: decodeResource(row.source),
        target: decodeResource(row.target),
      })),
      next: rows.length > limit ? rows[limit - 1]!.id : null,
    };
  }

  evidence(
    edgeId: string,
    options: { history?: boolean; limit?: number } = {},
  ): RelationshipEvidence[] {
    return this.evidenceRows
      .all<{
        producer: string;
        source_key: string;
        record_key: string;
        source_version: string;
        extractor_version: number;
        trust: RelationshipTrust;
        state: RelationshipEvidence["state"];
        metadata: string;
        observed_at: string;
      }>(edgeId, options.history ? 1 : 0, pageLimit(options.limit))
      .map((row) => ({
        producer: row.producer,
        sourceKey: row.source_key,
        recordKey: row.record_key,
        sourceVersion: row.source_version,
        extractorVersion: row.extractor_version,
        observedAt: row.observed_at,
        trust: row.trust,
        state: row.state,
        metadata: JSON.parse(row.metadata) as RelationshipMetadata,
      }));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const statement of [
      this.insertEdge,
      this.insertEvidence,
      this.refreshEvidence,
      this.retireSource,
      this.checkpointRow,
      this.writeCheckpoint,
      this.outgoing,
      this.incoming,
      this.outgoingType,
      this.incomingType,
      this.evidenceRows,
    ])
      statement.finalize();
  }
}

function pageLimit(value = 50): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 200)
    throw new Error("Relationship page limit must be between 1 and 200");
  return value;
}
