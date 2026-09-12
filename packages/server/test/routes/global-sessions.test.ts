import type { UrlProjectId } from "@yep-anywhere/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionIndexService } from "../../src/indexes/index.js";
import type { SessionMetadataService } from "../../src/metadata/SessionMetadataService.js";
import type { NotificationService } from "../../src/notifications/index.js";
import type { ProjectScanner } from "../../src/projects/scanner.js";
import {
  type GlobalSessionsDeps,
  type GlobalSessionsResponse,
  createGlobalSessionsRoutes,
} from "../../src/routes/global-sessions.js";
import type { GeminiSessionReader } from "../../src/sessions/gemini-reader.js";
import type { ISessionReader } from "../../src/sessions/types.js";
import type { ExternalSessionTracker } from "../../src/supervisor/ExternalSessionTracker.js";
import type { Supervisor } from "../../src/supervisor/Supervisor.js";
import type { Project, SessionSummary } from "../../src/supervisor/types.js";
import { EventBus } from "../../src/watcher/EventBus.js";

// Helper to create ISO timestamps relative to now
function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

// Helper to create a mock session
function createSession(
  id: string,
  projectId: string,
  updatedAt: string,
  overrides: Partial<SessionSummary> = {},
): SessionSummary {
  return {
    id,
    projectId: projectId as UrlProjectId,
    title: `Session ${id}`,
    fullTitle: `Session ${id} full title`,
    createdAt: hoursAgo(48),
    updatedAt,
    messageCount: 5,
    ownership: { owner: "none" },
    provider: "claude",
    ...overrides,
  };
}

// Helper to create a mock project
function createProject(id: string, name: string, sessionDir: string): Project {
  return {
    id: id as UrlProjectId,
    path: `/home/user/${name}`,
    name,
    sessionCount: 1,
    sessionDir,
    activeOwnedCount: 0,
    activeExternalCount: 0,
    lastActivity: null,
    provider: "claude",
  };
}

