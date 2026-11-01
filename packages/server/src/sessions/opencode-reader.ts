import { spawn } from "node:child_process";
import {
  type FileHandle,
  open,
  readFile,
  readdir,
  stat,
  unlink,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  type OpenCodeMessage,
  type OpenCodeSessionEntry,
  type OpenCodeStoredPart,
  type ProviderChildSessionSummary,
  type UrlProjectId,
  getModelContextWindow,
  truncateSessionTitle,
} from "@yep-anywhere/shared";
import { encodeProjectId } from "../projects/paths.js";
import type {
  ContextUsage,
  Message,
  SessionSummary,
} from "../supervisor/types.js";
import { normalizeSession } from "./normalization.js";
import {
  OpenCodeDbReader,
  type OpenCodeDbChildSessionRow,
  type OpenCodeDbSessionRow,
} from "./opencode-db-reader.js";
import type {
  GetSessionOptions,
  ISessionReader,
  LoadedSession,
} from "./types.js";
import { sortProviderChildSessions } from "./types.js";

/** Default OpenCode storage directory */
export const OPENCODE_STORAGE_DIR = join(
  homedir(),
  ".local",
  "share",
  "opencode",
  "storage",
);

const OPENCODE_DATA_DIR =
  process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
export const OPENCODE_DB_PATH = join(
  OPENCODE_DATA_DIR,
  "opencode",
  "opencode.db",
);
const OPENCODE_CLI_TIMEOUT_MS = 10_000;
const OPENCODE_CLI_MAX_SESSIONS = 200;
// `opencode session list` output is global (not scoped to the spawn cwd), so
// one spawn can serve every project's reader. Index validations for several
// legacy (pre-1.16, no-DB) projects land in one burst; without sharing, each
// scope paid its own 1-2s subprocess. TTL only bounds staleness between
// bursts — the periodic index revalidation re-runs it anyway.
const OPENCODE_CLI_LIST_CACHE_TTL_MS = 10_000;

/**
 * OpenCode storage directory structure:
 * ~/.local/share/opencode/storage/
 *   project/{projectId}.json        - Project metadata
 *   session/{projectId}/{sessionId}.json  - Session metadata
 *   message/{sessionId}/{messageId}.json  - Message metadata
 *   part/{messageId}/{partId}.json        - Message parts (text, tool-use, tool-result)
 */

export interface OpenCodeSessionReaderOptions {
  /** Base storage directory (e.g., ~/.local/share/opencode/storage) */
  storageDir?: string;
  /** OpenCode SQLite database path, used only as an index stat anchor. */
  databasePath?: string;
  /** OpenCode executable used for 1.15+ CLI export/list fallbacks. */
  opencodePath?: string;
  /** Project path (used to look up the OpenCode project ID) */
  projectPath: string;
}

/**
 * OpenCode JSON file schemas (simplified for reading)
 */
interface OpenCodeProjectJson {
  id: string;
  worktree: string;
  time?: {
    created?: number;
    updated?: number;
  };
}

interface OpenCodeSessionJson {
  id: string;
  version?: string;
  projectID: string;
  directory?: string;
  title?: string;
  parentID?: string;
  time?: {
    created?: number;
    updated?: number;
  };
  summary?: {
    additions?: number;
    deletions?: number;
    files?: number;
  };
}

interface OpenCodeCliListSession {
  id?: unknown;
  title?: unknown;
  directory?: unknown;
  created?: unknown;
  updated?: unknown;
  projectId?: unknown;
  projectID?: unknown;
  parentID?: unknown;
  parentId?: unknown;
}

// Shared across reader instances (one per project): the CLI list output is
// global, so any project's spawn serves them all. Keyed by the opencode
// binary path; holds the in-flight promise so concurrent validations
// coalesce onto one subprocess. Bounded by the opencode binaries in use.
const cliSessionListCache = new Map<
  string,
  { atMs: number; promise: Promise<OpenCodeCliListSession[]> }
>();

interface OpenCodeExportSessionInfo {
  id?: unknown;
  directory?: unknown;
  title?: unknown;
  projectID?: unknown;
  model?: unknown;
  time?: {
    created?: unknown;
    updated?: unknown;
  };
}

interface OpenCodeExportMessage {
  info?: unknown;
  parts?: unknown;
}

interface OpenCodeExport {
  info?: OpenCodeExportSessionInfo;
  messages?: OpenCodeExportMessage[];
}

// Use OpenCodeMessage and OpenCodeStoredPart types from shared

/**
 * Find the OpenCode project ID for a given project path by scanning project files.
 *
 * OpenCode uses an opaque hash as project ID. This function reads all project
 * JSON files and returns the ID whose worktree matches the given path.
 *
 * @param projectPath - The absolute path to the project directory
 * @param storageDir - The OpenCode storage directory (default: ~/.local/share/opencode/storage)
 * @returns The OpenCode project ID, or null if not found
 */
export async function findOpenCodeProjectId(
  projectPath: string,
  storageDir: string = OPENCODE_STORAGE_DIR,
): Promise<string | null> {
  const projectDir = join(storageDir, "project");

  try {
    const files = await readdir(projectDir);
    const jsonFiles = files.filter(
      (f) => f.endsWith(".json") && f !== "global.json",
    );

    for (const file of jsonFiles) {
      try {
        const content = await readFile(join(projectDir, file), "utf-8");
        const project = JSON.parse(content) as OpenCodeProjectJson;
        if (project.worktree === projectPath) {
          return project.id;
        }
      } catch {
        // Skip unreadable files
      }
    }
  } catch {
    // Directory doesn't exist
  }

  return null;
}

/**
 * OpenCode-specific session reader for OpenCode's file-based storage.
 *
 * OpenCode stores sessions in a directory structure rather than JSONL files:
 * - Project info in project/{id}.json
 * - Sessions in session/{projectId}/{sessionId}.json
 * - Messages in message/{sessionId}/{messageId}.json
 * - Parts (content) in part/{messageId}/{partId}.json
 */
export class OpenCodeSessionReader implements ISessionReader {
  private storageDir: string;
  private databasePath: string;
  private opencodePath: string;
  private projectPath: string;
  private openCodeProjectIdCache: string | null | undefined = undefined;
  private dbReader: OpenCodeDbReader;
  private closed = false;

