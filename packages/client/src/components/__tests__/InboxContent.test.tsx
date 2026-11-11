// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import {
  PROJECT_QUEUE_CAPABILITY,
  SESSION_CREATION_PROVENANCE_CAPABILITY,
} from "@yep-anywhere/shared";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InboxContent } from "../InboxContent";
import {
  createClientSummaryHostSourceKey,
  LOCAL_CLIENT_SUMMARY_SOURCE_KEY,
  setCurrentClientSummarySourceKey,
} from "../../lib/clientSummarySourceKey";
import { invalidateLocalStorageValues } from "../../lib/localStorageValue";

const {
  draftSessionIds,
  inboxState,
  mockRefresh,
  mockUseProjectQueues,
  mockUseProjectQueuedSessionIds,
  mockListReviewInbox,
  projectQueueItems,
  queuedSessionIds,
  versionState,
  serverSettingsState,
} = vi.hoisted(() => ({
  draftSessionIds: new Set<string>(),
  queuedSessionIds: new Set<string>(),
  projectQueueItems: [] as Array<Record<string, unknown>>,
  mockRefresh: vi.fn(),
  mockUseProjectQueues: vi.fn(),
  mockUseProjectQueuedSessionIds: vi.fn(),
  mockListReviewInbox: vi.fn(),
  versionState: {
    version: { capabilities: [] as string[] } as {
      capabilities?: string[];
      capabilityEncoding?: number;
      capabilityBits?: readonly (readonly [number, number])[];
      current?: string;
    },
  },
  serverSettingsState: {
    settings: {
      publicSharesEnabled: false,
      sourceReviewSubmissionsEnabled: false,
    },
  },
  inboxState: {
    needsAttention: [] as Array<Record<string, unknown>>,
    active: [] as Array<Record<string, unknown>>,
    recentActivity: [] as Array<Record<string, unknown>>,
    unread8h: [] as Array<Record<string, unknown>>,
    unread24h: [] as Array<Record<string, unknown>>,
    loading: false,
    error: null as Error | null,
  },
}));

vi.mock("../../api/client", () => ({
  api: {
    listReviewInbox: (...args: unknown[]) => mockListReviewInbox(...args),
  },
}));

vi.mock("../../lib/activityBus", () => ({
  activityBus: { on: () => () => {} },
}));

vi.mock("../../contexts/InboxContext", () => ({
  useInboxContext: () => ({
    ...inboxState,
    inbox: {
      needsAttention: inboxState.needsAttention,
      active: inboxState.active,
      recentActivity: inboxState.recentActivity,
      unread8h: inboxState.unread8h,
      unread24h: inboxState.unread24h,
    },
    refresh: mockRefresh,
    refetch: mockRefresh,
    totalNeedsAttention: inboxState.needsAttention.length,
    totalActive: inboxState.active.length,
    totalItems:
      inboxState.needsAttention.length +
      inboxState.active.length +
      inboxState.recentActivity.length +
      inboxState.unread8h.length +
      inboxState.unread24h.length,
    enabled: true,
    setEnabled: vi.fn(),
  }),
}));

vi.mock("../../hooks/useProjectQueues", () => ({
  useProjectQueues: (projectIds: string[]) => {
    mockUseProjectQueues(projectIds);
    return {
      queuesByProject: {},
      items: projectQueueItems,
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
    };
  },
}));

vi.mock("../../hooks/useVersion", () => ({
  useVersion: () => ({ version: versionState.version }),
}));

vi.mock("../../lib/clientSummaryStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/clientSummaryStore")>()),
  useDraftSessionIds: () => draftSessionIds,
  useProjectQueuedSessionIds: (projectIds: string[]) => {
    mockUseProjectQueuedSessionIds(projectIds);
    return queuedSessionIds;
  },
}));

vi.mock("../../hooks/useRemoteBasePath", () => ({
  useRemoteBasePath: () => "",
}));

vi.mock("../../hooks/useServerSettings", () => ({
  useServerSettings: () => ({
    settings: serverSettingsState.settings,
  }),
}));

