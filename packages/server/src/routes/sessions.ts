import {
  type ContextUsage,
  type ModelOption,
  type ProviderName,
  type ThinkingOption,
  type UploadedFile,
  getModelContextWindow,
  isUrlProjectId,
  thinkingOptionToTokens,
} from "@yep-anywhere/shared";
import { Hono } from "hono";
import {
  type EditInputWithAugment,
  type ExitPlanModeInput,
  type ExitPlanModeResult,
  type ReadResultWithAugment,
  type WriteInputWithAugment,
  computeEditAugment,
  computeReadAugment,
  computeWriteAugment,
} from "../augments/index.js";
import {
  augmentTextBlocks,
  renderMarkdownToHtml,
} from "../augments/markdown-augments.js";
import type { SessionMetadataService } from "../metadata/index.js";
import type { NotificationService } from "../notifications/index.js";
import type { CodexSessionScanner } from "../projects/codex-scanner.js";
import type { GeminiSessionScanner } from "../projects/gemini-scanner.js";
import type { ProjectScanner } from "../projects/scanner.js";
import { getProjectDirFromCwd, syncSessions } from "../sdk/session-sync.js";
import type { PermissionMode, SDKMessage, UserMessage } from "../sdk/types.js";
import { CodexSessionReader } from "../sessions/codex-reader.js";
import { cloneClaudeSession } from "../sessions/fork.js";
import { GeminiSessionReader } from "../sessions/gemini-reader.js";
import { normalizeSession } from "../sessions/normalization.js";
import type { ISessionReader } from "../sessions/types.js";
import type { ExternalSessionTracker } from "../supervisor/ExternalSessionTracker.js";
import type { Process } from "../supervisor/Process.js";
import type {
  QueueFullResponse,
  Supervisor,
} from "../supervisor/Supervisor.js";
import type { QueuedResponse } from "../supervisor/WorkerQueue.js";
import type { ContentBlock, Message, Project } from "../supervisor/types.js";
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
  geminiScanner?: GeminiSessionScanner;
  geminiSessionsDir?: string;
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
}

interface CreateSessionBody {
  mode?: PermissionMode;
  model?: ModelOption;
  thinking?: ThinkingOption;
  provider?: ProviderName;
  /** SSH host alias for remote execution (undefined = local) */
  executor?: string;
}

interface InputResponseBody {
  requestId: string;
  response: "approve" | "approve_accept_edits" | "deny" | string;
  answers?: Record<string, string>;
  feedback?: string;
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
        timestamp: new Date().toISOString(),
      });
    }
  }
  return messages;
}

/**
 * Extract context usage from SDK messages.
 * Finds the last assistant message with usage data.
 *
 * @param sdkMessages - SDK messages to search
 * @param model - Model ID for determining context window size
 */
