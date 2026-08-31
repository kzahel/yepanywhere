import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  DurableRecapMessage,
  ProviderName,
  TranscriptDisplayObject,
  UrlProjectId,
} from "@yep-anywhere/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getLogger } from "../../src/logging/logger.js";
import {
  canonicalizeProjectPath,
  encodeProjectId,
} from "../../src/projects/paths.js";
import {
  createSessionsRoutes,
  type SessionsDeps,
} from "../../src/routes/sessions.js";
import {
  type PersistedSessionQueuedMessage,
  SessionQueuePersistenceService,
} from "../../src/services/SessionQueuePersistenceService.js";
import type { UserMessage } from "../../src/sdk/types.js";
import type { CodexSessionReader } from "../../src/sessions/codex-reader.js";
import type { GrokSessionReader } from "../../src/sessions/grok-reader.js";
import type {
  ISessionReader,
  LoadedSession,
} from "../../src/sessions/types.js";
import {
  ResumeCompactionError,
  RetryableSessionLaunchError,
  SessionConfigurationConflictError,
} from "../../src/supervisor/Supervisor.js";
import type {
  Message,
  Project,
  SessionSummary,
} from "../../src/supervisor/types.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function createProject(): Project {
  return {
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
}

function createSummary(): SessionSummary {
  return {
    id: "sess-1",
    projectId: "proj-1" as UrlProjectId,
    title: "Codex metadata title",
    fullTitle: "Codex metadata title",
    createdAt: new Date("2026-03-10T09:45:00.000Z").toISOString(),
    updatedAt: new Date("2026-03-10T09:46:00.000Z").toISOString(),
    messageCount: 2,
    ownership: { owner: "none" },
    provider: "codex",
    model: "gpt-5-codex",
  };
}

function createLoadedCodexSession(): LoadedSession {
  return {
    summary: createSummary(),
    data: {
      provider: "codex",
      session: {
        entries: [],
      },
    },
  };
}

function createLoadedGrokSession(
  summaryOverrides: Partial<SessionSummary> = {},
  messages: Message[] = [
    {
      uuid: "provider-1",
      type: "assistant",
      timestamp: "2026-03-10T09:46:00.000Z",
      message: { role: "assistant", content: "Provider response." },
    },
  ],
): LoadedSession {
  return {
    summary: {
      ...createSummary(),
      provider: "grok",
      model: "grok-build",
      ...summaryOverrides,
    },
    data: {
      provider: "grok",
      session: { messages },
    },
  };
}

