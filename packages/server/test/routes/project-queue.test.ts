import {
  type ProjectQueueItemSummary,
  type ProjectQueueListResponse,
  type ProjectQueuePromoteNowRequest,
  toUrlProjectId,
  type UrlProjectId,
} from "@yep-anywhere/shared";
import { Hono } from "hono";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PRINCIPAL_VARIABLE,
  type Principal,
} from "../../src/auth/principal.js";
import { UserUsageService } from "../../src/auth/UserUsageService.js";
import type { ProjectScanner } from "../../src/projects/scanner.js";
import {
  createGlobalProjectQueueRoutes,
  createProjectQueueRoutes,
} from "../../src/routes/project-queue.js";
import type { ISessionIndexService } from "../../src/indexes/types.js";
import { ProjectQueueService } from "../../src/services/ProjectQueueService.js";
import {
  type PersistedSessionQueuedMessage,
  SessionQueuePersistenceService,
} from "../../src/services/SessionQueuePersistenceService.js";
import type { ISessionReader } from "../../src/sessions/types.js";
import type { Project, SessionSummary } from "../../src/supervisor/types.js";
import type { SessionMetadataService } from "../../src/metadata/index.js";

describe("Project Queue Routes", () => {
  let testDir: string;
  let projectId: UrlProjectId;
  let project: Project;
  let service: ProjectQueueService;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "project-queue-route-"));
    projectId = toUrlProjectId("/tmp/project-queue-route");
    project = {
      id: projectId,
      path: "/tmp/project-queue-route",
      name: "project-queue-route",
      sessionCount: 0,
      sessionDir: "/tmp/project-queue-route/.claude-sessions",
      activeOwnedCount: 0,
      activeExternalCount: 0,
      lastActivity: null,
      provider: "claude",
    };
    service = new ProjectQueueService({ dataDir: testDir });
    await service.initialize();
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  function createRoutes(
    overrides: Partial<Parameters<typeof createProjectQueueRoutes>[0]> = {},
  ) {
    return createProjectQueueRoutes({
      scanner: {
        getOrCreateProject: vi.fn(async (id) =>
          id === projectId ? project : null,
        ),
      } as unknown as ProjectScanner,
      projectQueueService: service,
      ...overrides,
    });
  }

  function createGlobalRoutes(
    overrides: Partial<
      Parameters<typeof createGlobalProjectQueueRoutes>[0]
    > = {},
  ) {
    return createGlobalProjectQueueRoutes({
      projectQueueService: service,
      ...overrides,
    });
  }

  function makePersistedSessionQueueItem(
    overrides: Partial<PersistedSessionQueuedMessage> = {},
  ): PersistedSessionQueuedMessage {
    return {
      id: "persisted-1",
      sessionId: "session-1",
      projectId,
      projectPath: project.path,
      provider: "claude",
      kind: "patient",
      message: { text: "resume this first" },
      createdAt: "2026-06-30T00:00:00.000Z",
      updatedAt: "2026-06-30T00:00:00.000Z",
      queuedAt: "2026-06-30T00:00:00.000Z",
      status: "paused-after-restart",
      ...overrides,
    };
  }

  it("creates, lists, updates, retries, and deletes project queue items", async () => {
    const routes = createRoutes();
    const createResponse = await routes.request(`/${projectId}/queue`, {
      method: "POST",
      body: JSON.stringify({
        target: { type: "existing-session", sessionId: "session-1" },
        message: { text: "do this after the project settles" },
      }),
      headers: { "Content-Type": "application/json" },
    });

    expect(createResponse.status).toBe(201);
    const created = await createResponse.json();
    const itemId = created.item.id as string;
    expect(created.queue.items).toHaveLength(1);

    const listResponse = await routes.request(`/${projectId}/queue`);
    expect(listResponse.status).toBe(200);
    expect((await listResponse.json()).items[0]).toMatchObject({
      id: itemId,
      messagePreview: "do this after the project settles",
    });

    const patchResponse = await routes.request(
      `/${projectId}/queue/${itemId}`,
      {
        method: "PATCH",
        body: JSON.stringify({ message: { text: "updated text" } }),
        headers: { "Content-Type": "application/json" },
      },
    );
    expect(patchResponse.status).toBe(200);
    expect((await patchResponse.json()).item.messagePreview).toBe(
      "updated text",
    );

    const retryResponse = await routes.request(
      `/${projectId}/queue/${itemId}/retry`,
      { method: "POST" },
    );
    expect(retryResponse.status).toBe(200);

    const deleteResponse = await routes.request(
      `/${projectId}/queue/${itemId}`,
      { method: "DELETE" },
    );
    expect(deleteResponse.status).toBe(200);
    expect((await deleteResponse.json()).queue.items).toEqual([]);
  });

  it("moves a project queue item to the top", async () => {
    const routes = createRoutes();
    const firstResponse = await routes.request(`/${projectId}/queue`, {
      method: "POST",
      body: JSON.stringify({
        target: { type: "existing-session", sessionId: "session-1" },
        message: { text: "first queued item" },
      }),
      headers: { "Content-Type": "application/json" },
    });
    const secondResponse = await routes.request(`/${projectId}/queue`, {
      method: "POST",
      body: JSON.stringify({
        target: { type: "existing-session", sessionId: "session-2" },
        message: { text: "second queued item" },
      }),
      headers: { "Content-Type": "application/json" },
    });
    const first = await firstResponse.json();
    const second = await secondResponse.json();

    const moveResponse = await routes.request(
      `/${projectId}/queue/${second.item.id}/move-to-top`,
      { method: "POST" },
    );

    expect(moveResponse.status).toBe(200);
    const moved = await moveResponse.json();
    expect(moved.item).toMatchObject({
      id: second.item.id,
      messagePreview: "second queued item",
    });
    expect(
      moved.queue.items.map((item: ProjectQueueItemSummary) => item.id),
    ).toEqual([second.item.id, first.item.id]);
  });

  it("rejects invalid queue requests", async () => {
    const routes = createRoutes();

    const response = await routes.request(`/${projectId}/queue`, {
      method: "POST",
      body: JSON.stringify({
        target: { type: "existing-session" },
        message: { text: "missing session target" },
      }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "Invalid project queue request",
    });
  });

  it("lists project queue items globally", async () => {
    const otherProjectId = toUrlProjectId("/tmp/project-queue-route-other");
    await service.createItem({
      creationProvenance: { surface: "api" },
      projectId,
      projectPath: project.path,
      request: {
        target: { type: "existing-session", sessionId: "session-1" },
        message: { text: "first queued item" },
      },
    });
    await service.createItem({
      creationProvenance: { surface: "api" },
      projectId: otherProjectId,
      projectPath: "/tmp/project-queue-route-other",
      request: {
        target: { type: "new-session", title: "Start later" },
        message: { text: "second queued item" },
      },
    });

    const response = await createGlobalRoutes().request("/");

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.dispatchState).toEqual({ status: "running" });
    expect(body.items).toMatchObject([
      {
        projectId,
        messagePreview: "first queued item",
      },
      {
        projectId: otherProjectId,
        messagePreview: "second queued item",
      },
    ]);
  });

  it("includes project status and forwards promote-now requests", async () => {
    const item = await service.createItem({
      creationProvenance: { surface: "api" },
      projectId,
      projectPath: project.path,
      request: {
        target: { type: "existing-session", sessionId: "session-1" },
        message: { text: "blocked queued item" },
      },
    });
    const projectQueueScheduler = {
      getProjectStatus: vi.fn(async (id: UrlProjectId) => ({
        projectId: id,
        state: "blocked" as const,
        idle: false,
        blockers: ["session-1:in-turn"],
        dispatchPaused: false,
        inFlight: false,
        quietWindowMs: 30_000,
        itemCount: 1,
        nextItemId: item.id,
      })),
      promoteNow: vi.fn(
        async (id: UrlProjectId, options: ProjectQueuePromoteNowRequest) => ({
          promoted: true,
          itemId: options.itemId,
          sessionId: "session-1",
          reason: "promoted" as const,
          status: {
            projectId: id,
            state: "empty" as const,
            idle: true,
            blockers: [],
            dispatchPaused: false,
            inFlight: false,
            quietWindowMs: 30_000,
            itemCount: 0,
          },
        }),
      ),
    };

    const routes = createGlobalRoutes({
      projectQueueScheduler,
      sessionMetadataService: {
        getMetadata: vi.fn((sessionId: string) =>
          sessionId === "session-1"
            ? { customTitle: "Active repair session" }
            : undefined,
        ),
      } as unknown as SessionMetadataService,
    });
    const listResponse = await routes.request("/");
    const listBody = await listResponse.json();
    expect(listBody.projectStatuses[projectId]).toMatchObject({
      state: "blocked",
      blockers: ["session-1:in-turn"],
      blockerSessionTitles: { "session-1": "Active repair session" },
      nextItemId: item.id,
    });

    const promoteResponse = await routes.request(`/${projectId}/promote-now`, {
      method: "POST",
      body: JSON.stringify({
        itemId: item.id,
        force: true,
        deliveryIntent: "steer",
      }),
      headers: { "Content-Type": "application/json" },
    });
    const promoteBody = await promoteResponse.json();
    expect(promoteBody.promoteResult).toMatchObject({
      promoted: true,
      itemId: item.id,
      sessionId: "session-1",
      reason: "promoted",
    });
    expect(projectQueueScheduler.promoteNow).toHaveBeenCalledWith(projectId, {
      itemId: item.id,
      force: true,
      deliveryIntent: "steer",
    });
  });

  it("looks up titles only for the blocker sessions the queue names", async () => {
    await service.createItem({
      creationProvenance: { surface: "api" },
      projectId,
      projectPath: project.path,
      request: {
        target: { type: "new-session" },
        message: { text: "blocked queued item" },
      },
    });
    const projectQueueScheduler = {
      getProjectStatus: vi.fn(async (id: UrlProjectId) => ({
        projectId: id,
        state: "blocked" as const,
        idle: false,
        blockers: [
          "session-1:in-turn",
          "worker-queue",
          "session-2:automation-paused",
          "session-3:liveness-verified-progressing",
        ],
        dispatchPaused: false,
        inFlight: false,
        quietWindowMs: 30_000,
        itemCount: 1,
      })),
      promoteNow: vi.fn(),
    };
    const getMetadata = vi.fn((sessionId: string) => ({
      customTitle: `Title of ${sessionId}`,
    }));

    const routes = createGlobalRoutes({
      projectQueueScheduler,
      sessionMetadataService: {
        getMetadata,
      } as unknown as SessionMetadataService,
    });
    const body = await (await routes.request("/")).json();

    expect(body.projectStatuses[projectId].blockerSessionTitles).toEqual({
      "session-1": "Title of session-1",
      "session-2": "Title of session-2",
    });
    expect(getMetadata).not.toHaveBeenCalledWith("session-3");
  });

  it("enriches existing-session targets with cached session titles", async () => {
    await service.createItem({
      creationProvenance: { surface: "api" },
      projectId,
      projectPath: project.path,
      request: {
        target: { type: "existing-session", sessionId: "session-1" },
        message: { text: "first queued item" },
      },
    });
    const reader = makeReader();
    const summary = makeSessionSummary("session-1", "Target session title");
    const sessionIndexService = makeSessionIndexService(summary);
    const readerFactory = vi.fn(() => reader);

    const projectRoutes = createRoutes({
      readerFactory,
      sessionIndexService,
    });
    const projectResponse = await projectRoutes.request(`/${projectId}/queue`);

    expect(projectResponse.status).toBe(200);
    const projectBody = await projectResponse.json();
    expect(projectBody.items[0]).toMatchObject({
      targetTitle: "Target session title",
      targetFullTitle: "Full Target session title",
    });
    expect(sessionIndexService.getSessionSummaryWithCache).toHaveBeenCalledWith(
      project.sessionDir,
      project.id,
      "session-1",
      reader,
    );

    const globalRoutes = createGlobalRoutes({
      scanner: {
        getOrCreateProject: vi.fn(async (id) =>
          id === projectId ? project : null,
        ),
      } as unknown as ProjectScanner,
      readerFactory,
      sessionIndexService,
    });
    const globalResponse = await globalRoutes.request("/");

    expect(globalResponse.status).toBe(200);
    const globalBody = await globalResponse.json();
    expect(globalBody.items[0]).toMatchObject({
      projectId,
      targetTitle: "Target session title",
      targetFullTitle: "Full Target session title",
    });
  });

  it("uses typed list projections for direct existing-session target titles", async () => {
    await service.createItem({
      creationProvenance: { surface: "api" },
      projectId,
      projectPath: project.path,
      request: {
        target: { type: "existing-session", sessionId: "session-1" },
        message: { text: "first queued item" },
      },
    });
    const summary = makeSessionSummary("session-1", "Target session title");
    const getSessionSummary = vi.fn(async () => summary);
    const reader = {
      ...makeReader(),
      getSessionSummary,
    };

    const routes = createRoutes({
      readerFactory: vi.fn(() => reader),
    });
    const response = await routes.request(`/${projectId}/queue`);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items[0]).toMatchObject({
      targetTitle: "Target session title",
      targetFullTitle: "Full Target session title",
    });
    expect(getSessionSummary).toHaveBeenCalledWith("session-1", project.id);
  });

  it("prefers custom titles for existing-session targets", async () => {
    await service.createItem({
      creationProvenance: { surface: "api" },
      projectId,
      projectPath: project.path,
      request: {
        target: { type: "existing-session", sessionId: "session-1" },
        message: { text: "first queued item" },
      },
    });
    const reader = makeReader();
    const summary = makeSessionSummary("session-1", "Target session title");
    const sessionIndexService = makeSessionIndexService(summary);
    const readerFactory = vi.fn(() => reader);
    const sessionMetadataService = {
      getMetadata: vi.fn((sessionId: string) =>
        sessionId === "session-1"
          ? { customTitle: "Renamed target session" }
          : undefined,
      ),
    } as unknown as SessionMetadataService;

    const projectRoutes = createRoutes({
      readerFactory,
      sessionIndexService,
      sessionMetadataService,
    });
    const projectResponse = await projectRoutes.request(`/${projectId}/queue`);

    expect(projectResponse.status).toBe(200);
    const projectBody = await projectResponse.json();
    expect(projectBody.items[0]).toMatchObject({
      targetTitle: "Renamed target session",
      targetFullTitle: "Renamed target session",
    });

    const globalRoutes = createGlobalRoutes({
      scanner: {
        getOrCreateProject: vi.fn(async (id) =>
          id === projectId ? project : null,
        ),
      } as unknown as ProjectScanner,
      readerFactory,
      sessionIndexService,
      sessionMetadataService,
    });
    const globalResponse = await globalRoutes.request("/");

    expect(globalResponse.status).toBe(200);
    const globalBody = await globalResponse.json();
    expect(globalBody.items[0]).toMatchObject({
      projectId,
      targetTitle: "Renamed target session",
      targetFullTitle: "Renamed target session",
    });
  });

  it("includes recovered session queue entries in the global list", async () => {
    const sessionQueuePersistenceService = new SessionQueuePersistenceService({
      dataDir: testDir,
    });
    await sessionQueuePersistenceService.initialize();
    await sessionQueuePersistenceService.replaceAll([
      makePersistedSessionQueueItem({
        id: "persisted-2",
        message: { text: "second recovered" },
        queuedAt: "2026-06-30T00:00:02.000Z",
      }),
      makePersistedSessionQueueItem({
        id: "persisted-1",
        message: { text: "first recovered" },
        queuedAt: "2026-06-30T00:00:01.000Z",
      }),
      makePersistedSessionQueueItem({
        id: "live-patient",
        message: { text: "not recovered" },
        status: "queued",
      }),
    ]);

    const routes = createGlobalProjectQueueRoutes({
      projectQueueService: service,
      sessionQueuePersistenceService,
      sessionMetadataService: {
        getMetadata: vi.fn((sessionId: string) =>
          sessionId === "session-1"
            ? { customTitle: "Recovered session" }
            : undefined,
        ),
      } as unknown as SessionMetadataService,
    });
    const response = await routes.request("/");

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.recoveredSessionQueues).toMatchObject([
      {
        id: "persisted-1",
        sessionId: "session-1",
        projectId,
        content: "first recovered",
        status: "paused-after-restart",
        kind: "patient",
        sessionTitle: "Recovered session",
      },
      {
        id: "persisted-2",
        content: "second recovered",
      },
    ]);
  });

  it("queues a limited user's item under their launch policy, and only lets them change their own", async () => {
    const limited: Principal = {
      kind: "limited",
      username: "alice",
      grants: {
        newSessionProjects: [projectId],
        joinProjects: [],
        viewProjects: [],
        joinStaleOffsetMinutes: 0,
        lock: { model: "gpt-5" },
      },
      switched: false,
      locked: true,
      via: "direct",
    };
    const app = new Hono<{
      Variables: Record<typeof PRINCIPAL_VARIABLE, Principal>;
    }>();
    app.use("*", async (c, next) => {
      c.set(PRINCIPAL_VARIABLE, limited);
      await next();
    });
    app.route("/", createRoutes());
    const send = (method: string, url: string, body: unknown) =>
      app.request(url, {
        method,
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      });

    const remote = await send("POST", `/${projectId}/queue`, {
      target: { type: "new-session", executor: "devbox" },
      message: { text: "run elsewhere" },
    });
    expect(remote.status).toBe(403);
    const command = await send("POST", `/${projectId}/queue`, {
      target: { type: "existing-session", sessionId: "session-1" },
      message: {
        text: "/clear 1",
        yaCommand: { name: "clear", argument: "1" },
      },
    });
    expect(command.status).toBe(403);

    const created = await send("POST", `/${projectId}/queue`, {
      target: { type: "new-session", sandboxLevel: "none" },
      message: { text: "start as alice" },
    });
    expect(created.status).toBe(201);
    const { item } = (await created.json()) as {
      item: ProjectQueueItemSummary;
    };
    expect(item.createdByUser).toBe("alice");
    expect(item.target).toMatchObject({
      type: "new-session",
      sandboxLevel: "project-write",
      model: "gpt-5",
    });

    const superuserItem = await service.createItem({
      creationProvenance: { surface: "api" },
      projectId,
      projectPath: project.path,
      request: {
        target: { type: "existing-session", sessionId: "session-1" },
        message: { text: "superuser's turn" },
      },
    });
    const foreign = await send(
      "PATCH",
      `/${projectId}/queue/${superuserItem.id}`,
      { message: { text: "rewritten by alice" } },
    );
    expect(foreign.status).toBe(404);
    const foreignDelete = await app.request(
      `/${projectId}/queue/${superuserItem.id}`,
      { method: "DELETE" },
    );
    expect(foreignDelete.status).toBe(404);
    const own = await send("PATCH", `/${projectId}/queue/${item.id}`, {
      message: { text: "edited by alice" },
    });
    expect(own.status).toBe(200);
  });

  it("counts a queued prompt in the usage ledger when it is queued", async () => {
    const userUsageService = new UserUsageService({ dataDir: testDir });
    const limited: Principal = {
      kind: "limited",
      username: "alice",
      grants: {
        newSessionProjects: [projectId],
        joinProjects: [projectId],
        viewProjects: [],
        joinStaleOffsetMinutes: 0,
        lock: {},
      },
      switched: false,
      locked: false,
      via: "direct",
    };
    let principal: Principal = limited;
    const app = new Hono<{
      Variables: Record<typeof PRINCIPAL_VARIABLE, Principal>;
    }>();
    app.use("*", async (c, next) => {
      c.set(PRINCIPAL_VARIABLE, principal);
      await next();
    });
    app.route("/", createRoutes({ userUsageService }));
    const queue = (body: unknown) =>
      app.request(`/${projectId}/queue`, {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      });

    const newSession = await queue({
      target: { type: "new-session" },
      message: { text: "start three words" },
    });
    expect(newSession.status).toBe(201);
    principal = { kind: "superuser" };
    const followUp = await queue({
      target: { type: "existing-session", sessionId: "session-1" },
      message: { text: "then this" },
    });
    expect(followUp.status).toBe(201);
    const command = await queue({
      target: { type: "existing-session", sessionId: "session-1" },
      message: {
        text: "/clear 1",
        yaCommand: { name: "clear", argument: "1" },
      },
    });
    expect(command.status).toBe(201);

    const report = await userUsageService.report(["alice"]);
    expect(
      report.users.find((user) => user.username === "alice")?.total,
    ).toMatchObject({ sessions: 1, turns: 1, words: 3 });
    // The queued YA command is no turn, as on the session routes.
    expect(
      report.users.find((user) => user.username === null)?.total,
    ).toMatchObject({ sessions: 0, turns: 1, words: 2 });
  });

  it("shows a limited user only their granted projects' queue", async () => {
    const otherProjectId = toUrlProjectId("/tmp/project-queue-route-other");
    const grantedItem = await service.createItem({
      creationProvenance: { surface: "api" },
      projectId,
      projectPath: project.path,
      request: {
        target: { type: "existing-session", sessionId: "session-1" },
        message: { text: "granted prompt" },
      },
    });
    await service.createItem({
      creationProvenance: { surface: "api" },
      projectId: otherProjectId,
      projectPath: "/tmp/project-queue-route-other",
      request: {
        target: { type: "existing-session", sessionId: "other-session" },
        message: { text: "someone else's prompt" },
      },
    });
    const sessionQueuePersistenceService = new SessionQueuePersistenceService({
      dataDir: testDir,
    });
    await sessionQueuePersistenceService.initialize();
    await sessionQueuePersistenceService.replaceAll([
      makePersistedSessionQueueItem({ id: "granted-recovered" }),
      makePersistedSessionQueueItem({
        id: "other-recovered",
        sessionId: "other-session",
        projectId: otherProjectId,
        projectPath: "/tmp/project-queue-route-other",
        message: { text: "someone else's recovered prompt" },
      }),
    ]);
    const statusFor = (id: UrlProjectId, sessionId: string) => ({
      projectId: id,
      state: "blocked" as const,
      idle: false,
      blockers: [`${sessionId}:in-turn`],
      dispatchPaused: false,
      inFlight: false,
      quietWindowMs: 30_000,
      itemCount: 1,
    });
    const projectQueueScheduler = {
      getProjectStatus: vi.fn(async (id: UrlProjectId) =>
        statusFor(id, id === projectId ? "session-1" : "other-session"),
      ),
      promoteNow: vi.fn(async (id: UrlProjectId) => ({
        promoted: false,
        reason: "blocked" as const,
        status: statusFor(id, "session-1"),
      })),
    };
    const global = createGlobalRoutes({
      projectQueueScheduler,
      sessionQueuePersistenceService,
      sessionMetadataService: {
        getMetadata: vi.fn((sessionId: string) => ({
          customTitle:
            sessionId === "session-1" ? "Granted session" : "Private title",
        })),
      } as unknown as SessionMetadataService,
    });
    const limited: Principal = {
      kind: "limited",
      username: "alice",
      grants: {
        newSessionProjects: [projectId],
        joinProjects: [],
        viewProjects: [],
        joinStaleOffsetMinutes: 0,
        lock: {},
      },
      switched: false,
      locked: true,
      via: "direct",
    };
    const app = new Hono<{
      Variables: Record<typeof PRINCIPAL_VARIABLE, Principal>;
    }>();
    app.use("*", async (c, next) => {
      c.set(PRINCIPAL_VARIABLE, limited);
      await next();
    });
    app.route("/", global);

    const expectScoped = (body: ProjectQueueListResponse) => {
      expect(body.items.map((item) => item.id)).toEqual([grantedItem.id]);
      expect(body.recoveredSessionQueues?.map((item) => item.id)).toEqual([
        "granted-recovered",
      ]);
      expect(Object.keys(body.projectStatuses ?? {})).toEqual([projectId]);
      expect(JSON.stringify(body)).not.toContain("Private title");
      expect(JSON.stringify(body)).not.toContain("someone else's");
    };

    const listResponse = await app.request("/");
    expect(listResponse.status).toBe(200);
    expectScoped(await listResponse.json());

    const promoteResponse = await app.request(`/${projectId}/promote-now`, {
      method: "POST",
    });
    expect(promoteResponse.status).toBe(200);
    expectScoped(await promoteResponse.json());

    // The superuser still sees every project.
    const superuserBody = await (await global.request("/")).json();
    expect(superuserBody.items).toHaveLength(2);
    expect(Object.keys(superuserBody.projectStatuses)).toHaveLength(2);
  });

  it("pauses and resumes project queue dispatch globally", async () => {
    await service.createItem({
      creationProvenance: { surface: "api" },
      projectId,
      projectPath: project.path,
      request: {
        target: { type: "existing-session", sessionId: "session-1" },
        message: { text: "pause this queue" },
      },
    });

    const routes = createGlobalRoutes();
    const pauseResponse = await routes.request("/pause", { method: "POST" });
    expect(pauseResponse.status).toBe(200);
    expect(await pauseResponse.json()).toMatchObject({
      dispatchState: { status: "paused", reason: "manual" },
      items: [{ messagePreview: "pause this queue" }],
    });

    const resumeResponse = await routes.request("/resume", { method: "POST" });
    expect(resumeResponse.status).toBe(200);
    expect(await resumeResponse.json()).toMatchObject({
      dispatchState: { status: "running" },
      items: [{ messagePreview: "pause this queue" }],
    });
  });

  it("rejects pausing an empty project queue", async () => {
    const response = await createGlobalRoutes().request("/pause", {
      method: "POST",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "Invalid project queue request",
    });
  });
});

function makeSessionSummary(sessionId: string, title: string): SessionSummary {
  return {
    id: sessionId,
    projectId: toUrlProjectId("/tmp/project-queue-route"),
    title,
    fullTitle: `Full ${title}`,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:01:00.000Z",
    messageCount: 2,
    ownership: { owner: "none" },
    provider: "claude",
  };
}

function makeReader(): ISessionReader {
  return {
    listSessions: vi.fn(async () => []),
    getSessionSummary: vi.fn(async () => null),
    getSession: vi.fn(async () => null),
    getSessionSummaryIfChanged: vi.fn(async () => null),
    getAgentMappings: vi.fn(async () => []),
    getAgentSession: vi.fn(async () => null),
  };
}

function makeSessionIndexService(
  summary: SessionSummary | null,
): ISessionIndexService {
  return {
    initialize: vi.fn(async () => {}),
    getSessionsWithCache: vi.fn(async () => (summary ? [summary] : [])),
    getSessionSummaryWithCache: vi.fn(async () => summary),
    getCachedSessionSummary: vi.fn(async () => summary),
    getSessionTitle: vi.fn(async () => summary?.title ?? null),
    invalidateSession: vi.fn(),
    clearCache: vi.fn(),
  };
}
