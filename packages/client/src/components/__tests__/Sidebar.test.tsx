// @vitest-environment jsdom

import {
  GIT_STATUS_ENHANCED_CAPABILITY,
  PROJECT_QUEUE_CAPABILITY,
  type ProjectQueueItemSummary,
  type ProjectQueueProjectStatus,
} from "@yep-anywhere/shared";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SAVED_HOSTS_KEY, UI_KEYS } from "../../lib/storageKeys";
import { SWITCH_HOST_RELOAD_STORAGE_KEY } from "../../lib/switchHostReload";
import { Sidebar } from "../Sidebar";

const {
  globalSessionsState,
  mockGlobalLoadMore,
  mockMoveItemToTop,
  mockPromoteNow,
  mockRemoteConnectionState,
  mockStarredLoadMore,
  mockToggleExpanded,
  mockShowToast,
  newSessionDraftState,
  projectQueueSidebarCountState,
  projectQueuesState,
  projectsState,
  starredSessionsState,
  versionState,
  categoriesState,
} = vi.hoisted(() => ({
  globalSessionsState: {
    sessions: [] as Array<Record<string, unknown>>,
    loading: false,
    hasMore: false,
    loadMore: vi.fn(),
  },
  starredSessionsState: {
    sessions: [] as Array<Record<string, unknown>>,
    loading: false,
    hasMore: false,
    loadMore: vi.fn(),
  },
  mockGlobalLoadMore: vi.fn(),
  mockMoveItemToTop: vi.fn(),
  mockPromoteNow: vi.fn(),
  mockRemoteConnectionState: {
    value: null as null | {
      disconnect: ReturnType<typeof vi.fn>;
      currentRelayUsername?: string;
    },
  },
  mockStarredLoadMore: vi.fn(),
  mockToggleExpanded: vi.fn(),
  mockShowToast: vi.fn(),
  newSessionDraftState: {
    hasDraft: false,
  },
  projectQueueSidebarCountState: {
    count: 0,
  },
  projectQueuesState: {
    queuesByProject: {} as Record<string, ProjectQueueItemSummary[]>,
    dispatchState: { status: "running" } as { status: "running" | "paused" },
  },
  projectsState: {
    projects: [] as Array<Record<string, unknown>>,
  },
  versionState: {
    capabilities: [] as string[],
  },
  categoriesState: {
    supported: false,
  },
}));

vi.mock("../../contexts/ToastContext", () => ({
  useToastContext: () => ({ showToast: mockShowToast }),
}));

vi.mock("../../contexts/RemoteConnectionContext", () => ({
  useOptionalRemoteConnection: () => mockRemoteConnectionState.value,
}));

vi.mock("../../hooks/useDrafts", () => ({
  useNewSessionDraft: () => newSessionDraftState.hasDraft,
}));

vi.mock("../../hooks/useProjectQueues", () => ({
  useProjectQueues: () => ({
    queuesByProject: projectQueuesState.queuesByProject,
    items: Object.values(projectQueuesState.queuesByProject).flat(),
    projectStatusesByProject: {},
    recoveredSessionQueues: [],
    loading: false,
    error: null,
    mutatingItemId: null,
    mutatingDispatchState: false,
    mutatingPromoteItemId: null,
    dispatchState: projectQueuesState.dispatchState,
    refetch: vi.fn(),
    pauseDispatch: vi.fn(),
    resumeDispatch: vi.fn(),
    promoteNow: mockPromoteNow,
    updateItem: vi.fn(),
    deleteItem: vi.fn(),
    retryItem: vi.fn(),
    moveItemToTop: mockMoveItemToTop,
  }),
}));

