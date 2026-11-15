/** Debug/testing routes under /debug, served on the maintenance server port. */
import type * as http from "node:http";
import type { SDKMessage } from "../sdk/types.js";
import { normalizeSession } from "../sessions/normalization.js";
import type { ISessionReader } from "../sessions/types.js";
import type { UrlProjectId } from "@yep-anywhere/shared";
import type { Process } from "../supervisor/Process.js";
import type { Supervisor } from "../supervisor/Supervisor.js";
import type { Message } from "../supervisor/types.js";

/** Populated by createApp and passed to the maintenance server. */
export interface DebugContext {
  supervisor: Supervisor;
  /** Borrow the app's scoped native reader for this public session. */
  getSessionSource: (
    projectPath: string,
    sessionId: string,
  ) => Promise<{
    reader: ISessionReader;
    nativeSessionId: string;
    projectId: UrlProjectId;
  } | null>;
  claudeSessionsDir: string;
}

/** Global debug context - set by the main app */
let debugContext: DebugContext | null = null;

export function setDebugContext(ctx: DebugContext | null): void {
  debugContext = ctx;
}

export function getDebugContext(): DebugContext | null {
  return debugContext;
}

interface SessionListItem {
  sessionId: string;
  processId: string;
  projectPath: string;
  state: string;
  messageCount: number;
  streamEventCount: number;
  startedAt: string;
  idleSince?: string;
}

interface SessionDetail {
  sessionId: string;
  processId: string;
  projectPath: string;
  state: string;
  messages: MessagePreview[];
  stats: {
    userMessages: number;
    assistantMessages: number;
    streamEvents: number;
    totalInMemory: number;
  };
}

interface MessagePreview {
  uuid?: string;
  type: string;
  parentUuid?: string | null;
  contentPreview: string;
}

interface CompareResult {
  sessionId: string;
  sse: {
    count: number;
    userCount: number;
    assistantCount: number;
  };
  jsonl: {
    count: number;
    userCount: number;
    assistantCount: number;
  };
  comparison: {
    matching: number;
    inSseOnly: string[];
    inJsonlOnly: string[];
    uuidMismatches: Array<{
      index: number;
      sseUuid: string | undefined;
      jsonlUuid: string | undefined;
    }>;
    parentUuidDiffs: Array<{
      uuid: string;
      sseParentUuid: string | null | undefined;
      jsonlParentUuid: string | null | undefined;
    }>;
  };
}

interface SendResult {
  queued?: boolean;
  position?: number;
  state?: string;
  durationMs?: number;
  newMessages?: MessagePreview[];
  error?: string;
}

interface RapidResult {
  sent: number;
  durationMs: number;
  results: Array<{
    message: string;
    queuedAt: string;
    uuid?: string;
  }>;
  finalState: string;
  dagStructure?: {
    description: string;
    branches: number;
    leafNodes: string[];
  };
}

interface CreateResult {
  sessionId: string;
  processId: string;
  projectPath: string;
  state: string;
  messages: MessagePreview[];
  error?: string;
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  data: unknown,
): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data, null, 2));
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const body = Buffer.concat(chunks).toString();
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function parseQuery(url: URL): Record<string, string> {
  const params: Record<string, string> = {};
  url.searchParams.forEach((value, key) => {
    params[key] = value;
  });
  return params;
}

function getContentPreview(message: SDKMessage): string {
  if (message.type === "user" && message.message?.content) {
    const content = message.message.content;
    if (typeof content === "string") {
      return content.length > 100 ? `${content.slice(0, 100)}...` : content;
    }
    return "[complex content]";
  }
  if (message.type === "assistant" && message.message?.content) {
    const content = message.message.content;
    if (typeof content === "string") {
      return content.length > 100 ? `${content.slice(0, 100)}...` : content;
    }
    if (Array.isArray(content)) {
      const textParts: string[] = [];
      for (const block of content) {
        const b = block as { type?: string; text?: string };
        if (b.type === "text" && b.text) {
          textParts.push(b.text);
        }
      }
      if (textParts.length > 0) {
        const text = textParts.join(" ");
        return text.length > 100 ? `${text.slice(0, 100)}...` : text;
      }
      const types = content.map(
        (b) => (b as { type?: string }).type ?? "unknown",
      );
      return `[${types.join(", ")}]`;
    }
    return "[complex content]";
  }
  if (message.type === "stream_event") {
    return `[stream_event: ${message.event ?? "unknown"}]`;
  }
  return `[${message.type}]`;
}

