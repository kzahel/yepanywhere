import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toUrlProjectId, type UrlProjectId } from "@yep-anywhere/shared";
import { describe, expect, it, vi } from "vitest";
import { ProjectMetadataService } from "../../src/metadata/index.js";
import { clearProjectCaptionCache } from "../../src/projects/projectCaption.js";
import { ProjectScanner } from "../../src/projects/scanner.js";
import { createProjectsRoutes } from "../../src/routes/projects.js";
import type { CodexSessionReader } from "../../src/sessions/codex-reader.js";
import type { ISessionReader } from "../../src/sessions/types.js";
import type { Project, SessionSummary } from "../../src/supervisor/types.js";
import { EventBus } from "../../src/watcher/index.js";

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
    title: "Codex project session",
    fullTitle: "Codex project session",
    createdAt: new Date("2026-03-10T09:45:00.000Z").toISOString(),
    updatedAt: new Date("2026-03-10T09:46:00.000Z").toISOString(),
    messageCount: 1,
    ownership: { owner: "none" },
    provider: "codex",
  };
}

function createProcess(
  projectId: UrlProjectId,
  options: {
    state?: { type: "idle" | "in-turn" | "waiting-input" };
    queueDepth?: number;
    retainingProviderWork?: boolean;
    deferredQueueDepth?: number;
    pendingInput?: unknown;
    livenessStatus?: string;
  } = {},
) {
  return {
    projectId,
    state: options.state ?? { type: "idle" },
    queueDepth: options.queueDepth ?? 0,
    isRetainingProviderWork: vi.fn(
      () => options.retainingProviderWork ?? false,
    ),
    getDeferredQueueSummary: vi.fn(() =>
      Array.from({ length: options.deferredQueueDepth ?? 0 }, () => ({})),
    ),
    getPendingInputRequest: vi.fn(() => options.pendingInput ?? null),
    getLivenessSnapshot: vi.fn(() => ({
      derivedStatus: options.livenessStatus ?? "verified-idle",
    })),
  };
}