vi.mock("../../hooks/usePublicShareStatus", () => ({
  usePublicShareStatus: () => ({
    status: { canCreate: false },
  }),
}));

vi.mock("../SessionListItem", () => ({
  SessionListItem: ({
    activity,
    hasCustomTitle,
    hasDraft,
    hasProjectQueue,
    isStarred,
    sessionId,
    showActivityIndicator,
    title,
  }: {
    activity?: string;
    hasCustomTitle?: boolean;
    hasDraft?: boolean;
    hasProjectQueue?: boolean;
    isStarred?: boolean;
    sessionId: string;
    showActivityIndicator?: boolean;
    title: string;
  }) => (
    <li data-testid={`session-${sessionId}`}>
      {title}
      {showActivityIndicator && activity === "in-turn" ? (
        <span data-testid={`thinking-${sessionId}`}>Thinking</span>
      ) : null}
      {hasCustomTitle ? <span>Custom</span> : null}
      {isStarred ? <span>Star</span> : null}
      {hasDraft ? <span>Draft</span> : null}
      {hasProjectQueue ? <span>Q</span> : null}
    </li>
  ),
}));

vi.mock("../../i18n", () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}));

function makeInboxItem(
  sessionId: string,
  projectId: string,
): Record<string, unknown> {
  return {
    sessionId,
    projectId,
    projectName: `Project ${projectId}`,
    sessionTitle: `Session ${sessionId}`,
    updatedAt: "2026-06-28T00:00:00.000Z",
    hasUnread: true,
  };
}

function makeProject(projectId: string) {
  return {
    id: projectId,
    path: `/tmp/${projectId}`,
    name: `Project ${projectId}`,
    sessionCount: 0,
    activeOwnedCount: 0,
    activeExternalCount: 0,
    lastActivity: null,
  };
}

function makeProjectQueueItem(
  itemId: string,
  projectId: string,
  messagePreview: string,
): Record<string, unknown> {
  return {
    id: itemId,
    projectId,
    target: { type: "new-session" },
    messagePreview,
    message: { text: messagePreview },
    createdAt: "2026-06-28T00:00:00.000Z",
    updatedAt: "2026-06-28T00:00:00.000Z",
    status: "queued",
    attachmentCount: 0,
  };
}

