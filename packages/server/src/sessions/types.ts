/**
 * Session reader interface for provider-agnostic session reading.
 *
 * Each provider (Claude, Codex, Gemini) has different JSONL formats,
 * but all readers implement this interface to provide a common API.
 */

import type { UnifiedSession, UrlProjectId } from "@yep-anywhere/shared";
import type { Message, Session, SessionSummary } from "../supervisor/types.js";

/**
 * Options for reading a session.
 */
export interface GetSessionOptions {
  /** Include orphaned tool use detection (default: true, only applicable for Claude) */
  includeOrphans?: boolean;
}

// Return type that includes both the computed summary and the raw provider data
export interface LoadedSession {
  summary: SessionSummary;
  data: UnifiedSession;
}

/**
 * Common interface for session readers across providers.
 *
 * Provider-specific readers may have additional methods beyond this interface.
 * For example, ClaudeSessionReader has getAgentSession() for subagent support.
 */
export interface ISessionReader {
  /**
   * List all sessions in this reader's session directory.
   */
  listSessions(projectId: UrlProjectId): Promise<SessionSummary[]>;

  /**
   * Get summary metadata for a single session.
   */
  getSessionSummary(
    sessionId: string,
    projectId: UrlProjectId,
  ): Promise<SessionSummary | null>;

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
  getAgentMappings(): Promise<{ toolUseId: string; agentId: string }[]>;

  /**
   * Get an agent (subagent) session by ID.
   * Used for Claude's Task tool subagent sessions (agent-*.jsonl files).
   * Non-Claude providers should return null.
   */
  getAgentSession(
    agentId: string,
  ): Promise<{ messages: Message[]; status: string } | null>;

  /**
   * Get the file path for a session by ID.
   * Used for operations that need direct file access (e.g., cloning).
   * Returns null if the session is not found.
   */
  getSessionFilePath?(sessionId: string): Promise<string | null>;

  /**
   * Enumerate session files in a directory with their IDs.
   * Used by SessionIndexService for providers where the session ID
   * can't be derived from the filename (e.g., Gemini JSON files).
   *
   * When not implemented, the index service falls back to JSONL
   * filename-based enumeration.
   */
  listSessionFiles?(
    sessionDir: string,
  ): Promise<{ sessionId: string; filePath: string }[]>;

  /**
   * Return a stable cache/index scope key for this reader.
   *
   * Most providers can use the physical sessionDir directly, but providers like
   * Codex/Gemini share a single root session directory across many projects and
   * rely on reader-level filtering. Those readers should return a key that also
   * includes the logical project scope to avoid cache/index contamination.
   */
  getIndexScopeKey?(sessionDir: string): string;

  /**
   * Invalidate any reader-local cache.
   *
   * Providers that maintain their own file discovery cache (for example Codex's
   * shared sessions tree) can implement this so higher layers can force a
   * refresh after watcher-driven dirty events.
   */
  invalidateCache?(): void;
}