vi.mock("../../hooks/useProjects", () => ({
  useProjects: () => ({
    projects: projectsState.projects,
    loading: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

vi.mock("../../hooks/useProcesses", () => ({
  useProcesses: () => ({
    processes: [],
    terminatedProcesses: [],
  }),
}));

vi.mock("../../hooks/useSidebarSessionFeeds", () => ({
  SIDEBAR_SESSION_FEED_LIMIT: 50,
  useSidebarSessionFeeds: () => ({
    globalQuery: { scope: "global-sessions" },
    starredQuery: { scope: "global-sessions", starred: true },
    loading: globalSessionsState.loading || starredSessionsState.loading,
    hasMoreGlobalSessions: globalSessionsState.hasMore,
    loadMoreGlobalSessions: globalSessionsState.loadMore,
    hasMoreStarredSessions: starredSessionsState.hasMore,
    loadMoreStarredSessions: starredSessionsState.loadMore,
    sidebarCategoriesSupported: categoriesState.supported,
    hasMoreCategorizedSessions: false,
    loadMoreCategorizedSessions: async () => {},
  }),
}));

vi.mock("../../lib/clientSummaryStore", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../lib/clientSummaryStore")>();
  return {
    ...actual,
    useDraftSessionIds: () => new Set<string>(),
    useInboxCounts: () => ({
      needsAttention: 0,
      active: 0,
      total: 0,
    }),
    useSessionCollectionQueryRecords: (query: { starred?: boolean }) =>
      query.starred
        ? starredSessionsState.sessions
        : globalSessionsState.sessions,
    useStarredSessionRecords: () => {
      const sessionsById = new Map<string, Record<string, unknown>>();
      for (const session of [
        ...globalSessionsState.sessions,
        ...starredSessionsState.sessions,
      ]) {
        if (
          typeof session.id === "string" &&
          session.isStarred === true &&
          session.isArchived !== true
        ) {
          sessionsById.set(session.id, session);
        }
      }
      return Array.from(sessionsById.values());
    },
    useCategorizedSessionRecords: () =>
      globalSessionsState.sessions.filter(
        (session) => session.sidebarCategory && session.isArchived !== true,
      ),
    useKnownProjectQueueItems: () =>
      Object.values(projectQueuesState.queuesByProject).flat(),
    useProjectQueuedSessionIds: () => {
      const sessionIds = new Set<string>();
      for (const items of Object.values(projectQueuesState.queuesByProject)) {
        for (const item of items) {
          if (
            item.target.type === "existing-session" &&
            item.target.sessionId
          ) {
            sessionIds.add(item.target.sessionId);
          }
        }
      }
      return sessionIds;
    },
    useProjectQueueSidebarCount: () => projectQueueSidebarCountState.count,
  };
});

vi.mock("../../hooks/useRemoteBasePath", () => ({
  useRemoteBasePath: () => "/remote/test",
}));

vi.mock("../../hooks/usePublicShareStatus", () => ({
  usePublicShareStatus: () => ({
    status: null,
  }),
}));

vi.mock("../../hooks/useServerSettings", () => ({
  useServerSettings: () => ({
    settings: {
      publicSharesEnabled: false,
    },
  }),
}));

vi.mock("../../hooks/useVersion", () => ({
  useVersion: () => ({
    version: {
      capabilities: versionState.capabilities,
    },
  }),
}));

vi.mock("../../i18n", () => ({
  useI18n: () => ({
    t: (key: string, vars?: Record<string, string | number>) => {
      const messages = {
        actionExpandSidebar: "Expand sidebar",
        actionCloseSidebar: "Close sidebar",
        sidebarNewSession: "New Session",
        sidebarInbox: "Inbox",
        sidebarAllSessions: "All Sessions",
        sidebarProjects: "Projects",
        sidebarSourceControl: "Source Control",
        projectCardQueueCount: "Project Queue items: {count}",
        sidebarSectionPendingSessions: "Pending Sessions",
        sidebarSettings: "Settings",
        sidebarSwitchHost: "Switch Host",
        sidebarSectionStarred: "Starred",
        sidebarSectionLast24Hours: "Last 24 Hours",
        sidebarSectionOlder: "Older",
        sidebarSectionExpand: "Expand",
        sidebarSectionCollapse: "Collapse",
        sidebarEmpty: "No sessions yet",
        sidebarHiddenDuplicateSessions: "{count} hidden (duplicate titles)",
        projectQueueStatusQueued: "Queued",
        projectQueueStatusFailed: "Failed",
        projectQueueTargetNewSession: "New session",
        projectQueueUnknownProject: "Unknown project",
        sidebarSessionResume: "Resume",
        sidebarPendingSessionResumeTitle:
          "Resume Project Queue dispatch with this pending session first",
        sidebarPendingSessionResumeFailed:
          "Failed to resume pending session: {message}",
      } as Record<string, string>;
      let text = messages[key] ?? key;
      if (vars) {
        for (const [name, value] of Object.entries(vars)) {
          text = text.replaceAll(`{${name}}`, String(value));
        }
      }
      return text;
    },
  }),
}));

vi.mock("../AgentsNavItem", () => ({
  AgentsNavItem: () => null,
}));

vi.mock("../SessionListItem", () => ({
  SessionListItem: ({
    sessionId,
    title,
    activity,
    hasProjectQueue,
  }: {
    sessionId: string;
    title: string;
    activity?: string;
    hasProjectQueue?: boolean;
  }) => (
    <li data-testid={`session-${sessionId}`} data-activity={activity ?? ""}>
      {title}
      {activity === "in-turn" ? (
        <span data-testid={`thinking-${sessionId}`}>Thinking</span>
      ) : null}
      {hasProjectQueue ? <span>Q</span> : null}
    </li>
  ),
}));

function makeSession(
  id: string,
  updatedAt: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    projectId: "project-1",
    projectName: "Project",
    title: `Session ${id}`,
    createdAt: updatedAt,
    updatedAt,
    messageCount: 1,
    ownership: { owner: "none" },
    provider: "claude",
    isArchived: false,
    isStarred: false,
    ...overrides,
  };
}

function makeProjectQueueItem(
  id: string,
  overrides: Partial<ProjectQueueItemSummary> = {},
): ProjectQueueItemSummary {
  return {
    id,
    projectId: "project-1" as ProjectQueueItemSummary["projectId"],
    target: { type: "new-session", title: `Pending ${id}` },
    messagePreview: `Pending ${id}`,
    message: { text: `Pending ${id}` },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "queued",
    attachmentCount: 0,
    ...overrides,
  };
}

function makeProjectStatus(
  state: ProjectQueueProjectStatus["state"],
): ProjectQueueProjectStatus {
  return {
    projectId: "project-1" as ProjectQueueProjectStatus["projectId"],
    state,
    idle: state !== "blocked",
    blockers: state === "blocked" ? ["session-1:in-turn"] : [],
    dispatchPaused: state === "paused",
    inFlight: state === "dispatching",
    quietWindowMs: 30_000,
    itemCount: 1,
  };
}

function LocationProbe() {
  const location = useLocation();
  return (
    <div data-testid="location">
      {location.pathname}
      {location.search}
    </div>
  );
}

/** Render order (top → bottom) of the rendered rows in the Last 24 Hours list. */
function last24HourIds(container: HTMLElement): string[] {
  const list = container.querySelector("#sidebar-last-24-hours-list");
  if (!list) return [];
  return Array.from(list.querySelectorAll("[data-testid^='session-']")).map(
    (el) => el.getAttribute("data-testid")?.replace("session-", "") ?? "",
  );
}

describe("Sidebar collapsed toggle", () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
    });
    mockToggleExpanded.mockReset();
    mockMoveItemToTop.mockReset();
    mockMoveItemToTop.mockResolvedValue(undefined);
    mockPromoteNow.mockReset();
    mockShowToast.mockReset();
    mockRemoteConnectionState.value = null;
    mockGlobalLoadMore.mockReset();
    mockStarredLoadMore.mockReset();
    categoriesState.supported = false;
    globalSessionsState.sessions = [];
    globalSessionsState.loading = false;
    globalSessionsState.hasMore = false;
    globalSessionsState.loadMore = mockGlobalLoadMore;
    starredSessionsState.sessions = [];
    starredSessionsState.loading = false;
    starredSessionsState.hasMore = false;
    starredSessionsState.loadMore = mockStarredLoadMore;
    newSessionDraftState.hasDraft = false;
    projectQueuesState.queuesByProject = {};
    projectQueuesState.dispatchState = { status: "running" };
    projectQueueSidebarCountState.count = 0;
    projectsState.projects = [];
    versionState.capabilities = [];
  });

  afterEach(() => {
    cleanup();
    sessionStorage.removeItem(SWITCH_HOST_RELOAD_STORAGE_KEY);
    vi.unstubAllGlobals();
  });

  function renderSidebar() {
    render(
      <MemoryRouter>
        <Sidebar
          isOpen={true}
          onClose={() => {}}
          onNavigate={() => {}}
          isDesktop={true}
          isCollapsed={true}
          onToggleExpanded={mockToggleExpanded}
        />
      </MemoryRouter>,
    );
  }

  it("expands the sidebar on a normal click", () => {
    renderSidebar();

    fireEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));

    expect(mockToggleExpanded).toHaveBeenCalledTimes(1);
  });

  it("exposes the expanded new-session target to native middle click", () => {
    renderSidebar();

    const toggle = screen.getByRole("button", { name: "Expand sidebar" });
    expect(toggle.getAttribute("href")).toBe(
      "/remote/test/new-session?sidebar=expanded",
    );
    expect(toggle.getAttribute("target")).toBe("_blank");
    expect(toggle.getAttribute("rel")).toBe("noopener");
    expect(toggle.getAttribute("title")).toBe(
      "Expand sidebar / [Shift] New Session",
    );

    const auxClick = new MouseEvent("auxclick", {
      bubbles: true,
      cancelable: true,
      button: 1,
    });
    expect(toggle.dispatchEvent(auxClick)).toBe(true);
    expect(auxClick.defaultPrevented).toBe(false);
    expect(mockToggleExpanded).not.toHaveBeenCalled();
  });

  it("renders the relay Switch Host with the standard nav-item representation", () => {
    mockRemoteConnectionState.value = { disconnect: vi.fn() };

    renderSidebar();

    // Switch Host must share the exact representation of standard nav items
    // (data-sidebar-nav-item with a data-sidebar-nav-text label) so it inherits
    // the shared data-sidebar-collapsed icon-only presentation
    // in the mini rail, rather than relying on a bespoke per-item guard. The
    // visual icon-only outcome is a CSS concern, verified at the browser level.
    const switchHost = screen.getByRole("button", { name: "Switch Host" });
    expect(switchHost.hasAttribute("data-sidebar-nav-item")).toBe(true);
    const label = switchHost.querySelector("[data-sidebar-nav-text]");
    expect(label?.textContent).toBe("Switch Host");
  });

  it("reloads the host picker when switching hosts", () => {
    const originalLocation = window.location;
    const replace = vi.fn();
    const disconnect = vi.fn();
    mockRemoteConnectionState.value = { disconnect };
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        href: "https://ya.example/remote/current/session",
        replace,
      },
    });

    try {
      renderSidebar();
      fireEvent.click(screen.getByRole("button", { name: "Switch Host" }));

      expect(disconnect).toHaveBeenCalledOnce();
      expect(replace).toHaveBeenCalledOnce();
      expect(sessionStorage.getItem(SWITCH_HOST_RELOAD_STORAGE_KEY)).toBe("1");
      const reloadUrl = new URL(String(replace.mock.calls[0]?.[0]));
      expect(reloadUrl.pathname).toBe("/remote/current/session");
      expect(reloadUrl.searchParams.get("__ya_reload")).toMatch(/^\d+$/);
    } finally {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: originalLocation,
      });
    }
  });

  it("right-click on Switch Host offers recent hosts and opens one by route", () => {
    const host = (
      relayUsername: string,
      displayName: string,
      lastConnected: string,
    ) => ({
      id: relayUsername,
      displayName,
      mode: "relay",
      relayUrl: "wss://relay.example/ws",
      relayUsername,
      srpUsername: "me",
      lastConnected,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    localStorage.setItem(
      SAVED_HOSTS_KEY,
      JSON.stringify({
        version: 1,
        hosts: [
          host("older", "Older box", "2026-10-01T00:00:00.000Z"),
          host("current", "This box", "2026-10-07T00:00:00.000Z"),
          host("windows", "Windows", "2026-10-06T00:00:00.000Z"),
        ],
      }),
    );
    const disconnect = vi.fn();
    mockRemoteConnectionState.value = {
      disconnect,
      currentRelayUsername: "current",
    };
    const onNavigate = vi.fn();

    try {
      render(
        <MemoryRouter initialEntries={["/-/relay/current/projects"]}>
          <Sidebar
            isOpen={true}
            onClose={() => {}}
            onNavigate={onNavigate}
            isDesktop={true}
            isCollapsed={true}
            onToggleExpanded={mockToggleExpanded}
          />
          <Routes>
            <Route path="*" element={<LocationProbe />} />
          </Routes>
        </MemoryRouter>,
      );

      fireEvent.contextMenu(
        screen.getByRole("button", { name: "Switch Host" }),
      );
      const items = screen
        .getAllByRole("menuitem")
        .map((item) => item.textContent);
      // The current host is omitted and the previous host leads.
      expect(items).toEqual([
        "Windowswindows",
        "Older boxolder",
        "sidebarSwitchHostMenuAllHosts",
      ]);

      fireEvent.click(screen.getAllByRole("menuitem")[0] as HTMLElement);

      expect(screen.getByTestId("location").textContent).toBe(
        "/-/relay/windows/projects",
      );
      expect(onNavigate).toHaveBeenCalledOnce();
      expect(disconnect).not.toHaveBeenCalled();
      expect(screen.queryByRole("menu")).toBeNull();
    } finally {
      localStorage.removeItem(SAVED_HOSTS_KEY);
    }
  });

  it("renders loaded sidebar sessions without a show-more gate", () => {
    globalSessionsState.sessions = Array.from({ length: 13 }, (_, index) =>
      makeSession(
        String(index + 1),
        new Date(Date.now() - index * 60_000).toISOString(),
      ),
    );

    render(
      <MemoryRouter>
        <Sidebar
          isOpen={true}
          onClose={() => {}}
          onNavigate={() => {}}
          isDesktop={true}
          isCollapsed={false}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("Session 13")).toBeDefined();
    expect(screen.queryByText("Show more")).toBeNull();
  });

  it("marks sidebar rows that have Project Queue items", () => {
    versionState.capabilities = [PROJECT_QUEUE_CAPABILITY];
    globalSessionsState.sessions = [
      makeSession("queued-session", new Date().toISOString()),
      makeSession("plain-session", new Date(Date.now() - 60_000).toISOString()),
    ];
    projectQueuesState.queuesByProject = {
      "project-1": [
        makeProjectQueueItem("queue-session", {
          target: {
            type: "existing-session",
            sessionId: "queued-session",
          },
        }),
      ],
    };

    renderSidebar();

    expect(screen.getByTestId("session-queued-session").textContent).toContain(
      "Q",
    );
    expect(
      screen.getByTestId("session-plain-session").textContent,
    ).not.toContain("Q");
  });

  it("hides the sidebar thinking dot for queue-only active rows", () => {
    versionState.capabilities = [PROJECT_QUEUE_CAPABILITY];
    globalSessionsState.sessions = [
      makeSession("queued-session", new Date().toISOString(), {
        activity: "in-turn",
        activityInferredFromInboxTier: true,
      }),
    ];
    projectQueuesState.queuesByProject = {
      "project-1": [
        makeProjectQueueItem("queue-session", {
          target: {
            type: "existing-session",
            sessionId: "queued-session",
          },
        }),
      ],
    };

    renderSidebar();

    expect(screen.getByTestId("session-queued-session").textContent).toContain(
      "Q",
    );
    expect(screen.queryByTestId("thinking-queued-session")).toBeNull();
    expect(screen.getByTestId("session-queued-session").dataset.activity).toBe(
      "",
    );
  });

  it("hides stale queue-inferred thinking after the queue clears", () => {
    globalSessionsState.sessions = [
      makeSession("queued-session", new Date().toISOString(), {
        activity: "in-turn",
        activityInferredFromInboxTier: true,
      }),
    ];

    renderSidebar();

    expect(screen.queryByTestId("thinking-queued-session")).toBeNull();
    expect(screen.getByTestId("session-queued-session").dataset.activity).toBe(
      "",
    );
  });

  it("keeps the sidebar thinking dot for real in-turn queued rows", () => {
    versionState.capabilities = [PROJECT_QUEUE_CAPABILITY];
    globalSessionsState.sessions = [
      makeSession("active-queued-session", new Date().toISOString(), {
        activity: "in-turn",
      }),
    ];
    projectQueuesState.queuesByProject = {
      "project-1": [
        makeProjectQueueItem("queue-session", {
          target: {
            type: "existing-session",
            sessionId: "active-queued-session",
          },
        }),
      ],
    };

    renderSidebar();

    expect(screen.getByTestId("thinking-active-queued-session")).toBeDefined();
    expect(
      screen.getByTestId("session-active-queued-session").dataset.activity,
    ).toBe("in-turn");
  });

  it("shows the Project Queue count on the Projects nav item", () => {
    versionState.capabilities = [PROJECT_QUEUE_CAPABILITY];
    projectQueueSidebarCountState.count = 3;

    renderSidebar();

    const projectsLink = screen.getByRole("link", { name: /Projects/i });
    expect(projectsLink.textContent).toContain("3");
    expect(
      within(projectsLink).getByTestId("sidebar-nav-badge-projectQueue")
        .textContent,
    ).toBe("3");
  });

  it("links Source Control to the project selected in the sessions filter", () => {
    versionState.capabilities = [GIT_STATUS_ENHANCED_CAPABILITY];
    projectsState.projects = [
      { id: "project-1", name: "Alpha" },
      { id: "project-2", name: "Beta" },
    ];

    render(
      <MemoryRouter
        initialEntries={["/sessions?project=project-2&source=projects"]}
      >
        <Sidebar
          isOpen={true}
          onClose={() => {}}
          onNavigate={() => {}}
          isDesktop={true}
          isCollapsed={false}
        />
      </MemoryRouter>,
    );

    expect(
      screen.getByRole("link", { name: "Source Control" }).getAttribute("href"),
    ).toBe("/remote/test/git-status?projectId=project-2");
  });

  it("links Source Control to the current session project", () => {
    versionState.capabilities = [GIT_STATUS_ENHANCED_CAPABILITY];
    projectsState.projects = [
      { id: "project-1", name: "Alpha" },
      { id: "project-2", name: "Beta" },
    ];

    render(
      <MemoryRouter initialEntries={["/projects/project-1/sessions/session-1"]}>
        <Sidebar
          isOpen={true}
          onClose={() => {}}
          onNavigate={() => {}}
          isDesktop={true}
          isCollapsed={false}
        />
      </MemoryRouter>,
    );

    expect(
      screen.getByRole("link", { name: "Source Control" }).getAttribute("href"),
    ).toBe("/remote/test/git-status?projectId=project-1");
  });

  it("keeps Source Control active when its link includes project context", () => {
    versionState.capabilities = [GIT_STATUS_ENHANCED_CAPABILITY];
    projectsState.projects = [{ id: "project-1", name: "Alpha" }];

    render(
      <MemoryRouter initialEntries={["/git-status?projectId=project-1"]}>
        <Sidebar
          isOpen={true}
          onClose={() => {}}
          onNavigate={() => {}}
          isDesktop={true}
          isCollapsed={false}
        />
      </MemoryRouter>,
    );

    expect(
      screen
        .getByRole("link", { name: "Source Control" })
        .hasAttribute("data-sidebar-active"),
    ).toBe(true);
  });

  it("links pending new-session Project Queue items to the Projects page", () => {
    versionState.capabilities = [PROJECT_QUEUE_CAPABILITY];
    projectsState.projects = [
      {
        id: "project-1",
        name: "Alpha",
        projectQueueCount: 1,
      },
    ];
    projectQueuesState.queuesByProject = {
      "project-1": [
        makeProjectQueueItem("queue-new-session", {
          target: { type: "new-session", title: "Queued launch" },
          messagePreview: "Queued launch",
        }),
      ],
    };

    renderSidebar();

    expect(screen.getByText("Pending Sessions")).toBeDefined();
    const link = screen.getByRole("link", { name: /Queued launch/i });
    expect(link.getAttribute("href")).toBe(
      "/remote/test/projects?queueItem=queue-new-session",
    );
  });

  it("resumes restart-paused dispatch with the selected pending item first", async () => {
    versionState.capabilities = [PROJECT_QUEUE_CAPABILITY];
    projectsState.projects = [
      {
        id: "project-1",
        name: "Alpha",
        projectQueueCount: 2,
      },
    ];
    projectQueuesState.dispatchState = { status: "paused" };
    projectQueuesState.queuesByProject = {
      "project-1": [
        makeProjectQueueItem("queue-first"),
        makeProjectQueueItem("queue-selected", {
          target: { type: "new-session", title: "Selected pending session" },
        }),
      ],
    };

    renderSidebar();
    const selectedLink = screen.getByRole("link", {
      name: /Selected pending session/i,
    });
    const row = selectedLink.closest("li");
    const resume = row?.querySelector("button");
    expect(resume?.textContent).toBe("Resume");

    fireEvent.click(resume as Element);

    await waitFor(() =>
      expect(mockMoveItemToTop).toHaveBeenCalledWith(
        "project-1",
        "queue-selected",
      ),
    );
    expect(mockPromoteNow).not.toHaveBeenCalled();
  });

  it("starts queued new-session sidebar rows before navigating", async () => {
    versionState.capabilities = [PROJECT_QUEUE_CAPABILITY];
    projectsState.projects = [
      {
        id: "project-1",
        name: "Alpha",
        projectQueueCount: 1,
      },
    ];
    projectQueuesState.queuesByProject = {
      "project-1": [
        makeProjectQueueItem("queue-new-session", {
          target: { type: "new-session", title: "Queued launch" },
          messagePreview: "Queued launch",
        }),
      ],
    };
    mockPromoteNow.mockResolvedValue({
      promoted: true,
      itemId: "queue-new-session",
      sessionId: "session-created",
      reason: "promoted",
      status: makeProjectStatus("empty"),
    });
    const onNavigate = vi.fn();

    render(
      <MemoryRouter>
        <Sidebar
          isOpen={true}
          onClose={() => {}}
          onNavigate={onNavigate}
          isDesktop={true}
          isCollapsed={true}
          onToggleExpanded={mockToggleExpanded}
        />
        <Routes>
          <Route path="*" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("link", { name: /Queued launch/i }));

    await waitFor(() =>
      expect(mockPromoteNow).toHaveBeenCalledWith(
        "project-1",
        "queue-new-session",
      ),
    );
    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toBe(
        "/remote/test/projects/project-1/sessions/session-created",
      ),
    );
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it("keeps the highest-message duplicate session visible", () => {
    const sharedTitle = "Repeated session";
    const now = Date.now();
    globalSessionsState.sessions = [
      makeSession("thin", new Date(now).toISOString(), {
        title: sharedTitle,
        fullTitle: sharedTitle,
        messageCount: 1,
      }),
      makeSession("substantive", new Date(now - 60_000).toISOString(), {
        title: sharedTitle,
        fullTitle: sharedTitle,
        messageCount: 12,
      }),
    ];

    render(
      <MemoryRouter>
        <Sidebar
          isOpen={true}
          onClose={() => {}}
          onNavigate={() => {}}
          isDesktop={true}
          isCollapsed={false}
        />
      </MemoryRouter>,
    );

    expect(screen.getByTestId("session-substantive")).toBeDefined();
    expect(screen.queryByTestId("session-thin")).toBeNull();
  });

  it("does not send duplicate-title prompt text to the console", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const privatePrompt = "private prompt marker";
    const now = Date.now();
    globalSessionsState.sessions = [
      makeSession("first", new Date(now).toISOString(), {
        fullTitle: privatePrompt,
      }),
      makeSession("second", new Date(now - 60_000).toISOString(), {
        fullTitle: privatePrompt,
      }),
    ];

    try {
      render(
        <MemoryRouter>
          <Sidebar
            isOpen={true}
            onClose={() => {}}
            onNavigate={() => {}}
            isDesktop={true}
            isCollapsed={false}
          />
        </MemoryRouter>,
      );

      expect(JSON.stringify(debugSpy.mock.calls)).not.toContain(privatePrompt);
    } finally {
      debugSpy.mockRestore();
    }
  });

  it("keeps the current same-title fork visible even with fewer messages", () => {
    const sharedTitle = "Bug hunt";
    const now = Date.now();
    globalSessionsState.sessions = [
      makeSession("parent", new Date(now - 60_000).toISOString(), {
        title: sharedTitle,
        fullTitle: sharedTitle,
        messageCount: 198,
      }),
      makeSession("current-fork", new Date(now).toISOString(), {
        title: sharedTitle,
        fullTitle: sharedTitle,
        messageCount: 81,
        forkedFromSessionId: "parent",
      }),
    ];

    render(
      <MemoryRouter>
        <Sidebar
          isOpen={true}
          onClose={() => {}}
          onNavigate={() => {}}
          currentSessionId="current-fork"
          isDesktop={true}
          isCollapsed={false}
        />
      </MemoryRouter>,
    );

    expect(screen.getByTestId("session-current-fork")).toBeDefined();
    expect(screen.getByTestId("session-parent")).toBeDefined();
    expect(screen.queryByText(/hidden \(duplicate titles\)/)).toBeNull();
  });

  it("keeps self-owned idle same-title sessions visible", () => {
    const sharedTitle = "Retitle work";
    const now = Date.now();
    globalSessionsState.sessions = [
      makeSession("owned", new Date(now).toISOString(), {
        title: sharedTitle,
        fullTitle: sharedTitle,
        messageCount: 1,
        ownership: { owner: "self", processId: "process-owned" },
      }),
      makeSession("larger", new Date(now - 60_000).toISOString(), {
        title: sharedTitle,
        fullTitle: sharedTitle,
        messageCount: 20,
      }),
    ];

    render(
      <MemoryRouter>
        <Sidebar
          isOpen={true}
          onClose={() => {}}
          onNavigate={() => {}}
          isDesktop={true}
          isCollapsed={false}
        />
      </MemoryRouter>,
    );

    expect(screen.getByTestId("session-owned")).toBeDefined();
    expect(screen.getByTestId("session-larger")).toBeDefined();
    expect(screen.queryByText(/hidden \(duplicate titles\)/)).toBeNull();
  });

  it("does not let a same-title helper child hide its source", () => {
    const sharedTitle = "Summarize this session";
    const now = Date.now();
    globalSessionsState.sessions = [
      makeSession("source", new Date(now - 60_000).toISOString(), {
        title: sharedTitle,
        fullTitle: sharedTitle,
        messageCount: 4,
      }),
      makeSession("helper", new Date(now).toISOString(), {
        title: sharedTitle,
        fullTitle: sharedTitle,
        messageCount: 12,
        forkedFromSessionId: "source",
      }),
    ];

    render(
      <MemoryRouter>
        <Sidebar
          isOpen={true}
          onClose={() => {}}
          onNavigate={() => {}}
          isDesktop={true}
          isCollapsed={false}
        />
      </MemoryRouter>,
    );

    expect(screen.getByTestId("session-source")).toBeDefined();
    expect(screen.getByTestId("session-helper")).toBeDefined();
    expect(screen.queryByText(/hidden \(duplicate titles\)/)).toBeNull();
  });

  it("does not group rows that only share compact truncated titles", () => {
    const compactTitle = "Shared compact title";
    const now = Date.now();
    globalSessionsState.sessions = [
      makeSession("first", new Date(now).toISOString(), {
        title: compactTitle,
        fullTitle: `${compactTitle} with first distinct full prompt`,
        messageCount: 1,
      }),
      makeSession("second", new Date(now - 60_000).toISOString(), {
        title: compactTitle,
        fullTitle: `${compactTitle} with second distinct full prompt`,
        messageCount: 20,
      }),
    ];

    render(
      <MemoryRouter>
        <Sidebar
          isOpen={true}
          onClose={() => {}}
          onNavigate={() => {}}
          isDesktop={true}
          isCollapsed={false}
        />
      </MemoryRouter>,
    );

    expect(screen.getByTestId("session-first")).toBeDefined();
    expect(screen.getByTestId("session-second")).toBeDefined();
    expect(screen.queryByText(/hidden \(duplicate titles\)/)).toBeNull();
  });

  it("shows recent and older duplicates when duplicate hiding is disabled", () => {
    window.localStorage.setItem(UI_KEYS.sidebarDuplicateHidingEnabled, "false");
    const sharedRecentTitle = "Repeated recent session";
    const sharedOlderTitle = "Repeated older session";
    const now = Date.now();
    globalSessionsState.sessions = [
      makeSession("recent-thin", new Date(now).toISOString(), {
        title: sharedRecentTitle,
        fullTitle: sharedRecentTitle,
        messageCount: 1,
      }),
      makeSession("recent-substantive", new Date(now - 60_000).toISOString(), {
        title: sharedRecentTitle,
        fullTitle: sharedRecentTitle,
        messageCount: 12,
      }),
      makeSession(
        "older-thin",
        new Date(now - 48 * 60 * 60 * 1000).toISOString(),
        {
          title: sharedOlderTitle,
          fullTitle: sharedOlderTitle,
          messageCount: 1,
        },
      ),
      makeSession(
        "older-substantive",
        new Date(now - 49 * 60 * 60 * 1000).toISOString(),
        {
          title: sharedOlderTitle,
          fullTitle: sharedOlderTitle,
          messageCount: 12,
        },
      ),
    ];

    render(
      <MemoryRouter>
        <Sidebar
          isOpen={true}
          onClose={() => {}}
          onNavigate={() => {}}
          isDesktop={true}
          isCollapsed={false}
        />
      </MemoryRouter>,
    );

    expect(screen.getByTestId("session-recent-thin")).toBeDefined();
    expect(screen.getByTestId("session-recent-substantive")).toBeDefined();
    expect(screen.getByTestId("session-older-thin")).toBeDefined();
    expect(screen.getByTestId("session-older-substantive")).toBeDefined();
    expect(screen.queryByText(/hidden \(duplicate titles\)/)).toBeNull();
  });

  it("shows a draft badge on the new session action", () => {
    newSessionDraftState.hasDraft = true;

    render(
      <MemoryRouter>
        <Sidebar
          isOpen={true}
          onClose={() => {}}
          onNavigate={() => {}}
          isDesktop={true}
          isCollapsed={false}
        />
      </MemoryRouter>,
    );

    const newSessionLink = screen.getByRole("link", { name: /New Session/i });
    const newSessionIcon = newSessionLink.querySelector(
      "[data-sidebar-new-session-icon]",
    );
    expect(newSessionIcon?.getAttribute("width")).toBe("16");
    expect(newSessionIcon?.getAttribute("height")).toBe("16");
    expect(newSessionIcon?.querySelector("circle")).toBeTruthy();
    expect(newSessionIcon?.querySelectorAll("line")).toHaveLength(2);
    expect(screen.getByText("Draft")).toBeDefined();
  });

  it("collapses and expands the last-24-hours bucket", () => {
    globalSessionsState.sessions = [
      makeSession("recent", new Date().toISOString()),
    ];

    render(
      <MemoryRouter>
        <Sidebar
          isOpen={true}
          onClose={() => {}}
          onNavigate={() => {}}
          isDesktop={true}
          isCollapsed={false}
        />
      </MemoryRouter>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Collapse: Last 24 Hours" }),
    );
    expect(screen.queryByText("Session recent")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Expand: Last 24 Hours" }),
    );
    expect(screen.getByText("Session recent")).toBeDefined();
  });

  it("collapses and expands the starred bucket", () => {
    starredSessionsState.sessions = [
      makeSession("starred", new Date().toISOString(), { isStarred: true }),
    ];

    render(
      <MemoryRouter>
        <Sidebar
          isOpen={true}
          onClose={() => {}}
          onNavigate={() => {}}
          isDesktop={true}
          isCollapsed={false}
        />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Collapse: Starred" }));
    expect(screen.queryByText("Session starred")).toBeNull();
    expect(
      JSON.parse(
        window.localStorage.getItem(UI_KEYS.sidebarSectionExpansion) ?? "{}",
      ).starred,
    ).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Expand: Starred" }));
    expect(screen.getByText("Session starred")).toBeDefined();
    expect(
      JSON.parse(
        window.localStorage.getItem(UI_KEYS.sidebarSectionExpansion) ?? "{}",
      ).starred,
    ).toBe(true);
  });

  it("shows category and limited-user sections that toggle by name", () => {
    categoriesState.supported = true;
    const now = new Date().toISOString();
    globalSessionsState.sessions = [
      makeSession("filed", now, { sidebarCategory: "Paper" }),
      makeSession("archer-row", now, { createdByUser: "archer" }),
      makeSession("mine", now),
    ];

    const { container } = render(
      <MemoryRouter>
        <Sidebar
          isOpen={true}
          onClose={() => {}}
          onNavigate={() => {}}
          isDesktop={true}
          isCollapsed={false}
        />
      </MemoryRouter>,
    );

    expect(last24HourIds(container)).toEqual(["mine"]);
    const headings = Array.from(container.querySelectorAll("h3")).map(
      (heading) => heading.textContent,
    );
    expect(headings).toEqual(["Paper", "Last 24 Hours", "archer"]);

    fireEvent.click(screen.getByRole("button", { name: "Collapse: archer" }));
    expect(screen.queryByText("Session archer-row")).toBeNull();
    // A closed section tells how many rows it holds.
    expect(
      screen.getByRole("button", { name: "Expand: archer" }).textContent,
    ).toBe("archer1");
    expect(
      JSON.parse(
        window.localStorage.getItem(UI_KEYS.sidebarSectionExpansion) ?? "{}",
      ).collapsedGroups,
    ).toEqual(["user:archer"]);

    fireEvent.click(screen.getByRole("button", { name: "Expand: archer" }));
    expect(screen.getByText("Session archer-row")).toBeDefined();
  });

  it("keeps the pre-category sections on a server without categories", () => {
    const now = new Date().toISOString();
    globalSessionsState.sessions = [
      makeSession("archer-row", now, { createdByUser: "archer" }),
    ];

    const { container } = render(
      <MemoryRouter>
        <Sidebar
          isOpen={true}
          onClose={() => {}}
          onNavigate={() => {}}
          isDesktop={true}
          isCollapsed={false}
        />
      </MemoryRouter>,
    );

    expect(last24HourIds(container)).toEqual(["archer-row"]);
  });

  it("initializes sidebar section collapse state from localStorage", () => {
    const now = Date.now();
    starredSessionsState.sessions = [
      makeSession("starred", new Date(now).toISOString(), { isStarred: true }),
    ];
    globalSessionsState.sessions = [
      makeSession("recent", new Date(now).toISOString()),
      makeSession("older", new Date(now - 48 * 60 * 60 * 1000).toISOString()),
    ];
    window.localStorage.setItem(
      UI_KEYS.sidebarSectionExpansion,
      JSON.stringify({ starred: false, recentDay: false, older: false }),
    );

    render(
      <MemoryRouter>
        <Sidebar
          isOpen={true}
          onClose={() => {}}
          onNavigate={() => {}}
          isDesktop={true}
          isCollapsed={false}
        />
      </MemoryRouter>,
    );

    expect(
      screen.getByRole("button", { name: "Expand: Starred" }),
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Expand: Last 24 Hours" }),
    ).toBeDefined();
    expect(screen.getByRole("button", { name: "Expand: Older" })).toBeDefined();
    expect(screen.queryByText("Session starred")).toBeNull();
    expect(screen.queryByText("Session recent")).toBeNull();
    expect(screen.queryByText("Session older")).toBeNull();
  });

  it("predictively loads the next page near the sidebar scroll end", async () => {
    globalSessionsState.sessions = [
      makeSession("recent", new Date().toISOString()),
    ];
    globalSessionsState.hasMore = true;

    render(
      <MemoryRouter>
        <Sidebar
          isOpen={true}
          onClose={() => {}}
          onNavigate={() => {}}
          isDesktop={true}
          isCollapsed={false}
        />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(mockGlobalLoadMore).toHaveBeenCalledTimes(1);
    });
  });

  // Activity and Project Queue protect rows from duplicate hiding, while
  // chronology follows user interaction (creation time for unvisited rows).
  // See topics/sidebar-session-ordering.md.
  describe("active session ordering", () => {
    const now = Date.now();
    const ago = (ms: number) => new Date(now - ms).toISOString();

    function renderExpanded() {
      return render(
        <MemoryRouter>
          <Sidebar
            isOpen={true}
            onClose={() => {}}
            onNavigate={() => {}}
            isDesktop={true}
            isCollapsed={false}
          />
        </MemoryRouter>,
      );
    }

    it("orders unvisited sessions by creation regardless of activity", () => {
      globalSessionsState.sessions = [
        makeSession("idle-old", ago(3 * 60_000)),
        makeSession("active-1", ago(60_000), { activity: "in-turn" }),
        makeSession("idle-new", ago(30_000)),
      ];

      const { container } = renderExpanded();

      // No active-first partition can move a row when a turn starts or ends.
      expect(last24HourIds(container)).toEqual([
        "idle-new",
        "active-1",
        "idle-old",
      ]);
    });

    it("uses creation order for active sessions without recorded visits", () => {
      globalSessionsState.sessions = [
        makeSession("active-A", ago(10_000), { activity: "in-turn" }),
        makeSession("active-B", ago(5_000), { activity: "in-turn" }),
      ];

      const { container } = renderExpanded();

      expect(last24HourIds(container)).toEqual(["active-B", "active-A"]);
    });

    it("keeps waiting-input rows in chronology", () => {
      globalSessionsState.sessions = [
        makeSession("idle-new", ago(10_000)),
        makeSession("waiting", ago(5 * 60_000), { activity: "waiting-input" }),
      ];

      const { container } = renderExpanded();

      expect(last24HourIds(container)).toEqual(["idle-new", "waiting"]);
    });

    it("keeps queued target sessions in chronology without thinking", () => {
      versionState.capabilities = [PROJECT_QUEUE_CAPABILITY];
      globalSessionsState.sessions = [
        makeSession("idle-new", ago(10_000)),
        makeSession("queued-old", ago(5 * 60_000)),
      ];
      projectQueuesState.queuesByProject = {
        "project-1": [
          makeProjectQueueItem("queue-session", {
            target: {
              type: "existing-session",
              sessionId: "queued-old",
            },
          }),
        ],
      };

      const { container } = renderExpanded();

      expect(last24HourIds(container)).toEqual(["idle-new", "queued-old"]);
      expect(screen.getByTestId("session-queued-old").textContent).toContain(
        "Q",
      );
      expect(screen.queryByTestId("thinking-queued-old")).toBeNull();
      expect(screen.getByTestId("session-queued-old").dataset.activity).toBe(
        "",
      );
    });

    it("keeps every active same-title session visible", () => {
      const shared = "Repeated session";
      globalSessionsState.sessions = [
        makeSession("active-thin", ago(60_000), {
          activity: "in-turn",
          title: shared,
          fullTitle: shared,
          messageCount: 1,
        }),
        makeSession("active-fat", ago(120_000), {
          activity: "in-turn",
          title: shared,
          fullTitle: shared,
          messageCount: 20,
        }),
      ];

      renderExpanded();

      // Same titles do not prove that two live rows are interchangeable.
      expect(screen.getByTestId("session-active-fat")).toBeDefined();
      expect(screen.getByTestId("session-active-thin")).toBeDefined();
      expect(screen.queryByText(/hidden \(duplicate titles\)/)).toBeNull();
    });

    it("renders the section for an active-only recent list", () => {
      globalSessionsState.sessions = [
        makeSession("active-only", ago(1_000), { activity: "in-turn" }),
      ];

      renderExpanded();

      expect(
        screen.getByRole("button", { name: "Collapse: Last 24 Hours" }),
      ).toBeDefined();
      expect(screen.getByTestId("session-active-only")).toBeDefined();
      // The empty-state copy must not appear when only active rows exist.
      expect(screen.queryByText("sidebarNoSessions")).toBeNull();
    });

    it("keeps active duplicates visible while collapsing idle duplicates", () => {
      const activeTitle = "Active dup";
      const idleTitle = "Idle dup";
      globalSessionsState.sessions = [
        makeSession("active-dup-1", ago(1_000), {
          activity: "in-turn",
          title: activeTitle,
          fullTitle: activeTitle,
          messageCount: 1,
        }),
        makeSession("active-dup-2", ago(2_000), {
          activity: "in-turn",
          title: activeTitle,
          fullTitle: activeTitle,
          messageCount: 9,
        }),
        makeSession("idle-dup-keep", ago(3_000), {
          title: idleTitle,
          fullTitle: idleTitle,
          messageCount: 9,
        }),
        makeSession("idle-dup-hide", ago(4_000), {
          title: idleTitle,
          fullTitle: idleTitle,
          messageCount: 1,
        }),
      ];

      const { container } = renderExpanded();

      // Live rows stay visible; only the lower-ranked idle duplicate folds into
      // the hidden-duplicates expander.
      expect(screen.getByTestId("session-active-dup-2")).toBeDefined();
      expect(screen.getByTestId("session-active-dup-1")).toBeDefined();
      expect(screen.getByTestId("session-idle-dup-keep")).toBeDefined();
      expect(screen.queryByTestId("session-idle-dup-hide")).toBeNull();
      expect(last24HourIds(container)).toEqual([
        "active-dup-1",
        "active-dup-2",
        "idle-dup-keep",
      ]);
    });
  });
});
