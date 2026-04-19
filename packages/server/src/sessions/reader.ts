import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  type AgentStatus,
  type ProviderName,
  SESSION_TITLE_MAX_LENGTH,
  type UrlProjectId,
  getModelContextWindow,
  isIdeMetadata,
  stripIdeMetadata,
} from "@yep-anywhere/shared";
import type {
  ContentBlock,
  ContextUsage,
  Message,
  SessionSummary,
} from "../supervisor/types.js";
import type {
  GetSessionOptions,
  ISessionReader,
  LoadedSession,
} from "./types.js";

// Re-export interface types
export type { GetSessionOptions, ISessionReader } from "./types.js";

import {
  type ClaudeSessionEntry,
  getMessageContent,
  isCompactBoundary,
  isConversationEntry,
} from "@yep-anywhere/shared";
import { collectVisibleClaudeEntries } from "./claude-messages.js";
import { buildDag } from "./dag.js";

export interface ClaudeSessionReaderOptions {
  sessionDir: string;
  /** Additional session dirs from cross-machine merged projects */
  additionalDirs?: string[];
  /** Optional context window resolver (from ModelInfoService) */
  getContextWindow?: (
    model: string | undefined,
    provider?: ProviderName,
  ) => number;
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
  /** Agent type from meta.json (SDK 0.2.76+), e.g. "Explore", "Plan" */
  agentType?: string;
}

/**
 * Mapping of toolUseId to agentId.
 * Used to find agent sessions for pending Tasks on page reload.
 */
export interface AgentMapping {
  toolUseId: string;
  agentId: string;
  /** Agent type from meta.json (SDK 0.2.76+), e.g. "Explore", "Plan" */
  agentType?: string;
}

type UsageFields = {
  input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

/**
 * Get the total input tokens from a usage object.
 * Total = fresh input + cached reads + cache creation.
 */
function getTotalInputTokens(usage: UsageFields): number {
  return (
    (usage.input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0)
  );
}

/**
 * Compute the token overhead hidden from API-reported usage after compaction.
 *
 * When the Claude SDK compacts context, it writes a compact_boundary entry with
 * compactMetadata.preTokens — the actual context window fill level at compaction time.
 * However, the Anthropic API's usage.input_tokens on subsequent assistant messages only
 * reports the tokens actually sent (summary + new messages), which is much lower.
 * The difference is "overhead" — system prompt, tool definitions, and other context
 * the SDK tracks but the API doesn't include in usage.
 *
 * For sessions with compaction, we compute:
 *   overhead = preTokens - lastPreCompactionAssistantTokens
 *
 * This overhead is then added to post-compaction usage to get accurate context fill.
 *
 * @param messages - All messages on the active branch (not just user/assistant)
 * @returns Token overhead to add to API-reported input_tokens (0 if no compaction)
 */
export function computeCompactionOverhead(
  messages: ClaudeSessionEntry[],
): number {
  // Find the last compact_boundary with compactMetadata
  let lastCompactIdx = -1;
  let preTokens = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg && isCompactBoundary(msg)) {
      const metadata = (msg as { compactMetadata?: { preTokens?: number } })
        .compactMetadata;
      if (metadata?.preTokens) {
        lastCompactIdx = i;
        preTokens = metadata.preTokens;
        break;
      }
    }
  }

  if (lastCompactIdx === -1) {
    return 0; // No compaction, no overhead
  }

  // Find the last assistant message BEFORE the compaction boundary with non-zero usage
  for (let i = lastCompactIdx - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.type === "assistant") {
      const usage = (msg as { message?: { usage?: UsageFields } }).message
        ?.usage;
      if (usage) {
        const lastPreCompactionTokens = getTotalInputTokens(usage);
        if (lastPreCompactionTokens > 0) {
          const overhead = preTokens - lastPreCompactionTokens;
          return overhead > 0 ? overhead : 0;
        }
      }
    }
  }

  return 0; // No pre-compaction assistant message found
}

/**
 * Claude-specific session reader for Claude Code JSONL files.
 *
 * Handles Claude's DAG-based conversation structure with parentUuid,
 * agent sessions, orphaned tool detection, and context window tracking.
 */
export class ClaudeSessionReader implements ISessionReader {
  private sessionDir: string;
  private allSessionDirs: string[];
  private resolveContextWindow: (
    model: string | undefined,
    provider?: ProviderName,
  ) => number;

  constructor(options: ClaudeSessionReaderOptions) {
    this.sessionDir = options.sessionDir;
    this.allSessionDirs = [
      options.sessionDir,
      ...(options.additionalDirs ?? []),
    ];
    this.resolveContextWindow =
      options.getContextWindow ?? getModelContextWindow;
  }

