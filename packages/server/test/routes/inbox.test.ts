import type {
  ProjectQueueItemSummary,
  UrlProjectId,
} from "@yep-anywhere/shared";
import type { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionIndexService } from "../../src/indexes/index.js";
import type { NotificationService } from "../../src/notifications/index.js";
import type { CodexSessionScanner } from "../../src/projects/codex-scanner.js";
import type { ProjectScanner } from "../../src/projects/scanner.js";
import {
  type InboxDeps,
  type InboxResponse,
  createInboxRoutes,
} from "../../src/routes/inbox.js";
import type { CodexSessionReader } from "../../src/sessions/codex-reader.js";
import type { ISessionReader } from "../../src/sessions/types.js";
import type { Supervisor } from "../../src/supervisor/Supervisor.js";
import type { Project, SessionSummary } from "../../src/supervisor/types.js";
import { EventBus } from "../../src/watcher/index.js";

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

function createExistingSessionProjectQueueItem(
  id: string,
  projectId: string,
  sessionId: string,
  status: ProjectQueueItemSummary["status"] = "queued",
): ProjectQueueItemSummary {
  return {
    id,
    projectId: projectId as UrlProjectId,
    target: { type: "existing-session", sessionId },
    messagePreview: `Queued ${id}`,
    message: { text: `Queued ${id}` },
    createdAt: hoursAgo(1),
    updatedAt: hoursAgo(1),
    status,
    attachmentCount: 0,
  };
}

