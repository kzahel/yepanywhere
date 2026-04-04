import {
  type ContextUsage,
  type ModelOption,
  type PermissionRules,
  type ProviderName,
  type ThinkingOption,
  type UploadedFile,
  type UrlProjectId,
  getModelContextWindow,
  isUrlProjectId,
  thinkingOptionToConfig,
} from "@yep-anywhere/shared";
import { Hono } from "hono";
import { augmentTextBlocks } from "../augments/markdown-augments.js";
import type { SessionMetadataService } from "../metadata/index.js";
import type { NotificationService } from "../notifications/index.js";
import type { CodexSessionScanner } from "../projects/codex-scanner.js";
import type { GeminiSessionScanner } from "../projects/gemini-scanner.js";
import type { ProjectScanner } from "../projects/scanner.js";
import { getProjectDirFromCwd, syncSessions } from "../sdk/session-sync.js";
import type { PermissionMode, SDKMessage, UserMessage } from "../sdk/types.js";
import type { ModelInfoService } from "../services/ModelInfoService.js";
import type { ServerSettingsService } from "../services/ServerSettingsService.js";
import { CodexSessionReader } from "../sessions/codex-reader.js";
import { cloneClaudeSession, cloneCodexSession } from "../sessions/fork.js";
import { GeminiSessionReader } from "../sessions/gemini-reader.js";
import { normalizeSession } from "../sessions/normalization.js";
import {
  type PaginationInfo,
  sliceAtCompactBoundaries,
} from "../sessions/pagination.js";
import { augmentPersistedSessionMessages } from "../sessions/persisted-augments.js";
import { findSessionSummaryAcrossProviders } from "../sessions/provider-resolution.js";
import type { ISessionReader } from "../sessions/types.js";
import type { ExternalSessionTracker } from "../supervisor/ExternalSessionTracker.js";
import type { Process } from "../supervisor/Process.js";
import type {
  QueueFullResponse,
  Supervisor,
} from "../supervisor/Supervisor.js";
import type { QueuedResponse } from "../supervisor/WorkerQueue.js";
import type { ContentBlock, Message, Project } from "../supervisor/types.js";
import {
  isValidSshHostAlias,
  normalizeSshHostAlias,
} from "../utils/sshHostAlias.js";
import {
  type WorktreeInfo,
  cleanupWorktree,
  createWorktree,
} from "../utils/worktree.js";
import type { EventBus } from "../watcher/index.js";

/**
 * Type guard to check if a result is a QueuedResponse
 */
function isQueuedResponse(
  result: Process | QueuedResponse | QueueFullResponse,
): result is QueuedResponse {
  return "queued" in result && result.queued === true;
}

/**
 * Type guard to check if a result is a QueueFullResponse
 */
function isQueueFullResponse(
  result: Process | QueuedResponse | QueueFullResponse,
): result is QueueFullResponse {
  return "error" in result && result.error === "queue_full";
}

function parseOptionalExecutor(rawExecutor: unknown): {
  executor: string | undefined;
  error?: string;
} {
  if (rawExecutor === undefined || rawExecutor === null) {
    return { executor: undefined };
  }
  if (typeof rawExecutor !== "string") {
    return { executor: undefined, error: "executor must be a string" };
  }

  const executor = normalizeSshHostAlias(rawExecutor);
  if (!executor) {
    return { executor: undefined };
  }
  if (!isValidSshHostAlias(executor)) {
    return {
      executor: undefined,
      error: "executor must be a valid SSH host alias",
    };
  }

  return { executor };
}

function isCodexProviderName(
  provider: ProviderName | string | undefined,
): provider is "codex" | "codex-oss" {
  return provider === "codex" || provider === "codex-oss";
}

export interface SessionsDeps {
  supervisor: Supervisor;
  scanner: ProjectScanner;
  readerFactory: (project: Project) => ISessionReader;
  externalTracker?: ExternalSessionTracker;
  notificationService?: NotificationService;
  sessionMetadataService?: SessionMetadataService;
  eventBus?: EventBus;
  codexScanner?: CodexSessionScanner;
  codexSessionsDir?: string;
  /** Optional shared Codex reader factory for cross-provider session lookups */
  codexReaderFactory?: (projectPath: string) => CodexSessionReader;
  geminiScanner?: GeminiSessionScanner;
  geminiSessionsDir?: string;
  /** Optional shared Gemini reader factory for cross-provider session lookups */
  geminiReaderFactory?: (projectPath: string) => GeminiSessionReader;
  /** ServerSettingsService for reading global instructions */
  serverSettingsService?: ServerSettingsService;
  /** ModelInfoService for context window lookups */
  modelInfoService?: ModelInfoService;
}

interface StartSessionBody {
  message: string;
  images?: string[];
  documents?: string[];
  attachments?: UploadedFile[];
  mode?: PermissionMode;
  model?: ModelOption;
  thinking?: ThinkingOption;
  provider?: ProviderName;
  /** Client-generated temp ID for optimistic UI tracking */
  tempId?: string;
  /** SSH host alias for remote execution (undefined = local) */
  executor?: string;
  /** Permission rules for tool filtering (deny/allow patterns) */
  permissions?: PermissionRules;
  /** Whether to create a git worktree for this session */
  worktree?: boolean;
}

interface CreateSessionBody {
  mode?: PermissionMode;
  model?: ModelOption;
  thinking?: ThinkingOption;
  provider?: ProviderName;
  /** SSH host alias for remote execution (undefined = local) */
  executor?: string;
  /** Permission rules for tool filtering (deny/allow patterns) */
  permissions?: PermissionRules;
  /** Whether to create a git worktree for this session */
  worktree?: boolean;
}

interface InputResponseBody {
  requestId: string;
  response: "approve" | "approve_accept_edits" | "deny" | string;
  answers?: Record<string, string>;
  feedback?: string;
}

/**
 * Try to create a worktree for a session using server settings.
 * Returns the worktree info and effective session path.
 * Falls back to originalPath on failure.
 */
async function tryCreateWorktree(
  projectPath: string,
  requestWorktree: boolean | undefined,
  executor: string | undefined,
  serverSettings: ServerSettingsService | undefined,
): Promise<{ sessionPath: string; worktreeInfo?: WorktreeInfo }> {
  const useWt =
    requestWorktree ??
    serverSettings?.getSetting("worktreeEnabled") ??
    false;

  if (!useWt || executor) {
    return { sessionPath: projectPath };
  }

  try {
    const worktreeInfo = await createWorktree(projectPath, {
      copyFiles: serverSettings?.getSetting("worktreeCopyFiles") || undefined,
      symlinkDirectories:
        serverSettings?.getSetting("worktreeSymlinkDirectories") || undefined,
      postCreateCommand:
        serverSettings?.getSetting("worktreePostCreateCommand") || undefined,
    });
    return { sessionPath: worktreeInfo.worktreePath, worktreeInfo };
  } catch (error) {
    console.warn(
      "[worktree] Creation failed, using original path:",
      error instanceof Error ? error.message : error,
    );
    return { sessionPath: projectPath };
  }
}