async function withSessionQueuePersistence<T>(
  fn: (service: SessionQueuePersistenceService) => Promise<T>,
): Promise<T> {
  const tempDir = await mkdtemp(join(tmpdir(), "ya-session-queue-route-"));
  try {
    const service = new SessionQueuePersistenceService({ dataDir: tempDir });
    await service.initialize();
    return await fn(service);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function createPersistedPatientQueueItem(
  project: Project,
  overrides: Partial<PersistedSessionQueuedMessage> = {},
): PersistedSessionQueuedMessage {
  const id = overrides.id ?? "queue-1";
  const base: PersistedSessionQueuedMessage = {
    id,
    sessionId: "sess-1",
    projectId: project.id,
    projectPath: project.path,
    provider: "claude",
    kind: "patient",
    message: {
      text: "resume after restart",
      tempId: `temp-${id}`,
      metadata: { deliveryIntent: "patient" },
    },
    createdAt: "2026-06-30T09:00:00.000Z",
    updatedAt: "2026-06-30T09:01:00.000Z",
    queuedAt: "2026-06-30T09:00:00.000Z",
    status: "paused-after-restart",
    source: { tempId: `temp-${id}` },
  };
  return {
    ...base,
    ...overrides,
    message: overrides.message ?? base.message,
    source: overrides.source ?? base.source,
  };
}

async function createGrokRedirectFixture(): Promise<{
  tempDir: string;
  wrongProject: Project;
  rightProject: Project;
  rightProjectId: UrlProjectId;
  sessionId: string;
  grokSessionsDir: string;
  sessionDir: string;
}> {
  const tempDir = await mkdtemp(join(tmpdir(), "ya-grok-redirect-"));
  const wrongProjectPath = canonicalizeProjectPath(join(tempDir, "wrong"));
  const rightProjectPath = canonicalizeProjectPath(join(tempDir, "right"));
  const sessionId = "grok-native-id";
  const grokSessionsDir = join(tempDir, "grok-sessions");
  const sessionDir = join(
    grokSessionsDir,
    encodeURIComponent(rightProjectPath),
    sessionId,
  );
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    join(sessionDir, "summary.json"),
    JSON.stringify({
      info: { id: sessionId, cwd: rightProjectPath },
      created_at: "2026-05-28T17:00:00.000Z",
      updated_at: "2026-05-28T17:01:00.000Z",
      generated_title: "Right Grok",
      session_summary: "Right Grok",
      num_messages: 1,
      current_model_id: "grok-build",
    }),
  );

  return {
    tempDir,
    wrongProject: {
      ...createProject(),
      id: encodeProjectId(wrongProjectPath),
      path: wrongProjectPath,
      name: "wrong",
      sessionDir: join(wrongProjectPath, ".claude-sessions"),
    },
    rightProject: {
      ...createProject(),
      id: encodeProjectId(rightProjectPath),
      path: rightProjectPath,
      name: "right",
      sessionDir: join(rightProjectPath, ".claude-sessions"),
    },
    rightProjectId: encodeProjectId(rightProjectPath),
    sessionId,
    grokSessionsDir,
    sessionDir,
  };
}

describe("Sessions metadata route", () => {
  it("writes Codex titles through the native provider without persisting a local copy", async () => {
    const rename = vi.fn(async () => undefined);
    const updateMetadata = vi.fn(async () => undefined);
    const emit = vi.fn();
    const routes = createSessionsRoutes({
      supervisor: {} as SessionsDeps["supervisor"],
      sessionMetadataService: {
        getProvider: vi.fn(() => "codex"),
        updateMetadata,
      } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>,
      codexNativeTitleService: {
        rename,
      } as unknown as NonNullable<SessionsDeps["codexNativeTitleService"]>,
      eventBus: { emit } as unknown as NonNullable<SessionsDeps["eventBus"]>,
    } as SessionsDeps);

    const response = await routes.request("/sessions/thread-1/metadata", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Native Codex title" }),
    });

    expect(response.status).toBe(200);
    expect(rename).toHaveBeenCalledWith("thread-1", "Native Codex title");
    expect(updateMetadata).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("does not persist a Codex title when the native provider rejects it", async () => {
    const updateMetadata = vi.fn(async () => undefined);
    const routes = createSessionsRoutes({
      supervisor: {} as SessionsDeps["supervisor"],
      sessionMetadataService: {
        getProvider: vi.fn(() => "codex"),
        updateMetadata,
      } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>,
      codexNativeTitleService: {
        rename: vi.fn(async () => {
          throw new Error("app-server rename failed");
        }),
      } as unknown as NonNullable<SessionsDeps["codexNativeTitleService"]>,
    } as SessionsDeps);

    const response = await routes.request("/sessions/thread-1/metadata", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Never persisted locally" }),
    });

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "app-server rename failed",
    });
    expect(updateMetadata).not.toHaveBeenCalled();
  });

  it("verifiably stops an owned process after persisting archive metadata", async () => {
    const order: string[] = [];
    const updateMetadata = vi.fn(async () => {
      order.push("persist-archive");
    });
    const abortSessionWithVerification = vi.fn(async () => {
      order.push("abort-process");
      return null;
    });
    const routes = createSessionsRoutes({
      supervisor: {
        abortSessionWithVerification,
      } as unknown as SessionsDeps["supervisor"],
      sessionMetadataService: {
        updateMetadata,
        getMetadata: vi.fn(() => undefined),
      } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>,
    } as SessionsDeps);

    const response = await routes.request("/sessions/sess-1/metadata", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived: true }),
    });

    expect(response.status).toBe(200);
    expect(order).toEqual(["persist-archive", "abort-process"]);
    expect(abortSessionWithVerification).toHaveBeenCalledWith("sess-1");
  });

  it("redirects stale active-process detail links to the process project", async () => {
    const wrongProject = {
      ...createProject(),
      id: encodeProjectId("/tmp/wrong-project"),
    };
    const rightProject = {
      ...createProject(),
      id: encodeProjectId("/tmp/right-project"),
    };
    const getOrCreateProject = vi.fn(async () => wrongProject);

    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => ({
          projectId: rightProject.id,
        })),
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getOrCreateProject,
      } as unknown as SessionsDeps["scanner"],
    });

    const response = await routes.request(
      `/projects/${wrongProject.id}/sessions/sess-1?tailCompactions=2`,
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      `/api/projects/${rightProject.id}/sessions/sess-1?tailCompactions=2`,
    );
    expect(getOrCreateProject).not.toHaveBeenCalled();
  });

  it("returns queue summaries after accepting a deferred message", async () => {
    const deferMessage = vi.fn(() => ({ success: true, deferred: true }));
    const primeSupportedCommandsForMessage = vi.fn(async () => {});
    const setPermissionMode = vi.fn();
    const waitForPatientQueuePersistenceIdle = vi.fn(async () => {});
    const getDeferredQueueSummary = vi.fn(() => [
      {
        tempId: "temp-queued",
        content: "queued text",
        timestamp: "2026-04-25T00:00:00.000Z",
      },
    ]);

    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => ({
          isTerminated: false,
          setPermissionMode,
          noteInputIntent: vi.fn(),
          primeSupportedCommandsForMessage,
          deferMessage,
          waitForPatientQueuePersistenceIdle,
          getDeferredQueueSummary,
        })),
      } as unknown as SessionsDeps["supervisor"],
    });

    const response = await routes.request("/sessions/sess-1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "queued text",
        tempId: "temp-queued",
        mode: "default",
        deferred: true,
        clientTimestamp: 1770000000123,
        messageMetadata: {
          deliveryIntent: "deferred",
          composition: {
            typingStartedAt: "2026-04-25T00:00:10.000Z",
            typingEndedAt: "2026-04-25T00:00:20.000Z",
            lastEditedAt: "2026-04-25T00:00:19.000Z",
            submittedAt: "2026-04-25T00:00:20.000Z",
          },
        },
      }),
    });

    expect(response.status).toBe(200);
    expect(primeSupportedCommandsForMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "queued text",
        tempId: "temp-queued",
      }),
    );
    expect(deferMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "queued text",
        tempId: "temp-queued",
        mode: "default",
        metadata: expect.objectContaining({
          deliveryIntent: "deferred",
          clientTimestamp: 1770000000123,
          serverReceivedAt: expect.any(String),
          composition: {
            typingStartedAt: "2026-04-25T00:00:10.000Z",
            typingEndedAt: "2026-04-25T00:00:20.000Z",
            lastEditedAt: "2026-04-25T00:00:19.000Z",
            submittedAt: "2026-04-25T00:00:20.000Z",
          },
        }),
      }),
      { promoteIfReady: true, placement: undefined },
    );
    expect(setPermissionMode).toHaveBeenCalledWith("default");
    expect(waitForPatientQueuePersistenceIdle).toHaveBeenCalledTimes(1);
    await expect(response.json()).resolves.toMatchObject({
      queued: true,
      deferred: true,
      deferredMessages: [
        {
          tempId: "temp-queued",
          content: "queued text",
        },
      ],
    });
  });

  it("queues an attachment without accompanying text", async () => {
    const attachment = {
      id: "attachment-only",
      originalName: "trace.txt",
      name: "attachment-only-trace.txt",
      path: "/tmp/attachment-only-trace.txt",
      size: 24,
      mimeType: "text/plain",
    };
    const deferMessage = vi.fn(() => ({ success: true, deferred: true }));
    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => ({
          isTerminated: false,
          noteInputIntent: vi.fn(),
          primeSupportedCommandsForMessage: vi.fn(async () => {}),
          deferMessage,
          waitForPatientQueuePersistenceIdle: vi.fn(async () => {}),
          getDeferredQueueSummary: vi.fn(() => []),
        })),
      } as unknown as SessionsDeps["supervisor"],
    });

    const response = await routes.request("/sessions/sess-1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "",
        attachments: [attachment],
        deferred: true,
      }),
    });

    expect(response.status).toBe(200);
    expect(deferMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: "", attachments: [attachment] }),
      { promoteIfReady: true, placement: undefined },
    );
  });

  it("retains recovered work when a deferred-message response adds live work", async () => {
    await withSessionQueuePersistence(
      async (sessionQueuePersistenceService) => {
        const project = createProject();
        await sessionQueuePersistenceService.replaceAll([
          createPersistedPatientQueueItem(project, {
            id: "queue-recovered",
            queuedAt: "2026-06-30T09:00:00.000Z",
          }),
        ]);
        const process = {
          isTerminated: false,
          setPermissionMode: vi.fn(),
          noteInputIntent: vi.fn(),
          primeSupportedCommandsForMessage: vi.fn(async () => {}),
          deferMessage: vi.fn(() => ({ success: true, deferred: true })),
          waitForPatientQueuePersistenceIdle: vi.fn(async () => {}),
          getDeferredQueueSummary: vi.fn(() => [
            {
              tempId: "temp-live",
              content: "new live work",
              timestamp: "2026-06-30T09:05:00.000Z",
            },
          ]),
        };
        const routes = createSessionsRoutes({
          supervisor: {
            getProcessForSession: vi.fn(() => process),
          } as unknown as SessionsDeps["supervisor"],
          sessionQueuePersistenceService,
        });

        const response = await routes.request("/sessions/sess-1/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: "new live work",
            tempId: "temp-live",
            deferred: true,
          }),
        });

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({
          deferredMessages: [
            {
              id: "queue-recovered",
              status: "paused-after-restart",
            },
            { tempId: "temp-live", content: "new live work" },
          ],
        });
      },
    );
  });

  it("records input intent before deferred slash-command preparation awaits", async () => {
    const noteInputIntent = vi.fn();
    let resolvePrime!: () => void;
    const primeSupportedCommandsForMessage = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolvePrime = resolve;
        }),
    );
    const deferMessage = vi.fn(() => ({ success: true, deferred: true }));
    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => ({
          isTerminated: false,
          noteInputIntent,
          primeSupportedCommandsForMessage,
          deferMessage,
          waitForPatientQueuePersistenceIdle: vi.fn(async () => {}),
          getDeferredQueueSummary: vi.fn(() => []),
        })),
      } as unknown as SessionsDeps["supervisor"],
    });

    const request = routes.request("/sessions/sess-1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "queued text", deferred: true }),
    });

    // Intent must be recorded synchronously, while the prime is still pending,
    // so an in-flight idle-threshold compaction check yields to this turn
    // rather than racing ahead during preparation.
    await vi.waitFor(() => {
      expect(primeSupportedCommandsForMessage).toHaveBeenCalledOnce();
    });
    expect(noteInputIntent).toHaveBeenCalledOnce();
    expect(deferMessage).not.toHaveBeenCalled();

    resolvePrime();
    const response = await request;
    expect(response.status).toBe(200);
    expect(deferMessage).toHaveBeenCalledOnce();
  });

  it("records input intent before provider-native command dispatch awaits", async () => {
    const noteInputIntent = vi.fn();
    let resolveCommand!: (result: { handled: boolean }) => void;
    const runProviderCommand = vi.fn(
      () =>
        new Promise<{ handled: boolean }>((resolve) => {
          resolveCommand = resolve;
        }),
    );
    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => ({
          isTerminated: false,
          noteInputIntent,
          runProviderCommand,
        })),
      } as unknown as SessionsDeps["supervisor"],
    });

    const request = routes.request("/sessions/sess-1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "/compact" }),
    });

    await vi.waitFor(() => {
      expect(runProviderCommand).toHaveBeenCalledWith("compact", "");
    });
    expect(noteInputIntent).toHaveBeenCalledOnce();

    resolveCommand({ handled: true });
    const response = await request;
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ queued: true });
  });

  it("reports immediate promotion when returned by the process", async () => {
    const primeSupportedCommandsForMessage = vi.fn(async () => {});
    const deferMessage = vi.fn(() => ({
      success: true,
      deferred: false,
      promoted: true,
      position: 0,
    }));
    const waitForPatientQueuePersistenceIdle = vi.fn(async () => {});
    const getDeferredQueueSummary = vi.fn(() => []);

    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => ({
          isTerminated: false,
          noteInputIntent: vi.fn(),
          primeSupportedCommandsForMessage,
          deferMessage,
          waitForPatientQueuePersistenceIdle,
          getDeferredQueueSummary,
        })),
      } as unknown as SessionsDeps["supervisor"],
    });

    const response = await routes.request("/sessions/sess-1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "steer this",
        tempId: "temp-steered",
        deferred: true,
      }),
    });

    expect(response.status).toBe(200);
    expect(primeSupportedCommandsForMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "steer this",
        tempId: "temp-steered",
      }),
    );
    expect(deferMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "steer this",
        tempId: "temp-steered",
      }),
      { promoteIfReady: true, placement: undefined },
    );
    expect(waitForPatientQueuePersistenceIdle).toHaveBeenCalledTimes(1);
    await expect(response.json()).resolves.toMatchObject({
      queued: true,
      deferred: false,
      promoted: true,
      position: 0,
      deferredMessages: [],
    });
  });

  it("resolves metadata across providers for mixed-provider projects", async () => {
    const project = createProject();
    const summary = createSummary();
    const claudeReader = {
      getSessionSummary: vi.fn(async () => null),
    } as unknown as ISessionReader;
    const codexReader = {
      getSessionSummary: vi.fn(async () => summary),
    } as unknown as ISessionReader;

    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => null),
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getProject: vi.fn(async () => project),
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: vi.fn(() => claudeReader),
      codexSessionsDir: "/tmp/codex-sessions",
      codexReaderFactory: vi.fn(
        () => codexReader as unknown as CodexSessionReader,
      ),
    });

    const response = await routes.request(
      `/projects/${project.id}/sessions/sess-1/metadata`,
    );
    expect(response.status).toBe(200);

    const json = await response.json();
    expect(json.session).toMatchObject({
      id: "sess-1",
      title: "Codex metadata title",
      provider: "codex",
      model: "gpt-5-codex",
    });
    expect(vi.mocked(claudeReader.getSessionSummary)).toHaveBeenCalledWith(
      "sess-1",
      project.id,
    );
    expect(vi.mocked(codexReader.getSessionSummary)).toHaveBeenCalledWith(
      "sess-1",
      project.id,
    );
  });

  it("attaches provider children to session metadata", async () => {
    const project = createProject();
    const summary = {
      ...createSummary(),
      provider: "claude" as const,
      title: "Parent session",
    };
    const children = [
      {
        id: "child-1",
        parentSessionId: "sess-1",
        title: "Explore the tree",
        updatedAt: "2026-08-16T12:00:00.000Z",
      },
    ];
    const listProviderChildSessions = vi.fn(async () => children);
    const reader = {
      getSessionSummary: vi.fn(async () => summary),
      listProviderChildSessions,
    } as unknown as ISessionReader;

    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => null),
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getProject: vi.fn(async () => project),
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: vi.fn(() => reader),
    });

    const response = await routes.request(
      `/projects/${project.id}/sessions/sess-1/metadata`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      session: {
        id: "sess-1",
        providerChildren: children,
      },
    });
    expect(listProviderChildSessions).toHaveBeenCalledWith("sess-1");
  });

  it("keeps explicit gateway identity over Claude model heuristics", async () => {
    const project = createProject();
    const summary: SessionSummary = {
      ...createSummary(),
      provider: "claude-ollama",
      model: "gpt-5.6-terra",
    };
    const reader = {
      getSessionSummary: vi.fn(async () => summary),
      getSession: vi.fn(async () => ({
        summary,
        data: {
          provider: "claude-ollama",
          session: { messages: [] },
        },
      })),
    } as unknown as ISessionReader;
    const sessionMetadataService = {
      getMetadata: vi.fn(() => ({ provider: "claude-gateway" })),
      getProvider: vi.fn(() => "claude-gateway"),
      getRequestedModel: vi.fn(() => "gpt-5.6-terra"),
      getRecapMessages: vi.fn(() => []),
    } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>;

    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => null),
        wasEverOwned: vi.fn(() => false),
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getProject: vi.fn(async () => project),
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: vi.fn(() => reader),
      sessionMetadataService,
    });

    const metadataResponse = await routes.request(
      `/projects/${project.id}/sessions/sess-1/metadata`,
    );
    expect(metadataResponse.status).toBe(200);
    await expect(metadataResponse.json()).resolves.toMatchObject({
      session: { provider: "claude-gateway", model: "gpt-5.6-terra" },
    });

    const detailResponse = await routes.request(
      `/projects/${project.id}/sessions/sess-1`,
    );
    expect(detailResponse.status).toBe(200);
    await expect(detailResponse.json()).resolves.toMatchObject({
      session: { provider: "claude-gateway", model: "gpt-5.6-terra" },
    });
  });

  it("returns paused recovered patient queue entries in metadata", async () => {
    await withSessionQueuePersistence(
      async (sessionQueuePersistenceService) => {
        const project = createProject();
        const summary = createSummary();
        await sessionQueuePersistenceService.replaceAll([
          {
            id: "queue-1",
            sessionId: "sess-1",
            projectId: project.id,
            projectPath: project.path,
            provider: "claude",
            kind: "patient",
            message: {
              text: "resume after restart",
              tempId: "temp-patient",
              metadata: { deliveryIntent: "patient" },
            },
            createdAt: "2026-06-30T09:00:00.000Z",
            updatedAt: "2026-06-30T09:01:00.000Z",
            queuedAt: "2026-06-30T09:00:00.000Z",
            status: "paused-after-restart",
            source: { tempId: "temp-patient" },
          },
        ]);
        const reader = {
          getSessionSummary: vi.fn(async () => summary),
        } as unknown as ISessionReader;

        const routes = createSessionsRoutes({
          supervisor: {
            getProcessForSession: vi.fn(() => null),
          } as unknown as SessionsDeps["supervisor"],
          scanner: {
            getOrCreateProject: vi.fn(async () => project),
          } as unknown as SessionsDeps["scanner"],
          readerFactory: vi.fn(() => reader),
          sessionQueuePersistenceService,
        });

        const response = await routes.request(
          `/projects/${project.id}/sessions/sess-1/metadata`,
        );
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({
          deferredMessages: [
            {
              id: "queue-1",
              tempId: "temp-patient",
              content: "resume after restart",
              kind: "patient",
              status: "paused-after-restart",
              sessionId: "sess-1",
              projectId: project.id,
              timestamp: "2026-06-30T09:00:00.000Z",
              metadata: { deliveryIntent: "patient" },
            },
          ],
        });
      },
    );
  });

  it("deletes a recovered entry without hiding live queued work", async () => {
    await withSessionQueuePersistence(
      async (sessionQueuePersistenceService) => {
        const project = createProject();
        await sessionQueuePersistenceService.replaceAll([
          {
            id: "queue-1",
            sessionId: "sess-1",
            projectId: project.id,
            projectPath: project.path,
            provider: "claude",
            kind: "patient",
            message: {
              text: "delete me",
              tempId: "temp-patient",
              metadata: { deliveryIntent: "patient" },
            },
            createdAt: "2026-06-30T09:00:00.000Z",
            updatedAt: "2026-06-30T09:01:00.000Z",
            queuedAt: "2026-06-30T09:00:00.000Z",
            status: "paused-after-restart",
          },
        ]);

        const routes = createSessionsRoutes({
          supervisor: {
            getProcessForSession: vi.fn(() => ({
              getDeferredQueueSummary: vi.fn(() => [
                {
                  tempId: "temp-live",
                  content: "keep me",
                  timestamp: "2026-06-30T09:05:00.000Z",
                },
              ]),
            })),
          } as unknown as SessionsDeps["supervisor"],
          scanner: {
            getOrCreateProject: vi.fn(async () => project),
          } as unknown as SessionsDeps["scanner"],
          sessionQueuePersistenceService,
        });

        const response = await routes.request(
          "/sessions/sess-1/recovered-queue/queue-1",
          { method: "DELETE" },
        );
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({
          deleted: true,
          deferredMessages: [
            {
              tempId: "temp-live",
              content: "keep me",
              timestamp: "2026-06-30T09:05:00.000Z",
            },
          ],
        });
        expect(sessionQueuePersistenceService.listSession("sess-1")).toEqual(
          [],
        );
      },
    );
  });

  it("resumes recovered patient queue entries through a non-head entry", async () => {
    await withSessionQueuePersistence(
      async (sessionQueuePersistenceService) => {
        const project = createProject();
        await sessionQueuePersistenceService.replaceAll([
          createPersistedPatientQueueItem(project, {
            id: "queue-1",
            queuedAt: "2026-06-30T09:00:00.000Z",
          }),
          createPersistedPatientQueueItem(project, {
            id: "queue-2",
            queuedAt: "2026-06-30T09:05:00.000Z",
          }),
        ]);

        const deferMessage = vi.fn(() => ({ success: true, deferred: true }));
        const process = {
          id: "proc-1",
          isTerminated: false,
          state: { type: "idle" },
          permissionMode: "default",
          modeVersion: 0,
          recapAfterSeconds: 300,
          setPermissionMode: vi.fn(),
          noteInputIntent: vi.fn(),
          primeSupportedCommandsForMessage: vi.fn(async () => {}),
          deferMessage,
          waitForPatientQueuePersistenceIdle: vi.fn(async () => {}),
          getDeferredQueueSummary: vi.fn(() => []),
        };
        const routes = createSessionsRoutes({
          supervisor: {
            getProcessForSession: vi.fn(() => null),
            reactivateSession: vi.fn(async () => process),
          } as unknown as SessionsDeps["supervisor"],
          sessionQueuePersistenceService,
        });

        const response = await routes.request(
          "/sessions/sess-1/recovered-queue/queue-2/resume",
          { method: "POST" },
        );

        expect(response.status).toBe(200);
        expect(deferMessage).toHaveBeenCalledTimes(2);
        expect(deferMessage).toHaveBeenNthCalledWith(
          1,
          expect.objectContaining({ tempId: "temp-queue-1" }),
          {
            promoteIfReady: true,
            persistedQueueId: "queue-1",
            timestamp: "2026-06-30T09:00:00.000Z",
          },
        );
        expect(deferMessage).toHaveBeenNthCalledWith(
          2,
          expect.objectContaining({ tempId: "temp-queue-2" }),
          {
            promoteIfReady: true,
            persistedQueueId: "queue-2",
            timestamp: "2026-06-30T09:05:00.000Z",
          },
        );
        await expect(response.json()).resolves.toMatchObject({
          resumed: true,
          resumedCount: 2,
          processId: "proc-1",
        });
      },
    );
  });

  it("rejects recovered patient queue resume behind newer live patient work", async () => {
    await withSessionQueuePersistence(
      async (sessionQueuePersistenceService) => {
        const project = createProject();
        await sessionQueuePersistenceService.replaceAll([
          createPersistedPatientQueueItem(project, {
            id: "queue-1",
            queuedAt: "2026-06-30T09:00:00.000Z",
          }),
        ]);
        const getDeferredQueueSummary = vi.fn(() => [
          {
            tempId: "temp-newer",
            content: "newer patient work",
            timestamp: "2026-06-30T10:00:00.000Z",
            metadata: { deliveryIntent: "patient" },
          },
        ]);

        const routes = createSessionsRoutes({
          supervisor: {
            getProcessForSession: vi.fn(() => ({
              isTerminated: false,
              getDeferredQueueSummary,
            })),
          } as unknown as SessionsDeps["supervisor"],
          sessionQueuePersistenceService,
        });

        const response = await routes.request(
          "/sessions/sess-1/recovered-queue/queue-1/resume",
          { method: "POST" },
        );

        expect(response.status).toBe(409);
        await expect(response.json()).resolves.toMatchObject({
          headQueueId: "queue-1",
          deferredMessages: [
            { id: "queue-1", status: "paused-after-restart" },
            { tempId: "temp-newer", content: "newer patient work" },
          ],
        });
        expect(
          sessionQueuePersistenceService.listSession("sess-1")[0],
        ).toMatchObject({
          id: "queue-1",
          status: "paused-after-restart",
        });
      },
    );
  });

  it("resumes recovered patient work past newer regular queued work", async () => {
    await withSessionQueuePersistence(
      async (sessionQueuePersistenceService) => {
        const project = createProject();
        await sessionQueuePersistenceService.replaceAll([
          createPersistedPatientQueueItem(project, {
            id: "queue-1",
            queuedAt: "2026-06-30T09:00:00.000Z",
          }),
        ]);
        const deferMessage = vi.fn(() => ({ success: true, deferred: true }));
        const process = {
          id: "proc-1",
          isTerminated: false,
          state: { type: "in-turn" },
          permissionMode: "default",
          modeVersion: 0,
          recapAfterSeconds: 300,
          setPermissionMode: vi.fn(),
          noteInputIntent: vi.fn(),
          primeSupportedCommandsForMessage: vi.fn(async () => {}),
          deferMessage,
          waitForPatientQueuePersistenceIdle: vi.fn(async () => {}),
          // The regular deferred lane delivers on turn boundaries and may
          // pass patient work by design, so it must not block resume.
          getDeferredQueueSummary: vi.fn(() => [
            {
              tempId: "temp-regular",
              content: "newer regular queued work",
              timestamp: "2026-06-30T10:00:00.000Z",
            },
          ]),
        };

        const routes = createSessionsRoutes({
          supervisor: {
            getProcessForSession: vi.fn(() => process),
          } as unknown as SessionsDeps["supervisor"],
          sessionQueuePersistenceService,
        });

        const response = await routes.request(
          "/sessions/sess-1/recovered-queue/queue-1/resume",
          { method: "POST" },
        );

        expect(response.status).toBe(200);
        expect(deferMessage).toHaveBeenCalledTimes(1);
        await expect(response.json()).resolves.toMatchObject({
          resumed: true,
          resumedCount: 1,
          processState: "in-turn",
        });
      },
    );
  });

  it("steers recovered patient queue entries through the requested entry", async () => {
    await withSessionQueuePersistence(
      async (sessionQueuePersistenceService) => {
        const project = createProject();
        await sessionQueuePersistenceService.replaceAll([
          createPersistedPatientQueueItem(project, {
            id: "queue-1",
            queuedAt: "2026-06-30T09:00:00.000Z",
          }),
          createPersistedPatientQueueItem(project, {
            id: "queue-2",
            queuedAt: "2026-06-30T09:05:00.000Z",
          }),
        ]);

        const deferMessage = vi.fn(() => ({ success: true, deferred: true }));
        const steerPatientDeferredMessagesThrough = vi.fn(() => ({
          success: true,
          steered: 2,
        }));
        const process = {
          id: "proc-1",
          isTerminated: false,
          state: { type: "in-turn" },
          permissionMode: "default",
          modeVersion: 0,
          recapAfterSeconds: 300,
          setPermissionMode: vi.fn(),
          noteInputIntent: vi.fn(),
          primeSupportedCommandsForMessage: vi.fn(async () => {}),
          deferMessage,
          steerPatientDeferredMessagesThrough,
          waitForPatientQueuePersistenceIdle: vi.fn(async () => {}),
          getDeferredQueueSummary: vi.fn(() => []),
        };
        const routes = createSessionsRoutes({
          supervisor: {
            getProcessForSession: vi.fn(() => null),
            reactivateSession: vi.fn(async () => process),
          } as unknown as SessionsDeps["supervisor"],
          sessionQueuePersistenceService,
        });

        const response = await routes.request(
          "/sessions/sess-1/recovered-queue/queue-2/steer",
          { method: "POST" },
        );

        expect(response.status).toBe(200);
        expect(deferMessage).toHaveBeenCalledTimes(2);
        expect(deferMessage).toHaveBeenNthCalledWith(
          1,
          expect.objectContaining({ tempId: "temp-queue-1" }),
          {
            promoteIfReady: false,
            persistedQueueId: "queue-1",
            timestamp: "2026-06-30T09:00:00.000Z",
          },
        );
        expect(steerPatientDeferredMessagesThrough).toHaveBeenCalledWith(
          "temp-queue-2",
        );
        await expect(response.json()).resolves.toMatchObject({
          steered: true,
          count: 2,
          processId: "proc-1",
          processState: "in-turn",
        });
      },
    );
  });

  it("resumes the head recovered patient queue entry into a live process", async () => {
    await withSessionQueuePersistence(
      async (sessionQueuePersistenceService) => {
        const project = createProject();
        const item = createPersistedPatientQueueItem(project, {
          id: "queue-1",
          message: {
            text: "resume me",
            tempId: "temp-recovered",
            metadata: { deliveryIntent: "patient" },
          },
          queuedAt: "2026-06-30T09:00:00.000Z",
          mode: "default",
        });
        await sessionQueuePersistenceService.replaceAll([item]);

        const deferredMessages: {
          tempId?: string;
          content: string;
          timestamp: string;
          metadata?: UserMessage["metadata"];
        }[] = [];
        const persistenceWrites: Promise<unknown>[] = [];
        const deferMessage = vi.fn(
          (
            message: UserMessage,
            options?: {
              persistedQueueId?: string;
              timestamp?: string;
            },
          ) => {
            deferredMessages.push({
              tempId: message.tempId,
              content: message.text,
              timestamp: options?.timestamp ?? "missing-timestamp",
              metadata: message.metadata,
            });
            persistenceWrites.push(
              sessionQueuePersistenceService.upsertItem({
                ...item,
                id: options?.persistedQueueId ?? item.id,
                message,
                updatedAt: options?.timestamp ?? item.updatedAt,
                queuedAt: options?.timestamp ?? item.queuedAt,
                status: "queued",
              }),
            );
            return { success: true, deferred: true };
          },
        );
        const primeSupportedCommandsForMessage = vi.fn(async () => {});
        const waitForPatientQueuePersistenceIdle = vi.fn(async () => {
          await Promise.all(persistenceWrites);
        });
        const getDeferredQueueSummary = vi.fn(() => deferredMessages);
        const process = {
          id: "proc-1",
          isTerminated: false,
          state: { type: "idle" },
          permissionMode: "default",
          modeVersion: 0,
          recapAfterSeconds: 300,
          setPermissionMode: vi.fn(),
          noteInputIntent: vi.fn(),
          primeSupportedCommandsForMessage,
          deferMessage,
          waitForPatientQueuePersistenceIdle,
          getDeferredQueueSummary,
        };
        const reactivateSession = vi.fn(async () => process);

        const routes = createSessionsRoutes({
          supervisor: {
            getProcessForSession: vi.fn(() => null),
            reactivateSession,
          } as unknown as SessionsDeps["supervisor"],
          sessionQueuePersistenceService,
        });

        const response = await routes.request(
          "/sessions/sess-1/recovered-queue/queue-1/resume",
          { method: "POST" },
        );

        expect(response.status).toBe(200);
        expect(reactivateSession).toHaveBeenCalledWith(
          project.path,
          "sess-1",
          "default",
          expect.objectContaining({
            providerName: "claude",
          }),
        );
        expect(primeSupportedCommandsForMessage).toHaveBeenCalledWith(
          expect.objectContaining({
            text: "resume me",
            tempId: "temp-recovered",
            metadata: { deliveryIntent: "patient" },
          }),
        );
        expect(deferMessage).toHaveBeenCalledWith(
          expect.objectContaining({
            text: "resume me",
            tempId: "temp-recovered",
            metadata: { deliveryIntent: "patient" },
          }),
          {
            promoteIfReady: true,
            persistedQueueId: "queue-1",
            timestamp: "2026-06-30T09:00:00.000Z",
          },
        );
        expect(waitForPatientQueuePersistenceIdle).toHaveBeenCalledTimes(1);
        await expect(response.json()).resolves.toMatchObject({
          resumed: true,
          processId: "proc-1",
          deferredMessages: [
            {
              tempId: "temp-recovered",
              content: "resume me",
              timestamp: "2026-06-30T09:00:00.000Z",
            },
          ],
        });
        expect(
          sessionQueuePersistenceService.listSession("sess-1"),
        ).toMatchObject([
          {
            id: "queue-1",
            status: "queued",
            queuedAt: "2026-06-30T09:00:00.000Z",
          },
        ]);
      },
    );
  });

  it("resolves agent content across providers for mixed-provider projects", async () => {
    const project = createProject();
    const summary = createSummary();
    const childMessage: Message = {
      id: "child-message-1",
      role: "assistant",
      content: [{ type: "text", text: "Child transcript" }],
    };
    const claudeReader = {
      getSessionSummary: vi.fn(async () => null),
      getAgentMappings: vi.fn(async () => []),
      getAgentSession: vi.fn(async () => ({
        messages: [],
        status: "pending",
      })),
    } as unknown as ISessionReader;
    const codexReader = {
      getSessionSummary: vi.fn(async () => summary),
      getAgentMappings: vi.fn(async () => [
        { toolUseId: "call-spawn", agentId: "child-thread" },
      ]),
      getAgentSession: vi.fn(async () => ({
        messages: [childMessage],
        status: "completed",
      })),
    } as unknown as ISessionReader;

    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => null),
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: vi.fn(() => claudeReader),
      codexSessionsDir: "/tmp/codex-sessions",
      codexReaderFactory: vi.fn(
        () => codexReader as unknown as CodexSessionReader,
      ),
    });

    const mappingsResponse = await routes.request(
      `/projects/${project.id}/sessions/sess-1/agents`,
    );
    expect(mappingsResponse.status).toBe(200);
    await expect(mappingsResponse.json()).resolves.toEqual({
      mappings: [{ toolUseId: "call-spawn", agentId: "child-thread" }],
    });

    const contentResponse = await routes.request(
      `/projects/${project.id}/sessions/sess-1/agents/child-thread`,
    );
    expect(contentResponse.status).toBe(200);
    await expect(contentResponse.json()).resolves.toMatchObject({
      messages: [childMessage],
      status: "completed",
    });

    expect(vi.mocked(claudeReader.getAgentMappings)).not.toHaveBeenCalled();
    expect(vi.mocked(claudeReader.getAgentSession)).not.toHaveBeenCalled();
    expect(vi.mocked(codexReader.getAgentMappings)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(codexReader.getAgentMappings)).toHaveBeenCalledWith(
      "sess-1",
    );
    expect(vi.mocked(codexReader.getAgentSession)).toHaveBeenCalledWith(
      "child-thread",
      "sess-1",
    );
  });

  it("loads Grok detail by native id after process loss", async () => {
    const project = createProject();
    const grokSummary: SessionSummary = {
      ...createSummary(),
      id: "grok-native-id",
      provider: "grok",
      model: "grok-build",
      title: "Grok title",
      fullTitle: "Grok title",
    };
    const primaryReader = {
      getSession: vi.fn(async () => null),
    } as unknown as ISessionReader;
    const grokReader = {
      getSession: vi.fn(async () => ({
        summary: grokSummary,
        data: {
          provider: "grok",
          session: { messages: [] },
        },
      })),
    } as unknown as GrokSessionReader;

    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => null),
        wasEverOwned: vi.fn(() => true),
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: vi.fn(() => primaryReader),
      grokSessionsDir: "/tmp/grok-sessions",
      grokReaderFactory: vi.fn(() => grokReader),
    });

    const response = await routes.request(
      `/projects/${project.id}/sessions/grok-native-id`,
    );
    expect(response.status).toBe(200);

    const json = await response.json();
    expect(json.session).toMatchObject({
      id: "grok-native-id",
      title: "Grok title",
      provider: "grok",
      model: "grok-build",
    });
    expect(vi.mocked(primaryReader.getSession)).toHaveBeenCalledWith(
      "grok-native-id",
      project.id,
      undefined,
      { includeOrphans: true },
    );
    expect(vi.mocked(grokReader.getSession)).toHaveBeenCalledWith(
      "grok-native-id",
      project.id,
      undefined,
      { includeOrphans: true },
    );
  });

  it("replays Grok updates.jsonl into renderable messages", async () => {
    const fixture = await createGrokRedirectFixture();
    try {
      const bytes = (value: string) => Array.from(Buffer.from(value, "utf-8"));
      const readPath = join(fixture.rightProject.path, "README.md");
      const updates = [
        {
          timestamp: 1779988150,
          method: "session/update",
          params: {
            sessionId: fixture.sessionId,
            update: {
              sessionUpdate: "user_message_chunk",
              content: { type: "text", text: "inspect this" },
            },
          },
        },
        {
          timestamp: 1779988151,
          method: "session/update",
          params: {
            sessionId: fixture.sessionId,
            update: {
              sessionUpdate: "agent_thought_chunk",
              content: { type: "text", text: "checking files" },
            },
          },
        },
        {
          timestamp: 1779988152,
          method: "session/update",
          params: {
            sessionId: fixture.sessionId,
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "call-grep",
              title: "grep",
              rawInput: {
                pattern: "needle",
                path: "src",
                output_mode: "files_with_matches",
                head_limit: 2,
              },
            },
          },
        },
        {
          timestamp: 1779988153,
          method: "session/update",
          params: {
            sessionId: fixture.sessionId,
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: "call-grep",
              status: "completed",
              content: [
                {
                  type: "content",
                  content: { type: "text", text: "found 1 match" },
                },
              ],
              rawOutput: {
                type: "GrepSearch",
                stdout: bytes(
                  `<workspace_result workspace_path="${fixture.rightProject.path}">\nFound 1 files\n${fixture.rightProject.path}/src/file.ts\n</workspace_result>`,
                ),
                stderr: [],
                exit_code: 0,
                match_count: 1,
                file_matches: [],
              },
            },
          },
        },
        {
          timestamp: 1779988154,
          method: "session/update",
          params: {
            sessionId: fixture.sessionId,
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "call-read",
              title: "read_file",
              rawInput: { target_file: "README.md" },
            },
          },
        },
        {
          timestamp: 1779988155,
          method: "session/update",
          params: {
            sessionId: fixture.sessionId,
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: "call-read",
              status: "completed",
              locations: [{ path: "README.md", line: 1 }],
              rawOutput: {
                type: "ReadFile",
                FileContent: {
                  content: "hello\n",
                  absolute_path: readPath,
                  total_lines: 1,
                },
              },
            },
          },
        },
        {
          timestamp: 1779988156,
          method: "session/update",
          params: {
            sessionId: fixture.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "done" },
            },
          },
        },
      ];
      await writeFile(
        join(fixture.sessionDir, "updates.jsonl"),
        `${updates.map((update) => JSON.stringify(update)).join("\n")}\n`,
      );

      const primaryReader = {
        getSession: vi.fn(async () => null),
      } as unknown as ISessionReader;
      const routes = createSessionsRoutes({
        supervisor: {
          getProcessForSession: vi.fn(() => null),
          wasEverOwned: vi.fn(() => true),
        } as unknown as SessionsDeps["supervisor"],
        scanner: {
          getOrCreateProject: vi.fn(async () => fixture.rightProject),
        } as unknown as SessionsDeps["scanner"],
        readerFactory: vi.fn(() => primaryReader),
        grokSessionsDir: fixture.grokSessionsDir,
      });

      const response = await routes.request(
        `/projects/${fixture.rightProjectId}/sessions/${fixture.sessionId}`,
      );
      expect(response.status).toBe(200);

      const json = (await response.json()) as {
        session: { messageCount: number; provider?: string };
        messages: Array<{
          message?: { content?: unknown };
          toolUseResult?: unknown;
          type?: string;
        }>;
      };
      expect(json.session.provider).toBe("grok");
      expect(json.session.messageCount).toBe(7);

      const blocks = json.messages.flatMap((message) => {
        const content = message.message?.content;
        return Array.isArray(content)
          ? (content as Record<string, unknown>[])
          : [];
      });
      const toolUses = blocks.filter((block) => block.type === "tool_use");
      expect(toolUses).toHaveLength(2);
      expect(toolUses[0]).toMatchObject({
        id: "call-grep",
        name: "Grep",
        input: {
          pattern: "needle",
          path: "src",
          output_mode: "files_with_matches",
          rawInput: { pattern: "needle" },
        },
      });
      expect(toolUses[1]).toMatchObject({
        id: "call-read",
        name: "Read",
        input: {
          file_path: "README.md",
          locations: [{ path: "README.md", line: 1 }],
          rawInput: { target_file: "README.md" },
        },
      });

      const resultFor = (toolUseId: string) =>
        json.messages.find((message) => {
          const content = message.message?.content;
          const first = Array.isArray(content)
            ? (content[0] as Record<string, unknown> | undefined)
            : undefined;
          return (
            first?.type === "tool_result" && first.tool_use_id === toolUseId
          );
        })?.toolUseResult;
      expect(resultFor("call-grep")).toMatchObject({
        mode: "files_with_matches",
        filenames: [`${fixture.rightProject.path}/src/file.ts`],
        numFiles: 1,
      });
      expect(resultFor("call-read")).toMatchObject({
        type: "text",
        file: {
          filePath: readPath,
          content: "hello\n",
          totalLines: 1,
        },
      });
    } finally {
      await rm(fixture.tempDir, { recursive: true, force: true });
    }
  });

  it("redirects stale Grok detail links to the native cwd project", async () => {
    const fixture = await createGrokRedirectFixture();
    try {
      const primaryReader = {
        getSession: vi.fn(async () => null),
      } as unknown as ISessionReader;
      const routes = createSessionsRoutes({
        supervisor: {
          getProcessForSession: vi.fn(() => null),
          wasEverOwned: vi.fn(() => false),
        } as unknown as SessionsDeps["supervisor"],
        scanner: {
          getOrCreateProject: vi.fn(async () => fixture.wrongProject),
        } as unknown as SessionsDeps["scanner"],
        readerFactory: vi.fn(() => primaryReader),
        grokSessionsDir: fixture.grokSessionsDir,
      });

      const response = await routes.request(
        `/projects/${fixture.wrongProject.id}/sessions/${fixture.sessionId}?tailCompactions=2`,
      );

      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toContain(
        `/api/projects/${fixture.rightProjectId}/sessions/${fixture.sessionId}?tailCompactions=2`,
      );
    } finally {
      await rm(fixture.tempDir, { recursive: true, force: true });
    }
  });

  it("redirects stale Grok metadata links to the native cwd project", async () => {
    const fixture = await createGrokRedirectFixture();
    try {
      const primaryReader = {
        getSessionSummary: vi.fn(async () => null),
      } as unknown as ISessionReader;
      const routes = createSessionsRoutes({
        supervisor: {
          getProcessForSession: vi.fn(() => null),
        } as unknown as SessionsDeps["supervisor"],
        scanner: {
          getOrCreateProject: vi.fn(async () => fixture.wrongProject),
        } as unknown as SessionsDeps["scanner"],
        readerFactory: vi.fn(() => primaryReader),
        grokSessionsDir: fixture.grokSessionsDir,
      });

      const response = await routes.request(
        `/projects/${fixture.wrongProject.id}/sessions/${fixture.sessionId}/metadata`,
      );

      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toContain(
        `/api/projects/${fixture.rightProjectId}/sessions/${fixture.sessionId}/metadata`,
      );
    } finally {
      await rm(fixture.tempDir, { recursive: true, force: true });
    }
  });

  it("reclassifies when the previous working project has vanished", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ya-reclassify-"));
    const workingProjectPath = join(tempDir, "working-project");
    await mkdir(workingProjectPath, { recursive: true });
    await writeFile(join(workingProjectPath, "README.md"), "# Working\n");

    const transcriptProject: Project = {
      ...createProject(),
      path: join(tempDir, "transcript-project"),
      sessionDir: join(tempDir, "transcript-project", ".claude-sessions"),
    };
    const workingProject: Project = {
      ...createProject(),
      id: "proj-2" as UrlProjectId,
      path: workingProjectPath,
      name: "working-project",
      sessionDir: join(workingProjectPath, ".claude-sessions"),
    };
    const vanishedWorkingProjectId = encodeProjectId(
      join(tempDir, "vanished-working-project"),
    );
    let metadata: {
      workingProjectId?: UrlProjectId;
      transcriptProjectId?: UrlProjectId;
    } = {
      workingProjectId: vanishedWorkingProjectId,
      transcriptProjectId: transcriptProject.id,
    };
    const setWorkingProject = vi.fn(
      async (
        _sessionId: string,
        workingProjectId: UrlProjectId | undefined,
        transcriptProjectId: UrlProjectId | undefined,
      ) => {
        metadata = { workingProjectId, transcriptProjectId };
      },
    );
    const emit = vi.fn();
    const sessionProjectChanged = vi.fn();
    const reader = {
      getSessionSummary: vi.fn(async (_sessionId: string, projectId) =>
        projectId === transcriptProject.id ? createSummary() : null,
      ),
      getSession: vi.fn(async (_sessionId: string, projectId) =>
        projectId === transcriptProject.id
          ? createLoadedGrokSession({}, [
              {
                uuid: "assistant-1",
                type: "assistant",
                timestamp: "2026-03-10T09:46:00.000Z",
                message: {
                  role: "assistant",
                  content: [
                    {
                      type: "text",
                      text: "See `README.md`.",
                    },
                  ],
                },
              },
            ])
          : null,
      ),
    } as unknown as ISessionReader;

    try {
      const routes = createSessionsRoutes({
        supervisor: {
          getProcessForSession: vi.fn(() => null),
          wasEverOwned: vi.fn(() => false),
        } as unknown as SessionsDeps["supervisor"],
        scanner: {
          getOrCreateProject: vi.fn(async (projectId: UrlProjectId) =>
            projectId === workingProject.id
              ? workingProject
              : projectId === transcriptProject.id
                ? transcriptProject
                : null,
          ),
        } as unknown as SessionsDeps["scanner"],
        readerFactory: vi.fn(() => reader),
        eventBus: {
          emit,
        } as unknown as NonNullable<SessionsDeps["eventBus"]>,
        projectQueueScheduler: {
          reserveUserSessionStart: vi.fn(),
          sessionProjectChanged,
        },
        sessionMetadataService: {
          getMetadata: vi.fn(() => metadata),
          getProvider: vi.fn(() => "grok"),
          getRecapMessages: vi.fn(() => []),
          setWorkingProject,
        } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>,
      });

      const moveResponse = await routes.request(
        `/projects/${transcriptProject.id}/sessions/sess-1/project`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectId: workingProject.id }),
        },
      );
      expect(moveResponse.status).toBe(200);
      expect(await moveResponse.json()).toMatchObject({
        updated: true,
        projectId: workingProject.id,
        transcriptProjectId: transcriptProject.id,
      });
      expect(setWorkingProject).toHaveBeenCalledWith(
        "sess-1",
        workingProject.id,
        transcriptProject.id,
      );
      expect(sessionProjectChanged).toHaveBeenCalledWith(
        vanishedWorkingProjectId,
        workingProject.id,
      );
      expect(emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "session-metadata-changed",
          sessionId: "sess-1",
          projectId: workingProject.id,
          transcriptProjectId: transcriptProject.id,
        }),
      );

      const staleResponse = await routes.request(
        `/projects/${transcriptProject.id}/sessions/sess-1`,
      );
      expect(staleResponse.status).toBe(307);
      expect(staleResponse.headers.get("location")).toBe(
        `/api/projects/${workingProject.id}/sessions/sess-1`,
      );

      const detailResponse = await routes.request(
        `/projects/${workingProject.id}/sessions/sess-1`,
      );
      expect(detailResponse.status).toBe(200);
      const detail = await detailResponse.json();
      expect(detail.session).toMatchObject({
        id: "sess-1",
        projectId: workingProject.id,
        workingProjectId: workingProject.id,
        transcriptProjectId: transcriptProject.id,
      });
      expect(reader.getSessionSummary).toHaveBeenCalledWith(
        "sess-1",
        transcriptProject.id,
      );
      expect(reader.getSession).toHaveBeenCalledWith(
        "sess-1",
        transcriptProject.id,
        undefined,
        { includeOrphans: false },
      );
      expect(detail.messages[0].message.content[0]._html as string).toContain(
        `data-ya-project-id="${workingProject.id}"`,
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("reclassifies from Codex native cwd instead of live launch cwd", async () => {
    const launchProjectPath = "/tmp/launch-project";
    const transcriptProjectPath = "/tmp/transcript-project";
    const targetProjectPath = "/tmp/target-project";
    const launchProject = {
      ...createProject(),
      id: encodeProjectId(launchProjectPath),
      path: launchProjectPath,
    };
    const transcriptProject = {
      ...createProject(),
      id: encodeProjectId(transcriptProjectPath),
      path: transcriptProjectPath,
      provider: "codex" as ProviderName,
    };
    const targetProject = {
      ...createProject(),
      id: encodeProjectId(targetProjectPath),
      path: targetProjectPath,
    };
    const setWorkingProject = vi.fn(async () => undefined);
    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => ({
          projectId: launchProject.id,
          projectPath: launchProject.path,
          provider: "codex",
        })),
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getOrCreateProject: vi.fn(
          async (projectId: UrlProjectId) =>
            [launchProject, transcriptProject, targetProject].find(
              (project) => project.id === projectId,
            ) ?? null,
        ),
      } as unknown as SessionsDeps["scanner"],
      codexScanner: {
        getSessionProjectPath: vi.fn(async () => transcriptProjectPath),
      },
      readerFactory: vi.fn(
        () =>
          ({ getSessionSummary: vi.fn(async () => null) }) as ISessionReader,
      ),
      sessionMetadataService: {
        getMetadata: vi.fn(() => ({ provider: "codex" as ProviderName })),
        setWorkingProject,
      } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>,
    });

    const response = await routes.request(
      `/projects/${launchProject.id}/sessions/sess-1/project`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: targetProject.id }),
      },
    );

    expect(response.status).toBe(200);
    expect(setWorkingProject).toHaveBeenCalledWith(
      "sess-1",
      targetProject.id,
      transcriptProject.id,
    );
    await expect(response.json()).resolves.toMatchObject({
      projectId: targetProject.id,
      transcriptProjectId: transcriptProject.id,
    });
  });

  it("isolates public and private Markdown projections in either order", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ya-detached-augment-"));
    const project: Project = {
      ...createProject(),
      path: tempDir,
      provider: "grok",
      sessionDir: join(tempDir, ".grok-sessions"),
    };
    await writeFile(join(tempDir, "README.md"), "# Project\n");
    const sourceMessage: Message = {
      uuid: "assistant-1",
      type: "assistant",
      timestamp: "2026-03-10T09:46:00.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "See `README.md`." }],
      },
    };
    const loaded = createLoadedGrokSession({}, [sourceMessage]);
    const reader = {
      getSession: vi.fn(async () => loaded),
    } as unknown as ISessionReader;
    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => null),
        wasEverOwned: vi.fn(() => false),
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: vi.fn(() => reader),
    });

    try {
      const firstPublicResponse = await routes.request(
        `/projects/${project.id}/sessions/sess-1?publicShare=1`,
      );
      const firstPublicBody = await firstPublicResponse.json();
      expect(
        firstPublicBody.messages[0].message.content[0]._html,
      ).toBeUndefined();

      const privateResponse = await routes.request(
        `/projects/${project.id}/sessions/sess-1`,
      );
      const privateBody = await privateResponse.json();
      expect(privateBody.messages[0].message.content[0]._html).toContain(
        `data-ya-project-id="${project.id}"`,
      );

      const secondPublicResponse = await routes.request(
        `/projects/${project.id}/sessions/sess-1?publicShare=1`,
      );
      const secondPublicBody = await secondPublicResponse.json();
      expect(
        secondPublicBody.messages[0].message.content[0]._html,
      ).toBeUndefined();
      expect(
        (
          sourceMessage.message?.content as
            | Array<Record<string, unknown>>
            | undefined
        )?.[0]?._html,
      ).toBeUndefined();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("isolates concurrent augmentation for two working-project contexts", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ya-augment-contexts-"));
    const firstPath = join(tempDir, "first");
    const secondPath = join(tempDir, "second");
    await Promise.all([
      mkdir(firstPath, { recursive: true }),
      mkdir(secondPath, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(firstPath, "README.md"), "# First\n"),
      writeFile(join(secondPath, "README.md"), "# Second\n"),
    ]);
    const firstProject: Project = {
      ...createProject(),
      id: "proj-first" as UrlProjectId,
      path: firstPath,
      provider: "grok",
      sessionDir: join(firstPath, ".grok-sessions"),
    };
    const secondProject: Project = {
      ...createProject(),
      id: "proj-second" as UrlProjectId,
      path: secondPath,
      provider: "grok",
      sessionDir: join(secondPath, ".grok-sessions"),
    };
    const sourceMessage: Message = {
      uuid: "assistant-1",
      type: "assistant",
      timestamp: "2026-03-10T09:46:00.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "See `README.md`." }],
      },
    };
    const loaded = createLoadedGrokSession({}, [sourceMessage]);
    const reader = {
      getSession: vi.fn(async () => loaded),
    } as unknown as ISessionReader;
    const projects = new Map([
      [firstProject.id, firstProject],
      [secondProject.id, secondProject],
    ]);
    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => null),
        wasEverOwned: vi.fn(() => false),
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getOrCreateProject: vi.fn(async (projectId: UrlProjectId) =>
          projects.get(projectId),
        ),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: vi.fn(() => reader),
    });

    try {
      const [firstResponse, secondResponse] = await Promise.all([
        routes.request(`/projects/${firstProject.id}/sessions/sess-1`),
        routes.request(`/projects/${secondProject.id}/sessions/sess-1`),
      ]);
      const [firstBody, secondBody] = await Promise.all([
        firstResponse.json(),
        secondResponse.json(),
      ]);
      const firstHtml = firstBody.messages[0].message.content[0]
        ._html as string;
      const secondHtml = secondBody.messages[0].message.content[0]
        ._html as string;
      expect(firstHtml).toContain(`data-ya-project-id="${firstProject.id}"`);
      expect(firstHtml).not.toContain(
        `data-ya-project-id="${secondProject.id}"`,
      );
      expect(secondHtml).toContain(`data-ya-project-id="${secondProject.id}"`);
      expect(secondHtml).not.toContain(
        `data-ya-project-id="${firstProject.id}"`,
      );
      expect(
        (
          sourceMessage.message?.content as
            | Array<Record<string, unknown>>
            | undefined
        )?.[0]?._html,
      ).toBeUndefined();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("augments detached process history before a session file exists", async () => {
    const project = createProject();
    const history = [
      {
        type: "assistant",
        uuid: "assistant-1",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "First **block**." },
            { type: "text", text: "Second `block`." },
          ],
        },
      },
    ];

    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => ({
          id: "proc-1",
          permissionMode: "default",
          appliedPermissionMode: "default",
          modeVersion: 0,
          recapAfterSeconds: undefined,
          startedAt: new Date("2026-03-10T09:46:00.000Z"),
          state: { type: "idle", since: new Date("2026-03-10T09:47:00.000Z") },
          provider: "claude",
          resolvedModel: "claude-sonnet-4-6",
          supportsDynamicCommands: false,
          contextWindow: undefined,
          getMessageHistory: vi.fn(() => history),
          getDeferredQueueSummary: vi.fn(() => []),
          getProviderRuntimeStatus: vi.fn(() => null),
        })),
        wasEverOwned: vi.fn(() => true),
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: vi.fn(
        () =>
          ({
            getSession: vi.fn(async () => null),
          }) as unknown as ISessionReader,
      ),
      sessionMetadataService: {
        getMetadata: vi.fn(() => undefined),
        getProvider: vi.fn(() => "claude"),
        getRecapMessages: vi.fn(() => []),
      } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>,
    });

    const response = await routes.request(
      `/projects/${project.id}/sessions/sess-1`,
    );
    expect(response.status).toBe(200);

    const json = await response.json();
    expect(json.messages[0].message.content).toMatchObject([
      {
        text: "First **block**.",
        _html: expect.stringContaining("<strong>block</strong>"),
      },
      {
        text: "Second `block`.",
        _html: expect.stringContaining("<code>block</code>"),
      },
    ]);
    expect(history[0]?.message.content).toEqual([
      { type: "text", text: "First **block**." },
      { type: "text", text: "Second `block`." },
    ]);
  });

  it("keeps persisted provider when metadata refresh misses the session summary", async () => {
    const project = createProject();

    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => ({
          id: "proc-1",
          permissionMode: "default",
          modeVersion: 0,
          state: { type: "idle", since: new Date("2026-03-10T09:47:00.000Z") },
          provider: "claude",
          supportsDynamicCommands: false,
          getDeferredQueueSummary: vi.fn(() => []),
          getProviderRuntimeStatus: vi.fn(() => null),
        })),
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getProject: vi.fn(async () => project),
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: vi.fn(
        () =>
          ({
            getSessionSummary: vi.fn(async () => null),
          }) as unknown as ISessionReader,
      ),
      sessionMetadataService: {
        getMetadata: vi.fn(() => undefined),
        getProvider: vi.fn(() => "codex"),
        getRequestedModel: vi.fn(() => undefined),
        setRequestedModel: vi.fn(async () => undefined),
      } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>,
    });

    const response = await routes.request(
      `/projects/${project.id}/sessions/sess-1/metadata`,
    );
    expect(response.status).toBe(200);

    const json = await response.json();
    expect(json.session.provider).toBe("codex");
    expect(json.ownership).toEqual({
      owner: "self",
      processId: "proc-1",
      permissionMode: "default",
      modeVersion: 0,
    });
    expect(json.ownership).not.toHaveProperty("state");
    expect(json.processState).toBe("idle");
  });

  it("keeps metadata viewable when dynamic command discovery disconnects", async () => {
    const project = { ...createProject(), provider: "codex" as const };
    const supportedCommands = vi.fn(async () => {
      throw new Error("Provider worker is disconnected");
    });
    const warn = vi
      .spyOn(getLogger(), "warn")
      .mockImplementation(() => undefined);

    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => ({
          id: "proc-1",
          sessionId: "sess-1",
          permissionMode: "default",
          modeVersion: 0,
          state: { type: "idle", since: new Date("2026-03-10T09:47:00.000Z") },
          provider: "codex",
          supportsDynamicCommands: true,
          supportedCommands,
          getDeferredQueueSummary: vi.fn(() => []),
          getProviderRuntimeStatus: vi.fn(() => null),
        })),
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: vi.fn(
        () =>
          ({
            getSessionSummary: vi.fn(async () => createSummary()),
          }) as unknown as ISessionReader,
      ),
      sessionMetadataService: {
        getMetadata: vi.fn(() => undefined),
        getProvider: vi.fn(() => "codex"),
      } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>,
    });

    const response = await routes.request(
      `/projects/${project.id}/sessions/sess-1/metadata`,
    );

    expect(response.status).toBe(200);
    expect(supportedCommands).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "session_dynamic_commands_unavailable",
        sessionId: "sess-1",
        processId: "proc-1",
        provider: "codex",
        error: "Provider worker is disconnected",
      }),
      "Falling back to static commands for session read",
    );
    const json = await response.json();
    expect(json.session.provider).toBe("codex");
    expect(json.slashCommands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "compact" }),
        expect.objectContaining({ name: "status" }),
      ]),
    );
  });

  it("returns static Codex slash commands for stopped sessions", async () => {
    const project = { ...createProject(), provider: "codex" as const };

    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => null),
        wasEverOwned: vi.fn(() => false),
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: vi.fn(
        () =>
          ({
            getSession: vi.fn(async () => createLoadedCodexSession()),
          }) as unknown as ISessionReader,
      ),
      sessionMetadataService: {
        getMetadata: vi.fn(() => undefined),
        getProvider: vi.fn(() => "codex"),
        getRequestedModel: vi.fn(() => undefined),
        setRequestedModel: vi.fn(async () => undefined),
      } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>,
    });

    const response = await routes.request(
      `/projects/${project.id}/sessions/sess-1`,
    );
    expect(response.status).toBe(200);

    const json = await response.json();
    expect(json.ownership).toEqual({ owner: "none" });
    expect(json.slashCommands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "compact" }),
        expect.objectContaining({ name: "goal" }),
        expect.objectContaining({ name: "status" }),
        expect.objectContaining({ name: "usage" }),
      ]),
    );
  });

  it("computes detail unread from pre-overlay updatedAt so a recap never flips unread", async () => {
    const project = { ...createProject(), provider: "grok" as const };
    const recap: DurableRecapMessage = {
      type: "system",
      subtype: "away_summary",
      content: "Fresh recap.",
      timestamp: "2026-03-10T09:50:00.000Z",
      uuid: "recap-1",
      id: "recap-1",
      yaRecapSource: "ya-synthetic",
    };
    // Session fully seen (09:49) after the last provider write (09:46);
    // the recap (09:50) bumps display freshness but must not mark unread.
    const lastSeenAt = "2026-03-10T09:49:00.000Z";
    const hasUnread = vi.fn(
      (_sessionId: string, updatedAt: string) => updatedAt > lastSeenAt,
    );

    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => null),
        wasEverOwned: vi.fn(() => false),
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: vi.fn(
        () =>
          ({
            getSession: vi.fn(async () =>
              createLoadedGrokSession({
                updatedAt: "2026-03-10T09:46:00.000Z",
                messageCount: 1,
              }),
            ),
          }) as unknown as ISessionReader,
      ),
      notificationService: {
        getLastSeen: vi.fn(() => ({
          sessionId: "sess-1",
          timestamp: lastSeenAt,
        })),
        hasUnread,
      } as unknown as NonNullable<SessionsDeps["notificationService"]>,
      sessionMetadataService: {
        getMetadata: vi.fn(() => undefined),
        getProvider: vi.fn(() => "grok"),
        getRecapMessages: vi.fn(() => [recap]),
      } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>,
    });

    const response = await routes.request(
      `/projects/${project.id}/sessions/sess-1`,
    );
    expect(response.status).toBe(200);

    const json = await response.json();
    expect(hasUnread).toHaveBeenCalledWith(
      "sess-1",
      "2026-03-10T09:46:00.000Z",
    );
    expect(json.session).toMatchObject({
      updatedAt: recap.timestamp,
      hasUnread: false,
    });
  });

  it("handles durable recap ids as overlay cursors", async () => {
    const project = { ...createProject(), provider: "grok" as const };
    const recap: DurableRecapMessage = {
      type: "system",
      subtype: "away_summary",
      content: "Fresh recap.",
      timestamp: "2026-03-10T09:50:00.000Z",
      uuid: "recap-1",
      id: "recap-1",
      yaRecapSource: "ya-synthetic",
    };
    const getSession = vi.fn(async () =>
      createLoadedGrokSession({
        updatedAt: "2026-03-10T09:46:00.000Z",
        messageCount: 1,
      }),
    );

    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => null),
        wasEverOwned: vi.fn(() => false),
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: vi.fn(
        () =>
          ({
            getSession,
          }) as unknown as ISessionReader,
      ),
      sessionMetadataService: {
        getMetadata: vi.fn(() => undefined),
        getProvider: vi.fn(() => "grok"),
        getRecapMessages: vi.fn(() => [recap]),
      } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>,
    });

    const response = await routes.request(
      `/projects/${project.id}/sessions/sess-1?afterMessageId=recap-1`,
    );
    expect(response.status).toBe(200);

    expect(getSession).toHaveBeenCalledWith("sess-1", project.id, undefined, {
      includeOrphans: false,
    });
    const json = await response.json();
    expect(json.messages).toEqual([]);
  });

  it("prefers an explicit resume provider over persisted metadata", async () => {
    const project = createProject();
    const resumeSession = vi.fn(async () => ({
      id: "proc-1",
      sessionId: "sess-1",
      permissionMode: "default",
      modeVersion: 0,
    }));

    const routes = createSessionsRoutes({
      supervisor: {
        resumeSession,
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: vi.fn(
        () =>
          ({
            getSessionSummary: vi.fn(async () => null),
            getSession: vi.fn(async () => null),
            getSessionFilePath: vi.fn(
              async () => "/home/user/.claude/projects/enc/sess-1.jsonl",
            ),
          }) as unknown as ISessionReader,
      ),
      sessionMetadataService: {
        getProvider: vi.fn(() => "codex"),
        getRequestedModel: vi.fn(() => undefined),
        setRequestedModel: vi.fn(async () => undefined),
        getExecutor: vi.fn(() => undefined),
      } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>,
      serverSettingsService: {
        getSetting: vi.fn((key: string) =>
          key === "claudeAutoCompactPercentOverride" ? 60 : undefined,
        ),
      } as unknown as NonNullable<SessionsDeps["serverSettingsService"]>,
    });

    const response = await routes.request(
      `/projects/${project.id}/sessions/sess-1/resume`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "continue",
          provider: "claude",
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(resumeSession).toHaveBeenCalledWith(
      "sess-1",
      project.path,
      expect.objectContaining({ text: "continue" }),
      undefined,
      expect.objectContaining({ providerName: "claude" }),
      { requireProviderSessionId: true },
    );
  });

  it("returns attachment rejection before claiming resume started", async () => {
    const warn = vi
      .spyOn(getLogger(), "warn")
      .mockImplementation(() => undefined);
    const project = createProject();
    const resumeSession = vi.fn(async () => {
      throw new RetryableSessionLaunchError(
        new Error("native session is missing"),
      );
    });
    const routes = createSessionsRoutes({
      supervisor: {
        resumeSession,
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: vi.fn(
        () =>
          ({
            getSessionSummary: vi.fn(async () => null),
            getSessionFilePath: vi.fn(
              async () => "/home/user/.codex/sessions/sess-1.jsonl",
            ),
          }) as unknown as ISessionReader,
      ),
      sessionMetadataService: {
        getProvider: vi.fn(() => "codex"),
        getRequestedModel: vi.fn(() => undefined),
        setRequestedModel: vi.fn(async () => undefined),
        getExecutor: vi.fn(() => undefined),
      } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>,
    });

    const response = await routes.request(
      `/projects/${project.id}/sessions/sess-1/resume`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "continue" }),
      },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error:
        "Provider session startup did not settle: native session is missing",
    });
    expect(resumeSession).toHaveBeenCalledWith(
      "sess-1",
      project.path,
      expect.objectContaining({ text: "continue" }),
      undefined,
      expect.objectContaining({ providerName: "codex" }),
      { requireProviderSessionId: true },
    );
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "provider_resume_attachment_failed",
        sessionId: "sess-1",
        projectId: project.id,
        providerName: "codex",
      }),
      "Provider resume failed before native session attachment",
    );
  });

  it("resumes from the Codex transcript cwd instead of the request project", async () => {
    const requestProjectPath = "/tmp/stale-project";
    const transcriptProjectPath = "/tmp/native-project";
    const requestProject = {
      ...createProject(),
      id: encodeProjectId(requestProjectPath),
      path: requestProjectPath,
    };
    const transcriptProject = {
      ...createProject(),
      id: encodeProjectId(transcriptProjectPath),
      path: transcriptProjectPath,
      provider: "codex" as ProviderName,
    };
    const resumeSession = vi.fn(async () => ({
      id: "proc-1",
      sessionId: "sess-1",
      permissionMode: "default",
      modeVersion: 0,
    }));
    const routes = createSessionsRoutes({
      supervisor: { resumeSession } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getOrCreateProject: vi.fn(async (projectId: UrlProjectId) =>
          projectId === requestProject.id
            ? requestProject
            : projectId === transcriptProject.id
              ? transcriptProject
              : null,
        ),
      } as unknown as SessionsDeps["scanner"],
      codexScanner: {
        getSessionProjectPath: vi.fn(async () => transcriptProjectPath),
      },
      readerFactory: vi.fn(
        () =>
          ({ getSessionSummary: vi.fn(async () => null) }) as ISessionReader,
      ),
      sessionMetadataService: {
        getMetadata: vi.fn(() => ({ provider: "codex" as ProviderName })),
        getProvider: vi.fn(() => "codex"),
        getRequestedModel: vi.fn(() => undefined),
        getExecutor: vi.fn(() => undefined),
      } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>,
    });

    const response = await routes.request(
      `/projects/${requestProject.id}/sessions/sess-1/resume`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "continue" }),
      },
    );

    expect(response.status).toBe(200);
    expect(resumeSession).toHaveBeenCalledWith(
      "sess-1",
      transcriptProjectPath,
      expect.objectContaining({ text: "continue" }),
      undefined,
      expect.objectContaining({ providerName: "codex" }),
      { requireProviderSessionId: true },
    );
  });

  it("normal-resumes a safe no-owner Claude transcript after restart", async () => {
    const project = createProject();
    const resumeSession = vi.fn(async () => ({
      id: "proc-1",
      sessionId: "sess-1",
      permissionMode: "default",
      modeVersion: 0,
    }));

    const routes = createSessionsRoutes({
      supervisor: {
        resumeSession,
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: vi.fn(
        () =>
          ({
            getSession: vi.fn(async () => ({
              summary: {
                ...createSummary(),
                provider: "claude",
                model: "claude-sonnet-4-5-20250929",
                ownership: { owner: "none" },
              },
              data: {
                provider: "claude",
                session: {
                  messages: [
                    {
                      type: "assistant",
                      isSidechain: false,
                      userType: "external",
                      cwd: project.path,
                      sessionId: "sess-1",
                      version: "1.0.0",
                      uuid: "11111111-1111-4111-8111-111111111111",
                      timestamp: "2026-05-31T00:00:00.000Z",
                      parentUuid: null,
                      message: {
                        id: "c7bff7ca-1111-4111-8111-111111111111",
                        type: "message",
                        role: "assistant",
                        model: "claude-sonnet-4-5-20250929",
                        content: [
                          {
                            type: "text",
                            text: "Ready to continue.",
                          },
                        ],
                        stop_reason: "end_turn",
                        stop_sequence: null,
                        usage: {
                          input_tokens: 1,
                          output_tokens: 2,
                        },
                      },
                    },
                  ],
                },
              },
            })),
            getSessionSummary: vi.fn(async () => null),
          }) as unknown as ISessionReader,
      ),
      sessionMetadataService: {
        getProvider: vi.fn(() => "claude"),
        getRequestedModel: vi.fn(() => undefined),
        setRequestedModel: vi.fn(async () => undefined),
        getExecutor: vi.fn(() => undefined),
      } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>,
    });

    const response = await routes.request(
      `/projects/${project.id}/sessions/sess-1/resume`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "continue",
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(resumeSession).toHaveBeenCalledWith(
      "sess-1",
      project.path,
      expect.objectContaining({ text: "continue" }),
      undefined,
      expect.objectContaining({ providerName: "claude" }),
      { requireProviderSessionId: true },
    );
  });

  it("blocks Claude resume when the latest assistant is an SDK API error", async () => {
    const warn = vi
      .spyOn(getLogger(), "warn")
      .mockImplementation(() => undefined);
    const project = createProject();
    const resumeSession = vi.fn(async () => ({
      id: "proc-1",
      sessionId: "sess-1",
      permissionMode: "default",
      modeVersion: 0,
    }));

    const routes = createSessionsRoutes({
      supervisor: {
        resumeSession,
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: vi.fn(
        () =>
          ({
            getSession: vi.fn(async () => ({
              summary: {
                ...createSummary(),
                provider: "claude",
                model: "claude-sonnet-4-5-20250929",
              },
              data: {
                provider: "claude",
                session: {
                  messages: [
                    {
                      type: "assistant",
                      isSidechain: false,
                      userType: "external",
                      cwd: project.path,
                      sessionId: "sess-1",
                      version: "1.0.0",
                      uuid: "11111111-1111-4111-8111-111111111111",
                      timestamp: "2026-05-31T00:00:00.000Z",
                      parentUuid: null,
                      isApiErrorMessage: true,
                      apiErrorStatus: 400,
                      message: {
                        id: "c7bff7ca-1111-4111-8111-111111111111",
                        type: "message",
                        role: "assistant",
                        model: "<synthetic>",
                        content: [
                          {
                            type: "text",
                            text: "API Error: 400 diagnostics.previous_message_id",
                          },
                        ],
                        stop_reason: null,
                        stop_sequence: null,
                        usage: {
                          input_tokens: 0,
                          output_tokens: 0,
                        },
                      },
                    },
                  ],
                },
              },
            })),
            getSessionSummary: vi.fn(async () => null),
          }) as unknown as ISessionReader,
      ),
      sessionMetadataService: {
        getProvider: vi.fn(() => "claude"),
        getRequestedModel: vi.fn(() => undefined),
        setRequestedModel: vi.fn(async () => undefined),
        getExecutor: vi.fn(() => undefined),
      } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>,
    });

    const response = await routes.request(
      `/projects/${project.id}/sessions/sess-1/resume`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "continue",
        }),
      },
    );

    expect(response.status).toBe(409);
    expect(resumeSession).not.toHaveBeenCalled();
    const json = await response.json();
    expect(json.recovery).toBe("handoff-required");
    expect(json.error).toContain("Start a handoff session");
    expect(warn).toHaveBeenCalledWith(
      {
        event: "claude_resume_blocked_after_api_error",
        sessionId: "sess-1",
        projectId: project.id,
        providerName: "claude",
        messageId: "c7bff7ca-1111-4111-8111-111111111111",
        apiErrorStatus: 400,
      },
      "Blocked Claude provider resume after SDK API-error message",
    );
  });

  it("resumes before the API-error tail when a good assistant message exists", async () => {
    const project = createProject();
    const goodUuid = "22222222-2222-4222-8222-222222222222";
    const resumeSession = vi.fn(async () => ({
      id: "proc-1",
      sessionId: "sess-1",
      permissionMode: "default",
      modeVersion: 0,
    }));

    const makeAssistant = (params: {
      uuid: string;
      parentUuid: string | null;
      isApiErrorMessage?: boolean;
      text: string;
    }) => ({
      type: "assistant",
      isSidechain: false,
      userType: "external",
      cwd: project.path,
      sessionId: "sess-1",
      version: "1.0.0",
      uuid: params.uuid,
      timestamp: "2026-05-31T00:00:00.000Z",
      parentUuid: params.parentUuid,
      ...(params.isApiErrorMessage
        ? { isApiErrorMessage: true, apiErrorStatus: 400 }
        : {}),
      message: {
        id: `c7bff7ca-${params.uuid.slice(9)}`,
        type: "message",
        role: "assistant",
        model: params.isApiErrorMessage ? "<synthetic>" : "claude-sonnet-4-5",
        content: [{ type: "text", text: params.text }],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });

    const routes = createSessionsRoutes({
      supervisor: {
        resumeSession,
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: vi.fn(
        () =>
          ({
            getSession: vi.fn(async () => ({
              summary: {
                ...createSummary(),
                provider: "claude",
                model: "claude-sonnet-4-5-20250929",
              },
              data: {
                provider: "claude",
                session: {
                  messages: [
                    makeAssistant({
                      uuid: goodUuid,
                      parentUuid: null,
                      text: "All done.",
                    }),
                    makeAssistant({
                      uuid: "11111111-1111-4111-8111-111111111111",
                      parentUuid: goodUuid,
                      isApiErrorMessage: true,
                      text: "API Error: 400 diagnostics.previous_message_id",
                    }),
                  ],
                },
              },
            })),
            getSessionSummary: vi.fn(async () => null),
          }) as unknown as ISessionReader,
      ),
      sessionMetadataService: {
        getProvider: vi.fn(() => "claude"),
        getRequestedModel: vi.fn(() => undefined),
        setRequestedModel: vi.fn(async () => undefined),
        getExecutor: vi.fn(() => undefined),
      } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>,
    });

    const response = await routes.request(
      `/projects/${project.id}/sessions/sess-1/resume`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "continue",
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(resumeSession).toHaveBeenCalledWith(
      "sess-1",
      project.path,
      expect.objectContaining({ text: "continue" }),
      undefined,
      expect.objectContaining({
        providerName: "claude",
        resumeSessionAt: goodUuid,
      }),
      { requireProviderSessionId: true },
    );
  });

  it("returns full-resume recovery when compact-first resume fails", async () => {
    const warn = vi
      .spyOn(getLogger(), "warn")
      .mockImplementation(() => undefined);
    const project = createProject();
    const resumeSession = vi.fn(async () => {
      throw new ResumeCompactionError({
        sessionId: "sess-1",
        provider: "claude",
        attempt: {
          status: "unavailable",
          reason: "no compact/compress slash command advertised",
        },
      });
    });

    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => undefined),
        resumeSession,
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: vi.fn(
        () =>
          ({
            getSession: vi.fn(async () => null),
            getSessionSummary: vi.fn(async () => null),
          }) as unknown as ISessionReader,
      ),
      sessionMetadataService: {
        getProvider: vi.fn(() => "claude"),
        getRequestedModel: vi.fn(() => undefined),
        setRequestedModel: vi.fn(async () => undefined),
        getExecutor: vi.fn(() => undefined),
      } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>,
    });

    const response = await routes.request(
      `/projects/${project.id}/sessions/sess-1/resume`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "continue",
          resumeMode: "compact-first",
        }),
      },
    );

    expect(response.status).toBe(409);
    expect(resumeSession).toHaveBeenCalledWith(
      "sess-1",
      project.path,
      expect.objectContaining({ text: "continue" }),
      undefined,
      expect.objectContaining({
        providerName: "claude",
        resumeMode: "compact-first",
      }),
      { requireProviderSessionId: true },
    );
    const json = await response.json();
    expect(json.recovery).toBe("full-resume");
    expect(json.resume).toMatchObject({
      requestedMode: "compact-first",
      provider: "claude",
      compaction: {
        status: "unavailable",
        reason: "no compact/compress slash command advertised",
      },
    });
    expect(warn).toHaveBeenCalledWith(
      {
        event: "resume_compaction_failed",
        sessionId: "sess-1",
        projectId: project.id,
        providerName: "claude",
        attempt: {
          status: "unavailable",
          reason: "no compact/compress slash command advertised",
        },
      },
      "Compact-first resume failed",
    );
  });

  it("preserves persisted provider and model when queueing a restartable message", async () => {
    const project = createProject();
    const queueMessageToSession = vi.fn(async () => ({
      success: true as const,
      restarted: true,
      process: { id: "proc-2" },
    }));

    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => ({
          projectPath: project.path,
          isTerminated: false,
          provider: "claude",
          model: "gpt-5.4",
          resolvedModel: "gpt-5.4",
          executor: undefined,
          noteInputIntent: vi.fn(),
        })),
        queueMessageToSession,
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: vi.fn(
        () =>
          ({
            getSessionSummary: vi.fn(async () => null),
            getSessionFilePath: vi.fn(
              async () => "/home/user/.claude/projects/enc/sess-1.jsonl",
            ),
          }) as unknown as ISessionReader,
      ),
      sessionMetadataService: {
        getProvider: vi.fn(() => "codex"),
        getRequestedModel: vi.fn(() => undefined),
        setRequestedModel: vi.fn(async () => undefined),
        getExecutor: vi.fn(() => undefined),
      } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>,
    });

    const response = await routes.request("/sessions/sess-1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "continue",
        serviceTier: "priority",
        thinking: "max",
      }),
    });

    expect(response.status).toBe(200);
    expect(queueMessageToSession).toHaveBeenCalledWith(
      "sess-1",
      project.path,
      expect.objectContaining({ text: "continue" }),
      undefined,
      expect.objectContaining({
        model: "gpt-5.4",
        serviceTier: "priority",
        providerName: "codex",
        claudeAutoCompactPercentOverride: undefined,
      }),
    );
  });

  it("passes the global Claude compaction override to queued launches", async () => {
    const project = createProject();
    const queueMessageToSession = vi.fn(async () => ({
      success: true as const,
      restarted: false,
      process: { id: "proc-1" },
    }));

    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => ({
          projectPath: project.path,
          isTerminated: false,
          provider: "claude",
          model: "sonnet",
          resolvedModel: "claude-sonnet-4-6",
          executor: undefined,
          noteInputIntent: vi.fn(),
        })),
        queueMessageToSession,
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: vi.fn(
        () =>
          ({
            getSessionSummary: vi.fn(async () => null),
          }) as unknown as ISessionReader,
      ),
      sessionMetadataService: {
        getProvider: vi.fn(() => "claude"),
        getRequestedModel: vi.fn(() => "sonnet"),
        setRequestedModel: vi.fn(async () => undefined),
        getExecutor: vi.fn(() => undefined),
      } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>,
      serverSettingsService: {
        getSetting: vi.fn((key: string) =>
          key === "claudeAutoCompactPercentOverride" ? 60 : undefined,
        ),
      } as unknown as NonNullable<SessionsDeps["serverSettingsService"]>,
    });

    const response = await routes.request("/sessions/sess-1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "continue" }),
    });

    expect(response.status).toBe(200);
    expect(queueMessageToSession).toHaveBeenCalledWith(
      "sess-1",
      project.path,
      expect.objectContaining({ text: "continue" }),
      undefined,
      expect.objectContaining({
        providerName: "claude",
        claudeAutoCompactPercentOverride: 60,
      }),
    );
  });

  it.each([
    { label: "absent", body: undefined },
    { label: "whitespace-only", body: " \n\t " },
  ])("accepts an $label restart body as defaults", async ({ body }) => {
    const project = createProject();
    const getOrCreateProject = vi.fn(async () => null);
    const routes = createSessionsRoutes({
      supervisor: {} as SessionsDeps["supervisor"],
      scanner: { getOrCreateProject } as unknown as SessionsDeps["scanner"],
    });

    const response = await routes.request(
      `/projects/${project.id}/sessions/sess-1/restart`,
      {
        method: "POST",
        ...(body === undefined
          ? {}
          : {
              headers: { "Content-Type": "application/json" },
              body,
            }),
      },
    );

    expect(response.status).toBe(404);
    expect(getOrCreateProject).toHaveBeenCalledWith(project.id);
  });

  it.each([
    { label: "malformed JSON", body: "{" },
    { label: "array", body: "[]" },
    { label: "null", body: "null" },
    { label: "string", body: '"restart"' },
    { label: "number", body: "42" },
    { label: "boolean", body: "true" },
  ])(
    "rejects a $label restart body before any side effect",
    async ({ body }) => {
      const project = createProject();
      const getOrCreateProject = vi.fn(async () => project);
      const queueMessage = vi.fn(() => ({ success: true, position: 1 }));
      const interruptProcess = vi.fn(async () => ({
        success: true,
        supported: true,
      }));
      const abortProcess = vi.fn(async () => true);
      const startSession = vi.fn(async () => ({
        id: "proc-new",
        sessionId: "sess-new",
        projectId: project.id,
        provider: "claude",
        model: "sonnet",
        permissionMode: "default",
        modeVersion: 0,
        subscribe: vi.fn(() => vi.fn()),
      }));
      const updateMetadata = vi.fn(async () => undefined);
      const setProvider = vi.fn(async () => undefined);
      const setRequestedModel = vi.fn(async () => undefined);
      const setSessionSandbox = vi.fn(async () => undefined);
      const emit = vi.fn();
      const getProcessForSession = vi.fn(() => ({
        id: "proc-old",
        provider: "claude",
        model: "sonnet",
        permissionMode: "default",
        modeVersion: 0,
        state: { type: "idle", since: new Date() },
        supportsDynamicCommands: true,
        supportedCommands: vi.fn(async () => [
          { name: "compact", description: "Compact conversation" },
        ]),
        subscribe: vi.fn(
          (listener: (event: { type: string; message: unknown }) => void) => {
            queueMicrotask(() =>
              listener({
                type: "message",
                message: {
                  type: "system",
                  subtype: "compact_boundary",
                  message: { content: "summary" },
                },
              }),
            );
            return vi.fn();
          },
        ),
        queueMessage,
        getMessageHistory: vi.fn(() => []),
        getDeferredQueueSummary: vi.fn(() => []),
      }));
      const routes = createSessionsRoutes({
        supervisor: {
          getProcessForSession,
          interruptProcess,
          abortProcess,
          startSession,
        } as unknown as SessionsDeps["supervisor"],
        scanner: { getOrCreateProject } as unknown as SessionsDeps["scanner"],
        readerFactory: vi.fn(
          () =>
            ({
              getSessionSummary: vi.fn(async () => null),
            }) as unknown as ISessionReader,
        ),
        sessionMetadataService: {
          getProvider: vi.fn(() => "claude"),
          getRequestedModel: vi.fn(() => undefined),
          getExecutor: vi.fn(() => undefined),
          getMetadata: vi.fn(() => undefined),
          updateMetadata,
          setProvider,
          setRequestedModel,
          setSessionSandbox,
        } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>,
        eventBus: { emit } as unknown as SessionsDeps["eventBus"],
      });

      const response = await routes.request(
        `/projects/${project.id}/sessions/sess-1/restart`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        },
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "Invalid JSON body",
      });
      expect(getOrCreateProject).not.toHaveBeenCalled();
      expect(getProcessForSession).not.toHaveBeenCalled();
      expect(queueMessage).not.toHaveBeenCalled();
      expect(interruptProcess).not.toHaveBeenCalled();
      expect(abortProcess).not.toHaveBeenCalled();
      expect(startSession).not.toHaveBeenCalled();
      expect(updateMetadata).not.toHaveBeenCalled();
      expect(setProvider).not.toHaveBeenCalled();
      expect(setRequestedModel).not.toHaveBeenCalled();
      expect(setSessionSandbox).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();
    },
  );

  it("starts a fresh handoff session before aborting the old process", async () => {
    const project = createProject();
    let replacementListener:
      | ((event: { type: string; message?: unknown }) => void)
      | undefined;
    const startSession = vi.fn(async () => ({
      id: "proc-new",
      sessionId: "sess-new",
      projectId: project.id,
      provider: "codex",
      model: "gpt-5.4",
      resolvedModel: "gpt-5.4",
      permissionMode: "default",
      modeVersion: 0,
      subscribe: vi.fn((listener) => {
        replacementListener = listener;
        return vi.fn();
      }),
    }));
    const abortProcess = vi.fn(async () => true);
    const interruptProcess = vi.fn(async () => ({
      success: true,
      supported: true,
    }));
    const updateMetadata = vi.fn(async () => undefined);
    const emit = vi.fn();

    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => ({
          id: "proc-old",
          provider: "codex",
          model: "gpt-5.5",
          resolvedModel: "gpt-5.5",
          permissionMode: "default",
          modeVersion: 0,
          state: { type: "idle", since: new Date() },
          getMessageHistory: vi.fn(() => [
            {
              type: "user",
              uuid: "u1",
              timestamp: "2026-04-24T20:00:00.000Z",
              message: { role: "user", content: "please continue the bugfix" },
            },
          ]),
        })),
        startSession,
        interruptProcess,
        abortProcess,
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: vi.fn(
        () =>
          ({
            getSessionSummary: vi.fn(async () => null),
            getSessionFilePath: vi.fn(
              async () => "/home/user/.claude/projects/enc/sess-1.jsonl",
            ),
          }) as unknown as ISessionReader,
      ),
      sessionMetadataService: {
        getProvider: vi.fn(() => "codex"),
        getRequestedModel: vi.fn(() => undefined),
        setRequestedModel: vi.fn(async () => undefined),
        getExecutor: vi.fn(() => undefined),
        getMetadata: vi.fn(() => ({
          customTitle: "Broken Codex session",
          effectiveLaunchSettings: {
            schemaVersion: 1,
            revision: 3,
            permissionMode: "plan",
            requestedModel: "gpt-5.5",
            serviceTier: "priority",
            thinking: { type: "adaptive" },
            effort: "high",
          },
        })),
        setProvider: vi.fn(async () => undefined),
        updateMetadata,
      } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>,
      eventBus: { emit } as unknown as SessionsDeps["eventBus"],
    });

    const response = await routes.request(
      `/projects/${project.id}/sessions/sess-1/restart`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "codex",
          model: "gpt-5.4",
          reason: "test restart",
        }),
      },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      sessionId: "sess-new",
      processId: "proc-new",
      title: "Handoff: Broken Codex session",
      restartedFrom: "sess-1",
      oldProcessId: "proc-old",
      oldProcessInterrupted: true,
      oldProcessAbortDeferred: true,
      oldProcessAborted: false,
    });
    expect(interruptProcess).toHaveBeenCalledWith("proc-old");
    expect(startSession).toHaveBeenCalledWith(
      project.path,
      expect.objectContaining({
        text: expect.stringContaining("# Handoff: Broken Codex session"),
      }),
      "plan",
      expect.objectContaining({
        model: "gpt-5.4",
        requestedModel: "gpt-5.4",
        serviceTier: "priority",
        thinking: { type: "adaptive" },
        effort: "high",
        providerName: "codex",
      }),
    );
    const handoffText = startSession.mock.calls[0]?.[1].text;
    expect(handoffText).toContain("please continue the bugfix");
    expect(updateMetadata).toHaveBeenCalledWith("sess-new", {
      title: "Handoff: Broken Codex session",
    });
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "session-metadata-changed",
        sessionId: "sess-new",
        title: "Handoff: Broken Codex session",
      }),
    );
    expect(interruptProcess.mock.invocationCallOrder[0]).toBeLessThan(
      startSession.mock.invocationCallOrder[0] ?? 0,
    );
    expect(abortProcess).not.toHaveBeenCalled();

    replacementListener?.({
      type: "message",
      message: { type: "assistant", message: { content: "working" } },
    });
    await Promise.resolve();
    expect(abortProcess).toHaveBeenCalledWith("proc-old");
  });

  it("does not allow a handoff restart to weaken the source sandbox", async () => {
    const project = createProject();
    const startSession = vi.fn();
    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => undefined),
        startSession,
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: vi.fn(
        () =>
          ({
            getSessionSummary: vi.fn(async () => null),
          }) as unknown as ISessionReader,
      ),
      sessionMetadataService: {
        getMetadata: vi.fn(() => ({
          sandboxLevel: "project-write",
          sandboxStateKey: "project-sandbox",
          sandboxProjectPath: project.path,
        })),
        getExecutor: vi.fn(() => undefined),
      } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>,
    });

    const response = await routes.request(
      `/projects/${project.id}/sessions/sess-1/restart`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          restartMode: "handoff",
          sandboxLevel: "none",
        }),
      },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error:
        "A restarted session inherits the source sandbox boundary and cannot change it",
    });
    expect(startSession).not.toHaveBeenCalled();
  });

  it("preserves a firewall opt-out when restartMode is fork", async () => {
    const project = createProject();
    const forkSession = vi.fn(async () => ({
      sessionId: "sess-fork",
      sandboxStateKey: "project-sandbox",
    }));
    const startSession = vi.fn();
    const resumeSession = vi.fn(async () => ({
      id: "proc-new",
      sessionId: "sess-fork",
      projectId: project.id,
      provider: "claude",
      model: "sonnet",
      resolvedModel: "sonnet",
      permissionMode: "default",
      modeVersion: 0,
      sandboxStateKey: "project-sandbox",
      subscribe: vi.fn(() => vi.fn()),
    }));
    const interruptProcess = vi.fn(async () => ({
      success: true,
      supported: true,
    }));
    const abortProcess = vi.fn(async () => true);
    const updateMetadata = vi.fn(async () => undefined);
    const setSessionSandbox = vi.fn(async () => undefined);
    const emit = vi.fn();

    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => ({
          id: "proc-old",
          provider: "claude",
          model: "sonnet",
          resolvedModel: "sonnet",
          permissionMode: "default",
          modeVersion: 0,
          state: { type: "idle", since: new Date() },
          getMessageHistory: vi.fn(() => [
            {
              type: "user",
              uuid: "u1",
              timestamp: "2026-04-24T20:00:00.000Z",
              message: { role: "user", content: "long-running refactor" },
            },
          ]),
        })),
        supportsForkSession: vi.fn(() => true),
        forkSession,
        startSession,
        resumeSession,
        interruptProcess,
        abortProcess,
      } as unknown as SessionsDeps["supervisor"],
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
      sessionMetadataService: {
        getProvider: vi.fn(() => "claude"),
        getRequestedModel: vi.fn(() => undefined),
        setRequestedModel: vi.fn(async () => undefined),
        getExecutor: vi.fn(() => undefined),
        getMetadata: vi.fn(() => ({
          customTitle: "Refactor session",
          sandboxLevel: "project-write",
          sandboxNetworkFirewall: false,
          sandboxStateKey: "project-sandbox",
          sandboxProjectPath: project.path,
          effectiveLaunchSettings: {
            schemaVersion: 1,
            revision: 2,
            permissionMode: "bypassPermissions",
            requestedModel: "sonnet",
            serviceTier: "priority",
            thinking: { type: "adaptive" },
            effort: "high",
          },
        })),
        setProvider: vi.fn(async () => undefined),
        setSessionSandbox,
        updateMetadata,
      } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>,
      eventBus: { emit } as unknown as SessionsDeps["eventBus"],
    });

    const invalidReasonResponse = await routes.request(
      `/projects/${project.id}/sessions/sess-1/restart`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ restartMode: "fork", reason: 42 }),
      },
    );
    expect(invalidReasonResponse.status).toBe(400);
    expect(interruptProcess).not.toHaveBeenCalled();
    expect(forkSession).not.toHaveBeenCalled();

    const response = await routes.request(
      `/projects/${project.id}/sessions/sess-1/restart`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          restartMode: "fork",
          forkUpToMessageId: "msg-uuid-7",
        }),
      },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      sessionId: "sess-fork",
      processId: "proc-new",
      title: "Fork: Refactor session",
      restartedFrom: "sess-1",
      forkUpToMessageId: "msg-uuid-7",
      oldProcessId: "proc-old",
    });
    expect(forkSession).toHaveBeenCalledWith({
      sessionId: "sess-1",
      projectPath: project.path,
      providerName: "claude",
      upToMessageId: "msg-uuid-7",
      title: "Fork: Refactor session",
      sandboxLevel: "project-write",
      sandboxNetworkFirewall: false,
      sandboxStateKey: "project-sandbox",
    });
    expect(startSession).not.toHaveBeenCalled();
    expect(resumeSession).toHaveBeenCalledWith(
      "sess-fork",
      project.path,
      expect.objectContaining({ text: "Continue from this fork point." }),
      "bypassPermissions",
      expect.objectContaining({
        model: "sonnet",
        requestedModel: "sonnet",
        serviceTier: "priority",
        thinking: { type: "adaptive" },
        effort: "high",
        providerName: "claude",
        sandboxLevel: "project-write",
        sandboxNetworkFirewall: false,
        sandboxStateKey: "project-sandbox",
      }),
    );
    expect(setSessionSandbox).toHaveBeenCalledWith("sess-fork", {
      level: "project-write",
      networkFirewall: false,
      stateKey: "project-sandbox",
      projectPath: project.path,
      projectId: project.id,
    });
    expect(updateMetadata).toHaveBeenCalledWith("sess-fork", {
      title: "Fork: Refactor session",
    });
  });

  it("forks a transcript without starting a process via the fork endpoint", async () => {
    const project = createProject();
    const forkSession = vi.fn(async () => ({
      sessionId: "sess-fork",
      sandboxStateKey: "project-sandbox",
    }));
    const resumeSession = vi.fn();
    const startSession = vi.fn();
    const setProvider = vi.fn(async () => undefined);
    const setSessionSandbox = vi.fn(async () => undefined);
    const updateMetadata = vi.fn(async () => undefined);
    const emit = vi.fn();

    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => undefined),
        supportsForkSession: vi.fn(() => true),
        forkSession,
        resumeSession,
        startSession,
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: vi.fn(
        () =>
          ({
            getSessionSummary: vi.fn(async () => null),
          }) as unknown as ISessionReader,
      ),
      sessionMetadataService: {
        getProvider: vi.fn(() => "claude"),
        getRequestedModel: vi.fn(() => undefined),
        setRequestedModel: vi.fn(async () => undefined),
        getExecutor: vi.fn(() => undefined),
        getMetadata: vi.fn(() => ({
          customTitle: "Refactor session",
          sandboxLevel: "project-write",
          sandboxStateKey: "project-sandbox",
          sandboxProjectPath: project.path,
        })),
        setProvider,
        setSessionSandbox,
        updateMetadata,
      } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>,
      eventBus: { emit } as unknown as SessionsDeps["eventBus"],
    });

    const response = await routes.request(
      `/projects/${project.id}/sessions/sess-1/fork`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ upToMessageId: "msg-uuid-3" }),
      },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      sessionId: "sess-fork",
      provider: "claude",
      title: "Fork: Refactor session",
      forkedFrom: "sess-1",
      upToMessageId: "msg-uuid-3",
    });
    expect(forkSession).toHaveBeenCalledWith({
      sessionId: "sess-1",
      projectPath: project.path,
      providerName: "claude",
      upToMessageId: "msg-uuid-3",
      boundary: undefined,
      title: "Fork: Refactor session",
      sandboxLevel: "project-write",
      sandboxNetworkFirewall: true,
      sandboxStateKey: "project-sandbox",
    });
    // Fork-only: no process is started or resumed, no message sent.
    expect(resumeSession).not.toHaveBeenCalled();
    expect(startSession).not.toHaveBeenCalled();
    expect(setProvider).toHaveBeenCalledWith("sess-fork", "claude");
    expect(setSessionSandbox).toHaveBeenCalledWith("sess-fork", {
      level: "project-write",
      networkFirewall: true,
      stateKey: "project-sandbox",
      projectPath: project.path,
      projectId: project.id,
    });
    expect(updateMetadata).toHaveBeenCalledWith("sess-fork", {
      title: "Fork: Refactor session",
      forkedFromSessionId: "sess-1",
    });
  });

  it("clones the latest completed transcript cold with Clone lineage", async () => {
    const project = createProject();
    const forkSession = vi.fn(async () => ({ sessionId: "sess-clone" }));
    const resumeSession = vi.fn();
    const updateMetadata = vi.fn(async () => undefined);
    const setRequestedModel = vi.fn(async () => undefined);
    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => ({
          provider: "claude",
          requestedModel: "default",
          resolvedModel: "gpt-5.6-sol",
          state: { type: "idle", since: new Date() },
          getMessageHistory: vi.fn(() => []),
        })),
        supportsForkSession: vi.fn(() => true),
        forkSession,
        resumeSession,
      } as unknown as SessionsDeps["supervisor"],
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
      sessionMetadataService: {
        getProvider: vi.fn(() => "claude"),
        setProvider: vi.fn(async () => undefined),
        setRequestedModel,
        getExecutor: vi.fn(() => undefined),
        getRequestedModel: vi.fn(() => "default"),
        getMetadata: vi.fn(() => ({ customTitle: "Short session" })),
        updateMetadata,
      } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>,
    });

    const response = await routes.request(
      `/projects/${project.id}/sessions/sess-1/fork`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ forkKind: "clone-latest-complete" }),
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      sessionId: "sess-clone",
      title: "Clone: Short session",
      forkKind: "clone-latest-complete",
      forkedFrom: "sess-1",
    });
    expect(forkSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sess-1",
        providerName: "claude",
        title: "Clone: Short session",
      }),
    );
    expect(forkSession.mock.calls[0]?.[0]).toMatchObject({
      boundary: undefined,
      upToMessageId: undefined,
    });
    expect(updateMetadata).toHaveBeenCalledWith("sess-clone", {
      title: "Clone: Short session",
      forkedFromSessionId: "sess-1",
    });
    expect(setRequestedModel).toHaveBeenCalledWith("sess-clone", "gpt-5.6-sol");
    expect(resumeSession).not.toHaveBeenCalled();
  });

  it("rejects explicit Clone while the current response is active", async () => {
    const project = createProject();
    const forkSession = vi.fn();
    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => ({
          provider: "claude",
          state: { type: "in-turn", since: new Date() },
        })),
        supportsForkSession: vi.fn(() => true),
        forkSession,
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: vi.fn(
        () =>
          ({
            getSessionSummary: vi.fn(async () => null),
          }) as unknown as ISessionReader,
      ),
      sessionMetadataService: {
        getProvider: vi.fn(() => "claude"),
        setProvider: vi.fn(async () => undefined),
        getRequestedModel: vi.fn(() => undefined),
        getMetadata: vi.fn(() => ({})),
      } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>,
    });

    const response = await routes.request(
      `/projects/${project.id}/sessions/sess-1/fork`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ forkKind: "clone-latest-complete" }),
      },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("source is unchanged"),
    });
    expect(forkSession).not.toHaveBeenCalled();
  });

  it("resolves before and after intents across tool-result user rows", async () => {
    const project = createProject();
    const messages: Message[] = [
      {
        type: "user",
        uuid: "user-1",
        parentUuid: null,
        message: { role: "user", content: "First request" },
      },
      {
        type: "assistant",
        uuid: "tool-call-1",
        parentUuid: "user-1",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "tool-1", name: "Read", input: {} },
          ],
        },
      },
      {
        type: "user",
        uuid: "tool-result-1",
        parentUuid: "tool-call-1",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tool-1", content: "ok" },
          ],
        },
      },
      {
        type: "assistant",
        uuid: "assistant-1-final",
        parentUuid: "tool-result-1",
        message: { role: "assistant", content: "First response" },
      },
      {
        type: "user",
        uuid: "user-2",
        parentUuid: "assistant-1-final",
        message: { role: "user", content: "Second request" },
      },
      {
        type: "assistant",
        uuid: "assistant-2-final",
        parentUuid: "user-2",
        message: { role: "assistant", content: "Second response" },
      },
    ];
    const forkSession = vi
      .fn()
      .mockResolvedValueOnce({ sessionId: "sess-after" })
      .mockResolvedValueOnce({ sessionId: "sess-before" });
    const summary: SessionSummary = {
      ...createSummary(),
      provider: "claude",
      model: "sonnet",
    };
    const durableReader = {
      getSessionSummary: vi.fn(async () => summary),
      getSession: vi.fn(async () => ({
        summary,
        data: { provider: "claude", session: { messages } },
      })),
    } as unknown as ISessionReader;
    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => ({
          provider: "claude",
          state: { type: "idle", since: new Date() },
          getMessageHistory: vi.fn(() => [
            {
              type: "user",
              uuid: "sdk-history-user-1",
              message: { role: "user", content: "First request" },
            },
          ]),
        })),
        supportsForkSession: vi.fn(() => true),
        forkSession,
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: vi.fn(() => durableReader),
      sessionMetadataService: {
        getProvider: vi.fn(() => "claude"),
        setProvider: vi.fn(async () => undefined),
        setRequestedModel: vi.fn(async () => undefined),
        getExecutor: vi.fn(() => undefined),
        getRequestedModel: vi.fn(() => undefined),
        getMetadata: vi.fn(() => ({ customTitle: "Tool turn" })),
        updateMetadata: vi.fn(async () => undefined),
      } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>,
    });

    for (const request of [
      { forkKind: "after-user-turn", sourceMessageId: "user-1" },
      { forkKind: "before-user-turn", sourceMessageId: "user-2" },
    ]) {
      const response = await routes.request(
        `/projects/${project.id}/sessions/sess-1/fork`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request),
        },
      );
      expect(response.status).toBe(200);
    }

    for (const call of forkSession.mock.calls) {
      expect(call[0]).toMatchObject({
        boundary: {
          kind: "message",
          provider: "claude",
          messageId: "assistant-1-final",
        },
      });
    }
    expect(durableReader.getSession).toHaveBeenCalledTimes(2);
  });

  it("maps a positional Codex display id to its persisted provider turn", async () => {
    const project = createProject();
    const summary = createSummary();
    const timestamp = "2026-08-01T07:38:02.999Z";
    const loaded: LoadedSession = {
      summary,
      data: {
        provider: "codex",
        session: {
          entries: [
            {
              timestamp,
              type: "response_item",
              payload: {
                type: "message",
                role: "user",
                content: [{ type: "input_text", text: "Use a tool" }],
                internal_chat_message_metadata_passthrough: {
                  turn_id: "turn-provider-1",
                },
              },
            },
            {
              timestamp: "2026-08-01T07:38:03.000Z",
              type: "response_item",
              payload: {
                type: "function_call",
                name: "read_file",
                arguments: "{}",
                call_id: "call-provider-1",
                internal_chat_message_metadata_passthrough: {
                  turn_id: "turn-provider-1",
                },
              },
            },
            {
              timestamp: "2026-08-01T07:38:03.100Z",
              type: "response_item",
              payload: {
                type: "function_call_output",
                call_id: "call-provider-1",
                output: "file contents",
                internal_chat_message_metadata_passthrough: {
                  turn_id: "turn-provider-1",
                },
              },
            },
            {
              timestamp: "2026-08-01T07:38:04.000Z",
              type: "response_item",
              payload: {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "Tool turn done" }],
                internal_chat_message_metadata_passthrough: {
                  turn_id: "turn-provider-1",
                },
              },
            },
            {
              timestamp: "2026-08-01T07:39:00.000Z",
              type: "response_item",
              payload: {
                type: "message",
                role: "user",
                content: [{ type: "input_text", text: "Next turn" }],
                internal_chat_message_metadata_passthrough: {
                  turn_id: "turn-provider-2",
                },
              },
            },
          ],
        },
      },
    };
    const codexReader = {
      getSessionSummary: vi.fn(async () => summary),
      getSession: vi.fn(async () => loaded),
    } as unknown as CodexSessionReader;
    const forkSession = vi.fn(async () => ({ sessionId: "codex-fork" }));
    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => undefined),
        supportsForkSession: vi.fn(() => true),
        forkSession,
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: vi.fn(
        () =>
          ({
            getSessionSummary: vi.fn(async () => null),
          }) as unknown as ISessionReader,
      ),
      codexSessionsDir: "/tmp/codex-sessions",
      codexReaderFactory: vi.fn(() => codexReader),
      sessionMetadataService: {
        getProvider: vi.fn(() => "codex"),
        setProvider: vi.fn(async () => undefined),
        setRequestedModel: vi.fn(async () => undefined),
        getExecutor: vi.fn(() => undefined),
        getRequestedModel: vi.fn(() => undefined),
        getMetadata: vi.fn(() => ({ customTitle: "Codex tools" })),
        updateMetadata: vi.fn(async () => undefined),
      } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>,
    });

    const response = await routes.request(
      `/projects/${project.id}/sessions/sess-1/fork`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          forkKind: "after-user-turn",
          sourceMessageId: `codex-0-${timestamp}`,
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(forkSession).toHaveBeenCalledWith(
      expect.objectContaining({
        providerName: "codex",
        boundary: {
          kind: "turn",
          provider: "codex",
          turnId: "turn-provider-1",
        },
      }),
    );
    expect(forkSession.mock.calls[0]?.[0].upToMessageId).toBeUndefined();
  });

  it("rejects impossible or mixed turn-intent request shapes", async () => {
    const project = createProject();
    const forkSession = vi.fn();
    const messages: Message[] = [
      {
        type: "user",
        uuid: "user-1",
        parentUuid: null,
        message: { role: "user", content: "Only request" },
      },
      {
        type: "assistant",
        uuid: "assistant-1",
        parentUuid: "user-1",
        message: { role: "assistant", content: "Only response" },
      },
    ];
    const summary: SessionSummary = {
      ...createSummary(),
      provider: "claude",
      model: "sonnet",
    };
    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => ({
          provider: "claude",
          state: { type: "idle", since: new Date() },
          getMessageHistory: vi.fn(() => []),
        })),
        supportsForkSession: vi.fn(() => true),
        forkSession,
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: vi.fn(
        () =>
          ({
            getSessionSummary: vi.fn(async () => summary),
            getSession: vi.fn(async () => ({
              summary,
              data: { provider: "claude", session: { messages } },
            })),
          }) as unknown as ISessionReader,
      ),
      sessionMetadataService: {
        getProvider: vi.fn(() => "claude"),
        getMetadata: vi.fn(() => ({})),
      } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>,
    });

    const mixed = await routes.request(
      `/projects/${project.id}/sessions/sess-1/fork`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          forkKind: "after-user-turn",
          sourceMessageId: "user-1",
          upToMessageId: "assistant-1",
        }),
      },
    );
    expect(mixed.status).toBe(400);

    const beforeFirst = await routes.request(
      `/projects/${project.id}/sessions/sess-1/fork`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          forkKind: "before-user-turn",
          sourceMessageId: "user-1",
        }),
      },
    );
    expect(beforeFirst.status).toBe(409);
    expect(forkSession).not.toHaveBeenCalled();
  });

  it("generates a retitle proposal without updating source metadata", async () => {
    const project = createProject();
    const forkSession = vi.fn(async () => ({
      sessionId: "sess-retitle-generator",
    }));
    const generateSummary = vi.fn(async () => ({
      text: 'Title: "Tight rename flow."',
    }));
    const updateMetadata = vi.fn();
    const setProvider = vi.fn();
    const setRequestedModel = vi.fn();

    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => ({
          id: "proc-source",
          provider: "claude",
          model: "sonnet",
        })),
        supportsForkSession: vi.fn(() => true),
        forkSession,
        generateSummary,
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: vi.fn(
        () =>
          ({
            getSessionSummary: vi.fn(async () => null),
          }) as unknown as ISessionReader,
      ),
      sessionMetadataService: {
        getProvider: vi.fn(() => "claude"),
        getRequestedModel: vi.fn(() => "sonnet"),
        getExecutor: vi.fn(() => undefined),
        getMetadata: vi.fn(() => ({ promptSuggestionMode: "native" })),
        updateMetadata,
        setProvider,
        setRequestedModel,
      } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>,
      eventBus: { emit: vi.fn() } as unknown as SessionsDeps["eventBus"],
    });

    const response = await routes.request(
      `/projects/${project.id}/sessions/sess-1/retitle`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentTitle: "old noisy title",
          lengthTarget: 132,
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      title: "Tight rename flow",
      generatorSessionId: "sess-retitle-generator",
    });
    expect(forkSession).toHaveBeenCalledWith({
      sessionId: "sess-1",
      projectPath: project.path,
      providerName: "claude",
      title: "Retitle generator",
    });
    expect(generateSummary).toHaveBeenCalledWith(
      "claude",
      expect.objectContaining({
        purpose: "session-retitle",
        strategy: "fork",
        model: "sonnet",
        generatorSessionId: "sess-retitle-generator",
        cwd: project.path,
        currentTitle: "old noisy title",
        lengthTarget: 132,
      }),
    );
    expect(updateMetadata).toHaveBeenCalledWith("sess-retitle-generator", {
      title: "Retitle generator",
      archived: true,
      forkedFromSessionId: "sess-1",
    });
    expect(updateMetadata).not.toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({ title: expect.any(String) }),
    );
    expect(setProvider).toHaveBeenCalledWith(
      "sess-retitle-generator",
      "claude",
    );
    expect(setRequestedModel).toHaveBeenCalledWith(
      "sess-retitle-generator",
      "sonnet",
    );
  });

  it("reactivates a stopped cross-provider session before retitle fork", async () => {
    const project = createProject();
    const summary = createSummary();
    const primaryReader = {
      getSessionSummary: vi.fn(async () => null),
    } as unknown as ISessionReader;
    const codexReader = {
      getSessionSummary: vi.fn(async () => summary),
    } as unknown as CodexSessionReader;
    const reactivateSession = vi.fn(async () => ({
      id: "proc-source",
      provider: "codex",
      model: "gpt-5-codex",
      isTerminated: false,
    }));
    const forkSession = vi.fn(async () => ({
      sessionId: "sess-retitle-generator",
    }));
    const generateSummary = vi.fn(async () => ({
      text: "Codex-backed rename",
    }));

    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => undefined),
        reactivateSession,
        supportsForkSession: vi.fn(
          (providerName: ProviderName | undefined) => providerName === "codex",
        ),
        forkSession,
        generateSummary,
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: vi.fn(() => primaryReader),
      codexSessionsDir: "/tmp/codex-sessions",
      codexReaderFactory: vi.fn(
        () => codexReader as unknown as CodexSessionReader,
      ),
      sessionMetadataService: {
        getProvider: vi.fn(() => undefined),
        getRequestedModel: vi.fn(() => undefined),
        getExecutor: vi.fn(() => undefined),
        getMetadata: vi.fn(() => ({ promptSuggestionMode: "off" })),
        updateMetadata: vi.fn(async () => undefined),
        setProvider: vi.fn(async () => undefined),
        setRequestedModel: vi.fn(async () => undefined),
      } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>,
      eventBus: { emit: vi.fn() } as unknown as SessionsDeps["eventBus"],
    });

    const response = await routes.request(
      `/projects/${project.id}/sessions/sess-1/retitle`,
      { method: "POST", headers: { "Content-Type": "application/json" } },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      title: "Codex-backed rename",
      generatorSessionId: "sess-retitle-generator",
    });
    expect(reactivateSession).toHaveBeenCalledWith(
      project.path,
      "sess-1",
      undefined,
      expect.objectContaining({
        providerName: "codex",
        promptSuggestionMode: "off",
      }),
      { requestedOverrides: {} },
    );
    expect(forkSession).toHaveBeenCalledWith({
      sessionId: "sess-1",
      projectPath: project.path,
      providerName: "codex",
      title: "Retitle generator",
    });
    expect(generateSummary).toHaveBeenCalledWith(
      "codex",
      expect.objectContaining({ purpose: "session-retitle" }),
    );
    expect(reactivateSession.mock.invocationCallOrder[0]).toBeLessThan(
      forkSession.mock.invocationCallOrder[0],
    );
    expect(primaryReader.getSessionSummary).toHaveBeenCalledWith(
      "sess-1",
      project.id,
    );
    expect(codexReader.getSessionSummary).toHaveBeenCalledWith(
      "sess-1",
      project.id,
    );
  });

  it("owns fork-summary generation after returning a durable display object", async () => {
    const project = createProject();
    const sessionSandbox = { stateKey: "project-sandbox" };
    const generateSummary = vi.fn(async () => ({
      text: "Title: Refactor continuation\n\nKept the setup; continue from the fixed test failure.",
    }));
    const forkSession = vi
      .fn()
      .mockResolvedValueOnce({
        sessionId: "sess-generator",
        sandboxStateKey: "project-sandbox",
        sessionSandbox,
      })
      .mockResolvedValueOnce({
        sessionId: "sess-target",
        sandboxStateKey: "project-sandbox",
        sessionSandbox,
      });
    const resumeSession = vi.fn(async () => ({
      id: "proc-target",
      sessionId: "sess-target",
      projectId: project.id,
      provider: "claude",
      model: "sonnet",
      resolvedModel: "sonnet",
      permissionMode: "default",
      modeVersion: 0,
      promptSuggestionMode: "native",
      sandboxStateKey: "project-sandbox",
      subscribe: vi.fn(() => vi.fn()),
    }));
    const updateMetadata = vi.fn(async () => undefined);
    const setProvider = vi.fn(async () => undefined);
    const setRequestedModel = vi.fn(async () => undefined);
    const setSessionSandbox = vi.fn(async () => undefined);
    const emit = vi.fn();
    let transcriptDisplayObjects: TranscriptDisplayObject[] = [];
    const addTranscriptDisplayObject = vi.fn(async (_sessionId, object) => {
      transcriptDisplayObjects = [...transcriptDisplayObjects, object];
    });
    const updateTranscriptDisplayObject = vi.fn(
      async (_sessionId, objectId, updater) => {
        let updated: TranscriptDisplayObject | undefined;
        transcriptDisplayObjects = transcriptDisplayObjects.map((object) => {
          if (object.id !== objectId) return object;
          updated = updater(object);
          return updated;
        });
        return updated;
      },
    );

    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => ({
          id: "proc-source",
          provider: "claude",
          model: "sonnet",
          resolvedModel: "sonnet",
          permissionMode: "default",
          modeVersion: 0,
          state: { type: "idle", since: new Date() },
          getMessageHistory: vi.fn(() => [
            {
              type: "user",
              uuid: "msg-user-initial",
              message: {
                role: "user",
                content: "Fix the failing test.",
              },
            },
            {
              type: "assistant",
              uuid: "msg-after-initial-turn",
              message: {
                role: "assistant",
                content: "Loaded AGENTS and found the failing test.",
              },
            },
          ]),
        })),
        supportsForkSession: vi.fn(() => true),
        generateSummary,
        forkSession,
        resumeSession,
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: vi.fn(
        () =>
          ({
            getSessionSummary: vi.fn(async () => null),
          }) as unknown as ISessionReader,
      ),
      sessionMetadataService: {
        getProvider: vi.fn(() => "claude"),
        getRequestedModel: vi.fn(() => "sonnet"),
        setRequestedModel,
        getExecutor: vi.fn(() => undefined),
        getMetadata: vi.fn(() => ({
          customTitle: "Refactor session",
          promptSuggestionMode: "native",
          sandboxLevel: "project-write",
          sandboxStateKey: "project-sandbox",
          sandboxProjectPath: project.path,
        })),
        getTranscriptDisplayObjects: vi.fn(() => transcriptDisplayObjects),
        addTranscriptDisplayObject,
        updateTranscriptDisplayObject,
        setProvider,
        setSessionSandbox,
        updateMetadata,
      } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>,
      eventBus: { emit } as unknown as SessionsDeps["eventBus"],
    });

    const response = await routes.request(
      `/projects/${project.id}/sessions/sess-1/fork-summary`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceMessageId: "msg-user-initial",
          instructions: "focus on verification and next action",
        }),
      },
    );

    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body).toMatchObject({
      displayObject: {
        kind: "fork-summary",
        sourceMessageId: "msg-user-initial",
        retainedThroughMessageId: "msg-after-initial-turn",
        placementAfterMessageId: "msg-after-initial-turn",
        status: "generating",
      },
    });
    await vi.waitFor(() => {
      expect(resumeSession).toHaveBeenCalledTimes(1);
    });
    expect(forkSession).toHaveBeenNthCalledWith(1, {
      sessionId: "sess-1",
      projectPath: project.path,
      providerName: "claude",
      title: "Fork summary generator",
      sandboxLevel: "project-write",
      sandboxNetworkFirewall: true,
      sandboxStateKey: "project-sandbox",
    });
    expect(generateSummary).toHaveBeenCalledWith(
      "claude",
      expect.objectContaining({
        purpose: "fork-after-summary",
        strategy: "fork",
        model: "sonnet",
        generatorSessionId: "sess-generator",
        cwd: project.path,
        afterTurnMessageId: "msg-after-initial-turn",
        afterTurnContext: "Loaded AGENTS and found the failing test.",
        instructions: "focus on verification and next action",
        sessionSandbox,
      }),
    );
    expect(forkSession).toHaveBeenNthCalledWith(2, {
      sessionId: "sess-1",
      projectPath: project.path,
      providerName: "claude",
      boundary: {
        kind: "message",
        provider: "claude",
        messageId: "msg-after-initial-turn",
      },
      title: "Refactor continuation",
      sandboxLevel: "project-write",
      sandboxNetworkFirewall: true,
      sandboxStateKey: "project-sandbox",
    });
    expect(resumeSession).toHaveBeenCalledWith(
      "sess-target",
      project.path,
      expect.objectContaining({
        text: expect.stringContaining("Kept the setup"),
      }),
      undefined,
      expect.objectContaining({
        providerName: "claude",
        model: "sonnet",
        promptSuggestionMode: "native",
        sandboxLevel: "project-write",
        sandboxStateKey: "project-sandbox",
      }),
    );
    expect(setSessionSandbox).toHaveBeenCalledWith(
      "sess-generator",
      expect.objectContaining({
        level: "project-write",
        stateKey: "project-sandbox",
        projectPath: project.path,
      }),
    );
    expect(setSessionSandbox).toHaveBeenCalledWith(
      "sess-target",
      expect.objectContaining({
        level: "project-write",
        stateKey: "project-sandbox",
        projectPath: project.path,
      }),
    );
    expect(updateMetadata).toHaveBeenCalledWith("sess-generator", {
      title: "Fork summary generator",
      archived: true,
      forkedFromSessionId: "sess-1",
    });
    expect(updateMetadata).toHaveBeenCalledWith("sess-target", {
      title: "Refactor continuation",
      archived: true,
      forkedFromSessionId: "sess-1",
    });
    expect(updateMetadata).toHaveBeenCalledWith("sess-target", {
      title: "Refactor continuation",
      archived: false,
      forkedFromSessionId: "sess-1",
    });
    expect(setProvider).toHaveBeenCalledWith("sess-target", "claude");
    expect(setProvider).toHaveBeenCalledWith("sess-generator", "claude");
    expect(setRequestedModel).toHaveBeenCalledWith("sess-target", "sonnet");
    expect(setRequestedModel).toHaveBeenCalledWith("sess-generator", "sonnet");
    expect(updateTranscriptDisplayObject).toHaveBeenCalled();
    expect(transcriptDisplayObjects[0]).toMatchObject({
      status: "ready",
      targetSessionId: "sess-target",
      title: "Refactor continuation",
    });
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sess-generator",
        archived: true,
        forkedFromSessionId: "sess-1",
      }),
    );
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sess-target",
        archived: true,
        forkedFromSessionId: "sess-1",
      }),
    );
  });

  it("keeps compact summaries in fork-after context without making them source turns", async () => {
    const project = createProject();
    const generateSummary = vi.fn(async () => ({
      text: "Title: Compact continuation\n\nUse the compacted state.",
    }));
    const forkSession = vi
      .fn()
      .mockResolvedValueOnce({ sessionId: "sess-generator" })
      .mockResolvedValueOnce({ sessionId: "sess-target" });
    const resumeSession = vi.fn(async () => ({
      id: "proc-target",
      sessionId: "sess-target",
      projectId: project.id,
      provider: "claude",
      model: "sonnet",
      resolvedModel: "sonnet",
      permissionMode: "default",
      modeVersion: 0,
      subscribe: vi.fn(() => vi.fn()),
    }));
    let transcriptDisplayObjects: TranscriptDisplayObject[] = [];
    const addTranscriptDisplayObject = vi.fn(async (_sessionId, object) => {
      transcriptDisplayObjects = [...transcriptDisplayObjects, object];
    });
    const updateTranscriptDisplayObject = vi.fn(
      async (_sessionId, objectId, updater) => {
        let updated: TranscriptDisplayObject | undefined;
        transcriptDisplayObjects = transcriptDisplayObjects.map((object) => {
          if (object.id !== objectId) return object;
          updated = updater(object);
          return updated;
        });
        return updated;
      },
    );
    const getMessageHistory = vi.fn(() => [
      {
        type: "user",
        uuid: "msg-user-initial",
        message: { role: "user", content: "Start the task." },
      },
      {
        type: "assistant",
        uuid: "msg-assistant",
        message: { role: "assistant", content: "Did the initial work." },
      },
      {
        type: "system",
        uuid: "compact-boundary",
        subtype: "compact_boundary",
        content: "Conversation compacted",
      },
      {
        type: "user",
        uuid: "compact-summary",
        isCompactSummary: true,
        isVisibleInTranscriptOnly: true,
        message: {
          role: "user",
          content: "Provider compact summary text.",
        },
      },
      {
        type: "user",
        uuid: "msg-user-next",
        message: { role: "user", content: "Continue." },
      },
    ]);

    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => ({
          id: "proc-source",
          provider: "claude",
          model: "sonnet",
          state: { type: "idle", since: new Date() },
          getMessageHistory,
        })),
        supportsForkSession: vi.fn(() => true),
        generateSummary,
        forkSession,
        resumeSession,
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: vi.fn(
        () =>
          ({
            getSessionSummary: vi.fn(async () => null),
          }) as unknown as ISessionReader,
      ),
      sessionMetadataService: {
        getProvider: vi.fn(() => "claude"),
        getRequestedModel: vi.fn(() => "sonnet"),
        getExecutor: vi.fn(() => undefined),
        getMetadata: vi.fn(() => ({})),
        getTranscriptDisplayObjects: vi.fn(() => transcriptDisplayObjects),
        addTranscriptDisplayObject,
        updateTranscriptDisplayObject,
        setProvider: vi.fn(async () => undefined),
        setRequestedModel: vi.fn(async () => undefined),
        updateMetadata: vi.fn(async () => undefined),
      } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>,
    });

    const response = await routes.request(
      `/projects/${project.id}/sessions/sess-1/fork-summary`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceMessageId: "msg-user-initial" }),
      },
    );

    expect(response.status).toBe(202);
    await vi.waitFor(() => {
      expect(generateSummary).toHaveBeenCalledTimes(1);
    });
    expect(generateSummary).toHaveBeenCalledWith(
      "claude",
      expect.objectContaining({
        afterTurnMessageId: "compact-summary",
        afterTurnContext: "Provider compact summary text.",
      }),
    );
    expect(forkSession).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        boundary: {
          kind: "message",
          provider: "claude",
          messageId: "compact-summary",
        },
      }),
    );
  });

  it("rejects compact summaries as fork-after source turns", async () => {
    const project = createProject();
    const forkSession = vi.fn();
    const generateSummary = vi.fn();
    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => ({
          id: "proc-source",
          provider: "claude",
          state: { type: "idle", since: new Date() },
          getMessageHistory: vi.fn(() => [
            {
              type: "user",
              uuid: "compact-summary",
              isCompactSummary: true,
              isVisibleInTranscriptOnly: true,
              message: {
                role: "user",
                content: "Provider compact summary text.",
              },
            },
          ]),
        })),
        supportsForkSession: vi.fn(() => true),
        forkSession,
        generateSummary,
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: vi.fn(
        () =>
          ({
            getSessionSummary: vi.fn(async () => null),
          }) as unknown as ISessionReader,
      ),
      sessionMetadataService: {
        getProvider: vi.fn(() => "claude"),
        getTranscriptDisplayObjects: vi.fn(() => []),
      } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>,
    });

    const response = await routes.request(
      `/projects/${project.id}/sessions/sess-1/fork-summary`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceMessageId: "compact-summary" }),
      },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "sourceMessageId must identify a user-authored request",
    });
    expect(forkSession).not.toHaveBeenCalled();
    expect(generateSummary).not.toHaveBeenCalled();
  });

  it("rejects provider-synthetic rows as fork-after source turns", async () => {
    const project = createProject();
    const forkSession = vi.fn();
    const generateSummary = vi.fn();
    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => ({
          id: "proc-source",
          provider: "codex",
          state: { type: "idle", since: new Date() },
          getMessageHistory: vi.fn(() => [
            {
              type: "user",
              uuid: "provider-context",
              isSynthetic: true,
              message: {
                role: "user",
                content: "Provider-injected context",
              },
            },
          ]),
        })),
        supportsForkSession: vi.fn(() => true),
        forkSession,
        generateSummary,
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: vi.fn(
        () =>
          ({
            getSessionSummary: vi.fn(async () => null),
          }) as unknown as ISessionReader,
      ),
      sessionMetadataService: {
        getProvider: vi.fn(() => "codex"),
        getTranscriptDisplayObjects: vi.fn(() => []),
      } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>,
    });

    const response = await routes.request(
      `/projects/${project.id}/sessions/sess-1/fork-summary`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceMessageId: "provider-context" }),
      },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "sourceMessageId must identify a user-authored request",
    });
    expect(forkSession).not.toHaveBeenCalled();
    expect(generateSummary).not.toHaveBeenCalled();
  });

  it("rejects slash-command skill bodies as fork-after source turns", async () => {
    const project = createProject();
    const forkSession = vi.fn();
    const generateSummary = vi.fn();
    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => ({
          id: "proc-source",
          provider: "claude",
          state: { type: "idle", since: new Date() },
          getMessageHistory: vi.fn(() => [
            {
              type: "user",
              uuid: "skill-body",
              isMeta: true,
              message: {
                role: "user",
                content: [
                  {
                    type: "text",
                    text:
                      "Base directory for this skill: /home/graehl/.claude/skills/harsh-review\n\n" +
                      "# Harsh review\n\nFirst classify each changed artifact.",
                  },
                ],
              },
            },
          ]),
        })),
        supportsForkSession: vi.fn(() => true),
        forkSession,
        generateSummary,
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: vi.fn(
        () =>
          ({
            getSessionSummary: vi.fn(async () => null),
          }) as unknown as ISessionReader,
      ),
      sessionMetadataService: {
        getProvider: vi.fn(() => "claude"),
        getTranscriptDisplayObjects: vi.fn(() => []),
      } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>,
    });

    const response = await routes.request(
      `/projects/${project.id}/sessions/sess-1/fork-summary`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceMessageId: "skill-body" }),
      },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "sourceMessageId must identify a user-authored request",
    });
    expect(forkSession).not.toHaveBeenCalled();
    expect(generateSummary).not.toHaveBeenCalled();
  });

  it("rejects an in-progress fork boundary before creating helper work", async () => {
    const project = createProject();
    const forkSession = vi.fn();
    const generateSummary = vi.fn();
    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => ({
          id: "proc-source",
          provider: "claude",
          model: "sonnet",
          state: { type: "in-turn", since: new Date() },
          getMessageHistory: vi.fn(() => [
            {
              type: "user",
              uuid: "msg-user",
              message: { role: "user", content: "Still running" },
            },
          ]),
        })),
        supportsForkSession: vi.fn(() => true),
        forkSession,
        generateSummary,
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: vi.fn(
        () =>
          ({
            getSessionSummary: vi.fn(async () => null),
          }) as unknown as ISessionReader,
      ),
      sessionMetadataService: {
        getProvider: vi.fn(() => "claude"),
        getTranscriptDisplayObjects: vi.fn(() => []),
      } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>,
    });

    const response = await routes.request(
      `/projects/${project.id}/sessions/sess-1/fork-summary`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceMessageId: "msg-user" }),
      },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "The selected turn is still in progress",
    });
    expect(forkSession).not.toHaveBeenCalled();
    expect(generateSummary).not.toHaveBeenCalled();
  });

  it("accepts a completed persisted turn with no active process", async () => {
    const project = createProject();
    const summary: SessionSummary = {
      ...createSummary(),
      provider: "grok",
      model: "grok-build",
    };
    const reader = {
      getSessionSummary: vi.fn(async () => summary),
      getSession: vi.fn(async () => ({
        summary,
        data: {
          provider: "grok",
          session: {
            messages: [
              {
                type: "user",
                uuid: "msg-user",
                message: { role: "user", content: "Completed request" },
              },
              {
                type: "assistant",
                uuid: "msg-assistant",
                message: { role: "assistant", content: "Completed response" },
              },
            ],
          },
        },
      })),
    } as unknown as ISessionReader;
    const forkSession = vi.fn(
      () => new Promise<{ sessionId: string }>(() => {}),
    );
    let transcriptDisplayObjects: TranscriptDisplayObject[] = [];
    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => undefined),
        supportsForkSession: vi.fn(() => true),
        forkSession,
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: vi.fn(() => reader),
      grokReaderFactory: vi.fn(() => reader as unknown as GrokSessionReader),
      sessionMetadataService: {
        getProvider: vi.fn(() => "grok"),
        getRequestedModel: vi.fn(() => "grok-build"),
        getExecutor: vi.fn(() => undefined),
        getMetadata: vi.fn(() => ({})),
        getTranscriptDisplayObjects: vi.fn(() => transcriptDisplayObjects),
        addTranscriptDisplayObject: vi.fn(async (_sessionId, object) => {
          transcriptDisplayObjects = [...transcriptDisplayObjects, object];
        }),
      } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>,
    });

    const response = await routes.request(
      `/projects/${project.id}/sessions/sess-1/fork-summary`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceMessageId: "msg-user" }),
      },
    );

    const responseBody = await response.json();
    expect(response.status, JSON.stringify(responseBody)).toBe(202);
    expect(responseBody).toMatchObject({
      displayObject: {
        retainedThroughMessageId: "msg-assistant",
        status: "generating",
      },
    });
    expect(forkSession).toHaveBeenCalledTimes(1);
  });

  it("rejects an invalid fork-summary permission mode", async () => {
    const project = createProject();
    const routes = createSessionsRoutes({
      supervisor: {} as SessionsDeps["supervisor"],
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
    });

    const response = await routes.request(
      `/projects/${project.id}/sessions/sess-1/fork-summary`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceMessageId: "msg-user",
          mode: "unrestricted",
        }),
      },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Invalid permission mode",
    });
  });

  it("rejects the fork endpoint when the provider has no fork primitive", async () => {
    const project = createProject();
    const forkSession = vi.fn();
    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => undefined),
        supportsForkSession: vi.fn(() => false),
        forkSession,
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: vi.fn(
        () =>
          ({
            getSessionSummary: vi.fn(async () => null),
            getSessionFilePath: vi.fn(
              async () => "/home/user/.claude/projects/enc/sess-1.jsonl",
            ),
          }) as unknown as ISessionReader,
      ),
      sessionMetadataService: {
        getProvider: vi.fn(() => "codex"),
        getRequestedModel: vi.fn(() => undefined),
        setRequestedModel: vi.fn(async () => undefined),
        getExecutor: vi.fn(() => undefined),
        getMetadata: vi.fn(() => ({})),
      } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>,
    });

    const response = await routes.request(
      `/projects/${project.id}/sessions/sess-1/fork`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );

    expect(response.status).toBe(400);
    expect(forkSession).not.toHaveBeenCalled();
  });

  it("rejects fork restart before interrupting an unsupported provider", async () => {
    const project = createProject();
    const forkSession = vi.fn();
    const interruptProcess = vi.fn(async () => ({
      success: true,
      supported: true,
    }));
    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => ({
          id: "proc-old",
          provider: "codex",
          model: "gpt-5.4",
          resolvedModel: "gpt-5.4",
          permissionMode: "default",
          modeVersion: 0,
          state: { type: "idle", since: new Date() },
          getMessageHistory: vi.fn(() => [
            {
              type: "user",
              uuid: "u1",
              timestamp: "2026-04-24T20:00:00.000Z",
              message: { role: "user", content: "codex work" },
            },
          ]),
        })),
        supportsForkSession: vi.fn(() => false),
        forkSession,
        interruptProcess,
      } as unknown as SessionsDeps["supervisor"],
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
      sessionMetadataService: {
        getProvider: vi.fn(() => "codex"),
        getRequestedModel: vi.fn(() => undefined),
        setRequestedModel: vi.fn(async () => undefined),
        getExecutor: vi.fn(() => undefined),
        getMetadata: vi.fn(() => ({})),
      } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>,
    });

    const response = await routes.request(
      `/projects/${project.id}/sessions/sess-1/restart`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ restartMode: "fork" }),
      },
    );

    expect(response.status).toBe(400);
    expect(interruptProcess).not.toHaveBeenCalled();
    expect(forkSession).not.toHaveBeenCalled();
    const body = await response.json();
    expect(body.error).toContain("does not support transcript fork");
  });

  it("uses the requested provider only as the handoff target", async () => {
    const project = createProject();
    const summary: SessionSummary = {
      ...createSummary(),
      title: "Claude source session",
      fullTitle: "Claude source session",
      provider: "claude",
      model: "sonnet",
    };
    const reader = {
      getSessionSummary: vi.fn(async () => summary),
      getSession: vi.fn(async () => ({
        summary,
        data: {
          provider: "claude",
          session: {
            messages: [
              {
                type: "user",
                timestamp: "2026-04-24T20:00:00.000Z",
                message: {
                  role: "user",
                  content: "please hand this Claude session to Codex",
                },
              },
            ],
          },
        },
      })),
    } as unknown as ISessionReader;
    const startSession = vi.fn(async () => ({
      id: "proc-new",
      sessionId: "sess-new",
      projectId: project.id,
      provider: "codex",
      model: "gpt-5.5",
      resolvedModel: "gpt-5.5",
      permissionMode: "default",
      modeVersion: 0,
      subscribe: vi.fn(() => vi.fn()),
    }));
    const setProvider = vi.fn(async () => undefined);
    const getContextWindow = vi.fn((model: string | undefined) =>
      model === "sonnet" ? 200_000 : 0,
    );

    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => undefined),
        startSession,
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: vi.fn(() => reader),
      sessionMetadataService: {
        getProvider: vi.fn(() => undefined),
        getRequestedModel: vi.fn(() => "opus"),
        setRequestedModel: vi.fn(async () => undefined),
        getExecutor: vi.fn(() => undefined),
        getMetadata: vi.fn(() => ({
          effectiveLaunchSettings: {
            schemaVersion: 1,
            revision: 3,
            permissionMode: "bypassPermissions",
            requestedModel: "opus",
            serviceTier: "priority",
            thinking: { type: "adaptive" },
            effort: "high",
          },
        })),
        setProvider,
        updateMetadata: vi.fn(async () => undefined),
      } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>,
      serverSettingsService: {
        getSetting: vi.fn((key: string) =>
          key === "clientDefaults"
            ? { compactAtContextPercent: { "gpt-5.5": 50 } }
            : undefined,
        ),
      } as unknown as SessionsDeps["serverSettingsService"],
      modelInfoService: {
        getContextWindow,
      } as unknown as SessionsDeps["modelInfoService"],
    });

    const response = await routes.request(
      `/projects/${project.id}/sessions/sess-1/restart`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "codex" }),
      },
    );

    expect(response.status).toBe(200);
    expect(startSession).toHaveBeenCalledWith(
      project.path,
      expect.objectContaining({
        text: expect.stringContaining("- Provider: claude"),
      }),
      "bypassPermissions",
      expect.objectContaining({
        model: undefined,
        requestedModel: undefined,
        serviceTier: undefined,
        thinking: undefined,
        effort: undefined,
        providerName: "codex",
      }),
    );
    expect(startSession.mock.calls[0]?.[1].text).toContain("- Model: sonnet");
    expect(setProvider).toHaveBeenCalledWith("sess-new", "codex");

    startSession.mockClear();
    const explicitResponse = await routes.request(
      `/projects/${project.id}/sessions/sess-1/restart`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "codex",
          mode: "plan",
          model: "gpt-5.5",
          serviceTier: "priority",
          thinking: "max",
        }),
      },
    );

    expect(explicitResponse.status).toBe(200);
    expect(startSession).toHaveBeenCalledWith(
      project.path,
      expect.anything(),
      "plan",
      expect.objectContaining({
        model: "gpt-5.5",
        requestedModel: "gpt-5.5",
        serviceTier: "priority",
        thinking: { type: "adaptive", display: "summarized" },
        effort: "max",
        providerName: "codex",
        compactAtContextPercent: 50,
        compactAtContextWindow: undefined,
      }),
    );
    expect(getContextWindow).not.toHaveBeenCalledWith("sonnet", "codex");
  });

  it("does not reuse generated handoff boilerplate as the next handoff title", async () => {
    const project = createProject();
    const startSession = vi.fn(async () => ({
      id: "proc-new",
      sessionId: "sess-new",
      projectId: project.id,
      provider: "codex",
      model: "gpt-5.4",
      resolvedModel: "gpt-5.4",
      permissionMode: "default",
      modeVersion: 0,
      subscribe: vi.fn(() => vi.fn()),
    }));
    const updateMetadata = vi.fn(async () => undefined);

    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => ({
          id: "proc-old",
          provider: "codex",
          model: "gpt-5.5",
          resolvedModel: "gpt-5.5",
          permissionMode: "default",
          modeVersion: 0,
          state: { type: "idle", since: new Date() },
          getMessageHistory: vi.fn(() => [
            {
              type: "user",
              uuid: "u1",
              message: {
                role: "user",
                content:
                  "# Restart Handoff\n\nYep Anywhere is starting this as a fresh agent session.",
              },
            },
            {
              type: "user",
              uuid: "u2",
              message: {
                role: "user",
                content: "fix handoff session titles",
              },
            },
          ]),
        })),
        startSession,
        interruptProcess: vi.fn(async () => ({
          success: true,
          supported: true,
        })),
        abortProcess: vi.fn(async () => true),
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: vi.fn(
        () =>
          ({
            getSessionSummary: vi.fn(async () => null),
            getSessionFilePath: vi.fn(
              async () => "/home/user/.claude/projects/enc/sess-1.jsonl",
            ),
          }) as unknown as ISessionReader,
      ),
      sessionMetadataService: {
        getProvider: vi.fn(() => "codex"),
        getRequestedModel: vi.fn(() => undefined),
        setRequestedModel: vi.fn(async () => undefined),
        getExecutor: vi.fn(() => undefined),
        getMetadata: vi.fn(() => undefined),
        setProvider: vi.fn(async () => undefined),
        updateMetadata,
      } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>,
    });

    const response = await routes.request(
      `/projects/${project.id}/sessions/sess-1/restart`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "codex", model: "gpt-5.4" }),
      },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.title).toBe("Handoff: fix handoff session titles");
    expect(startSession.mock.calls[0]?.[1].text).toContain(
      "# Handoff: fix handoff session titles",
    );
    expect(updateMetadata).toHaveBeenCalledWith("sess-new", {
      title: "Handoff: fix handoff session titles",
    });
  });

  it("tries provider-native compact before starting the handoff", async () => {
    const project = createProject();
    const history: unknown[] = [
      {
        type: "user",
        uuid: "u1",
        timestamp: "2026-04-24T20:00:00.000Z",
        message: { role: "user", content: "handoff after compact please" },
      },
    ];
    let compactListener:
      | ((event: { type: string; message?: unknown }) => void)
      | undefined;
    const queueMessage = vi.fn((message) => {
      history.push({
        type: "user",
        uuid: "compact-command",
        timestamp: "2026-04-24T20:00:01.000Z",
        message: { role: "user", content: message.text },
      });
      queueMicrotask(() => {
        const compactMessage = {
          type: "system",
          subtype: "compact_boundary",
          uuid: "compact-1",
          timestamp: "2026-04-24T20:00:02.000Z",
          message: {
            role: "system",
            content: "Native compact summary text",
          },
        };
        history.push(compactMessage);
        compactListener?.({ type: "message", message: compactMessage });
      });
      return { success: true, position: 1 };
    });
    const interruptProcess = vi.fn(async () => ({
      success: true,
      supported: true,
    }));
    const startSession = vi.fn(async () => ({
      id: "proc-new",
      sessionId: "sess-new",
      projectId: project.id,
      provider: "codex",
      model: "gpt-5.4",
      resolvedModel: "gpt-5.4",
      permissionMode: "default",
      modeVersion: 0,
      subscribe: vi.fn(() => vi.fn()),
    }));

    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => ({
          id: "proc-old",
          provider: "codex",
          model: "gpt-5.5",
          resolvedModel: "gpt-5.5",
          permissionMode: "default",
          modeVersion: 0,
          state: { type: "idle", since: new Date() },
          supportsDynamicCommands: true,
          supportedCommands: vi.fn(async () => [
            { name: "compact", description: "Compact conversation" },
          ]),
          queueMessage,
          subscribe: vi.fn((listener) => {
            compactListener = listener;
            return vi.fn();
          }),
          getMessageHistory: vi.fn(() => history),
          getDeferredQueueSummary: vi.fn(() => []),
        })),
        startSession,
        interruptProcess,
        abortProcess: vi.fn(async () => true),
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: vi.fn(
        () =>
          ({
            getSessionSummary: vi.fn(async () => null),
            getSessionFilePath: vi.fn(
              async () => "/home/user/.claude/projects/enc/sess-1.jsonl",
            ),
          }) as unknown as ISessionReader,
      ),
      sessionMetadataService: {
        getProvider: vi.fn(() => "codex"),
        getRequestedModel: vi.fn(() => undefined),
        setRequestedModel: vi.fn(async () => undefined),
        getExecutor: vi.fn(() => undefined),
        getMetadata: vi.fn(() => undefined),
        setProvider: vi.fn(async () => undefined),
        updateMetadata: vi.fn(async () => undefined),
      } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>,
    });

    const response = await routes.request(
      `/projects/${project.id}/sessions/sess-1/restart`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "codex", model: "gpt-5.4" }),
      },
    );

    expect(response.status).toBe(200);
    expect(queueMessage).toHaveBeenCalledWith({ text: "/compact" });
    expect(queueMessage.mock.invocationCallOrder[0]).toBeLessThan(
      interruptProcess.mock.invocationCallOrder[0] ?? 0,
    );
    const handoffText = startSession.mock.calls[0]?.[1].text;
    // The compact attempt still runs (its boundary feeds the summary section),
    // but its status is no longer echoed as a handoff header line.
    expect(handoffText).not.toContain("Provider-native compact:");
    expect(handoffText).toContain("## Provider-Native Compact Summary");
    expect(handoffText).toContain("Native compact summary text");
    // The internal /compact command is still filtered out of the user turns.
    expect(handoffText).not.toContain("### user\n\n/compact");
  });

  /**
   * A compact-capable source process, shared by the draft tests so they can
   * assert what the preview and an edited restart each do to it.
   */
  const createHandoffDraftRoutes = () => {
    const project = createProject();
    const history: unknown[] = [
      {
        type: "user",
        uuid: "u1",
        timestamp: "2026-04-24T20:00:00.000Z",
        message: { role: "user", content: "draft this handoff" },
      },
    ];
    let compactListener:
      | ((event: { type: string; message?: unknown }) => void)
      | undefined;
    const queueMessage = vi.fn((message) => {
      history.push({
        type: "user",
        uuid: "compact-command",
        timestamp: "2026-04-24T20:00:01.000Z",
        message: { role: "user", content: message.text },
      });
      queueMicrotask(() => {
        const compactMessage = {
          type: "system",
          subtype: "compact_boundary",
          uuid: "compact-1",
          timestamp: "2026-04-24T20:00:02.000Z",
          message: { role: "system", content: "Native compact summary text" },
        };
        history.push(compactMessage);
        compactListener?.({ type: "message", message: compactMessage });
      });
      return { success: true, position: 1 };
    });
    const interruptProcess = vi.fn(async () => ({
      success: true,
      supported: true,
    }));
    const startSession = vi.fn(async () => ({
      id: "proc-new",
      sessionId: "sess-new",
      projectId: project.id,
      provider: "codex",
      model: "gpt-5.4",
      resolvedModel: "gpt-5.4",
      permissionMode: "default",
      modeVersion: 0,
      subscribe: vi.fn(() => vi.fn()),
    }));

    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => ({
          id: "proc-old",
          provider: "codex",
          model: "gpt-5.5",
          resolvedModel: "gpt-5.5",
          permissionMode: "default",
          modeVersion: 0,
          state: { type: "idle", since: new Date() },
          supportsDynamicCommands: true,
          supportedCommands: vi.fn(async () => [
            { name: "compact", description: "Compact conversation" },
          ]),
          queueMessage,
          subscribe: vi.fn((listener) => {
            compactListener = listener;
            return vi.fn();
          }),
          getMessageHistory: vi.fn(() => history),
          getDeferredQueueSummary: vi.fn(() => []),
        })),
        startSession,
        interruptProcess,
        abortProcess: vi.fn(async () => true),
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: vi.fn(
        () =>
          ({
            getSessionSummary: vi.fn(async () => null),
            getSessionFilePath: vi.fn(
              async () => "/home/user/.claude/projects/enc/sess-1.jsonl",
            ),
          }) as unknown as ISessionReader,
      ),
      sessionMetadataService: {
        getProvider: vi.fn(() => "codex"),
        getRequestedModel: vi.fn(() => undefined),
        setRequestedModel: vi.fn(async () => undefined),
        getExecutor: vi.fn(() => undefined),
        getMetadata: vi.fn(() => undefined),
        setProvider: vi.fn(async () => undefined),
        updateMetadata: vi.fn(async () => undefined),
      } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>,
    });

    return { project, routes, queueMessage, interruptProcess, startSession };
  };

  it("previews the handoff draft without starting or interrupting", async () => {
    const { project, routes, queueMessage, interruptProcess, startSession } =
      createHandoffDraftRoutes();

    const response = await routes.request(
      `/projects/${project.id}/sessions/sess-1/restart/handoff`,
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.handoff).toContain("draft this handoff");
    // The draft is the computed content, so it carries the compact boundary a
    // real handoff would have.
    expect(queueMessage).toHaveBeenCalledWith({ text: "/compact" });
    expect(body.handoff).toContain("## Provider-Native Compact Summary");
    expect(body.compactStatus).toBe("completed");
    // Previewing is not starting: the source session keeps running.
    expect(interruptProcess).not.toHaveBeenCalled();
    expect(startSession).not.toHaveBeenCalled();
  });

  it("seeds an edited handoff draft verbatim without compacting again", async () => {
    const { project, routes, queueMessage, interruptProcess, startSession } =
      createHandoffDraftRoutes();

    const response = await routes.request(
      `/projects/${project.id}/sessions/sess-1/restart`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "codex",
          model: "gpt-5.4",
          handoffText: "Only what I chose to carry forward.",
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(startSession.mock.calls[0]?.[1].text).toBe(
      "Only what I chose to carry forward.",
    );
    // The preview already compacted; doing it again would only spend tokens.
    expect(queueMessage).not.toHaveBeenCalled();
    // Starting still replaces the old process.
    expect(interruptProcess).toHaveBeenCalled();
  });

  it.each([
    {
      label: "non-string",
      handoffText: { text: "not a string" },
      error: "handoffText must be a string",
    },
    {
      label: "oversized",
      handoffText: "x".repeat(40_001),
      error: "handoffText must be at most 40000 characters",
    },
  ])(
    "rejects $label edited handoff text before touching the source process",
    async ({ handoffText, error }) => {
      const { project, routes, queueMessage, interruptProcess, startSession } =
        createHandoffDraftRoutes();

      const response = await routes.request(
        `/projects/${project.id}/sessions/sess-1/restart`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ handoffText }),
        },
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error });
      expect(queueMessage).not.toHaveBeenCalled();
      expect(interruptProcess).not.toHaveBeenCalled();
      expect(startSession).not.toHaveBeenCalled();
    },
  );

  it("summarizes fallback activity and appends queued turns last", async () => {
    const project = createProject();
    const verboseReadOutput = "VERBOSE_READ_OUTPUT".repeat(200);
    const startSession = vi.fn(async () => ({
      id: "proc-new",
      sessionId: "sess-new",
      projectId: project.id,
      provider: "codex",
      model: "gpt-5.4",
      resolvedModel: "gpt-5.4",
      permissionMode: "default",
      modeVersion: 0,
      subscribe: vi.fn(() => vi.fn()),
    }));

    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => ({
          id: "proc-old",
          provider: "codex",
          model: "gpt-5.5",
          resolvedModel: "gpt-5.5",
          permissionMode: "default",
          modeVersion: 0,
          state: { type: "in-turn" },
          getMessageHistory: vi.fn(() => [
            {
              type: "system",
              subtype: "compact_boundary",
              uuid: "compact-1",
              timestamp: "2026-04-24T20:00:00.000Z",
              message: {
                role: "system",
                content: "Existing compact summary",
              },
            },
            {
              type: "user",
              uuid: "u1",
              timestamp: "2026-04-24T20:01:00.000Z",
              message: { role: "user", content: "older user turn" },
            },
            {
              type: "assistant",
              uuid: "a1",
              timestamp: "2026-04-24T20:02:00.000Z",
              message: {
                role: "assistant",
                content: [
                  {
                    type: "tool_use",
                    id: "read-1",
                    name: "Read",
                    input: {
                      file_path: "packages/server/src/routes/sessions.ts",
                    },
                  },
                ],
              },
            },
            {
              type: "user",
              uuid: "tool-result-1",
              timestamp: "2026-04-24T20:03:00.000Z",
              message: {
                role: "user",
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: "read-1",
                    content: verboseReadOutput,
                  },
                ],
              },
            },
            {
              type: "assistant",
              uuid: "a2",
              timestamp: "2026-04-24T20:03:30.000Z",
              message: {
                role: "assistant",
                content: [
                  { type: "thinking", thinking: "PRIVATE_REASONING_TEXT" },
                  { type: "text", text: "assistant conclusion prose" },
                  {
                    type: "tool_use",
                    id: "bash-1",
                    name: "Bash",
                    input: { command: "pnpm test foo" },
                  },
                ],
              },
            },
            {
              type: "user",
              uuid: "u2",
              timestamp: "2026-04-24T20:04:00.000Z",
              message: { role: "user", content: "latest user direction" },
            },
          ]),
          getDeferredQueueSummary: vi.fn(() => [
            {
              tempId: "queued-1",
              content: "queued follow-up",
              timestamp: "2026-04-24T20:05:00.000Z",
              attachmentCount: 1,
            },
          ]),
        })),
        startSession,
        interruptProcess: vi.fn(async () => ({
          success: true,
          supported: true,
        })),
        abortProcess: vi.fn(async () => true),
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: vi.fn(
        () =>
          ({
            getSessionSummary: vi.fn(async () => null),
            getSessionFilePath: vi.fn(
              async () => "/home/user/.claude/projects/enc/sess-1.jsonl",
            ),
          }) as unknown as ISessionReader,
      ),
      sessionMetadataService: {
        getProvider: vi.fn(() => "codex"),
        getRequestedModel: vi.fn(() => undefined),
        setRequestedModel: vi.fn(async () => undefined),
        getExecutor: vi.fn(() => undefined),
        getMetadata: vi.fn(() => undefined),
        setProvider: vi.fn(async () => undefined),
        updateMetadata: vi.fn(async () => undefined),
      } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>,
    });

    const response = await routes.request(
      `/projects/${project.id}/sessions/sess-1/restart`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "codex",
          model: "gpt-5.4",
          reason: "Manual restart from Yep Anywhere",
          sourceUrl: "https://localhost:3400/projects/proj-1/sessions/sess-1",
        }),
      },
    );

    expect(response.status).toBe(200);
    const handoffText = startSession.mock.calls[0]?.[1].text ?? "";
    // Source Session block: self-documenting URL, no internal process id, no
    // restart-reason or provider-compact noise.
    expect(handoffText).toContain(
      "- URL: https://localhost:3400/projects/proj-1/sessions/sess-1",
    );
    expect(handoffText).not.toContain("Previous YA process");
    expect(handoffText).not.toContain("Restart reason");
    expect(handoffText).not.toContain("Provider-native compact:");
    expect(handoffText).toContain("- Full transcript on ");
    expect(handoffText).toContain(
      "(read or grep there for detail beyond this summary): /home/user/.claude/projects/enc/sess-1.jsonl",
    );
    // A claude/codex source also gets the non-forking consult command.
    expect(handoffText).toContain(
      "echo '<question>' | session-turn codex sess-1",
    );
    // The real compact summary section still renders.
    expect(handoffText).toContain("## Provider-Native Compact Summary");
    expect(handoffText).toContain("Existing compact summary");
    // User turns keep a light divider; their content is verbatim.
    expect(handoffText).toContain("## Recent User Turns");
    expect(handoffText).toContain("### user");
    expect(handoffText).toContain("older user turn");
    expect(handoffText).toContain("latest user direction");
    // Activity: assistant prose and bash commands survive, bare.
    expect(handoffText).toContain("assistant conclusion prose");
    expect(handoffText).toContain("$ pnpm test foo");
    expect(handoffText).not.toContain("### assistant");
    // Slimmed noise is gone: no timestamps, non-bash tool_use, tool results,
    // or thinking.
    expect(handoffText).not.toContain("2026-04-24T20:04:00.000Z");
    expect(handoffText).not.toContain("[tool_use");
    expect(handoffText).not.toContain("[tool_result");
    expect(handoffText).not.toContain("thinking");
    expect(handoffText).not.toContain("PRIVATE_REASONING_TEXT");
    expect(handoffText).not.toContain("read/search details omitted");
    expect(handoffText).not.toContain(verboseReadOutput);
    // Queued turns still come last.
    expect(handoffText).toContain("## Queued User Turns (Not Yet Processed)");
    expect(handoffText).toContain(
      "No agent response in the source session has processed them yet.",
    );
    expect(handoffText).toContain("queued follow-up");
    expect(handoffText).toContain("Attachments queued: 1");
    expect(handoffText.trim().endsWith("Temp ID: queued-1")).toBe(true);
    expect(handoffText.indexOf("## Queued User Turns")).toBeGreaterThan(
      handoffText.indexOf("## Recent Agent and Tool Activity"),
    );
  });

  it("does not abort the old process when handoff startup is queued", async () => {
    const project = createProject();
    const abortProcess = vi.fn(async () => true);
    const interruptProcess = vi.fn(async () => ({
      success: true,
      supported: true,
    }));
    const cancelQueuedRequest = vi.fn(() => true);

    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => ({
          id: "proc-old",
          provider: "codex",
          model: "gpt-5.5",
          resolvedModel: "gpt-5.5",
          permissionMode: "default",
          modeVersion: 0,
          state: { type: "idle", since: new Date() },
          getMessageHistory: vi.fn(() => []),
        })),
        interruptProcess,
        startSession: vi.fn(async () => ({
          queued: true,
          queueId: "queue-1",
          position: 1,
        })),
        cancelQueuedRequest,
        abortProcess,
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: vi.fn(
        () =>
          ({
            getSessionSummary: vi.fn(async () => null),
            getSessionFilePath: vi.fn(
              async () => "/home/user/.claude/projects/enc/sess-1.jsonl",
            ),
          }) as unknown as ISessionReader,
      ),
      sessionMetadataService: {
        getProvider: vi.fn(() => "codex"),
        getRequestedModel: vi.fn(() => undefined),
        setRequestedModel: vi.fn(async () => undefined),
        getExecutor: vi.fn(() => undefined),
        getMetadata: vi.fn(() => undefined),
      } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>,
    });

    const response = await routes.request(
      `/projects/${project.id}/sessions/sess-1/restart`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "codex", model: "gpt-5.4" }),
      },
    );

    expect(response.status).toBe(503);
    expect(interruptProcess).toHaveBeenCalledWith("proc-old");
    expect(cancelQueuedRequest).toHaveBeenCalledWith("queue-1");
    expect(abortProcess).not.toHaveBeenCalled();
  });
});