function extractContextUsageFromSDKMessages(
  sdkMessages: SDKMessage[],
  model: string | undefined,
): ContextUsage | undefined {
  const contextWindowSize = getModelContextWindow(model);

  // Find the last assistant message with usage data (iterate backwards)
  for (let i = sdkMessages.length - 1; i >= 0; i--) {
    const msg = sdkMessages[i];
    if (msg && msg.type === "assistant" && msg.usage) {
      const usage = msg.usage as {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      };

      // Total input = fresh tokens + cached tokens + new cache creation
      const inputTokens =
        (usage.input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0);

      // Skip messages with zero input tokens (incomplete streaming messages)
      if (inputTokens === 0) {
        continue;
      }

      const percentage = Math.round((inputTokens / contextWindowSize) * 100);

      const result: ContextUsage = { inputTokens, percentage };

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
  return undefined;
}

/**
 * Embed Edit augment data directly into tool_use inputs.
 * Adds _structuredPatch and _diffHtml to Edit tool_use input blocks.
 */
async function augmentEditInputs(messages: Message[]): Promise<void> {
  const promises: Promise<void>[] = [];

  for (const msg of messages) {
    // Only assistant messages have tool_use blocks
    if (msg.type !== "assistant") continue;

    // Content is in msg.message.content (nested structure from SDK)
    const content = msg.message?.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (
        block.type === "tool_use" &&
        block.name === "Edit" &&
        block.id &&
        block.input
      ) {
        const input = block.input as EditInputWithAugment;
        // Validate required fields and hasn't been augmented yet
        if (
          input.file_path &&
          typeof input.old_string === "string" &&
          typeof input.new_string === "string" &&
          !input._structuredPatch
        ) {
          const toolUseId = block.id;
          promises.push(
            computeEditAugment(toolUseId, {
              file_path: input.file_path,
              old_string: input.old_string,
              new_string: input.new_string,
            })
              .then((augment) => {
                input._structuredPatch = augment.structuredPatch;
                input._diffHtml = augment.diffHtml;
              })
              .catch(() => {
                // Ignore augment computation errors
              }),
          );
        }
      }
    }
  }

  await Promise.all(promises);
}

// Types imported from augments/types.ts:
// - EditInputWithAugment
// - ExitPlanModeInput
// - ExitPlanModeResult
// - ReadResultWithAugment
// - WriteInputWithAugment

/**
 * Embed Write augment data directly into tool_use inputs.
 * Adds _highlightedContentHtml to Write tool_use input blocks.
 */
async function augmentWriteInputs(messages: Message[]): Promise<void> {
  const promises: Promise<void>[] = [];

  for (const msg of messages) {
    // Only assistant messages have tool_use blocks
    if (msg.type !== "assistant") continue;

    // Content is in msg.message.content (nested structure from SDK)
    const content = msg.message?.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (block.type === "tool_use" && block.name === "Write" && block.input) {
        const input = block.input as WriteInputWithAugment;
        // Validate required fields and hasn't been augmented yet
        if (
          typeof input.file_path === "string" &&
          typeof input.content === "string" &&
          !input._highlightedContentHtml
        ) {
          promises.push(
            computeWriteAugment({
              file_path: input.file_path,
              content: input.content,
            })
              .then((augment) => {
                if (augment) {
                  input._highlightedContentHtml = augment.highlightedHtml;
                  input._highlightedLanguage = augment.language;
                  input._highlightedTruncated = augment.truncated;
                  if (augment.renderedMarkdownHtml) {
                    input._renderedMarkdownHtml = augment.renderedMarkdownHtml;
                  }
                }
              })
              .catch(() => {
                // Ignore augment computation errors
              }),
          );
        }
      }
    }
  }

  await Promise.all(promises);
}

/**
 * Render ExitPlanMode plan HTML directly into messages.
 * Adds _renderedHtml to tool_use input and tool_result structured data.
 */
async function augmentExitPlanModeMessages(messages: Message[]): Promise<void> {
  const promises: Promise<void>[] = [];

  for (const msg of messages) {
    // Check assistant messages for ExitPlanMode tool_use
    if (msg.type === "assistant") {
      const content = msg.message?.content;
      if (!Array.isArray(content)) continue;

      for (const block of content) {
        if (
          block.type === "tool_use" &&
          block.name === "ExitPlanMode" &&
          block.input
        ) {
          const input = block.input as ExitPlanModeInput;
          if (input.plan && !input._renderedHtml) {
            promises.push(
              renderMarkdownToHtml(input.plan)
                .then((html) => {
                  input._renderedHtml = html;
                })
                .catch(() => {
                  // Ignore render errors
                }),
            );
          }
        }
      }
    }

    // Check user messages for ExitPlanMode tool_result
    if (msg.type === "user") {
      const toolUseResult = (msg as Record<string, unknown>).toolUseResult as
        | ExitPlanModeResult
        | undefined;
      const toolUseResultSnake = (msg as Record<string, unknown>)
        .tool_use_result as ExitPlanModeResult | undefined;
      const result = toolUseResult ?? toolUseResultSnake;

      if (result?.plan && !result._renderedHtml) {
        promises.push(
          renderMarkdownToHtml(result.plan)
            .then((html) => {
              result._renderedHtml = html;
            })
            .catch(() => {
              // Ignore render errors
            }),
        );
      }

      // Check for Read tool_result and augment with syntax highlighting
      const readResult = (toolUseResult ?? toolUseResultSnake) as
        | ReadResultWithAugment
        | undefined;
      if (
        readResult?.type === "text" &&
        readResult.file?.filePath &&
        readResult.file?.content &&
        !readResult._highlightedContentHtml
      ) {
        promises.push(
          computeReadAugment({
            file_path: readResult.file.filePath,
            content: readResult.file.content,
          })
            .then((augment) => {
              if (augment) {
                readResult._highlightedContentHtml = augment.highlightedHtml;
                readResult._highlightedLanguage = augment.language;
                readResult._highlightedTruncated = augment.truncated;
                if (augment.renderedMarkdownHtml) {
                  readResult._renderedMarkdownHtml =
                    augment.renderedMarkdownHtml;
                }
              }
            })
            .catch(() => {
              // Ignore augment computation errors
            }),
        );
      }
    }
  }

  await Promise.all(promises);
}

