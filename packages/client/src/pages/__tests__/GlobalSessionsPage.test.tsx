// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  SESSION_CONTENT_SEARCH_CAPABILITY,
  SESSION_CREATION_PROVENANCE_CAPABILITY,
  type ProviderInfo,
} from "@yep-anywhere/shared";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROJECT_QUEUE_CAPABILITY } from "@yep-anywhere/shared";
import { GlobalSessionsPage } from "../GlobalSessionsPage";
import english from "../../i18n/en.json";

const {
  mockNavigate,
  mockSetNewSessionPrefill,
  globalSessionsState,
  mockLoadMore,
  mockUseProjectQueues,
  sessionCollectionState,
  versionState,
  providerState,
} = vi.hoisted(() => ({
  providerState: { providers: [] as ProviderInfo[] },
  mockNavigate: vi.fn(),
  mockSetNewSessionPrefill: vi.fn(),
  mockLoadMore: vi.fn(),
  mockUseProjectQueues: vi.fn(),
  versionState: {
    version: { capabilities: [] as string[] } as {
      capabilities?: string[];
      current?: string;
    },
  },
  sessionCollectionState: {
    records: [] as unknown[],
    queuedSessionIds: new Set<string>(),
  },
  globalSessionsState: {
    sessions: [] as unknown[],
    stats: {
      totalCount: 0,
      unreadCount: 0,
      starredCount: 0,
      archivedCount: 0,
      providerCounts: {},
      executorCounts: {},
    },
    projects: [
      {
        id: "project-1",
        name: "Alpha",
        path: "/tmp/alpha",
        sessionCount: 3,
        lastActivity: "2026-04-21T00:00:00.000Z",
      },
    ],
    loading: false,
    error: null as Error | null,
    hasMore: false,
    loadMore: vi.fn(),
    refetch: vi.fn(),
  },
}));