  constructor(options: OpenCodeSessionReaderOptions) {
    this.storageDir = options.storageDir ?? OPENCODE_STORAGE_DIR;
    this.databasePath = options.databasePath ?? OPENCODE_DB_PATH;
    this.opencodePath = options.opencodePath ?? "opencode";
    this.projectPath = options.projectPath;
    this.dbReader = new OpenCodeDbReader(this.databasePath);
  }

  close(): void {
    this.closed = true;
    this.dbReader.close();
  }

  /**
   * Get the OpenCode project ID, looking it up lazily from storage.
   * Returns null if no OpenCode project exists for this path.
   */
  private async getOpenCodeProjectId(): Promise<string | null> {
    if (this.closed) return null;
    if (this.openCodeProjectIdCache !== undefined) {
      return this.openCodeProjectIdCache;
    }
    this.openCodeProjectIdCache = await findOpenCodeProjectId(
      this.projectPath,
      this.storageDir,
    );
    return this.openCodeProjectIdCache;
  }

  async listSessions(projectId: UrlProjectId): Promise<SessionSummary[]> {
    if (this.closed) return [];
    const summaries: SessionSummary[] = [];
    const seen = new Set<string>();

    // OpenCode 1.16+: the DB is authoritative and the CLI `session list` reads
    // the same store, so when the DB has this project we enumerate from it and
    // skip the subprocess. The CLI stays a legacy fallback for pre-1.16 / no-DB.
    const dbProjectId = await this.dbReader.getProjectId(this.projectPath);
    if (this.closed) return [];

    if (dbProjectId) {
      for (const summary of await this.listDbSessions(projectId)) {
        summaries.push(summary);
        seen.add(summary.id);
      }
    }

    if (this.closed) return [];
    for (const summary of await this.listFileSessions(projectId)) {
      if (seen.has(summary.id)) continue;
      summaries.push(summary);
      seen.add(summary.id);
    }

    if (!dbProjectId && !this.closed) {
      for (const summary of await this.listCliSessions(projectId)) {
        if (seen.has(summary.id)) continue;
        summaries.push(summary);
        seen.add(summary.id);
      }
    }

    // Sort by updatedAt descending
    summaries.sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );

    return summaries;
  }

  async getSessionSummary(
    sessionId: string,
    projectId: UrlProjectId,
  ): Promise<SessionSummary | null> {
    if (this.closed) return null;
    const database = await this.getDbSessionSummary(sessionId, projectId);
    if (database || this.closed) return database;
    const file = await this.getFileSessionSummary(sessionId, projectId);
    if (file || this.closed) return file;
    return this.getCliSessionSummary(sessionId, projectId);
  }

  async getSession(
    sessionId: string,
    projectId: UrlProjectId,
    afterMessageId?: string,
    options?: GetSessionOptions,
  ): Promise<LoadedSession | null> {
    const loaded = await this.loadSessionFromSources(
      sessionId,
      projectId,
      afterMessageId,
    );
    return loaded && options?.ownedTurnInProgress
      ? withoutUnfinishedAssistantTail(loaded)
      : loaded;
  }

  private async loadSessionFromSources(
    sessionId: string,
    projectId: UrlProjectId,
    afterMessageId?: string,
  ): Promise<LoadedSession | null> {
    if (this.closed) return null;
    const fromDb = await this.loadDbSession(
      sessionId,
      projectId,
      afterMessageId,
    );
    if (fromDb || this.closed) return fromDb;

    const fileSummary = await this.getFileSessionSummary(sessionId, projectId);
    if (this.closed) return null;
    if (fileSummary) {
      const messages = await this.loadSessionMessages(
        sessionId,
        afterMessageId,
      );
      return {
        summary: fileSummary,
        transcriptSnapshotUpdatedAt: fileSummary.updatedAt,
        data: {
          provider: "opencode",
          session: {
            messages,
          },
        },
      };
    }

    const exported = await this.loadCliExport(sessionId);
    if (!exported || !this.exportBelongsToProject(exported)) return null;
    const entries = this.exportMessagesToEntries(exported, afterMessageId);
    if (entries.length === 0) return null;
    const summary = this.summaryFromExport(exported, entries, projectId);
    if (!summary) return null;

    return {
      summary,
      transcriptSnapshotUpdatedAt: summary.updatedAt,
      data: {
        provider: "opencode",
        session: {
          messages: entries,
        },
      },
    };
  }

  async getSessionSummaryIfChanged(
    sessionId: string,
    projectId: UrlProjectId,
    cachedMtime: number,
    cachedSize: number,
  ): Promise<{ summary: SessionSummary; mtime: number; size: number } | null> {
    if (this.closed) return null;
    const dbChanged = await this.getDbSessionSummaryIfChanged(
      sessionId,
      projectId,
      cachedMtime,
      cachedSize,
    );
    if (this.closed) return null;
    if (dbChanged === "unchanged") {
      // The session exists in the DB and its row matches the cache. Without
      // this terminal, an unchanged DB session fell through to the file-tree
      // check (no json file for DB sessions) and then a per-session CLI
      // spawn — on every index validation.
      return null;
    }
    if (dbChanged) {
      return dbChanged;
    }

    const fileChanged = await this.getFileSessionSummaryIfChanged(
      sessionId,
      projectId,
      cachedMtime,
      cachedSize,
    );
    if (this.closed) return null;
    if (fileChanged) {
      return fileChanged;
    }

    // Legacy CLI sessions: probe freshness from the (shared, cached) session
    // list rather than a per-session `opencode export` spawn — the list row's
    // updated-time is the same signal at 1/Nth the subprocesses. The stored
    // summary matches what listCliSessions builds from the same row.
    const cliSessions = await this.loadCliSessionList();
    const cliRow = cliSessions.find(
      (session) =>
        this.stringField(session.id) === sessionId &&
        this.cliListSessionBelongsToProject(session),
    );
    if (!cliRow) return null;

    const summary = this.summaryFromCliListSession(cliRow, projectId);
    if (!summary) return null;

    const mtime = Date.parse(summary.updatedAt);
    const size = summary.messageCount;
    if (mtime === cachedMtime && size === cachedSize) {
      return null;
    }

    return { summary, mtime, size };
  }

  async getSessionFilePath(_sessionId: string): Promise<string | null> {
    return this.closed ? null : this.databasePath;
  }

  async listSessionFiles(
    _sessionDir: string,
    options?: { activeAfterMs?: number },
  ): Promise<
    { sessionId: string; filePath: string; sharedFilePath?: boolean }[]
  > {
    if (this.closed) return [];
    const out: {
      sessionId: string;
      filePath: string;
      sharedFilePath?: boolean;
    }[] = [];
    const seen = new Set<string>();

    // DB sessions (OpenCode 1.16+) are the primary durable source. Enumerate
    // them straight from the `session` table rather than the CLI `session list`,
    // using the db path as the index anchor (the index then stats nothing
    // per-session; change detection runs through getSessionSummaryIfChanged,
    // which compares the row's time_updated + message count).
    const dbProjectId = await this.dbReader.getProjectId(this.projectPath);
    const childIds = await this.collectProviderChildIds();
    if (dbProjectId) {
      for (const { id, timeUpdated } of await this.dbReader.listSessionRows(
        dbProjectId,
      )) {
        if (seen.has(id) || childIds.has(id)) continue;
        if (
          options?.activeAfterMs !== undefined &&
          timeUpdated < options.activeAfterMs
        ) {
          continue;
        }
        out.push({
          sessionId: id,
          filePath: this.databasePath,
          sharedFilePath: true,
        });
        seen.add(id);
      }
    }

    // File-storage sessions: storage/session/{openCodeProjectId}/*.json.
    // These are the bulk of OpenCode sessions. The session index enumerates via
    // this method (not listSessions), so omitting file sessions here meant they
    // never appeared in project listings even though listSessions returns them.
    // Use the session json path as filePath so the index gets per-session mtime.
    const openCodeProjectId = await this.getOpenCodeProjectId();
    if (openCodeProjectId) {
      const sessionDir = join(this.storageDir, "session", openCodeProjectId);
      try {
        for (const file of await readdir(sessionDir)) {
          if (!file.endsWith(".json")) continue;
          const sessionId = file.replace(".json", "");
          if (seen.has(sessionId) || childIds.has(sessionId)) continue;
          const stored = await this.readFileSessionJson(sessionId);
          if (stored?.parentID) continue;
          out.push({ sessionId, filePath: join(sessionDir, file) });
          seen.add(sessionId);
        }
      } catch {
        // Session dir missing/unreadable — fall through to CLI sessions.
      }
    }

    // CLI-listed sessions: legacy fallback only. With a 1.16+ DB present the
    // CLI `session list` reads the same store, so enumerating it would just
    // re-spawn the subprocess for rows the DB already returned. Run it only when
    // the DB has no project for this worktree (pre-1.16 / no DB).
    if (!dbProjectId) {
      const cliSessions = await this.loadCliSessionList();
      for (const session of cliSessions) {
        if (!this.cliListSessionBelongsToProject(session)) continue;
        const sessionId = String(session.id);
        if (seen.has(sessionId) || this.cliListSessionParentId(session)) {
          continue;
        }
        if (options?.activeAfterMs !== undefined) {
          const updatedAt = this.numberField(session.updated);
          if (updatedAt !== undefined && updatedAt < options.activeAfterMs) {
            continue;
          }
        }
        out.push({
          sessionId,
          filePath: this.databasePath,
          sharedFilePath: true,
        });
        seen.add(sessionId);
      }
    }

    return out;
  }

  getIndexScopeKey(_sessionDir: string): string {
    return `opencode::${this.projectPath}`;
  }

  private async collectProviderChildIds(): Promise<Set<string>> {
    const ids = new Set(await this.dbReader.listChildSessionIds());
    const openCodeProjectId = await this.getOpenCodeProjectId();
    if (!openCodeProjectId) return ids;
    const sessionDir = join(this.storageDir, "session", openCodeProjectId);
    try {
      for (const file of await readdir(sessionDir)) {
        if (!file.endsWith(".json")) continue;
        const sessionId = file.replace(/\.json$/, "");
        const stored = await this.readFileSessionJson(sessionId);
        if (stored?.parentID) ids.add(sessionId);
      }
    } catch {
      // Session dir missing/unreadable — DB ids still apply.
    }
    return ids;
  }

  private async listFileProviderChildSessions(
    parentSessionId: string,
  ): Promise<ProviderChildSessionSummary[]> {
    const openCodeProjectId = await this.getOpenCodeProjectId();
    if (!openCodeProjectId) return [];
    const sessionDir = join(this.storageDir, "session", openCodeProjectId);
    const children: ProviderChildSessionSummary[] = [];
    try {
      for (const file of await readdir(sessionDir)) {
        if (!file.endsWith(".json")) continue;
        const sessionId = file.replace(/\.json$/, "");
        const stored = await this.readFileSessionJson(sessionId);
        if (!stored || stored.parentID !== parentSessionId) continue;
        children.push(
          childSummaryFromFileSession(parentSessionId, sessionId, stored),
        );
      }
    } catch {
      return [];
    }
    return children;
  }

  private async listFileTaskChildMappings(
    parentSessionId: string,
  ): Promise<{ toolUseId: string; agentId: string }[]> {
    const entries = await this.loadSessionMessages(parentSessionId);
    const mappings: { toolUseId: string; agentId: string }[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
      for (const part of entry.parts) {
        if (part.tool !== "task") continue;
        const agentId = childSessionIdFromStoredTaskPart(part);
        if (!agentId) continue;
        const toolUseIds = [part.callID, part.id].filter(
          (id): id is string => typeof id === "string" && id.length > 0,
        );
        for (const toolUseId of toolUseIds) {
          const key = `${toolUseId}\0${agentId}`;
          if (seen.has(key)) continue;
          seen.add(key);
          mappings.push({ toolUseId, agentId });
        }
      }
    }
    return mappings;
  }

  private async readFileSessionJson(
    sessionId: string,
  ): Promise<OpenCodeSessionJson | null> {
    const openCodeProjectId = await this.getOpenCodeProjectId();
    if (!openCodeProjectId) return null;
    try {
      const content = await readFile(
        join(
          this.storageDir,
          "session",
          openCodeProjectId,
          `${sessionId}.json`,
        ),
        "utf-8",
      );
      return JSON.parse(content) as OpenCodeSessionJson;
    } catch {
      return null;
    }
  }

  private cliListSessionParentId(
    session: OpenCodeCliListSession,
  ): string | undefined {
    return (
      this.stringField(session.parentID) ?? this.stringField(session.parentId)
    );
  }

  private async listFileSessions(
    projectId: UrlProjectId,
  ): Promise<SessionSummary[]> {
    const openCodeProjectId = await this.getOpenCodeProjectId();
    if (!openCodeProjectId) {
      return [];
    }

    const summaries: SessionSummary[] = [];
    const sessionDir = join(this.storageDir, "session", openCodeProjectId);

    try {
      const files = await readdir(sessionDir);
      const jsonFiles = files.filter((f) => f.endsWith(".json"));

      for (const file of jsonFiles) {
        const sessionId = file.replace(".json", "");
        const stored = await this.readFileSessionJson(sessionId);
        if (stored?.parentID) continue;
        const summary = await this.getFileSessionSummary(sessionId, projectId);
        if (summary) {
          summaries.push(summary);
        }
      }
    } catch {
      // Directory doesn't exist or not readable
      return [];
    }

    // Sort by updatedAt descending
    summaries.sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );

    return summaries;
  }

  private async getFileSessionSummary(
    sessionId: string,
    projectId: UrlProjectId,
  ): Promise<SessionSummary | null> {
    const openCodeProjectId = await this.getOpenCodeProjectId();
    if (!openCodeProjectId) {
      return null;
    }

    const sessionPath = join(
      this.storageDir,
      "session",
      openCodeProjectId,
      `${sessionId}.json`,
    );

    try {
      const content = await readFile(sessionPath, "utf-8");
      const session = JSON.parse(content) as OpenCodeSessionJson;

      // Get message count and first user message for title
      const messageDir = join(this.storageDir, "message", sessionId);
      let messageCount = 0;
      let firstUserMessageText: string | null = null;
      let model: string | undefined;

      try {
        const messageFiles = await readdir(messageDir);
        const jsonFiles = messageFiles.filter((f) => f.endsWith(".json"));
        messageCount = jsonFiles.length;

        // Sort by filename (which contains timestamp) to get chronological order
        jsonFiles.sort();

        // Find first user message and model
        for (const file of jsonFiles) {
          const msgPath = join(messageDir, file);
          try {
            const msgContent = await readFile(msgPath, "utf-8");
            const msg = JSON.parse(msgContent) as OpenCodeMessage;

            // Track the latest assistant model (a session's model can
            // change mid-transcript); files iterate in chronological order.
            if (msg.role === "assistant" && msg.modelID) {
              model =
                this.canonicalModelId(msg.providerID, msg.modelID) ??
                msg.modelID;
            }

            // Get first user message text
            if (!firstUserMessageText && msg.role === "user") {
              const text = await this.getMessageText(msg.id);
              if (text) {
                firstUserMessageText = text;
              }
            }

            // Stop if we have both
            if (model && firstUserMessageText) break;
          } catch {
            // Skip unreadable messages
          }
        }
      } catch {
        // No messages yet
      }

      // Skip sessions with no messages
      if (messageCount === 0) {
        return null;
      }

      const stats = await stat(sessionPath);
      const contextUsage = await this.extractContextUsage(sessionId, model);

      // Use session title if available, otherwise first user message
      const fullTitle = session.title || firstUserMessageText?.trim() || null;

      return {
        id: sessionId,
        projectId,
        title: this.truncateTitle(fullTitle),
        fullTitle,
        createdAt: session.time?.created
          ? new Date(session.time.created).toISOString()
          : stats.birthtime.toISOString(),
        updatedAt: session.time?.updated
          ? new Date(session.time.updated).toISOString()
          : stats.mtime.toISOString(),
        messageCount,
        ownership: { owner: "none" }, // Will be updated by Supervisor
        contextUsage,
        provider: "opencode",
        model,
      };
    } catch {
      return null;
    }
  }

  private async getFileSessionSummaryIfChanged(
    sessionId: string,
    projectId: UrlProjectId,
    cachedMtime: number,
    cachedSize: number,
  ): Promise<{ summary: SessionSummary; mtime: number; size: number } | null> {
    const openCodeProjectId = await this.getOpenCodeProjectId();
    if (!openCodeProjectId) {
      return null;
    }

    const sessionPath = join(
      this.storageDir,
      "session",
      openCodeProjectId,
      `${sessionId}.json`,
    );

    try {
      const stats = await stat(sessionPath);
      const mtime = stats.mtimeMs;
      const size = stats.size;

      // If mtime and size match cached values, return null (no change)
      if (mtime === cachedMtime && size === cachedSize) {
        return null;
      }

      // Otherwise parse the file and return { summary, mtime, size }
      const summary = await this.getFileSessionSummary(sessionId, projectId);
      if (!summary) return null;

      return { summary, mtime, size };
    } catch {
      return null;
    }
  }

  /**
   * Load a session straight from `opencode.db` — the authoritative durable
   * source for OpenCode 1.16+ and the only one that does not spawn a subprocess
   * or depend on the (frozen) JSON file tree. Returns null when the DB is
   * absent, the session is not in this project, or sqlite is unavailable
   * (Node < 22.5), so callers fall through to the file-tree and CLI-export
   * readers. The summary always reflects the whole session even when
   * `afterMessageId` pages the returned messages.
   */
  private async loadDbSession(
    sessionId: string,
    projectId: UrlProjectId,
    afterMessageId?: string,
  ): Promise<LoadedSession | null> {
    const projectIdHash = await this.dbReader.getProjectId(this.projectPath);
    if (!projectIdHash) return null;

    const row = await this.dbReader.getSessionRow(sessionId, projectIdHash);
    // Skip empty sessions (0 messages) so an unstarted session falls through to
    // the same null the file path returns, rather than rendering blank.
    if (!row || row.messageCount === 0) return null;

    const entries = await this.dbReader.loadEntries(sessionId, afterMessageId);
    if (entries === null) return null;

    const summary = await this.buildDbSummary(row, projectId);

    return {
      summary,
      transcriptSnapshotUpdatedAt: this.dateFromMillis(
        row.timeUpdated ?? undefined,
      ),
      data: {
        provider: "opencode",
        session: { messages: entries },
      },
    };
  }

  private async getDbSessionSummary(
    sessionId: string,
    projectId: UrlProjectId,
  ): Promise<SessionSummary | null> {
    const projectIdHash = await this.dbReader.getProjectId(this.projectPath);
    if (!projectIdHash) return null;
    const row = await this.dbReader.getSessionRow(sessionId, projectIdHash);
    if (!row || row.messageCount === 0) return null;
    return this.buildDbSummary(row, projectId);
  }

  /**
   * Change detection for DB sessions. Unlike the file path (which stats one
   * per-session JSON file), every DB session shares a single `opencode.db`, so
   * the db-file mtime over-triggers. Compare the session row's `time_updated`
   * and message count instead — carried as the index's (mtime, size) pair, the
   * same convention the CLI fallback uses.
   */
  /**
   * DB-row change check. Returns "unchanged" as a terminal answer (the
   * session is in the DB and needs no re-summarize), a changed summary, or
   * null only when the DB cannot answer for this session at all — only then
   * may callers fall through to the file-tree / CLI readers.
   */
  private async getDbSessionSummaryIfChanged(
    sessionId: string,
    projectId: UrlProjectId,
    cachedMtime: number,
    cachedSize: number,
  ): Promise<
    | { summary: SessionSummary; mtime: number; size: number }
    | "unchanged"
    | null
  > {
    const projectIdHash = await this.dbReader.getProjectId(this.projectPath);
    if (!projectIdHash) return null;

    const meta = await this.dbReader.getSessionMeta(sessionId, projectIdHash);
    if (!meta) return null;
    // An empty DB session summarizes to nothing; treat it as unchanged
    // rather than "not in the DB" so it never triggers the CLI fallback.
    if (meta.messageCount === 0) return "unchanged";

    if (meta.timeUpdated === cachedMtime && meta.messageCount === cachedSize) {
      return "unchanged";
    }

    const summary = await this.getDbSessionSummary(sessionId, projectId);
    // The row exists but yielded no summary (e.g. deleted mid-read): the DB
    // is still authoritative for this session, so stay terminal.
    if (!summary) return "unchanged";

    return { summary, mtime: meta.timeUpdated, size: meta.messageCount };
  }

  /**
   * Build a SessionSummary from a DB session row plus cheap targeted lookups
   * (first user text for the title fallback; last assistant tokens for context
   * usage), so a summary never loads the full part list.
   */
  private async buildDbSummary(
    row: OpenCodeDbSessionRow,
    projectId: UrlProjectId,
  ): Promise<SessionSummary> {
    const model = this.canonicalModelId(
      row.model?.providerID,
      row.model?.id ?? row.model?.modelID,
    );

    const dbTitle = row.title?.trim() || null;
    const firstUserText =
      !dbTitle || dbTitle === "Yep Anywhere Session"
        ? await this.dbReader.loadFirstUserText(row.id)
        : null;
    const fullTitle =
      dbTitle && dbTitle !== "Yep Anywhere Session"
        ? dbTitle
        : (firstUserText ?? dbTitle);

    const tokens = await this.dbReader.loadLastAssistantTokens(row.id);

    return {
      id: row.id,
      projectId,
      title: this.truncateTitle(fullTitle),
      fullTitle,
      createdAt: this.dateFromMillis(row.timeCreated ?? undefined),
      updatedAt: this.dateFromMillis(row.timeUpdated ?? undefined),
      messageCount: row.messageCount,
      ownership: { owner: "none" },
      contextUsage: this.contextUsageFromTokens(tokens ?? undefined, model),
      provider: "opencode",
      model,
    };
  }

  private async listDbSessions(
    projectId: UrlProjectId,
  ): Promise<SessionSummary[]> {
    const projectIdHash = await this.dbReader.getProjectId(this.projectPath);
    if (!projectIdHash) return [];

    const rows = await this.dbReader.listSessionRows(projectIdHash);
    const childIds = new Set(
      await this.dbReader.listChildSessionIds(projectIdHash),
    );
    const summaries: SessionSummary[] = [];
    for (const { id } of rows) {
      if (childIds.has(id)) continue;
      const summary = await this.getDbSessionSummary(id, projectId);
      if (summary) summaries.push(summary);
    }
    return summaries;
  }

  private async listCliSessions(
    projectId: UrlProjectId,
  ): Promise<SessionSummary[]> {
    const sessions = await this.loadCliSessionList();
    const summaries: SessionSummary[] = [];

    for (const session of sessions) {
      if (!this.cliListSessionBelongsToProject(session)) continue;
      if (this.cliListSessionParentId(session)) continue;
      const summary = this.summaryFromCliListSession(session, projectId);
      if (summary) summaries.push(summary);
    }

    return summaries;
  }

  private async getCliSessionSummary(
    sessionId: string,
    projectId: UrlProjectId,
  ): Promise<SessionSummary | null> {
    const exported = await this.loadCliExport(sessionId);
    if (!exported || !this.exportBelongsToProject(exported)) return null;

    const entries = this.exportMessagesToEntries(exported);
    if (entries.length === 0) return null;

    return this.summaryFromExport(exported, entries, projectId);
  }

  private async loadCliSessionList(): Promise<OpenCodeCliListSession[]> {
    if (this.closed) return [];
    const cached = cliSessionListCache.get(this.opencodePath);
    if (cached && Date.now() - cached.atMs < OPENCODE_CLI_LIST_CACHE_TTL_MS) {
      return cached.promise;
    }
    const promise = this.spawnCliSessionList();
    cliSessionListCache.set(this.opencodePath, {
      atMs: Date.now(),
      promise,
    });
    return promise;
  }

  private async spawnCliSessionList(): Promise<OpenCodeCliListSession[]> {
    const output = await this.runOpenCodeCli([
      "session",
      "list",
      "--format",
      "json",
      "--max-count",
      String(OPENCODE_CLI_MAX_SESSIONS),
    ]);
    if (!output) return [];

    const parsed = this.parseJsonOutput(output);
    if (!Array.isArray(parsed)) return [];

    return parsed.filter((value): value is OpenCodeCliListSession => {
      if (!value || typeof value !== "object") return false;
      return Boolean(this.stringField((value as OpenCodeCliListSession).id));
    });
  }

  private async loadCliExport(
    sessionId: string,
  ): Promise<OpenCodeExport | null> {
    const output = await this.runOpenCodeCli(["export", sessionId]);
    if (!output) return null;

    const parsed = this.parseJsonOutput(output);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }

    return parsed as OpenCodeExport;
  }

  private async runOpenCodeCli(args: string[]): Promise<string | null> {
    if (this.closed) return null;
    // Capture stdout into a real file fd, not a pipe. `opencode` is a Bun
    // binary that drops buffered piped stdout on process.exit() once it
    // exceeds the kernel pipe buffer, so large `export` JSON was truncated
    // mid-string (execFile) and failed to parse — blanking session reload.
    // A regular file fd is lossless. See topics/opencode-backend.md
    // "Durable Storage Format".
    const tmpFile = join(
      tmpdir(),
      `ya-opencode-${process.pid}-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2)}.json`,
    );
    let handle: FileHandle | undefined;
    try {
      handle = await open(tmpFile, "w");
    } catch {
      return null;
    }

    try {
      if (this.closed) return null;
      const fd = handle.fd;
      const exitedOk = await new Promise<boolean>((resolve) => {
        const child = spawn(this.opencodePath, args, {
          cwd: this.projectPath,
          stdio: ["ignore", fd, "ignore"],
          windowsHide: true,
        });
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve(false);
        }, OPENCODE_CLI_TIMEOUT_MS);
        child.on("error", () => {
          clearTimeout(timer);
          resolve(false);
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve(code === 0);
        });
      });

      await handle.close();
      handle = undefined;

      if (!exitedOk) return null;
      return await readFile(tmpFile, "utf8");
    } catch {
      return null;
    } finally {
      if (handle) {
        await handle.close().catch(() => {});
      }
      await unlink(tmpFile).catch(() => {});
    }
  }

  private parseJsonOutput(output: string): unknown {
    const trimmed = output.trim();
    const objectStart = trimmed.indexOf("{");
    const arrayStart = trimmed.indexOf("[");
    const starts = [objectStart, arrayStart].filter((index) => index >= 0);
    if (starts.length === 0) return null;
    const jsonStart = Math.min(...starts);

    try {
      return JSON.parse(trimmed.slice(jsonStart));
    } catch {
      return null;
    }
  }

  private cliListSessionBelongsToProject(
    session: OpenCodeCliListSession,
  ): boolean {
    const directory = this.stringField(session.directory);
    return !directory || directory === this.projectPath;
  }

  private exportBelongsToProject(exported: OpenCodeExport): boolean {
    const directory = this.stringField(exported.info?.directory);
    return !directory || directory === this.projectPath;
  }

  private exportMessagesToEntries(
    exported: OpenCodeExport,
    afterMessageId?: string,
  ): OpenCodeSessionEntry[] {
    const messages = Array.isArray(exported.messages) ? exported.messages : [];
    const entries: OpenCodeSessionEntry[] = [];
    let foundAfterMessage = !afterMessageId;

    for (const exportedMessage of messages) {
      const message = this.asOpenCodeMessage(exportedMessage.info);
      if (!message) continue;

      if (!foundAfterMessage) {
        if (message.id === afterMessageId) {
          foundAfterMessage = true;
        }
        continue;
      }

      const parts = Array.isArray(exportedMessage.parts)
        ? exportedMessage.parts
            .map((part) => this.asOpenCodeStoredPart(part))
            .filter((part): part is OpenCodeStoredPart => Boolean(part))
        : [];
      entries.push({ message, parts });
    }

    return entries;
  }

  private asOpenCodeMessage(value: unknown): OpenCodeMessage | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    const raw = value as Record<string, unknown>;
    const id = this.stringField(raw.id);
    const role = this.stringField(raw.role);
    if (!id || (role !== "user" && role !== "assistant")) {
      return null;
    }
    const sessionID =
      this.stringField(raw.sessionID) ??
      this.stringField(raw.sessionId) ??
      this.stringField(raw.session_id) ??
      "";

    return {
      ...raw,
      id,
      sessionID,
      role,
    } as OpenCodeMessage;
  }

  private asOpenCodeStoredPart(value: unknown): OpenCodeStoredPart | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    const raw = value as Record<string, unknown>;
    const type = this.stringField(raw.type);
    if (!type) return null;
    return raw as OpenCodeStoredPart;
  }

  private summaryFromCliListSession(
    session: OpenCodeCliListSession,
    projectId: UrlProjectId,
  ): SessionSummary | null {
    const id = this.stringField(session.id);
    if (!id) return null;

    const title = this.stringField(session.title)?.trim() || null;
    const updatedAt = this.dateFromMillis(
      this.numberField(session.updated) ?? this.numberField(session.created),
    );
    const createdAt = this.dateFromMillis(
      this.numberField(session.created) ?? this.numberField(session.updated),
    );

    return {
      id,
      projectId,
      title: this.truncateTitle(title),
      fullTitle: title,
      createdAt,
      updatedAt,
      messageCount: 1,
      ownership: { owner: "none" },
      provider: "opencode",
    };
  }

  private summaryFromExport(
    exported: OpenCodeExport,
    entries: OpenCodeSessionEntry[],
    projectId: UrlProjectId,
  ): SessionSummary | null {
    const id =
      this.stringField(exported.info?.id) ??
      entries.find((entry) => entry.message.sessionID)?.message.sessionID;
    if (!id) return null;

    const exportTitle = this.stringField(exported.info?.title)?.trim() || null;
    const firstUserText = this.firstUserText(entries);
    const fullTitle =
      exportTitle && exportTitle !== "Yep Anywhere Session"
        ? exportTitle
        : (firstUserText ?? exportTitle);
    const model = this.modelFromExport(exported, entries);
    const createdAt = this.dateFromMillis(
      this.numberField(exported.info?.time?.created) ??
        entries[0]?.message.time?.created,
    );
    const lastMessage = entries[entries.length - 1]?.message;
    const updatedAt = this.dateFromMillis(
      this.numberField(exported.info?.time?.updated) ??
        lastMessage?.time?.completed ??
        lastMessage?.time?.created,
    );

    return {
      id,
      projectId,
      title: this.truncateTitle(fullTitle),
      fullTitle,
      createdAt,
      updatedAt,
      messageCount: entries.length,
      ownership: { owner: "none" },
      contextUsage: this.extractContextUsageFromEntries(entries, model),
      provider: "opencode",
      model,
    };
  }

  private firstUserText(entries: OpenCodeSessionEntry[]): string | null {
    for (const entry of entries) {
      if (entry.message.role !== "user") continue;
      for (const part of entry.parts) {
        if (part.type === "text" && part.text?.trim()) {
          return part.text.trim();
        }
      }
    }
    return null;
  }

  private modelFromExport(
    exported: OpenCodeExport,
    entries: OpenCodeSessionEntry[],
  ): string | undefined {
    const model = exported.info?.model;
    if (typeof model === "string" && model.trim()) {
      return model.trim();
    }
    if (model && typeof model === "object" && !Array.isArray(model)) {
      const raw = model as Record<string, unknown>;
      const canonical = this.canonicalModelId(
        raw.providerID,
        this.stringField(raw.id) ?? this.stringField(raw.modelID),
      );
      if (canonical) return canonical;
    }

    for (const entry of entries) {
      if (entry.message.role !== "assistant") continue;
      const nested =
        entry.message.model &&
        typeof entry.message.model === "object" &&
        !Array.isArray(entry.message.model)
          ? (entry.message.model as Record<string, unknown>)
          : undefined;
      const canonical = this.canonicalModelId(
        entry.message.providerID ?? nested?.providerID,
        entry.message.modelID ?? this.stringField(nested?.modelID),
      );
      if (canonical) return canonical;
    }

    return undefined;
  }

  /**
   * Canonical OpenCode model id as `providerID/modelID` — the form
   * `opencode models` prints and `parseOpenCodeModelSelection` requires.
   * A reload must not drop the provider prefix, or the next turn fails with
   * `OpenCode model must use provider/model format`. modelID may itself
   * contain slashes (e.g. `local-glm/Qwen/Qwen3.6-27B`); only the first
   * slash separates provider from model, so a present prefix is preserved.
   */
  private canonicalModelId(
    providerID: unknown,
    modelID: unknown,
  ): string | undefined {
    const mid = this.stringField(modelID);
    if (!mid) return undefined;
    const pid = this.stringField(providerID);
    if (!pid || mid.startsWith(`${pid}/`)) return mid;
    return `${pid}/${mid}`;
  }

  private extractContextUsageFromEntries(
    entries: OpenCodeSessionEntry[],
    model: string | undefined,
  ): ContextUsage | undefined {
    for (const entry of [...entries].reverse()) {
      const msg = entry.message;
      if (msg.role !== "assistant") continue;
      const usage = this.contextUsageFromTokens(msg.tokens, model);
      if (usage) return usage;
    }

    return undefined;
  }

  /**
   * Context-window fill from an assistant message's token counts — input plus
   * cache-read represents the prompt size carried into the next turn. Shared by
   * the entries scan (file/export paths) and the DB path's last-assistant probe.
   */
  private contextUsageFromTokens(
    tokens: OpenCodeMessage["tokens"] | undefined,
    model: string | undefined,
  ): ContextUsage | undefined {
    if (!tokens) return undefined;
    const inputTokens = (tokens.input ?? 0) + (tokens.cache?.read ?? 0);
    if (inputTokens === 0) return undefined;

    const contextWindowSize = getModelContextWindow(model);
    const result: ContextUsage = {
      inputTokens,
      percentage: Math.round((inputTokens / contextWindowSize) * 100),
      contextWindow: contextWindowSize,
    };
    if (tokens.output !== undefined && tokens.output > 0) {
      result.outputTokens = tokens.output;
    }
    if (tokens.cache?.read !== undefined && tokens.cache.read > 0) {
      result.cacheReadTokens = tokens.cache.read;
    }
    return result;
  }

  private stringField(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value : undefined;
  }

  private numberField(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value)
      ? value
      : undefined;
  }

  private dateFromMillis(value: number | undefined): string {
    if (value !== undefined) {
      const date = new Date(value);
      if (Number.isFinite(date.getTime())) {
        return date.toISOString();
      }
    }
    return new Date(0).toISOString();
  }

  async listProviderChildSessions(
    parentSessionId: string,
  ): Promise<ProviderChildSessionSummary[]> {
    if (this.closed) return [];
    const byId = new Map<string, ProviderChildSessionSummary>();
    const projectIdHash = await this.dbReader.getProjectId(this.projectPath);
    if (projectIdHash) {
      for (const row of await this.dbReader.listChildSessionRows(
        projectIdHash,
        parentSessionId,
      )) {
        byId.set(row.id, childSummaryFromDbRow(parentSessionId, row));
      }
    }
    for (const child of await this.listFileProviderChildSessions(
      parentSessionId,
    )) {
      if (!byId.has(child.id)) byId.set(child.id, child);
    }
    return sortProviderChildSessions([...byId.values()]);
  }

  async getAgentMappings(
    parentSessionId?: string,
  ): Promise<{ toolUseId: string; agentId: string }[]> {
    if (this.closed || !parentSessionId) return [];
    const byToolUseId = new Map<string, string>();
    for (const mapping of await this.dbReader.listTaskChildMappings(
      parentSessionId,
    )) {
      byToolUseId.set(mapping.toolUseId, mapping.agentId);
    }
    for (const mapping of await this.listFileTaskChildMappings(
      parentSessionId,
    )) {
      if (!byToolUseId.has(mapping.toolUseId)) {
        byToolUseId.set(mapping.toolUseId, mapping.agentId);
      }
    }
    return [...byToolUseId.entries()].map(([toolUseId, agentId]) => ({
      toolUseId,
      agentId,
    }));
  }

  async getAgentSession(
    agentId: string,
    parentSessionId?: string,
  ): Promise<{ messages: Message[]; status: string } | null> {
    if (parentSessionId) {
      const children = await this.listProviderChildSessions(parentSessionId);
      if (!children.some((child) => child.id === agentId)) return null;
    }
    const loaded = await this.getSession(
      agentId,
      encodeProjectId(this.projectPath),
    );
    if (!loaded) return null;
    const session = normalizeSession(loaded);
    return {
      messages: session.messages.map((message) => ({
        ...message,
        isSubagent: true,
      })),
      status: session.messages.length > 0 ? "completed" : "pending",
    };
  }

  /**
   * Load all messages for a session, optionally after a specific message ID.
   */
  private async loadSessionMessages(
    sessionId: string,
    afterMessageId?: string,
  ): Promise<OpenCodeSessionEntry[]> {
    if (this.closed) return [];
    const messageDir = join(this.storageDir, "message", sessionId);
    const messages: OpenCodeSessionEntry[] = [];

    try {
      const messageFiles = await readdir(messageDir);
      const jsonFiles = messageFiles.filter((f) => f.endsWith(".json"));

      // Sort by filename to get chronological order
      jsonFiles.sort();

      let foundAfterMessage = !afterMessageId;

      for (const file of jsonFiles) {
        const messageId = file.replace(".json", "");

        // Skip messages until we find afterMessageId
        if (!foundAfterMessage) {
          if (messageId === afterMessageId) {
            foundAfterMessage = true;
          }
          continue;
        }

        const entry = await this.loadMessageEntry(messageDir, file);
        if (entry) {
          messages.push(entry);
        }
      }
    } catch {
      // Directory doesn't exist or not readable
    }

    return messages;
  }

  /**
   * Load a single message with its parts as an OpenCodeSessionEntry.
   */
  private async loadMessageEntry(
    messageDir: string,
    file: string,
  ): Promise<OpenCodeSessionEntry | null> {
    try {
      const msgPath = join(messageDir, file);
      const content = await readFile(msgPath, "utf-8");
      const message = JSON.parse(content) as OpenCodeMessage;

      // Load parts for this message
      const parts = await this.loadMessageParts(message.id);

      return { message, parts };
    } catch {
      return null;
    }
  }

  /**
   * Load all parts for a message.
   */
  private async loadMessageParts(
    messageId: string,
  ): Promise<OpenCodeStoredPart[]> {
    const partDir = join(this.storageDir, "part", messageId);
    const parts: OpenCodeStoredPart[] = [];

    try {
      const partFiles = await readdir(partDir);
      const jsonFiles = partFiles.filter((f) => f.endsWith(".json"));

      // Sort by filename to get chronological order
      jsonFiles.sort();

      for (const file of jsonFiles) {
        try {
          const partPath = join(partDir, file);
          const content = await readFile(partPath, "utf-8");
          const part = JSON.parse(content) as OpenCodeStoredPart;
          parts.push(part);
        } catch {
          // Skip unreadable parts
        }
      }
    } catch {
      // No parts directory
    }

    return parts;
  }

  /**
   * Get the text content of a message by loading its parts.
   */
  private async getMessageText(messageId: string): Promise<string | null> {
    const parts = await this.loadMessageParts(messageId);

    for (const part of parts) {
      if (part.type === "text" && part.text) {
        return part.text;
      }
    }

    return null;
  }

  /**
   * Extract context usage from the last assistant message's tokens.
   *
   * @param sessionId - Session ID to extract usage from
   * @param model - Model ID for determining context window size
   */
  private async extractContextUsage(
    sessionId: string,
    model: string | undefined,
  ): Promise<ContextUsage | undefined> {
    const contextWindowSize = getModelContextWindow(model);
    const messageDir = join(this.storageDir, "message", sessionId);

    try {
      const messageFiles = await readdir(messageDir);
      const jsonFiles = messageFiles.filter((f) => f.endsWith(".json"));

      // Sort and reverse to get most recent first
      jsonFiles.sort().reverse();

      for (const file of jsonFiles) {
        try {
          const msgPath = join(messageDir, file);
          const content = await readFile(msgPath, "utf-8");
          const msg = JSON.parse(content) as OpenCodeMessage;

          if (msg.role === "assistant" && msg.tokens) {
            const inputTokens =
              (msg.tokens.input ?? 0) + (msg.tokens.cache?.read ?? 0);

            if (inputTokens === 0) continue;

            const percentage = Math.round(
              (inputTokens / contextWindowSize) * 100,
            );

            const result: ContextUsage = {
              inputTokens,
              percentage,
              contextWindow: contextWindowSize,
            };

            if (msg.tokens.output !== undefined && msg.tokens.output > 0) {
              result.outputTokens = msg.tokens.output;
            }
            if (
              msg.tokens.cache?.read !== undefined &&
              msg.tokens.cache.read > 0
            ) {
              result.cacheReadTokens = msg.tokens.cache.read;
            }

            return result;
          }
        } catch {
          // Skip unreadable messages
        }
      }
    } catch {
      // No messages
    }

    return undefined;
  }

  /**
   * Truncate title to max length.
   */
  private truncateTitle(title: string | null): string | null {
    if (!title) return null;
    return truncateSessionTitle(title) || null;
  }
}

