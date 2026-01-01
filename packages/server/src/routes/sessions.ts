import {
  type ModelOption,
  type ThinkingOption,
  type UploadedFile,
  isUrlProjectId,
  thinkingOptionToTokens,
} from "@claude-anywhere/shared";
import { Hono } from "hono";
import type { SessionMetadataService } from "../metadata/index.js";
import type { NotificationService } from "../notifications/index.js";
import type { ProjectScanner } from "../projects/scanner.js";
import type { PermissionMode, SDKMessage, UserMessage } from "../sdk/types.js";
import type { SessionReader } from "../sessions/reader.js";
import type { ExternalSessionTracker } from "../supervisor/ExternalSessionTracker.js";
import type { Process } from "../supervisor/Process.js";
import type { Supervisor } from "../supervisor/Supervisor.js";
import type { QueuedResponse } from "../supervisor/WorkerQueue.js";
import type { ContentBlock, Message } from "../supervisor/types.js";
import type { EventBus } from "../watcher/index.js";

/**
 * Type guard to check if a result is a QueuedResponse
 */
function isQueuedResponse(
  result: Process | QueuedResponse,
): result is QueuedResponse {
  return "queued" in result && result.queued === true;
}

export interface SessionsDeps {
  supervisor: Supervisor;
  scanner: ProjectScanner;
  readerFactory: (sessionDir: string) => SessionReader;
  externalTracker?: ExternalSessionTracker;
  notificationService?: NotificationService;
  sessionMetadataService?: SessionMetadataService;
  eventBus?: EventBus;
}

interface StartSessionBody {
  message: string;
  images?: string[];
  documents?: string[];
  attachments?: UploadedFile[];
  mode?: PermissionMode;
  model?: ModelOption;
  thinking?: ThinkingOption;
}

interface CreateSessionBody {
  mode?: PermissionMode;
  model?: ModelOption;
  thinking?: ThinkingOption;
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
      // User messages: string content works with preprocessMessages
      // Assistant messages: need ContentBlock[] format for preprocessMessages to render
      let content: string | ContentBlock[];
      if (msg.type === "user") {
        content =
          typeof rawContent === "string"
            ? rawContent
            : JSON.stringify(rawContent);
      } else {
        content =
          typeof rawContent === "string"
            ? [{ type: "text" as const, text: rawContent }]
            : (rawContent as ContentBlock[]);
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

export function createSessionsRoutes(deps: SessionsDeps): Hono {
  const routes = new Hono();

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

    const project = await deps.scanner.getProject(projectId);
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
    const reader = deps.readerFactory(project.sessionDir);
    const session = await reader.getSession(
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

    if (!session) {
      // Session file doesn't exist yet - only valid if we own the process
      if (process) {
        // Get messages from process memory (for mock SDK that doesn't persist to disk)
        const processMessages = sdkMessagesToClientMessages(
          process.getMessageHistory(),
        );
        // Get metadata even for new sessions (in case it was set before file was written)
        const metadata = deps.sessionMetadataService?.getMetadata(sessionId);
        return c.json({
          session: {
            id: sessionId,
            projectId,
            title: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            messageCount: processMessages.length,
            status,
            messages: processMessages,
            customTitle: metadata?.customTitle,
            isArchived: metadata?.isArchived,
            isStarred: metadata?.isStarred,
          },
          messages: processMessages,
          status,
        });
      }
      return c.json({ error: "Session not found" }, 404);
    }

    // Get session metadata (custom title, archived, starred)
    const metadata = deps.sessionMetadataService?.getMetadata(sessionId);

    return c.json({
      session: {
        ...session,
        status,
        customTitle: metadata?.customTitle,
        isArchived: metadata?.isArchived,
        isStarred: metadata?.isStarred,
      },
      messages: session.messages,
      status,
    });
  });

  // POST /api/projects/:projectId/sessions - Start new session
  routes.post("/projects/:projectId/sessions", async (c) => {
    const projectId = c.req.param("projectId");

    // Validate projectId format at API boundary
    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }

    const project = await deps.scanner.getProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
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
      { model, maxThinkingTokens },
    );

    // Check if request was queued
    if (isQueuedResponse(result)) {
      return c.json(result, 202); // 202 Accepted - queued for processing
    }

    // Started immediately
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

    const project = await deps.scanner.getProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
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
      },
    );

    // Check if request was queued
    if (isQueuedResponse(result)) {
      return c.json(result, 202); // 202 Accepted - queued for processing
    }

    // Created immediately - session exists and is ready for uploads
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

    const project = await deps.scanner.getProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
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
    };

    // Convert thinking option to token budget
    const maxThinkingTokens =
      body.thinking && body.thinking !== "off"
        ? thinkingOptionToTokens(body.thinking)
        : undefined;

    // Convert model option (undefined or "default" means use CLI default)
    const model =
      body.model && body.model !== "default" ? body.model : undefined;

    const result = await deps.supervisor.resumeSession(
      sessionId,
      project.path,
      userMessage,
      body.mode,
      { model, maxThinkingTokens },
    );

    // Check if request was queued
    if (isQueuedResponse(result)) {
      return c.json(result, 202); // 202 Accepted - queued for processing
    }

    // Started immediately
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

    // Update process permission mode if specified
    if (body.mode) {
      process.setPermissionMode(body.mode);
    }

    const result = process.queueMessage(userMessage);

    if (!result.success) {
      return c.json(
        {
          error: "Failed to queue message",
          reason: result.error,
        },
        410,
      ); // 410 Gone - process is no longer available
    }

    return c.json({ queued: true, position: result.position });
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

  // POST /api/sessions/:sessionId/mark-seen - Mark session as seen
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

  // GET /api/notifications/last-seen - Get all last seen entries
  routes.get("/notifications/last-seen", async (c) => {
    if (!deps.notificationService) {
      return c.json({ error: "Notification service not available" }, 503);
    }

    return c.json({ lastSeen: deps.notificationService.getAllLastSeen() });
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