  async listSessions(projectId: UrlProjectId): Promise<SessionSummary[]> {
    const summaries: SessionSummary[] = [];
    const seenIds = new Set<string>();

    for (const dir of this.allSessionDirs) {
      try {
        const files = await readdir(dir);
        // Filter out agent-* files (internal subagent warmup sessions)
        const jsonlFiles = files.filter(
          (f) => f.endsWith(".jsonl") && !f.startsWith("agent-"),
        );

        for (const file of jsonlFiles) {
          const sessionId = file.replace(".jsonl", "");
          if (seenIds.has(sessionId)) continue;
          seenIds.add(sessionId);
          const loaded = await this.loadSessionFromDir(
            dir,
            sessionId,
            projectId,
          );
          if (loaded) {
            summaries.push(loaded.summary);
          }
        }
      } catch {
        // Directory doesn't exist or not readable — continue to next
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
    for (const dir of this.allSessionDirs) {
      const result = await this.loadSessionFromDir(
        dir,
        sessionId,
        projectId,
      );
      if (result) return result.summary;
    }
    return null;
  }

  private async loadSessionFromDir(
    dir: string,
    sessionId: string,
    projectId: UrlProjectId,
    afterMessageId?: string,
  ): Promise<LoadedSession | null> {
    const filePath = join(dir, `${sessionId}.jsonl`);
    return this.loadSessionFromFilePath(
      filePath,
      sessionId,
      projectId,
      afterMessageId,
    );
  }

  private async loadSessionFromFilePath(
    filePath: string,
    sessionId: string,
    projectId: UrlProjectId,
    afterMessageId?: string,
  ): Promise<LoadedSession | null> {
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
            return JSON.parse(line) as ClaudeSessionEntry;
          } catch {
            return null;
          }
        })
        .filter((m): m is ClaudeSessionEntry => m !== null);

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
      const model = this.extractModel(conversationMessages);

      // claude-ollama sessions use the same JSONL format but have non-Claude
      // model IDs (e.g. "qwen3-coder-128k:latest" vs "claude-opus-4-5-20251101")
      const provider =
        model && !model.startsWith("claude-") ? "claude-ollama" : "claude";

      const contextUsage = this.extractContextUsage(
        activeBranch.map((node) => node.raw),
        model,
        provider,
      );

      let finalMessages = messages;
      if (afterMessageId) {
        const afterIndex = messages.findIndex(
          (m) => "uuid" in m && m.uuid === afterMessageId,
        );
        if (afterIndex !== -1) {
          finalMessages = messages.slice(afterIndex + 1);
        }
      }

      const summary: SessionSummary = {
        id: sessionId,
        projectId,
        title: this.extractTitle(firstUserMessage),
        fullTitle,
        createdAt: stats.birthtime.toISOString(),
        updatedAt: stats.mtime.toISOString(),
        messageCount: conversationMessages.length,
        ownership: { owner: "none" }, // Will be updated by Supervisor
        contextUsage,
        provider,
        model,
      };

      return {
        summary,
        data: {
          provider: summary.provider as "claude" | "claude-ollama",
          session: {
            messages: finalMessages,
          },
        },
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
  ): Promise<LoadedSession | null> {
    for (const dir of this.allSessionDirs) {
      const loaded = await this.loadSessionFromDir(
        dir,
        sessionId,
        projectId,
        afterMessageId,
      );
      if (loaded) {
        return loaded;
      }
    }
    return null;
  }

  /**
   * Get agent session content for lazy-loading completed Tasks/Agents.
   *
   * Agent JSONL files are stored at:
   * - SDK 0.2.76+: {sessionDir}/subagents/agent-{agentId}.jsonl
   * - Legacy: {sessionDir}/agent-{agentId}.jsonl
   *
   * @param agentId - The agent session ID (used as filename: agent-{agentId}.jsonl)
   * @returns Agent session with messages and inferred status
   */
  async getAgentSession(agentId: string): Promise<AgentSession> {
    // Find the agent file across all dirs, checking subagents/ subdir first (new SDK),
    // then root (legacy)
    let filePath: string | null = null;
    for (const dir of this.allSessionDirs) {
      for (const candidate of [
        join(dir, "subagents", `agent-${agentId}.jsonl`),
        join(dir, `agent-${agentId}.jsonl`),
      ]) {
        try {
          await stat(candidate);
          filePath = candidate;
          break;
        } catch {
          // Not here
        }
      }
      if (filePath) break;
    }
    if (!filePath) return { messages: [], status: "pending" };

    try {
      const content = await readFile(filePath, "utf-8");
      const trimmed = content.trim();

      if (!trimmed) {
        return { messages: [], status: "pending" };
      }

      const lines = trimmed.split("\n");
      const rawMessages: ClaudeSessionEntry[] = [];

      for (const line of lines) {
        try {
          rawMessages.push(JSON.parse(line) as ClaudeSessionEntry);
        } catch {
          // Skip malformed lines
        }
      }

      const { entries, orphanedToolUses } = collectVisibleClaudeEntries(
        rawMessages,
        { includeOrphans: false },
      );

      const messages: Message[] = entries.map((raw, index) =>
        this.convertMessage(raw, index, orphanedToolUses),
      );

      // Infer status from messages
      const status = this.inferAgentStatus(messages);

      // Read agent metadata (agentType from meta.json, SDK 0.2.76+)
      const meta = await this.readAgentMeta(filePath);

      return { messages, status, ...meta };
    } catch {
      // File doesn't exist or not readable - agent is pending
      return { messages: [], status: "pending" };
    }
  }