describe("Session reactivation route", () => {
  const projectId = encodeProjectId("/tmp/project");
  const reactivatePath = `/projects/${projectId}/sessions/sess-1/reactivate`;
  const project = { ...createProject(), id: projectId };
  const readerFactory = vi.fn(
    () => ({ getSessionSummary: vi.fn(async () => null) }) as ISessionReader,
  );

  it("reserves the project until provider startup settles", async () => {
    let finishStartup!: (process: { id: string }) => void;
    const startup = new Promise<{ id: string }>((resolve) => {
      finishStartup = resolve;
    });
    const release = vi.fn();
    const reserveUserSessionStart = vi.fn(() => release);
    const reactivateSession = vi.fn(() => startup);
    const routes = createSessionsRoutes({
      supervisor: {
        reactivateSession,
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory,
      projectQueueScheduler: { reserveUserSessionStart },
      sessionMetadataService: {
        getMetadata: vi.fn(() => ({ provider: "claude" as ProviderName })),
      } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>,
    });

    const responsePromise = routes.request(reactivatePath, { method: "POST" });
    await vi.waitFor(() => expect(reactivateSession).toHaveBeenCalledOnce());

    expect(reserveUserSessionStart).toHaveBeenCalledWith(projectId, "sess-1");
    expect(release).not.toHaveBeenCalled();

    finishStartup({ id: "process-started" });
    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(release).toHaveBeenCalledOnce();
  });

  it("releases the project reservation after provider startup fails", async () => {
    const release = vi.fn();
    const routes = createSessionsRoutes({
      supervisor: {
        reactivateSession: vi.fn(async () => {
          throw new Error("provider refused startup");
        }),
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory,
      projectQueueScheduler: {
        reserveUserSessionStart: vi.fn(() => release),
      },
      sessionMetadataService: {
        getMetadata: vi.fn(() => ({ provider: "claude" as ProviderName })),
      } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>,
    });

    const response = await routes.request(reactivatePath, { method: "POST" });

    expect(response.status).toBe(503);
    expect(release).toHaveBeenCalledOnce();
  });

  it("resolves an external session from exact native provider evidence", async () => {
    const primaryReader = {
      getSessionSummary: vi.fn(async () => null),
    } as unknown as ISessionReader;
    const grokReader = {
      getSessionSummary: vi.fn(async () => ({
        ...createSummary(),
        provider: "grok" as ProviderName,
      })),
    } as unknown as GrokSessionReader;
    const process = {
      id: "process-grok",
      permissionMode: "default",
      appliedPermissionMode: "default",
      modeVersion: 0,
    };
    const reactivateSession = vi.fn(async () => process);
    const routes = createSessionsRoutes({
      supervisor: {
        reactivateSession,
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: vi.fn(() => primaryReader),
      grokReaderFactory: vi.fn(() => grokReader),
      sessionMetadataService: {
        getMetadata: vi.fn(() => undefined),
      } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>,
    });

    const response = await routes.request(reactivatePath, { method: "POST" });

    expect(response.status).toBe(200);
    expect(reactivateSession).toHaveBeenCalledWith(
      project.path,
      "sess-1",
      undefined,
      expect.objectContaining({ providerName: "grok" }),
      { requestedOverrides: {} },
    );
  });

  it("reactivates from the Codex transcript cwd instead of the request project", async () => {
    const transcriptProjectPath = "/tmp/native-codex-project";
    const transcriptProject = {
      ...project,
      id: encodeProjectId(transcriptProjectPath),
      path: transcriptProjectPath,
      provider: "codex" as ProviderName,
    };
    const process = {
      id: "process-codex",
      permissionMode: "default",
      appliedPermissionMode: "default",
      modeVersion: 0,
    };
    const reactivateSession = vi.fn(async () => process);
    const reserveUserSessionStart = vi.fn(() => vi.fn());
    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => undefined),
        reactivateSession,
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getOrCreateProject: vi.fn(async (requestedId: UrlProjectId) =>
          requestedId === project.id
            ? project
            : requestedId === transcriptProject.id
              ? transcriptProject
              : null,
        ),
      } as unknown as SessionsDeps["scanner"],
      codexScanner: {
        getSessionProjectPath: vi.fn(async () => transcriptProjectPath),
      },
      readerFactory,
      projectQueueScheduler: { reserveUserSessionStart },
      sessionMetadataService: {
        getMetadata: vi.fn(() => ({ provider: "codex" as ProviderName })),
      } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>,
    });

    const response = await routes.request(reactivatePath, { method: "POST" });

    expect(response.status).toBe(200);
    expect(reactivateSession).toHaveBeenCalledWith(
      transcriptProjectPath,
      "sess-1",
      undefined,
      expect.objectContaining({ providerName: "codex" }),
      { requestedOverrides: {} },
    );
    expect(reserveUserSessionStart).toHaveBeenCalledWith(
      transcriptProject.id,
      "sess-1",
    );
  });

  it("does not fall back to the project provider for an unknown session", async () => {
    const emptyReader = {
      getSessionSummary: vi.fn(async () => null),
    } as unknown as ISessionReader;
    const reactivateSession = vi.fn();
    const routes = createSessionsRoutes({
      supervisor: {
        reactivateSession,
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: vi.fn(() => emptyReader),
      grokReaderFactory: vi.fn(
        () => emptyReader as unknown as GrokSessionReader,
      ),
      piReaderFactory: vi.fn(() => emptyReader),
    });

    const response = await routes.request(reactivatePath, { method: "POST" });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Session not found",
    });
    expect(reactivateSession).not.toHaveBeenCalled();
  });

  it.each([
    ["malformed", "{not-json"],
    ["array", "[]"],
    ["null", "null"],
  ])(
    "rejects a %s body before project or process lookup",
    async (_name, body) => {
      const getOrCreateProject = vi.fn(async () => project);
      const reactivateSession = vi.fn();
      const getProcessForSession = vi.fn();
      const routes = createSessionsRoutes({
        supervisor: {
          getProcessForSession,
          reactivateSession,
        } as unknown as SessionsDeps["supervisor"],
        scanner: {
          getOrCreateProject,
        } as unknown as SessionsDeps["scanner"],
        readerFactory,
      });

      const response = await routes.request(reactivatePath, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });

      expect(response.status).toBe(400);
      expect(getOrCreateProject).not.toHaveBeenCalled();
      expect(getProcessForSession).not.toHaveBeenCalled();
      expect(reactivateSession).not.toHaveBeenCalled();
    },
  );

  it("passes exact explicit overrides even when a live process already exists", async () => {
    const process = {
      id: "process-live",
      projectId,
      projectPath: project.path,
      provider: "codex" as ProviderName,
      executor: "build-host",
      permissionMode: "plan",
      appliedPermissionMode: "plan",
      modeVersion: 3,
      recapMode: "fork" as const,
      recapAfterSeconds: 45,
      promptSuggestionMode: "off" as const,
      sandboxEnforcement: undefined,
    };
    const reactivateSession = vi.fn(async () => process);
    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => process),
        reactivateSession,
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory,
      sessionMetadataService: {
        getMetadata: vi.fn(() => ({
          provider: "claude" as ProviderName,
          requestedModel: "sonnet",
          executor: "old-host",
          recapAfterSeconds: 30,
        })),
      } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>,
    });

    const response = await routes.request(reactivatePath, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "plan",
        provider: "codex",
        executor: "build-host",
        sandboxLevel: "none",
        model: "gpt-5.4",
        serviceTier: "priority",
        thinking: "on:high",
        showThinking: "off",
        recapMode: "fork",
        recapAfterSeconds: 45,
        promptSuggestionMode: "off",
        permissions: { deny: ["Bash(rm *)"] },
      }),
    });

    expect(response.status).toBe(200);
    expect(reactivateSession).toHaveBeenCalledWith(
      project.path,
      "sess-1",
      "plan",
      expect.objectContaining({
        providerName: "codex",
        executor: "build-host",
        sandboxLevel: "none",
        model: "gpt-5.4",
        requestedModel: "gpt-5.4",
        serviceTier: "priority",
        thinking: { type: "adaptive", display: "summarized" },
        effort: "high",
        recapMode: "fork",
        recapAfterSeconds: 45,
        promptSuggestionMode: "off",
        permissions: { deny: ["Bash(rm *)"] },
      }),
      {
        requestedOverrides: {
          permissionMode: "plan",
          modelSettings: {
            model: "gpt-5.4",
            requestedModel: "gpt-5.4",
            serviceTier: "priority",
            thinking: { type: "adaptive", display: "summarized" },
            effort: "high",
            providerName: "codex",
            executor: "build-host",
            permissions: { deny: ["Bash(rm *)"] },
            sandboxLevel: "none",
            sandboxNetworkFirewall: false,
            sandboxStateKey: undefined,
            recapMode: "fork",
            recapAfterSeconds: 45,
            promptSuggestionMode: "off",
          },
        },
      },
    );
  });

  it("reports an active-turn configuration conflict as 409", async () => {
    const reactivateSession = vi.fn(async () => {
      throw new SessionConfigurationConflictError(["service tier"]);
    });
    const routes = createSessionsRoutes({
      supervisor: {
        reactivateSession,
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory,
      sessionMetadataService: {
        getMetadata: vi.fn(() => ({ provider: "claude" as ProviderName })),
      } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>,
    });

    const response = await routes.request(reactivatePath, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serviceTier: "priority" }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: expect.stringContaining("service tier"),
    });
  });
});