describe("Inbox Routes", () => {
  let mockScanner: ProjectScanner;
  let mockReaderFactory: (project: Project) => ISessionReader;
  let mockSupervisor: Supervisor;
  let mockNotificationService: NotificationService;
  let mockSessionIndexService: SessionIndexService;
  let mockSessionMetadataService: NonNullable<
    InboxDeps["sessionMetadataService"]
  >;
  let mockProjectQueueService: NonNullable<InboxDeps["projectQueueService"]>;
  let sessionsByDir: Map<string, SessionSummary[]>;
  let codexSessionsByPath: Map<string, SessionSummary[]>;
  let metadataMap: Map<
    string,
    { customTitle?: string; isArchived?: boolean; isStarred?: boolean }
  >;
  let projectQueueItems: ProjectQueueItemSummary[];
  let processMap: Map<
    string,
    {
      getPendingInputRequest: () => unknown;
      state: { type: string };
      isRetainingProviderWork?: () => boolean;
      lastProviderContentTime?: Date | null;
    }
  >;
  let unreadMap: Map<string, boolean>;

  beforeEach(() => {
    sessionsByDir = new Map();
    codexSessionsByPath = new Map();
    metadataMap = new Map();
    projectQueueItems = [];
    processMap = new Map();
    unreadMap = new Map();

    // Mock scanner
    mockScanner = {
      listProjects: vi.fn(async () => []),
    } as unknown as ProjectScanner;

    // Mock reader factory - now takes a Project instead of sessionDir
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

    mockSessionMetadataService = {
      getMetadata: vi.fn((sessionId: string) => metadataMap.get(sessionId)),
    } as unknown as NonNullable<InboxDeps["sessionMetadataService"]>;

    mockProjectQueueService = {
      listAll: vi.fn(() => projectQueueItems),
    };
  });

  async function makeRequest(deps: InboxDeps): Promise<InboxResponse> {
    const routes = createInboxRoutes(deps);
    const response = await routes.request("/");
    expect(response.status).toBe(200);
    return response.json();
  }

  describe("tier categorization", () => {
    it("preserves independently observed question previews in Inbox", async () => {
      const project = createProject("proj1", "myproject", "/sessions/proj1");
      const asyncQuestions = {
        omitted: true,
        questions: [
          { messageId: "question", index: 0, title: "Continue?", age: 2 },
        ],
      };
      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set(project.sessionDir, [
        createSession("sess1", "proj1", minutesAgo(1), { asyncQuestions }),
      ]);
      processMap.set("sess1", {
        getPendingInputRequest: () => null,
        state: { type: "in-turn" },
      });
      const result = await makeRequest({
        scanner: mockScanner,
        readerFactory: mockReaderFactory,
        supervisor: mockSupervisor,
        notificationService: mockNotificationService,
        sessionIndexService: mockSessionIndexService,
      });
      expect(result.active[0]?.asyncQuestions).toEqual(asyncQuestions);
    });

    it("categorizes session with pendingInputType into needsAttention", async () => {
      const project = createProject("proj1", "myproject", "/sessions/proj1");
      const session = createSession("sess1", "proj1", minutesAgo(5));

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [session]);

      // Mock process with pending input
      processMap.set("sess1", {
        getPendingInputRequest: () => ({
          type: "tool-approval",
          id: "req1",
          prompt: "Allow?",
        }),
        state: { type: "waiting-input" },
      });

      const result = await makeRequest({
        scanner: mockScanner,
        readerFactory: mockReaderFactory,
        supervisor: mockSupervisor,
        notificationService: mockNotificationService,
        sessionIndexService: mockSessionIndexService,
      });

      expect(result.needsAttention).toHaveLength(1);
      expect(result.needsAttention[0].sessionId).toBe("sess1");
      expect(result.needsAttention[0].pendingInputType).toBe("tool-approval");
      expect(result.active).toHaveLength(0);
    });

    it("categorizes session with in-turn process (no pending) into active", async () => {
      const project = createProject("proj1", "myproject", "/sessions/proj1");
      const session = createSession("sess1", "proj1", minutesAgo(5));

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [session]);

      // Mock in-turn process without pending input
      processMap.set("sess1", {
        getPendingInputRequest: () => null,
        state: { type: "in-turn" },
      });

      const result = await makeRequest({
        scanner: mockScanner,
        readerFactory: mockReaderFactory,
        supervisor: mockSupervisor,
        notificationService: mockNotificationService,
        sessionIndexService: mockSessionIndexService,
      });

      expect(result.needsAttention).toHaveLength(0);
      expect(result.active).toHaveLength(1);
      expect(result.active[0].sessionId).toBe("sess1");
      expect(result.active[0].activity).toBe("in-turn");
    });

    it("uses later owned-process activity for active unread state", async () => {
      const project = createProject("proj1", "myproject", "/sessions/proj1");
      const summaryUpdatedAt = hoursAgo(2);
      const lastSeenAt = hoursAgo(1);
      const processUpdatedAt = new Date(minutesAgo(2));
      const session = createSession("sess1", "proj1", summaryUpdatedAt, {
        provider: "codex",
      });

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [session]);
      processMap.set("sess1", {
        getPendingInputRequest: () => null,
        state: { type: "in-turn" },
        lastProviderContentTime: processUpdatedAt,
      });
      vi.mocked(mockNotificationService.hasUnread).mockImplementation(
        (_sessionId: string, updatedAt: string) => updatedAt > lastSeenAt,
      );

      const result = await makeRequest({
        scanner: mockScanner,
        readerFactory: mockReaderFactory,
        supervisor: mockSupervisor,
        notificationService: mockNotificationService,
        sessionIndexService: mockSessionIndexService,
      });

      expect(mockNotificationService.hasUnread).toHaveBeenCalledWith(
        "sess1",
        processUpdatedAt.toISOString(),
      );
      expect(result.active[0]).toMatchObject({
        sessionId: "sess1",
        updatedAt: processUpdatedAt.toISOString(),
        activity: "in-turn",
        hasUnread: true,
      });
    });

    it("categorizes idle process retaining provider background work into active", async () => {
      const project = createProject("proj1", "myproject", "/sessions/proj1");
      // Updated recently enough that, without the retention check, it would
      // otherwise fall into recentActivity.
      const session = createSession("sess1", "proj1", minutesAgo(2));

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [session]);

      // Idle process, but the provider is still keeping background work alive.
      processMap.set("sess1", {
        getPendingInputRequest: () => null,
        state: { type: "idle" },
        isRetainingProviderWork: () => true,
      });

      const result = await makeRequest({
        scanner: mockScanner,
        readerFactory: mockReaderFactory,
        supervisor: mockSupervisor,
        notificationService: mockNotificationService,
        sessionIndexService: mockSessionIndexService,
      });

      expect(result.active).toHaveLength(1);
      expect(result.active[0].sessionId).toBe("sess1");
      expect(result.active[0].activity).toBe("in-turn");
      expect(result.recentActivity).toHaveLength(0);
    });

    it("categorizes idle process without provider retention into recentActivity", async () => {
      const project = createProject("proj1", "myproject", "/sessions/proj1");
      const session = createSession("sess1", "proj1", minutesAgo(2));

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [session]);

      // Idle process with no retained background work stays inactive.
      processMap.set("sess1", {
        getPendingInputRequest: () => null,
        state: { type: "idle" },
        isRetainingProviderWork: () => false,
      });

      const result = await makeRequest({
        scanner: mockScanner,
        readerFactory: mockReaderFactory,
        supervisor: mockSupervisor,
        notificationService: mockNotificationService,
        sessionIndexService: mockSessionIndexService,
      });

      expect(result.active).toHaveLength(0);
      expect(result.recentActivity).toHaveLength(1);
      expect(result.recentActivity[0].sessionId).toBe("sess1");
      expect(result.recentActivity[0].activity).toBeUndefined();
    });

    it("categorizes existing-session Project Queue targets into active", async () => {
      const project = createProject("proj1", "myproject", "/sessions/proj1");
      const session = createSession("sess1", "proj1", hoursAgo(30));

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [session]);
      projectQueueItems = [
        createExistingSessionProjectQueueItem("queue-1", "proj1", "sess1"),
      ];

      const result = await makeRequest({
        scanner: mockScanner,
        readerFactory: mockReaderFactory,
        supervisor: mockSupervisor,
        notificationService: mockNotificationService,
        sessionIndexService: mockSessionIndexService,
        projectQueueService: mockProjectQueueService,
      });

      expect(result.active).toHaveLength(1);
      expect(result.active[0].sessionId).toBe("sess1");
      expect(result.recentActivity).toHaveLength(0);
      expect(result.unread24h).toHaveLength(0);
    });

    it("does not promote failed or new-session Project Queue items", async () => {
      const project = createProject("proj1", "myproject", "/sessions/proj1");
      const failedSession = createSession("failed-sess", "proj1", hoursAgo(30));

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [failedSession]);
      projectQueueItems = [
        createExistingSessionProjectQueueItem(
          "queue-failed",
          "proj1",
          "failed-sess",
          "failed",
        ),
        {
          id: "queue-new",
          projectId: "proj1" as UrlProjectId,
          target: { type: "new-session", title: "Queued new session" },
          messagePreview: "Queued new session",
          message: { text: "Queued new session" },
          createdAt: hoursAgo(1),
          updatedAt: hoursAgo(1),
          status: "queued",
          attachmentCount: 0,
        },
      ];

      const result = await makeRequest({
        scanner: mockScanner,
        readerFactory: mockReaderFactory,
        supervisor: mockSupervisor,
        notificationService: mockNotificationService,
        sessionIndexService: mockSessionIndexService,
        projectQueueService: mockProjectQueueService,
      });

      expect(result.active).toHaveLength(0);
      expect(result.recentActivity).toHaveLength(0);
      expect(result.unread24h).toHaveLength(0);
    });

    it("categorizes session updated in last 30 minutes into recentActivity", async () => {
      const project = createProject("proj1", "myproject", "/sessions/proj1");
      const session = createSession("sess1", "proj1", minutesAgo(15)); // 15 minutes ago

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [session]);

      const result = await makeRequest({
        scanner: mockScanner,
        readerFactory: mockReaderFactory,
        supervisor: mockSupervisor,
        notificationService: mockNotificationService,
        sessionIndexService: mockSessionIndexService,
      });

      expect(result.needsAttention).toHaveLength(0);
      expect(result.active).toHaveLength(0);
      expect(result.recentActivity).toHaveLength(1);
      expect(result.recentActivity[0].sessionId).toBe("sess1");
    });

    it("categorizes unread session updated within 8 hours into unread8h", async () => {
      const project = createProject("proj1", "myproject", "/sessions/proj1");
      const session = createSession("sess1", "proj1", hoursAgo(4)); // 4 hours ago

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [session]);
      unreadMap.set("sess1", true);

      const result = await makeRequest({
        scanner: mockScanner,
        readerFactory: mockReaderFactory,
        supervisor: mockSupervisor,
        notificationService: mockNotificationService,
        sessionIndexService: mockSessionIndexService,
      });

      expect(result.needsAttention).toHaveLength(0);
      expect(result.active).toHaveLength(0);
      expect(result.recentActivity).toHaveLength(0);
      expect(result.unread8h).toHaveLength(1);
      expect(result.unread8h[0].sessionId).toBe("sess1");
    });

    it("categorizes unread session updated within 24 hours into unread24h", async () => {
      const project = createProject("proj1", "myproject", "/sessions/proj1");
      const session = createSession("sess1", "proj1", hoursAgo(12)); // 12 hours ago

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [session]);
      unreadMap.set("sess1", true);

      const result = await makeRequest({
        scanner: mockScanner,
        readerFactory: mockReaderFactory,
        supervisor: mockSupervisor,
        notificationService: mockNotificationService,
        sessionIndexService: mockSessionIndexService,
      });

      expect(result.needsAttention).toHaveLength(0);
      expect(result.active).toHaveLength(0);
      expect(result.recentActivity).toHaveLength(0);
      expect(result.unread8h).toHaveLength(0);
      expect(result.unread24h).toHaveLength(1);
      expect(result.unread24h[0].sessionId).toBe("sess1");
    });

    it("does not categorize session older than 24h or already read", async () => {
      const project = createProject("proj1", "myproject", "/sessions/proj1");

      // Session older than 24h
      const oldSession = createSession("old-sess", "proj1", hoursAgo(30));
      // Session within 24h but already read
      const readSession = createSession("read-sess", "proj1", hoursAgo(12));

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [oldSession, readSession]);
      unreadMap.set("old-sess", true); // unread but too old
      unreadMap.set("read-sess", false); // already read

      const result = await makeRequest({
        scanner: mockScanner,
        readerFactory: mockReaderFactory,
        supervisor: mockSupervisor,
        notificationService: mockNotificationService,
        sessionIndexService: mockSessionIndexService,
      });

      expect(result.needsAttention).toHaveLength(0);
      expect(result.active).toHaveLength(0);
      expect(result.recentActivity).toHaveLength(0);
      expect(result.unread8h).toHaveLength(0);
      expect(result.unread24h).toHaveLength(0);
    });

    it("does not treat a later storage touch as recent or unread", async () => {
      const project = createProject("proj1", "myproject", "/sessions/proj1");
      const contentUpdatedAt = hoursAgo(2);
      const lastSeenAt = hoursAgo(1);
      const storageTouchedAt = minutesAgo(5);
      const session = createSession("sess1", "proj1", contentUpdatedAt);

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [session]);
      vi.mocked(mockNotificationService.hasUnread).mockImplementation(
        (_sessionId: string, updatedAt: string) => updatedAt > lastSeenAt,
      );

      const result = await makeRequest({
        scanner: mockScanner,
        readerFactory: mockReaderFactory,
        supervisor: mockSupervisor,
        notificationService: mockNotificationService,
        sessionIndexService: mockSessionIndexService,
      });

      expect(storageTouchedAt > lastSeenAt).toBe(true);
      expect(mockNotificationService.hasUnread).toHaveBeenCalledWith(
        "sess1",
        contentUpdatedAt,
      );
      expect(result.recentActivity).toHaveLength(0);
      expect(result.unread8h).toHaveLength(0);
      expect(result.unread24h).toHaveLength(0);
    });
  });

  describe("priority", () => {
    it("assigns session to highest priority tier only", async () => {
      const project = createProject("proj1", "myproject", "/sessions/proj1");
      // Session that could qualify for multiple tiers:
      // - has pending input (needsAttention)
      // - has running process (active)
      // - updated 10 minutes ago (recentActivity)
      // - is unread (unread8h)
      const session = createSession("sess1", "proj1", minutesAgo(10));

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [session]);
      unreadMap.set("sess1", true);

      // Mock process with pending input (highest priority)
      processMap.set("sess1", {
        getPendingInputRequest: () => ({
          type: "user-question",
          id: "req1",
          prompt: "Question?",
        }),
        state: { type: "waiting-input" },
      });

      const result = await makeRequest({
        scanner: mockScanner,
        readerFactory: mockReaderFactory,
        supervisor: mockSupervisor,
        notificationService: mockNotificationService,
        sessionIndexService: mockSessionIndexService,
      });

      // Should only appear in needsAttention (highest priority)
      expect(result.needsAttention).toHaveLength(1);
      expect(result.needsAttention[0].sessionId).toBe("sess1");
      expect(result.active).toHaveLength(0);
      expect(result.recentActivity).toHaveLength(0);
      expect(result.unread8h).toHaveLength(0);
    });

    it("session in active tier does not appear in lower tiers", async () => {
      const project = createProject("proj1", "myproject", "/sessions/proj1");
      // In-turn session that is also recent and unread
      const session = createSession("sess1", "proj1", minutesAgo(10));

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [session]);
      unreadMap.set("sess1", true);

      // Mock in-turn process without pending input
      processMap.set("sess1", {
        getPendingInputRequest: () => null,
        state: { type: "in-turn" },
      });

      const result = await makeRequest({
        scanner: mockScanner,
        readerFactory: mockReaderFactory,
        supervisor: mockSupervisor,
        notificationService: mockNotificationService,
        sessionIndexService: mockSessionIndexService,
      });

      // Should only appear in active tier
      expect(result.needsAttention).toHaveLength(0);
      expect(result.active).toHaveLength(1);
      expect(result.active[0].sessionId).toBe("sess1");
      expect(result.recentActivity).toHaveLength(0);
      expect(result.unread8h).toHaveLength(0);
    });
  });

  describe("sorting within tiers", () => {
    it("sorts items by updatedAt descending (most recent first)", async () => {
      const project = createProject("proj1", "myproject", "/sessions/proj1");
      // Create sessions with different update times
      const sessions = [
        createSession("sess-oldest", "proj1", minutesAgo(25)),
        createSession("sess-middle", "proj1", minutesAgo(15)),
        createSession("sess-newest", "proj1", minutesAgo(5)),
      ];

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", sessions);

      const result = await makeRequest({
        scanner: mockScanner,
        readerFactory: mockReaderFactory,
        supervisor: mockSupervisor,
        notificationService: mockNotificationService,
        sessionIndexService: mockSessionIndexService,
      });

      // All should be in recentActivity (< 30 min)
      expect(result.recentActivity).toHaveLength(3);
      // Most recent first
      expect(result.recentActivity[0].sessionId).toBe("sess-newest");
      expect(result.recentActivity[1].sessionId).toBe("sess-middle");
      expect(result.recentActivity[2].sessionId).toBe("sess-oldest");
    });
  });

  describe("tier limits", () => {
    it("limits each tier to 20 items", async () => {
      const project = createProject("proj1", "myproject", "/sessions/proj1");
      // Create 25 sessions, all recently updated
      const sessions: SessionSummary[] = [];
      for (let i = 0; i < 25; i++) {
        sessions.push(createSession(`sess-${i}`, "proj1", minutesAgo(i + 1)));
      }

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", sessions);

      const result = await makeRequest({
        scanner: mockScanner,
        readerFactory: mockReaderFactory,
        supervisor: mockSupervisor,
        notificationService: mockNotificationService,
        sessionIndexService: mockSessionIndexService,
      });

      // Should be capped at 20
      expect(result.recentActivity).toHaveLength(20);
      // Oldest sessions (sess-20 through sess-24) should be excluded
      const ids = result.recentActivity.map((item) => item.sessionId);
      expect(ids).not.toContain("sess-20");
      expect(ids).not.toContain("sess-24");
    });
  });

  describe("graceful handling of unavailable services", () => {
    it("works without supervisor", async () => {
      const project = createProject("proj1", "myproject", "/sessions/proj1");
      const session = createSession("sess1", "proj1", minutesAgo(10));

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [session]);

      // No supervisor provided
      const result = await makeRequest({
        scanner: mockScanner,
        readerFactory: mockReaderFactory,
        // supervisor: undefined
      });

      // Session should appear in recentActivity (no activity info)
      expect(result.recentActivity).toHaveLength(1);
      expect(result.recentActivity[0].sessionId).toBe("sess1");
      expect(result.recentActivity[0].activity).toBeUndefined();
      expect(result.recentActivity[0].pendingInputType).toBeUndefined();
    });

    it("works without notificationService", async () => {
      const project = createProject("proj1", "myproject", "/sessions/proj1");
      const session = createSession("sess1", "proj1", hoursAgo(4));

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [session]);

      // No notification service - session is older than 30 min, so won't be in recentActivity
      // Without hasUnread, it won't appear in unread tiers either
      const result = await makeRequest({
        scanner: mockScanner,
        readerFactory: mockReaderFactory,
        supervisor: mockSupervisor,
        // notificationService: undefined
      });

      // Session should not appear in any tier (no unread tracking)
      expect(result.needsAttention).toHaveLength(0);
      expect(result.active).toHaveLength(0);
      expect(result.recentActivity).toHaveLength(0);
      expect(result.unread8h).toHaveLength(0);
      expect(result.unread24h).toHaveLength(0);
    });

    it("works without sessionIndexService (uses reader directly)", async () => {
      const project = createProject("proj1", "myproject", "/sessions/proj1");
      const session = createSession("sess1", "proj1", minutesAgo(10));

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [session]);

      // No session index service - should use reader directly
      const result = await makeRequest({
        scanner: mockScanner,
        readerFactory: mockReaderFactory,
        supervisor: mockSupervisor,
        notificationService: mockNotificationService,
        // sessionIndexService: undefined
      });

      expect(result.recentActivity).toHaveLength(1);
      expect(result.recentActivity[0].sessionId).toBe("sess1");
    });

    it("returns empty tiers when no projects exist", async () => {
      vi.mocked(mockScanner.listProjects).mockResolvedValue([]);

      const result = await makeRequest({
        scanner: mockScanner,
        readerFactory: mockReaderFactory,
      });

      expect(result.needsAttention).toHaveLength(0);
      expect(result.active).toHaveLength(0);
      expect(result.recentActivity).toHaveLength(0);
      expect(result.unread8h).toHaveLength(0);
      expect(result.unread24h).toHaveLength(0);
    });
  });

  describe("multi-project aggregation", () => {
    it("aggregates sessions across multiple projects", async () => {
      const projects = [
        createProject("proj1", "project1", "/sessions/proj1"),
        createProject("proj2", "project2", "/sessions/proj2"),
      ];
      const sess1 = createSession("sess1", "proj1", minutesAgo(5));
      const sess2 = createSession("sess2", "proj2", minutesAgo(10));

      vi.mocked(mockScanner.listProjects).mockResolvedValue(projects);
      sessionsByDir.set("/sessions/proj1", [sess1]);
      sessionsByDir.set("/sessions/proj2", [sess2]);

      const result = await makeRequest({
        scanner: mockScanner,
        readerFactory: mockReaderFactory,
        supervisor: mockSupervisor,
        notificationService: mockNotificationService,
        sessionIndexService: mockSessionIndexService,
      });

      expect(result.recentActivity).toHaveLength(2);
      // Sorted by updatedAt descending
      expect(result.recentActivity[0].sessionId).toBe("sess1");
      expect(result.recentActivity[0].projectId).toBe("proj1");
      expect(result.recentActivity[1].sessionId).toBe("sess2");
      expect(result.recentActivity[1].projectId).toBe("proj2");
    });

    it("includes project name in inbox items", async () => {
      const project = createProject(
        "proj1",
        "my-awesome-project",
        "/sessions/proj1",
      );
      const session = createSession("sess1", "proj1", minutesAgo(10));

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [session]);

      const result = await makeRequest({
        scanner: mockScanner,
        readerFactory: mockReaderFactory,
        supervisor: mockSupervisor,
        notificationService: mockNotificationService,
        sessionIndexService: mockSessionIndexService,
      });

      expect(result.recentActivity[0].projectName).toBe("my-awesome-project");
    });

    it("uses customTitle when available", async () => {
      const project = createProject("proj1", "myproject", "/sessions/proj1");
      const session = createSession("sess1", "proj1", minutesAgo(10), {
        title: "Original title",
        customTitle: "My Custom Title",
      });

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [session]);

      const result = await makeRequest({
        scanner: mockScanner,
        readerFactory: mockReaderFactory,
        supervisor: mockSupervisor,
        notificationService: mockNotificationService,
        sessionIndexService: mockSessionIndexService,
      });

      expect(result.recentActivity[0].sessionTitle).toBe("My Custom Title");
    });

    it("includes starred metadata in inbox items", async () => {
      const project = createProject("proj1", "myproject", "/sessions/proj1");
      const session = createSession("sess1", "proj1", minutesAgo(10));

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [session]);
      metadataMap.set("sess1", { isStarred: true });

      const result = await makeRequest({
        scanner: mockScanner,
        readerFactory: mockReaderFactory,
        supervisor: mockSupervisor,
        notificationService: mockNotificationService,
        sessionIndexService: mockSessionIndexService,
        sessionMetadataService: mockSessionMetadataService,
      });

      expect(result.recentActivity[0].isStarred).toBe(true);
    });
  });

  describe("archived sessions", () => {
    it("excludes archived sessions from all tiers", async () => {
      const project = createProject("proj1", "myproject", "/sessions/proj1");

      // Archived session that would qualify for needsAttention
      const archivedSession = createSession(
        "archived-sess",
        "proj1",
        minutesAgo(5),
        { isArchived: true },
      );

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [archivedSession]);

      // Mock process with pending input - would normally put it in needsAttention
      processMap.set("archived-sess", {
        getPendingInputRequest: () => ({
          type: "tool-approval",
          id: "req1",
          prompt: "Allow?",
        }),
        state: { type: "waiting-input" },
      });

      const result = await makeRequest({
        scanner: mockScanner,
        readerFactory: mockReaderFactory,
        supervisor: mockSupervisor,
        notificationService: mockNotificationService,
        sessionIndexService: mockSessionIndexService,
      });

      // Archived session should be excluded from ALL tiers
      expect(result.needsAttention).toHaveLength(0);
      expect(result.active).toHaveLength(0);
      expect(result.recentActivity).toHaveLength(0);
      expect(result.unread8h).toHaveLength(0);
      expect(result.unread24h).toHaveLength(0);
    });

    it("excludes archived sessions from unread tiers", async () => {
      const project = createProject("proj1", "myproject", "/sessions/proj1");

      // Archived unread session within 8 hours
      const archivedSession = createSession(
        "archived-sess",
        "proj1",
        hoursAgo(4),
        {
          isArchived: true,
        },
      );
      // Non-archived unread session within 8 hours
      const normalSession = createSession("normal-sess", "proj1", hoursAgo(4));

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [archivedSession, normalSession]);
      unreadMap.set("archived-sess", true);
      unreadMap.set("normal-sess", true);

      const result = await makeRequest({
        scanner: mockScanner,
        readerFactory: mockReaderFactory,
        supervisor: mockSupervisor,
        notificationService: mockNotificationService,
        sessionIndexService: mockSessionIndexService,
      });

      // Archived session should be excluded from unread tier
      expect(result.unread8h).toHaveLength(1);
      expect(result.unread8h[0].sessionId).toBe("normal-sess");
    });

    it("excludes archived sessions from unread24h tier", async () => {
      const project = createProject("proj1", "myproject", "/sessions/proj1");

      // Archived unread session within 24 hours (but outside 8h)
      const archivedSession = createSession(
        "archived-sess",
        "proj1",
        hoursAgo(12),
        {
          isArchived: true,
        },
      );

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [archivedSession]);
      unreadMap.set("archived-sess", true);

      const result = await makeRequest({
        scanner: mockScanner,
        readerFactory: mockReaderFactory,
        supervisor: mockSupervisor,
        notificationService: mockNotificationService,
        sessionIndexService: mockSessionIndexService,
      });

      // Archived session should be excluded from unread24h tier
      expect(result.unread24h).toHaveLength(0);
    });

    it("includes codex sessions for projects whose primary provider is claude", async () => {
      const project = createProject("proj1", "project1", "/sessions/proj1");
      project.path = "/home/user/project1";
      const codexSession = createSession("codex-sess", "proj1", minutesAgo(5), {
        provider: "codex",
        title: "Codex session",
      });

      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      codexSessionsByPath.set(project.path, [codexSession]);

      const result = await makeRequest({
        scanner: mockScanner,
        readerFactory: mockReaderFactory,
        sessionIndexService: mockSessionIndexService,
        codexScanner: {
          listProjects: vi.fn(async () => [
            {
              ...project,
              sessionDir: "/tmp/codex-sessions",
              provider: "codex",
            },
          ]),
        } as unknown as CodexSessionScanner,
        codexSessionsDir: "/tmp/codex-sessions",
        codexReaderFactory: vi.fn(
          (projectPath: string) =>
            ({
              listSessions: vi.fn(
                async () => codexSessionsByPath.get(projectPath) ?? [],
              ),
              getAgentMappings: vi.fn(async () => []),
              getAgentSession: vi.fn(async () => null),
            }) as unknown as CodexSessionReader,
        ),
      });

      expect(result.recentActivity).toHaveLength(1);
      expect(result.recentActivity[0]?.sessionId).toBe("codex-sess");
      expect(result.recentActivity[0]?.sessionTitle).toBe("Codex session");
    });
  });

  /**
   * The Inbox is app-shell mounted, so every tab reads it on reconnect. What
   * may be shared is the walk; what may not is the tier decision, which is a
   * wall-clock window over the same rows.
   */
  describe("shared collection walk", () => {
    function setUpOneSession(eventBus?: EventBus): Hono {
      const project = createProject("proj1", "myproject", "/sessions/proj1");
      vi.mocked(mockScanner.listProjects).mockResolvedValue([project]);
      sessionsByDir.set("/sessions/proj1", [
        createSession("sess1", "proj1", minutesAgo(5)),
      ]);
      return createInboxRoutes({
        scanner: mockScanner,
        readerFactory: mockReaderFactory,
        supervisor: mockSupervisor,
        notificationService: mockNotificationService,
        sessionIndexService: mockSessionIndexService,
        sessionMetadataService: mockSessionMetadataService,
        eventBus,
      });
    }

    async function readInbox(routes: Hono, path = "/"): Promise<InboxResponse> {
      const response = await routes.request(path);
      expect(response.status).toBe(200);
      return response.json();
    }

    function walks(): number {
      return vi.mocked(mockScanner.listProjects).mock.calls.length;
    }

    it("walks every project once for a herd of concurrent reads", async () => {
      const routes = setUpOneSession();

      const herd = await Promise.all(
        Array.from({ length: 20 }, () => readInbox(routes)),
      );

      for (const result of herd) {
        expect(result.recentActivity).toHaveLength(1);
      }
      expect(walks()).toBe(1);
    });

    it("reuses the walk for a later read at the same generation", async () => {
      const routes = setUpOneSession();
      await readInbox(routes);
      await readInbox(routes);
      expect(walks()).toBe(1);
    });

    it("walks again once an event advances the collection", async () => {
      const eventBus = new EventBus();
      const routes = setUpOneSession(eventBus);
      await readInbox(routes);

      eventBus.emit({
        type: "session-metadata-changed",
        sessionId: "sess1",
        starred: true,
        timestamp: new Date().toISOString(),
      });
      await Promise.all(Array.from({ length: 20 }, () => readInbox(routes)));

      // One more walk for the new generation, not twenty, and not zero.
      expect(walks()).toBe(2);
    });

    it("re-tiers a retained walk against the current clock", async () => {
      const routes = setUpOneSession();
      expect((await readInbox(routes)).recentActivity).toHaveLength(1);

      // Nothing on the bus moved, so the walk is still the retained one. The
      // 30-minute window has to move anyway, or a session would sit in Recent
      // Activity until something unrelated happened.
      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + 31 * 60 * 1000);
      try {
        const later = await readInbox(routes);
        expect(later.recentActivity).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
      expect(walks()).toBe(1);
    });

    it("keeps a filtered read separate from the unfiltered one", async () => {
      const routes = setUpOneSession();
      await readInbox(routes);
      await readInbox(routes, "/?projectId=proj1");

      // Same generation, different collection: the filter is part of the key.
      expect(walks()).toBe(2);
    });
  });
});
