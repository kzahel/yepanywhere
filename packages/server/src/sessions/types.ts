/**
 * Session reader interface for provider-agnostic session reading.
 *
 * Each provider (Claude, Codex, Gemini) has different JSONL formats,
 * but all readers implement this interface to provide a common API.
 */

import type { UrlProjectId } from "@claude-anywhere/shared";
import type { Message, Session, SessionSummary } from "../supervisor/types.js";

/**
 * Options for reading a session.
 */
export interface GetSessionOptions {
  /** Include orphaned tool use detection (default: true, only applicable for Claude) */
  includeOrphans?: boolean;
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
  ): Promise<Session | null>;

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
}
