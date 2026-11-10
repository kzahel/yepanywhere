import { CollectionMetadataChanges } from "./collection-metadata-changes.js";
/**
 * Session metadata rows (plan 189 step 6, migration 031). Queried fields are
 * columns; the rest of the object is JSON in `extra`. A key whose value has
 * the wrong type, or a string SQLite cannot store exactly (a lone surrogate
 * or a NUL), stays in `extra`, which wins over its column on read. Booleans
 * are stored as 0 and 1. Encoding is deterministic, so a loaded object
 * encodes back to the stored row and is never rewritten for nothing.
 */
import type { SqliteDatabase, SqliteStatement } from "../storage/sqlite.js";
import type { SessionMetadata } from "./SessionMetadataService.js";

/** `[key, column, kind]` in table order; `initial_prompt` is stored last. */
const COLUMNS = [
  ["provider", "provider", "text"],
  ["workingProjectId", "working_project_id", "text"],
  ["isArchived", "is_archived", "boolean"],
  ["isStarred", "is_starred", "boolean"],
  ["customTitle", "custom_title", "text"],
  ["sidebarCategory", "sidebar_category", "text"],
  ["parentSessionId", "parent_session_id", "text"],
  ["parentSessionKind", "parent_session_kind", "text"],
  ["forkedFromSessionId", "forked_from_session_id", "text"],
  ["executor", "executor", "text"],
  ["sandboxLevel", "sandbox_level", "text"],
  ["initialPrompt", "initial_prompt", "text"],
] as const satisfies readonly (readonly [
  keyof SessionMetadata,
  string,
  "text" | "boolean",
])[];

type Value = string | number | null;
/** The stored form: one value per column, then `extra`. */
export type EncodedMetadata = Value[];

const NAMES = [...COLUMNS.map(([, column]) => column), "extra"].join(", ");
const exact = (value: string) =>
  !value.includes("\0") &&
  (value as unknown as { isWellFormed(): boolean }).isWellFormed();
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function encodeMetadata(metadata: SessionMetadata): EncodedMetadata {
  if (!isRecord(metadata))
    return [...COLUMNS.map(() => null), JSON.stringify(metadata)];
  const rest: Record<string, unknown> = { ...metadata };
  const values = COLUMNS.map(([key, , kind]): Value => {
    const value = rest[key];
    if (
      kind === "boolean"
        ? typeof value !== "boolean"
        : typeof value !== "string" || !exact(value)
    )
      return null;
    delete rest[key];
    return typeof value === "boolean" ? Number(value) : (value as string);
  });
  return [...values, JSON.stringify(rest)];
}

/** Conservative string payload charge plus a fixed per-object allowance. */
export function encodedMetadataBytes(
  id: string,
  encoded: readonly Value[],
): number {
  return (
    id.length * 2 +
    512 +
    encoded.reduce<number>(
      (size, value) =>
        size + (typeof value === "string" ? value.length * 2 : 8),
      0,
    )
  );
}

/** Rebuild the object: `extra` first, then column keys `extra` lacks. */
export function decodeMetadata(row: Record<string, unknown>): SessionMetadata {
  const metadata = JSON.parse(row.extra as string) as unknown;
  if (!isRecord(metadata)) return metadata as SessionMetadata;
  for (const [key, column, kind] of COLUMNS) {
    const value = row[column];
    if (value === null || value === undefined || Object.hasOwn(metadata, key))
      continue;
    metadata[key] = kind === "boolean" ? Number(value) !== 0 : value;
  }
  return metadata as SessionMetadata;
}

/**
 * Sessions whose in-memory metadata is not committed yet (undefined when
 * deleted). Queries skip their stored rows and answer them from memory.
 */
export type PendingMetadata = ReadonlyMap<string, SessionMetadata | undefined>;
export interface MetadataCounts {
  sessions: number;
  starred: number;
  archived: number;
}
const idsOf = (pending: PendingMetadata) => JSON.stringify([...pending.keys()]);

/** Point queries; each repeats its partial index's condition exactly. */
export const METADATA_QUERIES = {
  sandboxed: `SELECT session_id FROM session_metadata WHERE sandbox_level = 'project-write'
   AND session_id NOT IN (SELECT value FROM json_each(?))`,
  providers: `SELECT DISTINCT provider FROM session_metadata WHERE provider IS NOT NULL
   AND session_id NOT IN (SELECT value FROM json_each(?))`,
  hasProvider: `SELECT 1 AS found FROM session_metadata WHERE provider = ?
   AND session_id NOT IN (SELECT value FROM json_each(?)) LIMIT 1`,
} as const;

const same = (left: readonly Value[], right: readonly Value[]) =>
  left.length === right.length &&
  left.every((value, index) => value === right[index]);

