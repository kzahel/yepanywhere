import type { ProviderChildSource } from "./ProviderChildRelationshipService.js";
/**
 * Session reader interface for provider-agnostic session reading.
 *
 * Each provider (Claude, Codex, Gemini) has different JSONL formats,
 * but all readers implement this interface to provide a common API.
 */

import type {
  EffortLevel,
  PermissionMode,
  ProviderChildSessionSummary,
  ThinkingConfig,
  UnifiedSession,
  UrlProjectId,
} from "@yep-anywhere/shared";
import type { Message, SessionSummary, Project } from "../supervisor/types.js";
import type { NativeSessionRef } from "@yep-anywhere/shared";

/** Native scope is explicit when resolving an already bound YA identity. */
export type SessionReaderFactory = (
  project: Project,
  native?: NativeSessionRef,
) => ISessionReader;

/**
 * Bounded session facts for collection routes that only need identity, title,
 * and recency, with independently bounded question previews when observed.
 */
export interface SessionListSummary {
  id: SessionSummary["id"];
  projectId: SessionSummary["projectId"];
  title: SessionSummary["title"];
  fullTitle: SessionSummary["fullTitle"];
  createdAt?: SessionSummary["createdAt"];
  updatedAt: SessionSummary["updatedAt"];
  lastHumanTurnAt?: SessionSummary["lastHumanTurnAt"];
  provider: SessionSummary["provider"];
  customTitle?: SessionSummary["customTitle"];
  isArchived?: SessionSummary["isArchived"];
  isStarred?: SessionSummary["isStarred"];
  asyncQuestions?: SessionSummary["asyncQuestions"];
}

/**
 * Canonical provider-child order: most recently active first, so every surface
 * that lists subagents (Agents, session cards, the sidebar outline, the child
 * selector) puts the child that ran last at the top. Sorts in place.
 */
