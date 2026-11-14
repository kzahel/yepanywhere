import { PROGRESSIVE_SESSION_CATALOG_CAPABILITY } from "@yep-anywhere/shared";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  GlobalSessionItem,
  GlobalSessionsResponse,
  GlobalSessionStats,
  ProjectOption,
} from "../../api/client";
import { activityBus } from "../../lib/activityBus";
import {
  getClientQueryStates,
  resetClientQueryControllerForTests,
} from "../../lib/clientQueryController";
import {
  getQueryRevalidationMetrics,
  resetQueryRevalidationForTests,
} from "../../lib/clientQueryRevalidation";
import {
  resetClientSummaryStoreForTests,
  useSessionCollectionQueryRecords,
} from "../../lib/clientSummaryStore";
import {
  DEFAULT_GLOBAL_SESSION_STATS,
  resetGlobalSessionsFeedForTests,
  type UseGlobalSessionsOptions,
  useGlobalSessionsFeed,
} from "../useGlobalSessionsFeed";

const mocks = vi.hoisted(() => ({
  getGlobalSessions: vi.fn(),
  getGlobalSessionStats: vi.fn(),
  useFileActivity: vi.fn(),
  versionInfo: vi.fn(),
  ensureVersionInfo: vi.fn(),
}));

vi.mock("../../api/client", () => ({
  api: {
    getGlobalSessions: mocks.getGlobalSessions,
    getGlobalSessionStats: mocks.getGlobalSessionStats,
  },
  isUnchangedGlobalSessionsResponse: (response: { unchanged?: boolean }) =>
    response.unchanged === true,
}));

vi.mock("../useFileActivity", () => ({
  useFileActivity: mocks.useFileActivity,
}));

vi.mock("../useVersion", () => ({
  useRetainedVersionInfo: () => mocks.versionInfo(),
  ensureVersionInfo: (...args: unknown[]) => mocks.ensureVersionInfo(...args),
}));

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const RECENT = "2026-06-27T11:00:00.000Z";
const PROJECT: ProjectOption = { id: "project-1", name: "Project" };

function globalSession(
  id: string,
  overrides: Partial<GlobalSessionItem> = {},
): GlobalSessionItem {
  return {
    id,
    title: `Session ${id}`,
    fullTitle: `Session ${id}`,
    createdAt: RECENT,
    updatedAt: RECENT,
    messageCount: 1,
    provider: "claude",
    projectId: PROJECT.id,
    projectName: PROJECT.name,
    ownership: { owner: "none" },
    isArchived: false,
    isStarred: false,
    ...overrides,
  };
}

function globalSessionsResponse(
  ids: readonly string[],
  overrides: Partial<GlobalSessionsResponse> = {},
): GlobalSessionsResponse {
  return {
    sessions: ids.map((id) => globalSession(id)),
    hasMore: false,
    stats: DEFAULT_GLOBAL_SESSION_STATS,
    projects: [PROJECT],
    ...overrides,
  };
}

function stats(
  overrides: Partial<GlobalSessionStats> = {},
): GlobalSessionStats {
  return {
    ...DEFAULT_GLOBAL_SESSION_STATS,
    ...overrides,
  };
}

function useFeedWithRecords(options?: UseGlobalSessionsOptions) {
  const feed = useGlobalSessionsFeed(options);
  const records = useSessionCollectionQueryRecords(feed.query);
  return { feed, records };
}

beforeEach(() => {
  resetClientSummaryStoreForTests();
  resetClientQueryControllerForTests();
  resetQueryRevalidationForTests();
  resetGlobalSessionsFeedForTests();
  mocks.getGlobalSessions.mockReset();
  mocks.getGlobalSessionStats.mockReset();
  mocks.getGlobalSessionStats.mockResolvedValue({
    stats: DEFAULT_GLOBAL_SESSION_STATS,
  });
  mocks.useFileActivity.mockClear();
  mocks.versionInfo.mockReset();
  mocks.versionInfo.mockReturnValue(null);
  mocks.ensureVersionInfo.mockReset();
  mocks.ensureVersionInfo.mockImplementation(async () => mocks.versionInfo());
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  resetClientSummaryStoreForTests();
  resetClientQueryControllerForTests();
  resetQueryRevalidationForTests();
  resetGlobalSessionsFeedForTests();
});

