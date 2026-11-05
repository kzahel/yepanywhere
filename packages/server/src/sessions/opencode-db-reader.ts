import { statSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { getProjectIdentityKey, isAbsolutePath } from "../projects/paths.js";
import {
  loadSqliteDriver,
  type SqliteDatabase,
  type SqliteStatement,
} from "../storage/sqlite.js";
import type {
  OpenCodeMessage,
  OpenCodeSessionEntry,
  OpenCodeStoredPart,
} from "@yep-anywhere/shared";

/**
 * Direct reader for OpenCode's SQLite transcript store (`opencode.db`, 1.16+).
 *
 * OpenCode 1.16+ persists every session in a single SQLite database; the legacy
 * JSON file tree (`storage/{session,message,part}/…`) is frozen and the
 * `opencode export` CLI is truncation-prone for large sessions (a Bun-binary
 * piped-stdout cap). Reading the DB directly is the authoritative, subprocess-free
 * durable source. See `topics/opencode-backend.md` § "Durable Storage Format".
 *
 * Contract: open **read-only**, never write/checkpoint/PRAGMA-mutate; tolerate a
 * concurrent `opencode serve` writer (WAL readers see the latest committed
 * snapshot per statement); and **never throw** out of a public method — any
 * absence/lock/old-schema returns null so callers fall through to the export and
 * file-tree readers.
 *
 * Mechanism: the common Node/Bun SQLite adapter opens the native file read-only.
 * SQL statements are reused per handle and released on replacement or close.
 * No transcript-store write, checkpoint, or fallback file creation is allowed.
 */

interface ReadQueries {
  prepare(sql: string): Pick<SqliteStatement, "get" | "all">;
}

/**
 * Global opt-out for the direct opencode.db reader (default **on**). Set
 * `OPENCODE_DB_READER=0` (or `false`/`off`/`no`) to disable it: the reader then
 * never opens the DB or loads a SQLite driver, and the OpenCode session
 * paths fall back to the CLI export / legacy file tree exactly as before. This
 * retains the direct-reader opt-out independently of YA's required own database.
 * Checked at the single `ensureDb` choke point, so one guard covers every query.
 */
export function openCodeDbReaderEnabled(): boolean {
  const v = process.env.OPENCODE_DB_READER?.trim().toLowerCase();
  return v !== "0" && v !== "false" && v !== "off" && v !== "no";
}

/** Native directory membership, distinct from OpenCode's shared project ids. */
export interface OpenCodeProjectScope {
  readonly directory: string;
  readonly canonicalDirectory?: string;
  /** Operation-scoped native spellings; never retained across enumerations. */
  readonly directorySpellings?: ReadonlySet<string>;
}

/** Session-level metadata read straight from the `session` table row. */
export interface OpenCodeDbSessionRow {
  id: string;
  title: string | null;
  /** Parsed `session.model` JSON; carries both providerID and the model id. */
  model: { id?: string; providerID?: string; modelID?: string } | null;
  timeCreated: number | null;
  timeUpdated: number | null;
  /** Number of `message` rows for the session (full count, not a page). */
  messageCount: number;
}

/** One install-wide session row, already joined to its project's worktree. */
export interface OpenCodeDbCatalogRow {
  id: string;
  worktree: string;
  directory: string;
  title: string | null;
  timeCreated: number | null;
  timeUpdated: number | null;
}

/** Child session keyed by `session.parent_id` (OpenCode task / subagent). */
export interface OpenCodeDbChildSessionRow {
  id: string;
  parentId: string;
  title: string | null;
  agent: string | null;
  timeUpdated: number | null;
}

/** Raw compact native rows; the relationship adapter owns identity/scope proof. */
export interface OpenCodeRelationshipSnapshot {
  rows: Array<Record<string, unknown>>;
  hasParentIds: boolean;
}

interface DbRow {
  [column: string]: unknown;
}

export class OpenCodeDbReader {
  private db: SqliteDatabase | null | undefined = undefined;
  /** inode+mtime of the db file at open, to reopen if the file is replaced. */
  private dbStamp: string | undefined;
  private closed = false;
  /** Positive project ids only, valid until this native handle is replaced. */
  private projectIdCache = new Map<string, string>();
  // The reader has a fixed set of SQL strings, never SQL keyed by a session.
  private readonly statements = new Map<string, SqliteStatement>();
  private readonly queries: ReadQueries = {
    prepare: (sql) => {
      const existing = this.statements.get(sql);
      if (existing) return existing;
      if (!this.db) throw new Error("OpenCode database reader is closed");
      const statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
      return statement;
    },
  };
  private sessionColumns: Set<string> | undefined;
  private relationshipStatement: SqliteStatement | undefined;
  private relationshipSql: string | undefined;

  constructor(private databasePath: string) {}

  /**
   * Lazily open (and cache) a read-only handle. Re-stats the db file so a
   * replaced database (different inode/mtime) reopens rather than reading a
   * stale handle. Returns null when the file is absent or sqlite is unavailable.
   */
  private ensureDb(): SqliteDatabase | null {
    if (this.closed) return null;
    // Global opt-out (default on). When off, never touch the file or
    // node:sqlite — every query returns null and callers fall back.
    if (!openCodeDbReaderEnabled()) return null;

    let stamp: string;
    try {
      const st = statSync(this.databasePath);
      stamp = `${st.dev}:${st.ino}:${st.mtimeMs}:${st.ctimeMs}:${st.size}`;
    } catch {
      // File absent/unreadable: drop any cached handle and report unavailable.
      this.closeHandle();
      return null;
    }

    if (this.db && this.dbStamp === stamp) return this.db;
    if (this.db && this.dbStamp !== stamp) this.closeHandle();

    const driver = loadSqliteDriver();
    if (!driver) {
      this.db = null;
      return null;
    }
    try {
      this.db = driver.open(this.databasePath, { readOnly: true });
      this.dbStamp = stamp;
      return this.db;
    } catch {
      this.db = null;
      this.dbStamp = undefined;
      return null;
    }
  }

  private closeHandle(): void {
    this.relationshipStatement?.finalize();
    this.relationshipStatement = undefined;
    this.relationshipSql = undefined;
    for (const statement of this.statements.values()) statement.finalize();
    this.statements.clear();
    this.projectIdCache.clear();
    if (this.db) {
      try {
        this.db.close();
      } catch {
        // ignore
      }
    }
    this.db = undefined;
    this.dbStamp = undefined;
    this.sessionColumns = undefined;
  }

  /** project.id for a worktree path, cached. Null when no DB / no such project. */
  async getProjectId(worktree: string): Promise<string | null> {
    return this.run((db) => {
      const cached = this.projectIdCache.get(worktree);
      if (cached !== undefined) return cached;
      const row = db
        .prepare("SELECT id FROM project WHERE worktree = ?")
        .get(worktree) as DbRow | undefined;
      const id = row?.id;
      if (typeof id !== "string") return null;
      this.projectIdCache.set(worktree, id);
      return id;
    });
  }

  async hasProject(scope: OpenCodeProjectScope): Promise<boolean> {
    if (await this.getProjectId(scope.directory)) return true;
    if (
      scope.canonicalDirectory &&
      scope.canonicalDirectory !== scope.directory &&
      (await this.getProjectId(scope.canonicalDirectory))
    )
      return true;
    const aliases = JSON.stringify([...(await this.directoryAliases(scope))]);
    return Boolean(
      await this.run((db) =>
        db
          .prepare(
            `SELECT 1 AS found FROM session s JOIN project p ON p.id = s.project_id WHERE (${this.directoryExpression(db)} IN (SELECT value FROM json_each(?)) OR p.worktree IN (SELECT value FROM json_each(?))) LIMIT 1`,
          )
          .get(aliases, aliases),
      ),
    );
  }

  /**
   * Resolve unique native directory spellings, rather than realpath per session.
   * This compact metadata query reads no messages/parts and bounds filesystem
   * concurrency. Keep the proof request-local: aliases may be retargeted while
   * an unchanged native database remains open.
   */
  async resolveProjectScope(
    scope: OpenCodeProjectScope,
  ): Promise<OpenCodeProjectScope> {
    return { ...scope, directorySpellings: await this.directoryAliases(scope) };
  }

  private async directoryAliases(
    scope: OpenCodeProjectScope,
  ): Promise<ReadonlySet<string>> {
    if (scope.directorySpellings !== undefined) return scope.directorySpellings;
    const paths =
      (await this.run((db) =>
        db
          .prepare(
            this.sessionTableHasColumn(db, "directory")
              ? "SELECT directory AS path FROM session WHERE directory IS NOT NULL AND directory != '' GROUP BY directory UNION SELECT worktree AS path FROM project"
              : "SELECT DISTINCT worktree AS path FROM project",
          )
          .all<DbRow>(),
      )) ?? [];
    const matches = new Set([
      scope.directory,
      scope.canonicalDirectory ?? scope.directory,
    ]);
    for (let offset = 0; offset < paths.length && !this.closed; offset += 5) {
      const batch = paths.slice(offset, offset + 5);
      const results = await Promise.all(
        batch.map(async (row) =>
          typeof row.path === "string" &&
          (await this.belongsToDirectory(row.path, scope))
            ? row.path
            : null,
        ),
      );
      for (const path of results) if (path) matches.add(path);
    }
    return matches;
  }

  private directoryExpression(db: ReadQueries): string {
    return this.sessionTableHasColumn(db, "directory")
      ? "COALESCE(NULLIF(s.directory, ''), p.worktree)"
      : "p.worktree";
  }

  private async belongsToDirectory(
    directory: unknown,
    scope: OpenCodeProjectScope,
  ): Promise<boolean> {
    if (typeof directory !== "string" || !isAbsolutePath(directory))
      return false;
    if (scope.directorySpellings)
      return !this.closed && scope.directorySpellings.has(directory);
    if (
      getProjectIdentityKey(directory) ===
      getProjectIdentityKey(scope.canonicalDirectory ?? scope.directory)
    )
      return !this.closed;
    const physical = await realpath(directory).catch(() => directory);
    const expected =
      scope.canonicalDirectory ??
      (await realpath(scope.directory).catch(() => scope.directory));
    return (
      !this.closed &&
      getProjectIdentityKey(physical) === getProjectIdentityKey(expected)
    );
  }

  /**
   * Session row scoped to its project (mirrors the export path's
   * project-belonging check). Null when the session isn't in this project, the
   * DB is unusable, or the schema predates the SQLite store.
   */
  async getSessionRow(
    sessionId: string,
    scope: OpenCodeProjectScope,
  ): Promise<OpenCodeDbSessionRow | null> {
    const result = await this.run((db) => {
      const row = db
        .prepare(
          `SELECT s.id, s.title, s.model, s.time_created, s.time_updated, ${this.directoryExpression(db)} AS directory, p.worktree AS worktree FROM session s JOIN project p ON p.id = s.project_id WHERE s.id = ?`,
        )
        .get(sessionId) as DbRow | undefined;
      if (!row || typeof row.id !== "string") return null;

      const count = db
        .prepare("SELECT count(*) AS c FROM message WHERE session_id = ?")
        .get(sessionId) as DbRow | undefined;

      return {
        directory: row.directory,
        worktree: row.worktree,
        row: {
          id: row.id,
          title: typeof row.title === "string" ? row.title : null,
          model: parseModel(row.model),
          timeCreated: numberOrNull(row.time_created),
          timeUpdated: numberOrNull(row.time_updated),
          messageCount: numberOrNull(count?.c) ?? 0,
        },
      };
    });
    return result &&
      ((await this.belongsToDirectory(result.directory, scope)) ||
        (await this.belongsToDirectory(result.worktree, scope)))
      ? result.row
      : null;
  }

  /** Native directory and legacy umbrella used to fence fallback acquisition. */
  async getSessionProjects(
    sessionId: string,
  ): Promise<{ directory: string; worktree: string } | null> {
    return this.run((db) => {
      const row = db
        .prepare(
          `SELECT ${this.directoryExpression(db)} AS directory, p.worktree AS worktree FROM session s JOIN project p ON p.id = s.project_id WHERE s.id = ?`,
        )
        .get<DbRow>(sessionId);
      return typeof row?.directory === "string" &&
        typeof row.worktree === "string"
        ? { directory: row.directory, worktree: row.worktree }
        : null;
    });
  }

  /** Lightweight freshness probe: latest `time_updated` + message count. */
  async getSessionMeta(
    sessionId: string,
    scope: OpenCodeProjectScope,
  ): Promise<{ timeUpdated: number; messageCount: number } | null> {
    const row = await this.getSessionRow(sessionId, scope);
    if (!row) return null;
    return {
      timeUpdated: row.timeUpdated ?? 0,
      messageCount: row.messageCount,
    };
  }

  /** All sessions for a project (id + updated time), for enumeration. */
  async listSessionRows(
    scope: OpenCodeProjectScope,
  ): Promise<{ id: string; timeUpdated: number }[]> {
    const aliases = JSON.stringify([...(await this.directoryAliases(scope))]);
    return (
      (await this.run((db) => {
        const rows = db
          .prepare(
            `SELECT s.id, s.time_updated FROM session s JOIN project p ON p.id = s.project_id WHERE (${this.directoryExpression(db)} IN (SELECT value FROM json_each(?)) OR p.worktree IN (SELECT value FROM json_each(?))) ORDER BY s.time_updated DESC`,
          )
          .all(aliases, aliases) as DbRow[];
        const out: { id: string; timeUpdated: number }[] = [];
        for (const row of rows) {
          if (typeof row.id === "string") {
            out.push({
              id: row.id,
              timeUpdated: numberOrNull(row.time_updated) ?? 0,
            });
          }
        }
        return out;
      })) ?? []
    );
  }

  /**
   * Every session in the store, joined to its project's worktree, in one
   * query. This is the install-wide catalog primitive: `listSessionRows` and
   * `getProjectId` answer "this project's sessions", which a per-project
   * caller multiplies by the project count.
   */
  async listAllSessionRows(): Promise<OpenCodeDbCatalogRow[]> {
    return (
      (await this.run((db) => {
        const rows = db
          .prepare(
            `SELECT s.id AS id, s.title AS title, s.time_created AS time_created, s.time_updated AS time_updated, ${this.directoryExpression(db)} AS directory, CASE WHEN p.id = 'global' THEN ${this.directoryExpression(db)} ELSE p.worktree END AS worktree FROM session s JOIN project p ON p.id = s.project_id`,
          )
          .all() as DbRow[];
        const out: OpenCodeDbCatalogRow[] = [];
        for (const row of rows) {
          if (typeof row.id !== "string") continue;
          if (
            typeof row.directory !== "string" ||
            !isAbsolutePath(row.directory)
          ) {
            continue;
          }
          out.push({
            id: row.id,
            worktree:
              typeof row.worktree === "string" ? row.worktree : row.directory,
            directory: row.directory,
            title: typeof row.title === "string" ? row.title : null,
            timeCreated: numberOrNull(row.time_created),
            timeUpdated: numberOrNull(row.time_updated),
          });
        }
        return out;
      })) ?? []
    );
  }

  /**
   * Child `ses_*` rows for one parent. Empty when the schema predates
   * `parent_id` or the parent has no children. Does not read message/part rows.
   */
  async listChildSessionRows(
    scope: OpenCodeProjectScope,
    parentSessionId: string,
  ): Promise<OpenCodeDbChildSessionRow[]> {
    const aliases = JSON.stringify([...(await this.directoryAliases(scope))]);
    return (
      (await this.run((db) => {
        if (!this.sessionTableHasParentId(db)) return [];
        const rows = db
          .prepare(
            `SELECT s.id, s.parent_id, s.title, s.agent, s.time_updated FROM session s JOIN project p ON p.id = s.project_id WHERE (${this.directoryExpression(db)} IN (SELECT value FROM json_each(?)) OR p.worktree IN (SELECT value FROM json_each(?))) AND s.parent_id = ?`,
          )
          .all(aliases, aliases, parentSessionId) as DbRow[];
        return parseChildSessionRows(rows);
      })) ?? []
    );
  }

  /**
   * Strict acquisition boundary: failure is never an authoritative empty set.
   * One statement reads descendants and the ancestors of selected legacy ids
   * from one committed WAL snapshot. No messages, parts, writes or checkpoints.
   * Unlike the tolerant replay methods, this method deliberately throws.
   */
  async readRelationshipSnapshot(
    parentSessionId: string,
    relatedSessionIds: readonly string[] = [],
    additionalParentIds: readonly string[] = [],
  ): Promise<OpenCodeRelationshipSnapshot> {
    const db = this.ensureDb();
    if (!db) throw new Error("OpenCode native relationship store unavailable");
    // Schema reads are constant-sized and fresh, including WAL-only migrations.
    // The generated SELECT has one replaceable statement slot, not a cache
    // entry for every optional-column combination encountered over its lifetime.
    const columns = new Set(
      this.queries
        .prepare("PRAGMA table_info(session)")
        .all<DbRow>()
        .flatMap((row) => (typeof row.name === "string" ? [row.name] : [])),
    );
    if (!columns.has("id") || !columns.has("project_id"))
      throw new Error("OpenCode native relationship schema unavailable");
    const hasParentIds = columns.has("parent_id");
    const optional = (column: string, limit: number) =>
      columns.has(column)
        ? `CASE WHEN length(s.${column}) <= ${limit} THEN s.${column} ELSE NULL END`
        : "NULL";
    const rawDirectory = columns.has("directory")
      ? "COALESCE(NULLIF(s.directory, ''), p.worktree)"
      : "p.worktree";
    const directory = `CASE WHEN length(${rawDirectory}) <= 4096 THEN ${rawDirectory} ELSE NULL END`;
    const updated = columns.has("time_updated")
      ? "CASE WHEN s.time_updated BETWEEN 0 AND 8640000000000000 THEN s.time_updated ELSE NULL END"
      : "NULL";
    const wanted = hasParentIds
      ? `WITH RECURSIVE descendants(id) AS (
      SELECT value FROM json_each(?) UNION SELECT s.id FROM session s JOIN descendants d ON s.parent_id = d.id
    ), targets(id) AS (
      SELECT id FROM descendants UNION SELECT value FROM json_each(?)
    ), lineage(id) AS (
      SELECT id FROM targets UNION SELECT s.parent_id FROM session s JOIN lineage l ON s.id = l.id WHERE s.parent_id IS NOT NULL AND s.parent_id != ''
    )`
      : `WITH lineage(id) AS (SELECT value FROM json_each(?) UNION SELECT value FROM json_each(?))`;
    const sql = `${wanted}
      SELECT ${optional("id", 1024)} AS id,
        ${optional("parent_id", 1024)} AS parent_id,
        ${columns.has("title") ? "substr(s.title, 1, 256)" : "NULL"} AS title,
        ${columns.has("agent") ? "substr(s.agent, 1, 256)" : "NULL"} AS agent,
        ${directory} AS directory, CASE WHEN length(p.worktree) <= 4096 THEN p.worktree ELSE NULL END AS worktree,
        ${updated} AS time_updated
      FROM session s LEFT JOIN project p ON p.id = s.project_id
      WHERE s.id IN (SELECT id FROM lineage)`;
    if (this.relationshipSql !== sql) {
      this.relationshipStatement?.finalize();
      this.relationshipStatement = undefined;
      this.relationshipSql = undefined;
      this.relationshipStatement = db.prepare(sql);
      this.relationshipSql = sql;
    }
    return {
      rows: this.relationshipStatement!.all<DbRow>(
        JSON.stringify([...new Set([parentSessionId, ...additionalParentIds])]),
        JSON.stringify(relatedSessionIds),
      ),
      hasParentIds,
    };
  }

  /**
   * Every child session id in the store. Used to keep `parent_id` rows out of
   * top-level catalogs. Empty when `parent_id` is absent.
   */
  async listChildSessionIds(scope?: OpenCodeProjectScope): Promise<string[]> {
    const aliases = scope
      ? JSON.stringify([...(await this.directoryAliases(scope))])
      : undefined;
    return (
      (await this.run((db) => {
        if (!this.sessionTableHasParentId(db)) return [];
        const rows = (
          scope
            ? db
                .prepare(
                  `SELECT s.id FROM session s JOIN project p ON p.id = s.project_id WHERE (${this.directoryExpression(db)} IN (SELECT value FROM json_each(?)) OR p.worktree IN (SELECT value FROM json_each(?))) AND s.parent_id IS NOT NULL AND s.parent_id != ''`,
                )
                .all(aliases!, aliases!)
            : db
                .prepare(
                  "SELECT id FROM session WHERE parent_id IS NOT NULL AND parent_id != ''",
                )
                .all()
        ) as DbRow[];
        const ids: string[] = [];
        for (const row of rows) {
          if (typeof row.id === "string") ids.push(row.id);
        }
        return ids;
      })) ?? []
    );
  }

  /**
   * Parent `task` parts that name a child session. Session-detail only — list
   * attach must not call this.
   */
  async listTaskChildMappings(
    parentSessionId: string,
  ): Promise<{ toolUseId: string; agentId: string }[]> {
    return (
      (await this.run((db) => {
        let rows: DbRow[];
        try {
          rows = db
            .prepare(
              "SELECT id, data FROM part WHERE session_id = ? AND json_extract(data, '$.tool') = 'task'",
            )
            .all(parentSessionId) as DbRow[];
        } catch {
          rows = db
            .prepare("SELECT id, data FROM part WHERE session_id = ?")
            .all(parentSessionId) as DbRow[];
        }
        const mappings: { toolUseId: string; agentId: string }[] = [];
        const seen = new Set<string>();
        for (const row of rows) {
          const part = parseJson(row.data);
          if (part?.tool !== "task") continue;
          const agentId = childSessionIdFromTaskPart(part);
          if (!agentId) continue;
          const toolUseIds = [stringOrNull(part.callID), stringOrNull(row.id)];
          for (const toolUseId of toolUseIds) {
            if (!toolUseId) continue;
            const key = `${toolUseId}\0${agentId}`;
            if (seen.has(key)) continue;
            seen.add(key);
            mappings.push({ toolUseId, agentId });
          }
        }
        return mappings;
      })) ?? []
    );
  }

  private sessionTableHasColumn(db: ReadQueries, column: string): boolean {
    if (!this.sessionColumns) {
      try {
        this.sessionColumns = new Set(
          db
            .prepare("PRAGMA table_info(session)")
            .all<DbRow>()
            .flatMap((row) => (typeof row.name === "string" ? [row.name] : [])),
        );
      } catch {
        this.sessionColumns = new Set();
      }
    }
    return this.sessionColumns.has(column);
  }

  private sessionTableHasParentId(db: ReadQueries): boolean {
    return this.sessionTableHasColumn(db, "parent_id");
  }

  /** First user message's first text part — the title fallback. */
  async loadFirstUserText(sessionId: string): Promise<string | null> {
    return this.run((db) => {
      const messages = db
        .prepare(
          "SELECT id, data FROM message WHERE session_id = ? ORDER BY id LIMIT 10",
        )
        .all(sessionId) as DbRow[];
      for (const m of messages) {
        const info = parseJson(m.data);
        if (info?.role !== "user") continue;
        const messageId = m.id;
        if (typeof messageId !== "string") continue;
        const parts = db
          .prepare("SELECT data FROM part WHERE message_id = ? ORDER BY id")
          .all(messageId) as DbRow[];
        for (const p of parts) {
          const part = parseJson(p.data);
          if (
            part?.type === "text" &&
            typeof part.text === "string" &&
            part.text.trim()
          ) {
            return part.text.trim();
          }
        }
        return null; // first user message had no text part
      }
      return null;
    });
  }

  /** Tokens from the most recent assistant message (current context fill). */
  async loadLastAssistantTokens(
    sessionId: string,
  ): Promise<OpenCodeMessage["tokens"] | null> {
    return this.run((db) => {
      const messages = db
        .prepare(
          "SELECT data FROM message WHERE session_id = ? ORDER BY id DESC LIMIT 30",
        )
        .all(sessionId) as DbRow[];
      for (const m of messages) {
        const info = parseJson(m.data);
        if (info?.role !== "assistant") continue;
        const tokens = info.tokens;
        if (tokens && typeof tokens === "object") {
          return tokens as OpenCodeMessage["tokens"];
        }
      }
      return null;
    });
  }

  /**
   * Full `{ message, parts }` entries for a session in chronological order, with
   * column ids injected (the JSON `data` blobs omit id/sessionID/messageID —
   * those live only as columns). `afterMessageId` pages: only messages strictly
   * after that id are returned (empty array = no new messages). Null = session
   * unreadable / DB unavailable.
   */
  async loadEntries(
    sessionId: string,
    afterMessageId?: string,
  ): Promise<OpenCodeSessionEntry[] | null> {
    return this.run((db) => {
      const messageRows = db
        .prepare(
          "SELECT id, data FROM message WHERE session_id = ? ORDER BY id",
        )
        .all(sessionId) as DbRow[];

      // Parts grouped by message. part.id is a chronological ULID, so a single
      // session-scoped query ordered by id keeps per-message part order without
      // an N+1 query per message.
      const partRows = db
        .prepare(
          "SELECT id, message_id, data FROM part WHERE session_id = ? ORDER BY id",
        )
        .all(sessionId) as DbRow[];
      const partsByMessage = new Map<string, OpenCodeStoredPart[]>();
      for (const row of partRows) {
        const messageId = row.message_id;
        const partId = row.id;
        if (typeof messageId !== "string" || typeof partId !== "string")
          continue;
        const part = asStoredPart(row.data, partId, sessionId, messageId);
        if (!part) continue;
        const list = partsByMessage.get(messageId);
        if (list) list.push(part);
        else partsByMessage.set(messageId, [part]);
      }

      const entries: OpenCodeSessionEntry[] = [];
      let found = !afterMessageId;
      for (const row of messageRows) {
        const messageId = row.id;
        if (typeof messageId !== "string") continue;
        if (!found) {
          if (messageId === afterMessageId) found = true;
          continue;
        }
        const message = asMessage(row.data, messageId, sessionId);
        if (!message) continue;
        entries.push({ message, parts: partsByMessage.get(messageId) ?? [] });
      }
      return entries;
    });
  }

  /** Run a query callback against the handle, mapping any failure to null. */
  private async run<T>(fn: (db: ReadQueries) => T): Promise<T | null> {
    const db = this.ensureDb();
    if (!db) return null;
    try {
      return fn(this.queries);
    } catch {
      // A locked/old-schema/corrupt read must fall through, never throw.
      return null;
    }
  }

  close(): void {
    this.closed = true;
    this.closeHandle();
  }
}

function parseJson(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function parseModel(value: unknown): OpenCodeDbSessionRow["model"] {
  const parsed = parseJson(value);
  if (!parsed) return null;
  return parsed as OpenCodeDbSessionRow["model"];
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseChildSessionRows(rows: DbRow[]): OpenCodeDbChildSessionRow[] {
  const out: OpenCodeDbChildSessionRow[] = [];
  for (const row of rows) {
    if (typeof row.id !== "string") continue;
    if (typeof row.parent_id !== "string" || row.parent_id.length === 0) {
      continue;
    }
    out.push({
      id: row.id,
      parentId: row.parent_id,
      title: typeof row.title === "string" ? row.title : null,
      agent: typeof row.agent === "string" ? row.agent : null,
      timeUpdated: numberOrNull(row.time_updated),
    });
  }
  return out;
}

function childSessionIdFromTaskPart(
  part: Record<string, unknown>,
): string | null {
  const state =
    part.state && typeof part.state === "object" && !Array.isArray(part.state)
      ? (part.state as Record<string, unknown>)
      : undefined;
  const metadata =
    state?.metadata &&
    typeof state.metadata === "object" &&
    !Array.isArray(state.metadata)
      ? (state.metadata as Record<string, unknown>)
      : undefined;
  const fromMeta =
    stringOrNull(metadata?.sessionId) ?? stringOrNull(metadata?.session_id);
  if (fromMeta) return fromMeta;
  const output = typeof state?.output === "string" ? state.output : "";
  return output.match(/session_id:\s*(ses_[A-Za-z0-9]+)/)?.[1] ?? null;
}

/** Parse `message.data` and inject the column-only id/sessionID. */
function asMessage(
  data: unknown,
  id: string,
  sessionId: string,
): OpenCodeMessage | null {
  const raw = parseJson(data);
  if (!raw) return null;
  const role = raw.role;
  if (role !== "user" && role !== "assistant") return null;
  return { ...raw, id, sessionID: sessionId, role } as OpenCodeMessage;
}

/** Parse `part.data` and inject the column-only id/sessionID/messageID. */
function asStoredPart(
  data: unknown,
  id: string,
  sessionId: string,
  messageId: string,
): OpenCodeStoredPart | null {
  const raw = parseJson(data);
  if (!raw || typeof raw.type !== "string") return null;
  return {
    ...raw,
    id,
    sessionID: sessionId,
    messageID: messageId,
  } as OpenCodeStoredPart;
}