/**
 * OpenCode fills an assistant row in place until it records `time.completed`.
 * While YA's own turn streams that row live, the partial durable copy would
 * shadow the stream, and an `afterMessageId` catch-up never returns it again.
 * Only the trailing row is omitted: a killed turn leaves its row unfinished
 * for good, and it reappears once no owned turn is in progress.
 */
function withoutUnfinishedAssistantTail(loaded: LoadedSession): LoadedSession {
  if (loaded.data.provider !== "opencode") return loaded;
  const entries = loaded.data.session.messages;
  const tail = entries.at(-1)?.message;
  if (tail?.role !== "assistant" || tail.time?.completed !== undefined) {
    return loaded;
  }
  return {
    ...loaded,
    data: {
      ...loaded.data,
      session: { ...loaded.data.session, messages: entries.slice(0, -1) },
    },
  };
}

function childSummaryFromDbRow(
  parentSessionId: string,
  row: OpenCodeDbChildSessionRow,
): ProviderChildSessionSummary {
  const title = row.title?.trim() || undefined;
  const agentType =
    row.agent?.trim() || agentTypeFromOpenCodeChildTitle(title) || undefined;
  return {
    id: row.id,
    parentSessionId,
    ...(title ? { title } : {}),
    ...(agentType ? { agentType } : {}),
    updatedAt: new Date(row.timeUpdated ?? 0).toISOString(),
  };
}

