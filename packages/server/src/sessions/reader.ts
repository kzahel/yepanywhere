import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  type UrlProjectId,
  isIdeMetadata,
  stripIdeMetadata,
} from "@claude-anywhere/shared";
import type {
  ContentBlock,
  ContextUsage,
  Message,
  Session,
  SessionSummary,
} from "../supervisor/types.js";
import { SESSION_TITLE_MAX_LENGTH } from "../supervisor/types.js";

// Claude model context window size (200K tokens)
const CONTEXT_WINDOW_SIZE = 200_000;

import { buildDag, findOrphanedToolUses } from "./dag.js";

export interface SessionReaderOptions {
  sessionDir: string;
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
  // Allow any additional fields from JSONL
  [key: string]: unknown;
}

export class SessionReader {
  private sessionDir: string;

  constructor(options: SessionReaderOptions) {
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

      // Filter to only user/assistant messages (not internal types like file-history-snapshot, queue-operation)
      const conversationMessages = messages.filter(
        (m) => m.type === "user" || m.type === "assistant",
      );

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
      };
    } catch {
      return null;
    }
  }

  async getSession(
    sessionId: string,
    projectId: UrlProjectId,
    afterMessageId?: string,
    options?: { includeOrphans?: boolean },
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
      const afterIndex = messages.findIndex((m) => m.id === afterMessageId);
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

          const percentage = Math.round(
            (inputTokens / CONTEXT_WINDOW_SIZE) * 100,
          );

          return { inputTokens, percentage };
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
   * Convert a raw JSONL message to our Message format.
   *
   * We pass through all fields from JSONL without stripping.
   * This preserves debugging info, DAG structure, and metadata.
   * The only transformation is:
   * - Ensure id exists (fallback to index-based)
   * - Normalize content blocks (pass through all fields)
   * - Add computed orphanedToolUseIds
   */
  private convertMessage(
    raw: RawSessionMessage,
    index: number,
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
      // Ensure id exists
      id: raw.uuid ?? `msg-${index}`,
      // Include normalized content if message had content
      ...(raw.message && {
        message: {
          ...raw.message,
          ...(content !== undefined && { content }),
        },
      }),
      // Also expose content at top level for convenience (matches SDK format)
      ...(content !== undefined && { content }),
      // Ensure type is set
      type: raw.type,
      // Map type to role for user/assistant messages
      ...(raw.type === "user" || raw.type === "assistant"
        ? { role: raw.type as "user" | "assistant" }
        : {}),
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