function toMessagePreview(message: SDKMessage): MessagePreview {
  return {
    uuid: message.uuid,
    type: message.type,
    parentUuid: message.parentUuid,
    contentPreview: getContentPreview(message),
  };
}

async function waitForIdle(
  process: Process,
  timeoutMs: number,
): Promise<{ success: boolean; state: string; durationMs: number }> {
  const startTime = Date.now();

  return new Promise((resolve) => {
    if (process.state.type === "idle") {
      resolve({
        success: true,
        state: "idle",
        durationMs: Date.now() - startTime,
      });
      return;
    }

    const timeout = setTimeout(() => {
      unsubscribe();
      resolve({
        success: false,
        state: process.state.type,
        durationMs: Date.now() - startTime,
      });
    }, timeoutMs);

    const unsubscribe = process.subscribe((event) => {
      if (event.type === "state-change" && event.state.type === "idle") {
        clearTimeout(timeout);
        unsubscribe();
        resolve({
          success: true,
          state: "idle",
          durationMs: Date.now() - startTime,
        });
      }
    });
  });
}

async function handleListSessions(
  res: http.ServerResponse,
  ctx: DebugContext,
): Promise<void> {
  const processes = ctx.supervisor.getAllProcesses();

  const sessions: SessionListItem[] = processes.map((p) => {
    const history = p.getMessageHistory();
    const streamEventCount = history.filter(
      (m) => m.type === "stream_event",
    ).length;
    const messageCount = history.length - streamEventCount;

    const item: SessionListItem = {
      sessionId: p.sessionId,
      processId: p.id,
      projectPath: p.projectPath,
      state: p.state.type,
      messageCount,
      streamEventCount,
      startedAt: p.startedAt.toISOString(),
    };

    if (p.state.type === "idle") {
      item.idleSince = p.state.since.toISOString();
    }

    return item;
  });

  sendJson(res, 200, { sessions });
}

async function handleGetSession(
  res: http.ServerResponse,
  ctx: DebugContext,
  sessionId: string,
  query: Record<string, string>,
): Promise<void> {
  const process = ctx.supervisor.getProcessForSession(sessionId);

  if (!process) {
    sendJson(res, 404, { error: "Session not found", sessionId });
    return;
  }

  const includeStreamEvents = query.includeStreamEvents === "true";
  const limit = Number.parseInt(query.limit ?? "100", 10);
  const offset = Number.parseInt(query.offset ?? "0", 10);

  const history = process.getMessageHistory();
  let messages = includeStreamEvents
    ? history
    : history.filter((m) => m.type !== "stream_event");

  messages = messages.slice(offset, offset + limit);

  const userCount = history.filter((m) => m.type === "user").length;
  const assistantCount = history.filter((m) => m.type === "assistant").length;
  const streamEventCount = history.filter(
    (m) => m.type === "stream_event",
  ).length;

  const detail: SessionDetail = {
    sessionId: process.sessionId,
    processId: process.id,
    projectPath: process.projectPath,
    state: process.state.type,
    messages: messages.map(toMessagePreview),
    stats: {
      userMessages: userCount,
      assistantMessages: assistantCount,
      streamEvents: streamEventCount,
      totalInMemory: history.length,
    },
  };

  sendJson(res, 200, detail);
}

