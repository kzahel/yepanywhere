import { act, cleanup, renderHook } from "@testing-library/react";
import type {
  ProviderRuntimeStatus,
  ProjectQueueItemSummary,
  UrlProjectId,
} from "@yep-anywhere/shared";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GlobalSessionItem, InboxItem } from "../../api/client";

type MockActivityCallback = (event: unknown) => void;

const mockActivityBus = vi.hoisted(() => {
  const listeners = new Map<string, Set<MockActivityCallback>>();
  const on = vi.fn((eventType: string, callback: MockActivityCallback) => {
    let set = listeners.get(eventType);
    if (!set) {
      set = new Set();
      listeners.set(eventType, set);
    }
    set.add(callback);
    return () => {
      set?.delete(callback);
    };
  });
  const onSource = vi.fn(
    (_sourceKey: string, eventType: string, callback: MockActivityCallback) =>
      on(eventType, callback),
  );
  const retainSourceStream = vi.fn(() => () => {});

  return {
    listeners,
    on,
    onSource,
    retainSourceStream,
    emit(eventType: string, event: unknown) {
      for (const callback of listeners.get(eventType) ?? []) {
        callback(event);
      }
    },
    listenerCount() {
      let count = 0;
      for (const set of listeners.values()) {
        count += set.size;
      }
      return count;
    },
  };
});

vi.mock("../activityBus", () => ({
  activityBus: {
    on: mockActivityBus.on,
    onSource: mockActivityBus.onSource,
    retainSourceStream: mockActivityBus.retainSourceStream,
  },
}));

import {
  createClientSummaryHostSourceKey,
  getClientSummarySnapshotForSource,
  LOCAL_CLIENT_SUMMARY_SOURCE_KEY,
  reportGlobalSessionsCollectionSnapshot,
  reportInboxCollectionSnapshot,
  reportProjectsCollectionSnapshot,
  reportProviderRuntimeStatusSnapshot,
  reportSessionCollectionCreated,
  reportSessionCollectionMetadataChanged,
  reportSessionCollectionTitleSnapshot,
  resetClientSummaryStoreForTests,
  setCurrentClientSummarySourceKey,
  subscribeClientSummary,
  useActiveAgentCount,
  useActiveProjectSessionIds,
  useDraftSessionIds,
  useHasActiveAgents,
  useInboxCounts,
  useInboxCountsByProject,
  useInboxResponseSnapshot,
  useProjectQueuedSessionIds,
  useProjectCollectionRecords,
  useProviderRuntimeStatusForSession,
  useRecentSessionRecords,
  useSessionCollectionRecord,
  useSessionNonHumanUserTurn,
  useStarredSessionRecords,
} from "../clientSummaryStore";
import { setCurrentClientSummarySourceKey as setSourceIdentity } from "../clientSummarySourceKey";
import { saveSessionDraft } from "../sessionDraftStorage";
import { createSessionDetailMemoryCache } from "../sessionDetail/sessionDetailStore";
import {
  createSourceRuntimeRegistry,
  type SourceApiClient,
  type YaSourceRuntime,
} from "../sourceRuntime";
import { SourceRuntimeProvider } from "../sourceRuntimeReact";

const PROJECT_ID = "project-1" as UrlProjectId;
const RECENT = "2026-06-27T11:00:00.000Z";
const SOURCE_KEY = LOCAL_CLIENT_SUMMARY_SOURCE_KEY;
const RUNTIME_STATUS: Exclude<ProviderRuntimeStatus, null> = {
  kind: "retrying",
  provider: "claude",
  reason: "rate_limit",
  httpStatus: 429,
  startedAt: RECENT,
  lastSeenAt: RECENT,
  retryAt: "2026-06-27T12:00:00.000Z",
  retryDelayMs: 3_600_000,
  eventCount: 1,
  source: "claude.system.api_retry",
};

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
    projectId: PROJECT_ID,
    projectName: "Project",
    ownership: { owner: "none" },
    isArchived: false,
    isStarred: false,
    ...overrides,
  };
}

function inboxItem(id: string, overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    sessionId: id,
    projectId: PROJECT_ID,
    projectName: "Project",
    sessionTitle: `Session ${id}`,
    updatedAt: RECENT,
    hasUnread: false,
    ...overrides,
  };
}

function queueItem(
  id: string,
  overrides: Partial<ProjectQueueItemSummary> = {},
): ProjectQueueItemSummary {
  return {
    id,
    projectId: PROJECT_ID,
    target: { type: "existing-session", sessionId: `session-${id}` },
    messagePreview: `Message ${id}`,
    message: { text: `Message ${id}` },
    createdAt: RECENT,
    updatedAt: RECENT,
    status: "queued",
    attachmentCount: 0,
    ...overrides,
  };
}

function fakeApiClient(): SourceApiClient {
  return {
    getSession: vi.fn(() => Promise.resolve({} as never)),
    getSessionMetadata: vi.fn(() => Promise.resolve({} as never)),
  };
}