vi.mock("react-router-dom", async () => {
  const actual =
    await vi.importActual<typeof import("react-router-dom")>(
      "react-router-dom",
    );

  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

vi.mock("../../api/client", () => ({
  api: {
    updateSessionMetadata: vi.fn(),
    markSessionSeen: vi.fn(),
    markSessionUnread: vi.fn(),
  },
}));

vi.mock("../../contexts/SourceRuntimeContext", () => ({
  useCurrentSourceRuntime: () => runtime,
}));
const runtime = { sourceKey: "host:test", transport: { fetch: vi.fn() } };

vi.mock("../../hooks/useProviders", () => ({
  useProviders: () => providerState,
}));

const filterDropdowns = vi.hoisted(
  () =>
    [] as Array<{
      label: string;
      options: Array<{ value: string; label: string; clearSelection?: true }>;
      onChange: (selected: string[]) => void;
    }>,
);

vi.mock("../../components/FilterDropdown", () => ({
  FilterDropdown: (props: (typeof filterDropdowns)[number]) => {
    filterDropdowns.push(props);
    return <div data-testid="filter-dropdown" />;
  },
}));

vi.mock("../../components/PageHeader", () => ({
  PageHeader: ({
    title,
    titleElement,
  }: {
    title: string;
    titleElement?: ReactNode;
  }) => <div>{titleElement ?? title}</div>,
}));

vi.mock("../../components/SessionListItem", () => ({
  SessionListItem: ({
    sessionId,
    title,
    hasProjectQueue,
    isSelected,
    onSelect,
  }: {
    sessionId: string;
    title: string;
    hasProjectQueue?: boolean;
    isSelected?: boolean;
    onSelect?: (id: string, checked: boolean) => void;
  }) => (
    <div data-testid={`session-${sessionId}`}>
      <input
        type="checkbox"
        aria-label={`Select ${title}`}
        checked={!!isSelected}
        onChange={(event) => onSelect?.(sessionId, event.target.checked)}
      />
      {title}
      {hasProjectQueue ? (
        <span data-testid={`project-queue-${sessionId}`}>Q</span>
      ) : null}
    </div>
  ),
}));

vi.mock("../../hooks/useGlobalSessionsFeed", () => ({
  useGlobalSessionsFeed: () => ({
    query: { scope: "global-sessions" },
    ...globalSessionsState,
  }),
}));

vi.mock("../../hooks/useProjectQueues", () => ({
  useProjectQueues: (projectIds: string[]) => {
    mockUseProjectQueues(projectIds);
    return {
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
    };
  },
}));

// Both hooks run retained supplementary queries whose deferred fetch and
// retry settle outside act() on a loaded host; the page reads only their data.
vi.mock("../../hooks/useProcesses", () => ({
  useProcesses: () => ({
    processes: [],
    terminatedProcesses: [],
    loading: false,
    error: null,
    activeCount: 0,
    refetch: vi.fn(),
  }),
}));

vi.mock("../../hooks/usePublicShareStatus", () => ({
  usePublicShareStatus: () => ({
    status: null,
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));

vi.mock("../../hooks/useVersion", () => ({
  useVersion: () => ({ version: versionState.version }),
}));

vi.mock("../../lib/clientSummaryStore", () => ({
  LOCAL_CLIENT_SUMMARY_SOURCE_KEY: "local",
  REMOTE_NONE_CLIENT_SUMMARY_SOURCE_KEY: "remote:none",
  getCurrentClientSummarySourceKey: () => "host:test",
  setCurrentClientSummarySourceKey: vi.fn(),
  useClientSummarySourceKey: () => "host:test",
  useSessionCollectionQueryRecords: () => sessionCollectionState.records,
  useProjectQueuedSessionIds: () => sessionCollectionState.queuedSessionIds,
  useDraftSessionIds: () => new Set<string>(),
}));

vi.mock("../../hooks/useRemoteBasePath", () => ({
  useRemoteBasePath: () => "",
}));

vi.mock("../../hooks/useServerSettings", () => ({
  useServerSettings: () => ({
    settings: { publicSharesEnabled: false },
    isLoading: false,
    error: null,
    updateSettings: vi.fn(),
    updateSetting: vi.fn(),
    refetch: vi.fn(),
  }),
}));

vi.mock("../../i18n", () => ({
  useI18n: () => ({
    t: (key: string, vars?: Record<string, string | number>) => {
      const messages: Record<string, string> = {
        ...english,
        sidebarNewSession: "New Session",
        globalSessionsTitle: "All Sessions",
        globalSessionsSearchPlaceholder: "Search sessions...",
        globalSessionsFilterAgePlaceholder: "Any age",
        globalSessionsClearFilters: "Clear filters",
        globalSessionsStatusAll: "All",
        globalSessionsFilterProjectPlaceholder: "All projects",
        globalSessionsFilterStatus: "Status",
        globalSessionsFilterProvider: "Provider",
        globalSessionsProviderAll: "All providers",
        globalSessionsFilterExecutor: "Machine",
        globalSessionsFilterAge: "Age",
        inboxFilterProject: "Project",
        globalSessionsFilterMachinePlaceholder: "All machines",
        globalSessionsAge3Days: "Older than 3 days",
        globalSessionsAge7Days: "Older than 7 days",
        globalSessionsAge14Days: "Older than 14 days",
        globalSessionsAge30Days: "Older than 30 days",
        globalSessionsProjectCtaHint: "Open session for",
        globalSessionsProjectCtaPromptLabel: "First prompt",
        globalSessionsNoResultsTitle: "No sessions found",
        globalSessionsNoResultsEmpty:
          "Sessions from all your projects will appear here.",
        globalSessionsNoResultsFiltered:
          "Try adjusting your filters or search query.",
        sidebarLoadingSessions: "Loading sessions...",
        projectsErrorPrefix: "Projects error:",
      };
      let text = messages[key] ?? key;
      if (!vars) return text;
      for (const [name, value] of Object.entries(vars)) {
        text = text.replaceAll(`{${name}}`, String(value));
      }
      return text;
    },
  }),
}));

vi.mock("../../layouts", () => ({
  MainContent: ({ children }: { children: ReactNode }) => (
    <main>{children}</main>
  ),
  useNavigationLayout: () => ({
    openSidebar: vi.fn(),
    isWideScreen: true,
    toggleSidebar: vi.fn(),
    isSidebarCollapsed: false,
  }),
}));

vi.mock("../../lib/newSessionPrefill", () => ({
  setNewSessionPrefill: mockSetNewSessionPrefill,
}));

function makeSessionRecord(
  id: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    title: `Session ${id}`,
    fullTitle: `Session ${id}`,
    createdAt: "2026-04-21T00:00:00.000Z",
    updatedAt: "2026-04-21T00:00:00.000Z",
    messageCount: 1,
    provider: "claude",
    projectId: "project-1",
    projectName: "Alpha",
    ownership: { owner: "none" },
    isArchived: false,
    isStarred: false,
    observedAt: 1,
    ...overrides,
  };
}

describe("GlobalSessionsPage", () => {
  beforeEach(() => {
    runtime.transport.fetch.mockReset();
    providerState.providers = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: true,
        addEventListener() {},
        removeEventListener() {},
      })),
    );
    globalSessionsState.sessions = [];
    sessionCollectionState.records = [];
    sessionCollectionState.queuedSessionIds = new Set<string>();
    globalSessionsState.projects = [
      {
        id: "project-1",
        name: "Alpha",
        path: "/tmp/alpha",
        sessionCount: 3,
        lastActivity: "2026-04-21T00:00:00.000Z",
      },
    ];
    globalSessionsState.loading = false;
    globalSessionsState.error = null;
    globalSessionsState.hasMore = false;
    globalSessionsState.loadMore = mockLoadMore;
    versionState.version = { capabilities: [PROJECT_QUEUE_CAPABILITY] };
    mockNavigate.mockReset();
    mockSetNewSessionPrefill.mockReset();
    mockLoadMore.mockReset();
    mockUseProjectQueues.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  function renderPage(initialEntry: string) {
    return render(
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/sessions" element={<GlobalSessionsPage />} />
        </Routes>
      </MemoryRouter>,
    );
  }

  it("defaults to unarchived and preserves an explicitly cleared status", async () => {
    sessionCollectionState.records = [
      makeSessionRecord("active"),
      makeSessionRecord("archived", { isArchived: true }),
    ];
    renderPage("/sessions");
    const filter = screen.getByRole("button", { name: "Filter: Unarchived" });
    expect(filter.getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByTestId("session-archived")).toBeNull();
    fireEvent.click(filter);
    expect(screen.getByTestId("session-archived")).toBeDefined();
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "Session" },
    });
    await waitFor(() =>
      expect(filter.getAttribute("aria-pressed")).toBe("false"),
    );
    cleanup();
    renderPage("/sessions?status=");
    expect(screen.getByTestId("session-archived")).toBeDefined();
    cleanup();
    renderPage("/sessions?status=archived");
    expect(screen.getByTestId("session-archived")).toBeDefined();
    expect(screen.queryByTestId("session-active")).toBeNull();
  });

  it("filters recorded web sessions and keeps unmarked sessions distinct", () => {
    versionState.version = {
      capabilities: [SESSION_CREATION_PROVENANCE_CAPABILITY],
    };
    sessionCollectionState.records = [
      makeSessionRecord("web", { creationProvenance: { surface: "web" } }),
      makeSessionRecord("desktop", {
        creationProvenance: { surface: "desktop" },
      }),
      makeSessionRecord("api", { creationProvenance: { surface: "api" } }),
      makeSessionRecord("unmarked"),
    ];
    filterDropdowns.length = 0;
    renderPage("/sessions?created=web&status=");

    expect(screen.getByTestId("session-web")).toBeDefined();
    expect(screen.queryByTestId("session-desktop")).toBeNull();
    expect(screen.queryByTestId("session-api")).toBeNull();
    expect(screen.queryByTestId("session-unmarked")).toBeNull();
    expect(
      filterDropdowns.find((dropdown) => dropdown.label === "Created from")
        ?.options,
    ).toMatchObject([
      { value: "web" },
      { value: "desktop" },
      { value: "api" },
      { value: "unspecified" },
    ]);
  });

  it("hides creation filtering and ignores its URL parameter on older servers", () => {
    versionState.version = { current: "0.9.2" };
    sessionCollectionState.records = [
      makeSessionRecord("web", { creationProvenance: { surface: "web" } }),
      makeSessionRecord("unmarked"),
    ];
    filterDropdowns.length = 0;
    renderPage("/sessions?created=web&status=");

    expect(screen.getByTestId("session-web")).toBeDefined();
    expect(screen.getByTestId("session-unmarked")).toBeDefined();
    expect(
      filterDropdowns.find((dropdown) => dropdown.label === "Created from"),
    ).toBeUndefined();
  });

  // The browser test in e2e/all-sessions-search.spec.ts measures key-to-frame
  // latency. fireEvent also flushes deferred React work, so its return time
  // cannot measure when the input acknowledged the key.
  // The 300-row jsdom rerenders took 5559ms and 5647ms in CI runs
  // 36539929521 and 36540817702, exceeding the default 5s whole-test budget.
  // Allow 2.7x that measured maximum; browser key-to-frame limits stay intact.
  it("preserves sequential search typing while provenance filtering and the catalog update", () => {
    versionState.version = {
      capabilities: [SESSION_CREATION_PROVENANCE_CAPABILITY],
    };
    sessionCollectionState.records = Array.from({ length: 300 }, (_, index) =>
      makeSessionRecord(`web-${index}`, {
        creationProvenance: { surface: "web" },
      }),
    );
    const page = () => (
      <MemoryRouter initialEntries={["/sessions?created=web&status="]}>
        <Routes>
          <Route path="/sessions" element={<GlobalSessionsPage />} />
        </Routes>
      </MemoryRouter>
    );
    const view = render(page());
    const input = screen.getByRole("searchbox") as HTMLInputElement;
    act(() => input.focus());
    let typed = "";
    for (const char of "source") {
      typed += char;
      fireEvent.keyDown(input, { key: char });
      fireEvent.change(input, { target: { value: typed } });
      expect(input.value).toBe(typed);
      sessionCollectionState.records = [
        ...sessionCollectionState.records,
        makeSessionRecord(`desktop-${typed}`, {
          creationProvenance: { surface: "desktop" },
        }),
      ];
      view.rerender(page());
      expect(input.value).toBe(typed);
    }
  }, 15_000);

  for (const release of ["0.8.0", "0.8.1"]) {
    it(`keeps ${release} title-only without content-search requests`, async () => {
      versionState.version = { current: release };
      sessionCollectionState.records = [makeSessionRecord("one")];
      renderPage("/sessions");
      const title = screen.getByRole("checkbox", { name: "Title" });
      expect((title as HTMLInputElement).checked).toBe(true);
      expect(
        (screen.getByRole("checkbox", { name: /^Ass\./ }) as HTMLInputElement)
          .disabled,
      ).toBe(true);
      expect(
        (screen.getByRole("checkbox", { name: /^User/ }) as HTMLInputElement)
          .disabled,
      ).toBe(true);
      await act(async () => {
        fireEvent.change(screen.getByRole("searchbox"), {
          target: { value: "Session one" },
        });
      });
      expect(screen.getByTestId("session-one")).toBeDefined();
      await act(async () => {
        fireEvent.keyDown(document, { key: "s", ctrlKey: true });
      });
      expect((title as HTMLInputElement).checked).toBe(true);
      expect(runtime.transport.fetch).not.toHaveBeenCalled();
    });
  }

  it("skips unsupported native readers and quotes diagnostics after results", async () => {
    versionState.version = {
      capabilities: [SESSION_CONTENT_SEARCH_CAPABILITY],
    };
    sessionCollectionState.records = [
      makeSessionRecord("supported"),
      makeSessionRecord("unsupported", { provider: "grok" }),
      makeSessionRecord("unavailable", { provider: "codex" }),
    ];
    providerState.providers = [
      { name: "codex", supportsBoundedTurnSearch: false } as ProviderInfo,
    ];
    runtime.transport.fetch.mockResolvedValue({
      matches: [],
      done: true,
      partial: true,
      bytesRead: 0,
      unavailable: "Malformed transcript record",
    });
    renderPage("/sessions?q=Session");
    fireEvent.click(screen.getByRole("checkbox", { name: /^User/ }));
    // The scan passes through real start, scheduling and publish timers. The
    // whole test takes ~310ms on a development host; CI runs at 8bdd9063a and
    // b4601c77a exceeded the 1000ms default wait with "0 / 1 sessions
    // scanned" showing, so the budget is 4x that observed limit.
    await waitFor(
      () =>
        expect(screen.getByText(/Malformed transcript record/)).toBeDefined(),
      { timeout: 4_000 },
    );
    expect(runtime.transport.fetch).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(runtime.transport.fetch.mock.calls[0]![1].body).sessionId,
    ).toBe("supported");
    const lastResult = screen.getByTestId("session-unavailable");
    expect(screen.getByTestId("session-unsupported")).toBeDefined();
    const title = screen.getByText("Session supported", { selector: "q" });
    expect(
      lastResult.compareDocumentPosition(title) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("keeps unselected sessions listed and retains selections the search hides", async () => {
    sessionCollectionState.records = [
      makeSessionRecord("alpha"),
      makeSessionRecord("beta"),
    ];
    renderPage("/sessions");
    await act(async () => {
      fireEvent.click(
        screen.getByRole("checkbox", { name: "Select Session alpha" }),
      );
    });
    expect(screen.getByTestId("session-beta")).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Clear 1 selected" }),
    ).toBeDefined();
    await act(async () => {
      fireEvent.change(screen.getByRole("searchbox"), {
        target: { value: "beta" },
      });
    });
    expect(screen.queryByTestId("session-alpha")).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Select all 1/ }));
    });
    expect(
      screen.getByRole("button", { name: "Clear 2 selected" }),
    ).toBeDefined();
    await act(async () => {
      fireEvent.change(screen.getByRole("searchbox"), {
        target: { value: "" },
      });
    });
    expect(screen.getByTestId("session-alpha")).toBeDefined();
    expect(screen.getByTestId("session-beta")).toBeDefined();
    expect(
      (
        screen.getByRole("button", {
          name: /Select all 2/,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Clear 2 selected" }));
    });
    expect(screen.queryByRole("button", { name: "Archive" })).toBeNull();
    expect(runtime.transport.fetch).not.toHaveBeenCalled();
  });

  it("restricts results to the selection only while Only selected is on", async () => {
    sessionCollectionState.records = [
      makeSessionRecord("alpha"),
      makeSessionRecord("beta"),
    ];
    renderPage("/sessions");
    const only = screen.getByRole("button", { name: "Only selected" });
    await act(async () => {
      fireEvent.click(only);
    });
    // Nothing is selected yet, so nothing is hidden.
    expect(screen.getByTestId("session-beta")).toBeDefined();
    await act(async () => {
      fireEvent.click(
        screen.getByRole("checkbox", { name: "Select Session alpha" }),
      );
    });
    expect(screen.queryByTestId("session-beta")).toBeNull();
    await act(async () => {
      fireEvent.click(only);
    });
    expect(only.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByTestId("session-beta")).toBeDefined();
  });

  it("offers only the bulk actions the selection can take", async () => {
    sessionCollectionState.records = [
      makeSessionRecord("plain"),
      makeSessionRecord("starred", { isStarred: true }),
    ];
    renderPage("/sessions");
    await act(async () => {
      fireEvent.click(
        screen.getByRole("checkbox", { name: "Select Session plain" }),
      );
    });
    expect(screen.getByRole("button", { name: "Archive" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Star" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Unarchive" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Unstar" })).toBeNull();
    await act(async () => {
      fireEvent.click(
        screen.getByRole("checkbox", { name: "Select Session starred" }),
      );
    });
    expect(screen.getByRole("button", { name: "Star" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Unstar" })).toBeDefined();
    // Status filters no longer choose an action.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Filter: Archived" }));
    });
    expect(screen.queryByRole("button", { name: /^Make / })).toBeNull();
    expect(screen.queryByRole("button", { name: "Unarchive" })).toBeNull();
  });

  it("applies bulk actions to hidden selections on the original transport across batches", async () => {
    sessionCollectionState.records = Array.from({ length: 10 }, (_, i) =>
      makeSessionRecord(`bulk-${i}`),
    );
    renderPage("/sessions");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Select all 10/ }));
      fireEvent.change(screen.getByRole("searchbox"), {
        target: { value: "bulk-0" },
      });
    });
    const originalFetch = runtime.transport.fetch;
    const replacementFetch = vi.fn();
    originalFetch.mockImplementation(async () => {
      runtime.transport.fetch = replacementFetch;
      return { success: true };
    });
    try {
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Star" }));
      });
      expect(originalFetch).toHaveBeenCalledTimes(10);
      expect(replacementFetch).not.toHaveBeenCalled();
      for (const [, options] of originalFetch.mock.calls) {
        expect(JSON.parse(options.body)).toEqual({ starred: true });
      }
      expect(
        screen.queryByRole("button", { name: "Clear 10 selected" }),
      ).toBeNull();
    } finally {
      runtime.transport.fetch = originalFetch;
    }
  });

  it("keeps renamed titles searchable while applying the chosen time basis to prompts and sessions", async () => {
    sessionCollectionState.records = [
      makeSessionRecord("renamed", {
        title: "Renamed title",
        fullTitle: "Renamed title",
        initialPrompt: "Original opening needle",
        createdAt: new Date(Date.now() - 2 * 86400000).toISOString(),
        updatedAt: new Date(Date.now() - 3600000).toISOString(),
      }),
    ];
    renderPage("/sessions?q=opening");
    expect(screen.getByTestId("session-renamed")).toBeDefined();
    expect(
      screen.getByRole("radio", { name: "Last activity", checked: true }),
    ).toBeDefined();
    await act(async () => {
      fireEvent.click(screen.getByRole("radio", { name: /^Turns$/ }));
    });
    await act(async () => {
      fireEvent.change(screen.getByRole("textbox", { name: /^Maximum age/ }), {
        target: { value: "1" },
      });
    });
    expect(screen.queryByTestId("session-renamed")).toBeNull();
    await act(async () => {
      fireEvent.change(screen.getByRole("searchbox"), {
        target: { value: "Renamed" },
      });
    });
    expect(screen.getByTestId("session-renamed")).toBeDefined();
    await act(async () => {
      fireEvent.click(screen.getByRole("radio", { name: "Created" }));
    });
    expect(screen.queryByTestId("session-renamed")).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("radio", { name: "Last activity" }));
    });
    expect(screen.getByTestId("session-renamed")).toBeDefined();
    await act(async () => {
      fireEvent.change(screen.getByRole("textbox", { name: /^Minimum age/ }), {
        target: { value: "25h" },
      });
    });
    // Shown under the filters, not announced per keystroke.
    expect(screen.getByText(/valid range/)).toBeDefined();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByTestId("session-renamed")).toBeNull();
    expect(runtime.transport.fetch).not.toHaveBeenCalled();
  });

  it("ranks results from catalog order again when the needle changes", async () => {
    sessionCollectionState.records = [
      makeSessionRecord("yankee"),
      makeSessionRecord("xray"),
    ];
    renderPage("/sessions?q=xray");
    expect(screen.queryByTestId("session-yankee")).toBeNull();
    await act(async () => {
      fireEvent.change(screen.getByRole("searchbox"), {
        target: { value: "" },
      });
    });
    const yankee = screen.getByTestId("session-yankee");
    const xray = screen.getByTestId("session-xray");
    expect(
      yankee.compareDocumentPosition(xray) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("manages a selected session whose provider has no turn search", async () => {
    versionState.version = {
      capabilities: [SESSION_CONTENT_SEARCH_CAPABILITY],
    };
    sessionCollectionState.records = [
      makeSessionRecord("supported"),
      makeSessionRecord("unsupported", { provider: "grok" }),
    ];
    renderPage("/sessions");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Select all 2/ }));
    });
    await act(async () => {
      fireEvent.click(screen.getByTitle(/Click to manage selection/));
    });
    const manager = within(
      screen.getByRole("region", {
        name: "Selection — selected and turn-searchable sessions",
      }),
    );
    const row = manager.getByRole("checkbox", { name: /Session unsupported/ });
    expect((row as HTMLInputElement).checked).toBe(true);
    await act(async () => {
      fireEvent.click(row);
    });
    expect(
      manager.queryByRole("checkbox", { name: /Session unsupported/ }),
    ).toBeNull();
    expect(
      manager.getByRole("checkbox", { name: /Session supported/ }),
    ).toBeDefined();
    expect(runtime.transport.fetch).not.toHaveBeenCalled();
  });

  it("shows the project CTA when arriving from the projects list", () => {
    renderPage("/sessions?project=project-1&source=projects");

    expect(screen.getAllByText("New Session")[0]).toBeDefined();
    expect(screen.getAllByText("Alpha")).toHaveLength(2);
    expect(screen.getByText("Open session for")).toBeDefined();
    expect(screen.getByRole("button", { name: "New Session" })).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "New Session" }));

    expect(mockSetNewSessionPrefill).not.toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith(
      "/new-session?projectId=project-1",
    );
  });

  it("offers every project as the first choice in the project filter", () => {
    filterDropdowns.length = 0;
    renderPage("/sessions?project=project-1");
    expect(screen.getByText("Open session for")).toBeDefined();

    const projectFilter = filterDropdowns.find(
      (dropdown) => dropdown.label === "Projects",
    );
    expect(projectFilter?.options[0]).toEqual({
      value: "",
      label: "All projects",
      clearSelection: true,
    });
    expect(projectFilter?.options[1]).toEqual({
      value: "project-1",
      label: "Alpha",
    });

    // Choosing it clears the project filter, so the project CTA goes away.
    act(() => projectFilter?.onChange([]));
    expect(screen.queryByText("Open session for")).toBe(null);
  });

  it("shows the project CTA for project-filtered views without a source hint", () => {
    renderPage("/sessions?project=project-1");

    expect(screen.getAllByText("New Session")[0]).toBeDefined();
    expect(screen.getAllByText("Alpha")).toHaveLength(2);
    expect(screen.getByText("Open session for")).toBeDefined();
    expect(screen.getByRole("button", { name: "New Session" })).toBeDefined();
  });

  it("prefills the new session from the active project search query", () => {
    renderPage("/sessions?project=project-1&q=fix%20login%20flow");

    expect(screen.getByText("First prompt")).toBeDefined();
    expect(screen.getByText("fix login flow")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "New Session" }));

    expect(mockSetNewSessionPrefill).toHaveBeenCalledWith(
      "host:test",
      "fix login flow",
    );
    expect(mockNavigate).toHaveBeenCalledWith(
      "/new-session?projectId=project-1",
    );
  });

  it("renders sessions from collection query records", () => {
    globalSessionsState.sessions = [];
    sessionCollectionState.records = [
      makeSessionRecord("collection-only", {
        title: "Collection row",
        fullTitle: "Collection row",
      }),
    ];

    renderPage("/sessions");

    expect(screen.getByTestId("session-collection-only").textContent).toBe(
      "Collection row",
    );
  });

  it("marks sessions with project queue items from store decorations", () => {
    sessionCollectionState.records = [
      makeSessionRecord("queued-session", {
        title: "Queued row",
        fullTitle: "Queued row",
      }),
      makeSessionRecord("plain-session", {
        title: "Plain row",
        fullTitle: "Plain row",
      }),
    ];
    sessionCollectionState.queuedSessionIds = new Set(["queued-session"]);

    renderPage("/sessions");

    expect(mockUseProjectQueues).toHaveBeenCalledWith(["project-1"]);
    expect(screen.getByTestId("project-queue-queued-session")).toBeDefined();
    expect(screen.queryByTestId("project-queue-plain-session")).toBe(null);
  });
});