describe("useGlobalSessionsFeed", () => {
  it("refreshes the loaded window without dropping and reloading older rows", async () => {
    mocks.getGlobalSessions
      .mockResolvedValueOnce(
        globalSessionsResponse(["a", "b"], { hasMore: true }),
      )
      .mockResolvedValueOnce(
        globalSessionsResponse(["c", "d"], { hasMore: true }),
      )
      .mockImplementation(async (request) =>
        globalSessionsResponse(["a", "b", "c", "d"].slice(0, request.limit), {
          hasMore: true,
        }),
      );
    const lengths: number[] = [];
    const { result } = renderHook(() => {
      const value = useFeedWithRecords({ limit: 2 });
      lengths.push(value.records.length);
      return value;
    });
    await waitFor(() => expect(result.current.records).toHaveLength(2));
    await act(() => result.current.feed.loadMore());
    expect(result.current.records).toHaveLength(4);
    lengths.length = 0;
    await act(() => result.current.feed.refetch());
    expect(mocks.getGlobalSessions.mock.calls.at(-1)?.[0]).toMatchObject({
      limit: 4,
    });
    expect(result.current.records).toHaveLength(4);
    expect(lengths).not.toContain(2);
  });

  it("refreshes beyond the server page limit atomically, including removals", async () => {
    const rows = Array.from({ length: 600 }, (_, index) =>
      globalSession(`session-${index}`, {
        updatedAt: new Date(Date.parse(RECENT) - index * 1000).toISOString(),
      }),
    );
    const finalPage = deferred<GlobalSessionsResponse>();
    mocks.getGlobalSessions
      .mockResolvedValueOnce(
        globalSessionsResponse([], {
          sessions: rows.slice(0, 500),
          hasMore: true,
        }),
      )
      .mockResolvedValueOnce(
        globalSessionsResponse([], {
          sessions: rows.slice(500),
        }),
      )
      .mockResolvedValueOnce(
        globalSessionsResponse([], {
          sessions: rows.slice(0, 500),
          hasMore: true,
        }),
      )
      .mockReturnValueOnce(finalPage.promise);
    const lengths: number[] = [];
    const { result } = renderHook(() => {
      const value = useFeedWithRecords({ limit: 500 });
      lengths.push(value.records.length);
      return value;
    });
    await waitFor(() => expect(result.current.records).toHaveLength(500));
    await act(() => result.current.feed.loadMore());
    expect(result.current.records).toHaveLength(600);
    lengths.length = 0;
    let refresh!: Promise<void>;
    act(() => {
      refresh = result.current.feed.refetch();
    });
    await waitFor(() =>
      expect(mocks.getGlobalSessions).toHaveBeenCalledTimes(4),
    );
    expect(result.current.records).toHaveLength(600);
    expect(mocks.getGlobalSessions.mock.calls[3]?.[0]).toMatchObject({
      limit: 100,
      after: rows[499]?.updatedAt,
    });
    await act(async () => {
      finalPage.resolve(
        globalSessionsResponse([], { sessions: rows.slice(500, 590) }),
      );
      await refresh;
    });
    expect(result.current.records).toHaveLength(590);
    expect(lengths).not.toContain(500);
  });

  it("uses retained mode on capable servers and refreshes on catalog publication without full stats", async () => {
    mocks.versionInfo.mockReturnValue({ current: "0.8.2" });
    const catalog = {
      catalogEpoch: "epoch",
      catalogGeneration: 1,
      complete: true,
      refreshing: true,
    };
    mocks.getGlobalSessions.mockResolvedValue(
      globalSessionsResponse(["saved"], { catalog }),
    );
    const { result } = renderHook(() =>
      useFeedWithRecords({ includeStats: true }),
    );
    await waitFor(() => expect(result.current.records).toHaveLength(1));
    expect(mocks.getGlobalSessions).toHaveBeenCalledWith(
      expect.objectContaining({ summaryMode: "retained" }),
    );
    expect(mocks.getGlobalSessions.mock.calls[0]?.[0]).not.toHaveProperty(
      "knownGeneration",
    );
    expect(mocks.getGlobalSessionStats).not.toHaveBeenCalled();
    mocks.getGlobalSessions.mockResolvedValue(
      globalSessionsResponse(["saved", "new"], {
        catalog: { ...catalog, catalogGeneration: 2, refreshing: false },
      }),
    );
    act(() =>
      activityBus.emitLocal("session-catalog-updated", {
        type: "session-catalog-updated",
        catalog: { ...catalog, catalogGeneration: 2, refreshing: false },
        timestamp: RECENT,
      }),
    );
    await waitFor(() => expect(result.current.records).toHaveLength(2));
  });

  it("keeps cold catalog loading visible and surfaces refresh failure", async () => {
    mocks.versionInfo.mockReturnValue({ current: "0.8.2" });
    const catalog = {
      catalogEpoch: "new",
      catalogGeneration: 0,
      complete: false,
      refreshing: true,
    };
    mocks.getGlobalSessions.mockResolvedValue(
      globalSessionsResponse([], { catalog }),
    );
    const { result } = renderHook(() => useFeedWithRecords());
    await waitFor(() =>
      expect(mocks.getGlobalSessions).toHaveBeenCalledTimes(1),
    );
    expect(result.current.feed.loading).toBe(true);
    mocks.getGlobalSessions.mockResolvedValue(
      globalSessionsResponse([], {
        catalog: {
          ...catalog,
          refreshing: false,
          refreshError: "Provider unavailable",
        },
      }),
    );
    await act(async () => {
      await result.current.feed.refetch();
    });
    expect(result.current.feed.loading).toBe(false);
    expect(result.current.feed.error?.message).toBe("Provider unavailable");
    expect(result.current.feed.requestError).toBeNull();
  });

  it("keeps the complete request on an older server", async () => {
    mocks.versionInfo.mockReturnValue({ current: "0.8.1" });
    mocks.getGlobalSessions.mockResolvedValue(globalSessionsResponse(["old"]));
    const { result } = renderHook(() => useFeedWithRecords());
    await waitFor(() => expect(result.current.records).toHaveLength(1));
    expect(mocks.getGlobalSessions.mock.calls[0]?.[0]).not.toHaveProperty(
      "summaryMode",
    );
  });

  it("observes both abandoned reads when the source changes during the version read", async () => {
    // The client tsconfig has no Node types; vitest runs it under Node.
    type RejectionListener = (reason: unknown) => void;
    const nodeProcess = (
      globalThis as unknown as {
        process: {
          on(event: "unhandledRejection", listener: RejectionListener): void;
          off(event: "unhandledRejection", listener: RejectionListener): void;
        };
      }
    ).process;
    const unhandled: unknown[] = [];
    const recordUnhandled: RejectionListener = (reason) =>
      unhandled.push(reason);
    nodeProcess.on("unhandledRejection", recordUnhandled);
    try {
      mocks.ensureVersionInfo.mockRejectedValue(
        new Error("Session source changed"),
      );
      const { result } = renderHook(() =>
        useFeedWithRecords({ includeStats: true }),
      );
      await waitFor(() =>
        expect(result.current.feed.error?.message).toBe(
          "Session source changed",
        ),
      );
      // Unhandled rejections are reported after a macrotask turn.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
      expect(mocks.getGlobalSessions).not.toHaveBeenCalled();
      expect(mocks.getGlobalSessionStats).not.toHaveBeenCalled();
    } finally {
      nodeProcess.off("unhandledRejection", recordUnhandled);
    }
  });

  it("releases query and activity work while disabled", () => {
    const { result } = renderHook(() =>
      useGlobalSessionsFeed({ enabled: false, limit: 50 }),
    );

    expect(result.current.loading).toBe(false);
    expect(mocks.getGlobalSessions).not.toHaveBeenCalled();
    expect(getClientQueryStates()).toHaveLength(0);
    expect(mocks.useFileActivity).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false }),
    );
  });

  it("coalesces compatible row coverage under the shared base query", async () => {
    const request = deferred<GlobalSessionsResponse>();
    mocks.getGlobalSessions.mockReturnValue(request.promise);

    const full = renderHook(() => useFeedWithRecords());
    const sidebar = renderHook(() => useFeedWithRecords({ limit: 50 }));

    await waitFor(() =>
      expect(mocks.getGlobalSessions).toHaveBeenCalledTimes(1),
    );
    expect(sidebar.result.current.feed.query.limit).toBeUndefined();

    await act(async () => {
      request.resolve(globalSessionsResponse(["session-a", "session-b"]));
      await request.promise;
    });

    await waitFor(() => expect(full.result.current.feed.loading).toBe(false));
    await waitFor(() =>
      expect(sidebar.result.current.feed.loading).toBe(false),
    );
    expect(full.result.current.records.map((record) => record.id)).toEqual([
      "session-a",
      "session-b",
    ]);
    expect(sidebar.result.current.records.map((record) => record.id)).toEqual([
      "session-a",
      "session-b",
    ]);
  });

  it("fetches again when cached row coverage is too small", async () => {
    mocks.getGlobalSessions
      .mockResolvedValueOnce(globalSessionsResponse(["recent-only"]))
      .mockResolvedValueOnce(
        globalSessionsResponse(["recent-only", "sidebar-extra"]),
      );

    const recent = renderHook(() => useFeedWithRecords({ limit: 15 }));
    await waitFor(() => expect(recent.result.current.feed.loading).toBe(false));

    const sidebar = renderHook(() => useFeedWithRecords({ limit: 50 }));
    await waitFor(() =>
      expect(sidebar.result.current.feed.loading).toBe(false),
    );

    expect(mocks.getGlobalSessions).toHaveBeenCalledTimes(2);
    expect(mocks.getGlobalSessions.mock.calls[0]?.[0]).toMatchObject({
      limit: 15,
    });
    expect(mocks.getGlobalSessions.mock.calls[1]?.[0]).toMatchObject({
      limit: 50,
    });
    expect(sidebar.result.current.records.map((record) => record.id)).toEqual([
      "recent-only",
      "sidebar-extra",
    ]);
  });

  it("uses fresh stronger coverage for later smaller consumers", async () => {
    mocks.getGlobalSessions.mockResolvedValue(
      globalSessionsResponse(["session-a", "session-b"]),
    );

    const full = renderHook(() => useFeedWithRecords());
    await waitFor(() => expect(full.result.current.feed.loading).toBe(false));

    const recent = renderHook(() => useFeedWithRecords({ limit: 15 }));
    await waitFor(() => expect(recent.result.current.feed.loading).toBe(false));

    expect(mocks.getGlobalSessions).toHaveBeenCalledTimes(1);
    expect(recent.result.current.records.map((record) => record.id)).toEqual([
      "session-a",
      "session-b",
    ]);
  });

  it("fetches stats separately from coalesced row coverage", async () => {
    const rowsRequest = deferred<GlobalSessionsResponse>();
    const statsRequest = deferred<{ stats: GlobalSessionStats }>();
    mocks.getGlobalSessions.mockReturnValue(rowsRequest.promise);
    mocks.getGlobalSessionStats.mockReturnValue(statsRequest.promise);

    const full = renderHook(() =>
      useFeedWithRecords({
        includeStats: true,
      }),
    );
    const sidebar = renderHook(() => useFeedWithRecords({ limit: 50 }));

    await waitFor(() =>
      expect(mocks.getGlobalSessions).toHaveBeenCalledTimes(1),
    );
    await waitFor(() =>
      expect(mocks.getGlobalSessionStats).toHaveBeenCalledTimes(1),
    );

    await act(async () => {
      rowsRequest.resolve(globalSessionsResponse(["session-a"]));
      statsRequest.resolve({ stats: stats({ totalCount: 7 }) });
      await Promise.all([rowsRequest.promise, statsRequest.promise]);
    });

    await waitFor(() => expect(full.result.current.feed.loading).toBe(false));
    await waitFor(() =>
      expect(sidebar.result.current.feed.loading).toBe(false),
    );
    expect(full.result.current.feed.stats.totalCount).toBe(7);
    expect(sidebar.result.current.feed.stats.totalCount).toBe(0);
    expect(full.result.current.feed.projects).toEqual([PROJECT]);
  });

  it("forces a row request for explicit refetch", async () => {
    mocks.getGlobalSessions
      .mockResolvedValueOnce(globalSessionsResponse(["first"]))
      .mockResolvedValueOnce(globalSessionsResponse(["second"]));

    const feed = renderHook(() => useFeedWithRecords());
    await waitFor(() => expect(feed.result.current.feed.loading).toBe(false));

    await act(async () => {
      await feed.result.current.feed.refetch();
    });

    expect(mocks.getGlobalSessions).toHaveBeenCalledTimes(2);
    expect(feed.result.current.records.map((record) => record.id)).toEqual([
      "second",
    ]);
  });

  it("revalidates one query key once however many feeds are mounted", async () => {
    mocks.getGlobalSessions.mockResolvedValue(
      globalSessionsResponse(["session-a"]),
    );

    // The sidebar rail, the Global Sessions page, and the recent-sessions
    // dropdown all mount this key with different row coverage.
    const sidebar = renderHook(() => useFeedWithRecords({ limit: 50 }));
    const page = renderHook(() => useFeedWithRecords({ limit: 100 }));
    const dropdown = renderHook(() => useFeedWithRecords({ limit: 15 }));
    await waitFor(() =>
      expect(sidebar.result.current.feed.loading).toBe(false),
    );
    await waitFor(() => expect(page.result.current.feed.loading).toBe(false));
    await waitFor(() =>
      expect(dropdown.result.current.feed.loading).toBe(false),
    );

    const metrics = getQueryRevalidationMetrics();
    expect(metrics.subscribers).toBe(3);
    // One listener per event (reconnect, visibility restore, catalog
    // publication, and project list changes), shared by all mounts.
    expect(metrics.eventSubscriptions).toBe(4);

    const requestsBefore = mocks.getGlobalSessions.mock.calls.length;
    vi.useFakeTimers();
    await act(async () => {
      activityBus.emitLocal("reconnect", undefined as never);
      await vi.advanceTimersByTimeAsync(600);
    });
    vi.useRealTimers();

    const refetches = mocks.getGlobalSessions.mock.calls.slice(requestsBefore);
    expect(refetches).toHaveLength(1);
    // The widest subscriber runs, so the 15- and 50-row feeds are served by the
    // 100-row refetch instead of issuing their own.
    expect(refetches[0]?.[0]).toMatchObject({ limit: 100 });
  });

  it("refetches when a project is added, removed, or renamed", async () => {
    mocks.getGlobalSessions.mockResolvedValue(
      globalSessionsResponse(["session-a"]),
    );
    const feed = renderHook(() => useFeedWithRecords({ limit: 50 }));
    await waitFor(() => expect(feed.result.current.feed.loading).toBe(false));

    const requestsBefore = mocks.getGlobalSessions.mock.calls.length;
    vi.useFakeTimers();
    await act(async () => {
      activityBus.emitLocal("projects-changed", {
        type: "projects-changed",
        projectIds: ["project-a"],
        timestamp: new Date().toISOString(),
      });
      await vi.advanceTimersByTimeAsync(600);
    });
    vi.useRealTimers();

    expect(
      mocks.getGlobalSessions.mock.calls.slice(requestsBefore),
    ).toHaveLength(1);
  });

  it("returns the query to fresh after a reconnect refetch", async () => {
    mocks.getGlobalSessions.mockResolvedValue(
      globalSessionsResponse(["session-a"]),
    );

    const sidebar = renderHook(() => useFeedWithRecords({ limit: 50 }));
    const page = renderHook(() => useFeedWithRecords({ limit: 100 }));
    await waitFor(() =>
      expect(sidebar.result.current.feed.loading).toBe(false),
    );
    await waitFor(() => expect(page.result.current.feed.loading).toBe(false));

    vi.useFakeTimers();
    await act(async () => {
      activityBus.emitLocal("reconnect", undefined as never);
      await vi.advanceTimersByTimeAsync(600);
    });
    vi.useRealTimers();

    // A query left stale fails every freshness check afterwards, so the
    // 30-second stale time would stop short-circuiting reads for the rest of
    // the session.
    const states = getClientQueryStates().filter(
      (state) => state.fetchedAt !== undefined,
    );
    expect(states.length).toBeGreaterThan(0);
    expect(states.filter((state) => state.stale)).toEqual([]);
  });

  it("revalidates cached rows when the feed becomes active again", async () => {
    mocks.versionInfo.mockReturnValue({
      capabilities: [PROGRESSIVE_SESSION_CATALOG_CAPABILITY],
    });
    mocks.getGlobalSessions
      .mockResolvedValueOnce(
        globalSessionsResponse(["session-a"], { generation: 7 }),
      )
      .mockResolvedValueOnce(
        globalSessionsResponse(["session-b", "session-a"], { generation: 8 }),
      );

    const feed = renderHook(
      ({ enabled }) => useFeedWithRecords({ enabled, limit: 50 }),
      { initialProps: { enabled: true } },
    );
    await waitFor(() => expect(feed.result.current.records).toHaveLength(1));

    feed.rerender({ enabled: false });
    feed.rerender({ enabled: true });

    await waitFor(() =>
      expect(feed.result.current.records.map((record) => record.id)).toEqual([
        "session-b",
        "session-a",
      ]),
    );
    expect(mocks.getGlobalSessions).toHaveBeenCalledTimes(2);
    expect(mocks.getGlobalSessions.mock.calls[1]?.[0]).toMatchObject({
      knownGeneration: 7,
    });
  });

  it("revalidates cached rows when a backgrounded client becomes visible", async () => {
    mocks.getGlobalSessions
      .mockResolvedValueOnce(globalSessionsResponse(["session-a"]))
      .mockResolvedValueOnce(
        globalSessionsResponse(["session-b", "session-a"]),
      );

    const feed = renderHook(() => useFeedWithRecords({ limit: 50 }));
    await waitFor(() => expect(feed.result.current.records).toHaveLength(1));

    vi.useFakeTimers();
    await act(async () => {
      activityBus.emitLocal("refresh", undefined as never);
      await vi.advanceTimersByTimeAsync(600);
    });
    vi.useRealTimers();

    expect(feed.result.current.records.map((record) => record.id)).toEqual([
      "session-b",
      "session-a",
    ]);
    expect(mocks.getGlobalSessions).toHaveBeenCalledTimes(2);
  });
});