  /**
   * Get mappings of toolUseId → agentId for all agent files in the session directory.
   *
   * This is used to find agent sessions for pending Tasks/Agents on page reload.
   * Scans agent-*.jsonl files in both:
   * - {sessionDir}/subagents/ (SDK 0.2.76+)
   * - {sessionDir}/ (legacy)
   *
   * For legacy sessions, extracts parent_tool_use_id from first few lines.
   * For new SDK sessions, parent_tool_use_id is no longer present in subagent
   * messages — mapping is done at the caller level via agentId in tool result text.
   *
   * @returns Array of toolUseId → agentId mappings
   */
  async getAgentMappings(): Promise<AgentMapping[]> {
    const mappings: AgentMapping[] = [];
    const seenAgentIds = new Set<string>();

    for (const dir of this.allSessionDirs) {
      // Check both subagents/ subdir (new SDK) and root dir (legacy)
      const dirsToScan = [join(dir, "subagents"), dir];

      for (const scanDir of dirsToScan) {
        try {
          const files = await readdir(scanDir);
          const agentFiles = files.filter(
            (f) => f.startsWith("agent-") && f.endsWith(".jsonl"),
          );

          for (const file of agentFiles) {
            // Extract agentId from filename: agent-{agentId}.jsonl
            const agentId = file.slice(6, -6); // Remove "agent-" prefix and ".jsonl" suffix
            if (seenAgentIds.has(agentId)) continue;
            seenAgentIds.add(agentId);
            const filePath = join(scanDir, file);

            // Read agent metadata (agentType from meta.json, SDK 0.2.76+)
            const meta = await this.readAgentMeta(filePath);

            try {
              const content = await readFile(filePath, "utf-8");
              const trimmed = content.trim();
              if (!trimmed) continue;

              // Check first few lines for parent_tool_use_id (legacy format)
              const lines = trimmed.split("\n").slice(0, 5);
              let foundToolUseId = false;
              for (const line of lines) {
                try {
                  const msg = JSON.parse(line) as ClaudeSessionEntry & {
                    parent_tool_use_id?: string;
                  };
                  if (msg.parent_tool_use_id) {
                    mappings.push({
                      toolUseId: msg.parent_tool_use_id,
                      agentId,
                      ...meta,
                    });
                    foundToolUseId = true;
                    break;
                  }
                } catch {
                  // Skip malformed lines
                }
              }

              // SDK 0.2.76+: no parent_tool_use_id in subagent files.
              // Still register the agent so callers know it exists.
              // The toolUseId mapping comes from the main session's tool result text.
              if (!foundToolUseId) {
                mappings.push({
                  toolUseId: agentId, // Use agentId as placeholder
                  agentId,
                  ...meta,
                });
              }
            } catch {
              // Skip unreadable files
            }
          }
        } catch {
          // Directory doesn't exist or not readable
        }
      }
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
        if ("is_error" in msg && msg.is_error === true) {
          return "failed";
        }
        return "completed";
      }
    }

