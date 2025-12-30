import { Hono } from "hono";
import type { ProjectScanner } from "../projects/scanner.js";
import type { PermissionMode, SDKMessage, UserMessage } from "../sdk/types.js";
import type { SessionReader } from "../sessions/reader.js";
import type { ExternalSessionTracker } from "../supervisor/ExternalSessionTracker.js";
import type { Supervisor } from "../supervisor/Supervisor.js";
import type { ContentBlock, Message } from "../supervisor/types.js";

export interface SessionsDeps {
  supervisor: Supervisor;
  scanner: ProjectScanner;
  readerFactory: (sessionDir: string) => SessionReader;
  externalTracker?: ExternalSessionTracker;
}

interface StartSessionBody {
  message: string;
  images?: string[];
  documents?: string[];
  mode?: PermissionMode;
}

interface InputResponseBody {
  requestId: string;
  response: "approve" | "deny" | string;
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

    const project = await deps.scanner.getProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    // Check if session is actively owned by a process
    const process = deps.supervisor.getProcessForSession(sessionId);

    // Check if session is being controlled by an external program
    const isExternal = deps.externalTracker?.isExternal(sessionId) ?? false;

    // Always try to read from disk first (even for owned sessions)
    const reader = deps.readerFactory(project.sessionDir);
    const session = await reader.getSession(
      sessionId,
      projectId,
      afterMessageId,
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
          },
          messages: processMessages,
          status,
        });
      }
      return c.json({ error: "Session not found" }, 404);
    }

    return c.json({
      session: { ...session, status },
      messages: session.messages,
      status,
    });
  });

  // POST /api/projects/:projectId/sessions - Start new session
  routes.post("/projects/:projectId/sessions", async (c) => {
    const projectId = c.req.param("projectId");

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
      mode: body.mode,
    };

    const process = await deps.supervisor.startSession(
      project.path,
      userMessage,
      body.mode,
    );

    return c.json({
      sessionId: process.sessionId,
      processId: process.id,
      permissionMode: process.permissionMode,
      modeVersion: process.modeVersion,
    });
  });

  // POST /api/projects/:projectId/sessions/:sessionId/resume - Resume session
  routes.post("/projects/:projectId/sessions/:sessionId/resume", async (c) => {
    const projectId = c.req.param("projectId");
    const sessionId = c.req.param("sessionId");

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
      mode: body.mode,
    };

    const process = await deps.supervisor.resumeSession(
      sessionId,
      project.path,
      userMessage,
      body.mode,
    );

    return c.json({
      processId: process.id,
      permissionMode: process.permissionMode,
      modeVersion: process.modeVersion,
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

    // Normalize response to approve/deny
    const normalizedResponse =
      body.response === "approve" || body.response === "allow"
        ? "approve"
        : "deny";

    // Call respondToInput which resolves the SDK's canUseTool promise
    const accepted = process.respondToInput(body.requestId, normalizedResponse);

    if (!accepted) {
      return c.json({ error: "Invalid request ID or no pending request" }, 400);
    }

    return c.json({ accepted: true });
  });

  return routes;
}