describe("Projects Routes", () => {
  it("serves registered projects without foreground discovery", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "retained-projects-route-"));
    const metadata = new ProjectMetadataService({ dataDir });
    await metadata.initialize();
    const projectId = toUrlProjectId(dataDir);
    await metadata.addProject(projectId, dataDir, "alice");
    await metadata.setProjectNameOverride(projectId, "Current name");
    const scanner = new ProjectScanner({
      projectsDir: join(dataDir, "no-transcripts"),
      enableCodex: false,
      enableGemini: false,
      projectMetadataService: metadata,
    });
    const discover = vi
      .spyOn(scanner, "listProjects")
      .mockRejectedValue(new Error("foreground discovery"));
    const routes = createProjectsRoutes({
      scanner,
      projectMetadataService: metadata,
      readerFactory: () => {
        throw new Error("foreground reader");
      },
    });
    try {
      const response = await routes.request("/?summaryMode=retained");
      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.projects).toHaveLength(1);
      expect(result.projects[0]).toMatchObject({
        id: projectId,
        name: "Current name",
        ownerUsername: "alice",
      });
      expect(result.catalog).toMatchObject({
        complete: false,
        refreshing: true,
      });
      expect(discover).not.toHaveBeenCalled();
      await metadata.hideProject(projectId, dataDir);
      expect(
        (await (await routes.request("/?summaryMode=retained")).json())
          .projects,
      ).toEqual([]);
    } finally {
      await scanner.dispose();
      await rm(dataDir, { recursive: true });
    }
  });

  it("uses content rather than housekeeping recency for project unread state", async () => {
    const project = { ...createProject(), provider: "grok" as const };
    const summary = { ...createSummary(), provider: "grok" as const };
    const process = {
      ...createProcess(project.id),
      lastProviderContentTime: new Date("2026-03-10T09:48:00.000Z"),
      lastProviderMessageTime: new Date("2026-03-10T09:55:00.000Z"),
    };
    const routes = createProjectsRoutes({
      scanner: {
        getOrCreateProject: async () => project,
      } as unknown as ProjectScanner,
      readerFactory: () =>
        ({ listSessions: async () => [summary] }) as unknown as ISessionReader,
      supervisor: {
        getProcessForSession: () => process,
        getAllProcesses: () => [],
      } as unknown as Parameters<typeof createProjectsRoutes>[0]["supervisor"],
      notificationService: {
        getLastSeen: () => ({ timestamp: "2026-03-10T09:49:00.000Z" }),
        hasUnread: (_id: string, updatedAt: string) =>
          updatedAt > "2026-03-10T09:49:00.000Z",
      } as unknown as Parameters<
        typeof createProjectsRoutes
      >[0]["notificationService"],
    });
    const read = await routes.request("/proj-1/sessions");
    expect(read.status).toBe(200);
    expect((await read.json()).sessions[0]).toMatchObject({
      updatedAt: "2026-03-10T09:48:00.000Z",
      hasUnread: false,
    });
    process.lastProviderContentTime = new Date("2026-03-10T09:50:00.000Z");
    const unread = await routes.request("/proj-1/sessions");
    expect(unread.status).toBe(200);
    expect((await unread.json()).sessions[0]).toMatchObject({
      updatedAt: "2026-03-10T09:50:00.000Z",
      hasUnread: true,
    });
  });

  it("shows retained provider background work as session activity", async () => {
    const project = createProject();
    const summary = createSummary();
    const process = createProcess(project.id, {
      state: { type: "idle" },
      retainingProviderWork: true,
    });
    const routes = createProjectsRoutes({
      scanner: {
        getOrCreateProject: async () => project,
      } as unknown as ProjectScanner,
      readerFactory: () =>
        ({ listSessions: async () => [summary] }) as unknown as ISessionReader,
      supervisor: {
        getProcessForSession: () => process,
        getAllProcesses: () => [],
      } as unknown as Parameters<typeof createProjectsRoutes>[0]["supervisor"],
    });

    const response = await routes.request("/proj-1/sessions");
    expect(response.status).toBe(200);
    expect((await response.json()).sessions[0]).toMatchObject({
      activity: "in-turn",
    });
  });

  it("enriches project list responses with Project Queue counts", async () => {
    const project = createProject();
    const listAll = vi.fn();
    const routes = createProjectsRoutes({
      scanner: {
        listProjects: vi.fn(async () => [
          project,
          { ...project, id: toUrlProjectId("/other-project") },
        ]),
      } as unknown as ProjectScanner,
      readerFactory: vi.fn(),
      projectQueueService: {
        listAll: listAll.mockImplementation(() => [
          {
            id: "queue-1",
            projectId: project.id,
            target: { type: "new-session" },
            messagePreview: "Queued session",
            message: { text: "Queued session" },
            createdAt: "2026-03-10T09:45:00.000Z",
            updatedAt: "2026-03-10T09:45:00.000Z",
            status: "queued",
            attachmentCount: 0,
          },
          {
            id: "queue-2",
            projectId: project.id,
            target: { type: "existing-session", sessionId: "sess-1" },
            messagePreview: "Sending now",
            message: { text: "Sending now" },
            createdAt: "2026-03-10T09:46:00.000Z",
            updatedAt: "2026-03-10T09:46:00.000Z",
            status: "dispatching",
            attachmentCount: 0,
          },
          {
            id: "queue-3",
            projectId: project.id,
            target: { type: "existing-session", sessionId: "sess-2" },
            messagePreview: "Needs retry",
            message: { text: "Needs retry" },
            createdAt: "2026-03-10T09:47:00.000Z",
            updatedAt: "2026-03-10T09:47:00.000Z",
            status: "failed",
            attachmentCount: 0,
          },
        ]),
        listProject: vi.fn(),
      } as unknown as Parameters<
        typeof createProjectsRoutes
      >[0]["projectQueueService"],
      projectMetadataService: {
        ensureProjectCodeNames: vi.fn(async () => ({
          assignments: [{ projectId: project.id, codeName: "prj" }],
          changedProjectIds: [],
        })),
        getProjectCaptionOverride: () => undefined,
      } as unknown as ProjectMetadataService,
    });

    const response = await routes.request("/");
    expect(response.status).toBe(200);

    const json = await response.json();
    expect(listAll).toHaveBeenCalledTimes(1);
    expect(json.projects[1].projectQueueCount).toBe(0);
    expect(json.projects[0]).toMatchObject({
      id: project.id,
      codeName: "prj",
      projectQueueCount: 2,
    });
  });

  it("derives a caption from the project README and honors an override", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "ya-caption-route-"));
    const projectDir = await mkdtemp(join(tmpdir(), "ya-caption-project-"));
    try {
      await writeFile(
        join(projectDir, "README.md"),
        "# tiny\n\nA project whose README opens with a real sentence for YA.\n",
      );
      const metadata = new ProjectMetadataService({ dataDir });
      await metadata.initialize();
      const project = {
        ...createProject(),
        id: toUrlProjectId(projectDir),
        path: projectDir,
        name: "captioned",
      };
      const emit = vi.fn();
      const routes = createProjectsRoutes({
        scanner: {
          listProjects: vi.fn(async () => [project]),
          getProject: vi.fn(async (id: string) =>
            id === project.id ? project : null,
          ),
        } as unknown as ProjectScanner,
        readerFactory: vi.fn(),
        projectMetadataService: metadata,
        eventBus: { emit } as unknown as NonNullable<
          Parameters<typeof createProjectsRoutes>[0]["eventBus"]
        >,
      });

      const listed = await routes.request("/");
      expect(listed.status).toBe(200);
      expect((await listed.json()).projects[0].caption).toEqual({
        text: "A project whose README opens with a real sentence for YA.",
        source: "readme",
      });

      const patched = await routes.request(`/${project.id}/caption`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ caption: "  Custom   text " }),
      });
      expect(patched.status).toBe(200);
      await expect(patched.json()).resolves.toEqual({
        caption: { text: "Custom text", source: "override" },
      });
      expect(emit).toHaveBeenCalledWith({
        type: "project-captions-changed",
        projectIds: [project.id],
        timestamp: expect.any(String),
      });
      expect(
        (await (await routes.request("/")).json()).projects[0].caption,
      ).toMatchObject({ source: "override" });

      const cleared = await routes.request(`/${project.id}/caption`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ caption: "" }),
      });
      expect(cleared.status).toBe(200);
      await expect(cleared.json()).resolves.toMatchObject({
        caption: { source: "readme" },
      });

      const tooLong = await routes.request(`/${project.id}/caption`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ caption: "x".repeat(301) }),
      });
      expect(tooLong.status).toBe(400);
    } finally {
      clearProjectCaptionCache();
      await rm(dataDir, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("refuses a caption for a directory that is not a listed project", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "ya-caption-route-"));
    const otherDir = await mkdtemp(join(tmpdir(), "ya-caption-other-"));
    try {
      const metadata = new ProjectMetadataService({ dataDir });
      await metadata.initialize();
      const emit = vi.fn();
      const scanner = new ProjectScanner({
        projectsDir: join(dataDir, "no-claude-projects"),
        enableCodex: false,
        enableGemini: false,
        projectMetadataService: metadata,
      });
      const routes = createProjectsRoutes({
        scanner,
        readerFactory: vi.fn(),
        projectMetadataService: metadata,
        eventBus: { emit } as unknown as NonNullable<
          Parameters<typeof createProjectsRoutes>[0]["eventBus"]
        >,
      });
      const otherId = toUrlProjectId(otherDir);

      const patched = await routes.request(`/${otherId}/caption`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ caption: "Not a project of mine" }),
      });

      expect(patched.status).toBe(404);
      expect(metadata.getProjectCaptionOverride(otherId)).toBeUndefined();
      expect(emit).not.toHaveBeenCalled();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
      await rm(otherDir, { recursive: true, force: true });
    }
  });

  it("reports what a typed project path holds before anything is added", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ya-folder-state-"));
    try {
      await mkdir(join(dir, "empty"));
      await mkdir(join(dir, "repo"));
      await writeFile(join(dir, "repo", "README.md"), "hi\n");
      await writeFile(join(dir, "note.txt"), "x\n");
      const routes = createProjectsRoutes({
        scanner: new ProjectScanner({
          projectsDir: join(dir, "no-claude-projects"),
          enableCodex: false,
          enableGemini: false,
        }),
        readerFactory: vi.fn(),
      });
      const stateOf = async (path: string) => {
        const response = await routes.request(
          `/folder-state?path=${encodeURIComponent(path)}`,
        );
        expect(response.status).toBe(200);
        return ((await response.json()) as { state: string }).state;
      };

      expect(await stateOf(join(dir, "missing"))).toBe("missing");
      expect(await stateOf(join(dir, "empty"))).toBe("empty");
      expect(await stateOf(`${join(dir, "repo")}/`)).toBe("contents");
      expect(await stateOf(join(dir, "note.txt"))).toBe("file");
      expect((await routes.request("/folder-state?path=rel")).status).toBe(400);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("adds a project under a chosen name and code, then announces the change", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "ya-named-route-"));
    const projectDir = await mkdtemp(join(tmpdir(), "ya-named-project-"));
    try {
      const metadata = new ProjectMetadataService({ dataDir });
      await metadata.initialize();
      const scanner = new ProjectScanner({
        projectsDir: join(dataDir, "claude-projects"),
        projectMetadataService: metadata,
        enableCodex: false,
        enableGemini: false,
      });
      const emit = vi.fn();
      const routes = createProjectsRoutes({
        scanner,
        readerFactory: vi.fn(),
        projectMetadataService: metadata,
        eventBus: { emit } as unknown as NonNullable<
          Parameters<typeof createProjectsRoutes>[0]["eventBus"]
        >,
      });
      const projectId = toUrlProjectId(projectDir);
      const post = (body: unknown) =>
        routes.request("/", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });

      // A rejected name adds nothing.
      const tooLong = await post({ path: projectDir, name: "x".repeat(81) });
      expect(tooLong.status).toBe(400);
      expect(metadata.isAddedProject(projectId)).toBe(false);

      const added = await post({
        path: projectDir,
        name: "  Chosen   Name ",
        codeName: "chs",
      });
      expect(added.status).toBe(200);
      expect((await added.json()).project).toMatchObject({
        id: projectId,
        name: "Chosen Name",
        codeName: "chs",
      });
      expect(emit).toHaveBeenCalledWith({
        type: "projects-changed",
        projectIds: [projectId],
        timestamp: expect.any(String),
      });

      // Every later read carries the chosen name.
      const listed = (await (await routes.request("/")).json()).projects;
      expect(
        listed.find((p: { id: string }) => p.id === projectId),
      ).toMatchObject({ name: "Chosen Name", codeName: "chs" });

      const patch = (name: string | null) =>
        routes.request(`/${projectId}/name`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name }),
        });
      expect((await patch("x".repeat(81))).status).toBe(400);
      const renamed = await patch("Renamed");
      expect(renamed.status).toBe(200);
      await expect(renamed.json()).resolves.toEqual({ name: "Renamed" });
      const cleared = await patch(null);
      expect(cleared.status).toBe(200);
      await expect(cleared.json()).resolves.toEqual({
        name: projectDir.slice(projectDir.lastIndexOf("/") + 1),
      });

      emit.mockClear();
      const removed = await routes.request(`/${projectId}`, {
        method: "DELETE",
      });
      expect(removed.status).toBe(200);
      expect(emit).toHaveBeenCalledWith({
        type: "projects-changed",
        projectIds: [projectId],
        timestamp: expect.any(String),
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("publishes automatic code-name collision reassignments", async () => {
    const alpha = {
      ...createProject(),
      id: toUrlProjectId("/tmp/alpha"),
      path: "/tmp/alpha",
      name: "Alpha",
    };
    const alpine = {
      ...createProject(),
      id: toUrlProjectId("/tmp/alpine"),
      path: "/tmp/alpine",
      name: "Alpine",
    };
    const emit = vi.fn();
    const routes = createProjectsRoutes({
      scanner: {
        listProjects: vi.fn(async () => [alpha, alpine]),
      } as unknown as ProjectScanner,
      readerFactory: vi.fn(),
      projectMetadataService: {
        ensureProjectCodeNames: vi.fn(async () => ({
          assignments: [
            { projectId: alpha.id, codeName: "alph" },
            { projectId: alpine.id, codeName: "alpi" },
          ],
          changedProjectIds: [alpha.id, alpine.id],
        })),
        getProjectCaptionOverride: () => undefined,
      } as unknown as ProjectMetadataService,
      eventBus: { emit } as unknown as NonNullable<
        Parameters<typeof createProjectsRoutes>[0]["eventBus"]
      >,
    });

    expect((await routes.request("/")).status).toBe(200);
    expect(emit).toHaveBeenCalledWith({
      type: "project-code-names-changed",
      projectIds: [alpha.id, alpine.id],
      timestamp: expect.any(String),
    });
  });

  it("invalidates two connected clients after Alpha gains an Alpine peer", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "ya-code-name-route-"));
    try {
      const metadata = new ProjectMetadataService({ dataDir });
      await metadata.initialize();
      const alpha = {
        ...createProject(),
        id: toUrlProjectId("/tmp/alpha"),
        path: "/tmp/alpha",
        name: "Alpha",
      };
      const alpine = {
        ...createProject(),
        id: toUrlProjectId("/tmp/alpine"),
        path: "/tmp/alpine",
        name: "Alpine",
      };
      let visibleProjects = [alpha];
      const eventBus = new EventBus();
      const firstClient = vi.fn();
      const secondClient = vi.fn();
      eventBus.subscribe(firstClient);
      eventBus.subscribe(secondClient);
      const routes = createProjectsRoutes({
        scanner: {
          listProjects: vi.fn(async () => visibleProjects),
        } as unknown as ProjectScanner,
        readerFactory: vi.fn(),
        projectMetadataService: metadata,
        eventBus,
      });

      expect((await routes.request("/")).status).toBe(200);
      firstClient.mockClear();
      secondClient.mockClear();
      visibleProjects = [alpha, alpine];

      const response = await routes.request("/");
      expect(response.status).toBe(200);
      const event = {
        type: "project-code-names-changed",
        projectIds: [alpha.id, alpine.id].sort(),
        timestamp: expect.any(String),
      };
      expect(firstClient).toHaveBeenCalledWith(event);
      expect(secondClient).toHaveBeenCalledWith(event);
      await expect(response.json()).resolves.toMatchObject({
        projects: expect.arrayContaining([
          expect.objectContaining({ id: alpha.id, codeName: "alph" }),
          expect.objectContaining({ id: alpine.id, codeName: "alpi" }),
        ]),
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("lists mixed-provider sessions through the shared provider resolver", async () => {
    const project = createProject();
    const summary = createSummary();
    const claudeReader = {
      listSessions: vi.fn(async () => []),
      listProviderChildSessions: vi.fn(async () => []),
    } as unknown as ISessionReader;
    const children = [
      {
        id: "child-1",
        parentSessionId: "sess-1",
        title: "Review the restart guard",
        updatedAt: "2026-08-16T12:00:00.000Z",
      },
    ];
    const listProviderChildSessions = vi.fn(async () => {
      throw new Error("list reads must not cold-parse Codex children");
    });
    const codexReader = {
      listSessions: vi.fn(async () => [summary]),
      listAcceptedProviderChildSessions: vi.fn(() => children),
      listProviderChildSessions,
    } as unknown as ISessionReader;

    const routes = createProjectsRoutes({
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as ProjectScanner,
      readerFactory: vi.fn(() => claudeReader),
      codexScanner: {
        listProjects: vi.fn(async () => [{ ...project, provider: "codex" }]),
      } as unknown as NonNullable<
        Parameters<typeof createProjectsRoutes>[0]["codexScanner"]
      >,
      codexSessionsDir: "/tmp/codex-sessions",
      codexReaderFactory: vi.fn(
        () => codexReader as unknown as CodexSessionReader,
      ),
      sessionAutoArchiveDays: 0,
    });

    const response = await routes.request("/proj-1/sessions");
    expect(response.status).toBe(200);

    const json = await response.json();
    expect(json.sessions).toHaveLength(1);
    expect(json.sessions[0]).toMatchObject({
      id: "sess-1",
      title: "Codex project session",
      provider: "codex",
      providerChildren: children,
    });
    expect(listProviderChildSessions).not.toHaveBeenCalled();
  });

  it("enriches single-project responses with live activity counts", async () => {
    const project = {
      ...createProject(),
      id: toUrlProjectId("/tmp/project"),
    };
    const routes = createProjectsRoutes({
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as ProjectScanner,
      readerFactory: vi.fn(),
      supervisor: {
        getAllProcesses: vi.fn(() => [
          createProcess(project.id),
          createProcess(project.id, { state: { type: "in-turn" } }),
          createProcess(toUrlProjectId("/tmp/other"), {
            state: { type: "in-turn" },
          }),
        ]),
        getQueueInfo: vi.fn(() => []),
      } as unknown as Parameters<typeof createProjectsRoutes>[0]["supervisor"],
      externalTracker: {
        getExternalSessions: vi.fn(() => ["external-1", "external-2"]),
        getExternalSessionInfoWithUrlId: vi
          .fn()
          .mockResolvedValueOnce({
            projectId: project.id,
            lastActivity: new Date("2026-03-10T09:47:00.000Z"),
          })
          .mockResolvedValueOnce({
            projectId: toUrlProjectId("/tmp/other"),
            lastActivity: new Date("2026-03-10T09:48:00.000Z"),
          }),
      } as unknown as Parameters<
        typeof createProjectsRoutes
      >[0]["externalTracker"],
    });

    const response = await routes.request(`/${project.id}`);
    expect(response.status).toBe(200);

    const json = await response.json();
    expect(json.project).toMatchObject({
      id: project.id,
      activeOwnedCount: 2,
      activeExternalCount: 1,
      projectQueueBlockingCount: 2,
    });
  });

  it("hides a project from YA lists", async () => {
    const project = {
      ...createProject(),
      id: toUrlProjectId("/tmp/project"),
    };
    const scanner = {
      getProject: vi.fn(async () => project),
      invalidateCache: vi.fn(),
    } as unknown as ProjectScanner;
    const projectMetadataService = {
      hideProject: vi.fn(async () => {}),
    } as unknown as ProjectMetadataService;

    const routes = createProjectsRoutes({
      scanner,
      readerFactory: vi.fn(),
      projectMetadataService,
    });

    const response = await routes.request(`/${project.id}`, {
      method: "DELETE",
    });
    expect(response.status).toBe(200);

    const json = await response.json();
    expect(json).toMatchObject({
      removed: true,
      projectId: project.id,
      path: project.path,
    });
    expect(projectMetadataService.hideProject).toHaveBeenCalledWith(
      project.id,
      project.path,
    );
    expect(scanner.invalidateCache).toHaveBeenCalledTimes(1);
  });

  it("edits a code name and publishes every atomic reassignment", async () => {
    const project = {
      ...createProject(),
      id: toUrlProjectId("/tmp/project"),
    };
    const otherProject = {
      ...createProject(),
      id: toUrlProjectId("/tmp/other"),
      path: "/tmp/other",
      name: "other",
    };
    const assignments = [
      { projectId: project.id, codeName: "oth" },
      { projectId: otherProject.id, codeName: "otr" },
    ];
    const setProjectCodeName = vi.fn(async () => ({
      assignments,
      changedProjectIds: [project.id, otherProject.id],
    }));
    const emit = vi.fn();
    const routes = createProjectsRoutes({
      scanner: {
        getProject: vi.fn(async () => project),
        listProjects: vi.fn(async () => [project, otherProject]),
      } as unknown as ProjectScanner,
      readerFactory: vi.fn(),
      projectMetadataService: {
        ensureProjectCodeNames: vi.fn(async () => ({
          assignments: [],
          changedProjectIds: [],
        })),
        setProjectCodeName,
        getProjectCaptionOverride: () => undefined,
      } as unknown as ProjectMetadataService,
      eventBus: { emit } as unknown as NonNullable<
        Parameters<typeof createProjectsRoutes>[0]["eventBus"]
      >,
    });

    const response = await routes.request(`/${project.id}/code-name`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ codeName: "oth" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ assignments });
    expect(setProjectCodeName).toHaveBeenCalledWith(project.id, "oth", [
      project,
      otherProject,
    ]);
    expect(emit).toHaveBeenCalledWith({
      type: "project-code-names-changed",
      projectIds: [project.id, otherProject.id],
      timestamp: expect.any(String),
    });
  });

  it("returns 404 when hiding an unknown project", async () => {
    const routes = createProjectsRoutes({
      scanner: {
        getProject: vi.fn(async () => null),
        invalidateCache: vi.fn(),
      } as unknown as ProjectScanner,
      readerFactory: vi.fn(),
      projectMetadataService: {
        hideProject: vi.fn(async () => {}),
      } as unknown as ProjectMetadataService,
    });

    const response = await routes.request(
      `/${toUrlProjectId("/tmp/missing")}`,
      {
        method: "DELETE",
      },
    );
    expect(response.status).toBe(404);
  });
});