    // No result message - still running or interrupted
    return "running";
  }

  /**
   * Read agent metadata from meta.json file (SDK 0.2.76+).
   * Returns agentType if available, e.g. "Explore", "Plan".
   */
  private async readAgentMeta(
    agentFilePath: string,
  ): Promise<{ agentType?: string }> {
    const metaPath = agentFilePath.replace(/\.jsonl$/, ".meta.json");
    try {
      const raw = await readFile(metaPath, "utf-8");
      const meta = JSON.parse(raw) as { agentType?: string };
      return { agentType: meta.agentType };
    } catch {
      return {};
    }
  }

  /** Find the session file across all session dirs, returning the first match. */
  private async findSessionFile(sessionId: string): Promise<string | null> {
    for (const dir of this.allSessionDirs) {
      const candidate = join(dir, `${sessionId}.jsonl`);
      try {
        await stat(candidate);
        return candidate;
      } catch {
        // Not in this dir
      }
    }
    return null;
  }

  private findFirstUserMessage(messages: ClaudeSessionEntry[]): string | null {
    for (const msg of messages) {
      if (msg.type === "user") {
        const content = msg.message.content;
        if (content) {
          // Content can be string or array of content blocks
          if (typeof content === "string") {
            return this.extractTitleContent(content);
          }
          // Filter to object blocks only (skip string items), cast for compatibility
          const objectBlocks = content.filter(
            (b) => typeof b !== "string",
          ) as Array<{ type: string; text?: string }>;
          return this.extractTitleContent(objectBlocks);
        }
      }
    }
    return null;
  }

  /**
   * Extract context usage from the last assistant message.
   * Usage data is stored in message.usage with input_tokens, cache_read_input_tokens, etc.
   *
   * After compaction, the API's input_tokens only reflects tokens sent in the compacted
   * request (summary + new messages), which is much less than the actual context window
   * fill level. We use compactMetadata.preTokens from compact_boundary entries to compute
   * the hidden overhead (system prompt, tools, etc.) and add it to post-compaction usage.
   *
   * @param messages - All active branch messages (including system entries for compaction detection)
   * @param model - Model ID for determining context window size
   */
  private extractContextUsage(
    messages: ClaudeSessionEntry[],
    model: string | undefined,
    provider?: ProviderName,
  ): ContextUsage | undefined {
    const contextWindowSize = this.resolveContextWindow(model, provider);

    // Compute token overhead from compaction metadata.
    // After compaction, the API reports fewer input_tokens because old messages are
    // compressed into a summary. But the SDK's actual context window fill is higher.
    // compactMetadata.preTokens tells us the true fill level at compaction time.
    const overhead = computeCompactionOverhead(messages);

    // Find the last assistant message (iterate backwards)
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg && msg.type === "assistant") {
        const usage = msg.message.usage as
          | {
              input_tokens?: number;
              output_tokens?: number;
              cache_read_input_tokens?: number;
              cache_creation_input_tokens?: number;
            }
          | undefined;

        if (usage) {
          // Total input = fresh tokens + cached tokens + new cache creation
          const rawInputTokens =
            (usage.input_tokens ?? 0) +
            (usage.cache_read_input_tokens ?? 0) +
            (usage.cache_creation_input_tokens ?? 0);

          // Skip messages with zero input tokens (incomplete streaming messages)
          if (rawInputTokens === 0) {
            continue;
          }

          // Apply overhead correction for post-compaction messages
          const inputTokens = rawInputTokens + overhead;

          const percentage = Math.round(
            (inputTokens / contextWindowSize) * 100,
          );

          const result: ContextUsage = {
            inputTokens,
            percentage,
            contextWindow: contextWindowSize,
          };

          // Add optional fields if available
          if (usage.output_tokens !== undefined && usage.output_tokens > 0) {
            result.outputTokens = usage.output_tokens;
          }
          if (
            usage.cache_read_input_tokens !== undefined &&
            usage.cache_read_input_tokens > 0
          ) {
            result.cacheReadTokens = usage.cache_read_input_tokens;
          }
          if (
            usage.cache_creation_input_tokens !== undefined &&
            usage.cache_creation_input_tokens > 0
          ) {
            result.cacheCreationTokens = usage.cache_creation_input_tokens;
          }

          return result;
        }
      }
    }
    return undefined;
  }

  /**
   * Extract the model from the first assistant message.
   * The model is stored in message.model (e.g., "claude-opus-4-5-20251101").
   */
  private extractModel(messages: ClaudeSessionEntry[]): string | undefined {
    // Find the first assistant message with a real model field.
    // Skip "<synthetic>" which the SDK uses for error messages (e.g., 500 errors).
    for (const msg of messages) {
      if (msg.type === "assistant") {
        const model = msg.message.model;
        if (model && model !== "<synthetic>") {
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
    const filePath = await this.findSessionFile(sessionId);
    if (!filePath) return null;

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
    raw: ClaudeSessionEntry,
    _index: number,
    orphanedToolUses: Set<string> = new Set(),
  ): Message {
    // Normalize content blocks - pass through all fields
    let content: string | ContentBlock[] | undefined;
    const rawContent = getMessageContent(raw);
    if (typeof rawContent === "string") {
      content = rawContent;
    } else if (Array.isArray(rawContent)) {
      // Pass through all fields from each content block
      // Filter out string items (which can appear in user message content)
      content = rawContent
        .filter((block) => typeof block !== "string")
        .map((block) => ({ ...(block as object) })) as ContentBlock[];
    }

    // Build message by spreading all raw fields, then override with normalized values
    // Use type assertion since we're converting to a looser Message type
    const rawAny = raw as Record<string, unknown>;
    const message: Message = {
      ...rawAny,
      // Include normalized content if message had content
      ...(isConversationEntry(raw) && {
        message: {
          ...(raw.message as Record<string, unknown>),
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
