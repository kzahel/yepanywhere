import { createHash } from "node:crypto";
import type { ProviderName, UrlProjectId } from "@yep-anywhere/shared";
import type {
  SessionCatalogLocation,
  SessionCatalogRow,
} from "../sessions/catalog-types.js";
import type { ProviderCatalogFamily } from "../sessions/provider-catalog-family.js";
import type { SqliteDatabase, SqliteStatement } from "../storage/sqlite.js";
import { withWellFormedTitle } from "./session-catalog-rows.js";

/**
 * Title characters kept in the catalog row itself. The rest of a longer title
 * lives in `session_catalog_text`, so list queries never read it. This covers
 * the prefix the shared display title is sanitized from (2 × 120 + 64).
 */
export const CATALOG_TITLE_PREFIX_LENGTH = 512;

export interface SessionCatalogSqliteState {
  epoch: string;
  generation: number;
  tombstoneHorizon: number;
  completedAt: string;
}

export interface SessionCatalogSqliteSource {
  catalogFamily: ProviderCatalogFamily;
  storeKey: string;
}

export interface SessionCatalogSqliteWrite {
  rowsWritten: number;
  rowsTombstoned: number;
  /** True when the previous lineage was dropped rather than diffed. */
  lineageReplaced: boolean;
}

interface CatalogColumns {
  id: number;
  family: string;
  store_key: string;
  native_id: string;
  native_storage_scope: string | null;
  native_directory_project_id: string | null;
  project_key: string;
  project_id: string;
  project_path: string;
  project_name: string | null;
  provider: string | null;
  title: string | null;
  title_null: number;
  full_title: string | null;
  created_at: string | null;
  updated_at: string;
  last_human_turn_at: string | null;
  async_questions: string | null;
  fidelity: SessionCatalogRow["fidelity"];
  row_format: number | null;
  source_version: string;
  location_kind: SessionCatalogLocation["kind"];
  location_path: string | null;
  location_record_id: string | null;
}

const ROW_COLUMNS = `c.id, c.family, c.store_key, c.native_id,
  c.native_storage_scope, c.native_directory_project_id, c.project_key,
  c.project_id, c.project_path, c.project_name, c.provider, c.title,
  c.title_null, t.full_title, c.created_at, c.updated_at,
  c.last_human_turn_at, c.async_questions, c.fidelity, c.row_format,
  c.source_version, c.location_kind, c.location_path, c.location_record_id`;

/**
 * The catalog's rows in `discovery.sqlite` (migration 028). A write diffs the
 * given generation against the stored rows by `row_hash`: an unchanged row is
 * not rewritten, a changed one takes the generation as `changed_gen`, and a
 * row no longer present becomes a tombstone with that generation. Statements
 * are prepared once; the database owns their lifetime.
 */
export class SessionCatalogSqliteStore {
  private readonly selectState;
  private readonly writeState;
  private readonly selectHashes;
  private readonly upsertRow;
  private readonly upsertText;
  private readonly deleteText;
  private readonly tombstone;
  private readonly deleteAllRows;
  private readonly selectSources;
  private readonly insertSource;
  private readonly deleteSource;
  private readonly selectRows;
  private readonly statements: SqliteStatement[] = [];