function renderInbox(ui: ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe("InboxContent", () => {
  beforeEach(() => {
    localStorage.clear();
    invalidateLocalStorageValues();
    setCurrentClientSummarySourceKey(LOCAL_CLIENT_SUMMARY_SOURCE_KEY);
    inboxState.needsAttention = [];
    inboxState.active = [];
    inboxState.recentActivity = [];
    inboxState.unread8h = [];
    inboxState.unread24h = [];
    inboxState.loading = false;
    inboxState.error = null;
    projectQueueItems.length = 0;
    versionState.version = { capabilities: [PROJECT_QUEUE_CAPABILITY] };
    serverSettingsState.settings = {
      publicSharesEnabled: false,
      sourceReviewSubmissionsEnabled: false,
    };
    draftSessionIds.clear();
    queuedSessionIds.clear();
    mockRefresh.mockReset();
    mockUseProjectQueues.mockReset();
    mockUseProjectQueuedSessionIds.mockReset();
    mockListReviewInbox.mockReset();
    mockListReviewInbox.mockResolvedValue({ items: [] });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  function selectCreatedVia(option: string) {
    fireEvent.click(screen.getByRole("button", { name: "filterByLabel" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: option }));
  }

  it("combines creation and project filters across tiers and remembers each source", () => {
    versionState.version = {
      capabilities: [
        PROJECT_QUEUE_CAPABILITY,
        SESSION_CREATION_PROVENANCE_CAPABILITY,
      ],
    };
    for (const tier of [
      "needsAttention",
      "active",
      "recentActivity",
      "unread8h",
      "unread24h",
    ] as const) {
      inboxState[tier] = [
        {
          ...makeInboxItem(`${tier}-web`, "one"),
          creationProvenance: { surface: "web" },
        },
        {
          ...makeInboxItem(`${tier}-desktop`, "one"),
          creationProvenance: { surface: "desktop" },
        },
        {
          ...makeInboxItem(`${tier}-api`, "one"),
          creationProvenance: { surface: "api" },
        },
        makeInboxItem(`${tier}-unknown`, "one"),
        {
          ...makeInboxItem(`${tier}-other-project`, "two"),
          creationProvenance: { surface: "web" },
        },
      ];
    }
    const first = renderInbox(<InboxContent projectId="one" />);
    selectCreatedVia("inboxStartedViaUi");
    expect(screen.getAllByTestId(/^session-/)).toHaveLength(10);
    expect(screen.queryByTestId("session-active-other-project")).toBeNull();
    expect(screen.queryByTestId("session-active-api")).toBeNull();
    expect(screen.getByTestId("session-active-desktop")).toBeTruthy();
    first.unmount();
    renderInbox(<InboxContent projectId="one" />);
    expect(screen.getAllByTestId(/^session-/)).toHaveLength(10);
    expect(localStorage.getItem("yep-anywhere-inbox-created-via:local")).toBe(
      "ui",
    );

    act(() =>
      setCurrentClientSummarySourceKey(
        createClientSummaryHostSourceKey("second"),
      ),
    );
    expect(screen.getAllByTestId(/^session-/)).toHaveLength(20);
    selectCreatedVia("inboxStartedViaApi");
    expect(screen.getAllByTestId(/^session-/)).toHaveLength(5);
    expect(screen.getByTestId("session-active-api")).toBeTruthy();
    act(() =>
      setCurrentClientSummarySourceKey(LOCAL_CLIENT_SUMMARY_SOURCE_KEY),
    );
    expect(screen.getAllByTestId(/^session-/)).toHaveLength(10);
    selectCreatedVia("inboxStartedViaUnspecified");
    expect(screen.getAllByTestId(/^session-/)).toHaveLength(5);
    expect(screen.getByTestId("session-active-unknown")).toBeTruthy();
    selectCreatedVia("inboxAllSessions");
    expect(screen.getAllByTestId(/^session-/)).toHaveLength(20);
  });

  it("ignores a saved filter on unsupported servers without overwriting it", () => {
    localStorage.setItem("yep-anywhere-inbox-created-via:local", "api");
    invalidateLocalStorageValues();
    inboxState.active = [makeInboxItem("external", "one")];
    const view = renderInbox(<InboxContent />);
    expect(screen.getByTestId("session-external")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "filterByLabel" })).toBeNull();
    expect(localStorage.getItem("yep-anywhere-inbox-created-via:local")).toBe(
      "api",
    );
    versionState.version = {
      capabilities: [SESSION_CREATION_PROVENANCE_CAPABILITY],
    };
    view.rerender(
      <MemoryRouter>
        <InboxContent />
      </MemoryRouter>,
    );
    expect(screen.queryByTestId("session-external")).toBeNull();
    expect(screen.getByText("inboxFilteredEmptyTitle")).toBeTruthy();
  });

  it("defaults invalid storage to All and keeps filtering when storage fails", () => {
    localStorage.setItem(
      "yep-anywhere-inbox-created-via:local",
      "future-filter",
    );
    invalidateLocalStorageValues();
    versionState.version = {
      capabilities: [SESSION_CREATION_PROVENANCE_CAPABILITY],
    };
    inboxState.active = [makeInboxItem("external", "one")];
    const first = renderInbox(<InboxContent />);
    expect(screen.getByTestId("session-external")).toBeTruthy();
    first.unmount();
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage blocked");
    });
    invalidateLocalStorageValues();
    renderInbox(<InboxContent />);
    expect(screen.getByTestId("session-external")).toBeTruthy();
    selectCreatedVia("inboxStartedViaUi");
    expect(screen.queryByTestId("session-external")).toBeNull();
    expect(screen.getByText("inboxFilteredEmptyTitle")).toBeTruthy();
    selectCreatedVia("inboxAllSessions");
    expect(screen.getByTestId("session-external")).toBeTruthy();
  });

  it("marks inbox rows with Project Queue items from store decorations", () => {
    inboxState.needsAttention = [
      makeInboxItem("queued-session", "project-1"),
      makeInboxItem("plain-session", "project-2"),
    ];
    draftSessionIds.add("plain-session");
    queuedSessionIds.add("queued-session");

    renderInbox(<InboxContent />);

    expect(mockUseProjectQueues).toHaveBeenCalledWith([
      "project-1",
      "project-2",
    ]);
    expect(mockUseProjectQueuedSessionIds).toHaveBeenCalledWith([
      "project-1",
      "project-2",
    ]);
    expect(screen.getByTestId("session-queued-session").textContent).toContain(
      "Q",
    );
    expect(screen.getByTestId("session-plain-session").textContent).toContain(
      "Draft",
    );
    expect(
      screen.getByTestId("session-plain-session").textContent,
    ).not.toContain("Q");
  });

  it("feeds only the visible filtered projects into queue decorations", () => {
    inboxState.needsAttention = [
      makeInboxItem("visible-session", "project-1"),
      makeInboxItem("hidden-session", "project-2"),
    ];

    renderInbox(<InboxContent projectId="project-1" />);

    expect(mockUseProjectQueues).toHaveBeenCalledWith(["project-1"]);
    expect(mockUseProjectQueuedSessionIds).toHaveBeenCalledWith(["project-1"]);
    expect(screen.getByTestId("session-visible-session")).toBeTruthy();
    expect(screen.queryByTestId("session-hidden-session")).toBe(null);
  });

  it("renders custom titles from inbox-only rows", () => {
    inboxState.needsAttention = [
      {
        ...makeInboxItem("renamed-session", "project-1"),
        sessionTitle: "Generated title",
        customTitle: "Renamed title",
      },
    ];

    renderInbox(<InboxContent />);

    expect(screen.getByTestId("session-renamed-session").textContent).toContain(
      "Renamed title",
    );
    expect(screen.getByTestId("session-renamed-session").textContent).toContain(
      "Custom",
    );
    expect(
      screen.getByTestId("session-renamed-session").textContent,
    ).not.toContain("Generated title");
  });

  it("does not restate the visible Refresh label in a title", () => {
    renderInbox(<InboxContent />);

    expect(
      screen
        .getByRole("button", { name: "inboxRefresh" })
        .getAttribute("title"),
    ).toBeNull();
  });

  it("passes starred state through to inbox rows", () => {
    inboxState.needsAttention = [
      {
        ...makeInboxItem("starred-session", "project-1"),
        isStarred: true,
      },
    ];

    renderInbox(<InboxContent />);

    expect(screen.getByTestId("session-starred-session").textContent).toContain(
      "Star",
    );
  });

  it("shows the active thinking indicator for real running inbox rows", () => {
    inboxState.active = [
      {
        ...makeInboxItem("running-session", "project-1"),
        activity: "in-turn",
      },
    ];

    renderInbox(<InboxContent />);

    expect(screen.getByTestId("thinking-running-session")).toBeTruthy();
  });

  it("hides the active thinking indicator for queue-only inbox rows", () => {
    inboxState.active = [
      {
        ...makeInboxItem("queued-session", "project-1"),
        activity: "in-turn",
        activityInferredFromInboxTier: true,
      },
    ];
    queuedSessionIds.add("queued-session");

    renderInbox(<InboxContent />);

    expect(screen.getByTestId("session-queued-session").textContent).toContain(
      "Q",
    );
    expect(screen.queryByTestId("thinking-queued-session")).toBe(null);
  });

  it("renders pending new-session Project Queue items in Active", () => {
    projectQueueItems.push(
      makeProjectQueueItem("queue-new-session", "project-1", "Build the docs"),
    );

    renderInbox(<InboxContent projects={[makeProject("project-1")]} />);

    expect(mockUseProjectQueues).toHaveBeenCalledWith(["project-1"]);
    expect(screen.getByText("Build the docs")).toBeTruthy();
    const targetLabel = screen.getByText("projectQueueTargetNewSession");
    expect(targetLabel.parentElement?.textContent).toContain("Q");
    expect(screen.getAllByText("projectQueueTargetNewSession")).toHaveLength(1);
    expect(screen.getByText("projectQueueStatusQueued")).toBeTruthy();

    const link = screen.getByRole("link", { name: /Build the docs/ });
    expect(link.getAttribute("href")).toBe(
      "/projects?queueItem=queue-new-session",
    );
  });

  it("maps the closed queue status union to explicit module classes", () => {
    const queued = makeProjectQueueItem("queue-queued", "project-1", "Queued");
    const dispatching = makeProjectQueueItem(
      "queue-dispatching",
      "project-1",
      "Dispatching",
    );
    dispatching.status = "dispatching";
    const failed = makeProjectQueueItem("queue-failed", "project-1", "Failed");
    failed.status = "failed";
    projectQueueItems.push(queued, dispatching, failed);

    const { container } = renderInbox(
      <InboxContent projects={[makeProject("project-1")]} />,
    );

    const itemFor = (id: string) => {
      const el = container.querySelector(
        `[data-inbox-project-queue-item-id="${id}"]`,
      );
      if (!el) throw new Error(`missing queue item ${id}`);
      return el;
    };
    const statusOf = (id: string) => {
      const el = itemFor(id).querySelector(
        "a > span:last-of-type > span:last-child",
      );
      if (!el) throw new Error(`missing status pill for ${id}`);
      return el;
    };

    // Every rendered class must resolve; a missing module key would leave
    // "undefined" in the class list.
    for (const id of ["queue-queued", "queue-dispatching", "queue-failed"]) {
      expect(itemFor(id).className).not.toContain("undefined");
      expect(statusOf(id).className).not.toContain("undefined");
    }

    const tokens = (el: Element) =>
      el.className.split(/\s+/).filter(Boolean).length;

    // Only `failed` carries an item modifier; `queued` and `dispatching`
    // have no item-level rule in the stylesheet.
    expect(tokens(itemFor("queue-failed"))).toBe(
      tokens(itemFor("queue-queued")) + 1,
    );
    expect(tokens(itemFor("queue-dispatching"))).toBe(
      tokens(itemFor("queue-queued")),
    );

    // The status pill has a modifier for `failed` and `dispatching` only.
    expect(tokens(statusOf("queue-failed"))).toBe(
      tokens(statusOf("queue-queued")) + 1,
    );
    expect(tokens(statusOf("queue-dispatching"))).toBe(
      tokens(statusOf("queue-queued")) + 1,
    );
    expect(statusOf("queue-failed").className).not.toBe(
      statusOf("queue-dispatching").className,
    );
  });

  it("renders capability-gated unread review outcome cards", async () => {
    versionState.version = {
      current: "0.7.1",
      capabilityEncoding: 1,
      capabilityBits: [],
    };
    serverSettingsState.settings = {
      publicSharesEnabled: false,
      sourceReviewSubmissionsEnabled: true,
    };
    mockListReviewInbox.mockResolvedValue({
      items: [
        {
          projectId: "project-1",
          projectName: "Project one",
          submissionId: "submission-1",
          name: "Compatibility review",
          targetSessionId: "session-1",
          responseRevision: 1,
          outcomes: [
            {
              siteId: "site-1",
              entryId: "entry-1",
              path: "src/a.ts",
              submissionId: "submission-1",
              disposition: "wont_fix",
              text: "The stable protocol still needs this field.",
              observedAt: "2026-08-01T00:00:00Z",
              responseHash: "a".repeat(64),
              sessionId: "session-1",
            },
          ],
        },
      ],
    });

    renderInbox(<InboxContent projects={[makeProject("project-1")]} />);

    expect(
      await screen.findByText("The stable protocol still needs this field."),
    ).toBeTruthy();
    expect(screen.getByText("sourceReviewOutcomeNoChange")).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Compatibility review" })
        .getAttribute("href"),
    ).toBe(
      "/git-status?projectId=project-1&tab=reviews&submission=submission-1",
    );
    expect(
      screen
        .getByRole("link", { name: "sourceReviewOutcomeSession" })
        .getAttribute("href"),
    ).toBe("/projects/project-1/sessions/session-1");
  });
});
