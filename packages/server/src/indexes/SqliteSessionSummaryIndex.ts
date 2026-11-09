import type { SqliteDatabase } from "../storage/sqlite.js";
import type {
  CachedSessionSummary,
  SessionIndexState,
} from "./SessionIndexService.js";

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
      "SELECT session_id, summary FROM session_summary_index WHERE scope = ?",
    );
    this.row = database.prepare(
      "SELECT summary FROM session_summary_index WHERE scope = ? AND session_id = ?",
    );
    this.writeScope = database.prepare(
      "INSERT INTO session_summary_scopes (scope, project_id, format_version) VALUES (?, ?, ?) ON CONFLICT(scope) DO UPDATE SET project_id = excluded.project_id, format_version = excluded.format_version WHERE project_id != excluded.project_id OR format_version != excluded.format_version",
    );
    this.writeRow = database.prepare(
      "INSERT INTO session_summary_index (scope, session_id, summary) VALUES (?, ?, ?) ON CONFLICT(scope, session_id) DO UPDATE SET summary = excluded.summary WHERE summary != excluded.summary",
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
    for (const row of this.rows.all<{ session_id: string; summary: string }>(
      scope,
    )) {
      sessions[row.session_id] = JSON.parse(
        row.summary,
      ) as CachedSessionSummary;
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
    const row = this.row.get<{ summary: string }>(scope, sessionId);
    return row ? (JSON.parse(row.summary) as CachedSessionSummary) : null;
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
          .all<{ session_id: string; summary: string }>(scope)
          .map((row) => [row.session_id, row.summary]),
      );
      for (const [id, summary] of Object.entries(index.sessions)) {
        const text = JSON.stringify(summary);
        if (previous.get(id) !== text) this.writeRow.run(scope, id, text);
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
    if (summary) this.writeRow.run(scope, sessionId, JSON.stringify(summary));
    else this.deleteRow.run(scope, sessionId);
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
