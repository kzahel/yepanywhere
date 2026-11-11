// @vitest-environment jsdom

import type { UrlProjectId } from "@yep-anywhere/shared";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { GlobalSessionItem } from "../../api/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../contexts/ToastContext";
import {
  createClientSummaryHostSourceKey,
  reportGlobalSessionsCollectionSnapshot,
  reportSessionCollectionMetadataChanged,
  resetClientSummaryStoreForTests,
  setCurrentClientSummarySourceKey,
} from "../../lib/clientSummaryStore";
import { invalidateLocalStorageValues } from "../../lib/localStorageValue";
import { saveSessionDraft } from "../../lib/sessionDraftStorage";
import { UI_KEYS } from "../../lib/storageKeys";
import { recordSessionInteraction } from "../../lib/sessionInteractionOrder";
import { Sidebar } from "../Sidebar";

vi.mock("../../lib/activityBus", () => ({
  activityBus: {
    on: vi.fn(() => () => {}),
    onSource: vi.fn(() => () => {}),
    retainSourceStream: vi.fn(() => () => {}),
  },
}));

vi.mock("../../contexts/RemoteConnectionContext", () => ({
  useOptionalRemoteConnection: () => null,
}));

vi.mock("../../hooks/useDrafts", () => ({
  useNewSessionDraft: () => false,
}));

vi.mock("../../hooks/useProjectQueues", () => ({
  useProjectQueues: () => ({
    queuesByProject: {},
    items: [],
    projectStatusesByProject: {},
    recoveredSessionQueues: [],
    loading: false,
    error: null,
    mutatingItemId: null,
    mutatingDispatchState: false,
    mutatingPromoteItemId: null,
    dispatchState: { status: "running" },
    refetch: vi.fn(),
    pauseDispatch: vi.fn(),
    resumeDispatch: vi.fn(),
    promoteNow: vi.fn(),
    updateItem: vi.fn(),
    deleteItem: vi.fn(),
    retryItem: vi.fn(),
    moveItemToTop: vi.fn(),
  }),
}));

