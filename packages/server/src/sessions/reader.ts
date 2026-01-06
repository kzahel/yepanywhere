import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  type AgentStatus,
  SESSION_TITLE_MAX_LENGTH,
  type UrlProjectId,
  isIdeMetadata,
  stripIdeMetadata,
} from "@yep-anywhere/shared";
import type {
  ContentBlock,
  ContextUsage,
  Message,
  Session,
  SessionSummary,
} from "../supervisor/types.js";
import type { GetSessionOptions, ISessionReader } from "./types.js";

// Re-export interface types
export type { GetSessionOptions, ISessionReader } from "./types.js";

// Claude model context window size (200K tokens)
const CONTEXT_WINDOW_SIZE = 200_000;

import { buildDag, findOrphanedToolUses } from "./dag.js";

export interface ClaudeSessionReaderOptions {
  sessionDir: string;
}

/** @deprecated Use ClaudeSessionReaderOptions */
export type SessionReaderOptions = ClaudeSessionReaderOptions;

// Re-export AgentStatus for backwards compatibility
export type { AgentStatus } from "@yep-anywhere/shared";

/**
 * Agent session content returned by getAgentSession.
 * Uses the server's Message type (loosely-typed JSONL pass-through).
 */
export interface AgentSession {
  messages: Message[];
  status: AgentStatus;
}

/**
 * Mapping of toolUseId to agentId.
 * Used to find agent sessions for pending Tasks on page reload.
 */
export interface AgentMapping {
  toolUseId: string;
  agentId: string;
}

// JSONL content block format from claude-code - loosely typed to preserve all fields
interface RawContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  signature?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
  // Allow any additional fields
  [key: string]: unknown;
}

// JSONL message format from claude-code - loosely typed to preserve all fields
interface RawSessionMessage {
  type: string;
  message?: {
    content: string | RawContentBlock[];
    role?: string;
    [key: string]: unknown;
  };
  timestamp?: string;
  uuid?: string;
  parentUuid?: string | null;
  toolUseResult?: unknown;
  // Agent session parent reference (links to Task tool_use id)
  parent_tool_use_id?: string;
  // Allow any additional fields from JSONL
  [key: string]: unknown;
}

/**
 * Claude-specific session reader for Claude Code JSONL files.
 *
 * Handles Claude's DAG-based conversation structure with parentUuid,
 * agent sessions, orphaned tool detection, and context window tracking.
 */
export class ClaudeSessionReader implements ISessionReader {
  private sessionDir: string;

  constructor(options: ClaudeSessionReaderOptions) {
    this.sessionDir = options.sessionDir;
  }

