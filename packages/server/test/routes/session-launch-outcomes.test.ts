import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  TranscriptDisplayObject,
  UrlProjectId,
} from "@yep-anywhere/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeProjectId } from "../../src/projects/paths.js";
import {
  createSessionsRoutes,
  type SessionsDeps,
} from "../../src/routes/sessions.js";
import type { AgentProvider } from "../../src/sdk/providers/types.js";
import type {
  ClearloopRunner,
  ClearloopService,
} from "../../src/services/ClearloopService.js";
import { ClaudeSessionReader } from "../../src/sessions/reader.js";
import type { ISessionReader } from "../../src/sessions/types.js";
import type { Process } from "../../src/supervisor/Process.js";
import { Supervisor } from "../../src/supervisor/Supervisor.js";
import type { Project } from "../../src/supervisor/types.js";
import {
  closeTestDiscoveryDatabases,
  createTestSessionMetadataService,
} from "../utils/session-metadata-database.js";

// Characterization for the session-launch service plan (doc 177, step 3):
// every route that starts or resumes a session reads the Supervisor's
// started, queued or queue-full result itself. These pin each route's exact
// response and side effects for a queued and a full queue: which routes
// cancel a queued request, which accept it with 202, what each refusal body
// names, and when usage is recorded.

const QUEUED = { queued: true, queueId: "queue-1", position: 2 } as const;
const QUEUE_FULL = { error: "queue_full", maxQueueSize: 4 } as const;

const project: Project = {
  id: "proj-1" as UrlProjectId,
  path: "/tmp/project",
  name: "project",
  sessionCount: 1,
  sessionDir: "/tmp/project/.claude-sessions",
  activeOwnedCount: 0,
  activeExternalCount: 0,
  lastActivity: null,
  provider: "claude",
};

const source = {
  customTitle: "Refactor session",
  effectiveLaunchSettings: {
    schemaVersion: 1,
    revision: 1,
    permissionMode: "default",
    requestedModel: "settings-model",
  },
};

const sourceProcess = {
  id: "proc-source",
  provider: "claude",
  model: "live-model",
  resolvedModel: "live-model",
  permissionMode: "default",
  modeVersion: 0,
  state: { type: "idle", since: new Date() },
  getMessageHistory: vi.fn(() => [
    {
      type: "user",
      uuid: "msg-user-initial",
      timestamp: "2026-04-24T20:00:00.000Z",
      message: { role: "user", content: "Fix the failing test." },
    },
    {
      type: "assistant",
      uuid: "msg-after-initial-turn",
      timestamp: "2026-04-24T20:00:01.000Z",
      message: { role: "assistant", content: "Found the failing test." },
    },
  ]),
};

const startedProcess = (sessionId: string) => ({
  id: "proc-new",
  sessionId,
  projectId: project.id,
  projectPath: project.path,
  provider: "claude",
  model: "sonnet",
  resolvedModel: "sonnet",
  permissionMode: "default",
  modeVersion: 0,
  subscribe: vi.fn(() => vi.fn()),
});

/**
 * Routes over a mocked Supervisor whose launches answer `launch`, with every
 * metadata write, usage record and queue cancellation recorded.
 */