/**
 * Statements over `session_metadata`. Point queries use the indexed columns
 * and repeat each partial index's condition exactly (gap item 3).
 */
export class SessionMetadataRows {
  private readonly changes = new CollectionMetadataChanges();
  private overlayRevision = 0;
  pendingChanged(sessionId: string): void {
    this.overlayRevision++;
    this.changes.publish(sessionId);
  }
  collectionState(pending: PendingMetadata) {
    return {
      pending,
      overlayRevision: this.overlayRevision,
      subscribe: this.changes.subscribe,
    };
  }
  /** Fixed SQL vocabulary: point, batch and three feature query shapes. */
  readonly #statements = new Map<string, SqliteStatement>();
  constructor(private readonly database: SqliteDatabase) {}

  #prepare(sql: string): SqliteStatement {
    let statement = this.#statements.get(sql);
    if (!statement) {
      statement = this.database.prepare(sql);
      this.#statements.set(sql, statement);
    }
    return statement;
  }

  all(): Array<[string, SessionMetadata]> {
    return this.#prepare(`SELECT session_id, ${NAMES} FROM session_metadata`)
      .all<Record<string, unknown>>()
      .map((row): [string, SessionMetadata] => [
        row.session_id as string,
        decodeMetadata(row),
      ]);
  }

  read(sessionId: string) {
    const row = this.#prepare(
      `SELECT ${NAMES} FROM session_metadata WHERE session_id = ?`,
    ).get<Record<string, Value>>(sessionId);
    return {
      value: row ? decodeMetadata(row) : undefined,
      bytes: encodedMetadataBytes(sessionId, row ? Object.values(row) : []),
    };
  }

  readBatch(ids: readonly string[]) {
    return new Map(
      this.#prepare(
        `SELECT session_id, ${NAMES} FROM session_metadata WHERE session_id IN (SELECT value FROM json_each(?))`,
      )
        .all<Record<string, Value>>(JSON.stringify(ids))
        .map((row) => {
          const { session_id: id, ...columns } = row;
          return [
            id as string,
            {
              value: decodeMetadata(columns),
              bytes: encodedMetadataBytes(id as string, Object.values(columns)),
            },
          ];
        }),
    );
  }

  /** Feature views only decode matching owners; never populate the clean cache. */
  featureRows(
    feature: "display" | "billing",
    pending: PendingMetadata,
  ): Array<[string, SessionMetadata]> {
    const path =
      feature === "display"
        ? "transcriptDisplayObjects"
        : "cacheMissBillingEvents";
    const stored = this.#prepare(
      `SELECT session_id, extra, working_project_id FROM session_metadata WHERE CASE WHEN json_valid(extra) THEN json_array_length(extra, '$.${path}') ELSE 0 END > 0
       AND session_id NOT IN (SELECT value FROM json_each(?))`,
    )
      .all<Record<string, unknown>>(idsOf(pending))
      .map((row): [string, SessionMetadata] => [
        row.session_id as string,
        decodeMetadata(row),
      ]);
    return [
      ...stored,
      ...[...pending].filter(
        (entry): entry is [string, SessionMetadata] => entry[1] !== undefined,
      ),
    ];
  }

  runningClearloops(pending: PendingMetadata): string[] {
    return [
      ...this.#prepare(`SELECT session_id FROM session_metadata WHERE CASE WHEN json_valid(extra) THEN json_extract(extra, '$.clearloop.state') END = 'running'
        AND session_id NOT IN (SELECT value FROM json_each(?))`)
        .all<{ session_id: string }>(idsOf(pending))
        .map((row) => row.session_id),
      ...[...pending]
        .filter(([, value]) => value?.clearloop?.state === "running")
        .map(([id]) => id),
    ];
  }

  interruptedDisplays(): Array<[string, SessionMetadata]> {
    return this.#prepare(`SELECT session_id, ${NAMES} FROM session_metadata m
      WHERE CASE WHEN json_valid(extra) THEN json_array_length(extra, '$.transcriptDisplayObjects') ELSE 0 END > 0 AND EXISTS (
        SELECT 1 FROM json_each(CASE WHEN json_valid(m.extra) THEN m.extra ELSE '{}' END, '$.transcriptDisplayObjects')
        WHERE json_extract(CASE WHEN type='object' THEN value ELSE '{}' END, '$.status') = 'generating'
          OR (json_extract(CASE WHEN type='object' THEN value ELSE '{}' END, '$.kind') = 'bang-command'
            AND json_extract(CASE WHEN type='object' THEN value ELSE '{}' END, '$.status') = 'running'))`)
      .all<Record<string, unknown>>()
      .map((row): [string, SessionMetadata] => [
        row.session_id as string,
        decodeMetadata(row),
      ]);
  }

  /** The stored row, encoded, or undefined when there is none. */
  stored(sessionId: string): EncodedMetadata | undefined {
    const row = this.#prepare(
      `SELECT ${NAMES} FROM session_metadata WHERE session_id = ?`,
    ).get<Record<string, Value>>(sessionId);
    return row ? Object.values(row) : undefined;
  }

  /** Whether the stored row already holds this encoding. */
  matches(sessionId: string, encoded: EncodedMetadata): boolean {
    const stored = this.stored(sessionId);
    return stored !== undefined && same(stored, encoded);
  }

  write(sessionId: string, encoded: EncodedMetadata): void {
    this.#prepare(
      `INSERT INTO session_metadata (session_id, ${NAMES}) VALUES (?${", ?".repeat(COLUMNS.length + 1)})
       ON CONFLICT (session_id) DO UPDATE SET ${[...COLUMNS.map(([, column]) => column), "extra"].map((column) => `${column} = excluded.${column}`).join(", ")}`,
    ).run(sessionId, ...encoded);
    this.changes.publish(sessionId);
  }

  remove(sessionId: string): void {
    this.#prepare("DELETE FROM session_metadata WHERE session_id = ?").run(
      sessionId,
    );
    this.changes.publish(sessionId);
  }

  /** Sessions launched with a `project-write` sandbox. */
  sandboxedSessionIds(pending: PendingMetadata): string[] {
    const stored = this.#prepare(METADATA_QUERIES.sandboxed).all<{
      session_id: string;
    }>(idsOf(pending));
    // Sorted, so a pending save does not reorder the sandbox roots (their
    // order is part of the reader cache key).
    return [
      ...stored.map((row) => row.session_id),
      ...[...pending]
        .filter(([, metadata]) => metadata?.sandboxLevel === "project-write")
        .map(([id]) => id),
    ].sort();
  }

  /** Distinct recorded providers. */
  providers(pending: PendingMetadata): string[] {
    const stored = this.#prepare(METADATA_QUERIES.providers).all<{
      provider: string;
    }>(idsOf(pending));
    // An empty provider was never a recorded one (the old scan was truthy).
    const providers = new Set(
      stored.map((row) => row.provider).filter(Boolean),
    );
    for (const metadata of pending.values())
      if (metadata?.provider) providers.add(metadata.provider);
    return [...providers];
  }

  /** Whether any session recorded this provider. */
  hasProvider(provider: string, pending: PendingMetadata): boolean {
    for (const metadata of pending.values())
      if (metadata?.provider === provider) return true;
    return (
      this.#prepare(METADATA_QUERIES.hasProvider).get(
        provider,
        idsOf(pending),
      ) !== undefined
    );
  }

  /** Diagnostics only: a scan of the narrow columns, not an indexed query. */
  counts(pending: PendingMetadata): MetadataCounts {
    const row = this.#prepare(
      `SELECT count(*) AS sessions, count(CASE WHEN is_starred = 1 THEN 1 END) AS starred,
       count(CASE WHEN is_archived = 1 THEN 1 END) AS archived FROM session_metadata
       WHERE session_id NOT IN (SELECT value FROM json_each(?))`,
    ).get<Record<keyof MetadataCounts, number>>(idsOf(pending));
    const counts = {
      sessions: Number(row?.sessions ?? 0),
      starred: Number(row?.starred ?? 0),
      archived: Number(row?.archived ?? 0),
    };
    for (const metadata of pending.values()) {
      if (!metadata) continue;
      counts.sessions += 1;
      if (metadata.isStarred) counts.starred += 1;
      if (metadata.isArchived) counts.archived += 1;
    }
    return counts;
  }

  dispose(): void {
    for (const statement of this.#statements.values()) statement.finalize();
    this.#statements.clear();
  }
}

/**
 * Every stored metadata object, for scripts that read a profile without
 * starting the server. Reads either layout, so a profile the upgraded server
 * has not migrated yet still reads.
 */
export function readStoredMetadata(
  database: SqliteDatabase,
): Map<string, SessionMetadata> {
  const columns = database
    .prepare("SELECT name FROM pragma_table_info('session_metadata')")
    .all<{ name: string }>()
    .map((row) => row.name);
  if (columns.includes("extra")) {
    const rows = new SessionMetadataRows(database);
    try {
      return new Map(rows.all());
    } finally {
      rows.dispose();
    }
  }
  return new Map(
    database
      .prepare("SELECT session_id, metadata FROM session_metadata")
      .all<{ session_id: string; metadata: string }>()
      .map((row) => [row.session_id, JSON.parse(row.metadata)]),
  );
}
