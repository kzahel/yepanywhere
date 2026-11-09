import { isYaSessionId } from "@yep-anywhere/shared";
import type { SqliteDatabase, SqliteStatement } from "../storage/sqlite.js";
import { runOutsideRequestContext } from "../lib/outsideRequestContext.js";
import type { SessionMetadata } from "../metadata/SessionMetadataService.js";
import {
  type CreationRelationshipSource,
  type ReceiptRelationshipSource,
  type OutboundRelationshipSource,
  type SessionRelationshipWriter,
  receiptRelationshipJson,
} from "./SessionRelationshipWriter.js";

const PRODUCER = "ya-relationship-reconciliation-v1";
const SOURCE = "profile";
const BATCH = 100;
const tables = [
  "session_creations",
  "session_metadata",
  "agent_api_receipts",
  "peer_api_outbound",
] as const;
// Project only relationship fields: saved prompt bodies, credential ids and
// proof material never leave SQLite for reconciliation or enter graph rows.
const keys = ["id", "session_id", "id", "id"] as const;
const projections = [
  `json_object('id', id, 'sessionId', session_id, 'createdAt', created_at,
    'nativeReceiptId', CASE WHEN owner_key = 'superuser' AND request_key = initial_input_id
      AND initial_input_id = json_extract(payload_json, '$.input.nativeReceiptId') THEN initial_input_id ELSE NULL END,
    'copy', CASE WHEN json_extract(payload_json, '$.copy.kind') IN ('fork', 'clone')
      THEN json_object('kind', json_extract(payload_json, '$.copy.kind'),
        'sourceSessionId', json_extract(payload_json, '$.copy.sourceSessionId'),
        'upToMessageId', json_extract(payload_json, '$.copy.upToMessageId'),
        'boundary', json_object('kind', json_extract(payload_json, '$.copy.boundary.kind'),
          'messageId', json_extract(payload_json, '$.copy.boundary.messageId'),
          'turnId', json_extract(payload_json, '$.copy.boundary.turnId'),
          'entryId', json_extract(payload_json, '$.copy.boundary.entryId'))) ELSE NULL END,
    'lineage', json_object('asideOf', json_extract(payload_json, '$.lineage.asideOf'),
      'continuedFrom', json_extract(payload_json, '$.lineage.continuedFrom')))`,
  // A value stays in `extra` when its column could not hold it (migration 031).
  // No writer stores a key in both; the column is checked first here.
  `json_object('sessionId', session_id,
    'parentSessionId', coalesce(parent_session_id, json_extract(extra, '$.parentSessionId')),
    'parentSessionKind', coalesce(parent_session_kind, json_extract(extra, '$.parentSessionKind')),
    'forkedFromSessionId', coalesce(forked_from_session_id, json_extract(extra, '$.forkedFromSessionId')))`,
  receiptRelationshipJson,
  `json_object('id', id, 'operation', json_extract(record_json, '$.operation'),
    'state', json_extract(record_json, '$.state'),
    'sourceSessionId', source_session_id, 'destinationServerId', destination_server_id,
    'sourceServerId', json_extract(record_json, '$.sourceServerId'),
    'destinationSessionId', json_extract(record_json, '$.destinationSessionId'),
    'sourceLaunchId', json_extract(record_json, '$.sourceLaunchId'),
    'createdAt', json_extract(record_json, '$.createdAt'),
    'receipt', json_object('id', json_extract(record_json, '$.receipt.id')))`,
] as const;
interface Cursor {
  phase: number;
  through: string;
  high: string | null;
}
interface Row {
  position: string;
  high: string;
  source: string;
}

/**
 * Finite upgrade/restart work, independent of request delivery. Each source
 * batch and progress commit in one owner transaction. New/updated rows already
 * participate in their source transactions, so a frozen primary-key frontier is safe.
 * No timer, native corpus scan, provider effects or new launch journal.
 */