async function handleCompare(
  res: http.ServerResponse,
  ctx: DebugContext,
  sessionId: string,
): Promise<void> {
  const process = ctx.supervisor.getProcessForSession(sessionId);

  if (!process) {
    sendJson(res, 404, { error: "Session not found", sessionId });
    return;
  }

  // Get SSE messages (in-memory)
  const sseHistory = process.getMessageHistory();
  const sseMessages = sseHistory.filter(
    (m) => m.type === "user" || m.type === "assistant",
  );

  // Get JSONL messages (on-disk)
  const source = await ctx.getSessionSource(process.projectPath, sessionId);
  if (!source) {
    sendJson(res, 500, {
      error: "Could not create session reader",
      projectPath: process.projectPath,
    });
    return;
  }

  const loadedSession = await source.reader.getSession(
    source.nativeSessionId,
    source.projectId,
    undefined,
    { includeOrphans: false },
  );
  const session = loadedSession ? normalizeSession(loadedSession) : null;
  const jsonlMessages = session?.messages ?? [];

  const sseUuids = new Set(sseMessages.map((m) => m.uuid).filter(Boolean));
  const jsonlUuids = new Set(
    jsonlMessages.map((m: Message) => m.uuid).filter(Boolean),
  );

  const inSseOnly = [...sseUuids].filter(
    (u) => u && !jsonlUuids.has(u),
  ) as string[];
  const inJsonlOnly = [...jsonlUuids].filter(
    (u) => u && !sseUuids.has(u),
  ) as string[];
  const matching = [...sseUuids].filter((u) => u && jsonlUuids.has(u)).length;

  const parentUuidDiffs: CompareResult["comparison"]["parentUuidDiffs"] = [];
  for (const sseMsg of sseMessages) {
    if (!sseMsg.uuid) continue;
    const jsonlMsg = jsonlMessages.find((m: Message) => m.uuid === sseMsg.uuid);
    if (jsonlMsg && sseMsg.parentUuid !== jsonlMsg.parentUuid) {
      parentUuidDiffs.push({
        uuid: sseMsg.uuid,
        sseParentUuid: sseMsg.parentUuid,
        jsonlParentUuid: jsonlMsg.parentUuid,
      });
    }
  }

  const result: CompareResult = {
    sessionId,
    sse: {
      count: sseMessages.length,
      userCount: sseMessages.filter((m) => m.type === "user").length,
      assistantCount: sseMessages.filter((m) => m.type === "assistant").length,
    },
    jsonl: {
      count: jsonlMessages.length,
      userCount: jsonlMessages.filter((m: Message) => m.type === "user").length,
      assistantCount: jsonlMessages.filter(
        (m: Message) => m.type === "assistant",
      ).length,
    },
    comparison: {
      matching,
      inSseOnly,
      inJsonlOnly,
      uuidMismatches: [],
      parentUuidDiffs,
    },
  };

  sendJson(res, 200, result);
}

async function handleSend(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: DebugContext,
  sessionId: string,
): Promise<void> {
  const process = ctx.supervisor.getProcessForSession(sessionId);

  if (!process) {
    sendJson(res, 404, { error: "Session not found", sessionId });
    return;
  }

  const body = (await readJsonBody(req)) as {
    message: string;
    blocking?: boolean;
    timeoutMs?: number;
  };

  if (!body.message) {
    sendJson(res, 400, { error: "message is required" });
    return;
  }

  const blocking = body.blocking ?? false;
  const timeoutMs = body.timeoutMs ?? 60000;

  const beforeCount = process.getMessageHistory().length;

  const queueResult = process.queueMessage({ text: body.message });

  if (!queueResult.success) {
    sendJson(res, 500, { error: queueResult.error });
    return;
  }

  if (!blocking) {
    const result: SendResult = {
      queued: true,
      position: queueResult.position,
    };
    sendJson(res, 200, result);
    return;
  }

  const waitResult = await waitForIdle(process, timeoutMs);

  if (!waitResult.success) {
    sendJson(res, 408, {
      error: "Timeout waiting for response",
      state: waitResult.state,
      durationMs: waitResult.durationMs,
    });
    return;
  }

  const afterHistory = process.getMessageHistory();
  const newMessages = afterHistory
    .slice(beforeCount)
    .filter((m) => m.type === "user" || m.type === "assistant");

  const result: SendResult = {
    state: "idle",
    durationMs: waitResult.durationMs,
    newMessages: newMessages.map(toMessagePreview),
  };

  sendJson(res, 200, result);
}