function successorRoutes(launch: unknown) {
  const writes: unknown[][] = [];
  let displayObjects: TranscriptDisplayObject[] = [];
  const readers: Record<string, unknown> = {
    getProvider: () => "claude",
    getRequestedModel: () => "saved-model",
    getExecutor: () => undefined,
    getMetadata: () => source,
    identities: undefined,
    nextForkOrdinal: async () => ({ ordinal: 1, lineageRootId: "sess-1" }),
    forkLineageRoot: (id: string) => id,
    getTranscriptDisplayObjects: () => displayObjects,
    addTranscriptDisplayObject: async (
      _sessionId: string,
      object: TranscriptDisplayObject,
    ) => {
      displayObjects = [...displayObjects, object];
    },
    updateTranscriptDisplayObject: async (
      _sessionId: string,
      objectId: string,
      updater: (object: TranscriptDisplayObject) => TranscriptDisplayObject,
    ) => {
      let updated: TranscriptDisplayObject | undefined;
      displayObjects = displayObjects.map((object) => {
        if (object.id !== objectId) return object;
        updated = updater(object);
        return updated;
      });
      return updated;
    },
  };
  const sessionMetadataService = new Proxy(readers, {
    get(target, prop) {
      if (typeof prop !== "string" || prop === "then") return undefined;
      if (prop in target) return target[prop];
      if (prop.startsWith("get")) return undefined;
      return async (...args: unknown[]) => {
        writes.push([prop, ...args]);
        return undefined;
      };
    },
  });
  const supervisor = {
    getProcessForSession: vi.fn(() => sourceProcess),
    interruptProcess: vi.fn(async () => ({ success: true, supported: true })),
    abortProcess: vi.fn(async () => true),
    supportsForkSession: vi.fn(() => true),
    cancelQueuedRequest: vi.fn(() => true),
    generateSummary: vi.fn(async () => ({
      text: "Title: Refactor continuation\n\nContinue from the fix.",
    })),
    forkSession: vi
      .fn()
      .mockResolvedValueOnce({ sessionId: "sess-fork" })
      .mockResolvedValueOnce({ sessionId: "sess-target" }),
    startSession: vi.fn(async () => launch),
    resumeSession: vi.fn(async () => launch),
  };
  const userUsageService = {
    recordSession: vi.fn(async () => undefined),
    recordTurn: vi.fn(async () => undefined),
  };
  const routes = createSessionsRoutes({
    supervisor: supervisor as unknown as SessionsDeps["supervisor"],
    scanner: {
      getOrCreateProject: vi.fn(async () => project),
    } as unknown as SessionsDeps["scanner"],
    readerFactory: vi.fn(
      () =>
        ({
          getSessionSummary: vi.fn(async () => null),
          getSession: vi.fn(async () => null),
        }) as unknown as ISessionReader,
    ),
    sessionMetadataService: sessionMetadataService as unknown as NonNullable<
      SessionsDeps["sessionMetadataService"]
    >,
    userUsageService:
      userUsageService as unknown as SessionsDeps["userUsageService"],
    eventBus: { emit: vi.fn() } as unknown as SessionsDeps["eventBus"],
  });
  const post = (path: string, body: unknown) =>
    routes.request(`/projects/${project.id}/sessions/sess-1/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  return {
    post,
    supervisor,
    userUsageService,
    writesFor: (sessionId: string) =>
      writes.filter(([, id]) => id === sessionId),
    forkSummary: () =>
      displayObjects.find((object) => object.kind === "fork-summary"),
  };
}

const restartHandoff = { handoffText: "Continue the fix." };
const restartFork = {
  restartMode: "fork",
  forkUpToMessageId: "msg-user-initial",
};
const staleHandoff = { message: "what is a volcano?" };

describe("restart handoff launch outcome", () => {
  it("a full queue answers 503 with the queue size", async () => {
    const fixture = successorRoutes(QUEUE_FULL);

    const response = await fixture.post("restart", restartHandoff);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Queue is full",
      maxQueueSize: 4,
    });
    expect(fixture.supervisor.cancelQueuedRequest).not.toHaveBeenCalled();
    expect(fixture.supervisor.abortProcess).not.toHaveBeenCalled();
    expect(fixture.userUsageService.recordSession).not.toHaveBeenCalled();
  });

  it("a queued launch is cancelled and answers 503, leaving the old process", async () => {
    const fixture = successorRoutes(QUEUED);

    const response = await fixture.post("restart", restartHandoff);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error:
        "Restart could not start immediately; old process was left running",
    });
    expect(fixture.supervisor.cancelQueuedRequest).toHaveBeenCalledWith(
      "queue-1",
    );
    expect(fixture.supervisor.abortProcess).not.toHaveBeenCalled();
    expect(fixture.userUsageService.recordSession).not.toHaveBeenCalled();
  });

  it("a started launch records the new session", async () => {
    const fixture = successorRoutes(startedProcess("sess-new"));

    const response = await fixture.post("restart", restartHandoff);

    expect(response.status).toBe(200);
    expect(fixture.userUsageService.recordSession).toHaveBeenCalledTimes(1);
    expect(fixture.userUsageService.recordTurn).not.toHaveBeenCalled();
    expect(fixture.writesFor("sess-new").length).toBeGreaterThan(0);
  });
});

describe("restart fork launch outcome", () => {
  it("a full queue answers 503 naming the fork", async () => {
    const fixture = successorRoutes(QUEUE_FULL);

    const response = await fixture.post("restart", restartFork);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Queue is full",
      maxQueueSize: 4,
      sessionId: "sess-fork",
      projectId: project.id,
    });
    expect(fixture.supervisor.cancelQueuedRequest).not.toHaveBeenCalled();
    expect(fixture.userUsageService.recordSession).not.toHaveBeenCalled();
  });

  it("a queued resume is cancelled and answers 503 naming the fork", async () => {
    const fixture = successorRoutes(QUEUED);

    const response = await fixture.post("restart", restartFork);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Fork could not start immediately; old process was left running",
      sessionId: "sess-fork",
      projectId: project.id,
    });
    expect(fixture.supervisor.cancelQueuedRequest).toHaveBeenCalledWith(
      "queue-1",
    );
    expect(fixture.supervisor.abortProcess).not.toHaveBeenCalled();
    expect(fixture.userUsageService.recordSession).not.toHaveBeenCalled();
    expect(fixture.writesFor("sess-fork")).toEqual([]);
  });
});

describe("stale-session handoff launch outcome", () => {
  it("a full queue answers 503 and records no usage", async () => {
    const fixture = successorRoutes(QUEUE_FULL);

    const response = await fixture.post("stale-handoff", staleHandoff);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Queue is full",
      maxQueueSize: 4,
    });
    expect(fixture.userUsageService.recordSession).not.toHaveBeenCalled();
    expect(fixture.userUsageService.recordTurn).not.toHaveBeenCalled();
  });

  it("a queued launch is kept and answers 202 with the queue position", async () => {
    const fixture = successorRoutes(QUEUED);

    const response = await fixture.post("stale-handoff", staleHandoff);

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      ...QUEUED,
      serverTimestamp: expect.any(Number),
    });
    expect(fixture.supervisor.cancelQueuedRequest).not.toHaveBeenCalled();
    expect(fixture.userUsageService.recordSession).toHaveBeenCalledTimes(1);
    expect(fixture.userUsageService.recordTurn).toHaveBeenCalledWith(
      undefined,
      "what is a volcano?",
    );
  });

  it("a started launch records the session and the turn", async () => {
    const fixture = successorRoutes(startedProcess("sess-new"));

    const response = await fixture.post("stale-handoff", staleHandoff);

    expect(response.status).toBe(200);
    expect(fixture.userUsageService.recordSession).toHaveBeenCalledTimes(1);
    expect(fixture.userUsageService.recordTurn).toHaveBeenCalledTimes(1);
  });
});

describe("fork-summary target launch outcome", () => {
  const request = { sourceMessageId: "msg-user-initial" };

  it("a full queue fails the summary with the queue error", async () => {
    const fixture = successorRoutes(QUEUE_FULL);

    const response = await fixture.post("fork-summary", request);

    expect(response.status).toBe(202);
    await vi.waitFor(() =>
      expect(fixture.forkSummary()).toMatchObject({
        status: "error",
        error: "Queue is full",
      }),
    );
    expect(fixture.supervisor.cancelQueuedRequest).not.toHaveBeenCalled();
    // Counted once its target fork exists, before the launch is refused.
    expect(fixture.userUsageService.recordSession).toHaveBeenCalledTimes(1);
  });

  it("a queued resume is cancelled and fails the summary", async () => {
    const fixture = successorRoutes(QUEUED);

    const response = await fixture.post("fork-summary", request);

    expect(response.status).toBe(202);
    await vi.waitFor(() =>
      expect(fixture.forkSummary()).toMatchObject({
        status: "error",
        error: "Fork summary could not start immediately",
      }),
    );
    expect(fixture.supervisor.cancelQueuedRequest).toHaveBeenCalledWith(
      "queue-1",
    );
    expect(fixture.userUsageService.recordSession).toHaveBeenCalledTimes(1);
  });
});

// Resume and /clearloop over a real transcript, metadata and Supervisor,
// with only the Supervisor's resume answer replaced.

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  closeTestDiscoveryDatabases();
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function resumeFixture(launch: unknown) {
  const dir = await mkdtemp(join(tmpdir(), "launch-outcomes-"));
  directories.push(dir);
  const sessionsDir = join(dir, "sessions");
  const projectPath = join(dir, "project");
  await mkdir(sessionsDir, { recursive: true });
  await mkdir(projectPath);
  const sessionId = randomUUID();
  const realProject: Project = {
    ...project,
    id: encodeProjectId(projectPath),
    path: projectPath,
    sessionDir: sessionsDir,
  };
  const line = (
    type: "user" | "assistant",
    uuid: string,
    parentUuid: string | null,
    text: string,
  ) => ({
    type,
    uuid,
    parentUuid,
    sessionId,
    cwd: projectPath,
    timestamp: "2026-09-26T08:00:00.000Z",
    message:
      type === "user"
        ? { role: "user", content: text }
        : {
            id: `msg-${uuid}`,
            role: "assistant",
            model: "claude-opus-5-5",
            content: [{ type: "text", text }],
            stop_reason: "end_turn",
          },
  });
  await writeFile(
    join(sessionsDir, `${sessionId}.jsonl`),
    `${[line("user", "u1", null, "first"), line("assistant", "a1", "u1", "one")]
      .map((entry) => JSON.stringify(entry))
      .join("\n")}\n`,
  );
  const metadata = createTestSessionMetadataService(dir);
  await metadata.initialize();
  await metadata.setProvider(sessionId, "claude");

  const supervisor = new Supervisor({
    provider: { name: "claude" } as unknown as AgentProvider,
  });
  vi.spyOn(supervisor, "resumeSession").mockResolvedValue(
    launch as unknown as Process,
  );
  const cancelQueuedRequest = vi
    .spyOn(supervisor, "cancelQueuedRequest")
    .mockReturnValue(true);
  const userUsageService = {
    recordSession: vi.fn(async () => undefined),
    recordTurn: vi.fn(async () => undefined),
  };
  let clearloopRunner: ClearloopRunner | undefined;
  const routes = createSessionsRoutes({
    supervisor,
    scanner: {
      getOrCreateProject: async () => realProject,
    } as unknown as SessionsDeps["scanner"],
    readerFactory: () => new ClaudeSessionReader({ sessionDir: sessionsDir }),
    sessionMetadataService: metadata,
    userUsageService:
      userUsageService as unknown as SessionsDeps["userUsageService"],
    clearloopService: {
      setRunner: (runner: ClearloopRunner) => {
        clearloopRunner = runner;
      },
      isRunning: () => false,
      getBadge: () => undefined,
    } as unknown as ClearloopService,
  });
  if (!clearloopRunner) throw new Error("routes did not install the runner");
  const runner = clearloopRunner;
  return {
    cancelQueuedRequest,
    userUsageService,
    resume: () =>
      routes.request(
        `/projects/${realProject.id}/sessions/${sessionId}/resume`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: "continue" }),
        },
      ),
    clearloopSend: () =>
      runner.send({
        sessionId,
        projectId: realProject.id,
        job: { prompt: "again" },
      } as Parameters<ClearloopRunner["send"]>[0]),
  };
}

describe("resume launch outcome", () => {
  it("a full queue answers 503 and records no turn", async () => {
    const fixture = await resumeFixture(QUEUE_FULL);

    const response = await fixture.resume();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Queue is full",
      maxQueueSize: 4,
    });
    expect(fixture.userUsageService.recordTurn).not.toHaveBeenCalled();
  });

  it("a queued resume is kept and answers 202 with the queue position", async () => {
    const fixture = await resumeFixture(QUEUED);

    const response = await fixture.resume();

    expect(response.status).toBe(202);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({
      ...QUEUED,
      serverTimestamp: expect.any(Number),
      resume: expect.objectContaining({ outcome: "queued" }),
    });
    expect(fixture.cancelQueuedRequest).not.toHaveBeenCalled();
    expect(fixture.userUsageService.recordTurn).toHaveBeenCalledWith(
      undefined,
      "continue",
    );
    expect(fixture.userUsageService.recordSession).not.toHaveBeenCalled();
  });

  it("a started resume records the turn once", async () => {
    const fixture = await resumeFixture({
      id: "process-1",
      permissionMode: "default",
      modeVersion: 0,
    });

    const response = await fixture.resume();

    expect(response.status).toBe(200);
    expect(fixture.userUsageService.recordTurn).toHaveBeenCalledTimes(1);
    expect(fixture.userUsageService.recordTurn).toHaveBeenCalledWith(
      undefined,
      "continue",
    );
  });
});

describe("/clearloop launch outcome", () => {
  it("a full queue fails the iteration's send", async () => {
    const fixture = await resumeFixture(QUEUE_FULL);

    await expect(fixture.clearloopSend()).rejects.toThrow("Queue is full");
  });

  it("a queued send is kept and the iteration goes on", async () => {
    const fixture = await resumeFixture(QUEUED);

    await expect(fixture.clearloopSend()).resolves.toBeUndefined();
    expect(fixture.cancelQueuedRequest).not.toHaveBeenCalled();
    expect(fixture.userUsageService.recordTurn).not.toHaveBeenCalled();
  });
});