vi.mock("../../hooks/useProjects", () => ({
  useProjects: () => ({
    projects: [
      {
        id: "project-1",
        path: "/work/draft",
        name: "draft",
        codeName: "dra",
        sessionCount: 1,
        activeOwnedCount: 0,
        activeExternalCount: 0,
        lastActivity: null,
      },
      {
        id: "project-2",
        path: "/work/yepanywhere",
        name: "yepanywhere",
        codeName: "yep",
        sessionCount: 1,
        activeOwnedCount: 0,
        activeExternalCount: 0,
        lastActivity: null,
      },
    ],
    loading: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

vi.mock("../../hooks/usePublicShareStatus", () => ({
  usePublicShareStatus: () => ({
    status: null,
  }),
}));

vi.mock("../../hooks/useRemoteBasePath", () => ({
  useRemoteBasePath: () => "/remote/test",
}));

vi.mock("../../hooks/useServerSettings", () => ({
  useServerSettings: () => ({
    settings: {
      publicSharesEnabled: false,
    },
  }),
}));

vi.mock("../../hooks/useSidebarSessionFeeds", () => ({
  SIDEBAR_SESSION_FEED_LIMIT: 50,
  useSidebarSessionFeeds: () => ({
    globalQuery: { scope: "global-sessions" },
    starredQuery: { scope: "global-sessions", starred: true },
    loading: false,
    hasMoreGlobalSessions: false,
    loadMoreGlobalSessions: vi.fn(),
    hasMoreStarredSessions: false,
    loadMoreStarredSessions: vi.fn(),
  }),
}));

vi.mock("../../hooks/useVersion", () => ({
  useVersion: () => ({
    version: {
      capabilities: ["project-code-names"],
    },
  }),
}));

vi.mock("../../i18n", () => ({
  useI18n: () => ({
    t: (key: string) =>
      (
        ({
          actionCloseSidebar: "Close sidebar",
          sidebarNewSession: "New Session",
          sidebarInbox: "Inbox",
          sidebarAllSessions: "All Sessions",
          sidebarProjects: "Projects",
          sidebarSettings: "Settings",
          sidebarSectionStarred: "Starred",
          sidebarSectionLast24Hours: "Last 24 Hours",
          sidebarSectionOlder: "Older",
          sidebarSectionExpand: "Expand",
          sidebarSectionCollapse: "Collapse",
          sidebarEmpty: "No sessions yet",
        }) as Record<string, string>
      )[key] ?? key,
  }),
}));

vi.mock("../AgentsNavItem", () => ({
  AgentsNavItem: () => null,
}));

vi.mock("../SessionListItem", () => ({
  SessionListItem: ({
    sessionId,
    title,
    hasDraft,
    projectId,
    projectName,
  }: {
    sessionId: string;
    title: string;
    hasDraft?: boolean;
    projectId: string;
    projectName?: string;
  }) => (
    <li
      data-has-draft={String(hasDraft === true)}
      data-project-id={projectId}
      data-project-name={projectName}
      data-testid={`session-row-${sessionId}`}
    >
      <span>{title}</span>
      {hasDraft ? <span>Draft</span> : null}
    </li>
  ),
}));

const RECENT_MS = Date.now() - 60_000;
const RECENT = new Date(RECENT_MS).toISOString();

function session(
  id: string,
  title: string,
  overrides: Partial<GlobalSessionItem> = {},
): GlobalSessionItem {
  return {
    id,
    title,
    fullTitle: title,
    createdAt: RECENT,
    updatedAt: RECENT,
    messageCount: 1,
    provider: "claude",
    projectId: "project-1",
    projectName: "Project",
    ownership: { owner: "none" },
    isArchived: false,
    isStarred: false,
    ...overrides,
  };
}

function renderSidebar() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <Sidebar
          isOpen={true}
          onClose={() => {}}
          onNavigate={() => {}}
          isDesktop={true}
          isCollapsed={false}
        />
      </ToastProvider>
    </MemoryRouter>,
  );
}

function sectionRowIds(container: HTMLElement, listId: string): string[] {
  const list = container.querySelector(`#${listId}`);
  if (!list) {
    return [];
  }
  return Array.from(list.querySelectorAll("[data-testid^='session-row-']")).map(
    (element) =>
      element.getAttribute("data-testid")?.replace("session-row-", "") ?? "",
  );
}

describe("Sidebar client summary source registry", () => {
  beforeEach(() => {
    resetClientSummaryStoreForTests();
    localStorage.clear();
    invalidateLocalStorageValues();
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    invalidateLocalStorageValues();
    resetClientSummaryStoreForTests();
  });

  it("uses full project names by default", async () => {
    const macbook = createClientSummaryHostSourceKey("macbook");

    act(() => {
      setCurrentClientSummarySourceKey(macbook);
      reportGlobalSessionsCollectionSnapshot(
        macbook,
        {
          query: { scope: "global-sessions" },
          sessions: [
            session("full-name-session", "Full name session", {
              projectId: "project-1",
              projectName: "draft",
            }),
          ],
          hasMore: false,
        },
        100,
      );
    });

    renderSidebar();

    const row = await screen.findByTestId("session-row-full-name-session");
    expect(row.getAttribute("data-project-name")).toBe("draft");
  });

  it("keeps rows in place through background output and activity transitions", () => {
    const source = createClientSummaryHostSourceKey("stable-sidebar");
    const first = session("first", "First", {
      createdAt: new Date(RECENT_MS + 1000).toISOString(),
      updatedAt: new Date(RECENT_MS + 1000).toISOString(),
      activity: "in-turn",
    });
    const second = session("second", "Second", { activity: "in-turn" });
    const report = (rows: GlobalSessionItem[], at: number) =>
      reportGlobalSessionsCollectionSnapshot(
        source,
        { query: { scope: "global-sessions" }, sessions: rows, hasMore: false },
        at,
      );
    act(() => {
      setCurrentClientSummarySourceKey(source);
      report([first, second], 100);
    });
    const { container } = renderSidebar();
    expect(sectionRowIds(container, "sidebar-last-24-hours-list")).toEqual([
      "first",
      "second",
    ]);
    act(() => {
      report(
        [
          { ...second, updatedAt: new Date().toISOString(), title: "Updated" },
          { ...first, activity: "idle" },
        ],
        200,
      );
    });
    expect(screen.getByText("Updated")).toBeDefined();
    expect(sectionRowIds(container, "sidebar-last-24-hours-list")).toEqual([
      "first",
      "second",
    ]);
  });

  it("applies user-driven moves and arrivals during pointer and focus interaction", async () => {
    const source = createClientSummaryHostSourceKey("held-sidebar");
    const rows = [session("a", "A"), session("b", "B")];
    act(() => {
      setCurrentClientSummarySourceKey(source);
      reportGlobalSessionsCollectionSnapshot(
        source,
        { query: { scope: "global-sessions" }, sessions: rows, hasMore: false },
        100,
      );
    });
    const { container } = renderSidebar();
    const aside = container.querySelector("aside")!;
    const ids = () => sectionRowIds(container, "sidebar-last-24-hours-list");
    await act(async () => {});
    expect(ids()).toEqual(["a", "b"]);
    fireEvent.pointerEnter(aside, { pointerType: "mouse" });
    const focusedLink = aside.querySelector("a")!;
    act(() => focusedLink.focus());
    act(() => {
      recordSessionInteraction(source, "b");
      reportGlobalSessionsCollectionSnapshot(
        source,
        {
          query: { scope: "global-sessions" },
          sessions: [session("new", "New"), ...rows],
          hasMore: false,
        },
        200,
      );
    });
    expect(ids()).toEqual(["b", "a", "new"]);
    fireEvent.pointerLeave(aside, { pointerType: "mouse" });
    expect(ids()).toEqual(["b", "a", "new"]);
    act(() => focusedLink.blur());
    expect(ids()).toEqual(["b", "a", "new"]);
    act(() => recordSessionInteraction(source, "a"));
    expect(ids()).toEqual(["a", "b", "new"]);
  });

  it("rerenders rows and draft badges from only the current source", async () => {
    const macbook = createClientSummaryHostSourceKey("macbook");
    const winnative = createClientSummaryHostSourceKey("winnative");

    act(() => {
      reportGlobalSessionsCollectionSnapshot(
        macbook,
        {
          query: { scope: "global-sessions" },
          sessions: [session("mac-session", "MacBook session")],
          hasMore: false,
        },
        100,
      );
      reportGlobalSessionsCollectionSnapshot(
        winnative,
        {
          query: { scope: "global-sessions" },
          sessions: [session("win-session", "WinNative session")],
          hasMore: false,
        },
        100,
      );
      saveSessionDraft(
        { sourceKey: macbook, sessionId: "mac-session" },
        "mac draft",
      );
      saveSessionDraft(
        { sourceKey: winnative, sessionId: "win-session" },
        "win draft",
      );
      setCurrentClientSummarySourceKey(macbook);
    });

    renderSidebar();

    await waitFor(() => {
      expect(screen.getByTestId("session-row-mac-session")).toBeDefined();
    });
    expect(screen.queryByTestId("session-row-win-session")).toBeNull();
    expect(
      screen
        .getByTestId("session-row-mac-session")
        .getAttribute("data-has-draft"),
    ).toBe("true");

    act(() => {
      setCurrentClientSummarySourceKey(winnative);
    });

    await waitFor(() => {
      expect(screen.getByTestId("session-row-win-session")).toBeDefined();
    });
    expect(screen.queryByTestId("session-row-mac-session")).toBeNull();
    expect(
      screen
        .getByTestId("session-row-win-session")
        .getAttribute("data-has-draft"),
    ).toBe("true");

    act(() => {
      setCurrentClientSummarySourceKey(macbook);
    });

    await waitFor(() => {
      expect(screen.getByTestId("session-row-mac-session")).toBeDefined();
    });
    expect(screen.queryByTestId("session-row-win-session")).toBeNull();
    expect(
      screen
        .getByTestId("session-row-mac-session")
        .getAttribute("data-has-draft"),
    ).toBe("true");
  });

  it("renders locally starred known rows before starred query refetches", async () => {
    const macbook = createClientSummaryHostSourceKey("macbook");

    act(() => {
      setCurrentClientSummarySourceKey(macbook);
      reportGlobalSessionsCollectionSnapshot(
        macbook,
        {
          query: { scope: "global-sessions" },
          sessions: [session("star-later", "Star later")],
          hasMore: false,
        },
        100,
      );
      reportGlobalSessionsCollectionSnapshot(
        macbook,
        {
          query: { scope: "global-sessions", starred: true },
          sessions: [],
          hasMore: false,
        },
        100,
      );
    });

    const { container } = renderSidebar();

    await waitFor(() => {
      expect(sectionRowIds(container, "sidebar-last-24-hours-list")).toEqual([
        "star-later",
      ]);
    });
    expect(sectionRowIds(container, "sidebar-starred-list")).toEqual([]);

    act(() => {
      reportSessionCollectionMetadataChanged(
        macbook,
        {
          type: "session-metadata-changed",
          sessionId: "star-later",
          starred: true,
          timestamp: new Date(RECENT_MS + 60_000).toISOString(),
        },
        200,
      );
    });

    await waitFor(() => {
      expect(sectionRowIds(container, "sidebar-starred-list")).toEqual([
        "star-later",
      ]);
    });
    expect(sectionRowIds(container, "sidebar-last-24-hours-list")).toEqual([]);
  });

  it("renders a relocated session under its destination project immediately", async () => {
    const macbook = createClientSummaryHostSourceKey("macbook");

    act(() => {
      localStorage.setItem(UI_KEYS.projectCodeNamesEnabled, "true");
      invalidateLocalStorageValues(UI_KEYS.projectCodeNamesEnabled);
      setCurrentClientSummarySourceKey(macbook);
      reportGlobalSessionsCollectionSnapshot(
        macbook,
        {
          query: { scope: "global-sessions" },
          sessions: [
            session("moved-session", "Moved session", {
              projectId: "project-1",
              projectName: "draft",
            }),
          ],
          hasMore: false,
        },
        100,
      );
    });

    renderSidebar();

    const row = await screen.findByTestId("session-row-moved-session");
    expect(row.getAttribute("data-project-name")).toBe("dra");

    act(() => {
      reportSessionCollectionMetadataChanged(
        macbook,
        {
          type: "session-metadata-changed",
          sessionId: "moved-session",
          projectId: "project-2" as UrlProjectId,
          timestamp: new Date(RECENT_MS + 60_000).toISOString(),
        },
        200,
      );
    });

    await waitFor(() => {
      expect(row.getAttribute("data-project-id")).toBe("project-2");
      expect(row.getAttribute("data-project-name")).toBe("yep");
    });
  });
});
