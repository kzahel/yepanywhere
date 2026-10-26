import {
  readIssueTextBatch,
  type IssueReadOptions,
} from "./issue-text-reader.js";
import { randomUUID } from "node:crypto";
import { isTransientFileReadError } from "../utils/fileReadError.js";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  type AgentStatus,
  type ClaudeProviderName,
  type ProviderChildSessionSummary,
  type ProviderName,
  type UrlProjectId,
  getModelContextWindow,
} from "@yep-anywhere/shared";
import type {
  ContentBlock,
  Message,
  SessionSummary,
} from "../supervisor/types.js";
import type {
  GetSessionOptions,
  GetSessionSummaryOptions,
  ISessionReader,
  LoadedSession,
} from "./types.js";
import { sortProviderChildSessions } from "./types.js";

// Re-export interface types
export type { GetSessionOptions, ISessionReader } from "./types.js";

import {
  type ClaudeSessionEntry,
  getMessageContent,
  isConversationEntry,
  isSyntheticNoResponseTurn,
} from "@yep-anywhere/shared";
import {
  assistantContentParts,
  formatAgentExcerpt,
  systemAwaySummaryExcerpt,
} from "./agent-excerpt.js";
import { collectVisibleClaudeEntries } from "./claude-messages.js";
import {
  buildSummaryFromState,
  hasClaudeTranscriptEntries,
  lastAgentExcerptFromState,
  readClaudeSessionSummary,
} from "./claude-summary.js";
import {
  type ClaudeTranscriptSnapshot,
  claudeTranscriptCache,
} from "./claude-transcript-cache.js";
import { SummaryParserClient } from "./summary-parser-worker-client.js";
import type {
  SummaryParserWorkerMode,
  SummaryParserWorkerRequest,
} from "./summary-parser-worker-protocol.js";

export interface ClaudeSessionReaderOptions {
  sessionDir: string;
  /** Additional session dirs from cross-machine merged projects */
  additionalDirs?: string[];
  /** Optional context window resolver (from ModelInfoService) */
  getContextWindow?: (
    model: string | undefined,
    provider?: ProviderName,
  ) => number;
  /** Default-off child-process summary parser gate. */
  summaryParserWorkerMode?: SummaryParserWorkerMode;
  /** Test/diagnostic injection for the summary parser worker client. */
  summaryParserClient?: SummaryParserClient;
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
  /** Provider description of the delegated task. */
  description?: string;
  /** Nesting depth reported by the provider. */
  spawnDepth?: number;
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
  /** Provider description of the delegated task. */
  description?: string;
  /** Nesting depth reported by the provider. */
  spawnDepth?: number;
}

interface AgentMeta {
  agentType?: string;
  description?: string;
  toolUseId?: string;
  spawnDepth?: number;
}

/**
 * Claude-specific session reader for Claude Code JSONL files.
 *
 * Handles Claude's DAG-based conversation structure with parentUuid,
 * agent sessions, orphaned tool detection, and context window tracking.
 */
export class ClaudeSessionReader implements ISessionReader {
  private allSessionDirs: string[];
  private resolveContextWindow: (
    model: string | undefined,
    provider?: ProviderName,
  ) => number;
  private summaryParserWorkerMode: SummaryParserWorkerMode;
  private summaryParserClient?: SummaryParserClient;

  constructor(options: ClaudeSessionReaderOptions) {
    this.allSessionDirs = [
      options.sessionDir,
      ...(options.additionalDirs ?? []),
    ];
    this.resolveContextWindow =
      options.getContextWindow ?? getModelContextWindow;
    this.summaryParserWorkerMode = options.summaryParserWorkerMode ?? "off";
    this.summaryParserClient = options.summaryParserClient;
  }

