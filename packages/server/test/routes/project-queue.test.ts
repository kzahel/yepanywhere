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
import { claudeCwdProjectDirectory } from "../../src/projects/claude-project-directory.js";
import { ProjectScanner } from "../../src/projects/scanner.js";
import {
  createGlobalProjectQueueRoutes,
  createProjectQueueRoutes,
} from "../../src/routes/project-queue.js";
import { RetainedSessionCollections } from "../../src/services/RetainedSessionCollections.js";
import { seedTestCatalog } from "../utils/session-catalog.js";
import {
  closeTestDiscoveryDatabases,
  openTestDiscoveryDatabase,
} from "../utils/session-metadata-database.js";
import {
  catalogAdaptersForRows,
  buildCatalogRow,
} from "../../src/sessions/catalog-adapters/row.js";
import { ProjectQueueService } from "../../src/services/ProjectQueueService.js";
import {
  type PersistedSessionQueuedMessage,
  SessionQueuePersistenceService,
} from "../../src/services/SessionQueuePersistenceService.js";
import type { Project } from "../../src/supervisor/types.js";
import type { SessionMetadataService } from "../../src/metadata/index.js";

describe("Project Queue Routes", () => {
  let testDir: string;
  let projectId: UrlProjectId;
  let project: Project;
  let service: ProjectQueueService;
  const catalogs: RetainedSessionCollections[] = [];

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
    await Promise.all(catalogs.splice(0).map((catalog) => catalog.dispose()));
    closeTestDiscoveryDatabases();
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

  it("reuses retained project identity after its inventory TTL expires", async () => {
    const store = path.join(testDir, "claude");
    async function seed(name: string) {
      const cwd = path.join(testDir, name);
      const directory = path.join(store, claudeCwdProjectDirectory(cwd));
      await fs.mkdir(cwd, { recursive: true });
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(
        path.join(directory, `${name}.jsonl`),
        JSON.stringify({
          type: "user",
          cwd,
          sessionId: name,
          uuid: "human",
          message: { role: "user", content: "Native project" },
          timestamp: new Date().toISOString(),
        }) + "\n",
      );
      return cwd;
    }
    const first = await seed("first");
    const scanner = new ProjectScanner({
      projectsDir: store,
      enableCodex: false,
      enableGemini: false,
      cacheTtlMs: 0,
    });
    try {
      expect(await scanner.listProjects()).toHaveLength(1);
      await seed("second");
      const routes = createProjectQueueRoutes({
        scanner,
        projectQueueService: service,
      });
      for (let count = 0; count < 5; count++)
        expect(
          (await routes.request(`/${toUrlProjectId(first)}/queue`)).status,
        ).toBe(200);
      expect(scanner.cachedProjects()).toHaveLength(1);
      expect(await scanner.listProjects()).toHaveLength(2);
    } finally {
      await scanner.dispose();
    }
  });

  it("restores accepted catalog titles for project/global queues and never acquires providers", async () => {
    await service.createItem({
      creationProvenance: { surface: "api" },
      projectId,
      projectPath: project.path,
      request: {
        target: { type: "existing-session", sessionId: "session-1" },
        message: { text: "queued item" },
      },
    });
    const directory = path.join(testDir, "catalog");
    const title = "A long accepted native title ".repeat(12);
    await seedTestCatalog(
      directory,
      catalogAdaptersForRows([
        buildCatalogRow({
          catalogFamily: "claude",
          storeKey: project.sessionDir,
          sessionId: "session-1",
          projectPath: project.path,
          updatedAtMs: Date.now(),
          title,
          fidelity: "head",
          sourceVersion: "one",
          location: { kind: "file", path: "not-readable-by-a-provider" },
        }),
      ]),
    );
    const acquire = vi.fn(async () => {
      throw new Error("Queue reads must not acquire native providers");
    });
    const catalog = new RetainedSessionCollections({
      dataDir: directory,
      database: openTestDiscoveryDatabase(directory),
      adapters: acquire,
    });
    catalogs.push(catalog);
    const projectRoutes = createRoutes({ retainedCollections: catalog });
    const global = createGlobalRoutes({ retainedCollections: catalog });
    for (let request = 0; request < 12; request++) {
      const response =
        request % 2
          ? await projectRoutes.request(`/${projectId}/queue`)
          : await global.request("/");
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.items[0].targetFullTitle).toBe(title);
      expect(body.items[0].targetTitle.length).toBeLessThan(title.length);
    }
    expect(acquire).not.toHaveBeenCalled();
    await catalog.dispose();
    // A stored row that no longer reassembles ends the lineage.
    const database = openTestDiscoveryDatabase(directory);
    database.exec("UPDATE session_catalog SET async_questions = '{'");
    const damaged = new RetainedSessionCollections({
      dataDir: directory,
      database,
      adapters: acquire,
    });
    catalogs.push(damaged);
    vi.useFakeTimers();
    try {
      const body = await (
        await createGlobalRoutes({ retainedCollections: damaged }).request("/")
      ).json();
      expect(body.items[0].targetTitle).toBeNull();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(acquire).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
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
    const sessionMetadataService = {
      getMetadata: vi.fn((sessionId: string) =>
        sessionId === "session-1"
          ? { customTitle: "Renamed target session" }
          : undefined,
      ),
    } as unknown as SessionMetadataService;

    const projectRoutes = createRoutes({
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
