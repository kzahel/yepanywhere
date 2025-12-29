import { Hono } from "hono";
import type { ProjectScanner } from "../projects/scanner.js";
import type { UserMessage } from "../sdk/types.js";
import type { SessionReader } from "../sessions/reader.js";
import type { Supervisor } from "../supervisor/Supervisor.js";

export interface SessionsDeps {
  supervisor: Supervisor;
  scanner: ProjectScanner;
  readerFactory: (sessionDir: string) => SessionReader;
}

interface StartSessionBody {
  message: string;
  images?: string[];
  documents?: string[];
}

interface InputResponseBody {
  requestId: string;
  response: "approve" | "deny" | string;
}

export function createSessionsRoutes(deps: SessionsDeps): Hono {
  const routes = new Hono();

  // GET /api/projects/:projectId/sessions/:sessionId - Get session detail
  routes.get("/projects/:projectId/sessions/:sessionId", async (c) => {
    const projectId = c.req.param("projectId");
    const sessionId = c.req.param("sessionId");

    const project = await deps.scanner.getProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    // Check if session is actively owned by a process (for mock/testing scenarios
    // where session files may not exist on disk yet)
    const process = deps.supervisor.getProcessForSession(sessionId);
    if (process) {
      // Return minimal session data for active processes
      return c.json({
        session: {
          id: sessionId,
          projectId,
          title: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          messageCount: 0,
          status: { state: "owned", processId: process.id },
          messages: [],
        },
        messages: [],
        status: { state: "owned", processId: process.id },
      });
    }

    const sessionDir = await deps.scanner.findProjectDir(project.path);
    if (!sessionDir) {
      return c.json({ error: "Session not found" }, 404);
    }

    const reader = deps.readerFactory(sessionDir);
    const session = await reader.getSession(sessionId, projectId);
    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }

    return c.json({
      session,
      messages: session.messages,
      status: session.status,
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
    };

    const process = await deps.supervisor.startSession(
      project.path,
      userMessage,
    );

    return c.json({
      sessionId: process.sessionId,
      processId: process.id,
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
    };

    const process = await deps.supervisor.resumeSession(
      sessionId,
      project.path,
      userMessage,
    );

    return c.json({ processId: process.id });
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
    };

    const position = process.queueMessage(userMessage);

    return c.json({ queued: true, position });
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