export function reconcileSessionRelationships(
  database: SqliteDatabase,
  writer: SessionRelationshipWriter,
  signal: AbortSignal,
  resolveAlias: (id: string) => string = (id) => id,
): Promise<void> {
  writer.assertProfileConnection(database);
  const resolveId = (id: string) => (isYaSessionId(id) ? resolveAlias(id) : id);
  return runOutsideRequestContext(async () => {
    const statements: SqliteStatement[] = [];
    try {
      while (!signal.aborted) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (signal.aborted) return;
        const more = database.transaction(() => {
          const previous = writer.index.checkpoint(PRODUCER, SOURCE);
          if (previous?.state === "complete") return false;
          const cursor: Cursor = previous
            ? JSON.parse(previous.cursor)
            : { phase: 0, through: "", high: null };
          if (
            !Number.isInteger(cursor.phase) ||
            cursor.phase < 0 ||
            cursor.phase >= tables.length ||
            typeof cursor.through !== "string" ||
            (cursor.high !== null && typeof cursor.high !== "string")
          )
            throw new Error("Invalid relationship reconciliation progress");
          const phase = cursor.phase;
          const table = tables[phase]!;
          const key = keys[phase]!;
          statements[phase] ??= database.prepare(
            `SELECT ${key} AS position, (SELECT COALESCE(MAX(${key}), '') FROM ${table}) AS high,
              ${projections[phase]} AS source FROM ${table}
             WHERE ${key} > ? AND ${key} <= COALESCE(?, (SELECT COALESCE(MAX(${key}), '') FROM ${table})) ORDER BY ${key} LIMIT ${BATCH}`,
          );
          const statement = statements[phase]!;
          const rows = statement.all<Row>(cursor.through, cursor.high);
          for (const row of rows) {
            const source = JSON.parse(row.source);
            switch (phase) {
              case 0:
                writer.creationWithinTransaction(
                  {
                    ...source,
                    sessionId: resolveId(source.sessionId),
                    ...(source.copy
                      ? {
                          copy: {
                            ...source.copy,
                            sourceSessionId: resolveId(
                              source.copy.sourceSessionId,
                            ),
                          },
                        }
                      : {}),
                    lineage: {
                      asideOf: source.lineage?.asideOf
                        ? resolveId(source.lineage.asideOf)
                        : undefined,
                      continuedFrom: source.lineage?.continuedFrom
                        ? resolveId(source.lineage.continuedFrom)
                        : undefined,
                    },
                  } as CreationRelationshipSource,
                  resolveId,
                );
                break;
              case 1:
                writer.metadataWithinTransaction(resolveId(source.sessionId), {
                  ...source,
                  parentSessionId: source.parentSessionId
                    ? resolveId(source.parentSessionId)
                    : undefined,
                  forkedFromSessionId: source.forkedFromSessionId
                    ? resolveId(source.forkedFromSessionId)
                    : undefined,
                } as SessionMetadata);
                break;
              case 2:
                writer.receiptWithinTransaction(
                  source as ReceiptRelationshipSource,
                  resolveId,
                );
                break;
              case 3:
                writer.outboundWithinTransaction({
                  ...source,
                  sourceSessionId: source.sourceSessionId
                    ? resolveId(source.sourceSessionId)
                    : null,
                } as OutboundRelationshipSource);
                break;
            }
          }
          const done =
            rows.length < BATCH ||
            // Range/order belongs to SQLite's collation, not JS UTF-16 order.
            rows.at(-1)!.position === (cursor.high ?? rows[0]!.high);
          const next: Cursor = done
            ? { phase: phase + 1, through: "", high: null }
            : {
                phase,
                through: rows.at(-1)!.position,
                high: cursor.high ?? rows[0]!.high,
              };
          const complete = next.phase === tables.length;
          const accepted = writer.index.publishWithinTransaction({
            observation: {
              producer: PRODUCER,
              sourceKey: SOURCE,
              sourceVersion: "1",
              extractorVersion: 1,
              observedAt: new Date().toISOString(),
            },
            expectedRevision: previous?.revision ?? null,
            facts: [],
            progress: {
              state: complete ? "complete" : "partial",
              cursor: JSON.stringify(next),
            },
          });
          if (!accepted)
            throw new Error(
              "Relationship reconciliation lost its transaction fence",
            );
          return !complete;
        });
        if (!more) return;
      }
    } finally {
      for (const statement of statements) statement?.finalize();
    }
  });
}