function childSummaryFromFileSession(
  parentSessionId: string,
  sessionId: string,
  session: OpenCodeSessionJson,
): ProviderChildSessionSummary {
  const title = session.title?.trim() || undefined;
  const agentType = agentTypeFromOpenCodeChildTitle(title);
  return {
    id: session.id || sessionId,
    parentSessionId,
    ...(title ? { title } : {}),
    ...(agentType ? { agentType } : {}),
    updatedAt: new Date(
      session.time?.updated ?? session.time?.created ?? 0,
    ).toISOString(),
  };
}

function agentTypeFromOpenCodeChildTitle(
  title: string | undefined,
): string | undefined {
  const match = title?.match(/\(@([^\s)]+)\s+subagent\)\s*$/i);
  return match?.[1];
}

function childSessionIdFromStoredTaskPart(
  part: OpenCodeStoredPart,
): string | undefined {
  const metadata = asRecord(asRecord(part.state)?.metadata);
  const fromMeta =
    stringFromUnknown(metadata?.sessionId) ??
    stringFromUnknown(metadata?.session_id);
  if (fromMeta) return fromMeta;
  const output = asRecord(part.state)?.output;
  if (typeof output !== "string") return undefined;
  return output.match(/session_id:\s*(ses_[A-Za-z0-9]+)/)?.[1];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringFromUnknown(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