export function createSessionsRoutes(deps: SessionsDeps): Hono {
  const routes = new Hono();

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

    // Determine the session status
    const status = process
      ? {
          state: "owned" as const,
          processId: process.id,
          permissionMode: process.permissionMode,
          modeVersion: process.modeVersion,
        }
      : isExternal
        ? { state: "external" as const }
        : { state: "idle" as const };

    // Get session metadata (custom title, archived, starred)
    const metadata = deps.sessionMetadataService?.getMetadata(sessionId);

    // Get notification data (lastSeenAt, hasUnread)
    const lastSeenEntry = deps.notificationService?.getLastSeen(sessionId);
    const lastSeenAt = lastSeenEntry?.timestamp;

    // Get pending input request from active process
    const pendingInputRequest =
      process?.state.type === "waiting-input" ? process.state.request : null;

    // Read minimal session info from disk (just for title/timestamps, no messages)
    const reader = deps.readerFactory(project);
    const sessionSummary = await reader.getSessionSummary(sessionId, projectId);

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
        model: sessionSummary?.model,
        customTitle: metadata?.customTitle,
        isArchived: metadata?.isArchived,
        isStarred: metadata?.isStarred,
        lastSeenAt,
        hasUnread,
      },
      status,
      pendingInputRequest,
    });
  });

  // GET /api/projects/:projectId/sessions/:sessionId - Get session detail
  // Optional query param: ?afterMessageId=<id> for incremental fetching
  routes.get("/projects/:projectId/sessions/:sessionId", async (c) => {
    const projectId = c.req.param("projectId");
    const sessionId = c.req.param("sessionId");
    const afterMessageId = c.req.query("afterMessageId");

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
      deps.codexScanner &&
      deps.codexSessionsDir
    ) {
      const codexSessions = await deps.codexScanner.getSessionsForProject(
        project.path,
      );
      if (codexSessions.length > 0) {
        const codexReader = new CodexSessionReader({
          sessionsDir: deps.codexSessionsDir,
          projectPath: project.path,
        });
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
      deps.geminiScanner &&
      deps.geminiSessionsDir
    ) {
      const geminiSessions = await deps.geminiScanner.getSessionsForProject(
        project.path,
      );
      if (geminiSessions.length > 0) {
        const geminiReader = new GeminiSessionReader({
          sessionsDir: deps.geminiSessionsDir,
          projectPath: project.path,
          hashToCwd: await deps.geminiScanner.getHashToCwd(),
        });
        loadedSession = await geminiReader.getSession(
          sessionId,
          project.id,
          afterMessageId,
          { includeOrphans: wasEverOwned && !process },
        );
      }
    }

    const session = loadedSession ? normalizeSession(loadedSession) : null;

    // Determine the session status
    const status = process
      ? {
          state: "owned" as const,
          processId: process.id,
          permissionMode: process.permissionMode,
          modeVersion: process.modeVersion,
        }
      : isExternal
        ? { state: "external" as const }
        : (session?.status ?? { state: "idle" as const });

    // Get pending input request from active process (for tool approval prompts)
    // This ensures clients get pending requests immediately without waiting for SSE
    const pendingInputRequest =
      process?.state.type === "waiting-input" ? process.state.request : null;

    if (!session) {
      // Session file doesn't exist yet - only valid if we own the process
      if (process) {
        // Get raw messages from process memory
        const sdkMessages = process.getMessageHistory();
        // Convert to client format
        const processMessages = sdkMessagesToClientMessages(sdkMessages);
        // Extract context usage from raw SDK messages (has usage field)
        const contextUsage = extractContextUsageFromSDKMessages(
          sdkMessages,
          process.model,
        );
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
            status,
            messages: processMessages,
            customTitle: metadata?.customTitle,
            isArchived: metadata?.isArchived,
            isStarred: metadata?.isStarred,
            lastSeenAt: lastSeenEntry?.timestamp,
            hasUnread,
            provider: process.provider,
            model: process.model,
            contextUsage,
          },
          messages: processMessages,
          status,
          pendingInputRequest,
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

    // Embed Edit augment data directly into tool_use inputs
    // This adds _structuredPatch and _diffHtml to the input
    await augmentEditInputs(session.messages);

    // Embed Write augment data directly into tool_use inputs
    // This adds _highlightedContentHtml to the input
    await augmentWriteInputs(session.messages);

    // Embed rendered HTML directly into text blocks
    // This adds _html to text content blocks
    await augmentTextBlocks(session.messages);

    // Render ExitPlanMode plan HTML directly into messages
    // This adds _renderedHtml to tool_use input and tool_result structured data
    await augmentExitPlanModeMessages(session.messages);

    return c.json({
      session: {
        ...session,
        status,
        customTitle: metadata?.customTitle,
        isArchived: metadata?.isArchived,
        isStarred: metadata?.isStarred,
        // Model comes from the session reader (extracted from JSONL)
        model: session.model,
        lastSeenAt,
        hasUnread,
      },
      messages: session.messages,
      status,
      pendingInputRequest,
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

    const userMessage: UserMessage = {
      text: body.message,
      images: body.images,
      documents: body.documents,
      attachments: body.attachments,
      mode: body.mode,
      tempId: body.tempId,
    };

    // Convert thinking option to token budget
    const maxThinkingTokens =
      body.thinking && body.thinking !== "off"
        ? thinkingOptionToTokens(body.thinking)
        : undefined;

    // Convert model option (undefined or "default" means use CLI default)
    const model =
      body.model && body.model !== "default" ? body.model : undefined;

    const result = await deps.supervisor.startSession(
      project.path,
      userMessage,
      body.mode,
      {
        model,
        maxThinkingTokens,
        providerName: body.provider,
        executor: body.executor,
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

    // Save executor to session metadata for resume
    if (body.executor && deps.sessionMetadataService) {
      await deps.sessionMetadataService.setExecutor(
        result.sessionId,
        body.executor,
      );
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

    // Convert thinking option to token budget
    const maxThinkingTokens =
      body.thinking && body.thinking !== "off"
        ? thinkingOptionToTokens(body.thinking)
        : undefined;

    // Convert model option (undefined or "default" means use CLI default)
    const model =
      body.model && body.model !== "default" ? body.model : undefined;

    const result = await deps.supervisor.createSession(
      project.path,
      body.mode,
      {
        model,
        maxThinkingTokens,
        providerName: body.provider,
        executor: body.executor,
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

    // Save executor to session metadata for resume
    if (body.executor && deps.sessionMetadataService) {
      await deps.sessionMetadataService.setExecutor(
        result.sessionId,
        body.executor,
      );
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

    const userMessage: UserMessage = {
      text: body.message,
      images: body.images,
      documents: body.documents,
      attachments: body.attachments,
      mode: body.mode,
      tempId: body.tempId,
    };

    // Convert thinking option to token budget
    const maxThinkingTokens =
      body.thinking && body.thinking !== "off"
        ? thinkingOptionToTokens(body.thinking)
        : undefined;

    // Convert model option (undefined or "default" means use CLI default)
    const model =
      body.model && body.model !== "default" ? body.model : undefined;

    // Look up saved executor for remote session resume
    const savedExecutor = deps.sessionMetadataService?.getExecutor(sessionId);

    // For remote sessions, sync local files TO remote before resuming
    // This ensures the remote has the latest session state
    if (savedExecutor) {
      const projectDir = getProjectDirFromCwd(project.path);
      const syncResult = await syncSessions({
        host: savedExecutor,
        projectDir,
        direction: "to-remote",
      });
      if (!syncResult.success) {
        console.warn(
          `[resume] Failed to pre-sync session to ${savedExecutor}: ${syncResult.error}`,
        );
        // Continue anyway - remote may have the files from before
      }
    }

    const result = await deps.supervisor.resumeSession(
      sessionId,
      project.path,
      userMessage,
      body.mode,
      {
        model,
        maxThinkingTokens,
        providerName: body.provider,
        executor: savedExecutor,
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

    let body: StartSessionBody;
    try {
      body = await c.req.json<StartSessionBody>();
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

    // Convert thinking option to token budget
    const maxThinkingTokens =
      body.thinking && body.thinking !== "off"
        ? thinkingOptionToTokens(body.thinking)
        : undefined;

    // Use queueMessageToSession which handles thinking mode changes
    // If thinking mode changed, it will restart the process automatically
    const result = await deps.supervisor.queueMessageToSession(
      sessionId,
      process.projectPath,
      userMessage,
      body.mode,
      { maxThinkingTokens },
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

    // Only Claude sessions can be cloned for now
    if (project.provider !== "claude") {
      return c.json(
        { error: "Clone is only supported for Claude sessions" },
        400,
      );
    }

    let body: { title?: string } = {};
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
      const originalSession = await reader.getSessionSummary(
        sessionId,
        projectId,
      );

      const result = await cloneClaudeSession(sessionDir, sessionId);

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
        provider: "claude",
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