describe("Global Sessions Routes", () => {
  let mockScanner: ProjectScanner;
  let mockReaderFactory: (project: Project) => ISessionReader;
  let mockSupervisor: Supervisor;
  let mockExternalTracker: ExternalSessionTracker;
  let mockNotificationService: NotificationService;
  let mockSessionIndexService: SessionIndexService;
  let mockMetadataService: SessionMetadataService;
  let sessionsByDir: Map<string, SessionSummary[]>;
  let processMap: Map<
    string,
    {
      id: string;
      getPendingInputRequest: () => unknown;
      state: { type: string };
      permissionMode: string;
      modeVersion: number;
      isRetainingProviderWork?: () => boolean;
      lastProviderContentTime?: Date | null;
    }
  >;
  let unreadMap: Map<string, boolean>;
  let metadataMap: Map<
    string,
    {
      customTitle?: string;
      isArchived?: boolean;
      isStarred?: boolean;
      autoResumeDisabled?: boolean;
    }
  >;
  let externalSessions: Set<string>;

  beforeEach(() => {
    sessionsByDir = new Map();
    processMap = new Map();
    unreadMap = new Map();
    metadataMap = new Map();
    externalSessions = new Set();

    // Mock scanner
    mockScanner = {
      listProjects: vi.fn(async () => []),
    } as unknown as ProjectScanner;

    // Mock reader factory
    mockReaderFactory = vi.fn((project: Project) => ({
      listSessions: vi.fn(
        async () => sessionsByDir.get(project.sessionDir) ?? [],
      ),
      getAgentMappings: vi.fn(async () => []),
      getAgentSession: vi.fn(async () => null),
    })) as unknown as (project: Project) => ISessionReader;

    // Mock supervisor
    mockSupervisor = {
      getProcessForSession: vi.fn((sessionId: string) =>
        processMap.get(sessionId),
      ),
    } as unknown as Supervisor;

    // Mock external tracker
    mockExternalTracker = {
      isExternal: vi.fn((sessionId: string) => externalSessions.has(sessionId)),
    } as unknown as ExternalSessionTracker;

    // Mock notification service
    mockNotificationService = {
      hasUnread: vi.fn(
        (sessionId: string, _updatedAt: string) =>
          unreadMap.get(sessionId) ?? false,
      ),
    } as unknown as NotificationService;

    // Mock session index service
    mockSessionIndexService = {
      getSessionsWithCache: vi.fn(
        async (
          _sessionDir: string,
          _projectId: string,
          reader: ISessionReader,
        ) => {
          return reader.listSessions(_projectId as UrlProjectId);
        },
      ),
    } as unknown as SessionIndexService;

    // Mock metadata service
    mockMetadataService = {
      getMetadata: vi.fn((sessionId: string) => metadataMap.get(sessionId)),
      getRecapMessages: vi.fn(() => []),
    } as unknown as SessionMetadataService;
  });

  function getDeps(
    overrides: Partial<GlobalSessionsDeps> = {},
  ): GlobalSessionsDeps {
    return {
      scanner: mockScanner,
      readerFactory: mockReaderFactory,
      supervisor: mockSupervisor,
      externalTracker: mockExternalTracker,
      notificationService: mockNotificationService,
      sessionIndexService: mockSessionIndexService,
      sessionMetadataService: mockMetadataService,
      ...overrides,
    };
  }

  async function makeRequest(
    queryString = "",
    overrides: Partial<GlobalSessionsDeps> = {},
  ): Promise<GlobalSessionsResponse> {
    const routes = createGlobalSessionsRoutes(getDeps(overrides));
    const response = await routes.request(`/${queryString}`);
    expect(response.status).toBe(200);
    return response.json();
  }

  async function makeStatsRequest(
    routes = createGlobalSessionsRoutes(getDeps()),
    queryString = "",
  ): Promise<{ stats: GlobalSessionsResponse["stats"] }> {
    const response = await routes.request(`/stats${queryString}`);
    expect(response.status).toBe(200);
    return response.json();
  }

  describe("basic functionality", () => {
    it("returns empty array when no projects exist", async () => {
      vi.mocked(mockScanner.listProjects).mockResolvedValue([]);

      const result = await makeRequest();

      expect(result.sessions).toEqual([]);
      expect(result.hasMore).toBe(false);
    });

    it("returns sessions from multiple projects", async () => {
      const project1 = createProject("proj1", "project-one", "/sessions/proj1");
      const project2 = createProject("proj2", "project-two", "/sessions/proj2");
      const session1 = createSession("sess1", "proj1", minutesAgo(5));
      const session2 = createSession("sess2", "proj2", minutesAgo(10));

      vi.mocked(mockScanner.listProjects).mockResolvedValue([
        project1,
        project2,
      ]);
      sessionsByDir.set("/sessions/proj1", [session1]);
      sessionsByDir.set("/sessions/proj2", [session2]);

      const result = await makeRequest();

      expect(result.sessions).toHaveLength(2);
      expect(result.sessions[0].id).toBe("sess1"); // More recent first
      expect(result.sessions[0].projectName).toBe("project-one");
      expect(result.sessions[1].id).toBe("sess2");
      expect(result.sessions[1].projectName).toBe("project-two");
    });

    it("exposes manual resume exemptions in session summaries", async () => {
      const project = createProject("proj1", "project-one", "/sessions/proj1");
      const session = createSession("sess1", "proj1", minutesAgo(5));
      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [session]);
      metadataMap.set("sess1", { autoResumeDisabled: true });

      const result = await makeRequest();

      expect(result.sessions[0].autoResumeDisabled).toBe(true);
    });

    it("only computes global stats when includeStats=true", async () => {
      const project = createProject("proj1", "project-one", "/sessions/proj1");
      const session = createSession("sess1", "proj1", minutesAgo(5));
      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [session]);
      unreadMap.set("sess1", true);
      metadataMap.set("sess1", { isStarred: true });

      const withoutStats = await makeRequest();
      expect(withoutStats.stats).toEqual({
        totalCount: 0,
        unreadCount: 0,
        starredCount: 0,
        archivedCount: 0,
        providerCounts: {},
        executorCounts: {},
      });

      const withStats = await makeRequest("?includeStats=true");
      expect(withStats.stats.totalCount).toBe(1);
      expect(withStats.stats.unreadCount).toBe(1);
      expect(withStats.stats.starredCount).toBe(1);
      expect(withStats.stats.providerCounts.claude).toBe(1);
    });

    it("hides auto-archived sessions from default lists and shows them in archive browsing", async () => {
      const project = createProject("proj1", "project-one", "/sessions/proj1");
      const recent = createSession("recent", "proj1", hoursAgo(1));
      const old = createSession("old", "proj1", hoursAgo(24 * 20));

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [recent, old]);

      const active = await makeRequest("", { sessionAutoArchiveDays: 14 });
      expect(active.sessions.map((session) => session.id)).toEqual(["recent"]);

      const archived = await makeRequest("?includeArchived=true", {
        sessionAutoArchiveDays: 14,
      });
      expect(archived.sessions.map((session) => session.id)).toEqual([
        "recent",
        "old",
      ]);
      expect(
        archived.sessions.find((session) => session.id === "old"),
      ).toMatchObject({ isArchived: true });
    });

    it("keeps old sessions visible by default", async () => {
      const project = createProject("proj1", "project-one", "/sessions/proj1");
      const recent = createSession("recent", "proj1", hoursAgo(1));
      const old = createSession("old", "proj1", hoursAgo(24 * 20));

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [recent, old]);

      const result = await makeRequest();

      expect(result.sessions.map((session) => session.id)).toEqual([
        "recent",
        "old",
      ]);
    });

    it("includes project context on each session", async () => {
      const project = createProject("proj1", "my-project", "/sessions/proj1");
      const session = createSession("sess1", "proj1", minutesAgo(5));

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [session]);

      const result = await makeRequest();

      expect(result.sessions[0].projectId).toBe("proj1");
      expect(result.sessions[0].projectName).toBe("my-project");
    });
  });

  describe("conditional reads", () => {
    async function readCollection(
      routes: ReturnType<typeof createGlobalSessionsRoutes>,
      queryString = "",
    ): Promise<GlobalSessionsResponse & { unchanged?: true }> {
      const response = await routes.request(`/${queryString}`);
      expect(response.status).toBe(200);
      return response.json();
    }

    function setUpOneSession(eventBus: EventBus) {
      const project = createProject("proj1", "project-one", "/sessions/proj1");
      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [
        createSession("sess1", "proj1", minutesAgo(5)),
      ]);
      return createGlobalSessionsRoutes(getDeps({ eventBus }));
    }

    it("answers an unchanged collection without walking any project", async () => {
      const eventBus = new EventBus();
      const routes = setUpOneSession(eventBus);

      const first = await readCollection(routes);
      expect(first.sessions).toHaveLength(1);
      expect(first.generation).toBeGreaterThan(0);
      const walks = vi.mocked(mockScanner.listProjects).mock.calls.length;

      const second = await readCollection(
        routes,
        `?knownGeneration=${first.generation}`,
      );
      expect(second.unchanged).toBe(true);
      expect(second.generation).toBe(first.generation);
      expect(second.sessions).toBeUndefined();
      expect(vi.mocked(mockScanner.listProjects).mock.calls).toHaveLength(
        walks,
      );
    });

    it("re-walks once an event could have changed a row", async () => {
      const eventBus = new EventBus();
      const routes = setUpOneSession(eventBus);
      const first = await readCollection(routes);

      eventBus.emit({
        type: "session-metadata-changed",
        sessionId: "sess1",
        starred: true,
        timestamp: new Date().toISOString(),
      });

      const second = await readCollection(
        routes,
        `?knownGeneration=${first.generation}`,
      );
      expect(second.unchanged).toBeUndefined();
      expect(second.sessions).toHaveLength(1);
      expect(second.generation).toBeGreaterThan(first.generation as number);
    });

    it("leaves a connection-only event's generation alone", async () => {
      const eventBus = new EventBus();
      const routes = setUpOneSession(eventBus);
      const first = await readCollection(routes);

      // Nothing a row renders, so a client holding rows is still current.
      eventBus.emit({
        type: "browser-tab-connected",
        tabId: "tab-1",
        timestamp: new Date().toISOString(),
      } as never);

      const second = await readCollection(
        routes,
        `?knownGeneration=${first.generation}`,
      );
      expect(second.unchanged).toBe(true);
    });

    it("walks once for a herd of identical concurrent reads", async () => {
      const eventBus = new EventBus();
      const routes = setUpOneSession(eventBus);

      // Twenty tabs reconnecting at the same instant. None of them can hold a
      // generation yet, so this is the cold path the conditional read cannot
      // help with.
      const herd = await Promise.all(
        Array.from({ length: 20 }, () => readCollection(routes)),
      );

      for (const result of herd) {
        expect(result.sessions).toHaveLength(1);
      }
      expect(vi.mocked(mockScanner.listProjects).mock.calls).toHaveLength(1);
    });

    it("re-walks a herd that arrives after the collection changed", async () => {
      const eventBus = new EventBus();
      const routes = setUpOneSession(eventBus);
      await readCollection(routes);
      const walks = vi.mocked(mockScanner.listProjects).mock.calls.length;

      eventBus.emit({
        type: "session-metadata-changed",
        sessionId: "sess1",
        starred: true,
        timestamp: new Date().toISOString(),
      });
      await Promise.all(
        Array.from({ length: 20 }, () => readCollection(routes)),
      );

      // One more walk for the new generation, not twenty, and not zero.
      expect(vi.mocked(mockScanner.listProjects).mock.calls).toHaveLength(
        walks + 1,
      );
    });

    it("never short-circuits a cursor page", async () => {
      const eventBus = new EventBus();
      const routes = setUpOneSession(eventBus);
      const first = await readCollection(routes);

      const paged = await readCollection(
        routes,
        `?after=${new Date().toISOString()}&knownGeneration=${first.generation}`,
      );
      expect(paged.unchanged).toBeUndefined();
      expect(paged.sessions).toBeDefined();
    });

    it("rejects a token no generation ever had", async () => {
      const eventBus = new EventBus();
      const routes = setUpOneSession(eventBus);

      for (const token of ["0", "-1", "not-a-number", "999999"]) {
        const result = await readCollection(
          routes,
          `?knownGeneration=${token}`,
        );
        expect(result.unchanged).toBeUndefined();
        expect(result.sessions).toBeDefined();
      }
    });
  });

  describe("stats endpoint", () => {
    it("returns cached stats and invalidates on metadata changes", async () => {
      const project = createProject("proj1", "project-one", "/sessions/proj1");
      const session = createSession("sess1", "proj1", minutesAgo(5));
      const eventBus = new EventBus();
      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [session]);

      const routes = createGlobalSessionsRoutes(getDeps({ eventBus }));

      const first = await makeStatsRequest(routes);
      expect(first.stats.totalCount).toBe(1);
      expect(first.stats.archivedCount).toBe(0);
      expect(vi.mocked(mockScanner.listProjects)).toHaveBeenCalledTimes(1);

      metadataMap.set("sess1", { isArchived: true });
      const second = await makeStatsRequest(routes);
      expect(second.stats.totalCount).toBe(1);
      expect(second.stats.archivedCount).toBe(0);
      expect(vi.mocked(mockScanner.listProjects)).toHaveBeenCalledTimes(1);

      eventBus.emit({
        type: "session-metadata-changed",
        sessionId: "sess1",
        archived: true,
        timestamp: new Date().toISOString(),
      });

      const third = await makeStatsRequest(routes);
      expect(third.stats.totalCount).toBe(0);
      expect(third.stats.archivedCount).toBe(1);
      expect(vi.mocked(mockScanner.listProjects)).toHaveBeenCalledTimes(2);
    });
  });

  describe("filtering", () => {
    it("filters by projectId when ?project query param provided", async () => {
      const project1 = createProject("proj1", "project-one", "/sessions/proj1");
      const project2 = createProject("proj2", "project-two", "/sessions/proj2");
      const session1 = createSession("sess1", "proj1", minutesAgo(5));
      const session2 = createSession("sess2", "proj2", minutesAgo(10));

      vi.mocked(mockScanner.listProjects).mockResolvedValue([
        project1,
        project2,
      ]);
      sessionsByDir.set("/sessions/proj1", [session1]);
      sessionsByDir.set("/sessions/proj2", [session2]);

      const result = await makeRequest("?project=proj1");

      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0].id).toBe("sess1");
    });

    it("excludes archived sessions by default", async () => {
      const project = createProject("proj1", "project", "/sessions/proj1");
      const session1 = createSession("sess1", "proj1", minutesAgo(5));
      const session2 = createSession("sess2", "proj1", minutesAgo(10));

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [session1, session2]);
      metadataMap.set("sess2", { isArchived: true });

      const result = await makeRequest();

      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0].id).toBe("sess1");
    });

    it("includes archived sessions when ?includeArchived=true", async () => {
      const project = createProject("proj1", "project", "/sessions/proj1");
      const session1 = createSession("sess1", "proj1", minutesAgo(5));
      const session2 = createSession("sess2", "proj1", minutesAgo(10));

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [session1, session2]);
      metadataMap.set("sess2", { isArchived: true });

      const result = await makeRequest("?includeArchived=true");

      expect(result.sessions).toHaveLength(2);
    });
  });

  describe("search", () => {
    it("filters by session title when ?q query param provided", async () => {
      const project = createProject("proj1", "project", "/sessions/proj1");
      const session1 = createSession("sess1", "proj1", minutesAgo(5), {
        title: "Fix login bug",
      });
      const session2 = createSession("sess2", "proj1", minutesAgo(10), {
        title: "Add new feature",
      });

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [session1, session2]);

      const result = await makeRequest("?q=login");

      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0].id).toBe("sess1");
    });

    it("searches in customTitle", async () => {
      const project = createProject("proj1", "project", "/sessions/proj1");
      const session1 = createSession("sess1", "proj1", minutesAgo(5), {
        title: "Original title",
      });
      const session2 = createSession("sess2", "proj1", minutesAgo(10), {
        title: "Another title",
      });

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [session1, session2]);
      metadataMap.set("sess1", { customTitle: "Custom Login Session" });

      const result = await makeRequest("?q=custom");

      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0].id).toBe("sess1");
    });

    it("searches in projectName", async () => {
      const project1 = createProject(
        "proj1",
        "authentication-service",
        "/sessions/proj1",
      );
      const project2 = createProject(
        "proj2",
        "payment-gateway",
        "/sessions/proj2",
      );
      const session1 = createSession("sess1", "proj1", minutesAgo(5));
      const session2 = createSession("sess2", "proj2", minutesAgo(10));

      vi.mocked(mockScanner.listProjects).mockResolvedValue([
        project1,
        project2,
      ]);
      sessionsByDir.set("/sessions/proj1", [session1]);
      sessionsByDir.set("/sessions/proj2", [session2]);

      const result = await makeRequest("?q=authentication");

      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0].id).toBe("sess1");
    });

    it("search is case-insensitive", async () => {
      const project = createProject("proj1", "project", "/sessions/proj1");
      const session = createSession("sess1", "proj1", minutesAgo(5), {
        title: "FIX LOGIN BUG",
      });

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [session]);

      const result = await makeRequest("?q=login");

      expect(result.sessions).toHaveLength(1);
    });
  });

  describe("pagination", () => {
    it("limits results to specified limit", async () => {
      const project = createProject("proj1", "project", "/sessions/proj1");
      const sessions = Array.from({ length: 5 }, (_, i) =>
        createSession(`sess${i}`, "proj1", minutesAgo(i)),
      );

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", sessions);

      const result = await makeRequest("?limit=2");

      expect(result.sessions).toHaveLength(2);
      expect(result.hasMore).toBe(true);
    });

    it("returns hasMore=false when all results returned", async () => {
      const project = createProject("proj1", "project", "/sessions/proj1");
      const sessions = [createSession("sess1", "proj1", minutesAgo(5))];

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", sessions);

      const result = await makeRequest("?limit=10");

      expect(result.sessions).toHaveLength(1);
      expect(result.hasMore).toBe(false);
    });

    it("uses after cursor for pagination", async () => {
      const project = createProject("proj1", "project", "/sessions/proj1");
      const session1 = createSession("sess1", "proj1", minutesAgo(5));
      const session2 = createSession("sess2", "proj1", minutesAgo(10));
      const session3 = createSession("sess3", "proj1", minutesAgo(15));

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [session1, session2, session3]);

      // Get sessions after session1's timestamp (should skip session1)
      const afterCursor = session1.updatedAt;
      const result = await makeRequest(`?after=${afterCursor}`);

      expect(result.sessions).toHaveLength(2);
      expect(result.sessions[0].id).toBe("sess2");
      expect(result.sessions[1].id).toBe("sess3");
    });

    it("combines after cursor with limit", async () => {
      const project = createProject("proj1", "project", "/sessions/proj1");
      const sessions = Array.from({ length: 10 }, (_, i) =>
        createSession(`sess${i}`, "proj1", minutesAgo(i)),
      );

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", sessions);

      // Skip first 3, take 2
      const afterCursor = sessions[2].updatedAt;
      const result = await makeRequest(`?after=${afterCursor}&limit=2`);

      expect(result.sessions).toHaveLength(2);
      expect(result.sessions[0].id).toBe("sess3");
      expect(result.sessions[1].id).toBe("sess4");
      expect(result.hasMore).toBe(true);
    });
  });

  describe("provider catalog", () => {
    it("reuses provider presence from listed projects before consulting scanners", async () => {
      const project = {
        ...createProject("proj1", "project-one", "/sessions/proj1"),
        hasCodexSessions: true,
      } as Project;
      const codexSession = createSession(
        "codex-sess-1",
        "proj1",
        minutesAgo(1),
        {
          provider: "codex",
        },
      );

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", []);

      const codexScanner = {
        listProjects: vi.fn(async () => {
          throw new Error("codex scanner should not be consulted");
        }),
      };
      const codexReader = {
        listSessions: vi.fn(async () => [codexSession]),
      } as unknown as ISessionReader;
      const codexReaderFactory = vi.fn(() => codexReader);
      const sessionIndexService = {
        getSessionsWithCache: vi.fn(
          async (
            sessionDir: string,
            _projectId: string,
            reader: ISessionReader,
          ) => {
            if (sessionDir === "/codex/sessions") {
              expect(reader).toBe(codexReader);
              return [codexSession];
            }
            return reader.listSessions(_projectId as UrlProjectId);
          },
        ),
      } as unknown as SessionIndexService;

      const routes = createGlobalSessionsRoutes({
        ...getDeps({ sessionIndexService }),
        codexScanner:
          codexScanner as unknown as GlobalSessionsDeps["codexScanner"],
        codexSessionsDir: "/codex/sessions",
        codexReaderFactory:
          codexReaderFactory as unknown as GlobalSessionsDeps["codexReaderFactory"],
      });

      const response = await routes.request("/?project=proj1");
      expect(response.status).toBe(200);
      const result = (await response.json()) as GlobalSessionsResponse;

      expect(codexScanner.listProjects).not.toHaveBeenCalled();
      expect(codexReaderFactory).toHaveBeenCalledWith(project.path);
      expect(result.sessions.some((s) => s.id === "codex-sess-1")).toBe(true);
    });

    it("builds codex project catalog once and avoids per-project scanner checks", async () => {
      const project1 = createProject("proj1", "project-one", "/sessions/proj1");
      const project2 = createProject("proj2", "project-two", "/sessions/proj2");

      vi.mocked(mockScanner.listProjects).mockResolvedValue([
        project1,
        project2,
      ]);
      sessionsByDir.set("/sessions/proj1", []);
      sessionsByDir.set("/sessions/proj2", []);

      const codexScanner = {
        listProjects: vi.fn(async () => [
          {
            ...project1,
            provider: "codex",
          },
        ]),
        getSessionsForProject: vi.fn(async () => []),
      };

      const codexReaderFactory = vi.fn(() => ({
        listSessions: vi.fn(async () => [
          createSession("codex-sess-1", "proj1", minutesAgo(1), {
            provider: "codex",
          }),
        ]),
      }));

      const routes = createGlobalSessionsRoutes({
        ...getDeps(),
        codexScanner:
          codexScanner as unknown as GlobalSessionsDeps["codexScanner"],
        codexReaderFactory:
          codexReaderFactory as unknown as GlobalSessionsDeps["codexReaderFactory"],
      });
      const response = await routes.request("/");
      expect(response.status).toBe(200);
      const result = (await response.json()) as GlobalSessionsResponse;

      expect(codexScanner.listProjects).toHaveBeenCalledTimes(1);
      expect(codexScanner.getSessionsForProject).not.toHaveBeenCalled();
      // List walk plus one child-attach pass per project, not per session.
      expect(codexReaderFactory).toHaveBeenCalledTimes(2);
      expect(codexReaderFactory).toHaveBeenCalledWith(project1.path);
      expect(result.sessions.some((s) => s.id === "codex-sess-1")).toBe(true);
    });

    it("uses session index cache for codex sessions merged into claude projects", async () => {
      const project = createProject("proj1", "project-one", "/sessions/proj1");
      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", []);

      const codexSession = createSession(
        "codex-sess-1",
        "proj1",
        minutesAgo(1),
        {
          provider: "codex",
        },
      );
      const codexReader = {
        listSessions: vi.fn(async () => [codexSession]),
      } as unknown as CodexSessionReader;
      const codexReaderFactory = vi.fn(() => codexReader);
      const codexScanner = {
        listProjects: vi.fn(async () => [{ ...project, provider: "codex" }]),
      };
      const sessionIndexService = {
        getSessionsWithCache: vi.fn(
          async (
            sessionDir: string,
            _projectId: string,
            reader: ISessionReader,
          ) => {
            if (sessionDir === "/codex/sessions") {
              expect(reader).toBe(codexReader);
              return [codexSession];
            }
            return reader.listSessions(_projectId as UrlProjectId);
          },
        ),
      } as unknown as SessionIndexService;

      const routes = createGlobalSessionsRoutes({
        ...getDeps({ sessionIndexService }),
        codexScanner:
          codexScanner as unknown as GlobalSessionsDeps["codexScanner"],
        codexSessionsDir: "/codex/sessions",
        codexReaderFactory:
          codexReaderFactory as unknown as GlobalSessionsDeps["codexReaderFactory"],
      });

      const response = await routes.request("/");
      expect(response.status).toBe(200);
      const result = (await response.json()) as GlobalSessionsResponse;

      expect(
        vi.mocked(sessionIndexService.getSessionsWithCache),
      ).toHaveBeenCalledWith(
        "/codex/sessions",
        project.id,
        codexReader,
        undefined,
      );
      expect(codexReader.listSessions).not.toHaveBeenCalled();
      expect(result.sessions.some((s) => s.id === "codex-sess-1")).toBe(true);
    });

    it("uses session index cache for gemini sessions merged into claude projects", async () => {
      const project = createProject("proj1", "project-one", "/sessions/proj1");
      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", []);

      const geminiSession = createSession(
        "gemini-sess-1",
        "proj1",
        minutesAgo(1),
        {
          provider: "gemini",
        },
      );
      const geminiReader = {
        listSessions: vi.fn(async () => [geminiSession]),
      } as unknown as GeminiSessionReader;
      const geminiReaderFactory = vi.fn(() => geminiReader);
      const geminiScanner = {
        listProjects: vi.fn(async () => [{ ...project, provider: "gemini" }]),
        getHashToCwd: vi.fn(async () => new Map()),
      };
      const sessionIndexService = {
        getSessionsWithCache: vi.fn(
          async (
            sessionDir: string,
            _projectId: string,
            reader: ISessionReader,
          ) => {
            if (sessionDir === "/gemini/tmp") {
              expect(reader).toBe(geminiReader);
              return [geminiSession];
            }
            return reader.listSessions(_projectId as UrlProjectId);
          },
        ),
      } as unknown as SessionIndexService;

      const routes = createGlobalSessionsRoutes({
        ...getDeps({ sessionIndexService }),
        geminiScanner:
          geminiScanner as unknown as GlobalSessionsDeps["geminiScanner"],
        geminiSessionsDir: "/gemini/tmp",
        geminiReaderFactory:
          geminiReaderFactory as unknown as GlobalSessionsDeps["geminiReaderFactory"],
      });

      const response = await routes.request("/");
      expect(response.status).toBe(200);
      const result = (await response.json()) as GlobalSessionsResponse;

      expect(
        vi.mocked(sessionIndexService.getSessionsWithCache),
      ).toHaveBeenCalledWith(
        "/gemini/tmp",
        project.id,
        geminiReader,
        undefined,
      );
      expect(geminiReader.listSessions).not.toHaveBeenCalled();
      expect(result.sessions.some((s) => s.id === "gemini-sess-1")).toBe(true);
    });
  });

  describe("enrichment", () => {
    it("enriches with self ownership from supervisor", async () => {
      const project = createProject("proj1", "project", "/sessions/proj1");
      const session = createSession("sess1", "proj1", minutesAgo(5));

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [session]);
      processMap.set("sess1", {
        id: "proc-1",
        getPendingInputRequest: () => null,
        state: { type: "in-turn" },
        permissionMode: "default",
        modeVersion: 1,
      });

      const result = await makeRequest();

      expect(result.sessions[0].ownership).toEqual({
        owner: "self",
        processId: "proc-1",
        permissionMode: "default",
        modeVersion: 1,
      });
      expect(result.sessions[0].activity).toBe("in-turn");
    });

    it("reports idle process retaining provider background work as in-turn", async () => {
      const project = createProject("proj1", "project", "/sessions/proj1");
      const session = createSession("sess1", "proj1", minutesAgo(5));

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [session]);
      processMap.set("sess1", {
        id: "proc-1",
        getPendingInputRequest: () => null,
        state: { type: "idle" },
        permissionMode: "default",
        modeVersion: 1,
        isRetainingProviderWork: () => true,
      });

      const result = await makeRequest();

      expect(result.sessions[0].activity).toBe("in-turn");
    });

    it("reports idle process without provider retention as inactive", async () => {
      const project = createProject("proj1", "project", "/sessions/proj1");
      const session = createSession("sess1", "proj1", minutesAgo(5));

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [session]);
      processMap.set("sess1", {
        id: "proc-1",
        getPendingInputRequest: () => null,
        state: { type: "idle" },
        permissionMode: "default",
        modeVersion: 1,
        isRetainingProviderWork: () => false,
      });

      const result = await makeRequest();

      expect(result.sessions[0].activity).toBeUndefined();
    });

    it("enriches with external ownership", async () => {
      const project = createProject("proj1", "project", "/sessions/proj1");
      const session = createSession("sess1", "proj1", minutesAgo(5));

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [session]);
      externalSessions.add("sess1");

      const result = await makeRequest();

      expect(result.sessions[0].ownership).toEqual({ owner: "external" });
    });

    it("enriches with pendingInputType", async () => {
      const project = createProject("proj1", "project", "/sessions/proj1");
      const session = createSession("sess1", "proj1", minutesAgo(5));

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [session]);
      processMap.set("sess1", {
        id: "proc-1",
        getPendingInputRequest: () => ({ type: "tool-approval" }),
        state: { type: "waiting-input" },
        permissionMode: "default",
        modeVersion: 1,
      });

      const result = await makeRequest();

      expect(result.sessions[0].pendingInputType).toBe("tool-approval");
    });

    it("enriches with hasUnread from notification service", async () => {
      const project = createProject("proj1", "project", "/sessions/proj1");
      const session = createSession("sess1", "proj1", minutesAgo(5));

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [session]);
      unreadMap.set("sess1", true);

      const result = await makeRequest();

      expect(result.sessions[0].hasUnread).toBe(true);
    });

    it("uses owned-process activity for unread, recency, and sorting", async () => {
      const project = createProject("proj1", "project", "/sessions/proj1");
      const lastSeenAt = minutesAgo(20);
      const processUpdatedAt = new Date(minutesAgo(2));
      const activeSession = createSession("active", "proj1", hoursAgo(2), {
        provider: "codex",
      });
      const otherSession = createSession("other", "proj1", minutesAgo(10));

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [activeSession, otherSession]);
      processMap.set("active", {
        id: "proc-active",
        getPendingInputRequest: () => null,
        state: { type: "in-turn" },
        permissionMode: "default",
        modeVersion: 1,
        lastProviderContentTime: processUpdatedAt,
      });
      vi.mocked(mockNotificationService.hasUnread).mockImplementation(
        (_sessionId: string, updatedAt: string) => updatedAt > lastSeenAt,
      );

      const result = await makeRequest();

      expect(mockNotificationService.hasUnread).toHaveBeenCalledWith(
        "active",
        processUpdatedAt.toISOString(),
      );
      expect(result.sessions[0]).toMatchObject({
        id: "active",
        updatedAt: processUpdatedAt.toISOString(),
        hasUnread: true,
      });
    });

    it("computes hasUnread from the pre-recap-overlay updatedAt", async () => {
      const project = createProject("proj1", "project", "/sessions/proj1");
      const rawUpdatedAt = minutesAgo(30);
      const session = createSession("sess1", "proj1", rawUpdatedAt);
      const recapTimestamp = minutesAgo(5);

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [session]);
      vi.mocked(mockMetadataService.getRecapMessages).mockReturnValue([
        {
          type: "system",
          subtype: "away_summary",
          content: "Recap of what happened while away",
          timestamp: recapTimestamp,
          uuid: "recap-1",
          yaRecapSource: "ya-synthetic",
        },
      ]);
      // Session fully seen after the last provider write but before the
      // recap landed: the recap bumps list freshness, never unread.
      const lastSeenAt = minutesAgo(20);
      vi.mocked(mockNotificationService.hasUnread).mockImplementation(
        (_sessionId: string, updatedAt: string) => updatedAt > lastSeenAt,
      );

      const result = await makeRequest();

      expect(result.sessions[0].updatedAt).toBe(recapTimestamp);
      expect(result.sessions[0].hasUnread).toBe(false);
      expect(mockNotificationService.hasUnread).toHaveBeenCalledWith(
        "sess1",
        rawUpdatedAt,
      );
    });

    it("enriches with metadata (customTitle, isArchived, isStarred)", async () => {
      const project = createProject("proj1", "project", "/sessions/proj1");
      const session = createSession("sess1", "proj1", minutesAgo(5));

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [session]);
      metadataMap.set("sess1", {
        customTitle: "My Custom Title",
        isStarred: true,
      });

      const result = await makeRequest();

      expect(result.sessions[0].customTitle).toBe("My Custom Title");
      expect(result.sessions[0].isStarred).toBe(true);
    });
  });

  describe("sorting", () => {
    it("sorts by updatedAt descending (most recent first)", async () => {
      const project = createProject("proj1", "project", "/sessions/proj1");
      const session1 = createSession("sess1", "proj1", minutesAgo(15));
      const session2 = createSession("sess2", "proj1", minutesAgo(5));
      const session3 = createSession("sess3", "proj1", minutesAgo(10));

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [session1, session2, session3]);

      const result = await makeRequest();

      expect(result.sessions[0].id).toBe("sess2"); // 5 min ago
      expect(result.sessions[1].id).toBe("sess3"); // 10 min ago
      expect(result.sessions[2].id).toBe("sess1"); // 15 min ago
    });
  });
});
