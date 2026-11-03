import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseYaSessionId, type UrlProjectId } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionMetadataService } from "../../src/metadata/SessionMetadataService.js";
import { encodeProjectId } from "../../src/projects/paths.js";
import {
  createSessionsRoutes,
  type SessionsDeps,
} from "../../src/routes/sessions.js";
import type { AgentProvider } from "../../src/sdk/providers/types.js";
import { MessageQueue } from "../../src/sdk/messageQueue.js";
import {
  createControllableIterator,
  waitFor,
} from "../process.test-support.js";
import { Supervisor } from "../../src/supervisor/Supervisor.js";
import type { Project } from "../../src/supervisor/types.js";
import {
  closeTestDiscoveryDatabases,
  createTestSessionMetadataService,
} from "../utils/session-metadata-database.js";

/**
 * A session start that waits for a free worker records the same launch
 * metadata and creator as one that starts at once: admission commits intent
 * before a worker becomes available.
 */
describe("a session start that waits for a worker", () => {
  let root: string;
  let projectPath: string;
  let projectId: UrlProjectId;
  let project: Project;
  let metadata: SessionMetadataService;
  const nativeCleanups: Array<() => Promise<void>> = [];

  beforeEach(async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    root = join(tmpdir(), `queued-start-metadata-${randomUUID()}`);
    projectPath = join(root, "project");
    await mkdir(projectPath, { recursive: true });
    projectId = encodeProjectId(projectPath);
    project = {
      id: projectId,
      path: projectPath,
      name: "project",
      sessionCount: 0,
      sessionDir: join(root, "sessions"),
      activeOwnedCount: 0,
      activeExternalCount: 0,
      lastActivity: null,
      provider: "claude",
    };
    metadata = createTestSessionMetadataService(join(root, "data"));
    await metadata.initialize();
  });

  afterEach(async () => {
    for (const dispose of nativeCleanups.splice(0).reverse()) await dispose();
    vi.restoreAllMocks();
    closeTestDiscoveryDatabases();
    await rm(root, { recursive: true, force: true });
  });

  function routesFor(supervisor: SessionsDeps["supervisor"]) {
    return createSessionsRoutes({
      supervisor,
      scanner: {
        getOrCreateProject: async () => project,
      } as unknown as SessionsDeps["scanner"],
      readerFactory: () => {
        throw new Error("readerFactory should not be used");
      },
      sessionMetadataService: metadata,
    });
  }

  function nativeRoutes(installed = true, maxWorkers = 0) {
    const owners: Array<
      { sessionId: string; queue: MessageQueue } & ReturnType<
        typeof createControllableIterator
      >
    > = [];
    const provider: AgentProvider = {
      name: "claude",
      acceptsChosenSessionId: true,
      displayName: "Claude",
      supportsPermissionMode: true,
      supportsThinkingToggle: true,
      supportsSlashCommands: true,
      supportsSteering: false,
      initializesOnFirstMessage: true,
      isInstalled: async () => installed,
      isAuthenticated: async () => true,
      getAuthStatus: async () => ({
        installed,
        authenticated: true,
        enabled: true,
      }),
      getAvailableModels: async () => [],
      getNewSessionNamespace: async () => ({
        family: "claude",
        storageScope: project.sessionDir,
      }),
      startSession: async (options) => {
        const sessionId = options.newSessionId!;
        expect(
          metadata.creations.getForSession(parseYaSessionId(sessionId))?.attempt
            .state,
        ).toBe("dispatching");
        const owner = {
          sessionId,
          queue: new MessageQueue(),
          ...createControllableIterator(),
        };
        owners.push(owner);
        return {
          iterator: owner.iterator,
          queue: owner.queue,
          abort: owner.finish,
        };
      },
    };
    const supervisor = new Supervisor({
      provider,
      sessionMetadataService: metadata,
      maxWorkers,
      idlePreemptThresholdMs: 0,
    });
    nativeCleanups.push(async () => {
      for (const process of supervisor.getAllProcesses()) await process.abort();
      await supervisor.stopBackgroundTasks();
    });
    return { supervisor, owners, routes: routesFor(supervisor) };
  }

  it("accepts text before native init and coalesces concurrent/replayed requests without another owner", async () => {
    const f = nativeRoutes();
    const body = {
      requestId: "owned_creation_request",
      provider: "claude",
      message: "exact accepted input",
      model: "sonnet",
    };
    const submit = (value = body) =>
      f.routes.request(`/projects/${projectId}/session-creations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(value),
      });
    const responses = await Promise.all([submit(), submit()]);
    expect(responses.map((r) => r.status)).toEqual([202, 202]);
    const [first, second] = await Promise.all(responses.map((r) => r.json()));
    expect(first.sessionId).toBe(second.sessionId);
    expect(metadata.creations.listProjections()).toHaveLength(1);
    await waitFor(() => expect(f.owners).toHaveLength(1));
    expect(
      metadata.creations.get({ kind: "superuser" }, body.requestId)?.request
        ?.message,
    ).toBe(body.message);
    const replay = await submit();
    expect((await replay.json()).sessionId).toBe(first.sessionId);
    expect(
      (await submit({ ...body, message: "conflicting input" })).status,
    ).toBe(409);
    expect(f.owners).toHaveLength(1);
    f.owners[0]!.push({
      type: "system",
      subtype: "init",
      session_id: first.sessionId,
    });
    f.owners[0]!.push({
      type: "assistant",
      session_id: first.sessionId,
      user_message_uuid: metadata.creations.get(
        { kind: "superuser" },
        body.requestId,
      )!.initialInputId!,
      message: { role: "assistant", content: "confirmed" },
    });
    await waitFor(() =>
      expect(
        metadata.creations.get({ kind: "superuser" }, body.requestId)?.attempt
          .delivery,
      ).toBe("consumed"),
    );
    const status = await f.routes.request(
      `/session-creations/${body.requestId}`,
    );
    expect(await status.json()).toMatchObject({
      sessionId: first.sessionId,
      creation: { delivery: "consumed" },
    });
  });

  it("retains an accepted failed text request and its original result across database reopen", async () => {
    const f = nativeRoutes(false);
    const body = {
      requestId: "owned_failed_creation",
      provider: "claude",
      message: "saved before unavailable startup",
      model: "sonnet",
    };
    const submit = () =>
      f.routes.request(`/projects/${projectId}/session-creations`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Yep-Client-Surface": "desktop",
        },
        body: JSON.stringify(body),
      });
    const accepted = await submit();
    expect(accepted.status).toBe(202);
    const receipt = await accepted.json();
    await waitFor(() =>
      expect(
        metadata.creations.get({ kind: "superuser" }, body.requestId)?.attempt
          .state,
      ).toBe("failed"),
    );
    expect(f.owners).toHaveLength(0);
    await f.supervisor.stopBackgroundTasks();
    closeTestDiscoveryDatabases();
    metadata = createTestSessionMetadataService(join(root, "data"));
    await metadata.initialize();
    const reopened = nativeRoutes(false);
    const result = await reopened.routes.request(
      `/session-creations/${body.requestId}`,
    );
    expect(await result.json()).toMatchObject({
      sessionId: receipt.sessionId,
      creation: { state: "failed", delivery: "not-admitted" },
    });
    expect(
      metadata.getMetadata(receipt.sessionId)?.creationProvenance?.surface,
    ).toBe("desktop");
    const replay = await reopened.routes.request(
      `/projects/${projectId}/session-creations`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    expect(replay.status).toBe(202);
    expect((await replay.json()).sessionId).toBe(receipt.sessionId);
    expect(reopened.owners).toHaveLength(0);
  });

  for (const route of ["project", "detached"] as const) {
    it(`retains ${route} prompt/source and first-input metadata when the provider is unavailable`, async () => {
      const f = nativeRoutes(false);
      // Intentional HTTP startup failure: the saved control record must survive.
      const response = await f.routes.request(
        route === "project" ? `/projects/${projectId}/sessions` : "/sessions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Yep-Client-Surface": "desktop",
            "X-Yep-Client-Version": "owned-test",
          },
          body: JSON.stringify({
            message: "  saved exact prompt\n",
            tempId: "original-client-input",
            model: "sonnet",
            messageMetadata: {
              turnEffort: "fast",
              composition: { submittedAt: "2026-11-02T00:00:00.000Z" },
              sentByUser: "forged-actor",
              hidden: true,
              apiSubmissionId: "forged-receipt",
            },
          }),
        },
      );
      expect(response.status).toBe(500);
      const [projection] = metadata.creations.listProjections();
      expect(projection?.creation).toMatchObject({
        state: "failed",
        failure: "startup-unavailable",
        delivery: "not-admitted",
      });
      const saved = metadata.creations.getForSession(projection!.sessionId)!;
      expect(saved.context).toMatchObject({
        owner: { kind: "superuser" },
        source: {
          kind: "request",
          provenance: { surface: "desktop", clientVersion: "owned-test" },
        },
      });
      expect(saved.request).toMatchObject({
        message: "  saved exact prompt\n",
        input: {
          tempId: "original-client-input",
          metadata: {
            turnEffort: "fast",
            composition: { submittedAt: "2026-11-02T00:00:00.000Z" },
          },
        },
      });
      expect(saved.request?.input?.metadata).not.toHaveProperty("sentByUser");
      expect(saved.request?.input?.metadata).not.toHaveProperty("hidden");
      expect(saved.request?.input?.metadata).not.toHaveProperty(
        "apiSubmissionId",
      );
      expect(
        metadata.getMetadata(saved.sessionId)?.creationProvenance?.surface,
      ).toBe("desktop");
      expect(f.owners).toEqual([]);
      expect(f.supervisor.getAllProcesses()).toEqual([]);
    });
  }

  it("keeps the completed HTTP shape and optimistic-input metadata on durable native launch", async () => {
    const f = nativeRoutes();
    const pending = f.routes.request(`/projects/${projectId}/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Yep-Client-Version": "owned-test",
      },
      body: JSON.stringify({
        message: "exact native prompt",
        tempId: "optimistic-input",
        model: "sonnet",
        mode: "default",
        messageMetadata: {
          turnEffort: "fast",
          sourceSessionId: "other-public-session",
        },
      }),
    });
    await waitFor(() => expect(f.owners).toHaveLength(1));
    const owner = f.owners[0]!;
    const initial = await owner.queue[Symbol.asyncIterator]().next();
    const saved = metadata.creations.getForSession(
      parseYaSessionId(owner.sessionId),
    )!;
    expect(initial.value?.uuid).toBe(saved.initialInputId);
    owner.push({
      type: "system",
      subtype: "init",
      session_id: owner.sessionId,
    });
    const response = await pending;
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      sessionId: owner.sessionId,
      projectId,
      processId: expect.any(String),
      permissionMode: "default",
    });
    const process = f.supervisor.getProcessForSession(owner.sessionId)!;
    expect(
      process.getMessageHistory().find((m) => m.uuid === saved.initialInputId),
    ).toMatchObject({
      tempId: "optimistic-input",
      messageMetadata: {
        turnEffort: "fast",
        sourceSessionId: "other-public-session",
        origin: "coordination",
      },
    });
    expect(metadata.getMetadata(owner.sessionId)).toMatchObject({
      workingProjectId: projectId,
      initialPrompt: "exact native prompt",
      creationProvenance: { surface: "web" },
    });
  });

  it("saves queued HTTP intent at admission and rehydrates it with its original source on promotion", async () => {
    const f = nativeRoutes(true, 1);
    const start = (text: string, surface: string) =>
      f.routes.request(`/projects/${projectId}/sessions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Yep-Client-Surface": surface,
        },
        body: JSON.stringify({ message: text, tempId: text, model: "sonnet" }),
      });
    const first = start("occupy", "web");
    await waitFor(() => expect(f.owners).toHaveLength(1));
    const owner = f.owners[0]!;
    const initial = await owner.queue[Symbol.asyncIterator]().next();
    owner.push({
      type: "system",
      subtype: "init",
      session_id: owner.sessionId,
    });
    expect((await first).status).toBe(200);
    owner.push({
      type: "assistant",
      session_id: owner.sessionId,
      user_message_uuid: initial.value!.uuid,
      message: { content: "reply" },
    });
    const queued = await start("exact queued prompt", "desktop");
    expect(queued.status).toBe(202);
    expect(await queued.json()).toMatchObject({
      queued: true,
      queueId: expect.any(String),
      position: 1,
    });
    const projection = metadata.creations
      .listProjections()
      .find((p) => p.sessionId !== owner.sessionId)!;
    expect(projection.creation.state).toBe("queued");
    const saved = metadata.creations.getForSession(projection.sessionId)!;
    expect(saved.context.source).toMatchObject({
      kind: "request",
      provenance: { surface: "desktop" },
    });
    const callerCopy = saved.request!;
    callerCopy.message = "caller mutation must not launch";
    await f.supervisor.abortSessionWithVerification(owner.sessionId);
    await waitFor(() => expect(f.owners).toHaveLength(2));
    const next = f.owners[1]!;
    const input = await next.queue[Symbol.asyncIterator]().next();
    expect(input.value?.message.content).toBe("exact queued prompt");
    expect(input.value?.uuid).toBe(saved.initialInputId);
    next.push({ type: "system", subtype: "init", session_id: next.sessionId });
    await waitFor(() =>
      expect(metadata.getMetadata(next.sessionId)?.workingProjectId).toBe(
        projectId,
      ),
    );
    expect(next.sessionId).toBe(saved.sessionId);
    expect(
      metadata.getMetadata(next.sessionId)?.creationProvenance?.surface,
    ).toBe("desktop");
  });

  it("preserves idle-worker preemption for an admitted ordinary text request", async () => {
    const f = nativeRoutes(true, 1);
    const start = (message: string) =>
      f.routes.request(`/projects/${projectId}/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "claude", message, model: "sonnet" }),
      });
    const first = start("first native prompt");
    await waitFor(() => expect(f.owners).toHaveLength(1));
    const original = f.owners[0]!;
    const input = await original.queue[Symbol.asyncIterator]().next();
    original.push({
      type: "system",
      subtype: "init",
      session_id: original.sessionId,
    });
    expect((await first).status).toBe(200);
    original.push({
      type: "result",
      subtype: "success",
      session_id: original.sessionId,
      user_message_uuid: input.value!.uuid,
    });
    await waitFor(() =>
      expect(
        f.supervisor.getProcessForSession(original.sessionId)?.state.type,
      ).toBe("idle"),
    );
    const next = start("next native prompt");
    await waitFor(() => expect(f.owners).toHaveLength(2));
    const replacement = f.owners[1]!;
    await replacement.queue[Symbol.asyncIterator]().next();
    replacement.push({
      type: "system",
      subtype: "init",
      session_id: replacement.sessionId,
    });
    expect((await next).status).toBe(200);
    expect(
      f.supervisor.getProcessForSession(original.sessionId),
    ).toBeUndefined();
    expect(f.supervisor.getQueueInfo()).toEqual([]);
  });
  it("admits explicit empty preparation on the canonical route without a phantom input", async () => {
    const f = nativeRoutes();
    const submit = (body: object) =>
      f.routes.request(`/projects/${projectId}/session-creations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const body = {
      requestId: "canonical_empty_preparation",
      message: "",
      intent: "prepare",
      provider: "claude",
    };
    const accepted = await submit(body);
    expect(accepted.status).toBe(202);
    const result = await accepted.json();
    await waitFor(() => expect(f.owners).toHaveLength(1));
    expect(f.owners[0]!.queue.depth).toBe(0);
    const saved = metadata.creations.getForSession(
      parseYaSessionId(result.sessionId),
    )!;
    expect(saved.request).toMatchObject({ intent: "prepare", message: "" });
    expect(result.creation.initialInputExpected).toBe(false);
    expect((await (await submit(body)).json()).sessionId).toBe(
      result.sessionId,
    );
    expect(
      (
        await submit({
          ...body,
          requestId: "invalid_prepare_input",
          message: "must not disappear",
        })
      ).status,
    ).toBe(400);
    expect(f.owners).toHaveLength(1);
  });
});
