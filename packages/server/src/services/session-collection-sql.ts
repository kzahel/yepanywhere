import { fromUrlProjectId, isUrlProjectId } from "@yep-anywhere/shared";
import { isDetachedProjectPath } from "../projects/paths.js";
import type {
  GlobalSessionItem,
  GlobalSessionStats,
} from "../routes/global-sessions.js";
import type {
  SqliteDatabase,
  SqliteStatement,
  SqliteValue,
} from "../storage/sqlite.js";

export interface CollectionPageQuery {
  filterProjectId?: string;
  searchQuery?: string;
  afterCursor?: string;
  includeArchived?: boolean;
  starredOnly?: boolean;
  categorizedOnly?: boolean;
  accessibleProjectIds?: readonly string[];
  limit: number;
}
export interface CollectionStoredRow {
  id: string;
  item: string;
  archived: number;
  automatic: number;
  updated_ms: number;
  attention: number;
  native_key: string | null;
  ordinal: number;
  parent_json: string | null;
}
export interface CollectionSource {
  key: string;
  public_id: string | null;
  project_id: string | null;
  project_path: string | null;
  ordinal: number;
  unstable: number;
}
let nextOwner = 0;

/** Rebuildable SQL working index. Its tables and statements die with the owner.
 * Only the fixed SQL vocabulary/boolean query shapes are prepared (LRU 8).
 * Heavy row/search JSON is outside covering page indexes and decoded on-page.
 */