/**
 * Convert SDK messages to client Message format.
 * Used for mock SDK sessions where messages aren't persisted to disk.
 */
function sdkMessagesToClientMessages(sdkMessages: SDKMessage[]): Message[] {
  const messages: Message[] = [];
  for (const msg of sdkMessages) {
    // Only include user and assistant messages with content
    if (
      (msg.type === "user" || msg.type === "assistant") &&
      msg.message?.content
    ) {
      const rawContent = msg.message.content;
      // Both user and assistant messages can have string or array content.
      // User messages with tool_result blocks have array content that must be preserved.
      // Assistant messages need ContentBlock[] format for preprocessMessages to render.
      let content: string | ContentBlock[];
      if (typeof rawContent === "string") {
        // String content: keep as-is for user messages, wrap in text block for assistant
        content =
          msg.type === "user"
            ? rawContent
            : [{ type: "text" as const, text: rawContent }];
      } else if (Array.isArray(rawContent)) {
        // Array content: pass through as ContentBlock[] for both user and assistant
        content = rawContent as ContentBlock[];
      } else {
        // Unknown content type - skip this message
        continue;
      }

      messages.push({
        id: msg.uuid ?? `msg-${Date.now()}-${messages.length}`,
        type: msg.type,
        role: msg.type as "user" | "assistant",
        content,
        timestamp:
          typeof msg.timestamp === "string" && msg.timestamp.trim().length > 0
            ? msg.timestamp
            : new Date().toISOString(),
      });
    }
  }
  return messages;
}

/**
 * Compute compaction overhead from SDK messages.
 * Same logic as computeCompactionOverhead in reader.ts but for SDKMessage type.
 */
function computeSDKCompactionOverhead(sdkMessages: SDKMessage[]): number {
  // Find the last compact_boundary with compactMetadata
  let lastCompactIdx = -1;
  let preTokens = 0;

  for (let i = sdkMessages.length - 1; i >= 0; i--) {
    const msg = sdkMessages[i];
    if (msg?.type === "system" && msg.subtype === "compact_boundary") {
      const metadata = (msg as { compactMetadata?: { preTokens?: number } })
        .compactMetadata;
      if (metadata?.preTokens) {
        lastCompactIdx = i;
        preTokens = metadata.preTokens;
        break;
      }
    }
  }

  if (lastCompactIdx === -1) return 0;

  // Find last assistant message before compaction with non-zero usage
  for (let i = lastCompactIdx - 1; i >= 0; i--) {
    const msg = sdkMessages[i];
    if (msg?.type === "assistant" && msg.usage) {
      const usage = msg.usage as {
        input_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      };
      const total =
        (usage.input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0);
      if (total > 0) {
        const overhead = preTokens - total;
        return overhead > 0 ? overhead : 0;
      }
    }
  }

  return 0;
}

/**
 * Extract context usage from SDK messages.
 * Finds the last assistant message with usage data.
 *
 * @param sdkMessages - SDK messages to search
 * @param model - Model ID for determining context window size
 * @param provider - Provider for model-less context-window fallback
 */