  constructor(private readonly database: SqliteDatabase) {
    const prepare = (sql: string) => {
      const statement = database.prepare(sql);
      this.statements.push(statement);
      return statement;
    };
    try {
      this.selectState = prepare(STATE_SQL);
      this.writeState = prepare(
        `INSERT INTO catalog_state (id, epoch, generation, tombstone_horizon, completed_at)
         VALUES (1, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET epoch = excluded.epoch,
           generation = excluded.generation,
           tombstone_horizon = excluded.tombstone_horizon,
           completed_at = excluded.completed_at`,
      );
      this.selectHashes = prepare(
        "SELECT id, family, store_key, native_id, row_hash, deleted FROM session_catalog",
      );
      this.upsertRow = prepare(
        `INSERT INTO session_catalog (family, store_key, native_id,
           native_storage_scope, native_directory_project_id, project_key,
           project_id, project_path, project_name, provider, title, title_null,
           created_at, updated_at, last_human_turn_at, async_questions, fidelity,
           row_format, source_version, location_kind, location_path,
           location_record_id, row_hash, changed_gen, deleted)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT(family, store_key, native_id) DO UPDATE SET
           native_storage_scope = excluded.native_storage_scope,
           native_directory_project_id = excluded.native_directory_project_id,
           project_key = excluded.project_key,
           project_id = excluded.project_id,
           project_path = excluded.project_path,
           project_name = excluded.project_name,
           provider = excluded.provider,
           title = excluded.title,
           title_null = excluded.title_null,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at,
           last_human_turn_at = excluded.last_human_turn_at,
           async_questions = excluded.async_questions,
           fidelity = excluded.fidelity,
           row_format = excluded.row_format,
           source_version = excluded.source_version,
           location_kind = excluded.location_kind,
           location_path = excluded.location_path,
           location_record_id = excluded.location_record_id,
           row_hash = excluded.row_hash,
           changed_gen = excluded.changed_gen,
           deleted = 0`,
      );
      this.upsertText = prepare(
        `INSERT INTO session_catalog_text (catalog_id, full_title)
         SELECT id, ? FROM session_catalog
         WHERE family = ? AND store_key = ? AND native_id = ?
         ON CONFLICT(catalog_id) DO UPDATE SET full_title = excluded.full_title`,
      );
      this.deleteText = prepare(
        `DELETE FROM session_catalog_text WHERE catalog_id = (
           SELECT id FROM session_catalog
           WHERE family = ? AND store_key = ? AND native_id = ?)`,
      );
      this.tombstone = prepare(
        "UPDATE session_catalog SET deleted = 1, changed_gen = ? WHERE id = ?",
      );
      this.deleteAllRows = prepare("DELETE FROM session_catalog");
      this.selectSources = prepare(
        "SELECT family, store_key FROM catalog_sources",
      );
      this.insertSource = prepare(
        "INSERT INTO catalog_sources (family, store_key) VALUES (?, ?)",
      );
      this.deleteSource = prepare(
        "DELETE FROM catalog_sources WHERE family = ? AND store_key = ?",
      );
      this.selectRows = prepare(
        `SELECT ${ROW_COLUMNS} FROM session_catalog c
         LEFT JOIN session_catalog_text t ON t.catalog_id = c.id
         WHERE c.deleted = 0 ORDER BY c.id`,
      );
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  readState(): SessionCatalogSqliteState | undefined {
    return stateFromRow(this.selectState.get<StateColumns>());
  }

  /**
   * Store one whole published generation in a single synchronous transaction.
   * A different epoch, or a generation behind the stored one, starts the
   * table over: change readers cannot follow a lineage backwards.
   */
  writeGeneration(
    state: Omit<SessionCatalogSqliteState, "tombstoneHorizon">,
    rows: Iterable<Readonly<SessionCatalogRow>>,
    sources: readonly SessionCatalogSqliteSource[],
  ): SessionCatalogSqliteWrite {
    return this.database.transaction(() => {
      const previous = this.readState();
      const lineageReplaced =
        !previous ||
        previous.epoch !== state.epoch ||
        previous.generation > state.generation;
      if (lineageReplaced) this.deleteAllRows.run();
      const stored = new Map<
        string,
        { id: number; hash: string; deleted: boolean }
      >();
      if (!lineageReplaced) {
        for (const row of this.selectHashes.all<{
          id: number;
          family: string;
          store_key: string;
          native_id: string;
          row_hash: string;
          deleted: number;
        }>()) {
          stored.set(rowKey(row.family, row.store_key, row.native_id), {
            id: row.id,
            hash: row.row_hash,
            deleted: row.deleted === 1,
          });
        }
      }
      let rowsWritten = 0;
      const seen = new Set<string>();
      for (const candidate of rows) {
        // Shards written before titles were made well-formed still hold some.
        const row = withWellFormedTitle(candidate);
        const key = rowKey(row.catalogFamily, row.storeKey, row.sessionId);
        seen.add(key);
        const hash = sessionCatalogRowHash(row);
        const existing = stored.get(key);
        if (existing && !existing.deleted && existing.hash === hash) continue;
        this.writeRow(row, hash, state.generation);
        rowsWritten += 1;
      }
      let rowsTombstoned = 0;
      for (const [key, existing] of stored) {
        if (existing.deleted || seen.has(key)) continue;
        this.tombstone.run(state.generation, existing.id);
        rowsTombstoned += 1;
      }
      this.writeSources(sources);
      this.writeState.run(
        state.epoch,
        state.generation,
        lineageReplaced
          ? state.generation
          : (previous?.tombstoneHorizon ?? state.generation),
        state.completedAt,
      );
      return { rowsWritten, rowsTombstoned, lineageReplaced };
    });
  }

  /** Live rows, reassembled exactly as the adapters published them. */
  readRows(): SessionCatalogRow[] {
    return this.selectRows.all<CatalogColumns>().map(rowFromColumns);
  }

  readSources(): SessionCatalogSqliteSource[] {
    return this.selectSources
      .all<{ family: string; store_key: string }>()
      .map((source) => ({
        catalogFamily: source.family as ProviderCatalogFamily,
        storeKey: source.store_key,
      }));
  }

  /** Finalize the prepared statements; the store is unusable afterwards. */
  dispose(): void {
    for (const statement of this.statements.splice(0)) statement.finalize();
  }

  private writeRow(
    row: Readonly<SessionCatalogRow>,
    hash: string,
    generation: number,
  ): void {
    const title = typeof row.title === "string" ? row.title : null;
    const location = row.location;
    this.upsertRow.run(
      row.catalogFamily,
      row.storeKey,
      row.sessionId,
      row.nativeStorageScope ?? null,
      row.nativeDirectoryProjectId ?? null,
      row.projectIdentityKey,
      row.projectId,
      row.projectPath,
      row.projectName ?? null,
      row.provider ?? null,
      title === null ? null : title.slice(0, CATALOG_TITLE_PREFIX_LENGTH),
      row.title === null ? 1 : 0,
      row.createdAt ?? null,
      row.updatedAt,
      row.lastHumanTurnAt ?? null,
      row.asyncQuestions === undefined
        ? null
        : JSON.stringify(row.asyncQuestions),
      row.fidelity,
      row.rowFormat ?? null,
      row.sourceVersion,
      location.kind,
      location.kind === "provider" ? null : location.path,
      location.kind === "file" ? null : location.recordId,
      hash,
      generation,
    );
    const key = [row.catalogFamily, row.storeKey, row.sessionId] as const;
    if (title !== null && title.length > CATALOG_TITLE_PREFIX_LENGTH) {
      this.upsertText.run(title, ...key);
    } else {
      this.deleteText.run(...key);
    }
  }

  private writeSources(sources: readonly SessionCatalogSqliteSource[]): void {
    const stored = new Set(
      this.selectSources
        .all<{ family: string; store_key: string }>()
        .map((source) => rowKey(source.family, source.store_key)),
    );
    const wanted = new Set<string>();
    for (const source of sources) {
      const key = rowKey(source.catalogFamily, source.storeKey);
      if (wanted.has(key)) continue;
      wanted.add(key);
      if (!stored.has(key))
        this.insertSource.run(source.catalogFamily, source.storeKey);
    }
    for (const key of stored) {
      if (wanted.has(key)) continue;
      const [family, storeKey] = JSON.parse(key) as [string, string];
      this.deleteSource.run(family, storeKey);
    }
  }
}

/**
 * Digest of a row's canonical JSON, so an unchanged row is never rewritten.
 * Rows reach the store already normalized (`SessionCatalogService`), which
 * fixes their property order.
 */
export function sessionCatalogRowHash(
  row: Readonly<SessionCatalogRow>,
): string {
  return createHash("sha256")
    .update(JSON.stringify(row))
    .digest("base64url")
    .slice(0, 22);
}

interface StateColumns {
  epoch: string;
  generation: number;
  tombstone_horizon: number;
  completed_at: string;
}

const STATE_SQL =
  "SELECT epoch, generation, tombstone_horizon, completed_at FROM catalog_state WHERE id = 1";

function stateFromRow(
  row: StateColumns | undefined,
): SessionCatalogSqliteState | undefined {
  return row
    ? {
        epoch: row.epoch,
        generation: row.generation,
        tombstoneHorizon: row.tombstone_horizon,
        completedAt: row.completed_at,
      }
    : undefined;
}

/** The stored lineage, without keeping a store's statements alive. */
export function readSessionCatalogState(
  database: SqliteDatabase,
): SessionCatalogSqliteState | undefined {
  const statement = database.prepare(STATE_SQL);
  try {
    return stateFromRow(statement.get<StateColumns>());
  } finally {
    statement.finalize();
  }
}

function rowKey(...parts: string[]): string {
  return JSON.stringify(parts);
}

function rowFromColumns(columns: CatalogColumns): SessionCatalogRow {
  const title =
    columns.title_null === 1
      ? null
      : (columns.full_title ?? columns.title ?? undefined);
  return {
    catalogFamily: columns.family as ProviderCatalogFamily,
    storeKey: columns.store_key,
    sessionId: columns.native_id,
    ...(columns.native_storage_scope !== null
      ? { nativeStorageScope: columns.native_storage_scope }
      : {}),
    ...(columns.native_directory_project_id !== null
      ? {
          nativeDirectoryProjectId:
            columns.native_directory_project_id as UrlProjectId,
        }
      : {}),
    projectId: columns.project_id as UrlProjectId,
    projectPath: columns.project_path,
    projectIdentityKey: columns.project_key,
    updatedAt: columns.updated_at,
    ...(columns.created_at !== null ? { createdAt: columns.created_at } : {}),
    ...(columns.last_human_turn_at !== null
      ? { lastHumanTurnAt: columns.last_human_turn_at }
      : {}),
    ...(title !== undefined ? { title } : {}),
    ...(columns.provider !== null
      ? { provider: columns.provider as ProviderName }
      : {}),
    ...(columns.project_name !== null
      ? { projectName: columns.project_name }
      : {}),
    ...(columns.async_questions !== null
      ? {
          asyncQuestions: JSON.parse(
            columns.async_questions,
          ) as SessionCatalogRow["asyncQuestions"],
        }
      : {}),
    fidelity: columns.fidelity,
    sourceVersion: columns.source_version,
    ...(columns.row_format !== null ? { rowFormat: columns.row_format } : {}),
    location: locationFromColumns(columns),
  };
}

function locationFromColumns(columns: CatalogColumns): SessionCatalogLocation {
  switch (columns.location_kind) {
    case "file":
      return { kind: "file", path: columns.location_path ?? "" };
    case "database":
      return {
        kind: "database",
        path: columns.location_path ?? "",
        recordId: columns.location_record_id ?? "",
      };
    case "provider":
      return { kind: "provider", recordId: columns.location_record_id ?? "" };
  }
}
