/**
 * CodexSessionReader - Reads Codex sessions from disk.
 *
 * Codex stores sessions at ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 * with a different format than Claude:
 * - session_meta: Session initialization (id, cwd, timestamp)
 * - response_item: Messages, reasoning, function calls
 * - event_msg: User/agent messages, token counts
 * - turn_context: Per-turn configuration
 *
 * Unlike Claude's DAG structure, Codex sessions are linear.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  type CodexEventMsgEntry,
  type CodexFunctionCallOutputPayload,
  type CodexFunctionCallPayload,
  type CodexMessagePayload,
  type CodexReasoningPayload,
  type CodexResponseItemEntry,
  type CodexSessionEntry,
  type CodexSessionMetaEntry,
  SESSION_TITLE_MAX_LENGTH,
  type UrlProjectId,
  parseCodexSessionEntry,
} from "@claude-anywhere/shared";
import type {
  ContentBlock,
  ContextUsage,
  Message,
  Session,
  SessionSummary,
} from "../supervisor/types.js";
import type { GetSessionOptions, ISessionReader } from "./types.js";

// Codex model context window size (200K tokens for GPT-4)
const CONTEXT_WINDOW_SIZE = 200_000;

export interface CodexSessionReaderOptions {
  /**
   * Base directory for Codex sessions (~/.codex/sessions).
   * Sessions are stored in YYYY/MM/DD/rollout-*.jsonl structure.
   */
  sessionsDir: string;
  /**
   * The project path (cwd) to filter sessions by.
   * Only sessions with this cwd will be listed.
   */
  projectPath?: string;
}

interface CodexSessionFile {
  id: string;
  filePath: string;
  cwd: string;
  timestamp: string;
  mtime: number;
  size: number;
}

/**
 * Codex-specific session reader for Codex CLI JSONL files.
 *
 * Handles Codex's linear conversation structure with session_meta,
 * response_item, event_msg, and turn_context entries.
 */
export class CodexSessionReader implements ISessionReader {
  private sessionsDir: string;
  private projectPath?: string;

  // Cache of session ID -> file path for quick lookups
  private sessionFileCache: Map<string, CodexSessionFile> = new Map();
  private cacheTimestamp = 0;
  private readonly CACHE_TTL_MS = 5000; // 5 second cache

  constructor(options: CodexSessionReaderOptions) {
    this.sessionsDir = options.sessionsDir;
    this.projectPath = options.projectPath;
  }