function runtimeWrapper(runtime: YaSourceRuntime) {
  return function RuntimeWrapper({ children }: { children: ReactNode }) {
    return (
      <SourceRuntimeProvider runtime={runtime}>
        {children}
      </SourceRuntimeProvider>
    );
  };
}

beforeEach(() => {
  resetClientSummaryStoreForTests();
  mockActivityBus.listeners.clear();
  mockActivityBus.on.mockClear();
  mockActivityBus.onSource.mockClear();
  mockActivityBus.retainSourceStream.mockClear();
});

afterEach(() => {
  cleanup();
  resetClientSummaryStoreForTests();
  mockActivityBus.listeners.clear();
  mockActivityBus.onSource.mockClear();
  mockActivityBus.retainSourceStream.mockClear();
  localStorage.clear();
  vi.useRealTimers();
});

describe("clientSummaryStore", () => {
  it("moves legacy summary subscriptions when the lightweight source owner switches hosts", () => {
    const oldSource = createClientSummaryHostSourceKey("old-host");
    const newSource = createClientSummaryHostSourceKey("new-host");
    setCurrentClientSummarySourceKey(oldSource);
    const changed = vi.fn();
    const release = subscribeClientSummary(changed);
    try {
      setSourceIdentity(newSource);
      expect(changed).toHaveBeenCalledTimes(1);
      const publish = (source: typeof oldSource) =>
        reportGlobalSessionsCollectionSnapshot(source, {
          query: { scope: "global-sessions", limit: 50 },
          sessions: [globalSession("s")],
          hasMore: false,
        });
      publish(oldSource);
      expect(changed).toHaveBeenCalledTimes(1);
      publish(newSource);
      expect(changed).toHaveBeenCalledTimes(2);
    } finally {
      release();
    }
    expect(mockActivityBus.listenerCount()).toBe(0);
  });

  it("observes delivery decorations without rerendering for freshness clocks or other sources", () => {
    const source = LOCAL_CLIENT_SUMMARY_SOURCE_KEY;
    const renders = vi.fn();
    const { result } = renderHook(() => {
      renders();
      return useSessionNonHumanUserTurn("session-1");
    });
    const count = renders.mock.calls.length;
    const publish = (
      key: typeof source,
      nonHumanUserTurn?: GlobalSessionItem["nonHumanUserTurn"],
    ) =>
      reportGlobalSessionsCollectionSnapshot(key, {
        query: { scope: "global-sessions" },
        sessions: [globalSession("session-1", { nonHumanUserTurn })],
        hasMore: false,
      });
    act(() => {
      publish(source);
      publish(source);
    });
    expect(renders).toHaveBeenCalledTimes(count);
    const turn = {
      messageId: "delivery",
      timestamp: RECENT,
      sourceSessionId: "sender",
    };
    act(() => publish(createClientSummaryHostSourceKey("other"), turn));
    expect(renders).toHaveBeenCalledTimes(count);
    act(() => publish(source, turn));
    expect(result.current).toEqual(turn);
    expect(renders).toHaveBeenCalledTimes(count + 1);
    act(() => publish(source, { ...turn }));
    expect(renders).toHaveBeenCalledTimes(count + 1);
    act(() => publish(source, { ...turn, messageId: "next" }));
    expect(result.current?.messageId).toBe("next");
    expect(renders).toHaveBeenCalledTimes(count + 2);
  });

  it("subscribes to activityBus once while hooks are mounted", () => {
    const first = renderHook(() => useRecentSessionRecords());
    expect(mockActivityBus.onSource).toHaveBeenCalledTimes(9);
    expect(mockActivityBus.listenerCount()).toBe(9);

    const second = renderHook(() => useSessionCollectionRecord("session-1"));
    expect(mockActivityBus.onSource).toHaveBeenCalledTimes(9);
    expect(mockActivityBus.listenerCount()).toBe(9);

    first.unmount();
    expect(mockActivityBus.listenerCount()).toBe(9);

    second.unmount();
    expect(mockActivityBus.listenerCount()).toBe(0);
  });

  it("keeps project subscribers stable across unrelated session activity", () => {
    const renders = vi.fn();
    const projects = renderHook(() => {
      renders();
      return useProjectCollectionRecords();
    });
    act(() =>
      reportProjectsCollectionSnapshot(SOURCE_KEY, {
        projects: [
          {
            id: PROJECT_ID,
            name: "Alpha",
            path: "/alpha",
            sessionCount: 1,
            activeOwnedCount: 0,
            activeExternalCount: 0,
            lastActivity: null,
          },
        ],
      }),
    );
    const before = projects.result.current;
    renders.mockClear();
    act(() =>
      reportProviderRuntimeStatusSnapshot(SOURCE_KEY, {
        sessionId: "session-1",
        projectId: PROJECT_ID,
        providerRuntimeStatus: RUNTIME_STATUS,
      }),
    );
    expect(projects.result.current).toBe(before);
    expect(renders).not.toHaveBeenCalled();
    act(() => reportProjectsCollectionSnapshot(SOURCE_KEY, { projects: [] }));
    expect(projects.result.current).toEqual([]);
  });

  it("stores provider runtime snapshots and clears from activity events", () => {
    const status = renderHook(() =>
      useProviderRuntimeStatusForSession("session-1"),
    );

    expect(status.result.current).toBe(null);

    act(() => {
      reportProviderRuntimeStatusSnapshot(SOURCE_KEY, {
        sessionId: "session-1",
        projectId: PROJECT_ID,
        providerRuntimeStatus: RUNTIME_STATUS,
      });
    });

    expect(status.result.current).toEqual(RUNTIME_STATUS);

    act(() => {
      mockActivityBus.emit("provider-runtime-status-changed", {
        type: "provider-runtime-status-changed",
        sessionId: "session-1",
        projectId: PROJECT_ID,
        providerRuntimeStatus: null,
        timestamp: "2026-06-27T12:00:00.000Z",
      });
    });

    expect(status.result.current).toBe(null);
  });

  it("merges a targeted title snapshot without replacing richer fields", () => {
    act(() => {
      reportGlobalSessionsCollectionSnapshot(
        SOURCE_KEY,
        {
          query: { scope: "global-sessions", limit: 50 },
          sessions: [
            globalSession("session-1", {
              title: "Old title",
              fullTitle: "Old full title",
              messageCount: 42,
              model: "claude-opus-5",
            }),
          ],
          hasMore: false,
        },
        100,
      );
      reportSessionCollectionTitleSnapshot(
        SOURCE_KEY,
        {
          id: "session-1",
          projectId: PROJECT_ID,
          title: "Current title",
          fullTitle: "Current full title",
          customTitle: "Current custom title",
          createdAt: RECENT,
          updatedAt: RECENT,
          messageCount: 0,
          provider: "claude",
        },
        200,
      );
    });

    expect(
      getClientSummarySnapshotForSource(SOURCE_KEY).sessions.entities.get(
        "session-1",
      ),
    ).toMatchObject({
      title: "Current title",
      fullTitle: "Current full title",
      customTitle: "Current custom title",
      messageCount: 42,
      model: "claude-opus-5",
    });
  });

  it("reports snapshots and applies metadata events to projections", () => {
    const starred = renderHook(() => useStarredSessionRecords());
    const recent = renderHook(() =>
      useRecentSessionRecords(Date.parse("2026-06-27T12:00:00.000Z")),
    );

    act(() => {
      reportGlobalSessionsCollectionSnapshot(
        SOURCE_KEY,
        {
          query: { scope: "global-sessions", limit: 50 },
          sessions: [globalSession("session-1")],
          hasMore: false,
        },
        100,
      );
    });

    expect(recent.result.current.map((s) => s.id)).toEqual(["session-1"]);
    expect(starred.result.current).toEqual([]);

    act(() => {
      mockActivityBus.emit("session-metadata-changed", {
        type: "session-metadata-changed",
        sessionId: "session-1",
        starred: true,
        timestamp: "2026-06-27T12:00:01.000Z",
      });
    });

    expect(recent.result.current).toEqual([]);
    expect(starred.result.current.map((s) => s.id)).toEqual(["session-1"]);
  });

  it("merges provisional session rows when the activity bus remaps the ID", () => {
    const temporaryId = "temporary-session";
    const canonicalId = "canonical-session";
    const selected = renderHook(() => useSessionCollectionRecord(temporaryId));
    const recent = renderHook(() =>
      useRecentSessionRecords(Date.parse("2026-06-27T12:00:00.000Z")),
    );

    act(() => {
      reportSessionCollectionCreated(SOURCE_KEY, {
        type: "session-created",
        session: {
          id: temporaryId,
          projectId: PROJECT_ID,
          title: "Claude",
          fullTitle: "Claude",
          createdAt: RECENT,
          updatedAt: RECENT,
          messageCount: 1,
          ownership: { owner: "self", processId: "process-1" },
          provider: "claude",
          activity: "in-turn",
        },
        timestamp: RECENT,
      });
      reportGlobalSessionsCollectionSnapshot(SOURCE_KEY, {
        query: { scope: "global-sessions", limit: 50 },
        sessions: [
          globalSession(canonicalId, {
            title: "Claude Fable",
            model: "claude-fable-5",
          }),
        ],
        hasMore: false,
      });
      mockActivityBus.emit("session-id-remapped", {
        type: "session-id-remapped",
        oldSessionId: temporaryId,
        newSessionId: canonicalId,
        projectId: PROJECT_ID,
        processId: "process-1",
        provider: "claude",
        timestamp: RECENT,
      });
    });

    expect(selected.result.current).toMatchObject({
      id: canonicalId,
      title: "Claude Fable",
      model: "claude-fable-5",
    });
    expect(recent.result.current.map((record) => record.id)).toEqual([
      canonicalId,
    ]);
    expect(
      getClientSummarySnapshotForSource(SOURCE_KEY).sessions.entities.has(
        temporaryId,
      ),
    ).toBe(false);
  });

  it("isolates current-source session data across host switches", () => {
    const macbook = createClientSummaryHostSourceKey("macbook");
    const winnative = createClientSummaryHostSourceKey("winnative");

    act(() => {
      setCurrentClientSummarySourceKey(macbook);
    });

    const recent = renderHook(() =>
      useRecentSessionRecords(Date.parse("2026-06-27T12:00:00.000Z")),
    );

    act(() => {
      reportGlobalSessionsCollectionSnapshot(
        macbook,
        {
          query: { scope: "global-sessions", limit: 50 },
          sessions: [globalSession("mac-session")],
          hasMore: false,
        },
        100,
      );
    });

    expect(recent.result.current.map((s) => s.id)).toEqual(["mac-session"]);

    act(() => {
      setCurrentClientSummarySourceKey(winnative);
    });

    expect(recent.result.current).toEqual([]);

    act(() => {
      setCurrentClientSummarySourceKey(macbook);
    });

    expect(recent.result.current.map((s) => s.id)).toEqual(["mac-session"]);
  });

  it("keeps late source-keyed snapshots out of the visible current source", () => {
    const macbook = createClientSummaryHostSourceKey("macbook");
    const winnative = createClientSummaryHostSourceKey("winnative");

    act(() => {
      setCurrentClientSummarySourceKey(winnative);
    });

    const recent = renderHook(() =>
      useRecentSessionRecords(Date.parse("2026-06-27T12:00:00.000Z")),
    );

    act(() => {
      reportGlobalSessionsCollectionSnapshot(
        macbook,
        {
          query: { scope: "global-sessions", limit: 50 },
          sessions: [globalSession("late-mac-session")],
          hasMore: false,
        },
        100,
      );
    });

    expect(recent.result.current).toEqual([]);

    act(() => {
      reportGlobalSessionsCollectionSnapshot(
        winnative,
        {
          query: { scope: "global-sessions", limit: 50 },
          sessions: [globalSession("win-session")],
          hasMore: false,
        },
        110,
      );
    });

    expect(recent.result.current.map((s) => s.id)).toEqual(["win-session"]);

    act(() => {
      setCurrentClientSummarySourceKey(macbook);
    });

    expect(recent.result.current.map((s) => s.id)).toEqual([
      "late-mac-session",
    ]);
  });

  it("rerenders current-source hooks when the source changes", () => {
    const macbook = createClientSummaryHostSourceKey("macbook");
    const winnative = createClientSummaryHostSourceKey("winnative");

    act(() => {
      setCurrentClientSummarySourceKey(macbook);
      reportGlobalSessionsCollectionSnapshot(
        macbook,
        {
          query: { scope: "global-sessions", limit: 50 },
          sessions: [
            globalSession("session-a", {
              projectName: "Mac Project",
            }),
          ],
          hasMore: false,
        },
        100,
      );
    });

    let renders = 0;
    const selected = renderHook(() => {
      renders += 1;
      return useSessionCollectionRecord("session-a")?.projectName ?? null;
    });

    expect(selected.result.current).toBe("Mac Project");
    const initialRenders = renders;

    act(() => {
      setCurrentClientSummarySourceKey(winnative);
    });

    expect(selected.result.current).toBeNull();
    expect(renders).toBeGreaterThan(initialRenders);
    const afterWinnativeRenders = renders;

    act(() => {
      setCurrentClientSummarySourceKey(macbook);
    });

    expect(selected.result.current).toBe("Mac Project");
    expect(renders).toBeGreaterThan(afterWinnativeRenders);
  });

  it("selects summary records from the mounted source runtime", () => {
    const sourceA = createClientSummaryHostSourceKey("runtime-a");
    const sourceB = createClientSummaryHostSourceKey("runtime-b");
    const registry = createSourceRuntimeRegistry({
      apiClient: fakeApiClient(),
      sessionDetails: { cache: createSessionDetailMemoryCache() },
    });
    const runtimeA = registry.getOrCreateSourceRuntime(sourceA);
    const runtimeB = registry.getOrCreateSourceRuntime(sourceB);

    act(() => {
      setCurrentClientSummarySourceKey(sourceA);
      runtimeA.summary.reportGlobalSessionsCollectionSnapshot(
        {
          query: { scope: "global-sessions", limit: 50 },
          sessions: [
            globalSession("session-a", {
              projectName: "Runtime A",
            }),
          ],
          hasMore: false,
        },
        100,
      );
      runtimeA.summary.reportInboxCollectionSnapshot(
        {
          needsAttention: [
            inboxItem("session-a", {
              pendingInputType: "tool-approval",
              projectName: "Runtime A",
            }),
          ],
          active: [],
          recentActivity: [],
          unread8h: [],
          unread24h: [],
        },
        100,
      );
      runtimeA.summary.reportProjectQueueCollectionSnapshot(
        {
          projectId: PROJECT_ID,
          items: [
            queueItem("a", {
              target: { type: "existing-session", sessionId: "session-a" },
            }),
          ],
        },
        100,
      );
      runtimeA.summary.reportProviderRuntimeStatusSnapshot(
        {
          sessionId: "session-a",
          projectId: PROJECT_ID,
          providerRuntimeStatus: RUNTIME_STATUS,
        },
        100,
      );

      runtimeB.summary.reportGlobalSessionsCollectionSnapshot(
        {
          query: { scope: "global-sessions", limit: 50 },
          sessions: [
            globalSession("session-b", {
              projectName: "Runtime B",
            }),
          ],
          hasMore: false,
        },
        100,
      );
      runtimeB.summary.reportInboxCollectionSnapshot(
        {
          needsAttention: [
            inboxItem("session-b", {
              pendingInputType: "user-question",
              projectName: "Runtime B",
            }),
          ],
          active: [],
          recentActivity: [],
          unread8h: [],
          unread24h: [],
        },
        100,
      );
      runtimeB.summary.reportProjectQueueCollectionSnapshot(
        {
          projectId: PROJECT_ID,
          items: [
            queueItem("b", {
              target: { type: "existing-session", sessionId: "session-b" },
            }),
          ],
        },
        100,
      );
      runtimeB.summary.reportProviderRuntimeStatusSnapshot(
        {
          sessionId: "session-b",
          projectId: PROJECT_ID,
          providerRuntimeStatus: RUNTIME_STATUS,
        },
        100,
      );
    });

    const runtimeARead = renderHook(
      () => ({
        projectName: useSessionCollectionRecord("session-a")?.projectName,
        otherProjectName: useSessionCollectionRecord("session-b")?.projectName,
        inboxIds: useInboxResponseSnapshot().needsAttention.map(
          (item) => item.sessionId,
        ),
        queuedIds: [...useProjectQueuedSessionIds([PROJECT_ID])],
        providerStatus: useProviderRuntimeStatusForSession("session-a"),
      }),
      { wrapper: runtimeWrapper(runtimeA) },
    );
    const runtimeBRead = renderHook(
      () => ({
        projectName: useSessionCollectionRecord("session-b")?.projectName,
        otherProjectName: useSessionCollectionRecord("session-a")?.projectName,
        inboxIds: useInboxResponseSnapshot().needsAttention.map(
          (item) => item.sessionId,
        ),
        queuedIds: [...useProjectQueuedSessionIds([PROJECT_ID])],
        providerStatus: useProviderRuntimeStatusForSession("session-b"),
      }),
      { wrapper: runtimeWrapper(runtimeB) },
    );

    expect(runtimeARead.result.current).toEqual({
      projectName: "Runtime A",
      otherProjectName: undefined,
      inboxIds: ["session-a"],
      queuedIds: ["session-a"],
      providerStatus: RUNTIME_STATUS,
    });
    expect(runtimeBRead.result.current).toEqual({
      projectName: "Runtime B",
      otherProjectName: undefined,
      inboxIds: ["session-b"],
      queuedIds: ["session-b"],
      providerStatus: RUNTIME_STATUS,
    });

    act(() => {
      setCurrentClientSummarySourceKey(sourceB);
    });

    expect(runtimeARead.result.current.projectName).toBe("Runtime A");
    expect(runtimeARead.result.current.inboxIds).toEqual(["session-a"]);
    expect(runtimeBRead.result.current.projectName).toBe("Runtime B");
    expect(runtimeBRead.result.current.inboxIds).toEqual(["session-b"]);
  });

  it("retains activity through the mounted source runtime", () => {
    const sourceA = createClientSummaryHostSourceKey("runtime-activity-a");
    const sourceB = createClientSummaryHostSourceKey("runtime-activity-b");
    const registry = createSourceRuntimeRegistry({
      apiClient: fakeApiClient(),
      sessionDetails: { cache: createSessionDetailMemoryCache() },
    });
    const runtimeA = registry.getOrCreateSourceRuntime(sourceA);

    act(() => {
      setCurrentClientSummarySourceKey(sourceB);
    });

    const selected = renderHook(
      () => useSessionCollectionRecord("runtime-event-session"),
      { wrapper: runtimeWrapper(runtimeA) },
    );
    expect(mockActivityBus.onSource).toHaveBeenCalledTimes(9);
    expect(mockActivityBus.retainSourceStream).toHaveBeenCalledWith(
      sourceA,
      runtimeA.transport,
    );
    expect(mockActivityBus.listenerCount()).toBe(9);

    act(() => {
      mockActivityBus.emit("session-created", {
        type: "session-created",
        session: {
          id: "runtime-event-session",
          projectId: PROJECT_ID,
          title: "Runtime event",
          fullTitle: "Runtime event",
          createdAt: RECENT,
          updatedAt: RECENT,
          messageCount: 1,
          ownership: { owner: "none" },
          provider: "claude",
        },
        timestamp: RECENT,
      });
    });

    expect(selected.result.current?.id).toBe("runtime-event-session");
    expect(
      getClientSummarySnapshotForSource(sourceB).sessions.entities.get(
        "runtime-event-session",
      ),
    ).toBeUndefined();

    selected.unmount();

    expect(mockActivityBus.listenerCount()).toBe(0);
  });

  it("reduces stale activity callbacks into their retained source", () => {
    const macbook = createClientSummaryHostSourceKey("macbook");
    const winnative = createClientSummaryHostSourceKey("winnative");

    act(() => {
      setCurrentClientSummarySourceKey(macbook);
    });

    const selected = renderHook(() =>
      useSessionCollectionRecord("stale-event-session"),
    );
    const staleCreatedCallbacks = [
      ...(mockActivityBus.listeners.get("session-created") ?? []),
    ];
    expect(staleCreatedCallbacks).toHaveLength(1);

    act(() => {
      setCurrentClientSummarySourceKey(winnative);
    });

    act(() => {
      for (const callback of staleCreatedCallbacks) {
        callback({
          type: "session-created",
          session: {
            id: "stale-event-session",
            projectId: PROJECT_ID,
            title: "Stale event",
            fullTitle: "Stale event",
            createdAt: RECENT,
            updatedAt: RECENT,
            messageCount: 1,
            ownership: { owner: "none" },
            provider: "claude",
          },
          timestamp: RECENT,
        });
      }
    });

    expect(selected.result.current).toBeUndefined();

    act(() => {
      setCurrentClientSummarySourceKey(macbook);
    });

    expect(selected.result.current?.id).toBe("stale-event-session");
  });

  it("reports inbox snapshots to React selectors", () => {
    const inbox = renderHook(() => useInboxResponseSnapshot());

    act(() => {
      reportInboxCollectionSnapshot(
        SOURCE_KEY,
        {
          needsAttention: [
            inboxItem("needs", { pendingInputType: "user-question" }),
          ],
          active: [inboxItem("active")],
          recentActivity: [],
          unread8h: [],
          unread24h: [],
        },
        100,
      );
    });

    expect(inbox.result.current.needsAttention).toMatchObject([
      {
        sessionId: "needs",
        pendingInputType: "user-question",
        activity: "waiting-input",
      },
    ]);
    expect(inbox.result.current.active).toMatchObject([
      {
        sessionId: "active",
      },
    ]);
    expect(inbox.result.current.active[0]?.activity).toBeUndefined();
  });

  it("reports inbox snapshots to targeted count selectors", () => {
    const counts = renderHook(() => useInboxCounts());
    const byProject = renderHook(() => useInboxCountsByProject());
    const activeIds = renderHook(() => useActiveProjectSessionIds(PROJECT_ID));
    const activeCount = renderHook(() => useActiveAgentCount());
    const hasActive = renderHook(() => useHasActiveAgents());

    act(() => {
      reportInboxCollectionSnapshot(
        SOURCE_KEY,
        {
          needsAttention: [
            inboxItem("needs", { pendingInputType: "tool-approval" }),
          ],
          active: [inboxItem("active")],
          recentActivity: [inboxItem("recent")],
          unread8h: [],
          unread24h: [],
        },
        100,
      );
    });

    expect(counts.result.current).toEqual({
      needsAttention: 1,
      active: 1,
      total: 3,
    });
    expect(byProject.result.current.get(PROJECT_ID)).toEqual({
      needsAttention: 1,
      active: 1,
      total: 3,
    });
    expect(activeIds.result.current).toEqual(["needs", "active"]);
    expect(activeCount.result.current).toBe(1);
    expect(hasActive.result.current).toBe(true);
  });

  it("reports local metadata changes to derived projections", () => {
    const starred = renderHook(() => useStarredSessionRecords());
    const recent = renderHook(() =>
      useRecentSessionRecords(Date.parse("2026-06-27T12:00:00.000Z")),
    );

    act(() => {
      reportGlobalSessionsCollectionSnapshot(
        SOURCE_KEY,
        {
          query: { scope: "global-sessions", limit: 50 },
          sessions: [globalSession("session-1")],
          hasMore: false,
        },
        100,
      );
    });

    act(() => {
      reportSessionCollectionMetadataChanged(
        SOURCE_KEY,
        {
          type: "session-metadata-changed",
          sessionId: "session-1",
          starred: true,
          timestamp: "2026-06-27T12:00:01.000Z",
        },
        200,
      );
    });

    expect(recent.result.current).toEqual([]);
    expect(starred.result.current.map((s) => s.id)).toEqual(["session-1"]);
  });

  it("keeps locally created sessions through older empty snapshots", () => {
    const recent = renderHook(() =>
      useRecentSessionRecords(Date.parse("2026-06-27T12:00:00.000Z")),
    );

    act(() => {
      reportSessionCollectionCreated(
        SOURCE_KEY,
        {
          type: "session-created",
          session: {
            id: "new-session",
            projectId: PROJECT_ID,
            title: null,
            fullTitle: null,
            createdAt: RECENT,
            updatedAt: RECENT,
            messageCount: 0,
            ownership: { owner: "self", processId: "process-1" },
            provider: "claude",
            activity: "in-turn",
          },
          timestamp: RECENT,
        },
        200,
      );
    });

    expect(recent.result.current.map((s) => s.id)).toEqual(["new-session"]);

    act(() => {
      reportGlobalSessionsCollectionSnapshot(
        SOURCE_KEY,
        {
          query: { scope: "global-sessions", limit: 50 },
          sessions: [],
          hasMore: false,
          mode: "replace",
        },
        100,
      );
    });

    expect(recent.result.current.map((s) => s.id)).toEqual(["new-session"]);
  });

  it("preserves unchanged record objects after unrelated updates", () => {
    act(() => {
      reportGlobalSessionsCollectionSnapshot(
        SOURCE_KEY,
        {
          query: { scope: "global-sessions", limit: 50 },
          sessions: [globalSession("session-a"), globalSession("session-b")],
          hasMore: false,
        },
        100,
      );
    });

    const before =
      getClientSummarySnapshotForSource(SOURCE_KEY).sessions.entities.get(
        "session-a",
      );
    expect(before).toBeDefined();

    act(() => {
      reportSessionCollectionMetadataChanged(
        SOURCE_KEY,
        {
          type: "session-metadata-changed",
          sessionId: "session-b",
          starred: true,
          timestamp: "2026-06-27T12:00:01.000Z",
        },
        200,
      );
    });

    const after = getClientSummarySnapshotForSource(SOURCE_KEY);
    expect(after.sessions.entities.get("session-a")).toBe(before);
  });

  it("does not rerender selected record hooks for unrelated record updates", () => {
    act(() => {
      reportGlobalSessionsCollectionSnapshot(
        SOURCE_KEY,
        {
          query: { scope: "global-sessions", limit: 50 },
          sessions: [globalSession("session-a"), globalSession("session-b")],
          hasMore: false,
        },
        100,
      );
    });

    let renders = 0;
    const selected = renderHook(() => {
      renders += 1;
      return useSessionCollectionRecord("session-a");
    });
    const before = selected.result.current;

    act(() => {
      reportSessionCollectionMetadataChanged(
        SOURCE_KEY,
        {
          type: "session-metadata-changed",
          sessionId: "session-b",
          starred: true,
          timestamp: "2026-06-27T12:00:01.000Z",
        },
        200,
      );
    });

    expect(selected.result.current).toBe(before);
    expect(renders).toBe(1);
  });

  it("applies project queue events to targeted session selectors", () => {
    const selected = renderHook(() => useProjectQueuedSessionIds([PROJECT_ID]));
    expect([...selected.result.current]).toEqual([]);

    act(() => {
      mockActivityBus.emit("project-queue-changed", {
        type: "project-queue-changed",
        projectId: PROJECT_ID,
        items: [
          queueItem("queue-1", {
            target: { type: "existing-session", sessionId: "session-a" },
          }),
        ],
        reason: "created",
        timestamp: "2026-06-27T12:00:01.000Z",
      });
    });

    expect([...selected.result.current]).toEqual(["session-a"]);
  });

  it("applies owned draft presence events only while decorations are mounted", () => {
    localStorage.clear();
    saveSessionDraft(
      {
        sourceKey: LOCAL_CLIENT_SUMMARY_SOURCE_KEY,
        sessionId: "session-a",
      },
      "draft text",
    );

    const selected = renderHook(() => useDraftSessionIds());

    expect([...selected.result.current]).toEqual(["session-a"]);

    act(() => {
      saveSessionDraft(
        {
          sourceKey: LOCAL_CLIENT_SUMMARY_SOURCE_KEY,
          sessionId: "session-b",
        },
        "more draft text",
      );
    });

    expect([...selected.result.current]).toEqual(["session-a", "session-b"]);

    selected.unmount();

    act(() => {
      saveSessionDraft(
        {
          sourceKey: LOCAL_CLIENT_SUMMARY_SOURCE_KEY,
          sessionId: "session-c",
        },
        "stale after unmount",
      );
    });

    const snapshot = getClientSummarySnapshotForSource(SOURCE_KEY);
    expect([...snapshot.localDecorations.draftSessionIds]).toEqual([
      "session-a",
      "session-b",
    ]);
  });

  it("keeps legacy local draft ids out of remote sources", () => {
    vi.useFakeTimers();
    localStorage.clear();
    localStorage.setItem("draft-message-session-a", "draft text");
    const macbook = createClientSummaryHostSourceKey("macbook");

    let renders = 0;
    const selected = renderHook(() => {
      renders += 1;
      return useDraftSessionIds();
    });

    expect([...selected.result.current]).toEqual(["session-a"]);
    const initialRenders = renders;

    act(() => {
      setCurrentClientSummarySourceKey(macbook);
    });

    expect([...selected.result.current]).toEqual([]);
    expect(renders).toBeGreaterThan(initialRenders);
    const afterMacbookRenders = renders;

    act(() => {
      localStorage.setItem("draft-message-session-b", "remote should ignore");
    });

    expect([...selected.result.current]).toEqual([]);

    act(() => {
      setCurrentClientSummarySourceKey(LOCAL_CLIENT_SUMMARY_SOURCE_KEY);
    });

    expect([...selected.result.current]).toEqual(["session-a", "session-b"]);
    expect(renders).toBeGreaterThan(afterMacbookRenders);
  });

  it("preserves indexed source-keyed remote draft storage", () => {
    vi.useFakeTimers();
    localStorage.clear();
    localStorage.setItem("draft-message-local-session", "local draft");
    const macbook = createClientSummaryHostSourceKey("macbook");

    act(() => {
      saveSessionDraft(
        { sourceKey: macbook, sessionId: "remote-session" },
        "remote draft",
      );
      setCurrentClientSummarySourceKey(macbook);
    });

    const selected = renderHook(() => useDraftSessionIds());

    expect([...selected.result.current]).toEqual(["remote-session"]);

    act(() => {
      localStorage.setItem("draft-message-other-session", "local only");
      vi.advanceTimersByTime(1000);
    });

    expect([...selected.result.current]).toEqual(["remote-session"]);
  });

  it("loads indexed remote draft ids for the current source", () => {
    vi.useFakeTimers();
    localStorage.clear();
    const macbook = createClientSummaryHostSourceKey("macbook");
    const winnative = createClientSummaryHostSourceKey("winnative");

    saveSessionDraft(
      { sourceKey: macbook, sessionId: "mac-draft-session" },
      "mac draft",
    );
    saveSessionDraft(
      { sourceKey: winnative, sessionId: "win-draft-session" },
      "win draft",
    );

    act(() => {
      setCurrentClientSummarySourceKey(macbook);
    });

    const selected = renderHook(() => useDraftSessionIds());

    expect([...selected.result.current]).toEqual(["mac-draft-session"]);

    act(() => {
      setCurrentClientSummarySourceKey(winnative);
    });

    expect([...selected.result.current]).toEqual(["win-draft-session"]);
  });

  it("scans draft decorations through mounted source runtimes", () => {
    vi.useFakeTimers();
    localStorage.clear();
    const sourceA = createClientSummaryHostSourceKey("draft-runtime-a");
    const sourceB = createClientSummaryHostSourceKey("draft-runtime-b");
    const registry = createSourceRuntimeRegistry({
      apiClient: fakeApiClient(),
      sessionDetails: { cache: createSessionDetailMemoryCache() },
    });
    const runtimeA = registry.getOrCreateSourceRuntime(sourceA);
    const runtimeB = registry.getOrCreateSourceRuntime(sourceB);

    saveSessionDraft(
      { sourceKey: sourceA, sessionId: "draft-session-a" },
      "draft A",
    );
    saveSessionDraft(
      { sourceKey: sourceB, sessionId: "draft-session-b" },
      "draft B",
    );

    act(() => {
      setCurrentClientSummarySourceKey(LOCAL_CLIENT_SUMMARY_SOURCE_KEY);
    });

    const selectedA = renderHook(() => useDraftSessionIds(), {
      wrapper: runtimeWrapper(runtimeA),
    });
    const selectedB = renderHook(() => useDraftSessionIds(), {
      wrapper: runtimeWrapper(runtimeB),
    });

    expect([...selectedA.result.current]).toEqual(["draft-session-a"]);
    expect([...selectedB.result.current]).toEqual(["draft-session-b"]);
    expect(vi.getTimerCount()).toBe(0);

    selectedA.unmount();

    expect(vi.getTimerCount()).toBe(0);

    act(() => {
      saveSessionDraft(
        { sourceKey: sourceB, sessionId: "draft-session-b-later" },
        "later draft B",
      );
    });

    expect([...selectedB.result.current]).toEqual([
      "draft-session-b",
      "draft-session-b-later",
    ]);
    expect([
      ...getClientSummarySnapshotForSource(sourceA).localDecorations
        .draftSessionIds,
    ]).toEqual(["draft-session-a"]);

    selectedB.unmount();

    expect(vi.getTimerCount()).toBe(0);
  });
});