  async listSessions(projectId: UrlProjectId): Promise<SessionSummary[]> {
    const summaries: SessionSummary[] = [];

    try {
      const files = await readdir(this.sessionDir);
      // Filter out agent-* files (internal subagent warmup sessions)
      const jsonlFiles = files.filter(
        (f) => f.endsWith(".jsonl") && !f.startsWith("agent-"),
      );

      for (const file of jsonlFiles) {
        const sessionId = file.replace(".jsonl", "");
        const summary = await this.getSessionSummary(sessionId, projectId);
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

  async getSessionSummary(
    sessionId: string,
    projectId: UrlProjectId,
  ): Promise<SessionSummary | null> {
    const filePath = join(this.sessionDir, `${sessionId}.jsonl`);

    try {
      const content = await readFile(filePath, "utf-8");
      const trimmed = content.trim();

      // Skip empty files
      if (!trimmed) {
        return null;
      }

      const lines = trimmed.split("\n");
      const messages = lines
        .map((line) => {
          try {
            return JSON.parse(line) as RawSessionMessage;
          } catch {
            return null;
          }
        })
        .filter((m): m is RawSessionMessage => m !== null);

      // Build DAG and get active branch (filters out dead branches from rewinds, etc.)
      const { activeBranch } = buildDag(messages);

      // Filter active branch to user/assistant messages only
      const conversationMessages = activeBranch
        .filter(
          (node) => node.raw.type === "user" || node.raw.type === "assistant",
        )
        .map((node) => node.raw);

      // Skip sessions with no actual conversation messages (metadata-only files).
      // Note: Newly created sessions may not have user/assistant messages yet (SDK writes async).
      // These are handled separately in the projects route by adding owned processes.
      if (conversationMessages.length === 0) {
        return null;
      }

      const stats = await stat(filePath);
      const firstUserMessage = this.findFirstUserMessage(messages);
      const fullTitle = firstUserMessage?.trim() || null;
      const contextUsage = this.extractContextUsage(conversationMessages);
      const model = this.extractModel(conversationMessages);

      return {
        id: sessionId,
        projectId,
        title: this.extractTitle(firstUserMessage),
        fullTitle,
        createdAt: stats.birthtime.toISOString(),
        updatedAt: stats.mtime.toISOString(),
        messageCount: conversationMessages.length,
        status: { state: "idle" }, // Will be updated by Supervisor
        contextUsage,
        provider: "claude",
        model,
      };
    } catch {
      return null;
    }
  }

  async getSession(
    sessionId: string,
    projectId: UrlProjectId,
    afterMessageId?: string,
    options?: GetSessionOptions,
  ): Promise<Session | null> {
    const summary = await this.getSessionSummary(sessionId, projectId);
    if (!summary) return null;

    const filePath = join(this.sessionDir, `${sessionId}.jsonl`);
    const content = await readFile(filePath, "utf-8");
    const lines = content.trim().split("\n");

    // Parse all lines first
    const rawMessages: RawSessionMessage[] = [];
    for (const line of lines) {
      try {
        rawMessages.push(JSON.parse(line) as RawSessionMessage);
      } catch {
        // Skip malformed lines
      }
    }

    // Build DAG and get active branch (filters out dead branches)
    const { activeBranch } = buildDag(rawMessages);

    // Only calculate orphaned tools if includeOrphans is true (default)
    // For external sessions, we don't know if tools were interrupted or still running
    const includeOrphans = options?.includeOrphans ?? true;
    const orphanedToolUses = includeOrphans
      ? findOrphanedToolUses(activeBranch)
      : new Set<string>();

    // Convert to Message objects (only active branch)
    const messages: Message[] = activeBranch.map((node, index) =>
      this.convertMessage(node.raw, index, orphanedToolUses),
    );

    // Filter to only messages after the given ID (for incremental fetching)
    if (afterMessageId) {
      const afterIndex = messages.findIndex((m) => m.uuid === afterMessageId);
      if (afterIndex !== -1) {
        return {
          ...summary,
          messages: messages.slice(afterIndex + 1),
        };
      }
    }

    return {
      ...summary,
      messages,
    };
  }

  /**
   * Get agent session content for lazy-loading completed Tasks.
   *
   * Agent JSONL files are stored at: {sessionDir}/agent-{agentId}.jsonl
   * They have the same format as parent session JSONL files.
   *
   * @param agentId - The agent session ID (used as filename: agent-{agentId}.jsonl)
   * @returns Agent session with messages and inferred status
   */
  async getAgentSession(agentId: string): Promise<AgentSession> {
    const filePath = join(this.sessionDir, `agent-${agentId}.jsonl`);

    try {
      const content = await readFile(filePath, "utf-8");
      const trimmed = content.trim();

      if (!trimmed) {
        return { messages: [], status: "pending" };
      }

      const lines = trimmed.split("\n");
      const rawMessages: RawSessionMessage[] = [];

      for (const line of lines) {
        try {
          rawMessages.push(JSON.parse(line) as RawSessionMessage);
        } catch {
          // Skip malformed lines
        }
      }

      // Build DAG and get active branch (filters out dead branches)
      const { activeBranch } = buildDag(rawMessages);

      // Don't include orphan detection for agent sessions
      // (agents are subprocesses, we don't know their lifecycle)
      const orphanedToolUses = new Set<string>();

      // Convert to Message objects
      const messages: Message[] = activeBranch.map((node, index) =>
        this.convertMessage(node.raw, index, orphanedToolUses),
      );

      // Infer status from messages
      const status = this.inferAgentStatus(messages);

      return { messages, status };
    } catch {
      // File doesn't exist or not readable - agent is pending
      return { messages: [], status: "pending" };
    }
  }

  /**
   * Get mappings of toolUseId → agentId for all agent files in the session directory.
   *
   * This is used to find agent sessions for pending Tasks on page reload.
   * It scans all agent-*.jsonl files and extracts the parent_tool_use_id from
   * the first message or system message.
   *
   * @returns Array of toolUseId → agentId mappings
   */
  async getAgentMappings(): Promise<AgentMapping[]> {
    const mappings: AgentMapping[] = [];

    try {
      const files = await readdir(this.sessionDir);
      const agentFiles = files.filter(
        (f) => f.startsWith("agent-") && f.endsWith(".jsonl"),
      );

      for (const file of agentFiles) {
        // Extract agentId from filename: agent-{agentId}.jsonl
        const agentId = file.slice(6, -6); // Remove "agent-" prefix and ".jsonl" suffix
        const filePath = join(this.sessionDir, file);

        try {
          const content = await readFile(filePath, "utf-8");
          const trimmed = content.trim();
          if (!trimmed) continue;

          // Check first few lines for parent_tool_use_id
          const lines = trimmed.split("\n").slice(0, 5);
          for (const line of lines) {
            try {
              const msg = JSON.parse(line) as RawSessionMessage;
              if (msg.parent_tool_use_id) {
                mappings.push({
                  toolUseId: msg.parent_tool_use_id,
                  agentId,
                });
                break;
              }
            } catch {
              // Skip malformed lines
            }
          }
        } catch {
          // Skip unreadable files
        }
      }
    } catch {
      // Directory doesn't exist or not readable
    }

    return mappings;
  }

  /**
   * Infer agent status from its messages.
   *
   * Status inference:
   * - pending: no messages
   * - failed: last message has is_error or error type
   * - completed: has a 'result' type message
   * - running: has messages but no result (still in progress or interrupted)
   */
  private inferAgentStatus(messages: Message[]): AgentStatus {
    if (messages.length === 0) {
      return "pending";
    }

    // Look for result message
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (!msg) continue;

      // Check for result type message (SDK's final message)
      if (msg.type === "result") {
        // Check for error in result
        const rawMessage = msg as RawSessionMessage;
        if (rawMessage.is_error === true) {
          return "failed";
        }
        return "completed";
      }
    }

    // No result message - still running or interrupted
    return "running";
  }

  private findFirstUserMessage(messages: RawSessionMessage[]): string | null {
    for (const msg of messages) {
      if (msg.type === "user" && msg.message?.content) {
        return this.extractTitleContent(msg.message.content);
      }
    }
    return null;
  }

  /**
   * Extract context usage from the last assistant message.
   * Usage data is stored in message.usage with input_tokens, cache_read_input_tokens, etc.
   */
  private extractContextUsage(
    messages: RawSessionMessage[],
  ): ContextUsage | undefined {
    // Find the last assistant message (iterate backwards)
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg && msg.type === "assistant" && msg.message) {
        const usage = msg.message.usage as
          | {
              input_tokens?: number;
              cache_read_input_tokens?: number;
              cache_creation_input_tokens?: number;
            }
          | undefined;

        if (usage) {
          // Total input = fresh tokens + cached tokens + new cache creation
          const inputTokens =
            (usage.input_tokens ?? 0) +
            (usage.cache_read_input_tokens ?? 0) +
            (usage.cache_creation_input_tokens ?? 0);

          // Skip messages with zero tokens (incomplete streaming messages)
          if (inputTokens === 0) {
            continue;
          }

          const percentage = Math.round(
            (inputTokens / CONTEXT_WINDOW_SIZE) * 100,
          );

          return { inputTokens, percentage };
        }
      }
    }
    return undefined;
  }