describe("Session-keyed away-recap route", () => {
  const projectId = encodeProjectId("/tmp/project");
  const recapPath = `/projects/${projectId}/sessions/sess-1/recap`;

  it("recaps a live process directly", async () => {
    const requestRecap = vi.fn(async () => ({
      supported: true,
      emitted: true,
      text: "live recap",
    }));
    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => ({ id: "p1", isTerminated: false })),
        isRecapPausedUntilUserTurn: vi.fn(() => false),
        requestRecap,
      } as unknown as SessionsDeps["supervisor"],
    });

    const response = await routes.request(recapPath, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hiddenSinceMs: 1000 }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      emitted: true,
      text: "live recap",
    });
    expect(requestRecap).toHaveBeenCalledWith("p1", { sinceMs: 1000 });
  });

  it("revives a cold fork-mode session and recaps from the transcript", async () => {
    const reactivateSession = vi.fn(async () => ({ id: "p-revived" }));
    const requestRecap = vi.fn(async () => ({
      supported: true,
      emitted: true,
      text: "revived recap",
    }));
    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => null),
        isRecapPausedUntilUserTurn: vi.fn(() => false),
        reactivateSession,
        requestRecap,
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getOrCreateProject: vi.fn(async () => createProject()),
      } as unknown as SessionsDeps["scanner"],
      sessionMetadataService: {
        getRecapMode: vi.fn(() => "fork"),
        getMetadata: vi.fn(() => ({ provider: "claude" as ProviderName })),
      } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>,
    });

    const response = await routes.request(recapPath, { method: "POST" });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      emitted: true,
      text: "revived recap",
    });
    expect(reactivateSession).toHaveBeenCalledWith(
      "/tmp/project",
      "sess-1",
      undefined,
      expect.objectContaining({ recapMode: "fork", providerName: "claude" }),
      { preempt: false, requestedOverrides: {} },
    );
    expect(requestRecap).toHaveBeenCalledWith("p-revived", {
      sinceMs: null,
      revived: true,
    });
  });

  it("does not revive a terminated session whose automatic resume is disabled", async () => {
    const reactivateSession = vi.fn();
    const requestRecap = vi.fn();
    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => null),
        isRecapPausedUntilUserTurn: vi.fn(() => false),
        reactivateSession,
        requestRecap,
      } as unknown as SessionsDeps["supervisor"],
      sessionMetadataService: {
        getMetadata: vi.fn(() => ({
          provider: "claude" as ProviderName,
          recapMode: "fork" as const,
          autoResumeDisabled: true,
        })),
      } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>,
    });

    const response = await routes.request(recapPath, { method: "POST" });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      supported: true,
      emitted: false,
      reason: "recap skipped: automatic resume disabled",
    });
    expect(reactivateSession).not.toHaveBeenCalled();
    expect(requestRecap).not.toHaveBeenCalled();
  });

  it("does not revive a session while recaps await a fresh user turn", async () => {
    const reactivateSession = vi.fn();
    const requestRecap = vi.fn();
    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => null),
        isRecapPausedUntilUserTurn: vi.fn(() => true),
        reactivateSession,
        requestRecap,
      } as unknown as SessionsDeps["supervisor"],
      sessionMetadataService: {
        getMetadata: vi.fn(() => ({
          provider: "claude" as ProviderName,
          recapMode: "fork" as const,
          recapPausedUntilUserTurn: true,
        })),
      } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>,
    });

    const response = await routes.request(recapPath, { method: "POST" });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      supported: true,
      emitted: false,
      reason: "recaps paused until next user turn",
    });
    expect(reactivateSession).not.toHaveBeenCalled();
    expect(requestRecap).not.toHaveBeenCalled();
  });

  it("skips a cold session whose recap mode is not fork (no revival)", async () => {
    const reactivateSession = vi.fn();
    const requestRecap = vi.fn();
    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => null),
        isRecapPausedUntilUserTurn: vi.fn(() => false),
        reactivateSession,
        requestRecap,
      } as unknown as SessionsDeps["supervisor"],
      sessionMetadataService: {
        getRecapMode: vi.fn(() => "side-session"),
      } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>,
    });

    const response = await routes.request(recapPath, { method: "POST" });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ emitted: false });
    expect(reactivateSession).not.toHaveBeenCalled();
    expect(requestRecap).not.toHaveBeenCalled();
  });

  it("skips without preempting when revival hits worker capacity", async () => {
    const reactivateSession = vi.fn(async () => {
      throw new Error(
        "Cannot reactivate: server is at worker capacity and no idle process can be preempted",
      );
    });
    const requestRecap = vi.fn();
    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => null),
        isRecapPausedUntilUserTurn: vi.fn(() => false),
        reactivateSession,
        requestRecap,
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getOrCreateProject: vi.fn(async () => createProject()),
      } as unknown as SessionsDeps["scanner"],
      sessionMetadataService: {
        getRecapMode: vi.fn(() => "fork"),
        getMetadata: vi.fn(() => ({ provider: "claude" as ProviderName })),
      } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>,
    });

    const response = await routes.request(recapPath, { method: "POST" });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      emitted: false,
      reason: expect.stringContaining("capacity"),
    });
    expect(requestRecap).not.toHaveBeenCalled();
  });
});