  async close(): Promise<void> {
    const client = this.summaryParserClient;
    this.summaryParserClient = undefined;
    await client?.close();
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
          const summary = await this.getSessionSummary(sessionId, projectId);
          if (summary) {
            seenIds.add(sessionId);
            summaries.push(summary);
          }
        }
      } catch (error) {
        if (isTransientFileReadError(error)) throw error;
        // Absent directories do not prevent reading another replica.
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
    options?: GetSessionSummaryOptions,
  ): Promise<SessionSummary | null> {
    let readError: unknown;
    for (const dir of this.allSessionDirs) {
      try {
        const result = await this.getSessionSummaryFromDir(
          dir,
          sessionId,
          projectId,
          options,
        );
        if (result) return result;
      } catch (error) {
        readError = error;
      }
    }
    if (readError) throw readError;
    return null;
  }

  /** Summary from an already-parsed transcript snapshot (no file re-read). */
  private summaryFromSnapshot(
    snapshot: ClaudeTranscriptSnapshot,
    filePath: string,
    sessionId: string,
    projectId: UrlProjectId,
    options?: GetSessionSummaryOptions,
  ): SessionSummary | null {
    if (snapshot.summaryState.metrics.parsedEntries === 0) return null;
    return buildSummaryFromState(snapshot.summaryState, {
      filePath,
      stats: snapshot.stats,
      sessionId,
      projectId,
      resolveContextWindow: this.resolveContextWindow,
      includeCompactionSafetyMargin:
        options?.contextUsageMode === "manual-compaction",
    });
  }

  private async getSessionSummaryFromDir(
    dir: string,
    sessionId: string,
    projectId: UrlProjectId,
    options?: GetSessionSummaryOptions,
  ): Promise<SessionSummary | null> {
    const filePath = join(dir, `${sessionId}.jsonl`);

    try {
      // A warm transcript cache entry (detail-loaded session) revalidates
      // incrementally; summary-only callers never populate the cache.
      const cached = await claudeTranscriptCache.peek(filePath);
      if (cached) {
        return this.summaryFromSnapshot(
          cached,
          filePath,
          sessionId,
          projectId,
          options,
        );
      }

      const stats = await stat(filePath);
      const inProcessParser = () =>
        readClaudeSessionSummary({
          filePath,
          stats,
          sessionId,
          projectId,
          resolveContextWindow: this.resolveContextWindow,
          includeCompactionSafetyMargin:
            options?.contextUsageMode === "manual-compaction",
        });

      if (
        this.summaryParserWorkerMode === "off" ||
        options?.contextUsageMode === "manual-compaction"
      ) {
        return await inProcessParser();
      }

      const request: SummaryParserWorkerRequest = {
        type: "parse",
        requestId: randomUUID(),
        provider: "claude",
        filePath,
        sessionId,
        projectId,
        stats: {
          size: Number(stats.size),
          mtimeMs: Number(stats.mtimeMs),
          mtimeIso: stats.mtime.toISOString(),
        },
        sourceHints: {
          claude: { sessionDir: dir },
        },
      };
      const result = await this.getSummaryParserClient().parse(
        request,
        inProcessParser,
      );
      return result.summary;
    } catch (error) {
      if (isTransientFileReadError(error)) throw error;
      return null;
    }
  }

  /** Use the same replica selection for indexes, retained catalogs and detail. */
  async listSessionFiles(
    _sessionDir: string,
  ): Promise<{ sessionId: string; filePath: string }[]> {
    const ids = new Set<string>();
    for (const dir of this.allSessionDirs) {
      try {
        for (const name of await readdir(dir)) {
          if (name.endsWith(".jsonl") && !name.startsWith("agent-"))
            ids.add(name.slice(0, -6));
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const files: { sessionId: string; filePath: string }[] = [];
    for (const sessionId of ids) {
      const filePath = await this.findSessionFile(sessionId);
      if (filePath) files.push({ sessionId, filePath });
    }
    return files;
  }

  private getSummaryParserClient(): SummaryParserClient {
    this.summaryParserClient ??= new SummaryParserClient({
      mode: this.summaryParserWorkerMode,
    });
    return this.summaryParserClient;
  }

  /**
   * Absolute path to a session's `.jsonl`, or null if no on-disk file exists.
   * Claude sessions are `<sessionDir>/<sessionId>.jsonl`; a project can map to
   * more than one session dir (alias/encoding), so probe each candidate.
   */
  async readIssueTextBatch(sessionId: string, options: IssueReadOptions) {
    const path = await this.getSessionFilePath(sessionId);
    if (!path) throw new Error("Session source unavailable");
    return readIssueTextBatch("claude", [{ path }], options);
  }

  async getSessionFilePath(sessionId: string): Promise<string | null> {
    return this.findSessionFile(sessionId);
  }

  async getSession(
    sessionId: string,
    projectId: UrlProjectId,
    afterMessageId?: string,
    _options?: GetSessionOptions,
  ): Promise<LoadedSession | null> {
    // Find the session file across all dirs
    const filePath = await this.findSessionFile(sessionId);
    if (!filePath) return null;

    // One cached parse serves both the summary and the message list; the
    // previous shape read and parsed the full file twice per request.
    const snapshot = await claudeTranscriptCache.load(filePath);
    if (!snapshot) return null;

    const summary = this.summaryFromSnapshot(
      snapshot,
      filePath,
      sessionId,
      projectId,
    );
    if (!summary) return null;

    const rawMessages = snapshot.entries;

    // Filter messages for incremental fetching if needed
    // Note: Raw messages might not have UUIDs if they are old format or haven't been normalized.
    // But typically they do.
    let finalMessages = rawMessages;
    if (afterMessageId) {
      const afterIndex = rawMessages.findIndex(
        (m) => "uuid" in m && m.uuid === afterMessageId,
      );
      if (afterIndex !== -1) {
        finalMessages = rawMessages.slice(afterIndex + 1);
      }
    }

    return {
      summary,
      transcriptSnapshotUpdatedAt: snapshot.stats.mtime.toISOString(),
      data: {
        provider: summary.provider as ClaudeProviderName,
        session: {
          messages: finalMessages,
        },
      },
    };
  }

  /**
   * Get agent session content for lazy-loading completed Tasks/Agents.
   *
   * Agent JSONL files are stored at:
   * - Current SDK: {sessionDir}/{parentSessionId}/subagents/agent-{agentId}.jsonl
   * - SDK 0.2.76+: {sessionDir}/subagents/agent-{agentId}.jsonl
   * - Legacy: {sessionDir}/agent-{agentId}.jsonl
   *
   * @param agentId - The agent session ID (used as filename: agent-{agentId}.jsonl)
   * @returns Agent session with messages and inferred status
   */
  async getAgentSession(
    agentId: string,
    parentSessionId?: string,
  ): Promise<AgentSession> {
    // Find the agent file across all dirs, checking subagents/ subdir first (new SDK),
    // then root (legacy)
    let filePath: string | null = null;
    for (const dir of this.getAgentDirectories(parentSessionId)) {
      const candidate = join(dir, `agent-${agentId}.jsonl`);
      try {
        await stat(candidate);
        filePath = candidate;
        break;
      } catch {
        // Not here
      }
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
   * - {sessionDir}/{parentSessionId}/subagents/ (current SDK)
   * - {sessionDir}/subagents/ (SDK 0.2.76+)
   * - {sessionDir}/ (legacy)
   *
   * For legacy sessions, extracts parent_tool_use_id from first few lines.
   * For current SDK sessions, parent_tool_use_id is no longer present in
   * subagent messages; the metadata sidecar carries the launch tool call ID.
   *
   * @returns Array of toolUseId → agentId mappings
   */
  async getAgentMappings(parentSessionId?: string): Promise<AgentMapping[]> {
    const mappings: AgentMapping[] = [];
    const seenAgentIds = new Set<string>();

    for (const scanDir of this.getAgentDirectories(parentSessionId)) {
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
                    ...meta,
                    toolUseId: msg.parent_tool_use_id,
                    agentId,
                  });
                  foundToolUseId = true;
                  break;
                }
              } catch {
                // Skip malformed lines
              }
            }

            // Current SDK metadata carries the launch tool call ID. Older
            // sidecars did not, so keep the agent-ID fallback for those files.
            if (!foundToolUseId) {
              mappings.push({
                ...meta,
                toolUseId: meta.toolUseId ?? agentId,
                agentId,
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

    return mappings;
  }

  async listProviderChildSessions(
    parentSessionId: string,
  ): Promise<ProviderChildSessionSummary[]> {
    const children: ProviderChildSessionSummary[] = [];
    const seenAgentIds = new Set<string>();

    for (const dir of this.allSessionDirs) {
      const childDir = join(dir, parentSessionId, "subagents");
      let files: string[];
      try {
        files = await readdir(childDir);
      } catch {
        continue;
      }

      for (const file of files) {
        if (!file.startsWith("agent-") || !file.endsWith(".jsonl")) {
          continue;
        }
        const agentId = file.slice(6, -6);
        if (seenAgentIds.has(agentId)) continue;

        const filePath = join(childDir, file);
        try {
          const [fileStat, meta] = await Promise.all([
            stat(filePath),
            this.readAgentMeta(filePath),
          ]);
          seenAgentIds.add(agentId);
          children.push({
            id: agentId,
            parentSessionId,
            ...(meta.description && { title: meta.description }),
            ...(meta.agentType && { agentType: meta.agentType }),
            ...(meta.toolUseId && { toolUseId: meta.toolUseId }),
            ...(meta.spawnDepth !== undefined && {
              spawnDepth: meta.spawnDepth,
            }),
            updatedAt: fileStat.mtime.toISOString(),
          });
        } catch {
          // The child disappeared or became unreadable during enumeration.
        }
      }
    }

    return sortProviderChildSessions(children);
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
   * Read provider child metadata from the JSON sidecar when available.
   */
  private async readAgentMeta(agentFilePath: string): Promise<AgentMeta> {
    const metaPath = agentFilePath.replace(/\.jsonl$/, ".meta.json");
    try {
      const raw = await readFile(metaPath, "utf-8");
      const meta = JSON.parse(raw) as Record<string, unknown>;
      return {
        ...(typeof meta.agentType === "string" && {
          agentType: meta.agentType,
        }),
        ...(typeof meta.description === "string" && {
          description: meta.description,
        }),
        ...(typeof meta.toolUseId === "string" && {
          toolUseId: meta.toolUseId,
        }),
        ...(typeof meta.spawnDepth === "number" && {
          spawnDepth: meta.spawnDepth,
        }),
      };
    } catch {
      return {};
    }
  }

  /**
   * Candidate directories for provider child transcripts, newest layout first.
   * Parent scoping excludes other current-layout session directories while the
   * project-level candidates preserve compatibility with older SDK layouts.
   */
  private getAgentDirectories(parentSessionId?: string): string[] {
    const directories: string[] = [];
    for (const dir of this.allSessionDirs) {
      if (parentSessionId) {
        directories.push(join(dir, parentSessionId, "subagents"));
      }
      directories.push(join(dir, "subagents"), dir);
    }
    return [...new Set(directories)];
  }

  /** Select a readable transcript, not an empty/partial replica ahead of it. */
  private async findSessionFile(sessionId: string): Promise<string | null> {
    let readError: unknown;
    for (const dir of this.allSessionDirs) {
      const candidate = join(dir, `${sessionId}.jsonl`);
      try {
        if (!(await stat(candidate)).isFile()) continue;
        if (this.allSessionDirs.length > 1) {
          if (!(await hasClaudeTranscriptEntries(candidate))) continue;
        }
        return candidate;
      } catch (error) {
        if (isTransientFileReadError(error)) readError = error;
      }
    }
    if (readError) throw readError;
    return null;
  }

  /**
   * Fast, on-demand recompute of the hover-card excerpt for a non-running
   * session: read the file and scan raw lines from the end, parsing only until
   * an assistant turn qualifies — skipping the full parse + DAG build the
   * summary path does. Approximates the active branch (a post-rewind dead
   * branch could win), which is acceptable for a preview. Used to refresh a
   * stale preview on focus/hover. See topics/session-hovercard-recent-activity.md.
   */
  async getLastAgentExcerpt(sessionId: string): Promise<string | undefined> {
    const filePath = await this.findSessionFile(sessionId);
    if (!filePath) return undefined;
    // A warm transcript avoids re-reading the file and yields the same
    // active-branch excerpt the summary path computes.
    const cached = await claudeTranscriptCache.peek(filePath);
    if (cached && cached.summaryState.metrics.parsedEntries > 0) {
      const excerpt = lastAgentExcerptFromState(cached.summaryState);
      if (excerpt) return excerpt;
    }
    let content: string;
    try {
      content = await readFile(filePath, "utf-8");
    } catch {
      return undefined;
    }
    const lines = content.split("\n");
    let trailingTool: string | undefined;
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]?.trim();
      if (!line) continue;
      let entry: {
        type?: string;
        subtype?: string;
        content?: unknown;
        message?: { content?: unknown; model?: unknown };
      };
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const awaySummary = systemAwaySummaryExcerpt(entry);
      if (awaySummary) return awaySummary;
      if (entry.type !== "assistant") continue;
      // No model produced this text, so quoting it would attribute a reply to
      // the agent that it never gave.
      if (isSyntheticNoResponseTurn(entry)) continue;
      const { text, toolName } = assistantContentParts(entry.message?.content);
      const excerpt = formatAgentExcerpt(text);
      if (excerpt) return excerpt;
      if (!trailingTool && toolName) trailingTool = toolName;
    }
    return trailingTool ? `⚙ ${trailingTool}` : undefined;
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
    } catch (error) {
      if (isTransientFileReadError(error)) throw error;
      return null;
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
