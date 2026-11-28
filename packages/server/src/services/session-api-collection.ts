import type { ApiSession } from "../core-api/contracts.js";
import type { SqliteStatement, SqliteValue } from "../storage/sqlite.js";

export interface SessionApiPageQuery {
  offset: number;
  limit: number;
  projectId?: string;
  visibleProjects?: readonly string[];
  pathAllowsProject?: (id: string) => boolean;
  hiddenProjects?: readonly string[];
  creator?: string;
}

export interface SessionApiIndexRow {
  id: string;
  // A null project records an ambiguous id, including for the live overlay.
  project_id: string | null;
  native_key: string | null;
  creator: string | null;
  updated_ms: number;
}

export interface SessionApiPageRow extends SessionApiIndexRow {
  owned?: ApiSession;
}

interface PageKey extends SessionApiIndexRow {
  live: number;
}

export function apiTimestamp(value: string) {
  return Date.parse(value) || 0;
}

/** The v0 projection shares the collection owner's source token and checkpoint. */
export class SessionApiCollection {
  constructor(
    private readonly table: string,
    private readonly prepare: (sql: string) => SqliteStatement,
  ) {}

  set(row: SessionApiIndexRow) {
    this.prepare(
      `INSERT INTO ${this.table} VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
       project_id=excluded.project_id,native_key=excluded.native_key,
       creator=excluded.creator,updated_ms=excluded.updated_ms
       WHERE project_id IS NOT excluded.project_id OR native_key IS NOT excluded.native_key
          OR creator IS NOT excluded.creator OR updated_ms IS NOT excluded.updated_ms`,
    ).run(row.id, row.project_id, row.native_key, row.creator, row.updated_ms);
  }

  remove(id: string) {
    this.prepare(`DELETE FROM ${this.table} WHERE id=?`).run(id);
  }

  select(query: SessionApiPageQuery, owned: readonly ApiSession[]) {
    const exclude = new Set<string>();
    const extra = new Map<string, ApiSession>();
    for (const session of owned) {
      if (exclude.has(session.id)) continue;
      const indexed = this.prepare(
        `SELECT project_id FROM ${this.table} WHERE id=?`,
      ).get<{ project_id: string | null }>(session.id);
      const project = indexed
        ? indexed.project_id
        : extra.get(session.id)?.projectId;
      if (project === undefined) extra.set(session.id, session);
      else if (project !== session.projectId) {
        exclude.add(session.id);
        extra.delete(session.id);
      }
    }
    const conditions = ["project_id IS NOT NULL"];
    const args: SqliteValue[] = [];
    if (query.projectId !== undefined) {
      conditions.push("project_id=?");
      args.push(query.projectId);
    }
    if (query.visibleProjects) {
      const allowed = new Set(query.visibleProjects);
      if (query.pathAllowsProject) {
        const projects =
          query.projectId === undefined
            ? this.prepare(
                `SELECT DISTINCT project_id FROM ${this.table} WHERE project_id IS NOT NULL`,
              ).all<{ project_id: string }>()
            : [{ project_id: query.projectId }];
        for (const { project_id } of projects)
          if (query.pathAllowsProject(project_id)) allowed.add(project_id);
        for (const session of extra.values())
          if (query.pathAllowsProject(session.projectId))
            allowed.add(session.projectId);
      }
      conditions.push(
        query.creator === undefined
          ? "project_id IN (SELECT value FROM json_each(?))"
          : "(project_id IN (SELECT value FROM json_each(?)) OR creator=?)",
      );
      args.push(JSON.stringify([...allowed]));
      if (query.creator !== undefined) args.push(query.creator);
    }
    if (query.hiddenProjects?.length) {
      conditions.push("project_id NOT IN (SELECT value FROM json_each(?))");
      args.push(JSON.stringify(query.hiddenProjects));
    }
    if (exclude.size) {
      conditions.push("id NOT IN (SELECT value FROM json_each(?))");
      args.push(JSON.stringify([...exclude]));
    }
    const native = `SELECT id,project_id,native_key,creator,updated_ms,0 AS live
      FROM ${this.table} WHERE ${conditions.join(" AND ")}`;
    const combined = extra.size
      ? `${native} UNION ALL SELECT * FROM (
        SELECT key AS id,json_extract(value,'$.projectId') AS project_id,
          NULL AS native_key,json_extract(value,'$.createdByUser') AS creator,
          json_extract(value,'$.ms') AS updated_ms,1 AS live FROM json_each(?)
        ) WHERE ${conditions.join(" AND ")}`
      : native;
    const parameters = extra.size
      ? [
          ...args,
          JSON.stringify(
            Object.fromEntries(
              [...extra].map(([id, session]) => [
                id,
                {
                  projectId: session.projectId,
                  createdByUser: session.createdByUser,
                  ms: apiTimestamp(session.updatedAt),
                },
              ]),
            ),
          ),
          ...args,
        ]
      : args;
    const offset = Math.max(0, query.offset - 1);
    const skipPrevious = query.offset - offset;
    const keys = this.prepare(
      `${combined} ORDER BY updated_ms DESC,id LIMIT ? OFFSET ?`,
    ).all<PageKey>(...parameters, query.limit + 1 + skipPrevious, offset);
    let page = keys.slice(skipPrevious);
    if (page.length === 0) return { rows: [], hasMore: false };

    // SQL uses portable binary order. Recover only the cut timestamp groups
    // to preserve v0's localeCompare order, including offset pages into a tie.
    const first = page[0]!.updated_ms;
    const last = page.at(-1)!.updated_ms;
    const cutsFirst = skipPrevious > 0 && keys[0]?.updated_ms === first;
    const boundary = this.prepare(
      `SELECT * FROM (${combined}) WHERE updated_ms=?`,
    );
    let start = 0;
    if (cutsFirst) {
      const { before } = this.prepare(
        `SELECT COUNT(*) AS before FROM (${combined}) WHERE updated_ms>?`,
      ).get<{ before: number }>(...parameters, first)!;
      start = query.offset - before;
      page = [
        ...page.filter((row) => row.updated_ms !== first),
        ...boundary.all<PageKey>(...parameters, first),
      ];
    }
    if (page.length >= query.limit + 1 && (!cutsFirst || last !== first)) {
      const ties = boundary.all<PageKey>(...parameters, last);
      const from = page.filter((row) => row.updated_ms !== last);
      page = [...from, ...ties];
    }
    page.sort(
      (a, b) => b.updated_ms - a.updated_ms || a.id.localeCompare(b.id),
    );
    return {
      rows: page.slice(start, start + query.limit).map(
        ({ live, ...row }): SessionApiPageRow => ({
          ...row,
          owned: live ? extra.get(row.id) : undefined,
        }),
      ),
      hasMore: page.length > start + query.limit,
    };
  }
}