  /**
   * Extract the model from the first assistant message.
   * The model is stored in message.model (e.g., "claude-opus-4-5-20251101").
   */
  private extractModel(messages: RawSessionMessage[]): string | undefined {
    // Find the first assistant message with a model field
    for (const msg of messages) {
      if (msg.type === "assistant" && msg.message) {
        const model = msg.message.model as string | undefined;
        if (model) {
          return model;
        }
      }
    }
    return undefined;
  }

  private extractTitle(content: string | null): string | null {
    if (!content) return null;
    const trimmed = content.trim();
    if (trimmed.length <= SESSION_TITLE_MAX_LENGTH) return trimmed;
    return `${trimmed.slice(0, SESSION_TITLE_MAX_LENGTH - 3)}...`;
  }

  private extractContent(
    content: string | Array<{ type: string; text?: string }>,
  ): string {
    if (typeof content === "string") return content;
    return content
      .filter(
        (block): block is { type: string; text: string } =>
          block.type === "text" && typeof block.text === "string",
      )
      .map((block) => block.text)
      .join("\n");
  }

  /**
   * Extract content for title generation, skipping IDE metadata blocks.
   * This ensures session titles show the actual user message, not IDE metadata
   * like <ide_opened_file> or <ide_selection> tags.
   */
  private extractTitleContent(
    content: string | Array<{ type: string; text?: string }>,
  ): string {
    if (typeof content === "string") {
      return stripIdeMetadata(content);
    }
    return content
      .filter(
        (block): block is { type: string; text: string } =>
          block.type === "text" &&
          typeof block.text === "string" &&
          !isIdeMetadata(block.text),
      )
      .map((block) => block.text)
      .join("\n");
  }