/**
 * Tactical 031 step 12's client half. The token is a claim that this client
 * still holds the rows of a generation, so every test here is really about when
 * that claim stops being true.
 */
describe("useGlobalSessionsFeed conditional reads", () => {
  function withProgressiveCatalog(): void {
    mocks.versionInfo.mockReturnValue({
      capabilities: [PROGRESSIVE_SESSION_CATALOG_CAPABILITY],
    });
  }

  async function reconnect(): Promise<void> {
    vi.useFakeTimers();
    await act(async () => {
      activityBus.emitLocal("reconnect", undefined as never);
      await vi.advanceTimersByTimeAsync(600);
    });
    vi.useRealTimers();
  }

  function lastRequest(): Record<string, unknown> | undefined {
    const calls = mocks.getGlobalSessions.mock.calls;
    return calls[calls.length - 1]?.[0] as Record<string, unknown> | undefined;
  }

  it("replays an accepted generation and keeps its rows on no-change", async () => {
    withProgressiveCatalog();
    mocks.getGlobalSessions
      .mockResolvedValueOnce(
        globalSessionsResponse(["session-a"], { generation: 7 }),
      )
      .mockResolvedValueOnce({ unchanged: true, generation: 7 });

    const feed = renderHook(() => useFeedWithRecords());
    await waitFor(() => expect(feed.result.current.feed.loading).toBe(false));
    expect(lastRequest()).not.toHaveProperty("knownGeneration");

    await reconnect();

    expect(mocks.getGlobalSessions).toHaveBeenCalledTimes(2);
    expect(lastRequest()).toMatchObject({ knownGeneration: 7 });
    // The response carried no rows, so the retained ones are the answer.
    expect(feed.result.current.records.map((record) => record.id)).toEqual([
      "session-a",
    ]);
    expect(feed.result.current.feed.projects).toEqual([PROJECT]);
  });

  it("accepts the newer generation when the server answers with rows", async () => {
    withProgressiveCatalog();
    mocks.getGlobalSessions
      .mockResolvedValueOnce(
        globalSessionsResponse(["session-a"], { generation: 7 }),
      )
      .mockResolvedValueOnce(
        globalSessionsResponse(["session-b"], { generation: 8 }),
      )
      .mockResolvedValueOnce({ unchanged: true, generation: 8 });

    const feed = renderHook(() => useFeedWithRecords());
    await waitFor(() => expect(feed.result.current.feed.loading).toBe(false));

    await reconnect();
    expect(lastRequest()).toMatchObject({ knownGeneration: 7 });
    expect(feed.result.current.records.map((record) => record.id)).toEqual([
      "session-b",
    ]);

    await reconnect();
    expect(lastRequest()).toMatchObject({ knownGeneration: 8 });
  });

  it("sends no generation to a server without the capability", async () => {
    mocks.getGlobalSessions.mockResolvedValue(
      // An ungated server does not report one, but a client that ignored the
      // gate would happily replay whatever it was handed.
      globalSessionsResponse(["session-a"], { generation: 7 }),
    );

    const feed = renderHook(() => useFeedWithRecords());
    await waitFor(() => expect(feed.result.current.feed.loading).toBe(false));

    await reconnect();

    expect(mocks.getGlobalSessions).toHaveBeenCalledTimes(2);
    expect(lastRequest()).not.toHaveProperty("knownGeneration");
  });

  it("forgets the generation when a later response omits it", async () => {
    withProgressiveCatalog();
    mocks.getGlobalSessions
      .mockResolvedValueOnce(
        globalSessionsResponse(["session-a"], { generation: 7 }),
      )
      .mockResolvedValueOnce(globalSessionsResponse(["session-a"]))
      .mockResolvedValueOnce(globalSessionsResponse(["session-a"]));

    const feed = renderHook(() => useFeedWithRecords());
    await waitFor(() => expect(feed.result.current.feed.loading).toBe(false));

    await reconnect();
    expect(lastRequest()).toMatchObject({ knownGeneration: 7 });

    await reconnect();
    expect(lastRequest()).not.toHaveProperty("knownGeneration");
  });

  it("asks for rows when a consumer wants more than it holds", async () => {
    withProgressiveCatalog();
    mocks.getGlobalSessions
      .mockResolvedValueOnce(
        globalSessionsResponse(["recent-only"], {
          generation: 7,
          hasMore: true,
        }),
      )
      .mockResolvedValueOnce(
        globalSessionsResponse(["recent-only", "sidebar-extra"], {
          generation: 7,
        }),
      );

    const dropdown = renderHook(() => useFeedWithRecords({ limit: 1 }));
    await waitFor(() =>
      expect(dropdown.result.current.feed.loading).toBe(false),
    );

    // A wider window is a coverage need, and no-change would answer it
    // truthfully while leaving this consumer short of rows forever.
    const sidebar = renderHook(() => useFeedWithRecords({ limit: 50 }));
    await waitFor(() =>
      expect(sidebar.result.current.feed.loading).toBe(false),
    );

    expect(mocks.getGlobalSessions).toHaveBeenCalledTimes(2);
    expect(lastRequest()).not.toHaveProperty("knownGeneration");
    expect(sidebar.result.current.records.map((record) => record.id)).toEqual([
      "recent-only",
      "sidebar-extra",
    ]);
  });

  it("asks for rows on an explicit refetch", async () => {
    withProgressiveCatalog();
    mocks.getGlobalSessions
      .mockResolvedValueOnce(
        globalSessionsResponse(["session-a"], { generation: 7 }),
      )
      .mockResolvedValueOnce(
        globalSessionsResponse(["session-a"], { generation: 7 }),
      );

    const feed = renderHook(() => useFeedWithRecords());
    await waitFor(() => expect(feed.result.current.feed.loading).toBe(false));

    await act(async () => {
      await feed.result.current.feed.refetch();
    });

    expect(mocks.getGlobalSessions).toHaveBeenCalledTimes(2);
    expect(lastRequest()).not.toHaveProperty("knownGeneration");
  });
});