export function sortProviderChildSessions(
  children: ProviderChildSessionSummary[],
): ProviderChildSessionSummary[] {
  return children.sort(
    (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
  );
}

export function toSessionListSummary(
  summary: Pick<
    SessionSummary,
    | "id"
    | "projectId"
    | "title"
    | "fullTitle"
    | "updatedAt"
    | "provider"
    | "customTitle"
    | "isArchived"
    | "isStarred"
    | "asyncQuestions"
  > &
    Pick<SessionListSummary, "createdAt" | "lastHumanTurnAt">,
): SessionListSummary {
  return {
    id: summary.id,
    projectId: summary.projectId,
    title: summary.title,
    fullTitle: summary.fullTitle,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    ...(summary.lastHumanTurnAt !== undefined
      ? { lastHumanTurnAt: summary.lastHumanTurnAt }
      : {}),
    provider: summary.provider,
    ...(summary.asyncQuestions !== undefined
      ? { asyncQuestions: summary.asyncQuestions }
      : {}),
    ...(summary.customTitle !== undefined
      ? { customTitle: summary.customTitle }
      : {}),
    ...(summary.isArchived !== undefined
      ? { isArchived: summary.isArchived }
      : {}),
    ...(summary.isStarred !== undefined
      ? { isStarred: summary.isStarred }
      : {}),
  };
}

/**
 * Options for reading a session.
 */
export interface GetSessionOptions {
  /** Include orphaned tool use detection (default: true, only applicable for Claude) */
  includeOrphans?: boolean;
  /** Bound a provider-native detail read to this many recent compactions. */
  tailCompactions?: number;
  /** Bound an older-page read to source content before this normalized id. */
  beforeMessageId?: string;
  /** Fresh indexed metadata that permits a provider to skip its historical prefix. */
  summaryHint?: SessionSummary;
  /**
   * A YA-owned provider process is mid-turn and streams the unfinished reply
   * live. A provider whose durable rows fill in place may omit that unfinished
   * tail, so a client never holds it as a durable row that later reads skip.
   */
  ownedTurnInProgress?: boolean;
}

export type SessionSummaryReadMode = "full" | "head";

/**
 * Options for reading summary metadata.
 */
export interface GetSessionSummaryOptions {
  /** Collection discovery may defer the independent question-tail projection. */
  deferAsyncQuestions?: boolean;
  /**
   * `head` permits a provider to stop after stable head metadata. It preserves
   * the SessionSummary wire shape but may omit tail-derived optional fields
   * such as contextUsage and may use a minimal compatible messageCount.
   */
  readMode?: SessionSummaryReadMode;
  /**
   * Let YA's manual compaction guard use transcript evidence that may be more
   * conservative than the provider-reported context total. The default stays
   * provider-reported for every user-visible summary.
   */
  contextUsageMode?: "manual-compaction";
}

// Return type that includes both the computed summary and the raw provider data
export interface LoadedSession {
  summary: SessionSummary;
  /** Source timestamp captured with the transcript rows in this snapshot. */
  transcriptSnapshotUpdatedAt: string;
  /** Private reader evidence; count of newline-committed rows in data. */
  committedEntries?: number;
  /** Private native snapshot identity used only for append-fenced extraction. */
  transcriptSourceVersion?: {
    id: string;
    size: number;
    mtime: number;
    ctime?: number;
  };
  /** Provider read window used to avoid retaining known-hidden source bytes. */
  readWindow?:
    | {
        kind: "compact-tail";
        omittedPrefix: true;
        startByte: number;
        compactBoundaries: number;
      }
    | {
        kind: "compact-page";
        omittedPrefix: boolean;
        startByte: number;
        endByte: number;
        compactBoundaries: number;
      };
  data: UnifiedSession;
}

/**
 * Best-effort provider transcript evidence used only when a session predates
 * the complete server-owned launch-settings snapshot.
 */
export interface RecoveredSessionLaunchSettings {
  permissionMode?: PermissionMode;
  requestedModel?: string;
  serviceTier?: string;
  thinking?: ThinkingConfig;
  effort?: EffortLevel;
}

/**
 * Common interface for session readers across providers.
 *
 * Provider-specific readers may have additional methods beyond this interface.
 * For example, ClaudeSessionReader has getAgentSession() for subagent support.
 */
export interface ISessionReader {
  readIssueTextBatch?(
    sessionId: string,
    options: import("./issue-text-reader.js").IssueReadOptions,
  ): Promise<import("./issue-text-reader.js").IssueTextBatch>;
  /**
   * Release any reader-owned resources such as parser child processes.
   */
  close?(): void | Promise<void>;

  /**
   * List all sessions in this reader's session directory.
   */
  listSessions(projectId: UrlProjectId): Promise<SessionSummary[]>;

  /**
   * Fast, on-demand recompute of the hover-card recent-activity excerpt
   * (last regular agent turn) for one session, without a full parse. Optional:
   * providers that do not populate `SessionSummary.lastAgentText` omit it.
   * See topics/session-hovercard-recent-activity.md.
   */
  getLastAgentExcerpt?(sessionId: string): Promise<string | undefined>;

  /** Accept one verified native file observation without rescanning its store. */
  observeNativeSessionFile?(
    native: NativeSessionRef,
    filePath: string,
    signal?: AbortSignal,
  ): Promise<boolean>;

  /**
   * Compact shared-store metadata has no reliable single-file freshness key.
   * undefined delegates to ordinary file caching; null is a terminal absence.
   * The index still owns/coalesces the request; this must not parse history.
   */
  getSharedStoreSummary?(
    sessionId: string,
    projectId: UrlProjectId,
  ): Promise<SessionSummary | null | undefined>;

  /** Get summary metadata for a single session. */
  getSessionSummary(
    sessionId: string,
    projectId: UrlProjectId,
    options?: GetSessionSummaryOptions,
  ): Promise<SessionSummary | null>;

  /**
   * Read only the bounded facts needed by lightweight collection routes.
   *
   * Providers should implement this only when they can bound the work
   * independently of transcript-tail size.
   */
  getSessionListSummary?(
    sessionId: string,
    projectId: UrlProjectId,
    /** Fresh indexed base facts; optional projections may still be absent. */
    summaryHint?: SessionListSummary,
    options?: { deferAsyncQuestions?: boolean },
  ): Promise<SessionListSummary | null>;

  /**
   * Recover the latest launch-relevant provider context for a pre-snapshot
   * session. Reading is side-effect free; successful process launch owns the
   * later metadata write.
   */
  getRecoveredLaunchSettings?(
    sessionId: string,
  ): Promise<RecoveredSessionLaunchSettings | null>;

  /**
   * Get full session with messages.
   * @param sessionId - The session ID
   * @param projectId - The project ID
   * @param afterMessageId - Only return messages after this ID (for incremental fetching)
   * @param options - Additional options
   */
  getSession(
    sessionId: string,
    projectId: UrlProjectId,
    afterMessageId?: string,
    options?: GetSessionOptions,
  ): Promise<LoadedSession | null>;

  /**
   * Get session summary only if the file has changed since cached values.
   * Used for cache invalidation.
   *
   * @param sessionId - The session ID
   * @param projectId - The project ID
   * @param cachedMtime - The mtime (ms since epoch) from the cache
   * @param cachedSize - The file size (bytes) from the cache
   * @returns Summary with file stats if changed, null if unchanged
   */
  getSessionSummaryIfChanged(
    sessionId: string,
    projectId: UrlProjectId,
    cachedMtime: number,
    cachedSize: number,
  ): Promise<{ summary: SessionSummary; mtime: number; size: number } | null>;

  /**
   * Get mappings from tool use IDs to agent session IDs.
   * Used for Claude's Task tool to link tool_use to subagent sessions.
   * Non-Claude providers should return an empty array.
   */
  getAgentMappings(
    parentSessionId?: string,
  ): Promise<{ toolUseId: string; agentId: string }[]>;

  /**
   * Get an agent (subagent) session by ID.
   * Used for Claude's Task tool subagent sessions (agent-*.jsonl files).
   * Non-Claude providers should return null.
   */
  getAgentSession(
    agentId: string,
    parentSessionId?: string,
  ): Promise<{ messages: Message[]; status: string } | null>;

  /** Profile-index input; acquisition is scheduled outside transcript requests. */
  getProviderChildSource?(
    nativeParent: NativeSessionRef,
  ): ProviderChildSource | undefined;

  /**
   * List provider-native child work attached to one canonical YA session,
   * most recently active first (see `sortProviderChildSessions`).
   * Readers without provider child sessions omit this method.
   */
  listProviderChildSessions?(
    parentSessionId: string,
  ): Promise<ProviderChildSessionSummary[]>;

  /**
   * Return the latest accepted child projection and start any needed refresh
   * in the background. Implementations must not wait for provider storage.
   * Omit the method when this freshness tier is unsupported. A present method
   * returns `undefined` for an unpublished cold miss and `[]` for a published
   * child-free projection.
   */
  listAcceptedProviderChildSessions?(
    parentSessionId: string,
  ): ProviderChildSessionSummary[] | undefined;

  /**
   * Get the file path for a session by ID.
   * Used for operations that need direct file access (e.g., cloning).
   * Returns null if the session is not found.
   */
  getSessionFilePath?(sessionId: string): Promise<string | null>;

  /** Native discovery evidence, including the actual root behind merged readers. */
  getNativeSessionRef?(
    sessionId: import("@yep-anywhere/shared").NativeSessionId,
  ): Promise<NativeSessionRef | null>;
  /** Batch discovery proof for list enrichment; canonicalize shared roots once. */
  getNativeSessionRefs?(
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, NativeSessionRef>>;

  /** Resolve the provider-native project path recorded by this session. */
  getSessionProjectPath?(sessionId: string): Promise<string | null>;

  /**
   * Enumerate session files in a directory with their IDs.
   * Used by SessionIndexService for providers where the session ID
   * can't be derived from the filename (e.g., Gemini JSON files).
   *
   * When not implemented, the index service falls back to JSONL
   * filename-based enumeration.
   *
   * `sharedFilePath: true` marks an entry whose filePath is a container
   * shared by many sessions (e.g. a provider database). Its stat mtime/size
   * say nothing about this session, so the index must validate it through
   * getSessionSummaryIfChanged instead of comparing file stats.
   */
  listSessionFiles?(
    sessionDir: string,
    options?: { activeAfterMs?: number },
  ): Promise<
    { sessionId: string; filePath: string; sharedFilePath?: boolean }[]
  >;

  /**
   * Return a stable cache/index scope key for this reader.
   *
   * Most providers can use the physical sessionDir directly, but providers like
   * Codex/Gemini share a single root session directory across many projects and
   * rely on reader-level filtering. Those readers should return a key that also
   * includes the logical project scope to avoid cache/index contamination.
   */
  getIndexScopeKey?(sessionDir: string): string;
}