  /**
   * Get session summary only if the file has changed since the cached values.
   * Used by SessionIndexService for cache invalidation.
   *
   * @param sessionId - The session ID
   * @param projectId - The project ID
   * @param cachedMtime - The mtime (ms since epoch) from the cache
   * @param cachedSize - The file size (bytes) from the cache
   * @returns Summary with file stats if changed, null if unchanged
   */
  async getSessionSummaryIfChanged(
    sessionId: string,
    projectId: UrlProjectId,
    cachedMtime: number,
    cachedSize: number,
  ): Promise<{ summary: SessionSummary; mtime: number; size: number } | null> {
    const filePath = join(this.sessionDir, `${sessionId}.jsonl`);

    try {
      const stats = await stat(filePath);
      const mtime = stats.mtimeMs;
      const size = stats.size;

      // If mtime and size match cached values, return null (no change)
      if (mtime === cachedMtime && size === cachedSize) {
        return null;
      }

      // Otherwise parse the file and return { summary, mtime, size }
      const summary = await this.getSessionSummary(sessionId, projectId);
      if (!summary) return null;

      return { summary, mtime, size };
    } catch {
      return null; // File doesn't exist or error
    }
  }

  /**
   * Convert a raw JSONL message to our Message format.
   *
   * We pass through all fields from JSONL without stripping.
   * This preserves debugging info, DAG structure, and metadata.
   * The only transformation is:
   * - Normalize content blocks (pass through all fields)
   * - Add computed orphanedToolUseIds
   */
  private convertMessage(
    raw: RawSessionMessage,
    _index: number,
    orphanedToolUses: Set<string> = new Set(),
  ): Message {
    // Normalize content blocks - pass through all fields
    let content: string | ContentBlock[] | undefined;
    if (typeof raw.message?.content === "string") {
      content = raw.message.content;
    } else if (Array.isArray(raw.message?.content)) {
      // Pass through all fields from each content block
      content = raw.message.content.map((block) => ({ ...block }));
    }

    // Build message by spreading all raw fields, then override with normalized values
    const message: Message = {
      ...raw,
      // Include normalized content if message had content
      ...(raw.message && {
        message: {
          ...raw.message,
          ...(content !== undefined && { content }),
        },
      }),
      // Ensure type is set
      type: raw.type,
    };

    // Identify orphaned tool_use IDs in this message's content
    if (Array.isArray(content)) {
      const orphanedIds = content
        .filter(
          (b): b is ContentBlock & { id: string } =>
            b.type === "tool_use" &&
            typeof b.id === "string" &&
            orphanedToolUses.has(b.id),
        )
        .map((b) => b.id);

      if (orphanedIds.length > 0) {
        message.orphanedToolUseIds = orphanedIds;
      }
    }

    return message;
  }
}

/** @deprecated Use ClaudeSessionReader */
export const SessionReader = ClaudeSessionReader;
/** @deprecated Use ClaudeSessionReader */
export type SessionReader = ClaudeSessionReader;