export class SessionCollectionSql {
  readonly prefix = `collection_query_${++nextOwner}`;
  private readonly statements = new Map<string, SqliteStatement>();
  constructor(readonly db: SqliteDatabase) {
    const p = this.prefix;
    db.transaction(() =>
      db.exec(`CREATE TEMP TABLE ${p}_rows (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, updated_ms REAL NOT NULL,
      archived INTEGER NOT NULL, automatic INTEGER NOT NULL, starred INTEGER NOT NULL,
      categorized INTEGER NOT NULL, unread INTEGER NOT NULL, attention INTEGER NOT NULL,
      active INTEGER NOT NULL, live INTEGER NOT NULL, provider TEXT NOT NULL,
      executor TEXT NOT NULL, ordinal INTEGER NOT NULL, native_key TEXT,
      parent_json TEXT, name_json TEXT NOT NULL, option_visible INTEGER NOT NULL, search_json TEXT NOT NULL, item TEXT NOT NULL);
      CREATE TEMP TABLE ${p}_options(project_id TEXT PRIMARY KEY,name_json TEXT NOT NULL);
      CREATE TEMP TABLE ${p}_projects(project_id TEXT PRIMARY KEY,project_path TEXT NOT NULL);
      CREATE TEMP TABLE ${p}_counts (project_id TEXT, provider TEXT, executor TEXT,
        total INTEGER NOT NULL, archived INTEGER NOT NULL, starred INTEGER NOT NULL,
        unread INTEGER NOT NULL, PRIMARY KEY(project_id,provider,executor));
      CREATE TEMP TABLE ${p}_sources (key TEXT PRIMARY KEY,public_id TEXT,
        project_id TEXT,project_path TEXT,ordinal INTEGER NOT NULL,unstable INTEGER NOT NULL);
      CREATE INDEX ${p}_source_id ON ${p}_sources(public_id,ordinal);
      CREATE INDEX ${p}_source_project ON ${p}_sources(project_id,ordinal DESC);
      CREATE INDEX ${p}_unstable ON ${p}_sources(unstable);
      CREATE TEMP TABLE ${p}_dirty (id TEXT PRIMARY KEY);
`),
    );
  }
  private building = false;
  beginReplacement() {
    this.building = true;
    for (const suffix of ["insert", "delete", "archive"])
      this.db.exec(`DROP TRIGGER IF EXISTS ${this.prefix}_${suffix}`);
    for (const [suffix] of ROW_INDEXES)
      this.db.exec(`DROP INDEX IF EXISTS ${this.prefix}_${suffix}`);
    this.reset();
  }
  async finishReplacement(signal: AbortSignal) {
    for (const [suffix, columns] of ROW_INDEXES) {
      signal.throwIfAborted();
      this.db.exec(
        `CREATE INDEX ${this.prefix}_${suffix} ON ${this.prefix}_rows(${columns})`,
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    signal.throwIfAborted();
    const p = this.prefix;
    this.db.transaction(() => {
      this.db.exec(`INSERT INTO ${p}_counts SELECT project_id,provider,executor,
        SUM(1-archived),SUM(archived),SUM(starred),SUM(unread*(1-archived))
        FROM ${p}_rows GROUP BY project_id,provider,executor;
        INSERT INTO ${p}_options SELECT project_id,name_json FROM
        (SELECT project_id,name_json,MAX(ordinal) FROM ${p}_rows WHERE option_visible=1 GROUP BY project_id);
      CREATE TEMP TRIGGER ${p}_insert AFTER INSERT ON ${p}_rows BEGIN
        INSERT OR REPLACE INTO ${p}_options SELECT project_id,name_json FROM ${p}_rows
          WHERE project_id=NEW.project_id AND option_visible=1 ORDER BY ordinal DESC LIMIT 1;
        INSERT INTO ${p}_counts VALUES (NEW.project_id,NEW.provider,NEW.executor,
          1-NEW.archived,NEW.archived,NEW.starred,NEW.unread*(1-NEW.archived))
        ON CONFLICT(project_id,provider,executor) DO UPDATE SET
          total=total+excluded.total,archived=archived+excluded.archived,
          starred=starred+excluded.starred,unread=unread+excluded.unread;
      END;
      CREATE TEMP TRIGGER ${p}_archive AFTER UPDATE OF archived ON ${p}_rows BEGIN
        UPDATE ${p}_counts SET total=total+OLD.archived-NEW.archived,
          archived=archived+NEW.archived-OLD.archived,
          unread=unread+OLD.unread*(OLD.archived-NEW.archived)
          WHERE project_id=OLD.project_id AND provider=OLD.provider AND executor=OLD.executor;
      END;
      CREATE TEMP TRIGGER ${p}_delete AFTER DELETE ON ${p}_rows BEGIN
        DELETE FROM ${p}_options WHERE project_id=OLD.project_id;
        INSERT INTO ${p}_options SELECT project_id,name_json FROM ${p}_rows
          WHERE project_id=OLD.project_id AND option_visible=1 ORDER BY ordinal DESC LIMIT 1;
        UPDATE ${p}_counts SET total=total-(1-OLD.archived),archived=archived-OLD.archived,
          starred=starred-OLD.starred,unread=unread-OLD.unread*(1-OLD.archived)
          WHERE project_id=OLD.project_id AND provider=OLD.provider AND executor=OLD.executor;
        DELETE FROM ${p}_counts WHERE total=0 AND archived=0 AND starred=0 AND unread=0;
      END;
`);
    });
    this.building = false;
  }
  private prepare(sql: string): SqliteStatement {
    let statement = this.statements.get(sql);
    if (statement) this.statements.delete(sql);
    else {
      if (this.statements.size >= 8) {
        const [key, oldest] = this.statements.entries().next().value!;
        oldest.finalize();
        this.statements.delete(key);
      }
      statement = this.db.prepare(sql);
    }
    this.statements.set(sql, statement);
    return statement;
  }
  source(key: string) {
    return this.prepare(
      `SELECT * FROM ${this.prefix}_sources WHERE key=?`,
    ).get<CollectionSource>(key);
  }
  sourcesFor(id: string) {
    return this.prepare(
      `SELECT * FROM ${this.prefix}_sources WHERE public_id=? ORDER BY ordinal`,
    ).all<CollectionSource>(id);
  }
  sourceProjects() {
    return this.prepare(
      `SELECT project_id,project_path FROM ${this.prefix}_projects`,
    )
      .all<{ project_id: string; project_path: string }>()
      .map((row) => ({
        ...row,
        project_path: JSON.parse(row.project_path) as string,
      }));
  }
  unstableSources() {
    return this.prepare(
      `SELECT key FROM ${this.prefix}_sources WHERE unstable=1`,
    ).all<{ key: string }>();
  }
  putSource(row: CollectionSource) {
    this.prepare(
      `INSERT INTO ${this.prefix}_sources VALUES(?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET public_id=excluded.public_id,project_id=excluded.project_id,project_path=excluded.project_path,unstable=excluded.unstable`,
    ).run(
      row.key,
      row.public_id,
      row.project_id,
      row.project_path === null ? null : JSON.stringify(row.project_path),
      row.ordinal,
      row.unstable,
    );
  }
  refreshProject(id: string) {
    this.prepare(`DELETE FROM ${this.prefix}_projects WHERE project_id=?`).run(
      id,
    );
    this.prepare(
      `INSERT INTO ${this.prefix}_projects SELECT project_id,project_path FROM ${this.prefix}_sources WHERE project_id=? ORDER BY ordinal DESC LIMIT 1`,
    ).run(id);
  }
  removeSource(key: string) {
    this.prepare(`DELETE FROM ${this.prefix}_sources WHERE key=?`).run(key);
  }
  markDirty(id: string) {
    this.prepare(`INSERT OR IGNORE INTO ${this.prefix}_dirty VALUES(?)`).run(
      id,
    );
  }
  dirty() {
    const ids = this.prepare(`SELECT id FROM ${this.prefix}_dirty`).all<{
      id: string;
    }>();
    this.prepare(`DELETE FROM ${this.prefix}_dirty`).run();
    return ids.map((row) => row.id);
  }
  liveIds() {
    return this.prepare(`SELECT id FROM ${this.prefix}_rows WHERE live=1`)
      .all<{ id: string }>()
      .map((r) => r.id);
  }
  idsForProject(id: string) {
    return this.prepare(
      `SELECT id FROM ${this.prefix}_rows WHERE project_id=? UNION SELECT public_id AS id FROM ${this.prefix}_sources WHERE project_id=? AND public_id IS NOT NULL`,
    )
      .all<{ id: string }>(id, id)
      .map((r) => r.id);
  }
  get(id: string) {
    return this.prepare(
      `SELECT id,item,archived,automatic,updated_ms,attention,native_key,ordinal,parent_json FROM ${this.prefix}_rows WHERE id=?`,
    ).get<CollectionStoredRow>(id);
  }
  remove(id: string) {
    this.prepare(`DELETE FROM ${this.prefix}_rows WHERE id=?`).run(id);
  }
  put(
    item: GlobalSessionItem,
    nativeKey: string | null,
    ordinal: number,
    automatic: boolean,
    live: boolean,
    cutoff?: number,
    parentJson: string | null = null,
    attention?: boolean,
  ) {
    if (!this.building) this.remove(item.id);
    const ms = Date.parse(item.updatedAt);
    const archived = automatic
      ? cutoff !== undefined && Number.isFinite(ms) && ms < cutoff
      : Boolean(item.isArchived);
    this.prepare(
      `INSERT INTO ${this.prefix}_rows VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      item.id,
      item.projectId,
      Number.isFinite(ms) ? ms : 0,
      Number(archived),
      Number(automatic),
      Number(Boolean(item.isStarred)),
      Number(Boolean(item.sidebarCategory)),
      Number(Boolean(item.hasUnread)),
      Number(
        attention ?? Boolean(item.pendingInputType || item.nonHumanUserTurn),
      ),
      Number(item.activity === "in-turn"),
      Number(live),
      JSON.stringify(item.provider),
      JSON.stringify(item.executor ?? "local"),
      ordinal,
      nativeKey,
      parentJson,
      JSON.stringify(item.projectName),
      Number(
        !item.creation ||
          (isUrlProjectId(item.projectId) &&
            !isDetachedProjectPath(fromUrlProjectId(item.projectId))),
      ),
      JSON.stringify(
        [
          item.title,
          item.customTitle,
          item.projectName,
          item.initialPrompt,
        ].map((s) => (typeof s === "string" ? s.toLowerCase() : null)),
      ),
      JSON.stringify(item),
    );
  }
  /** Time changes only rows crossing an archive boundary, never a timer per row. */
  async expire(cutoff: number | undefined, signal: AbortSignal) {
    for (const archived of [0, 1]) {
      const op = archived ? " >=" : " <";
      for (;;) {
        signal.throwIfAborted();
        const rows = this.prepare(
          `SELECT id FROM ${this.prefix}_rows WHERE automatic=1 AND archived=? ${cutoff === undefined ? (archived ? "" : "AND 0") : `AND updated_ms ${op} ?`} LIMIT 256`,
        ).all<{ id: string }>(
          archived,
          ...(cutoff === undefined ? [] : [cutoff]),
        );
        if (!rows.length) break;
        // Hydration overlays the flag. Heavy response/search JSON never moves.
        this.db.transaction(() =>
          this.prepare(
            `UPDATE ${this.prefix}_rows SET archived=? WHERE id IN (SELECT value FROM json_each(?))`,
          ).run(1 - archived, JSON.stringify(rows.map((row) => row.id))),
        );
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
  }
  stats(accessible?: readonly string[]): GlobalSessionStats {
    const rows = this.prepare(
      `SELECT * FROM ${this.prefix}_counts ${accessible ? "WHERE project_id IN (SELECT value FROM json_each(?))" : ""}`,
    ).all<{
      provider: string;
      executor: string;
      total: number;
      archived: number;
      starred: number;
      unread: number;
    }>(...(accessible ? [JSON.stringify(accessible)] : []));
    const stats: GlobalSessionStats = {
      totalCount: 0,
      unreadCount: 0,
      starredCount: 0,
      archivedCount: 0,
      providerCounts: {},
      executorCounts: {},
    };
    for (const row of rows) {
      stats.totalCount += row.total;
      stats.unreadCount += row.unread;
      stats.archivedCount += row.archived;
      stats.starredCount += row.starred;
      if (row.total) {
        const provider = JSON.parse(
          row.provider,
        ) as GlobalSessionItem["provider"];
        const executor = JSON.parse(row.executor) as string;
        stats.providerCounts[provider] =
          (stats.providerCounts[provider] ?? 0) + row.total;
        stats.executorCounts[executor] =
          (stats.executorCounts[executor] ?? 0) + row.total;
      }
    }
    return stats;
  }
  itemProjects() {
    return this.prepare(
      `SELECT project_id,name_json FROM ${this.prefix}_options`,
    ).all<{ project_id: string; name_json: string }>();
  }
  /** Only keys from the boundary timestamp expand; cold JSON hydration stays paged.
   * Sorting tie ids in JS preserves localeCompare on both portable backends.
   */
  select(
    query: CollectionPageQuery,
    extra = "",
    extraArgs: SqliteValue[] = [],
  ): CollectionStoredRow[] {
    const where: string[] = ["1"];
    const args: SqliteValue[] = [];
    if (!query.includeArchived) where.push("archived=0");
    if (query.starredOnly) where.push("starred=1");
    if (query.categorizedOnly) where.push("categorized=1");
    if (query.filterProjectId !== undefined) {
      where.push("project_id=?");
      args.push(query.filterProjectId);
    }
    if (query.accessibleProjectIds) {
      where.push("project_id IN (SELECT value FROM json_each(?))");
      args.push(JSON.stringify(query.accessibleProjectIds));
    }
    if (query.afterCursor) {
      where.push("updated_ms < ?");
      args.push(
        Number.isFinite(Date.parse(query.afterCursor))
          ? Date.parse(query.afterCursor)
          : -1e300,
      );
    }
    if (query.searchQuery) {
      where.push(
        "EXISTS(SELECT 1 FROM json_each(search_json) WHERE instr(value,json_extract(?,'$'))>0)",
      );
      args.push(JSON.stringify(query.searchQuery));
    }
    if (extra) {
      where.push(extra);
      args.push(...extraArgs);
    }
    const condition = where.join(" AND ");
    const keys = this.prepare(
      `SELECT id,updated_ms FROM ${this.prefix}_rows WHERE ${condition} ORDER BY updated_ms DESC,id LIMIT ?`,
    ).all<{ id: string; updated_ms: number }>(...args, query.limit);
    if (!keys.length) return [];
    const boundary = keys.at(-1)!.updated_ms;
    const ties = this.prepare(
      `SELECT id,updated_ms FROM ${this.prefix}_rows WHERE ${condition} AND updated_ms=?`,
    ).all<{ id: string; updated_ms: number }>(...args, boundary);
    return [...keys.filter((r) => r.updated_ms !== boundary), ...ties]
      .sort((a, b) => b.updated_ms - a.updated_ms || a.id.localeCompare(b.id))
      .slice(0, query.limit)
      .map((r) => this.get(r.id)!);
  }
  reset() {
    for (const table of [
      "rows",
      "sources",
      "dirty",
      "projects",
      "options",
      "counts",
    ])
      this.prepare(`DELETE FROM ${this.prefix}_${table}`).run();
  }
  dispose() {
    for (const statement of this.statements.values()) statement.finalize();
    this.statements.clear();
    for (const suffix of [
      "rows",
      "sources",
      "counts",
      "dirty",
      "projects",
      "options",
    ])
      this.db.exec(`DROP TABLE IF EXISTS ${this.prefix}_${suffix}`);
  }
}

const ROW_INDEXES = [
  ["time", "archived, updated_ms DESC, id"],
  ["all_time", "updated_ms DESC, id"],
  ["project", "project_id, archived, updated_ms DESC, id"],
  ["starred", "starred, archived, updated_ms DESC, id"],
  ["category", "categorized, archived, updated_ms DESC, id"],
  ["attention", "archived, attention, updated_ms DESC, id"],
  ["active", "archived, active, updated_ms DESC, id"],
  ["unread", "archived, unread, updated_ms DESC, id"],
  ["expiry", "automatic, archived, updated_ms"],
  ["live", "live, id"],
  ["item_options", "project_id, ordinal DESC"],
] as const;