function extractContextUsageFromSDKMessages(
  sdkMessages: SDKMessage[],
  model: string | undefined,
  provider?: ProviderName,
  resolveContextWindow?: (
    model: string | undefined,
    provider?: ProviderName,
  ) => number,
): ContextUsage | undefined {
  const contextWindowSize = resolveContextWindow
    ? resolveContextWindow(model, provider)
    : getModelContextWindow(model, provider);

  const isCodexProvider = provider === "codex" || provider === "codex-oss";

  // Compute compaction overhead for Claude sessions
  const overhead = isCodexProvider
    ? 0
    : computeSDKCompactionOverhead(sdkMessages);

  // Find the last assistant message with usage data (iterate backwards)
  for (let i = sdkMessages.length - 1; i >= 0; i--) {
    const msg = sdkMessages[i];
    if (msg && msg.type === "assistant" && msg.usage) {
      const usage = msg.usage as {
        input_tokens?: number;
        output_tokens?: number;
        cached_input_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      };

      // Codex context meter is based on fresh input tokens from the latest turn.
      // Claude/OpenCode/Gemini paths continue to include cached+creation tokens.
      const rawInputTokens = isCodexProvider
        ? (usage.input_tokens ?? 0)
        : (usage.input_tokens ?? 0) +
          (usage.cache_read_input_tokens ?? 0) +
          (usage.cache_creation_input_tokens ?? 0);

      // Skip messages with zero input tokens (incomplete streaming messages)
      if (rawInputTokens === 0) {
        continue;
      }

      // Apply compaction overhead correction
      const inputTokens = rawInputTokens + overhead;

      const percentage = Math.round((inputTokens / contextWindowSize) * 100);

      const result: ContextUsage = {
        inputTokens,
        percentage,
        contextWindow: contextWindowSize,
      };

      // Add optional fields if available
      if (usage.output_tokens !== undefined && usage.output_tokens > 0) {
        result.outputTokens = usage.output_tokens;
      }
      if (isCodexProvider) {
        if (
          usage.cached_input_tokens !== undefined &&
          usage.cached_input_tokens > 0
        ) {
          result.cacheReadTokens = usage.cached_input_tokens;
        }
      } else if (
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
  return undefined;
}

export function createSessionsRoutes(deps: SessionsDeps): Hono {
  const routes = new Hono();
  const getCodexReader = (projectPath: string): CodexSessionReader | null =>
    deps.codexReaderFactory?.(projectPath) ??
    (deps.codexSessionsDir
      ? new CodexSessionReader({
          sessionsDir: deps.codexSessionsDir,
          projectPath,
        })
      : null);

  // GET /api/projects/:projectId/sessions/:sessionId/agents - Get agent mappings
  // Used to find agent sessions for pending Tasks on page reload
  routes.get("/projects/:projectId/sessions/:sessionId/agents", async (c) => {
    const projectId = c.req.param("projectId");

    // Validate projectId format at API boundary
    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }

    const project = await deps.scanner.getOrCreateProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    const reader = deps.readerFactory(project);
    const mappings = await reader.getAgentMappings();

    return c.json({ mappings });
  });

  // GET /api/projects/:projectId/sessions/:sessionId/agents/:agentId - Get agent session content
  // Used for lazy-loading completed Tasks
  routes.get(
    "/projects/:projectId/sessions/:sessionId/agents/:agentId",
    async (c) => {
      const projectId = c.req.param("projectId");
      const agentId = c.req.param("agentId");

      // Validate projectId format at API boundary
      if (!isUrlProjectId(projectId)) {
        return c.json({ error: "Invalid project ID format" }, 400);
      }

      const project = await deps.scanner.getOrCreateProject(projectId);
      if (!project) {
        return c.json({ error: "Project not found" }, 404);
      }

      const reader = deps.readerFactory(project);
      const agentSession = await reader.getAgentSession(agentId);

      if (!agentSession) {
        return c.json({ error: "Agent session not found" }, 404);
      }

      // Add server-rendered HTML to text blocks for markdown display
      await augmentTextBlocks(agentSession.messages);

      return c.json(agentSession);
    },
  );

  // GET /api/projects/:projectId/sessions/:sessionId/metadata - Get session metadata only (no messages)
  // Lightweight endpoint for refreshing title, status, etc. without re-fetching all messages
  routes.get("/projects/:projectId/sessions/:sessionId/metadata", async (c) => {
    const projectId = c.req.param("projectId");
    const sessionId = c.req.param("sessionId");

    // Validate projectId format at API boundary
    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }

    const project = await deps.scanner.getOrCreateProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    // Check if session is actively owned by a process
    const process = deps.supervisor.getProcessForSession(sessionId);

    // Check if session is being controlled by an external program
    const isExternal = deps.externalTracker?.isExternal(sessionId) ?? false;

    // Determine the session ownership
    const ownership = process
      ? {
          owner: "self" as const,
          processId: process.id,
          permissionMode: process.permissionMode,
          modeVersion: process.modeVersion,
          state: process.state.type,
        }
      : isExternal
        ? { owner: "external" as const }
        : { owner: "none" as const };

    // Get session metadata (custom title, archived, starred)
    const metadata = deps.sessionMetadataService?.getMetadata(sessionId);

    // Get notification data (lastSeenAt, hasUnread)
    const lastSeenEntry = deps.notificationService?.getLastSeen(sessionId);
    const lastSeenAt = lastSeenEntry?.timestamp;

    // Get pending input request from active process
    const pendingInputRequest =
      process?.state.type === "waiting-input" ? process.state.request : null;

    // Get available slash commands from active process
    const slashCommands = process?.supportsDynamicCommands
      ? await process.supportedCommands()
      : null;

    // Read minimal session info from disk (just for title/timestamps, no messages)
    const metadataProvider = deps.sessionMetadataService?.getProvider(
      sessionId,
    ) as ProviderName | undefined;
    const sessionSummaryResult = await findSessionSummaryAcrossProviders(
      project,
      sessionId,
      projectId as UrlProjectId,
      {
        readerFactory: deps.readerFactory,
        codexSessionsDir: deps.codexSessionsDir,
        codexReaderFactory: deps.codexReaderFactory,
        geminiSessionsDir: deps.geminiSessionsDir,
        geminiReaderFactory: deps.geminiReaderFactory,
        geminiHashToCwd: deps.geminiScanner?.getHashToCwd(),
      },
      process?.provider ?? metadataProvider,
    );
    const sessionSummary = sessionSummaryResult?.summary ?? null;

    if (!sessionSummary && !process) {
      return c.json({ error: "Session not found" }, 404);
    }

    // Calculate hasUnread if we have session summary
    const hasUnread =
      deps.notificationService && sessionSummary
        ? deps.notificationService.hasUnread(
            sessionId,
            sessionSummary.updatedAt,
          )
        : undefined;

    return c.json({
      session: {
        id: sessionId,
        projectId,
        title: sessionSummary?.title ?? null,
        fullTitle: sessionSummary?.fullTitle ?? null,
        createdAt: sessionSummary?.createdAt ?? new Date().toISOString(),
        updatedAt: sessionSummary?.updatedAt ?? new Date().toISOString(),
        messageCount: sessionSummary?.messageCount ?? 0,
        provider: sessionSummary?.provider ?? project.provider,
        model: sessionSummary?.model,
        originator: sessionSummary?.originator,
        cliVersion: sessionSummary?.cliVersion,
        source: sessionSummary?.source,
        approvalPolicy: sessionSummary?.approvalPolicy,
        sandboxPolicy: sessionSummary?.sandboxPolicy,
        contextUsage: sessionSummary?.contextUsage,
        customTitle: metadata?.customTitle,
        isArchived: metadata?.isArchived,
        isStarred: metadata?.isStarred,
        lastSeenAt,
        hasUnread,
      },
      ownership,
      pendingInputRequest,
      slashCommands,
    });
  });

  // GET /api/projects/:projectId/sessions/:sessionId - Get session detail
  // Optional query params:
  //   ?afterMessageId=<id> - incremental forward-fetch (append new messages)
  //   ?tailCompactions=<n> - return only last N compact boundaries worth of messages
  //   ?beforeMessageId=<id> - cursor for loading older chunks (used with tailCompactions)
  routes.get("/projects/:projectId/sessions/:sessionId", async (c) => {
    const projectId = c.req.param("projectId");
    const sessionId = c.req.param("sessionId");
    const afterMessageId = c.req.query("afterMessageId");
    const tailCompactionsParam = c.req.query("tailCompactions");
    const beforeMessageId = c.req.query("beforeMessageId");
    const tailCompactions =
      tailCompactionsParam !== undefined
        ? Number.parseInt(tailCompactionsParam, 10)
        : undefined;

    // Validate projectId format at API boundary
    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }

    // Use getOrCreateProject to support Codex projects that may not be in the scan cache yet
    const project = await deps.scanner.getOrCreateProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    // Check if session is actively owned by a process
    const process = deps.supervisor.getProcessForSession(sessionId);

    // Check if session is being controlled by an external program
    const isExternal = deps.externalTracker?.isExternal(sessionId) ?? false;

    // Check if we've ever owned this session (for orphan detection)
    // Only mark tools as "aborted" if we owned the session and know it terminated
    const wasEverOwned = deps.supervisor.wasEverOwned(sessionId);

    // Always try to read from disk first (even for owned sessions)
    const reader = deps.readerFactory(project);
    let loadedSession = await reader.getSession(
      sessionId,
      project.id,
      afterMessageId,
      {
        // Only include orphaned tool info if:
        // 1. We previously owned this session (not external)
        // 2. No active process (tools aren't potentially in progress)
        // When we own the session, tools without results might be pending approval
        includeOrphans: wasEverOwned && !process,
      },
    );

    // For Claude projects, also check for Codex sessions if primary reader didn't find it
    // This handles mixed projects that have sessions from multiple providers
    if (
      !loadedSession &&
      project.provider === "claude" &&
      (deps.codexReaderFactory || deps.codexSessionsDir)
    ) {
      const codexReader =
        deps.codexReaderFactory?.(project.path) ??
        (deps.codexSessionsDir
          ? new CodexSessionReader({
              sessionsDir: deps.codexSessionsDir,
              projectPath: project.path,
            })
          : null);
      if (codexReader) {
        loadedSession = await codexReader.getSession(
          sessionId,
          project.id,
          afterMessageId,
          { includeOrphans: wasEverOwned && !process },
        );
      }
    }

    // For Claude/Codex projects, also check for Gemini sessions if still not found
    // This handles mixed projects that have sessions from multiple providers
    if (
      !loadedSession &&
      (project.provider === "claude" || project.provider === "codex") &&
      (deps.geminiReaderFactory || deps.geminiSessionsDir)
    ) {
      const geminiReader =
        deps.geminiReaderFactory?.(project.path) ??
        (deps.geminiSessionsDir
          ? new GeminiSessionReader({
              sessionsDir: deps.geminiSessionsDir,
              projectPath: project.path,
              hashToCwd: deps.geminiScanner?.getHashToCwd(),
            })
          : null);
      if (geminiReader) {
        loadedSession = await geminiReader.getSession(
          sessionId,
          project.id,
          afterMessageId,
          { includeOrphans: wasEverOwned && !process },
        );
      }
    }

    let session = loadedSession ? normalizeSession(loadedSession) : null;

    // Determine the session ownership
    const ownership = process
      ? {
          owner: "self" as const,
          processId: process.id,
          permissionMode: process.permissionMode,
          modeVersion: process.modeVersion,
        }
      : isExternal
        ? { owner: "external" as const }
        : (session?.ownership ?? { owner: "none" as const });

    // Get pending input request from active process (for tool approval prompts)
    // This ensures clients get pending requests immediately without waiting for SSE
    const pendingInputRequest =
      process?.state.type === "waiting-input" ? process.state.request : null;

    // Get available slash commands from active process (for "/" button in toolbar)
    // The init message that normally carries these gets discarded from the SSE buffer
    // after ~30s, so we attach them to the REST response for reliable delivery.
    const slashCommands = process?.supportsDynamicCommands
      ? await process.supportedCommands()
      : null;

    if (!session) {
      // Session file doesn't exist yet - only valid if we own the process
      if (process) {
        // Get raw messages from process memory
        const sdkMessages = process.getMessageHistory();
        // Convert to client format
        const processMessages = sdkMessagesToClientMessages(sdkMessages);
        // Extract context usage from raw SDK messages (has usage field)
        // Use process.contextWindow (captured from result messages) as primary source
        const mis = deps.modelInfoService;
        const sdkContextWindow = process.contextWindow;
        const contextUsage = extractContextUsageFromSDKMessages(
          sdkMessages,
          process.resolvedModel,
          process.provider,
          sdkContextWindow
            ? () => sdkContextWindow
            : mis
              ? (m, p) => mis.getContextWindow(m, p)
              : undefined,
        );
        // Cache SDK-reported context window for future JSONL reads
        if (mis && sdkContextWindow && process.resolvedModel) {
          mis.recordContextWindow(
            process.resolvedModel,
            sdkContextWindow,
            process.provider,
          );
        }
        // Get metadata even for new sessions (in case it was set before file was written)
        const metadata = deps.sessionMetadataService?.getMetadata(sessionId);
        // Get notification data for new sessions too
        const lastSeenEntry = deps.notificationService?.getLastSeen(sessionId);
        const newSessionUpdatedAt = new Date().toISOString();
        const hasUnread = deps.notificationService
          ? deps.notificationService.hasUnread(sessionId, newSessionUpdatedAt)
          : undefined;
        return c.json({
          session: {
            id: sessionId,
            projectId,
            title: null,
            createdAt: new Date().toISOString(),
            updatedAt: newSessionUpdatedAt,
            messageCount: processMessages.length,
            ownership,
            messages: processMessages,
            customTitle: metadata?.customTitle,
            isArchived: metadata?.isArchived,
            isStarred: metadata?.isStarred,
            lastSeenAt: lastSeenEntry?.timestamp,
            hasUnread,
            provider: process.provider,
            model: process.resolvedModel,
            contextUsage,
          },
          messages: processMessages,
          ownership,
          pendingInputRequest,
          slashCommands,
        });
      }
      return c.json({ error: "Session not found" }, 404);
    }

    // Get session metadata (custom title, archived, starred)
    const metadata = deps.sessionMetadataService?.getMetadata(sessionId);

    // Get notification data (lastSeenAt, hasUnread)
    const lastSeenEntry = deps.notificationService?.getLastSeen(sessionId);
    const lastSeenAt = lastSeenEntry?.timestamp;
    const hasUnread = deps.notificationService
      ? deps.notificationService.hasUnread(sessionId, session.updatedAt)
      : undefined;

    // Apply compact-boundary pagination if requested (BEFORE expensive augmentation)
    // tailCompactions slices to last N compact boundaries; skip when afterMessageId is
    // present since that's a different use case (incremental forward-fetch)
    let paginationInfo: PaginationInfo | undefined;
    if (
      tailCompactions !== undefined &&
      !Number.isNaN(tailCompactions) &&
      tailCompactions > 0 &&
      !afterMessageId
    ) {
      const sliced = sliceAtCompactBoundaries(
        session.messages,
        tailCompactions,
        beforeMessageId,
      );
      session = { ...session, messages: sliced.messages };
      paginationInfo = sliced.pagination;
    }

    // Keep persisted rendering in lockstep with stream augmentation behavior.
    await augmentPersistedSessionMessages(session.messages);

    // Override context usage with SDK-reported context window from live process
    // The reader uses hardcoded defaults; the process captures the real value at runtime
    let { contextUsage } = session;
    if (process?.contextWindow && contextUsage) {
      const cw = process.contextWindow;
      contextUsage = {
        ...contextUsage,
        percentage: Math.round((contextUsage.inputTokens / cw) * 100),
        contextWindow: cw,
      };
      // Cache for future reads without a live process
      deps.modelInfoService?.recordContextWindow(
        process.resolvedModel ?? session.model ?? "",
        cw,
        process.provider,
      );
    }

    return c.json({
      session: {
        ...session,
        ownership,
        contextUsage,
        customTitle: metadata?.customTitle,
        isArchived: metadata?.isArchived,
        isStarred: metadata?.isStarred,
        // Model comes from the session reader (extracted from JSONL)
        model: session.model,
        lastSeenAt,
        hasUnread,
      },
      messages: session.messages,
      ownership,
      pendingInputRequest,
      slashCommands,
      ...(paginationInfo && { pagination: paginationInfo }),
    });
  });

  // POST /api/projects/:projectId/sessions - Start new session
  routes.post("/projects/:projectId/sessions", async (c) => {
    const projectId = c.req.param("projectId");

    // Validate projectId format at API boundary
    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }

    // Use getOrCreateProject to allow starting sessions in new directories
    const project = await deps.scanner.getOrCreateProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found or path does not exist" }, 404);
    }

    let body: StartSessionBody;
    try {
      body = await c.req.json<StartSessionBody>();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (!body.message) {
      return c.json({ error: "Message is required" }, 400);
    }
    const { executor, error: executorError } = parseOptionalExecutor(
      body.executor,
    );
    if (executorError) {
      return c.json({ error: executorError }, 400);
    }

    const userMessage: UserMessage = {
      text: body.message,
      images: body.images,
      documents: body.documents,
      attachments: body.attachments,
      mode: body.mode,
      tempId: body.tempId,
    };

    // Convert thinking option to SDK config
    const { thinking, effort } = body.thinking
      ? thinkingOptionToConfig(body.thinking)
      : { thinking: undefined, effort: undefined };

    // Convert model option (undefined or "default" means use CLI default)
    const model =
      body.model && body.model !== "default" ? body.model : undefined;

    // Debug: log what we received
    console.log("[startSession] Request body:", {
      provider: body.provider,
      executor,
      model: body.model,
    });

    const globalInstructions =
      deps.serverSettingsService?.getSetting("globalInstructions") || undefined;

    // Handle worktree creation if requested
    const { sessionPath, worktreeInfo } = await tryCreateWorktree(
      project.path,
      body.worktree,
      executor,
      deps.serverSettingsService,
    );

    let result: Awaited<ReturnType<typeof deps.supervisor.startSession>>;
    try {
      result = await deps.supervisor.startSession(
        sessionPath,
        userMessage,
        body.mode,
        {
          model,
          thinking,
          effort,
          providerName: body.provider,
          executor,
          globalInstructions,
          permissions: body.permissions,
        },
      );
    } catch (error) {
      // Clean up worktree on any startup failure
      if (worktreeInfo) {
        cleanupWorktree(worktreeInfo, { force: true }).catch(() => {});
      }
      throw error;
    }

    // Check if queue is full
    if (isQueueFullResponse(result)) {
      if (worktreeInfo) {
        cleanupWorktree(worktreeInfo, { force: true }).catch(() => {});
      }
      return c.json(
        { error: "Queue is full", maxQueueSize: result.maxQueueSize },
        503,
      );
    }

    // Check if request was queued
    if (isQueuedResponse(result)) {
      return c.json(result, 202); // 202 Accepted - queued for processing
    }

    // Save provider, executor, and worktree info to session metadata
    if (deps.sessionMetadataService) {
      if (body.provider) {
        await deps.sessionMetadataService.setProvider(
          result.sessionId,
          body.provider,
        );
      }
      if (executor) {
        await deps.sessionMetadataService.setExecutor(
          result.sessionId,
          executor,
        );
      }
      if (worktreeInfo) {
        await deps.sessionMetadataService.setWorktree(result.sessionId, {
          worktreePath: worktreeInfo.worktreePath,
          branchName: worktreeInfo.branchName,
          originalPath: worktreeInfo.originalPath,
          originalHeadCommit: worktreeInfo.originalHeadCommit,
        });
      }
    }

    return c.json({
      sessionId: result.sessionId,
      processId: result.id,
      permissionMode: result.permissionMode,
      modeVersion: result.modeVersion,
    });
  });

  // POST /api/projects/:projectId/sessions/create - Create session without starting agent
  // Used for two-phase flow: create session first, upload files, then send first message
  routes.post("/projects/:projectId/sessions/create", async (c) => {
    const projectId = c.req.param("projectId");

    // Validate projectId format at API boundary
    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }

    // Use getOrCreateProject to allow starting sessions in new directories
    const project = await deps.scanner.getOrCreateProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found or path does not exist" }, 404);
    }

    let body: CreateSessionBody = {};
    try {
      body = await c.req.json<CreateSessionBody>();
    } catch {
      // Body is optional for this endpoint
    }

    const { executor, error: executorError } = parseOptionalExecutor(
      body.executor,
    );
    if (executorError) {
      return c.json({ error: executorError }, 400);
    }

    // Convert thinking option to SDK config
    const { thinking, effort } = body.thinking
      ? thinkingOptionToConfig(body.thinking)
      : { thinking: undefined, effort: undefined };

    // Convert model option (undefined or "default" means use CLI default)
    const model =
      body.model && body.model !== "default" ? body.model : undefined;

    const globalInstructions =
      deps.serverSettingsService?.getSetting("globalInstructions") || undefined;

    // Handle worktree creation if requested
    const { sessionPath, worktreeInfo } = await tryCreateWorktree(
      project.path,
      body.worktree,
      executor,
      deps.serverSettingsService,
    );

    let result: Awaited<ReturnType<typeof deps.supervisor.createSession>>;
    try {
      result = await deps.supervisor.createSession(
        sessionPath,
        body.mode,
        {
          model,
          thinking,
          effort,
          providerName: body.provider,
          executor,
          globalInstructions,
          permissions: body.permissions,
        },
      );
    } catch (error) {
      if (worktreeInfo) {
        cleanupWorktree(worktreeInfo, { force: true }).catch(() => {});
      }
      throw error;
    }

    // Check if queue is full
    if (isQueueFullResponse(result)) {
      if (worktreeInfo) {
        cleanupWorktree(worktreeInfo, { force: true }).catch(() => {});
      }
      return c.json(
        { error: "Queue is full", maxQueueSize: result.maxQueueSize },
        503,
      );
    }

    // Check if request was queued
    if (isQueuedResponse(result)) {
      return c.json(result, 202); // 202 Accepted - queued for processing
    }

    // Save provider, executor, and worktree info to session metadata
    if (deps.sessionMetadataService) {
      if (body.provider) {
        await deps.sessionMetadataService.setProvider(
          result.sessionId,
          body.provider,
        );
      }
      if (executor) {
        await deps.sessionMetadataService.setExecutor(
          result.sessionId,
          executor,
        );
      }
      if (worktreeInfo) {
        await deps.sessionMetadataService.setWorktree(result.sessionId, {
          worktreePath: worktreeInfo.worktreePath,
          branchName: worktreeInfo.branchName,
          originalPath: worktreeInfo.originalPath,
          originalHeadCommit: worktreeInfo.originalHeadCommit,
        });
      }
    }

    return c.json({
      sessionId: result.sessionId,
      processId: result.id,
      permissionMode: result.permissionMode,
      modeVersion: result.modeVersion,
    });
  });

  // POST /api/projects/:projectId/sessions/:sessionId/resume - Resume session
  routes.post("/projects/:projectId/sessions/:sessionId/resume", async (c) => {
    const projectId = c.req.param("projectId");
    const sessionId = c.req.param("sessionId");

    // Validate projectId format at API boundary
    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }

    // Use getOrCreateProject to allow resuming in directories that may have been moved
    const project = await deps.scanner.getOrCreateProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found or path does not exist" }, 404);
    }

    let body: StartSessionBody;
    try {
      body = await c.req.json<StartSessionBody>();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (!body.message) {
      return c.json({ error: "Message is required" }, 400);
    }
    const parsedBodyExecutor = parseOptionalExecutor(body.executor);
    if (parsedBodyExecutor.error) {
      return c.json({ error: parsedBodyExecutor.error }, 400);
    }

    const userMessage: UserMessage = {
      text: body.message,
      images: body.images,
      documents: body.documents,
      attachments: body.attachments,
      mode: body.mode,
      tempId: body.tempId,
    };

    // Convert thinking option to SDK config
    const { thinking, effort } = body.thinking
      ? thinkingOptionToConfig(body.thinking)
      : { thinking: undefined, effort: undefined };

    // Convert model option (undefined or "default" means use CLI default)
    const model =
      body.model && body.model !== "default" ? body.model : undefined;

    // Use client-provided executor, falling back to saved executor from metadata.
    let executor = parsedBodyExecutor.executor;
    if (!executor) {
      const parsedSavedExecutor = parseOptionalExecutor(
        deps.sessionMetadataService?.getExecutor(sessionId),
      );
      if (parsedSavedExecutor.error) {
        return c.json({ error: parsedSavedExecutor.error }, 400);
      }
      executor = parsedSavedExecutor.executor;
    }

    // For remote sessions, sync local files TO remote before resuming
    // This ensures the remote has the latest session state
    if (executor) {
      const projectDir = getProjectDirFromCwd(project.path);
      const syncResult = await syncSessions({
        host: executor,
        projectDir,
        direction: "to-remote",
      });
      if (!syncResult.success) {
        console.warn(
          `[resume] Failed to pre-sync session to ${executor}: ${syncResult.error}`,
        );
        // Continue anyway - remote may have the files from before
      }

      // Save executor to metadata if not already saved (e.g. client provided it)
      if (deps.sessionMetadataService) {
        await deps.sessionMetadataService.setExecutor(sessionId, executor);
      }
    }

    const globalInstructions =
      deps.serverSettingsService?.getSetting("globalInstructions") || undefined;

    // Look up the session's original provider so we resume with the correct one
    // (e.g., claude-ollama sessions need the Ollama provider, not default Claude).
    // Check metadata first (explicitly saved on creation), then fall back to reader.
    let providerName = body.provider;
    if (!providerName) {
      providerName = deps.sessionMetadataService?.getProvider(sessionId) as
        | ProviderName
        | undefined;
    }
    if (!providerName) {
      const sessionSummaryResult = await findSessionSummaryAcrossProviders(
        project,
        sessionId,
        projectId as UrlProjectId,
        {
          readerFactory: deps.readerFactory,
          codexSessionsDir: deps.codexSessionsDir,
          codexReaderFactory: deps.codexReaderFactory,
          geminiSessionsDir: deps.geminiSessionsDir,
          geminiReaderFactory: deps.geminiReaderFactory,
          geminiHashToCwd: deps.geminiScanner?.getHashToCwd(),
        },
        deps.sessionMetadataService?.getProvider(sessionId) as
          | ProviderName
          | undefined,
      );
      const sessionSummary = sessionSummaryResult?.summary ?? null;
      providerName = sessionSummary?.provider ?? project.provider;
    }

    // Use saved worktree path if session was created with worktree isolation
    const savedWorktree = deps.sessionMetadataService?.getWorktree(sessionId);
    const resumePath = savedWorktree?.worktreePath ?? project.path;

    const result = await deps.supervisor.resumeSession(
      sessionId,
      resumePath,
      userMessage,
      body.mode,
      {
        model,
        thinking,
        effort,
        providerName,
        executor,
        globalInstructions,
        permissions: body.permissions,
      },
    );

    // Check if queue is full
    if (isQueueFullResponse(result)) {
      return c.json(
        { error: "Queue is full", maxQueueSize: result.maxQueueSize },
        503,
      );
    }

    // Check if request was queued
    if (isQueuedResponse(result)) {
      return c.json(result, 202); // 202 Accepted - queued for processing
    }

    return c.json({
      processId: result.id,
      permissionMode: result.permissionMode,
      modeVersion: result.modeVersion,
    });
  });

  // POST /api/sessions/:sessionId/messages - Queue message
  routes.post("/sessions/:sessionId/messages", async (c) => {
    const sessionId = c.req.param("sessionId");

    const process = deps.supervisor.getProcessForSession(sessionId);
    if (!process) {
      return c.json({ error: "No active process for session" }, 404);
    }

    let body: StartSessionBody & { deferred?: boolean };
    try {
      body = await c.req.json<StartSessionBody & { deferred?: boolean }>();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (!body.message) {
      return c.json({ error: "Message is required" }, 400);
    }

    const userMessage: UserMessage = {
      text: body.message,
      images: body.images,
      documents: body.documents,
      attachments: body.attachments,
      mode: body.mode,
      tempId: body.tempId,
    };

    // Check if process is terminated
    if (process.isTerminated) {
      return c.json(
        {
          error: "Process terminated",
          reason: process.terminationReason,
        },
        410,
      ); // 410 Gone
    }

    // Deferred messages are held server-side and auto-sent when the agent finishes
    if (body.deferred) {
      process.deferMessage(userMessage);
      return c.json({ queued: true, deferred: true });
    }

    // Convert thinking option to SDK config
    const { thinking, effort } = body.thinking
      ? thinkingOptionToConfig(body.thinking)
      : { thinking: undefined, effort: undefined };

    // Use queueMessageToSession which handles thinking mode changes
    // If thinking mode changed, it will restart the process automatically
    const queueGlobalInstructions =
      deps.serverSettingsService?.getSetting("globalInstructions") || undefined;
    const result = await deps.supervisor.queueMessageToSession(
      sessionId,
      process.projectPath,
      userMessage,
      body.mode,
      { thinking, effort, globalInstructions: queueGlobalInstructions },
    );

    if (!result.success) {
      return c.json(
        {
          error: "Failed to queue message",
          reason: result.error,
        },
        410,
      ); // 410 Gone - process is no longer available
    }

    return c.json({
      queued: true,
      restarted: result.restarted,
      processId: result.process.id,
    });
  });

  // DELETE /api/sessions/:sessionId/deferred/:tempId - Cancel a deferred message
  routes.delete("/sessions/:sessionId/deferred/:tempId", (c) => {
    const sessionId = c.req.param("sessionId");
    const tempId = c.req.param("tempId");

    const process = deps.supervisor.getProcessForSession(sessionId);
    if (!process) {
      return c.json({ error: "No active process for session" }, 404);
    }

    const cancelled = process.cancelDeferredMessage(tempId);
    if (!cancelled) {
      return c.json({ error: "Deferred message not found" }, 404);
    }

    return c.json({ cancelled: true });
  });

  // PUT /api/sessions/:sessionId/mode - Update permission mode without sending a message
  routes.put("/sessions/:sessionId/mode", async (c) => {
    const sessionId = c.req.param("sessionId");
    const body = await c.req.json<{ mode: PermissionMode }>();

    if (!body.mode) {
      return c.json({ error: "mode is required" }, 400);
    }

    const process = deps.supervisor.getProcessForSession(sessionId);
    if (!process) {
      return c.json({ error: "No active process for session" }, 404);
    }

    process.setPermissionMode(body.mode);

    return c.json({
      permissionMode: process.permissionMode,
      modeVersion: process.modeVersion,
    });
  });

  // PUT /api/sessions/:sessionId/hold - Set hold (soft pause) mode
  routes.put("/sessions/:sessionId/hold", async (c) => {
    const sessionId = c.req.param("sessionId");
    const body = await c.req.json<{ hold: boolean }>();

    if (typeof body.hold !== "boolean") {
      return c.json({ error: "hold is required (boolean)" }, 400);
    }

    const process = deps.supervisor.getProcessForSession(sessionId);
    if (!process) {
      return c.json({ error: "No active process for session" }, 404);
    }

    process.setHold(body.hold);

    return c.json({
      isHeld: process.isHeld,
      holdSince: process.holdSince?.toISOString() ?? null,
      state: process.state.type,
    });
  });

  // GET /api/sessions/:sessionId/pending-input - Get pending input request
  routes.get("/sessions/:sessionId/pending-input", async (c) => {
    const sessionId = c.req.param("sessionId");

    const process = deps.supervisor.getProcessForSession(sessionId);
    if (!process) {
      return c.json({ request: null });
    }

    // Use getPendingInputRequest which works for both mock and real SDK
    const request = process.getPendingInputRequest();
    return c.json({ request });
  });

  // GET /api/sessions/:sessionId/process - Get process info for a session
  routes.get("/sessions/:sessionId/process", async (c) => {
    const sessionId = c.req.param("sessionId");

    const process = deps.supervisor.getProcessForSession(sessionId);
    if (!process) {
      return c.json({ process: null });
    }

    return c.json({ process: process.getInfo() });
  });

  // POST /api/sessions/:sessionId/input - Respond to input request
  routes.post("/sessions/:sessionId/input", async (c) => {
    const sessionId = c.req.param("sessionId");

    const process = deps.supervisor.getProcessForSession(sessionId);
    if (!process) {
      return c.json({ error: "No active process for session" }, 404);
    }

    if (process.state.type !== "waiting-input") {
      return c.json({ error: "No pending input request" }, 400);
    }

    let body: InputResponseBody;
    try {
      body = await c.req.json<InputResponseBody>();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (!body.requestId || !body.response) {
      return c.json({ error: "requestId and response are required" }, 400);
    }

    // Handle approve_accept_edits: approve and switch permission mode
    const isApproveAcceptEdits = body.response === "approve_accept_edits";

    // Normalize response to approve/deny
    const normalizedResponse =
      body.response === "approve" ||
      body.response === "allow" ||
      body.response === "approve_accept_edits"
        ? "approve"
        : "deny";

    // Call respondToInput which resolves the SDK's canUseTool promise
    const accepted = process.respondToInput(
      body.requestId,
      normalizedResponse,
      body.answers,
      body.feedback,
    );

    if (!accepted) {
      return c.json({ error: "Invalid request ID or no pending request" }, 400);
    }

    // If approve_accept_edits, switch the permission mode
    if (isApproveAcceptEdits) {
      process.setPermissionMode("acceptEdits");
    }

    return c.json({ accepted: true });
  });

  // POST /api/sessions/:sessionId/mark-seen - Mark session as seen (read)
  routes.post("/sessions/:sessionId/mark-seen", async (c) => {
    const sessionId = c.req.param("sessionId");

    if (!deps.notificationService) {
      return c.json({ error: "Notification service not available" }, 503);
    }

    let body: { timestamp?: string; messageId?: string } = {};
    try {
      body = await c.req.json();
    } catch {
      // Body is optional
    }

    await deps.notificationService.markSeen(
      sessionId,
      body.timestamp,
      body.messageId,
    );

    return c.json({ marked: true });
  });

  // DELETE /api/sessions/:sessionId/mark-seen - Mark session as unread
  routes.delete("/sessions/:sessionId/mark-seen", async (c) => {
    const sessionId = c.req.param("sessionId");

    if (!deps.notificationService) {
      return c.json({ error: "Notification service not available" }, 503);
    }

    await deps.notificationService.clearSession(sessionId);

    // Emit event so other tabs/clients can update
    if (deps.eventBus) {
      deps.eventBus.emit({
        type: "session-seen",
        sessionId,
        timestamp: "", // Empty timestamp signals "unread"
      });
    }

    return c.json({ marked: false });
  });

  // GET /api/notifications/last-seen - Get all last seen entries
  routes.get("/notifications/last-seen", async (c) => {
    if (!deps.notificationService) {
      return c.json({ error: "Notification service not available" }, 503);
    }

    return c.json({ lastSeen: deps.notificationService.getAllLastSeen() });
  });

  // GET /api/debug/metadata - Debug endpoint to inspect metadata service state
  routes.get("/debug/metadata", (c) => {
    if (!deps.sessionMetadataService) {
      return c.json(
        { error: "Session metadata service not available", available: false },
        503,
      );
    }

    const allMetadata = deps.sessionMetadataService.getAllMetadata();
    const sessionCount = Object.keys(allMetadata).length;
    const starredCount = Object.values(allMetadata).filter(
      (m) => m.isStarred,
    ).length;
    const archivedCount = Object.values(allMetadata).filter(
      (m) => m.isArchived,
    ).length;
    const filePath = deps.sessionMetadataService.getFilePath();

    return c.json({
      available: true,
      filePath,
      sessionCount,
      starredCount,
      archivedCount,
    });
  });

  // PUT /api/sessions/:sessionId/metadata - Update session metadata (title, archived, starred)
  routes.put("/sessions/:sessionId/metadata", async (c) => {
    const sessionId = c.req.param("sessionId");

    if (!deps.sessionMetadataService) {
      return c.json({ error: "Session metadata service not available" }, 503);
    }

    let body: { title?: string; archived?: boolean; starred?: boolean } = {};
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    // At least one field must be provided
    if (
      body.title === undefined &&
      body.archived === undefined &&
      body.starred === undefined
    ) {
      return c.json(
        { error: "At least title, archived, or starred must be provided" },
        400,
      );
    }

    await deps.sessionMetadataService.updateMetadata(sessionId, {
      title: body.title,
      archived: body.archived,
      starred: body.starred,
    });

    // Emit SSE event so sidebar and other clients can update
    if (deps.eventBus) {
      deps.eventBus.emit({
        type: "session-metadata-changed",
        sessionId,
        title: body.title,
        archived: body.archived,
        starred: body.starred,
        timestamp: new Date().toISOString(),
      });
    }

    return c.json({ updated: true });
  });

  // POST /api/projects/:projectId/sessions/:sessionId/clone - Clone a session
  routes.post("/projects/:projectId/sessions/:sessionId/clone", async (c) => {
    const projectId = c.req.param("projectId");
    const sessionId = c.req.param("sessionId");

    // Validate projectId format at API boundary
    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }

    const project = await deps.scanner.getOrCreateProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    // Check provider supports cloning
    const supportedProviders = ["claude", "codex", "codex-oss"];
    if (!supportedProviders.includes(project.provider)) {
      return c.json(
        { error: `Clone is not supported for ${project.provider} sessions` },
        400,
      );
    }

    let body: { title?: string; provider?: ProviderName } = {};
    try {
      body = await c.req.json();
    } catch {
      // Body is optional
    }

    try {
      // Get session directory from project
      const sessionDir = project.sessionDir;
      if (!sessionDir) {
        return c.json({ error: "Session directory not found" }, 500);
      }

      // Get original session to extract title for the clone
      const reader = deps.readerFactory(project);
      let originalSession = await reader.getSessionSummary(
        sessionId,
        projectId,
      );
      let cloneProvider: ProviderName = project.provider;

      let result: { newSessionId: string; entries: number };

      const shouldCloneFromCodex =
        isCodexProviderName(body.provider) ||
        isCodexProviderName(project.provider) ||
        (!originalSession && project.provider === "claude");

      if (shouldCloneFromCodex) {
        const codexReader = getCodexReader(project.path);
        if (!codexReader) {
          return c.json({ error: "Codex session reader not available" }, 500);
        }
        const filePath = await codexReader.getSessionFilePath(sessionId);
        if (!filePath) {
          return c.json({ error: "Session file not found" }, 404);
        }

        originalSession =
          originalSession ??
          (await codexReader.getSessionSummary(sessionId, projectId)) ??
          null;
        cloneProvider =
          originalSession?.provider ??
          body.provider ??
          (isCodexProviderName(project.provider) ? project.provider : "codex");
        result = await cloneCodexSession(filePath);
        codexReader.invalidateCache();
        deps.codexScanner?.invalidateCache();
      } else {
        result = await cloneClaudeSession(sessionDir, sessionId);
      }

      // Build clone title: use provided title, or derive from original
      let cloneTitle = body.title;
      if (!cloneTitle && deps.sessionMetadataService) {
        // Check for custom title first, then fall back to auto-generated title
        const originalMetadata =
          deps.sessionMetadataService.getMetadata(sessionId);
        const originalTitle =
          originalMetadata?.customTitle ?? originalSession?.title;
        if (originalTitle) {
          cloneTitle = `${originalTitle} [cloned]`;
        }
      }

      // Set the clone title
      if (cloneTitle && deps.sessionMetadataService) {
        await deps.sessionMetadataService.updateMetadata(result.newSessionId, {
          title: cloneTitle,
        });
      }

      return c.json({
        sessionId: result.newSessionId,
        messageCount: result.entries,
        clonedFrom: sessionId,
        provider: cloneProvider,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to clone session";
      return c.json({ error: message }, 500);
    }
  });

  // ============ Worker Queue Endpoints ============

  // GET /api/status/workers - Get worker activity for safe restart indicator
  routes.get("/status/workers", (c) => {
    const activity = deps.supervisor.getWorkerActivity();
    return c.json(activity);
  });

  // GET /api/queue - Get all queued requests
  routes.get("/queue", (c) => {
    const queue = deps.supervisor.getQueueInfo();
    const poolStatus = deps.supervisor.getWorkerPoolStatus();
    return c.json({ queue, ...poolStatus });
  });

  // GET /api/queue/:queueId - Get specific queue entry position
  routes.get("/queue/:queueId", (c) => {
    const queueId = c.req.param("queueId");
    const position = deps.supervisor.getQueuePosition(queueId);

    if (position === undefined) {
      return c.json({ error: "Queue entry not found" }, 404);
    }

    return c.json({ queueId, position });
  });

  // DELETE /api/queue/:queueId - Cancel a queued request
  routes.delete("/queue/:queueId", (c) => {
    const queueId = c.req.param("queueId");

    const cancelled = deps.supervisor.cancelQueuedRequest(queueId);
    if (!cancelled) {
      return c.json(
        { error: "Queue entry not found or already processed" },
        404,
      );
    }

    return c.json({ cancelled: true });
  });

  return routes;
}