async function handleRapid(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: DebugContext,
  sessionId: string,
): Promise<void> {
  const process = ctx.supervisor.getProcessForSession(sessionId);

  if (!process) {
    sendJson(res, 404, { error: "Session not found", sessionId });
    return;
  }

  const body = (await readJsonBody(req)) as {
    messages: string[];
    delayMs?: number;
    blocking?: boolean;
    timeoutMs?: number;
  };

  if (
    !body.messages ||
    !Array.isArray(body.messages) ||
    body.messages.length === 0
  ) {
    sendJson(res, 400, { error: "messages array is required" });
    return;
  }

  const delayMs = body.delayMs ?? 0;
  const blocking = body.blocking ?? true;
  const timeoutMs = body.timeoutMs ?? 120000;

  const startTime = Date.now();
  const results: RapidResult["results"] = [];

  for (const message of body.messages) {
    const queuedAt = new Date().toISOString();
    const queueResult = process.queueMessage({ text: message });

    results.push({
      message,
      queuedAt,
      uuid: undefined, // Will be assigned by SDK
    });

    if (!queueResult.success) {
      sendJson(res, 500, {
        error: `Failed to queue message: ${queueResult.error}`,
        sent: results.length - 1,
      });
      return;
    }

    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  if (!blocking) {
    const result: RapidResult = {
      sent: results.length,
      durationMs: Date.now() - startTime,
      results,
      finalState: process.state.type,
    };
    sendJson(res, 200, result);
    return;
  }

  const waitResult = await waitForIdle(process, timeoutMs);

  // Analyze DAG structure (simplified - just look at branches)
  const history = process.getMessageHistory();
  const parentCounts = new Map<string | null | undefined, number>();
  for (const msg of history) {
    if (msg.type === "user" || msg.type === "assistant") {
      const parent = msg.parentUuid ?? null;
      parentCounts.set(parent, (parentCounts.get(parent) ?? 0) + 1);
    }
  }
  const branches = [...parentCounts.values()].filter((c) => c > 1).length || 1;

  const hasChildren = new Set<string>();
  for (const msg of history) {
    if (msg.parentUuid) {
      hasChildren.add(msg.parentUuid);
    }
  }
  const leafNodes = history
    .filter(
      (m) =>
        (m.type === "user" || m.type === "assistant") &&
        m.uuid &&
        !hasChildren.has(m.uuid),
    )
    .map((m) => m.uuid as string);

  const result: RapidResult = {
    sent: results.length,
    durationMs: Date.now() - startTime,
    results,
    finalState: waitResult.state,
    dagStructure: {
      description: branches > 1 ? "Branching detected" : "Linear chain",
      branches,
      leafNodes,
    },
  };

  sendJson(res, 200, result);
}

async function handleCreate(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: DebugContext,
): Promise<void> {
  const body = (await readJsonBody(req)) as {
    projectPath: string;
    message: string;
    model?: string;
    blocking?: boolean;
    timeoutMs?: number;
  };

  if (!body.projectPath) {
    sendJson(res, 400, { error: "projectPath is required" });
    return;
  }

  if (!body.message) {
    sendJson(res, 400, { error: "message is required" });
    return;
  }

  const blocking = body.blocking ?? true;
  const timeoutMs = body.timeoutMs ?? 60000;

  try {
    const result = await ctx.supervisor.startSession(
      body.projectPath,
      { text: body.message },
      "default",
      body.model ? { model: body.model } : undefined,
      {
        creation: {
          context: {
            owner: { kind: "superuser" },
            source: { kind: "request", provenance: { surface: "api" } },
          },
          authorize: async () => {},
        },
      },
    );

    if ("queued" in result && result.queued) {
      sendJson(res, 202, {
        queued: true,
        queueId: result.queueId,
        position: result.position,
      });
      return;
    }

    if ("error" in result) {
      sendJson(res, 503, {
        error: result.error,
        maxQueueSize: result.maxQueueSize,
      });
      return;
    }

    const process = result as Process;

    if (!blocking) {
      const createResult: CreateResult = {
        sessionId: process.sessionId,
        processId: process.id,
        projectPath: process.projectPath,
        state: process.state.type,
        messages: process.getMessageHistory().map(toMessagePreview),
      };
      sendJson(res, 200, createResult);
      return;
    }

    const waitResult = await waitForIdle(process, timeoutMs);

    const createResult: CreateResult = {
      sessionId: process.sessionId,
      processId: process.id,
      projectPath: process.projectPath,
      state: waitResult.state,
      messages: process
        .getMessageHistory()
        .filter((m) => m.type === "user" || m.type === "assistant")
        .map(toMessagePreview),
    };

    sendJson(res, 200, createResult);
  } catch (err) {
    sendJson(res, 500, {
      error: "Failed to create session",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

async function handleDelete(
  res: http.ServerResponse,
  ctx: DebugContext,
  sessionId: string,
): Promise<void> {
  const process = ctx.supervisor.getProcessForSession(sessionId);

  if (!process) {
    sendJson(res, 404, { error: "Session not found", sessionId });
    return;
  }

  const processId = process.id;
  const success = await ctx.supervisor.abortProcess(processId);

  if (success) {
    sendJson(res, 200, { terminated: true, reason: "debug-cleanup" });
  } else {
    sendJson(res, 500, { error: "Failed to terminate session" });
  }
}

/**
 * Handle a debug API request.
 * Returns true if the request was handled, false otherwise.
 */
export async function handleDebugRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
): Promise<boolean> {
  const path = url.pathname;
  const method = req.method ?? "GET";

  if (!path.startsWith("/debug")) {
    return false;
  }

  if (!debugContext) {
    sendJson(res, 503, {
      error: "Debug API not available",
      message: "Debug context not initialized. Is the main server running?",
    });
    return true;
  }

  const ctx = debugContext;
  const query = parseQuery(url);

  try {
    if (path === "/debug/sessions" && method === "GET") {
      await handleListSessions(res, ctx);
      return true;
    }

    if (path === "/debug/sessions/create" && method === "POST") {
      await handleCreate(req, res, ctx);
      return true;
    }

    const sessionMatch = path.match(/^\/debug\/sessions\/([^/]+)$/);
    if (sessionMatch?.[1] && method === "GET") {
      await handleGetSession(res, ctx, sessionMatch[1], query);
      return true;
    }

    if (sessionMatch?.[1] && method === "DELETE") {
      await handleDelete(res, ctx, sessionMatch[1]);
      return true;
    }

    const compareMatch = path.match(/^\/debug\/sessions\/([^/]+)\/compare$/);
    if (compareMatch?.[1] && method === "GET") {
      await handleCompare(res, ctx, compareMatch[1]);
      return true;
    }

    const sendMatch = path.match(/^\/debug\/sessions\/([^/]+)\/send$/);
    if (sendMatch?.[1] && method === "POST") {
      await handleSend(req, res, ctx, sendMatch[1]);
      return true;
    }

    const rapidMatch = path.match(/^\/debug\/sessions\/([^/]+)\/rapid$/);
    if (rapidMatch?.[1] && method === "POST") {
      await handleRapid(req, res, ctx, rapidMatch[1]);
      return true;
    }

    sendJson(res, 404, {
      error: "Unknown debug endpoint",
      path,
      availableEndpoints: [
        "GET  /debug/sessions",
        "POST /debug/sessions/create",
        "GET  /debug/sessions/:sessionId",
        "DELETE /debug/sessions/:sessionId",
        "GET  /debug/sessions/:sessionId/compare",
        "POST /debug/sessions/:sessionId/send",
        "POST /debug/sessions/:sessionId/rapid",
      ],
    });
    return true;
  } catch (err) {
    sendJson(res, 500, {
      error: "Internal error",
      message: err instanceof Error ? err.message : String(err),
    });
    return true;
  }
}