  async listSessions(projectId: UrlProjectId): Promise<SessionSummary[]> {
    const summaries: SessionSummary[] = [];
    const sessions = await this.scanSessions();

    for (const session of sessions) {
      // Filter by project path if set
      if (this.projectPath && session.cwd !== this.projectPath) {
        continue;
      }

      const summary = await this.getSessionSummary(session.id, projectId);
      if (summary) {
        summaries.push(summary);
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
    const sessionFile = await this.findSessionFile(sessionId);
    if (!sessionFile) return null;

    try {
      const content = await readFile(sessionFile.filePath, "utf-8");
      const trimmed = content.trim();

      if (!trimmed) return null;

      const lines = trimmed.split("\n");
      const entries: CodexSessionEntry[] = [];

      for (const line of lines) {
        const entry = parseCodexSessionEntry(line);
        if (entry) {
          entries.push(entry);
        }
      }

      if (entries.length === 0) return null;

      // Extract session metadata from first entry
      const metaEntry = entries.find((e) => e.type === "session_meta") as
        | CodexSessionMetaEntry
        | undefined;
      if (!metaEntry) return null;

      const stats = await stat(sessionFile.filePath);
      const { title, fullTitle } = this.extractTitle(entries);
      const messageCount = this.countMessages(entries);
      const contextUsage = this.extractContextUsage(entries);

      // Skip sessions with no actual conversation messages
      if (messageCount === 0) return null;

      return {
        id: sessionId,
        projectId,
        title,
        fullTitle,
        createdAt: metaEntry.payload.timestamp,
        updatedAt: stats.mtime.toISOString(),
        messageCount,
        status: { state: "idle" },
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
    _options?: GetSessionOptions,
  ): Promise<Session | null> {
    const summary = await this.getSessionSummary(sessionId, projectId);
    if (!summary) return null;

    const sessionFile = await this.findSessionFile(sessionId);
    if (!sessionFile) return null;

    const content = await readFile(sessionFile.filePath, "utf-8");
    const lines = content.trim().split("\n");

    const entries: CodexSessionEntry[] = [];
    for (const line of lines) {
      const entry = parseCodexSessionEntry(line);
      if (entry) {
        entries.push(entry);
      }
    }

    // Convert entries to messages
    const messages = this.convertEntriesToMessages(entries);

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

  async getSessionSummaryIfChanged(
    sessionId: string,
    projectId: UrlProjectId,
    cachedMtime: number,
    cachedSize: number,
  ): Promise<{ summary: SessionSummary; mtime: number; size: number } | null> {
    const sessionFile = await this.findSessionFile(sessionId);
    if (!sessionFile) return null;

    try {
      const stats = await stat(sessionFile.filePath);
      const mtime = stats.mtimeMs;
      const size = stats.size;

      // If mtime and size match cached values, return null (no change)
      if (mtime === cachedMtime && size === cachedSize) {
        return null;
      }

      const summary = await this.getSessionSummary(sessionId, projectId);
      if (!summary) return null;

      return { summary, mtime, size };
    } catch {
      return null;
    }
  }

  /**
   * Codex doesn't have subagent sessions like Claude.
   * Returns empty array for compatibility.
   */
  async getAgentMappings(): Promise<{ toolUseId: string; agentId: string }[]> {
    return [];
  }

  /**
   * Codex doesn't have subagent sessions like Claude.
   * Returns null for compatibility.
   */
  async getAgentSession(
    _agentId: string,
  ): Promise<{ messages: Message[]; status: string } | null> {
    return null;
  }

  /**
   * Scan the sessions directory and find all session files.
   */
  private async scanSessions(): Promise<CodexSessionFile[]> {
    // Check cache
    if (Date.now() - this.cacheTimestamp < this.CACHE_TTL_MS) {
      return Array.from(this.sessionFileCache.values());
    }

    const sessions: CodexSessionFile[] = [];
    const files = await this.findJsonlFiles(this.sessionsDir);

    for (const filePath of files) {
      const session = await this.readSessionMeta(filePath);
      if (session) {
        sessions.push(session);
        this.sessionFileCache.set(session.id, session);
      }
    }

    this.cacheTimestamp = Date.now();
    return sessions;
  }

  /**
   * Find a session file by ID.
   */
  private async findSessionFile(
    sessionId: string,
  ): Promise<CodexSessionFile | null> {
    // Check cache first
    const cached = this.sessionFileCache.get(sessionId);
    if (cached) return cached;

    // Scan if cache miss
    await this.scanSessions();
    return this.sessionFileCache.get(sessionId) ?? null;
  }

  /**
   * Recursively find all .jsonl files in a directory.
   */
  private async findJsonlFiles(dir: string): Promise<string[]> {
    const files: string[] = [];

    try {
      const entries = await readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          const subFiles = await this.findJsonlFiles(fullPath);
          files.push(...subFiles);
        } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          files.push(fullPath);
        }
      }
    } catch {
      // Ignore errors (permission denied, etc.)
    }

    return files;
  }

  /**
   * Read session metadata from the first line of a file.
   */
  private async readSessionMeta(
    filePath: string,
  ): Promise<CodexSessionFile | null> {
    try {
      const stats = await stat(filePath);
      const content = await readFile(filePath, { encoding: "utf-8" });
      const firstNewline = content.indexOf("\n");
      const firstLine =
        firstNewline > 0 ? content.slice(0, firstNewline) : content;

      if (!firstLine.trim()) return null;

      const entry = parseCodexSessionEntry(firstLine);
      if (!entry || entry.type !== "session_meta") return null;

      const meta = entry.payload;

      return {
        id: meta.id,
        filePath,
        cwd: meta.cwd,
        timestamp: meta.timestamp,
        mtime: stats.mtimeMs,
        size: stats.size,
      };
    } catch {
      return null;
    }
  }

  /**
   * Extract title from entries (first user message).
   */
  private extractTitle(entries: CodexSessionEntry[]): {
    title: string | null;
    fullTitle: string | null;
  } {
    // Find first user message
    for (const entry of entries) {
      if (entry.type === "event_msg" && entry.payload.type === "user_message") {
        const fullTitle = entry.payload.message.trim();
        const title =
          fullTitle.length <= SESSION_TITLE_MAX_LENGTH
            ? fullTitle
            : `${fullTitle.slice(0, SESSION_TITLE_MAX_LENGTH - 3)}...`;
        return { title, fullTitle };
      }

      if (entry.type === "response_item") {
        const payload = entry.payload;
        if (payload.type === "message" && payload.role === "user") {
          const text = payload.content
            .map((c) => ("text" in c ? c.text : ""))
            .join("\n")
            .trim();
          if (text) {
            const title =
              text.length <= SESSION_TITLE_MAX_LENGTH
                ? text
                : `${text.slice(0, SESSION_TITLE_MAX_LENGTH - 3)}...`;
            return { title, fullTitle: text };
          }
        }
      }
    }

    return { title: null, fullTitle: null };
  }

  /**
   * Count user/assistant messages in entries.
   */
  private countMessages(entries: CodexSessionEntry[]): number {
    let count = 0;

    for (const entry of entries) {
      if (entry.type === "event_msg") {
        if (
          entry.payload.type === "user_message" ||
          entry.payload.type === "agent_message"
        ) {
          count++;
        }
      } else if (entry.type === "response_item") {
        if (entry.payload.type === "message") {
          count++;
        }
      }
    }

    return count;
  }

  /**
   * Extract context usage from token_count events.
   */
  private extractContextUsage(
    entries: CodexSessionEntry[],
  ): ContextUsage | undefined {
    // Find last token_count event
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (
        entry &&
        entry.type === "event_msg" &&
        entry.payload.type === "token_count"
      ) {
        const info = entry.payload.info;
        if (info?.total_token_usage) {
          const inputTokens =
            info.total_token_usage.input_tokens +
            (info.total_token_usage.cached_input_tokens ?? 0);

          if (inputTokens === 0) continue;

          const contextWindow =
            info.model_context_window ?? CONTEXT_WINDOW_SIZE;
          const percentage = Math.round((inputTokens / contextWindow) * 100);

          return { inputTokens, percentage };
        }
      }
    }

    return undefined;
  }

  /**
   * Convert Codex JSONL entries to Message format.
   */
  private convertEntriesToMessages(entries: CodexSessionEntry[]): Message[] {
    const messages: Message[] = [];
    let messageIndex = 0;

    // Track function calls for pairing with outputs
    const pendingCalls = new Map<
      string,
      { name: string; arguments: string; timestamp: string }
    >();

    for (const entry of entries) {
      if (entry.type === "response_item") {
        const msg = this.convertResponseItem(
          entry,
          messageIndex++,
          pendingCalls,
        );
        if (msg) {
          messages.push(msg);
        }
      } else if (entry.type === "event_msg") {
        const msg = this.convertEventMsg(entry, messageIndex++);
        if (msg) {
          messages.push(msg);
        }
      }
      // Skip session_meta and turn_context for now
    }

    return messages;
  }

  /**
   * Convert a response_item entry to a Message.
   */
  private convertResponseItem(
    entry: CodexResponseItemEntry,
    index: number,
    pendingCalls: Map<
      string,
      { name: string; arguments: string; timestamp: string }
    >,
  ): Message | null {
    const payload = entry.payload;
    const uuid = `codex-${index}-${entry.timestamp}`;

    switch (payload.type) {
      case "message":
        return this.convertMessagePayload(payload, uuid, entry.timestamp);

      case "reasoning":
        return this.convertReasoningPayload(payload, uuid, entry.timestamp);

      case "function_call":
        // Store for pairing with output
        pendingCalls.set(payload.call_id, {
          name: payload.name,
          arguments: payload.arguments,
          timestamp: entry.timestamp,
        });
        // Create tool_use message
        return this.convertFunctionCallPayload(payload, uuid, entry.timestamp);

      case "function_call_output":
        return this.convertFunctionCallOutputPayload(
          payload,
          uuid,
          entry.timestamp,
          pendingCalls,
        );

      case "ghost_snapshot":
        // Skip git snapshot entries for now
        return null;

      default:
        return null;
    }
  }

  /**
   * Convert a message payload (user or assistant).
   */
  private convertMessagePayload(
    payload: CodexMessagePayload,
    uuid: string,
    timestamp: string,
  ): Message {
    const content: ContentBlock[] = payload.content.map((c) => ({
      type: "text" as const,
      text: c.text,
    }));

    return {
      uuid,
      type: payload.role,
      message: {
        role: payload.role,
        content,
      },
      timestamp,
    };
  }

  /**
   * Convert a reasoning payload (thinking).
   */
  private convertReasoningPayload(
    payload: CodexReasoningPayload,
    uuid: string,
    timestamp: string,
  ): Message {
    // Extract text from summary or encrypted content indicator
    const summaryText = payload.summary
      ?.map((s) => s.text)
      .join("\n")
      .trim();

    const content: ContentBlock[] = [];

    if (summaryText) {
      content.push({
        type: "thinking",
        thinking: summaryText,
      });
    }

    if (payload.encrypted_content) {
      content.push({
        type: "text",
        text: "[Encrypted reasoning content]",
      });
    }

    return {
      uuid,
      type: "assistant",
      message: {
        role: "assistant",
        content,
      },
      timestamp,
    };
  }

  /**
   * Convert a function_call payload to tool_use.
   */
  private convertFunctionCallPayload(
    payload: CodexFunctionCallPayload,
    uuid: string,
    timestamp: string,
  ): Message {
    let input: unknown;
    try {
      input = JSON.parse(payload.arguments);
    } catch {
      input = { raw: payload.arguments };
    }

    const content: ContentBlock[] = [
      {
        type: "tool_use",
        id: payload.call_id,
        name: payload.name,
        input,
      },
    ];

    return {
      uuid,
      type: "assistant",
      message: {
        role: "assistant",
        content,
      },
      timestamp,
    };
  }

  /**
   * Convert a function_call_output payload to tool_result.
   */
  private convertFunctionCallOutputPayload(
    payload: CodexFunctionCallOutputPayload,
    uuid: string,
    timestamp: string,
    _pendingCalls: Map<
      string,
      { name: string; arguments: string; timestamp: string }
    >,
  ): Message {
    return {
      uuid,
      type: "tool_result",
      toolUseResult: {
        tool_use_id: payload.call_id,
        content: payload.output,
      },
      timestamp,
    };
  }

  /**
   * Convert an event_msg entry to a Message.
   */
  private convertEventMsg(
    entry: CodexEventMsgEntry,
    index: number,
  ): Message | null {
    const payload = entry.payload;
    const uuid = `codex-event-${index}-${entry.timestamp}`;

    switch (payload.type) {
      case "user_message":
        return {
          uuid,
          type: "user",
          message: {
            role: "user",
            content: payload.message,
          },
          timestamp: entry.timestamp,
        };

      case "agent_message":
        return {
          uuid,
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: payload.message }],
          },
          timestamp: entry.timestamp,
        };

      case "agent_reasoning":
        return {
          uuid,
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "thinking", thinking: payload.text }],
          },
          timestamp: entry.timestamp,
        };

      case "token_count":
        // Skip token count events in messages
        return null;

      default:
        return null;
    }
  }
}
