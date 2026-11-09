import type { SqliteDatabase } from "../storage/sqlite.js";
import type {
  CachedSessionSummary,
  SessionIndexState,
} from "./SessionIndexService.js";

/**
 * A stored summary: the JSON without `fullTitle`, which has its own column
 * (migration 030) because it is most of the bytes and is uncapped. A title
 * that is not well-formed UTF-16 or holds a NUL stays in the JSON, where both
 * survive as escapes: a text column would replace a lone surrogate, and
 * node:sqlite cuts text at the first NUL.
 */
interface StoredSummary {
  summary: string;
  full_title: string | null;
}

function toStored(summary: CachedSessionSummary): StoredSummary {
  const { fullTitle, ...rest } = summary;
  if (
    typeof fullTitle === "string" &&
    (fullTitle.includes("\0") ||
      !(fullTitle as unknown as { isWellFormed(): boolean }).isWellFormed())
  )
    return { summary: JSON.stringify(summary), full_title: null };
  return {
    summary: JSON.stringify(rest),
    full_title: typeof fullTitle === "string" ? fullTitle : null,
  };
}

/** Rebuilds the summary with `fullTitle` beside `title`, where it was written. */
function fromStored(row: StoredSummary): CachedSessionSummary {
  const parsed = JSON.parse(row.summary) as Omit<
    CachedSessionSummary,
    "fullTitle"
  >;
  if (Object.hasOwn(parsed, "fullTitle")) return parsed as CachedSessionSummary;
  const { title, ...rest } = parsed;
  return { title, fullTitle: row.full_title, ...rest };
}

/** Prepared once per index owner; the database owns their lifetime. */
export class SqliteSessionSummaryIndex {
  private readonly scope;
  private readonly rows;
  private readonly row;
  private readonly writeScope;
  private readonly writeRow;
  private readonly deleteRow;
  private readonly deleteRows;
  private disposed = false;

  constructor(private readonly database: SqliteDatabase) {
    this.scope = database.prepare(
      "SELECT project_id, format_version FROM session_summary_scopes WHERE scope = ?",
    );
    this.rows = database.prepare(
      "SELECT session_id, summary, full_title FROM session_summary_index WHERE scope = ?",
    );
    this.row = database.prepare(
      "SELECT summary, full_title FROM session_summary_index WHERE scope = ? AND session_id = ?",
    );
    this.writeScope = database.prepare(
      "INSERT INTO session_summary_scopes (scope, project_id, format_version) VALUES (?, ?, ?) ON CONFLICT(scope) DO UPDATE SET project_id = excluded.project_id, format_version = excluded.format_version WHERE project_id != excluded.project_id OR format_version != excluded.format_version",
    );
    this.writeRow = database.prepare(
      "INSERT INTO session_summary_index (scope, session_id, summary, full_title) VALUES (?, ?, ?, ?) ON CONFLICT(scope, session_id) DO UPDATE SET summary = excluded.summary, full_title = excluded.full_title WHERE summary != excluded.summary OR full_title IS NOT excluded.full_title",
    );
    this.deleteRow = database.prepare(
      "DELETE FROM session_summary_index WHERE scope = ? AND session_id = ?",
    );
    this.deleteRows = database.prepare(
      "DELETE FROM session_summary_index WHERE scope = ?",
    );
  }

  read(
    scope: string,
  ): (Omit<SessionIndexState, "version"> & { version: number }) | undefined {
    const header = this.scope.get<{
      project_id: string;
      format_version: number;
    }>(scope);
    if (!header) return undefined;
    const sessions: Record<string, CachedSessionSummary> = {};
    for (const row of this.rows.all<StoredSummary & { session_id: string }>(
      scope,
    )) {
      sessions[row.session_id] = fromStored(row);
    }
    return {
      version: header.format_version,
      projectId: header.project_id,
      sessions,
    };
  }

  /** Undefined means this scope has no stored summaries yet. */
  get(
    scope: string,
    projectId: string,
    sessionId: string,
    version: number,
  ): CachedSessionSummary | null | undefined {
    const header = this.scope.get<{
      project_id: string;
      format_version: number;
    }>(scope);
    if (
      !header ||
      header.project_id !== projectId ||
      header.format_version !== version
    )
      return undefined;
    const row = this.row.get<StoredSummary>(scope, sessionId);
    return row ? fromStored(row) : null;
  }

  /** Publish a scope atomically, writing only changed rows. Empty scopes persist too. */
  save(scope: string, index: SessionIndexState): void {
    this.database.transaction(() => {
      const header = this.scope.get<{ project_id: string }>(scope);
      if (header && header.project_id !== index.projectId)
        this.deleteRows.run(scope);
      this.writeScope.run(scope, index.projectId, index.version);
      const previous = new Map(
        this.rows
          .all<StoredSummary & { session_id: string }>(scope)
          .map((row) => [row.session_id, row]),
      );
      for (const [id, summary] of Object.entries(index.sessions)) {
        const next = toStored(summary);
        const stored = previous.get(id);
        if (
          stored?.summary !== next.summary ||
          stored.full_title !== next.full_title
        )
          this.writeRow.run(scope, id, next.summary, next.full_title);
        previous.delete(id);
      }
      for (const id of previous.keys()) this.deleteRow.run(scope, id);
    });
  }

  /** A selected-session refresh must not scan or serialize the rest of the scope. */
  saveSummary(
    scope: string,
    index: SessionIndexState,
    sessionId: string,
  ): void {
    const header = this.scope.get<{
      project_id: string;
      format_version: number;
    }>(scope);
    if (
      !header ||
      header.project_id !== index.projectId ||
      header.format_version !== index.version
    ) {
      this.save(scope, index);
      return;
    }
    const summary = index.sessions[sessionId];
    if (summary) {
      const next = toStored(summary);
      this.writeRow.run(scope, sessionId, next.summary, next.full_title);
    } else this.deleteRow.run(scope, sessionId);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const statement of [
      this.scope,
      this.rows,
      this.row,
      this.writeScope,
      this.writeRow,
      this.deleteRow,
      this.deleteRows,
    ])
      statement.finalize();
  }
}
