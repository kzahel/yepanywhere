import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { toUrlProjectId } from "@yep-anywhere/shared";
import type { ReactNode } from "react";
import {
  type Mock,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  __resetSessionLoadCacheForTest,
  useSessionMessages,
} from "../useSessionMessages";
import { __resetDeveloperModeForTest } from "../useDeveloperMode";
import {
  asClientSummarySourceKey,
  type ClientSummarySourceKey,
  createClientSummaryHostSourceKey,
  LOCAL_CLIENT_SUMMARY_SOURCE_KEY,
  resetClientSummaryStoreForTests,
  setCurrentClientSummarySourceKey,
} from "../../lib/clientSummaryStore";
import { SourceRuntimeProvider } from "../../contexts/SourceRuntimeContext";
import {
  selectSessionDetailAgentContent,
  selectSessionDetailMessages,
  selectSessionDetailToolUseToAgentEntries,
} from "../../lib/sessionDetail/selectors";
import {
  configureSessionDetailRetention,
  createSessionDetailMemoryCache,
  defaultSessionDetailMemoryCache,
  getSessionDetailRetentionDefaults,
} from "../../lib/sessionDetail/sessionDetailStore";
import { invalidateLocalStorageValues } from "../../lib/localStorageValue";
import type {
  GetSessionResult,
  SourceSummaryRuntime,
  YaSourceRuntime,
} from "../../lib/sourceRuntime";
import { FakeSourceTransport } from "../../lib/transport";
import { UI_KEYS } from "../../lib/storageKeys";
import type { SessionRouteScrollSnapshot } from "../../lib/sessionRouteSnapshots";
import {
  createSessionScrollMemoryStorageKey,
  readSessionScrollMemory,
  writeSessionScrollMemory,
} from "../../lib/sessionScrollMemoryStorage";
import type { Message, SessionMetadata } from "../../types";

const apiMocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getSessionMetadata: vi.fn(),
}));

const DEFAULT_SESSION_DETAIL_RETENTION = getSessionDetailRetentionDefaults();
const DEFAULT_INITIAL_TAIL_TURNS = 20;

vi.mock("../../api/client", () => ({
  api: apiMocks,
}));

vi.mock("../useStreamingEnabled", () => ({
  getStreamingEnabled: vi.fn(() => true),
}));

import { getStreamingEnabled } from "../useStreamingEnabled";

function enableSessionTranscriptCache() {
  window.localStorage.setItem(UI_KEYS.sessionTranscriptCache, "true");
  invalidateLocalStorageValues(UI_KEYS.sessionTranscriptCache);
}

function scrollSnapshot(): SessionRouteScrollSnapshot {
  return {
    atBottom: false,
    scrollTop: 120,
    scrollHeight: 480,
    clientHeight: 240,
    anchor: {
      id: "msg-1",
      topOffset: 16,
    },
    updatedAtMs: 42,
  };
}

function deviceScrollSnapshot(
  id: string,
  timestampMs: number,
  following = false,
): SessionRouteScrollSnapshot {
  return {
    atBottom: following,
    scrollTop: timestampMs,
    scrollHeight: 1000,
    clientHeight: 500,
    anchor: { id: `answer-${id}`, topOffset: 10, timestampMs },
    completedTurn: { id, timestampMs },
    following,
    updatedAtMs: timestampMs,
  };
}

function sessionResponse(messageId: string): GetSessionResult {
  const ownership = { owner: "self" as const, processId: "pid-test" };
  return {
    session: {
      id: "sess-1",
      projectId: toUrlProjectId("/projects/proj-1"),
      title: null,
      fullTitle: null,
      createdAt: "2026-05-04T00:00:00.000Z",
      provider: "claude",
      messageCount: 1,
      ownership,
      updatedAt: "2026-05-04T00:00:00.000Z",
    },
    messages: [
      {
        uuid: messageId,
        type: "assistant",
        timestamp: "2026-05-04T00:00:00.000Z",
        message: { role: "assistant", content: messageId },
      },
    ],
    transcriptSnapshotUpdatedAt: "2026-05-04T00:00:00.000Z",
    ownership,
    pendingInputRequest: null,
    slashCommands: null,
    pagination: {
      hasOlderMessages: false,
      totalMessageCount: 1,
      returnedMessageCount: 1,
      totalCompactions: 0,
    },
  };
}

function activeWindowSessionResponse(turnCount: number): GetSessionResult {
  const response = sessionResponse("seed");
  const messages = Array.from(
    { length: turnCount },
    (_, index): Message => ({
      uuid: `user-${index}`,
      type: "user",
      timestamp: "2020-01-01T00:00:00.000Z",
      message: { role: "user", content: `request ${index}` },
    }),
  );
  return {
    ...response,
    session: { ...response.session, messageCount: turnCount },
    messages,
    pagination: {
      hasOlderMessages: false,
      totalMessageCount: turnCount,
      returnedMessageCount: turnCount,
      totalCompactions: 0,
      totalUserTurns: turnCount,
    },
  };
}

function fakeSummaryRuntime(
  sourceKey: ClientSummarySourceKey,
): SourceSummaryRuntime {
  return {
    sourceKey,
    getStore: vi.fn(() => undefined as never),
    getSnapshot: vi.fn(() => undefined as never),
    clear: vi.fn(),
    retainActivitySubscription: vi.fn(() => vi.fn()),
    retainDraftDecorations: vi.fn(() => vi.fn()),
    reportGlobalSessionsCollectionSnapshot: vi.fn(),
    reportInboxCollectionSnapshot: vi.fn(),
    reportProjectsCollectionSnapshot: vi.fn(),
    reportProjectCollectionSnapshot: vi.fn(),
    reportProjectQueueCollectionSnapshot: vi.fn(),
    reportProjectQueueGlobalCollectionSnapshot: vi.fn(),
    reportProviderRuntimeStatusSnapshot: vi.fn(),
    reportSessionCollectionCreated: vi.fn(),
    reportSessionCollectionMetadataChanged: vi.fn(),
  };
}

function fakeRuntime(sourceKey: string, messageId: string): YaSourceRuntime {
  const runtimeSourceKey = asClientSummarySourceKey(sourceKey);
  return {
    sourceKey: runtimeSourceKey,
    transport: new FakeSourceTransport(),
    api: {
      getSession: vi.fn(async () => sessionResponse(messageId)),
      getSessionMetadata: vi.fn(),
    },
    summary: fakeSummaryRuntime(runtimeSourceKey),
    sessionDetails: {
      cache: createSessionDetailMemoryCache(),
    },
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

function defaultStoreEntryKey(projectId = "proj-1", sessionId = "sess-1") {
  return {
    sourceKey: LOCAL_CLIENT_SUMMARY_SOURCE_KEY,
    projectId,
    sessionId,
    initialHistoryCompactions: 2,
    tailTurns: DEFAULT_INITIAL_TAIL_TURNS,
  };
}

function runtimeStoreEntryKey(
  runtime: YaSourceRuntime,
  projectId = "proj-1",
  sessionId = "sess-1",
) {
  return {
    sourceKey: runtime.sourceKey,
    projectId,
    sessionId,
    initialHistoryCompactions: 2,
    tailTurns: DEFAULT_INITIAL_TAIL_TURNS,
  };
}

function defaultInitialTailRequest(extra: Record<string, unknown> = {}) {
  return expect.objectContaining({
    tailCompactions: 2,
    tailTurns: DEFAULT_INITIAL_TAIL_TURNS,
    ...extra,
  });
}

function readStoreMessageIds(
  projectId = "proj-1",
  sessionId = "sess-1",
): string[] | undefined {
  return defaultSessionDetailMemoryCache
    .readSelected(
      defaultStoreEntryKey(projectId, sessionId),
      selectSessionDetailMessages,
    )
    ?.map((message) => message.uuid)
    .filter((uuid): uuid is string => typeof uuid === "string");
}

function readRuntimeMessageIds(
  runtime: YaSourceRuntime,
  projectId = "proj-1",
  sessionId = "sess-1",
): string[] | undefined {
  return runtime.sessionDetails.cache
    .readSelected(
      runtimeStoreEntryKey(runtime, projectId, sessionId),
      selectSessionDetailMessages,
    )
    ?.map((message) => message.uuid)
    .filter((uuid): uuid is string => typeof uuid === "string");
}

function readStoreAgentContent(projectId = "proj-1", sessionId = "sess-1") {
  return defaultSessionDetailMemoryCache.readSelected(
    defaultStoreEntryKey(projectId, sessionId),
    selectSessionDetailAgentContent,
  );
}

function readStoreToolUseToAgent(projectId = "proj-1", sessionId = "sess-1") {
  const entries = defaultSessionDetailMemoryCache.readSelected(
    defaultStoreEntryKey(projectId, sessionId),
    selectSessionDetailToolUseToAgentEntries,
  );
  return entries ? new Map(entries) : undefined;
}

function reactCrossUpdateErrorCalls(error: {
  mock: { calls: Array<readonly unknown[]> };
}) {
  return error.mock.calls.filter(
    ([message]) =>
      typeof message === "string" &&
      message.includes("Cannot update a component"),
  );
}

describe("useSessionMessages cache", () => {
  beforeEach(() => {
    window.localStorage.clear();
    __resetDeveloperModeForTest();
    configureSessionDetailRetention(DEFAULT_SESSION_DETAIL_RETENTION);
    resetClientSummaryStoreForTests();
    __resetSessionLoadCacheForTest();
    (getStreamingEnabled as Mock).mockReturnValue(true);
  });

  afterEach(() => {
    // Unmount before resetting shared stores: this afterEach runs before
    // testing-library's auto-cleanup (vitest afterEach hooks are LIFO), and
    // resetting a store a still-mounted hook subscribes to is a state update
    // outside act().
    cleanup();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    window.localStorage.clear();
    __resetDeveloperModeForTest();
    configureSessionDetailRetention(DEFAULT_SESSION_DETAIL_RETENTION);
    __resetSessionLoadCacheForTest();
    resetClientSummaryStoreForTests();
  });

  it("uses the configured bounded initial compact history", async () => {
    window.localStorage.setItem(UI_KEYS.sessionInitialHistoryCompactions, "12");
    invalidateLocalStorageValues(UI_KEYS.sessionInitialHistoryCompactions);
    apiMocks.getSession.mockResolvedValueOnce(sessionResponse("msg-1"));

    const rendered = renderHook(() =>
      useSessionMessages({ projectId: "proj-1", sessionId: "sess-1" }),
    );
    await waitFor(() => expect(rendered.result.current.loading).toBe(false));

    expect(apiMocks.getSession).toHaveBeenCalledWith(
      "proj-1",
      "sess-1",
      undefined,
      expect.objectContaining({
        tailCompactions: 12,
        tailTurns: undefined,
      }),
    );
  });

  it("uses an explicit full-history request for unlimited initial history", async () => {
    window.localStorage.setItem(
      UI_KEYS.sessionInitialHistoryCompactions,
      "unlimited",
    );
    invalidateLocalStorageValues(UI_KEYS.sessionInitialHistoryCompactions);
    apiMocks.getSession.mockResolvedValueOnce(sessionResponse("msg-1"));

    const rendered = renderHook(() =>
      useSessionMessages({ projectId: "proj-1", sessionId: "sess-1" }),
    );
    await waitFor(() => expect(rendered.result.current.loading).toBe(false));

    expect(apiMocks.getSession).toHaveBeenCalledWith(
      "proj-1",
      "sess-1",
      undefined,
      {
        fullHistory: true,
        fullHistoryReason: "browser initial history preference",
      },
    );
  });

  it("replaces a warm Codex transcript for anchorless Unlimited history", async () => {
    enableSessionTranscriptCache();
    window.localStorage.setItem(
      UI_KEYS.sessionInitialHistoryCompactions,
      "unlimited",
    );
    invalidateLocalStorageValues(UI_KEYS.sessionInitialHistoryCompactions);
    const codexHistory = (messageIds: [string, string]): GetSessionResult => {
      const response = sessionResponse(messageIds[0]);
      return {
        ...response,
        session: { ...response.session, provider: "codex", messageCount: 2 },
        messages: [
          {
            uuid: messageIds[0],
            type: "user",
            timestamp: "2026-05-04T00:00:00.000Z",
            message: { role: "user", content: "same user turn" },
          },
          {
            uuid: messageIds[1],
            type: "assistant",
            timestamp: "2026-05-04T00:01:00.000Z",
            message: { role: "assistant", content: "same response" },
          },
        ],
        pagination: undefined,
      };
    };
    apiMocks.getSession
      .mockResolvedValueOnce(codexHistory(["codex-0-old", "codex-1-old"]))
      .mockResolvedValueOnce(
        codexHistory(["codex-byte-100-new", "codex-byte-200-new"]),
      );

    const first = renderHook(() =>
      useSessionMessages({
        projectId: "proj-1",
        sessionId: "sess-1",
      }),
    );
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    first.unmount();

    const second = renderHook(() =>
      useSessionMessages({
        projectId: "proj-1",
        sessionId: "sess-1",
      }),
    );
    await waitFor(() => expect(second.result.current.loading).toBe(false));

    expect(apiMocks.getSession).toHaveBeenNthCalledWith(
      2,
      "proj-1",
      "sess-1",
      undefined,
      {
        fullHistory: true,
        fullHistoryReason: "browser initial history preference",
      },
    );
    expect(
      second.result.current.messages.map((message) => message.uuid),
    ).toEqual(["codex-byte-100-new", "codex-byte-200-new"]);
  });

  it("enables active-window trimming by default while following the tail", async () => {
    apiMocks.getSession.mockResolvedValueOnce(activeWindowSessionResponse(31));
    const rendered = renderHook(() =>
      useSessionMessages({
        projectId: "proj-1",
        sessionId: "sess-1",
      }),
    );

    await waitFor(() => expect(rendered.result.current.loading).toBe(false));
    expect(rendered.result.current.messages).toHaveLength(31);

    act(() => {
      rendered.result.current.updateActiveWindowFollowingBottom(true);
    });

    await waitFor(() =>
      expect(rendered.result.current.messages).toHaveLength(20),
    );
    expect(rendered.result.current.messages[0]?.uuid).toBe("user-11");
    expect(rendered.result.current.activeWindowTrimRevision).toBe(1);
  });

  it("honors an explicit active-window trim opt-out", async () => {
    apiMocks.getSession.mockResolvedValueOnce(activeWindowSessionResponse(31));
    const rendered = renderHook(() =>
      useSessionMessages({
        projectId: "proj-1",
        sessionId: "sess-1",
      }),
    );

    await waitFor(() => expect(rendered.result.current.loading).toBe(false));
    window.localStorage.setItem(UI_KEYS.sessionActiveWindowTrim, "false");
    invalidateLocalStorageValues(UI_KEYS.sessionActiveWindowTrim);
    act(() => {
      rendered.result.current.updateActiveWindowFollowingBottom(true);
    });

    expect(rendered.result.current.messages).toHaveLength(31);
    expect(rendered.result.current.activeWindowTrimRevision).toBe(0);

    window.localStorage.setItem(UI_KEYS.sessionActiveWindowTrim, "true");
    invalidateLocalStorageValues(UI_KEYS.sessionActiveWindowTrim);
    act(() => {
      rendered.result.current.handleStreamMessageEvent({
        uuid: "user-31",
        type: "user",
        timestamp: "2020-01-01T00:00:00.000Z",
        message: { role: "user", content: "request 31" },
      });
    });

    await waitFor(() =>
      expect(rendered.result.current.messages).toHaveLength(20),
    );
    expect(rendered.result.current.messages[0]?.uuid).toBe("user-12");
    expect(rendered.result.current.activeWindowTrimRevision).toBe(1);
  });

  it("hydrates retained session snapshots after an initial loading state", async () => {
    enableSessionTranscriptCache();

    apiMocks.getSession.mockResolvedValueOnce({
      session: {
        provider: "claude",
        updatedAt: "2026-05-04T00:00:00.000Z",
      },
      messages: [
        {
          uuid: "msg-1",
          type: "user",
          timestamp: "2026-05-04T00:00:00.000Z",
          message: { role: "user", content: "hello" },
        },
      ],
      ownership: { owner: "self" },
      pendingInputRequest: null,
      slashCommands: null,
      pagination: {
        hasOlderMessages: false,
        totalMessageCount: 1,
        returnedMessageCount: 1,
        totalCompactions: 0,
      },
    });
    apiMocks.getSession.mockResolvedValueOnce({
      session: {
        provider: "claude",
        updatedAt: "2026-05-04T00:01:00.000Z",
      },
      messages: [
        {
          uuid: "msg-1",
          type: "user",
          timestamp: "2026-05-04T00:00:00.000Z",
          message: { role: "user", content: "hello" },
        },
        {
          uuid: "msg-2",
          type: "assistant",
          timestamp: "2026-05-04T00:01:00.000Z",
          message: { role: "assistant", content: "hi" },
        },
      ],
      ownership: { owner: "self" },
      pendingInputRequest: null,
      slashCommands: null,
      pagination: {
        hasOlderMessages: false,
        totalMessageCount: 2,
        returnedMessageCount: 2,
        totalCompactions: 0,
      },
    });

    const first = renderHook(() =>
      useSessionMessages({
        projectId: "proj-1",
        sessionId: "sess-1",
      }),
    );

    await waitFor(() => expect(first.result.current.loading).toBe(false));
    expect(first.result.current.restoredFromSnapshot).toBe(false);
    first.unmount();

    const second = renderHook(() =>
      useSessionMessages({
        projectId: "proj-1",
        sessionId: "sess-1",
      }),
    );

    expect(second.result.current.loading).toBe(true);
    expect(second.result.current.messages).toEqual([]);
    expect(second.result.current.restoredFromSnapshot).toBe(true);
    await waitFor(() => expect(apiMocks.getSession).toHaveBeenCalledTimes(2));
    expect(apiMocks.getSession).toHaveBeenNthCalledWith(
      2,
      "proj-1",
      "sess-1",
      "msg-1",
      defaultInitialTailRequest(),
    );
    await waitFor(() => expect(second.result.current.loading).toBe(false));
    expect(
      second.result.current.messages.map((message) => message.uuid),
    ).toEqual(["msg-1", "msg-2"]);
    expect(readStoreMessageIds()).toEqual(["msg-1", "msg-2"]);
  });

  it("isolates session detail API calls and caches by runtime", async () => {
    const firstRuntime = fakeRuntime("host:first", "msg-first");
    const secondRuntime = fakeRuntime("host:second", "msg-second");

    const first = renderHook(
      () =>
        useSessionMessages({
          projectId: "proj-1",
          sessionId: "sess-1",
        }),
      { wrapper: runtimeWrapper(firstRuntime) },
    );
    const second = renderHook(
      () =>
        useSessionMessages({
          projectId: "proj-1",
          sessionId: "sess-1",
        }),
      { wrapper: runtimeWrapper(secondRuntime) },
    );

    await waitFor(() => {
      expect(first.result.current.loading).toBe(false);
      expect(second.result.current.loading).toBe(false);
    });

    expect(firstRuntime.api.getSession).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj-1",
        sessionId: "sess-1",
        tailCompactions: 2,
        tailTurns: DEFAULT_INITIAL_TAIL_TURNS,
      }),
    );
    expect(secondRuntime.api.getSession).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj-1",
        sessionId: "sess-1",
        tailCompactions: 2,
        tailTurns: DEFAULT_INITIAL_TAIL_TURNS,
      }),
    );
    expect(
      first.result.current.messages.map((message) => message.uuid),
    ).toEqual(["msg-first"]);
    expect(
      second.result.current.messages.map((message) => message.uuid),
    ).toEqual(["msg-second"]);
    expect(readRuntimeMessageIds(firstRuntime)).toEqual(["msg-first"]);
    expect(readRuntimeMessageIds(secondRuntime)).toEqual(["msg-second"]);
    expect(
      firstRuntime.sessionDetails.cache.readSelected(
        runtimeStoreEntryKey(secondRuntime),
        selectSessionDetailMessages,
      ),
    ).toBeUndefined();
  });

  it("keeps initial messages visible when cache admission rejects an over-budget reveal", async () => {
    enableSessionTranscriptCache();
    configureSessionDetailRetention({
      ...DEFAULT_SESSION_DETAIL_RETENTION,
      maxBytes: 1,
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    apiMocks.getSession.mockResolvedValueOnce({
      session: {
        provider: "claude",
        updatedAt: "2026-05-04T00:00:00.000Z",
      },
      messages: [
        {
          uuid: "msg-1",
          type: "user",
          timestamp: "2026-05-04T00:00:00.000Z",
          message: { role: "user", content: "hello" },
        },
      ],
      ownership: { owner: "self" },
      pendingInputRequest: null,
      slashCommands: null,
      pagination: {
        hasOlderMessages: false,
        totalMessageCount: 1,
        returnedMessageCount: 1,
        totalCompactions: 0,
      },
    });

    try {
      const rendered = renderHook(() =>
        useSessionMessages({
          projectId: "proj-1",
          sessionId: "sess-1",
        }),
      );

      await waitFor(() => expect(rendered.result.current.loading).toBe(false));
      expect(
        rendered.result.current.messages.map((message) => message.uuid),
      ).toEqual(["msg-1"]);
      expect(readStoreMessageIds()).toEqual(["msg-1"]);
      expect(
        defaultSessionDetailMemoryCache.getStats().retainedEntryCount,
      ).toBe(1);
      expect(
        warn.mock.calls.some(([label, payload]) => {
          if (label !== "[SessionDetailStore]") return false;
          if (
            typeof payload !== "object" ||
            payload === null ||
            !("event" in payload)
          ) {
            return false;
          }
          return (
            (payload as Record<string, unknown>).event ===
            "session-detail-store-missing-after-reveal"
          );
        }),
      ).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps store-backed warm messages gated until hydration", async () => {
    enableSessionTranscriptCache();

    apiMocks.getSession.mockResolvedValueOnce({
      session: {
        provider: "claude",
        updatedAt: "2026-05-04T00:00:00.000Z",
      },
      messages: [
        {
          uuid: "msg-1",
          type: "user",
          timestamp: "2026-05-04T00:00:00.000Z",
          message: { role: "user", content: "hello" },
        },
      ],
      ownership: { owner: "self" },
      pendingInputRequest: null,
      slashCommands: null,
      pagination: {
        hasOlderMessages: false,
        totalMessageCount: 1,
        returnedMessageCount: 1,
        totalCompactions: 0,
      },
    });
    let resolveDelta!: (value: unknown) => void;
    apiMocks.getSession.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveDelta = resolve;
      }),
    );

    const first = renderHook(() =>
      useSessionMessages({
        projectId: "proj-1",
        sessionId: "sess-1",
      }),
    );

    await waitFor(() => expect(first.result.current.loading).toBe(false));
    first.unmount();

    const second = renderHook(() =>
      useSessionMessages({
        projectId: "proj-1",
        sessionId: "sess-1",
      }),
    );

    expect(second.result.current.loading).toBe(true);
    expect(second.result.current.messages).toEqual([]);
    expect(readStoreMessageIds()).toEqual(["msg-1"]);

    await waitFor(() => expect(second.result.current.loading).toBe(false));
    expect(
      second.result.current.messages.map((message) => message.uuid),
    ).toEqual(["msg-1"]);

    await act(async () => {
      resolveDelta({
        session: {
          provider: "claude",
          updatedAt: "2026-05-04T00:00:00.000Z",
        },
        messages: [],
        ownership: { owner: "self" },
        pendingInputRequest: null,
        slashCommands: null,
      });
      await apiMocks.getSession.mock.results[1]?.value;
    });
  });

  it("hides stale fallback mirrors across route changes before reveal", async () => {
    apiMocks.getSession.mockResolvedValueOnce({
      session: {
        provider: "claude",
        updatedAt: "2026-05-04T00:00:00.000Z",
      },
      messages: [
        {
          uuid: "sess-1-msg",
          type: "user",
          timestamp: "2026-05-04T00:00:00.000Z",
          message: { role: "user", content: "first" },
        },
      ],
      ownership: { owner: "self" },
      pendingInputRequest: null,
      slashCommands: null,
      pagination: {
        hasOlderMessages: false,
        totalMessageCount: 1,
        returnedMessageCount: 1,
        totalCompactions: 0,
      },
    });
    let rejectSecondLoad!: (error: Error) => void;
    const secondLoad = new Promise<never>((_, reject) => {
      rejectSecondLoad = reject;
    });
    apiMocks.getSession.mockReturnValueOnce(secondLoad);

    const rendered = renderHook(
      ({ sessionId }) =>
        useSessionMessages({
          projectId: "proj-1",
          sessionId,
        }),
      {
        initialProps: { sessionId: "sess-1" },
      },
    );

    await waitFor(() => expect(rendered.result.current.loading).toBe(false));
    expect(
      rendered.result.current.messages.map((message) => message.uuid),
    ).toEqual(["sess-1-msg"]);

    act(() => {
      rendered.rerender({ sessionId: "sess-2" });
    });

    await waitFor(() => expect(apiMocks.getSession).toHaveBeenCalledTimes(2));
    expect(rendered.result.current.messages).toEqual([]);

    await act(async () => {
      rejectSecondLoad(new Error("load failed"));
      await secondLoad.catch(() => undefined);
    });

    await waitFor(() => expect(rendered.result.current.loading).toBe(false));
    expect(rendered.result.current.messages).toEqual([]);
  });

  it("mirrors active loads into the session detail store without retaining when cache is disabled", async () => {
    apiMocks.getSession.mockResolvedValueOnce({
      session: {
        provider: "claude",
        updatedAt: "2026-05-04T00:00:00.000Z",
      },
      messages: [
        {
          uuid: "msg-1",
          type: "user",
          timestamp: "2026-05-04T00:00:00.000Z",
          message: { role: "user", content: "hello" },
        },
      ],
      ownership: { owner: "self" },
      pendingInputRequest: null,
      slashCommands: null,
      pagination: {
        hasOlderMessages: false,
        totalMessageCount: 1,
        returnedMessageCount: 1,
        totalCompactions: 0,
      },
    });

    const rendered = renderHook(() =>
      useSessionMessages({
        projectId: "proj-1",
        sessionId: "sess-1",
      }),
    );

    await waitFor(() => expect(rendered.result.current.loading).toBe(false));
    expect(rendered.result.current.pagination?.totalMessageCount).toBe(1);

    const storeKey = defaultStoreEntryKey();
    expect(
      defaultSessionDetailMemoryCache
        .read(storeKey)
        ?.messages.map((message) => message.uuid),
    ).toEqual(["msg-1"]);

    rendered.unmount();

    expect(defaultSessionDetailMemoryCache.read(storeKey)).toBeUndefined();
  });

  it("retains the mounted session's store entry against eviction", async () => {
    apiMocks.getSession.mockResolvedValueOnce({
      session: {
        provider: "claude",
        updatedAt: "2026-05-04T00:00:00.000Z",
      },
      messages: [
        {
          uuid: "msg-1",
          type: "user",
          timestamp: "2026-05-04T00:00:00.000Z",
          message: { role: "user", content: "hello" },
        },
      ],
      ownership: { owner: "self" },
      pendingInputRequest: null,
      slashCommands: null,
      pagination: {
        hasOlderMessages: false,
        totalMessageCount: 1,
        returnedMessageCount: 1,
        totalCompactions: 0,
      },
    });

    const rendered = renderHook(() =>
      useSessionMessages({
        projectId: "proj-1",
        sessionId: "sess-1",
      }),
    );

    await waitFor(() => expect(rendered.result.current.loading).toBe(false));
    expect(defaultSessionDetailMemoryCache.getStats().retainedEntryCount).toBe(
      1,
    );

    // A TTL sweep far in the future must not evict the mounted entry.
    expect(
      defaultSessionDetailMemoryCache.evictExpired({
        nowMs: Date.now() + 60 * 60 * 1000,
      }),
    ).toBe(0);
    expect(readStoreMessageIds()).toEqual(["msg-1"]);

    rendered.unmount();
    expect(defaultSessionDetailMemoryCache.getStats().retainedEntryCount).toBe(
      0,
    );
  });

  it("returns store-selected messages", async () => {
    apiMocks.getSession.mockResolvedValueOnce({
      session: {
        provider: "claude",
        updatedAt: "2026-05-04T00:00:00.000Z",
      },
      messages: [
        {
          uuid: "msg-1",
          type: "user",
          timestamp: "2026-05-04T00:00:00.000Z",
          message: { role: "user", content: "hello" },
        },
      ],
      ownership: { owner: "self" },
      pendingInputRequest: null,
      slashCommands: null,
      pagination: {
        hasOlderMessages: false,
        totalMessageCount: 1,
        returnedMessageCount: 1,
        totalCompactions: 0,
      },
    });

    const rendered = renderHook(() =>
      useSessionMessages({
        projectId: "proj-1",
        sessionId: "sess-1",
      }),
    );

    await waitFor(() => expect(rendered.result.current.loading).toBe(false));

    act(() => {
      defaultSessionDetailMemoryCache.dispatch(defaultStoreEntryKey(), {
        type: "applyStreamMessage",
        message: {
          uuid: "store-only-msg",
          type: "assistant",
          timestamp: "2026-05-04T00:01:00.000Z",
          message: { role: "assistant", content: "store update" },
        },
      });
    });

    await waitFor(() =>
      expect(
        rendered.result.current.messages.map((message) => message.uuid),
      ).toEqual(["msg-1", "store-only-msg"]),
    );
  });

  it("keeps transcript identities stable for metadata-only store changes", async () => {
    apiMocks.getSession.mockResolvedValueOnce({
      session: {
        provider: "claude",
        title: "Before",
        updatedAt: "2026-05-04T00:00:00.000Z",
      },
      messages: [
        {
          uuid: "msg-1",
          type: "user",
          timestamp: "2026-05-04T00:00:00.000Z",
          message: { role: "user", content: "hello" },
        },
      ],
      ownership: { owner: "self" },
      pendingInputRequest: null,
      slashCommands: null,
      pagination: {
        hasOlderMessages: false,
        totalMessageCount: 1,
        returnedMessageCount: 1,
        totalCompactions: 0,
      },
    });

    let renderCount = 0;
    const rendered = renderHook(() => {
      renderCount += 1;
      return useSessionMessages({
        projectId: "proj-1",
        sessionId: "sess-1",
      });
    });

    await waitFor(() => expect(rendered.result.current.loading).toBe(false));
    const settledRenderCount = renderCount;
    const returnedMessages = rendered.result.current.messages;
    const returnedAgentContent = rendered.result.current.agentContent;
    const returnedToolUseToAgent = rendered.result.current.toolUseToAgent;

    act(() => {
      defaultSessionDetailMemoryCache.dispatch(defaultStoreEntryKey(), {
        type: "setSessionMetadata",
        session: {
          id: "sess-1",
          projectId: "proj-1" as SessionMetadata["projectId"],
          provider: "claude",
          title: "After",
          fullTitle: "After",
          createdAt: "2026-05-04T00:00:00.000Z",
          updatedAt: "2026-05-04T00:01:00.000Z",
          messageCount: 1,
          ownership: { owner: "self", processId: "pid-1" },
        },
      });
    });

    // Session is store-backed, so the metadata change re-renders exactly once
    // and surfaces the new session without churning transcript identities.
    expect(renderCount).toBe(settledRenderCount + 1);
    expect(rendered.result.current.session?.title).toBe("After");
    expect(rendered.result.current.messages).toBe(returnedMessages);
    expect(rendered.result.current.agentContent).toBe(returnedAgentContent);
    expect(rendered.result.current.toolUseToAgent).toBe(returnedToolUseToAgent);
  });

  it("keeps the tool-use map stable for message-only store changes", async () => {
    apiMocks.getSession.mockResolvedValueOnce({
      session: {
        provider: "claude",
        updatedAt: "2026-05-04T00:00:00.000Z",
      },
      messages: [
        {
          uuid: "msg-1",
          type: "user",
          timestamp: "2026-05-04T00:00:00.000Z",
          message: { role: "user", content: "hello" },
        },
      ],
      ownership: { owner: "self" },
      pendingInputRequest: null,
      slashCommands: null,
      pagination: {
        hasOlderMessages: false,
        totalMessageCount: 1,
        returnedMessageCount: 1,
        totalCompactions: 0,
      },
    });

    const rendered = renderHook(() =>
      useSessionMessages({
        projectId: "proj-1",
        sessionId: "sess-1",
      }),
    );

    await waitFor(() => expect(rendered.result.current.loading).toBe(false));

    act(() => {
      defaultSessionDetailMemoryCache.dispatch(defaultStoreEntryKey(), {
        type: "registerToolUseAgent",
        toolUseId: "tool-1",
        agentId: "agent-1",
      });
    });

    await waitFor(() =>
      expect(rendered.result.current.toolUseToAgent.get("tool-1")).toBe(
        "agent-1",
      ),
    );
    const returnedToolUseToAgent = rendered.result.current.toolUseToAgent;

    act(() => {
      defaultSessionDetailMemoryCache.dispatch(defaultStoreEntryKey(), {
        type: "applyStreamMessage",
        message: {
          uuid: "msg-2",
          type: "assistant",
          timestamp: "2026-05-04T00:01:00.000Z",
          message: { role: "assistant", content: "world" },
        },
      });
    });

    await waitFor(() =>
      expect(rendered.result.current.messages).toHaveLength(2),
    );
    expect(rendered.result.current.toolUseToAgent).toBe(returnedToolUseToAgent);
  });

  it("returns empty transcript surfaces when store data is missing after reveal", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    apiMocks.getSession.mockResolvedValueOnce({
      session: {
        provider: "claude",
        updatedAt: "2026-05-04T00:00:00.000Z",
      },
      messages: [
        {
          uuid: "msg-1",
          type: "user",
          timestamp: "2026-05-04T00:00:00.000Z",
          message: { role: "user", content: "hello" },
        },
      ],
      ownership: { owner: "self" },
      pendingInputRequest: null,
      slashCommands: null,
      pagination: {
        hasOlderMessages: false,
        totalMessageCount: 1,
        returnedMessageCount: 1,
        totalCompactions: 0,
      },
    });

    const rendered = renderHook(() =>
      useSessionMessages({
        projectId: "proj-1",
        sessionId: "sess-1",
      }),
    );

    await waitFor(() => expect(rendered.result.current.loading).toBe(false));
    expect(
      rendered.result.current.messages.map((message) => message.uuid),
    ).toEqual(["msg-1"]);

    act(() => {
      defaultSessionDetailMemoryCache.deleteEntry(defaultStoreEntryKey());
    });

    await waitFor(() => expect(rendered.result.current.messages).toEqual([]));
    expect(rendered.result.current.agentContent).toEqual({});
    expect(rendered.result.current.toolUseToAgent.size).toBe(0);
    expect(
      warn.mock.calls.some(
        ([label, payload]) =>
          label === "[SessionDetailStore]" &&
          typeof payload === "object" &&
          payload !== null &&
          "event" in payload &&
          payload.event === "session-detail-store-missing-after-reveal",
      ),
    ).toBe(true);

    warn.mockRestore();
  });

  it("returns store-selected agent content", async () => {
    apiMocks.getSession.mockResolvedValueOnce({
      session: {
        provider: "codex",
        updatedAt: "2026-05-04T00:00:00.000Z",
      },
      messages: [],
      ownership: { owner: "self" },
      pendingInputRequest: null,
      slashCommands: null,
      pagination: {
        hasOlderMessages: false,
        totalMessageCount: 0,
        returnedMessageCount: 0,
        totalCompactions: 0,
      },
    });

    const rendered = renderHook(() =>
      useSessionMessages({
        projectId: "proj-1",
        sessionId: "sess-1",
      }),
    );

    await waitFor(() => expect(rendered.result.current.loading).toBe(false));

    const storeOnlyMessage: Message = {
      uuid: "agent-store-only-1",
      type: "assistant",
      message: { role: "assistant", content: "store only" },
    };

    act(() => {
      defaultSessionDetailMemoryCache.dispatch(defaultStoreEntryKey(), {
        type: "mergeLoadedAgentContent",
        agentId: "task-store",
        content: {
          messages: [storeOnlyMessage],
          status: "completed",
        },
      });
    });

    await waitFor(() =>
      expect(rendered.result.current.agentContent["task-store"]).toEqual({
        messages: [storeOnlyMessage],
        status: "completed",
      }),
    );
  });

  it("returns store-selected tool-use mappings", async () => {
    apiMocks.getSession.mockResolvedValueOnce({
      session: {
        provider: "codex",
        updatedAt: "2026-05-04T00:00:00.000Z",
      },
      messages: [],
      ownership: { owner: "self" },
      pendingInputRequest: null,
      slashCommands: null,
      pagination: {
        hasOlderMessages: false,
        totalMessageCount: 0,
        returnedMessageCount: 0,
        totalCompactions: 0,
      },
    });

    const rendered = renderHook(() =>
      useSessionMessages({
        projectId: "proj-1",
        sessionId: "sess-1",
      }),
    );

    await waitFor(() => expect(rendered.result.current.loading).toBe(false));

    act(() => {
      defaultSessionDetailMemoryCache.dispatch(defaultStoreEntryKey(), {
        type: "registerToolUseAgent",
        toolUseId: "toolu_store",
        agentId: "agent-store",
      });
    });

    await waitFor(() =>
      expect(rendered.result.current.toolUseToAgent.get("toolu_store")).toBe(
        "agent-store",
      ),
    );
  });

  it("keeps returned store-backed data coherent across message and subagent transitions", async () => {
    apiMocks.getSession.mockResolvedValueOnce({
      session: {
        provider: "claude",
        updatedAt: "2026-05-04T00:00:00.000Z",
      },
      messages: [
        {
          uuid: "msg-1",
          type: "user",
          timestamp: "2026-05-04T00:00:00.000Z",
          message: { role: "user", content: "hello" },
        },
      ],
      ownership: { owner: "self" },
      pendingInputRequest: null,
      slashCommands: null,
      pagination: {
        hasOlderMessages: false,
        totalMessageCount: 1,
        returnedMessageCount: 1,
        totalCompactions: 0,
      },
    });

    const rendered = renderHook(() =>
      useSessionMessages({
        projectId: "proj-1",
        sessionId: "sess-1",
      }),
    );

    await waitFor(() => expect(rendered.result.current.loading).toBe(false));

    act(() => {
      rendered.result.current.handleStreamingUpdate({
        uuid: "streaming-1",
        type: "assistant",
        timestamp: "2026-05-04T00:00:30.000Z",
        _isStreaming: true,
        message: { role: "assistant", content: "streaming" },
      });
    });

    await waitFor(() =>
      expect(
        rendered.result.current.messages.map((message) => message.uuid),
      ).toEqual(["msg-1", "streaming-1"]),
    );
    expect(readStoreMessageIds()).toEqual(["msg-1", "streaming-1"]);

    act(() => {
      rendered.result.current.clearStreamingPlaceholders();
    });

    await waitFor(() =>
      expect(
        rendered.result.current.messages.map((message) => message.uuid),
      ).toEqual(["msg-1"]),
    );
    expect(readStoreMessageIds()).toEqual(["msg-1"]);

    const subagentStreamMessage: Message = {
      uuid: "agent-stream-1",
      type: "assistant",
      timestamp: "2026-05-04T00:01:00.000Z",
      message: { role: "assistant", content: "agent stream" },
    };

    act(() => {
      rendered.result.current.handleStreamSubagentMessage(
        subagentStreamMessage,
        "task-1",
      );
    });

    await waitFor(() =>
      expect(rendered.result.current.agentContent["task-1"]).toEqual({
        messages: [subagentStreamMessage],
        status: "running",
      }),
    );
    expect(readStoreAgentContent()?.["task-1"]).toEqual({
      messages: [subagentStreamMessage],
      status: "running",
    });

    const loadedSubagentMessage: Message = {
      uuid: "agent-loaded-1",
      type: "assistant",
      timestamp: "2026-05-04T00:02:00.000Z",
      message: { role: "assistant", content: "agent loaded" },
    };

    act(() => {
      rendered.result.current.mergeLoadedAgentContent("task-1", {
        messages: [loadedSubagentMessage],
        status: "completed",
      });
    });

    await waitFor(() =>
      expect(rendered.result.current.agentContent["task-1"]).toEqual({
        messages: [loadedSubagentMessage, subagentStreamMessage],
        status: "running",
      }),
    );
    expect(readStoreAgentContent()?.["task-1"]).toEqual({
      messages: [loadedSubagentMessage, subagentStreamMessage],
      status: "running",
    });

    act(() => {
      rendered.result.current.registerToolUseAgent("toolu_1", "task-1");
    });

    await waitFor(() =>
      expect(rendered.result.current.toolUseToAgent.get("toolu_1")).toBe(
        "task-1",
      ),
    );
  });

  it("mirrors tool-use mappings from the session detail store after registration", async () => {
    apiMocks.getSession.mockResolvedValueOnce({
      session: {
        provider: "codex",
        updatedAt: "2026-05-04T00:00:00.000Z",
      },
      messages: [],
      ownership: { owner: "self" },
      pendingInputRequest: null,
      slashCommands: null,
      pagination: {
        hasOlderMessages: false,
        totalMessageCount: 0,
        returnedMessageCount: 0,
        totalCompactions: 0,
      },
    });

    const rendered = renderHook(() =>
      useSessionMessages({
        projectId: "proj-1",
        sessionId: "sess-1",
      }),
    );

    await waitFor(() => expect(rendered.result.current.loading).toBe(false));

    act(() => {
      defaultSessionDetailMemoryCache.dispatch(defaultStoreEntryKey(), {
        type: "registerToolUseAgent",
        toolUseId: "toolu_store",
        agentId: "agent-store",
      });
      rendered.result.current.registerToolUseAgent("toolu_hook", "agent-hook");
    });

    expect(
      Array.from(rendered.result.current.toolUseToAgent.entries()),
    ).toEqual([
      ["toolu_store", "agent-store"],
      ["toolu_hook", "agent-hook"],
    ]);
    expect(Array.from(readStoreToolUseToAgent()?.entries() ?? [])).toEqual([
      ["toolu_store", "agent-store"],
      ["toolu_hook", "agent-hook"],
    ]);
  });

  it("keeps store-backed warm agent content gated until hydration", async () => {
    enableSessionTranscriptCache();

    apiMocks.getSession.mockResolvedValueOnce({
      session: {
        provider: "codex",
        updatedAt: "2026-05-04T00:00:00.000Z",
      },
      messages: [],
      ownership: { owner: "self" },
      pendingInputRequest: null,
      slashCommands: null,
      pagination: {
        hasOlderMessages: false,
        totalMessageCount: 0,
        returnedMessageCount: 0,
        totalCompactions: 0,
      },
    });
    let resolveDelta!: (value: unknown) => void;
    apiMocks.getSession.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveDelta = resolve;
      }),
    );

    const first = renderHook(() =>
      useSessionMessages({
        projectId: "proj-1",
        sessionId: "sess-1",
      }),
    );

    await waitFor(() => expect(first.result.current.loading).toBe(false));

    const warmMessage: Message = {
      uuid: "agent-warm-1",
      type: "assistant",
      message: { role: "assistant", content: "warm" },
    };
    act(() => {
      first.result.current.mergeLoadedAgentContent("task-warm", {
        messages: [warmMessage],
        status: "completed",
      });
    });
    await waitFor(() =>
      expect(first.result.current.agentContent["task-warm"]).toEqual({
        messages: [warmMessage],
        status: "completed",
      }),
    );
    first.unmount();

    const second = renderHook(() =>
      useSessionMessages({
        projectId: "proj-1",
        sessionId: "sess-1",
      }),
    );

    expect(second.result.current.loading).toBe(true);
    expect(second.result.current.agentContent).toEqual({});
    expect(readStoreAgentContent()?.["task-warm"]).toEqual({
      messages: [warmMessage],
      status: "completed",
    });

    await waitFor(() => expect(second.result.current.loading).toBe(false));
    expect(second.result.current.agentContent["task-warm"]).toEqual({
      messages: [warmMessage],
      status: "completed",
    });

    await act(async () => {
      resolveDelta({
        session: {
          provider: "codex",
          updatedAt: "2026-05-04T00:00:00.000Z",
        },
        messages: [],
        ownership: { owner: "self" },
        pendingInputRequest: null,
        slashCommands: null,
      });
      await apiMocks.getSession.mock.results[1]?.value;
    });
  });

  it("keeps store-selected messages authoritative across stream events", async () => {
    apiMocks.getSession.mockResolvedValueOnce({
      session: {
        provider: "claude",
        updatedAt: "2026-05-04T00:00:00.000Z",
      },
      messages: [
        {
          uuid: "msg-1",
          type: "user",
          timestamp: "2026-05-04T00:00:00.000Z",
          message: { role: "user", content: "hello" },
        },
      ],
      ownership: { owner: "self" },
      pendingInputRequest: null,
      slashCommands: null,
      pagination: {
        hasOlderMessages: false,
        totalMessageCount: 1,
        returnedMessageCount: 1,
        totalCompactions: 0,
      },
    });

    const rendered = renderHook(() =>
      useSessionMessages({
        projectId: "proj-1",
        sessionId: "sess-1",
      }),
    );

    await waitFor(() => expect(rendered.result.current.loading).toBe(false));

    act(() => {
      defaultSessionDetailMemoryCache.dispatch(defaultStoreEntryKey(), {
        type: "applyStreamMessage",
        message: {
          uuid: "store-only-msg",
          type: "assistant",
          timestamp: "2026-05-04T00:00:30.000Z",
          message: { role: "assistant", content: "store update" },
        },
      });
    });
    await waitFor(() =>
      expect(
        rendered.result.current.messages.map((message) => message.uuid),
      ).toEqual(["msg-1", "store-only-msg"]),
    );

    act(() => {
      rendered.result.current.handleStreamMessageEvent({
        uuid: "stream-msg",
        type: "assistant",
        timestamp: "2026-05-04T00:01:00.000Z",
        message: { role: "assistant", content: "stream update" },
      });
    });

    await waitFor(() =>
      expect(
        rendered.result.current.messages.map((message) => message.uuid),
      ).toEqual(["msg-1", "store-only-msg", "stream-msg"]),
    );
    expect(readStoreMessageIds()).toEqual([
      "msg-1",
      "store-only-msg",
      "stream-msg",
    ]);
  });

  it("mirrors main stream messages from the session detail store after stream events", async () => {
    apiMocks.getSession.mockResolvedValueOnce({
      session: {
        provider: "claude",
        updatedAt: "2026-05-04T00:00:00.000Z",
      },
      messages: [
        {
          uuid: "msg-1",
          type: "user",
          timestamp: "2026-05-04T00:00:00.000Z",
          message: { role: "user", content: "hello" },
        },
      ],
      ownership: { owner: "self" },
      pendingInputRequest: null,
      slashCommands: null,
      pagination: {
        hasOlderMessages: false,
        totalMessageCount: 1,
        returnedMessageCount: 1,
        totalCompactions: 0,
      },
    });

    const rendered = renderHook(() =>
      useSessionMessages({
        projectId: "proj-1",
        sessionId: "sess-1",
      }),
    );

    await waitFor(() => expect(rendered.result.current.loading).toBe(false));

    act(() => {
      defaultSessionDetailMemoryCache.dispatch(defaultStoreEntryKey(), {
        type: "applyStreamMessage",
        message: {
          uuid: "store-only-msg",
          type: "assistant",
          timestamp: "2026-05-04T00:00:30.000Z",
          message: { role: "assistant", content: "store update" },
        },
      });
    });
    await waitFor(() =>
      expect(
        rendered.result.current.messages.map((message) => message.uuid),
      ).toEqual(["msg-1", "store-only-msg"]),
    );

    act(() => {
      rendered.result.current.handleStreamMessageEvent({
        uuid: "stream-msg",
        type: "assistant",
        timestamp: "2026-05-04T00:01:00.000Z",
        message: { role: "assistant", content: "stream update" },
      });
    });

    expect(
      rendered.result.current.messages.map((message) => message.uuid),
    ).toEqual(["msg-1", "store-only-msg", "stream-msg"]);
    expect(readStoreMessageIds()).toEqual([
      "msg-1",
      "store-only-msg",
      "stream-msg",
    ]);
  });

  it("coalesces same-id stream replacements before publishing", async () => {
    apiMocks.getSession.mockResolvedValueOnce({
      ...sessionResponse("assistant-1"),
      messages: [],
    });

    const rendered = renderHook(() =>
      useSessionMessages({
        projectId: "proj-1",
        sessionId: "sess-1",
      }),
    );

    await waitFor(() => expect(rendered.result.current.loading).toBe(false));

    act(() => {
      rendered.result.current.handleStreamMessageEvent({
        uuid: "assistant-1",
        type: "assistant",
        message: { role: "assistant", content: "draft" },
      });
    });
    expect(rendered.result.current.messages[0]?.message?.content).toBe("draft");

    act(() => {
      rendered.result.current.handleStreamMessageEvent({
        uuid: "assistant-1",
        type: "assistant",
        message: { role: "assistant", content: "enriching" },
      });
      rendered.result.current.handleStreamMessageEvent({
        uuid: "assistant-1",
        type: "assistant",
        message: { role: "assistant", content: "enriched" },
      });
    });

    expect(rendered.result.current.messages[0]?.message?.content).toBe("draft");

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
    });

    expect(rendered.result.current.messages[0]?.message?.content).toBe(
      "enriched",
    );
  });

  it("keeps store-selected messages authoritative across catch-up", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    apiMocks.getSession.mockResolvedValueOnce({
      session: {
        provider: "claude",
        updatedAt: "2026-05-04T00:00:00.000Z",
      },
      messages: [
        {
          uuid: "msg-1",
          type: "user",
          timestamp: "2026-05-04T00:00:00.000Z",
          message: { role: "user", content: "hello" },
        },
      ],
      ownership: { owner: "self" },
      pendingInputRequest: null,
      slashCommands: null,
      pagination: {
        hasOlderMessages: false,
        totalMessageCount: 1,
        returnedMessageCount: 1,
        totalCompactions: 0,
      },
    });

    const { result } = renderHook(() =>
      useSessionMessages({
        projectId: "proj-1",
        sessionId: "sess-1",
      }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      defaultSessionDetailMemoryCache.dispatch(defaultStoreEntryKey(), {
        type: "applyStreamMessage",
        message: {
          uuid: "store-only-msg",
          type: "assistant",
          timestamp: "2026-05-04T00:00:30.000Z",
          message: { role: "assistant", content: "store update" },
        },
      });
    });
    await waitFor(() =>
      expect(result.current.messages.map((message) => message.uuid)).toEqual([
        "msg-1",
        "store-only-msg",
      ]),
    );

    apiMocks.getSession.mockClear();
    apiMocks.getSession.mockResolvedValueOnce({
      session: {
        provider: "claude",
        updatedAt: "2026-05-04T00:01:00.000Z",
      },
      messages: [
        {
          uuid: "msg-2",
          type: "assistant",
          timestamp: "2026-05-04T00:01:00.000Z",
          message: { role: "assistant", content: "hi" },
        },
      ],
      ownership: { owner: "self" },
      pendingInputRequest: null,
      slashCommands: null,
    });

    await act(async () => {
      await result.current.fetchNewMessages();
    });

    expect(apiMocks.getSession).toHaveBeenCalledWith(
      "proj-1",
      "sess-1",
      "msg-1",
    );
    expect(result.current.messages.map((message) => message.uuid)).toEqual([
      "msg-1",
      "store-only-msg",
      "msg-2",
    ]);
    expect(readStoreMessageIds()).toEqual(["msg-1", "store-only-msg", "msg-2"]);
    expect(reactCrossUpdateErrorCalls(error)).toHaveLength(0);
  });

  it("uses compact tail fallback when catch-up has no last message cursor", async () => {
    apiMocks.getSession.mockResolvedValueOnce({
      session: {
        provider: "claude",
        updatedAt: "2026-05-04T00:00:00.000Z",
      },
      messages: [],
      ownership: { owner: "self" },
      pendingInputRequest: null,
      slashCommands: null,
      pagination: {
        hasOlderMessages: false,
        totalMessageCount: 0,
        returnedMessageCount: 0,
        totalCompactions: 0,
      },
    });

    const { result } = renderHook(() =>
      useSessionMessages({
        projectId: "proj-1",
        sessionId: "sess-1",
      }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(readStoreMessageIds()).toEqual([]);

    apiMocks.getSession.mockClear();
    apiMocks.getSession.mockResolvedValueOnce({
      session: {
        provider: "claude",
        updatedAt: "2026-05-04T00:01:00.000Z",
      },
      messages: [
        {
          uuid: "msg-1",
          type: "assistant",
          timestamp: "2026-05-04T00:01:00.000Z",
          message: { role: "assistant", content: "tail fallback" },
        },
      ],
      ownership: { owner: "self" },
      pendingInputRequest: null,
      slashCommands: null,
      pagination: {
        hasOlderMessages: false,
        totalMessageCount: 1,
        returnedMessageCount: 1,
        totalCompactions: 0,
      },
    });

    await act(async () => {
      await result.current.fetchNewMessages();
    });

    expect(apiMocks.getSession).toHaveBeenCalledWith(
      "proj-1",
      "sess-1",
      undefined,
      defaultInitialTailRequest(),
    );
    expect(result.current.messages.map((message) => message.uuid)).toEqual([
      "msg-1",
    ]);
  });

  it("keeps store-selected messages authoritative across older-page prepend", async () => {
    apiMocks.getSession.mockResolvedValueOnce({
      session: {
        provider: "claude",
        updatedAt: "2026-05-04T00:00:00.000Z",
      },
      messages: [
        {
          uuid: "msg-1",
          type: "user",
          timestamp: "2026-05-04T00:00:00.000Z",
          message: { role: "user", content: "hello" },
        },
      ],
      ownership: { owner: "self" },
      pendingInputRequest: null,
      slashCommands: null,
      pagination: {
        hasOlderMessages: true,
        truncatedBeforeMessageId: "msg-1",
        totalMessageCount: 2,
        returnedMessageCount: 1,
        totalCompactions: 0,
      },
    });
    apiMocks.getSession.mockResolvedValueOnce({
      session: {
        provider: "claude",
        updatedAt: "2026-05-03T23:59:00.000Z",
      },
      messages: [
        {
          uuid: "older-msg",
          type: "assistant",
          timestamp: "2026-05-03T23:59:00.000Z",
          message: { role: "assistant", content: "before" },
        },
      ],
      ownership: { owner: "self" },
      pendingInputRequest: null,
      slashCommands: null,
      pagination: {
        hasOlderMessages: false,
        totalMessageCount: 3,
        returnedMessageCount: 3,
        totalCompactions: 0,
      },
    });

    const rendered = renderHook(() =>
      useSessionMessages({
        projectId: "proj-1",
        sessionId: "sess-1",
      }),
    );

    await waitFor(() => expect(rendered.result.current.loading).toBe(false));

    act(() => {
      defaultSessionDetailMemoryCache.dispatch(defaultStoreEntryKey(), {
        type: "applyStreamMessage",
        message: {
          uuid: "store-only-msg",
          type: "assistant",
          timestamp: "2026-05-04T00:00:30.000Z",
          message: { role: "assistant", content: "store update" },
        },
      });
    });
    await waitFor(() =>
      expect(
        rendered.result.current.messages.map((message) => message.uuid),
      ).toEqual(["msg-1", "store-only-msg"]),
    );

    await act(async () => {
      await rendered.result.current.loadOlderMessages();
    });

    expect(apiMocks.getSession).toHaveBeenNthCalledWith(
      2,
      "proj-1",
      "sess-1",
      undefined,
      {
        tailCompactions: 2,
        beforeMessageId: "msg-1",
      },
    );
    expect(
      rendered.result.current.messages.map((message) => message.uuid),
    ).toEqual(["older-msg", "msg-1", "store-only-msg"]);
    expect(readStoreMessageIds()).toEqual([
      "older-msg",
      "msg-1",
      "store-only-msg",
    ]);
  });

  it("returns retained scroll snapshots through the store selector", async () => {
    enableSessionTranscriptCache();

    apiMocks.getSession.mockResolvedValueOnce({
      session: {
        provider: "claude",
        updatedAt: "2026-05-04T00:00:00.000Z",
      },
      messages: [
        {
          uuid: "msg-1",
          type: "user",
          timestamp: "2026-05-04T00:00:00.000Z",
          message: { role: "user", content: "hello" },
        },
      ],
      ownership: { owner: "self" },
      pendingInputRequest: null,
      slashCommands: null,
      pagination: {
        hasOlderMessages: false,
        totalMessageCount: 1,
        returnedMessageCount: 1,
        totalCompactions: 0,
      },
    });
    apiMocks.getSession.mockResolvedValueOnce({
      session: {
        provider: "claude",
        updatedAt: "2026-05-04T00:01:00.000Z",
      },
      messages: [],
      ownership: { owner: "self" },
      pendingInputRequest: null,
      slashCommands: null,
    });

    const first = renderHook(() =>
      useSessionMessages({
        projectId: "proj-1",
        sessionId: "sess-1",
      }),
    );

    await waitFor(() => expect(first.result.current.loading).toBe(false));
    const retainedScroll = scrollSnapshot();
    act(() => {
      first.result.current.updateRouteScrollSnapshot(retainedScroll);
    });
    first.unmount();

    const second = renderHook(() =>
      useSessionMessages({
        projectId: "proj-1",
        sessionId: "sess-1",
      }),
    );

    expect(second.result.current.restoredFromSnapshot).toBe(true);
    expect(second.result.current.initialScrollSnapshot).toEqual(retainedScroll);
    await waitFor(() => expect(second.result.current.loading).toBe(false));
  });

  it("restores a remembered place without a warm transcript cache", async () => {
    apiMocks.getSession.mockResolvedValueOnce(sessionResponse("msg-1"));
    const reference = {
      sourceKey: LOCAL_CLIENT_SUMMARY_SOURCE_KEY,
      projectId: "proj-1",
      sessionId: "sess-1",
    };
    const retainedScroll = {
      ...deviceScrollSnapshot("turn-2", 200),
      scrollTop: 240,
      anchor: { id: "answer-mid-turn-2", topOffset: 10, timestampMs: 250 },
      completedTurn: undefined,
      seenTurn: { id: "turn-2", timestampMs: 200, activityIndex: 1 },
      updatedAtMs: 300,
    };
    writeSessionScrollMemory(reference, retainedScroll);

    const rendered = renderHook(() =>
      useSessionMessages({ projectId: "proj-1", sessionId: "sess-1" }),
    );

    expect(rendered.result.current.initialScrollSnapshot).toEqual(
      retainedScroll,
    );
    await waitFor(() => expect(rendered.result.current.loading).toBe(false));
    expect(rendered.result.current.initialScrollSnapshot).toEqual(
      retainedScroll,
    );
  });

  it("advances storage on completed turns and reconciles another tab", async () => {
    apiMocks.getSession.mockResolvedValueOnce(sessionResponse("msg-1"));
    const reference = {
      sourceKey: LOCAL_CLIENT_SUMMARY_SOURCE_KEY,
      projectId: "proj-1",
      sessionId: "sess-1",
    };
    const rendered = renderHook(() =>
      useSessionMessages({ projectId: "proj-1", sessionId: "sess-1" }),
    );
    await waitFor(() => expect(rendered.result.current.loading).toBe(false));

    const first = deviceScrollSnapshot("turn-1", 100);
    act(() => {
      rendered.result.current.updateRouteScrollSnapshot(first);
    });
    expect(readSessionScrollMemory(reference)).toEqual(first);

    const second = deviceScrollSnapshot("turn-2", 200, true);
    writeSessionScrollMemory(reference, second);
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: createSessionScrollMemoryStorageKey(reference),
          newValue: JSON.stringify(second),
        }),
      );
    });

    expect(
      defaultSessionDetailMemoryCache.readScrollSnapshot(
        defaultStoreEntryKey(),
      ),
    ).toEqual(second);
  });

  it("does not persist a viewport without a seen-turn cursor", async () => {
    apiMocks.getSession.mockResolvedValueOnce(sessionResponse("msg-1"));
    const reference = {
      sourceKey: LOCAL_CLIENT_SUMMARY_SOURCE_KEY,
      projectId: "proj-1",
      sessionId: "sess-1",
    };
    const rememberedPlace = {
      ...deviceScrollSnapshot("turn-1", 100),
      scrollTop: 240,
      anchor: { id: "answer-mid-turn-1", topOffset: 10, timestampMs: 150 },
      completedTurn: undefined,
      updatedAtMs: 300,
    };
    const rendered = renderHook(() =>
      useSessionMessages({ projectId: "proj-1", sessionId: "sess-1" }),
    );
    await waitFor(() => expect(rendered.result.current.loading).toBe(false));

    act(() => {
      rendered.result.current.updateRouteScrollSnapshot(rememberedPlace);
    });

    expect(readSessionScrollMemory(reference)).toBeNull();
  });

  it("persists an active seen turn before it completes", async () => {
    apiMocks.getSession.mockResolvedValueOnce(sessionResponse("msg-1"));
    const reference = {
      sourceKey: LOCAL_CLIENT_SUMMARY_SOURCE_KEY,
      projectId: "proj-1",
      sessionId: "sess-1",
    };
    const activeTurn = {
      ...deviceScrollSnapshot("turn-2", 200),
      completedTurn: undefined,
      seenTurn: { id: "turn-2", timestampMs: 200, activityIndex: 1 },
    };
    const rendered = renderHook(() =>
      useSessionMessages({ projectId: "proj-1", sessionId: "sess-1" }),
    );
    await waitFor(() => expect(rendered.result.current.loading).toBe(false));

    act(() => {
      rendered.result.current.updateRouteScrollSnapshot(activeTurn);
    });

    expect(readSessionScrollMemory(reference)).toEqual(activeTurn);
  });

  it("does not advance the device cursor from a hidden tab", async () => {
    apiMocks.getSession.mockResolvedValueOnce(sessionResponse("msg-1"));
    const reference = {
      sourceKey: LOCAL_CLIENT_SUMMARY_SOURCE_KEY,
      projectId: "proj-1",
      sessionId: "sess-1",
    };
    const rendered = renderHook(() =>
      useSessionMessages({ projectId: "proj-1", sessionId: "sess-1" }),
    );
    await waitFor(() => expect(rendered.result.current.loading).toBe(false));
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden");

    act(() => {
      rendered.result.current.updateRouteScrollSnapshot(
        deviceScrollSnapshot("turn-1", 100, true),
      );
    });

    expect(readSessionScrollMemory(reference)).toBeNull();
    visibility.mockRestore();
  });

  it("reuses the warm session cache before a slow delta fetch resolves", async () => {
    enableSessionTranscriptCache();

    apiMocks.getSession.mockResolvedValueOnce({
      session: {
        provider: "claude",
        updatedAt: "2026-05-04T00:00:00.000Z",
      },
      messages: [
        {
          uuid: "msg-1",
          type: "user",
          timestamp: "2026-05-04T00:00:00.000Z",
          message: { role: "user", content: "hello" },
        },
      ],
      ownership: { owner: "self" },
      pendingInputRequest: null,
      slashCommands: null,
      pagination: {
        hasOlderMessages: false,
        totalMessageCount: 1,
        returnedMessageCount: 1,
        totalCompactions: 0,
      },
    });
    let resolveDelta!: (value: unknown) => void;
    apiMocks.getSession.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveDelta = resolve;
      }),
    );

    const first = renderHook(() =>
      useSessionMessages({
        projectId: "proj-1",
        sessionId: "sess-1",
      }),
    );

    await waitFor(() => expect(apiMocks.getSession).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(first.result.current.loading).toBe(false));

    expect(apiMocks.getSession).toHaveBeenNthCalledWith(
      1,
      "proj-1",
      "sess-1",
      undefined,
      defaultInitialTailRequest(),
    );

    first.unmount();

    const second = renderHook(() =>
      useSessionMessages({
        projectId: "proj-1",
        sessionId: "sess-1",
      }),
    );

    expect(second.result.current.loading).toBe(true);
    expect(second.result.current.messages).toEqual([]);
    act(() => {
      defaultSessionDetailMemoryCache.dispatch(defaultStoreEntryKey(), {
        type: "applyStreamMessage",
        message: {
          uuid: "store-only-msg",
          type: "assistant",
          timestamp: "2026-05-04T00:00:30.000Z",
          message: { role: "assistant", content: "store update" },
        },
      });
    });
    expect(second.result.current.messages).toEqual([]);
    expect(readStoreMessageIds()).toEqual(["msg-1", "store-only-msg"]);

    await waitFor(() => expect(apiMocks.getSession).toHaveBeenCalledTimes(2));
    expect(apiMocks.getSession).toHaveBeenNthCalledWith(
      2,
      "proj-1",
      "sess-1",
      "msg-1",
      defaultInitialTailRequest(),
    );

    await waitFor(() => expect(second.result.current.loading).toBe(false));
    expect(
      second.result.current.messages.map((message) => message.uuid),
    ).toEqual(["msg-1", "store-only-msg"]);

    await act(async () => {
      resolveDelta({
        session: {
          provider: "claude",
          updatedAt: "2026-05-04T00:01:00.000Z",
        },
        messages: [
          {
            uuid: "msg-2",
            type: "assistant",
            timestamp: "2026-05-04T00:01:00.000Z",
            message: { role: "assistant", content: "hi" },
          },
        ],
        ownership: { owner: "self" },
        pendingInputRequest: null,
        slashCommands: null,
      });
      await apiMocks.getSession.mock.results[1]?.value;
    });

    await waitFor(() => expect(second.result.current.messages).toHaveLength(3));
    expect(
      second.result.current.messages.map((message) => message.uuid),
    ).toEqual(["msg-1", "store-only-msg", "msg-2"]);
    expect(readStoreMessageIds()).toEqual(["msg-1", "store-only-msg", "msg-2"]);
    expect(second.result.current.pagination).toMatchObject({
      totalMessageCount: 3,
      returnedMessageCount: 3,
    });
  });

  it("does not reuse warm cached messages across summary sources", async () => {
    enableSessionTranscriptCache();

    const macbook = createClientSummaryHostSourceKey("macbook");
    const winnative = createClientSummaryHostSourceKey("winnative");
    apiMocks.getSession.mockResolvedValueOnce({
      session: {
        provider: "claude",
        updatedAt: "2026-05-04T00:00:00.000Z",
      },
      messages: [
        {
          uuid: "mac-msg",
          type: "user",
          timestamp: "2026-05-04T00:00:00.000Z",
          message: { role: "user", content: "mac" },
        },
      ],
      ownership: { owner: "self" },
      pendingInputRequest: null,
      slashCommands: null,
      pagination: {
        hasOlderMessages: false,
        totalMessageCount: 1,
        returnedMessageCount: 1,
        totalCompactions: 0,
      },
    });
    apiMocks.getSession.mockResolvedValueOnce({
      session: {
        provider: "claude",
        updatedAt: "2026-05-04T00:01:00.000Z",
      },
      messages: [
        {
          uuid: "win-msg",
          type: "user",
          timestamp: "2026-05-04T00:01:00.000Z",
          message: { role: "user", content: "win" },
        },
      ],
      ownership: { owner: "self" },
      pendingInputRequest: null,
      slashCommands: null,
      pagination: {
        hasOlderMessages: false,
        totalMessageCount: 1,
        returnedMessageCount: 1,
        totalCompactions: 0,
      },
    });

    act(() => {
      setCurrentClientSummarySourceKey(macbook);
    });

    const first = renderHook(() =>
      useSessionMessages({
        projectId: "proj-1",
        sessionId: "sess-1",
      }),
    );

    await waitFor(() => expect(first.result.current.loading).toBe(false));
    expect(
      first.result.current.messages.map((message) => message.uuid),
    ).toEqual(["mac-msg"]);
    first.unmount();

    act(() => {
      setCurrentClientSummarySourceKey(winnative);
    });

    const second = renderHook(() =>
      useSessionMessages({
        projectId: "proj-1",
        sessionId: "sess-1",
      }),
    );

    expect(second.result.current.loading).toBe(true);
    expect(second.result.current.messages).toEqual([]);
    await waitFor(() => expect(apiMocks.getSession).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(second.result.current.loading).toBe(false));
    expect(
      second.result.current.messages.map((message) => message.uuid),
    ).toEqual(["win-msg"]);
    second.unmount();
  });

  it("does not restore retained messages when transcript cache is disabled", async () => {
    enableSessionTranscriptCache();

    apiMocks.getSession.mockResolvedValueOnce({
      session: {
        provider: "claude",
        updatedAt: "2026-07-01T00:00:00.000Z",
      },
      messages: [
        {
          uuid: "msg-1",
          type: "user",
          timestamp: "2026-07-01T00:00:00.000Z",
          message: { role: "user", content: "hello" },
        },
      ],
      ownership: { owner: "self" },
      pendingInputRequest: null,
      slashCommands: null,
    });
    apiMocks.getSession.mockResolvedValueOnce({
      session: {
        provider: "claude",
        updatedAt: "2026-07-01T00:01:00.000Z",
      },
      messages: [
        {
          uuid: "fresh-msg",
          type: "assistant",
          timestamp: "2026-07-01T00:01:00.000Z",
          message: { role: "assistant", content: "fresh" },
        },
      ],
      ownership: { owner: "self" },
      pendingInputRequest: null,
      slashCommands: null,
    });

    const first = renderHook(() =>
      useSessionMessages({
        projectId: "proj-1",
        sessionId: "sess-1",
      }),
    );

    await waitFor(() => expect(first.result.current.loading).toBe(false));
    first.unmount();
    window.localStorage.setItem(UI_KEYS.sessionTranscriptCache, "false");
    invalidateLocalStorageValues(UI_KEYS.sessionTranscriptCache);

    const second = renderHook(() =>
      useSessionMessages({
        projectId: "proj-1",
        sessionId: "sess-1",
      }),
    );

    expect(second.result.current.restoredFromSnapshot).toBe(false);
    await waitFor(() => expect(apiMocks.getSession).toHaveBeenCalledTimes(2));
    expect(apiMocks.getSession).toHaveBeenNthCalledWith(
      2,
      "proj-1",
      "sess-1",
      undefined,
      defaultInitialTailRequest(),
    );
    await waitFor(() => expect(second.result.current.loading).toBe(false));
    expect(
      second.result.current.messages.map((message) => message.uuid),
    ).toEqual(["fresh-msg"]);
  });

  it("does not use durable recap overlays as warm-cache cursors", async () => {
    enableSessionTranscriptCache();

    apiMocks.getSession.mockResolvedValueOnce({
      session: {
        provider: "claude",
        updatedAt: "2026-05-04T00:01:00.000Z",
      },
      messages: [
        {
          uuid: "msg-1",
          type: "assistant",
          timestamp: "2026-05-04T00:00:00.000Z",
          message: { role: "assistant", content: "work" },
        },
        {
          uuid: "recap-1",
          id: "recap-1",
          type: "system",
          subtype: "away_summary",
          timestamp: "2026-05-04T00:01:00.000Z",
          content: "Recap overlay.",
          yaRecapSource: "ya-synthetic",
        },
      ],
      ownership: { owner: "self" },
      pendingInputRequest: null,
      slashCommands: null,
      pagination: {
        hasOlderMessages: false,
        totalMessageCount: 2,
        returnedMessageCount: 2,
        totalCompactions: 0,
      },
    });
    apiMocks.getSession.mockResolvedValueOnce({
      session: {
        provider: "claude",
        updatedAt: "2026-05-04T00:01:00.000Z",
      },
      messages: [],
      ownership: { owner: "self" },
      pendingInputRequest: null,
      slashCommands: null,
    });

    const first = renderHook(() =>
      useSessionMessages({
        projectId: "proj-1",
        sessionId: "sess-1",
      }),
    );

    await waitFor(() => expect(first.result.current.loading).toBe(false));
    first.unmount();

    renderHook(() =>
      useSessionMessages({
        projectId: "proj-1",
        sessionId: "sess-1",
      }),
    );

    await waitFor(() => expect(apiMocks.getSession).toHaveBeenCalledTimes(2));
    expect(apiMocks.getSession).toHaveBeenNthCalledWith(
      2,
      "proj-1",
      "sess-1",
      "msg-1",
      defaultInitialTailRequest(),
    );
  });

  it("keeps warm cached messages when an incremental refresh has no delta", async () => {
    enableSessionTranscriptCache();

    apiMocks.getSession.mockResolvedValueOnce({
      session: {
        provider: "claude",
        updatedAt: "2026-05-04T00:00:00.000Z",
      },
      messages: [
        {
          uuid: "msg-1",
          type: "user",
          timestamp: "2026-05-04T00:00:00.000Z",
          message: { role: "user", content: "hello" },
        },
      ],
      ownership: { owner: "self" },
      pendingInputRequest: null,
      slashCommands: null,
      pagination: {
        hasOlderMessages: true,
        truncatedBeforeMessageId: "older-msg",
        totalMessageCount: 10,
        returnedMessageCount: 1,
        totalCompactions: 2,
      },
    });
    apiMocks.getSession.mockResolvedValueOnce({
      session: {
        provider: "claude",
        updatedAt: "2026-05-04T00:00:00.000Z",
      },
      messages: [],
      ownership: { owner: "self" },
      pendingInputRequest: null,
      slashCommands: null,
    });

    const first = renderHook(() =>
      useSessionMessages({
        projectId: "proj-1",
        sessionId: "sess-1",
      }),
    );

    await waitFor(() => expect(first.result.current.loading).toBe(false));
    first.unmount();

    const second = renderHook(() =>
      useSessionMessages({
        projectId: "proj-1",
        sessionId: "sess-1",
      }),
    );

    expect(second.result.current.loading).toBe(true);
    expect(second.result.current.messages).toEqual([]);

    await waitFor(() => expect(apiMocks.getSession).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(
        second.result.current.messages.map((message) => message.uuid),
      ).toEqual(["msg-1"]),
    );
    expect(second.result.current.pagination?.truncatedBeforeMessageId).toBe(
      "older-msg",
    );
    expect(readStoreMessageIds()).toEqual(["msg-1"]);
  });

  it("replaces a warm full window when an after-cursor refresh returns a compacted tail", async () => {
    enableSessionTranscriptCache();

    apiMocks.getSession.mockResolvedValueOnce({
      session: {
        provider: "codex",
        updatedAt: "2026-05-04T00:02:00.000Z",
      },
      messages: [
        {
          uuid: "older-msg",
          type: "user",
          timestamp: "2026-05-04T00:00:00.000Z",
          message: { role: "user", content: "older" },
        },
        {
          uuid: "tail-msg-1",
          type: "assistant",
          timestamp: "2026-05-04T00:01:00.000Z",
          message: { role: "assistant", content: "tail one" },
        },
        {
          uuid: "tail-msg-2",
          type: "assistant",
          timestamp: "2026-05-04T00:02:00.000Z",
          message: { role: "assistant", content: "tail two" },
        },
      ],
      ownership: { owner: "self" },
      pendingInputRequest: null,
      slashCommands: null,
      pagination: {
        hasOlderMessages: false,
        totalMessageCount: 3,
        returnedMessageCount: 3,
        totalCompactions: 2,
      },
    });
    apiMocks.getSession.mockResolvedValueOnce({
      session: {
        provider: "codex",
        updatedAt: "2026-05-04T00:03:00.000Z",
      },
      messages: [
        {
          uuid: "tail-msg-1",
          type: "assistant",
          timestamp: "2026-05-04T00:01:00.000Z",
          message: { role: "assistant", content: "tail one" },
        },
        {
          uuid: "tail-msg-2",
          type: "assistant",
          timestamp: "2026-05-04T00:02:00.000Z",
          message: { role: "assistant", content: "tail two" },
        },
      ],
      ownership: { owner: "self" },
      pendingInputRequest: null,
      slashCommands: null,
      pagination: {
        hasOlderMessages: true,
        truncatedBeforeMessageId: "tail-msg-1",
        totalMessageCount: 3,
        returnedMessageCount: 2,
        totalCompactions: 2,
      },
    });

    const first = renderHook(() =>
      useSessionMessages({
        projectId: "proj-1",
        sessionId: "sess-1",
      }),
    );

    await waitFor(() => expect(first.result.current.loading).toBe(false));
    expect(
      first.result.current.messages.map((message) => message.uuid),
    ).toEqual(["older-msg", "tail-msg-1", "tail-msg-2"]);
    first.unmount();

    const second = renderHook(() =>
      useSessionMessages({
        projectId: "proj-1",
        sessionId: "sess-1",
      }),
    );

    expect(second.result.current.loading).toBe(true);
    expect(second.result.current.messages).toEqual([]);
    await waitFor(() => expect(apiMocks.getSession).toHaveBeenCalledTimes(2));
    expect(apiMocks.getSession).toHaveBeenNthCalledWith(
      2,
      "proj-1",
      "sess-1",
      "tail-msg-2",
      defaultInitialTailRequest(),
    );
    await waitFor(() => expect(second.result.current.loading).toBe(false));

    expect(
      second.result.current.messages.map((message) => message.uuid),
    ).toEqual(["tail-msg-1", "tail-msg-2"]);
    expect(readStoreMessageIds()).toEqual(["tail-msg-1", "tail-msg-2"]);
    expect(second.result.current.pagination).toMatchObject({
      hasOlderMessages: true,
      totalMessageCount: 3,
      returnedMessageCount: 2,
      truncatedBeforeMessageId: "tail-msg-1",
    });
  });

  it("uses selector-backed pagination when loading older messages", async () => {
    apiMocks.getSession.mockResolvedValueOnce({
      session: {
        provider: "claude",
        updatedAt: "2026-05-04T00:00:00.000Z",
      },
      messages: [
        {
          uuid: "msg-1",
          type: "user",
          timestamp: "2026-05-04T00:00:00.000Z",
          message: { role: "user", content: "hello" },
        },
      ],
      ownership: { owner: "self" },
      pendingInputRequest: null,
      slashCommands: null,
      pagination: {
        hasOlderMessages: true,
        truncatedBeforeMessageId: "msg-1",
        totalMessageCount: 2,
        returnedMessageCount: 1,
        totalCompactions: 0,
      },
    });
    apiMocks.getSession.mockResolvedValueOnce({
      session: {
        provider: "claude",
        updatedAt: "2026-05-04T00:00:00.000Z",
      },
      messages: [
        {
          uuid: "older-msg",
          type: "assistant",
          timestamp: "2026-05-03T23:59:00.000Z",
          message: { role: "assistant", content: "before" },
        },
      ],
      ownership: { owner: "self" },
      pendingInputRequest: null,
      slashCommands: null,
      pagination: {
        hasOlderMessages: false,
        totalMessageCount: 2,
        returnedMessageCount: 2,
        totalCompactions: 0,
      },
    });

    const rendered = renderHook(() =>
      useSessionMessages({
        projectId: "proj-1",
        sessionId: "sess-1",
      }),
    );

    await waitFor(() => expect(rendered.result.current.loading).toBe(false));
    expect(rendered.result.current.pagination?.hasOlderMessages).toBe(true);
    act(() => {
      defaultSessionDetailMemoryCache.dispatch(defaultStoreEntryKey(), {
        type: "applyStreamMessage",
        message: {
          uuid: "store-only-msg",
          type: "assistant",
          timestamp: "2026-05-04T00:00:30.000Z",
          message: { role: "assistant", content: "store update" },
        },
      });
      defaultSessionDetailMemoryCache.dispatch(defaultStoreEntryKey(), {
        type: "replaceTailWindow",
        session: {
          id: "sess-1",
          projectId: "proj-1" as SessionMetadata["projectId"],
          provider: "claude",
          title: "Session",
          fullTitle: "Session",
          createdAt: "2026-05-04T00:00:00.000Z",
          updatedAt: "2026-05-04T00:00:30.000Z",
          messageCount: 2,
          ownership: { owner: "self", processId: "pid-1" },
        },
        messages: [
          {
            uuid: "msg-1",
            type: "user",
            timestamp: "2026-05-04T00:00:00.000Z",
            message: { role: "user", content: "hello" },
          },
          {
            uuid: "store-only-msg",
            type: "assistant",
            timestamp: "2026-05-04T00:00:30.000Z",
            message: { role: "assistant", content: "store update" },
          },
        ],
        pagination: {
          hasOlderMessages: true,
          truncatedBeforeMessageId: "store-cursor",
          totalMessageCount: 3,
          returnedMessageCount: 2,
          totalCompactions: 0,
        },
      });
    });
    await waitFor(() =>
      expect(
        rendered.result.current.messages.map((message) => message.uuid),
      ).toEqual(["msg-1", "store-only-msg"]),
    );

    await act(async () => {
      await rendered.result.current.loadOlderMessages();
    });

    expect(apiMocks.getSession).toHaveBeenNthCalledWith(
      2,
      "proj-1",
      "sess-1",
      undefined,
      {
        tailCompactions: 2,
        beforeMessageId: "store-cursor",
      },
    );
    expect(
      rendered.result.current.messages.map((message) => message.uuid),
    ).toEqual(["older-msg", "msg-1", "store-only-msg"]);
    expect(readStoreMessageIds()).toEqual([
      "older-msg",
      "msg-1",
      "store-only-msg",
    ]);
    expect(rendered.result.current.pagination?.hasOlderMessages).toBe(false);
    expect(rendered.result.current.pagination?.returnedMessageCount).toBe(2);
  });

  it("loads compact pages through the preceding real user turn", async () => {
    apiMocks.getSession
      .mockResolvedValueOnce({
        ...sessionResponse("current-user"),
        messages: [
          {
            uuid: "current-user",
            type: "user",
            timestamp: "2026-05-04T00:00:00.000Z",
            message: { role: "user", content: "current" },
          },
        ],
        pagination: {
          hasOlderMessages: true,
          truncatedBeforeMessageId: "current-user",
          totalMessageCount: 4,
          returnedMessageCount: 1,
          totalCompactions: 2,
        },
      })
      .mockResolvedValueOnce({
        ...sessionResponse("older-assistant"),
        pagination: {
          hasOlderMessages: true,
          truncatedBeforeMessageId: "older-assistant",
          totalMessageCount: 4,
          returnedMessageCount: 1,
          totalCompactions: 1,
        },
      })
      .mockResolvedValueOnce({
        ...sessionResponse("older-user"),
        messages: [
          {
            uuid: "older-user",
            type: "user",
            timestamp: "2026-05-03T23:58:00.000Z",
            message: { role: "user", content: "older request" },
          },
        ],
        pagination: {
          hasOlderMessages: true,
          truncatedBeforeMessageId: "older-user",
          totalMessageCount: 4,
          returnedMessageCount: 1,
          totalCompactions: 0,
        },
      });

    const rendered = renderHook(() =>
      useSessionMessages({ projectId: "proj-1", sessionId: "sess-1" }),
    );
    await waitFor(() => expect(rendered.result.current.loading).toBe(false));

    await act(async () => rendered.result.current.loadOlderMessages());

    expect(apiMocks.getSession).toHaveBeenNthCalledWith(
      2,
      "proj-1",
      "sess-1",
      undefined,
      { tailCompactions: 2, beforeMessageId: "current-user" },
    );
    expect(apiMocks.getSession).toHaveBeenNthCalledWith(
      3,
      "proj-1",
      "sess-1",
      undefined,
      { tailCompactions: 2, beforeMessageId: "older-assistant" },
    );
    expect(
      rendered.result.current.messages.map((message) => message.uuid),
    ).toEqual(["older-user", "older-assistant", "current-user"]);
    expect(rendered.result.current.olderLoadContinuationRequired).toBe(false);
  });

  it("reads older search pages through the fixed compact cursor path", async () => {
    apiMocks.getSession
      .mockResolvedValueOnce({
        ...sessionResponse("current-user"),
        pagination: {
          hasOlderMessages: true,
          truncatedBeforeMessageId: "codex-compacted-byte-500-current",
          totalMessageCount: 1,
          returnedMessageCount: 1,
          totalCompactions: 2,
        },
      })
      .mockResolvedValueOnce({
        ...sessionResponse("older-user"),
        messages: [
          {
            uuid: "older-user",
            type: "user",
            timestamp: "2026-05-03T23:58:00.000Z",
            message: { role: "user", content: "older request" },
          },
        ],
        pagination: {
          hasOlderMessages: true,
          truncatedBeforeMessageId: "codex-compacted-byte-100-older",
          totalMessageCount: 1,
          returnedMessageCount: 1,
          totalCompactions: 2,
        },
      });

    const rendered = renderHook(() =>
      useSessionMessages({ projectId: "proj-1", sessionId: "sess-1" }),
    );
    await waitFor(() => expect(rendered.result.current.loading).toBe(false));

    const page = await rendered.result.current.readOlderSearchPage(
      "codex-compacted-byte-500-current",
    );

    expect(apiMocks.getSession).toHaveBeenNthCalledWith(
      2,
      "proj-1",
      "sess-1",
      undefined,
      {
        tailCompactions: 2,
        beforeMessageId: "codex-compacted-byte-500-current",
      },
    );
    expect(page?.messages.map((message) => message.uuid)).toEqual([
      "older-user",
    ]);
    expect(
      rendered.result.current.messages.map((message) => message.uuid),
    ).toEqual(["current-user"]);
  });

  it("recovers older history after a stale pagination cursor", async () => {
    apiMocks.getSession
      .mockResolvedValueOnce({
        ...sessionResponse("stale-current"),
        pagination: {
          hasOlderMessages: true,
          truncatedBeforeMessageId: "stale-cursor",
          totalMessageCount: 3,
          returnedMessageCount: 1,
          totalCompactions: 2,
        },
      })
      .mockResolvedValueOnce({
        ...sessionResponse("empty"),
        messages: [],
        pagination: {
          hasOlderMessages: false,
          totalMessageCount: 3,
          returnedMessageCount: 0,
          totalCompactions: 0,
        },
      })
      .mockResolvedValueOnce({
        ...sessionResponse("fresh-current"),
        pagination: {
          hasOlderMessages: true,
          truncatedBeforeMessageId: "fresh-cursor",
          totalMessageCount: 3,
          returnedMessageCount: 1,
          totalCompactions: 2,
        },
      })
      .mockResolvedValueOnce({
        ...sessionResponse("older-user"),
        messages: [
          {
            uuid: "older-user",
            type: "user",
            timestamp: "2026-05-03T23:58:00.000Z",
            message: { role: "user", content: "visible older request" },
          },
        ],
        pagination: {
          hasOlderMessages: false,
          totalMessageCount: 3,
          returnedMessageCount: 2,
          totalCompactions: 0,
        },
      });

    const rendered = renderHook(() =>
      useSessionMessages({ projectId: "proj-1", sessionId: "sess-1" }),
    );
    await waitFor(() => expect(rendered.result.current.loading).toBe(false));

    await act(async () => rendered.result.current.loadOlderMessages());

    expect(apiMocks.getSession).toHaveBeenNthCalledWith(
      2,
      "proj-1",
      "sess-1",
      undefined,
      { tailCompactions: 2, beforeMessageId: "stale-cursor" },
    );
    expect(apiMocks.getSession).toHaveBeenNthCalledWith(
      3,
      "proj-1",
      "sess-1",
      undefined,
      defaultInitialTailRequest(),
    );
    expect(apiMocks.getSession).toHaveBeenNthCalledWith(
      4,
      "proj-1",
      "sess-1",
      undefined,
      { tailCompactions: 2, beforeMessageId: "fresh-cursor" },
    );
    expect(
      rendered.result.current.messages.map((message) => message.uuid),
    ).toEqual(["older-user", "fresh-current"]);
    expect(rendered.result.current.pagination?.hasOlderMessages).toBe(false);
  });

  it("keeps older history available when cursor recovery is empty", async () => {
    apiMocks.getSession
      .mockResolvedValueOnce({
        ...sessionResponse("stale-current"),
        pagination: {
          hasOlderMessages: true,
          truncatedBeforeMessageId: "stale-cursor",
          totalMessageCount: 2,
          returnedMessageCount: 1,
          totalCompactions: 2,
        },
      })
      .mockResolvedValueOnce({
        ...sessionResponse("empty-page"),
        messages: [],
      })
      .mockResolvedValueOnce({
        ...sessionResponse("empty-refresh"),
        messages: [],
      });

    const rendered = renderHook(() =>
      useSessionMessages({ projectId: "proj-1", sessionId: "sess-1" }),
    );
    await waitFor(() => expect(rendered.result.current.loading).toBe(false));

    await act(async () => rendered.result.current.loadOlderMessages());

    expect(apiMocks.getSession).toHaveBeenCalledTimes(3);
    expect(
      rendered.result.current.messages.map((message) => message.uuid),
    ).toEqual(["stale-current"]);
    expect(rendered.result.current.pagination?.hasOlderMessages).toBe(true);
  });

  it("pauses a large assistant-only history span with a resumable warning", async () => {
    apiMocks.getSession.mockResolvedValueOnce({
      ...sessionResponse("current-user"),
      messages: [
        {
          uuid: "current-user",
          type: "user",
          timestamp: "2026-05-04T00:00:00.000Z",
          message: { role: "user", content: "current" },
        },
      ],
      pagination: {
        hasOlderMessages: true,
        truncatedBeforeMessageId: "cursor-8",
        totalMessageCount: 20,
        returnedMessageCount: 1,
        totalCompactions: 9,
      },
    });
    for (let index = 8; index > 0; index -= 1) {
      apiMocks.getSession.mockResolvedValueOnce({
        ...sessionResponse(`assistant-${index}`),
        pagination: {
          hasOlderMessages: true,
          truncatedBeforeMessageId: `cursor-${index - 1}`,
          totalMessageCount: 20,
          returnedMessageCount: 1,
          totalCompactions: index,
        },
      });
    }

    const rendered = renderHook(() =>
      useSessionMessages({ projectId: "proj-1", sessionId: "sess-1" }),
    );
    await waitFor(() => expect(rendered.result.current.loading).toBe(false));

    await act(async () => rendered.result.current.loadOlderMessages());

    expect(apiMocks.getSession).toHaveBeenCalledTimes(9);
    expect(rendered.result.current.pagination).toMatchObject({
      hasOlderMessages: true,
      truncatedBeforeMessageId: "cursor-0",
    });
    expect(rendered.result.current.olderLoadContinuationRequired).toBe(true);
  });

  it("mirrors incremental catch-up messages into the session detail store", async () => {
    const onTranscriptReconciled = vi.fn();
    apiMocks.getSession.mockResolvedValueOnce({
      session: {
        provider: "claude",
        updatedAt: "2026-05-04T00:00:00.000Z",
      },
      messages: [
        {
          uuid: "msg-1",
          type: "user",
          timestamp: "2026-05-04T00:00:00.000Z",
          message: { role: "user", content: "hello" },
        },
      ],
      transcriptSnapshotUpdatedAt: "2026-05-04T00:00:00.000Z",
      ownership: { owner: "self" },
      pendingInputRequest: null,
      slashCommands: null,
      pagination: {
        hasOlderMessages: false,
        totalMessageCount: 1,
        returnedMessageCount: 1,
        totalCompactions: 0,
      },
    });

    const { result } = renderHook(() =>
      useSessionMessages({
        projectId: "proj-1",
        sessionId: "sess-1",
        onTranscriptReconciled,
      }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(onTranscriptReconciled).toHaveBeenCalledWith(
      "2026-05-04T00:00:00.000Z",
    );
    onTranscriptReconciled.mockClear();

    act(() => {
      defaultSessionDetailMemoryCache.dispatch(defaultStoreEntryKey(), {
        type: "applyStreamMessage",
        message: {
          uuid: "store-only-msg",
          type: "assistant",
          timestamp: "2026-05-04T00:00:30.000Z",
          message: { role: "assistant", content: "store update" },
        },
      });
    });
    await waitFor(() =>
      expect(result.current.messages.map((message) => message.uuid)).toEqual([
        "msg-1",
        "store-only-msg",
      ]),
    );

    apiMocks.getSession.mockClear();
    apiMocks.getSession.mockResolvedValueOnce({
      session: {
        provider: "claude",
        updatedAt: "2026-05-04T00:01:00.000Z",
      },
      messages: [
        {
          uuid: "msg-2",
          type: "assistant",
          timestamp: "2026-05-04T00:01:00.000Z",
          message: { role: "assistant", content: "hi" },
        },
      ],
      transcriptSnapshotUpdatedAt: "2026-05-04T00:00:59.000Z",
      ownership: { owner: "self" },
      pendingInputRequest: null,
      slashCommands: null,
    });

    await act(async () => {
      await result.current.fetchNewMessages();
    });

    expect(apiMocks.getSession).toHaveBeenCalledWith(
      "proj-1",
      "sess-1",
      "msg-1",
    );
    expect(result.current.messages.map((message) => message.uuid)).toEqual([
      "msg-1",
      "store-only-msg",
      "msg-2",
    ]);
    expect(readStoreMessageIds()).toEqual(["msg-1", "store-only-msg", "msg-2"]);
    expect(onTranscriptReconciled).toHaveBeenCalledWith(
      "2026-05-04T00:00:59.000Z",
    );
  });

  it("retries a failed cold reveal on recovery and opens its stream gate", async () => {
    const onLoadComplete = vi.fn();
    const onLoadError = vi.fn();
    apiMocks.getSession.mockRejectedValueOnce(new Error("offline"));
    const { result } = renderHook(() =>
      useSessionMessages({
        projectId: "proj-1",
        sessionId: "sess-1",
        onLoadComplete,
        onLoadError,
      }),
    );
    await waitFor(() => expect(onLoadError).toHaveBeenCalledOnce());
    expect(result.current.loading).toBe(false);
    apiMocks.getSession.mockResolvedValue(sessionResponse("recovered"));
    await act(async () => result.current.fetchNewMessages());
    await waitFor(() => expect(onLoadComplete).toHaveBeenCalledOnce());
    expect(result.current.messages.map((message) => message.uuid)).toEqual([
      "recovered",
    ]);
    expect(result.current.loading).toBe(false);
  });

  it("does not advance the transcript watermark for an empty delta", async () => {
    const onTranscriptReconciled = vi.fn();
    apiMocks.getSession.mockResolvedValueOnce(sessionResponse("msg-1"));

    const { result } = renderHook(() =>
      useSessionMessages({
        projectId: "proj-1",
        sessionId: "sess-1",
        onTranscriptReconciled,
      }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    onTranscriptReconciled.mockClear();

    apiMocks.getSession.mockResolvedValueOnce({
      ...sessionResponse("unused"),
      messages: [],
      transcriptSnapshotUpdatedAt: "2026-05-04T00:01:00.000Z",
    });
    await act(async () => result.current.fetchNewMessages());

    expect(onTranscriptReconciled).not.toHaveBeenCalled();
  });

  it("takes a rewind's regrouping from the server's tail projection in place", async () => {
    const row = (uuid: string, type: "user" | "assistant", extra = {}) => ({
      uuid,
      type,
      timestamp: "2026-05-04T00:00:00.000Z",
      message: { role: type, content: uuid },
      ...extra,
    });
    const loaded = sessionResponse("unused");
    apiMocks.getSession.mockResolvedValueOnce({
      ...loaded,
      messages: [
        row("u1", "user"),
        row("a1", "assistant"),
        row("u2", "user"),
        row("a2", "assistant"),
      ],
    });
    const { result } = renderHook(() =>
      useSessionMessages({ projectId: "proj-1", sessionId: "sess-1" }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    // The server's projection groups the dropped turn behind its header; the
    // client applies that membership as served rather than computing it.
    const grouped = { rewoundGroupId: "rw-1" };
    apiMocks.getSession.mockClear();
    apiMocks.getSession.mockResolvedValueOnce({
      ...loaded,
      messages: [
        row("u1", "user"),
        row("a1", "assistant"),
        {
          type: "system",
          subtype: "rewound_group",
          uuid: "rewound-group-rw-1",
          parentUuid: "a1",
          timestamp: "2026-05-04T00:00:00.000Z",
          isSynthetic: true,
          ...grouped,
        },
        row("u2", "user", grouped),
        row("a2", "assistant", grouped),
      ],
    });
    await act(async () => result.current.refreshTranscriptTail());

    expect(apiMocks.getSession).toHaveBeenCalledTimes(1);
    expect(apiMocks.getSession).toHaveBeenCalledWith(
      "proj-1",
      "sess-1",
      undefined,
      expect.objectContaining({ tailCompactions: expect.any(Number) }),
    );
    expect(result.current.loading).toBe(false);
    expect(
      result.current.messages.map((message) => [
        message.uuid,
        (message as { rewoundGroupId?: string }).rewoundGroupId,
      ]),
    ).toEqual([
      ["u1", undefined],
      ["a1", undefined],
      ["rewound-group-rw-1", "rw-1"],
      ["u2", "rw-1"],
      ["a2", "rw-1"],
    ]);
  });

  it("reloads the session when the tail projection cannot be fetched", async () => {
    apiMocks.getSession.mockResolvedValueOnce(sessionResponse("msg-1"));
    const { result } = renderHook(() =>
      useSessionMessages({ projectId: "proj-1", sessionId: "sess-1" }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    apiMocks.getSession.mockClear();
    apiMocks.getSession
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(sessionResponse("msg-2"));
    await act(async () => result.current.refreshTranscriptTail());

    await waitFor(() =>
      expect(result.current.messages.map((message) => message.uuid)).toEqual([
        "msg-2",
      ]),
    );
    expect(apiMocks.getSession).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent incremental refreshes into one trailing pass", async () => {
    apiMocks.getSession.mockResolvedValueOnce({
      session: {
        provider: "claude",
        updatedAt: "2026-05-04T00:00:00.000Z",
      },
      messages: [
        {
          uuid: "msg-1",
          type: "user",
          timestamp: "2026-05-04T00:00:00.000Z",
          message: { role: "user", content: "hello" },
        },
      ],
      ownership: { owner: "self" },
      pendingInputRequest: null,
      slashCommands: null,
      pagination: {
        hasOlderMessages: false,
        totalMessageCount: 1,
        returnedMessageCount: 1,
        totalCompactions: 0,
      },
    });

    const { result } = renderHook(() =>
      useSessionMessages({
        projectId: "proj-1",
        sessionId: "sess-1",
      }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    apiMocks.getSession.mockClear();
    let resolveRefresh!: (value: unknown) => void;
    const refreshPromise = new Promise((resolve) => {
      resolveRefresh = resolve;
    });
    apiMocks.getSession
      .mockReturnValueOnce(refreshPromise)
      .mockResolvedValueOnce({
        session: {
          provider: "claude",
          updatedAt: "2026-05-04T00:01:00.000Z",
        },
        messages: [],
        ownership: { owner: "self" },
        pendingInputRequest: null,
        slashCommands: null,
      });

    const first = result.current.fetchNewMessages();
    const second = result.current.fetchNewMessages();

    expect(second).toBe(first);
    expect(apiMocks.getSession).toHaveBeenCalledTimes(1);
    expect(apiMocks.getSession).toHaveBeenCalledWith(
      "proj-1",
      "sess-1",
      "msg-1",
    );

    await act(async () => {
      resolveRefresh({
        session: {
          provider: "claude",
          updatedAt: "2026-05-04T00:01:00.000Z",
        },
        messages: [],
        ownership: { owner: "self" },
        pendingInputRequest: null,
        slashCommands: null,
      });
      await Promise.all([first, second]);
    });

    expect(apiMocks.getSession).toHaveBeenCalledTimes(2);
  });

  it("reconciles the bounded tail after an incremental refresh fails", async () => {
    apiMocks.getSession.mockResolvedValueOnce(sessionResponse("msg-1"));
    const diagnostic = vi.spyOn(console, "info").mockImplementation(() => {});
    const { result } = renderHook(() =>
      useSessionMessages({
        projectId: "proj-1",
        sessionId: "sess-1",
      }),
    );

    try {
      await waitFor(() => expect(result.current.loading).toBe(false));
      apiMocks.getSession.mockClear();
      apiMocks.getSession
        .mockRejectedValueOnce(new Error("incremental anchor failed"))
        .mockResolvedValueOnce(activeWindowSessionResponse(2));

      await act(async () => {
        await result.current.fetchNewMessages();
      });

      expect(apiMocks.getSession).toHaveBeenNthCalledWith(
        1,
        "proj-1",
        "sess-1",
        "msg-1",
      );
      expect(apiMocks.getSession).toHaveBeenNthCalledWith(
        2,
        "proj-1",
        "sess-1",
        undefined,
        defaultInitialTailRequest(),
      );
      expect(result.current.messages.map((message) => message.uuid)).toEqual([
        "user-0",
        "user-1",
      ]);
      expect(diagnostic).toHaveBeenCalledWith(
        "[SessionIncrementalRefresh]",
        expect.objectContaining({
          event: "incremental-refresh-reconciliation",
          outcome: "recovered",
          afterMessageId: "msg-1",
          incrementalError: "incremental anchor failed",
        }),
      );
    } finally {
      diagnostic.mockRestore();
    }
  });

  it("bounds failed reconciliation and rate-limits its diagnostic", async () => {
    apiMocks.getSession.mockResolvedValueOnce(sessionResponse("msg-1"));
    const diagnostic = vi.spyOn(console, "info").mockImplementation(() => {});
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const { result } = renderHook(() =>
      useSessionMessages({
        projectId: "proj-1",
        sessionId: "sess-1",
      }),
    );

    try {
      await waitFor(() => expect(result.current.loading).toBe(false));
      apiMocks.getSession.mockClear();
      apiMocks.getSession
        .mockRejectedValueOnce(new Error("incremental failed 1"))
        .mockRejectedValueOnce(new Error("reconciliation failed 1"))
        .mockRejectedValueOnce(new Error("incremental failed 2"))
        .mockRejectedValueOnce(new Error("reconciliation failed 2"))
        .mockRejectedValueOnce(new Error("incremental failed 3"))
        .mockRejectedValueOnce(new Error("reconciliation failed 3"));

      await act(async () => {
        await result.current.fetchNewMessages();
      });
      await act(async () => {
        await result.current.fetchNewMessages();
      });

      expect(apiMocks.getSession).toHaveBeenCalledTimes(4);
      expect(diagnostic).toHaveBeenCalledTimes(1);
      now.mockReturnValue(31_001);
      await act(async () => {
        await result.current.fetchNewMessages();
      });

      expect(apiMocks.getSession).toHaveBeenCalledTimes(6);
      expect(diagnostic).toHaveBeenCalledTimes(2);
      expect(diagnostic).toHaveBeenNthCalledWith(
        1,
        "[SessionIncrementalRefresh]",
        expect.objectContaining({
          event: "incremental-refresh-reconciliation",
          outcome: "failed",
          afterMessageId: "msg-1",
          incrementalError: "incremental failed 1",
          reconciliationError: "reconciliation failed 1",
        }),
      );
      expect(diagnostic).toHaveBeenNthCalledWith(
        2,
        "[SessionIncrementalRefresh]",
        expect.objectContaining({
          event: "incremental-refresh-reconciliation",
          outcome: "failed",
          afterMessageId: "msg-1",
          incrementalError: "incremental failed 3",
          reconciliationError: "reconciliation failed 3",
          suppressedCount: 1,
        }),
      );
      expect(result.current.messages.map((message) => message.uuid)).toEqual([
        "msg-1",
      ]);
    } finally {
      now.mockRestore();
      diagnostic.mockRestore();
    }
  });

  it("suppresses Codex live streaming messages when response streaming is disabled", async () => {
    apiMocks.getSession.mockResolvedValueOnce({
      session: {
        provider: "codex",
        updatedAt: "2026-05-04T00:00:00.000Z",
      },
      messages: [],
      ownership: { owner: "self" },
      pendingInputRequest: null,
      slashCommands: null,
      pagination: {
        hasOlderMessages: false,
        totalMessageCount: 0,
        returnedMessageCount: 0,
        totalCompactions: 0,
      },
    });

    const { result } = renderHook(() =>
      useSessionMessages({
        projectId: "proj-1",
        sessionId: "sess-1",
      }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.handleStreamMessageEvent({
        uuid: "codex-item-1",
        type: "assistant",
        _isStreaming: true,
        message: { role: "assistant", content: "Hel" },
      });
    });
    expect(result.current.messages).toHaveLength(1);

    (getStreamingEnabled as Mock).mockReturnValue(false);

    act(() => {
      result.current.handleStreamMessageEvent({
        uuid: "codex-item-1",
        type: "assistant",
        _isStreaming: true,
        message: { role: "assistant", content: "Hello" },
      });
    });
    expect(result.current.messages).toEqual([]);

    act(() => {
      result.current.handleStreamMessageEvent({
        uuid: "codex-item-1",
        type: "assistant",
        message: { role: "assistant", content: "Hello" },
      });
    });

    expect(result.current.messages).toMatchObject([
      {
        uuid: "codex-item-1",
        type: "assistant",
        message: { content: "Hello" },
      },
    ]);
  });

  it("suppresses buffered Codex live streaming messages when response streaming is disabled", async () => {
    (getStreamingEnabled as Mock).mockReturnValue(false);

    let resolveLoad!: (value: unknown) => void;
    apiMocks.getSession.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveLoad = resolve;
      }),
    );

    const { result } = renderHook(() =>
      useSessionMessages({
        projectId: "proj-1",
        sessionId: "sess-1",
      }),
    );

    act(() => {
      result.current.handleStreamMessageEvent({
        uuid: "codex-buffered-1",
        type: "assistant",
        _isStreaming: true,
        message: { role: "assistant", content: "partial" },
      });
    });

    await act(async () => {
      resolveLoad({
        session: {
          provider: "codex",
          updatedAt: "2026-05-04T00:00:00.000Z",
        },
        messages: [],
        ownership: { owner: "self" },
        pendingInputRequest: null,
        slashCommands: null,
        pagination: {
          hasOlderMessages: false,
          totalMessageCount: 0,
          returnedMessageCount: 0,
          totalCompactions: 0,
        },
      });
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.messages).toEqual([]);
  });

  it("suppresses Codex subagent live streaming messages when response streaming is disabled", async () => {
    apiMocks.getSession.mockResolvedValueOnce({
      session: {
        provider: "codex",
        updatedAt: "2026-05-04T00:00:00.000Z",
      },
      messages: [],
      ownership: { owner: "self" },
      pendingInputRequest: null,
      slashCommands: null,
      pagination: {
        hasOlderMessages: false,
        totalMessageCount: 0,
        returnedMessageCount: 0,
        totalCompactions: 0,
      },
    });

    const { result } = renderHook(() =>
      useSessionMessages({
        projectId: "proj-1",
        sessionId: "sess-1",
      }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.handleStreamSubagentMessage(
        {
          uuid: "codex-subagent-1",
          type: "assistant",
          _isStreaming: true,
          message: { role: "assistant", content: "partial" },
        },
        "task-1",
      );
    });
    expect(result.current.agentContent["task-1"]?.messages).toHaveLength(1);

    (getStreamingEnabled as Mock).mockReturnValue(false);

    act(() => {
      result.current.handleStreamSubagentMessage(
        {
          uuid: "codex-subagent-1",
          type: "assistant",
          _isStreaming: true,
          message: { role: "assistant", content: "partial done" },
        },
        "task-1",
      );
    });

    expect(result.current.agentContent).toEqual({});

    act(() => {
      result.current.handleStreamSubagentMessage(
        {
          uuid: "codex-subagent-1",
          type: "assistant",
          message: { role: "assistant", content: "done" },
        },
        "task-1",
      );
    });

    expect(result.current.agentContent["task-1"]?.messages).toMatchObject([
      {
        uuid: "codex-subagent-1",
        message: { content: "done" },
      },
    ]);
  });

  it("mirrors subagent stream events from the session detail store", async () => {
    apiMocks.getSession.mockResolvedValueOnce({
      session: {
        provider: "codex",
        updatedAt: "2026-05-04T00:00:00.000Z",
      },
      messages: [],
      ownership: { owner: "self" },
      pendingInputRequest: null,
      slashCommands: null,
      pagination: {
        hasOlderMessages: false,
        totalMessageCount: 0,
        returnedMessageCount: 0,
        totalCompactions: 0,
      },
    });

    const { result } = renderHook(() =>
      useSessionMessages({
        projectId: "proj-1",
        sessionId: "sess-1",
      }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    const storeOnlyMessage: Message = {
      uuid: "agent-store-only-1",
      type: "assistant",
      message: { role: "assistant", content: "store only" },
    };
    const streamMessage: Message = {
      uuid: "agent-stream-1",
      type: "assistant",
      message: { role: "assistant", content: "stream" },
    };

    act(() => {
      defaultSessionDetailMemoryCache.dispatch(defaultStoreEntryKey(), {
        type: "mergeLoadedAgentContent",
        agentId: "task-store",
        content: {
          messages: [storeOnlyMessage],
          status: "completed",
        },
      });
      result.current.handleStreamSubagentMessage(streamMessage, "task-1");
    });

    expect(result.current.agentContent["task-store"]).toEqual({
      messages: [storeOnlyMessage],
      status: "completed",
    });
    expect(result.current.agentContent["task-1"]).toEqual({
      messages: [streamMessage],
      status: "running",
    });
    expect(
      defaultSessionDetailMemoryCache.read(defaultStoreEntryKey())
        ?.agentContent,
    ).toMatchObject({
      "task-1": {
        messages: [streamMessage],
        status: "running",
      },
      "task-store": {
        messages: [storeOnlyMessage],
        status: "completed",
      },
    });
  });

  it("upserts main streaming placeholders through the session detail store", async () => {
    apiMocks.getSession.mockResolvedValueOnce({
      session: {
        provider: "codex",
        updatedAt: "2026-05-04T00:00:00.000Z",
      },
      messages: [],
      ownership: { owner: "self" },
      pendingInputRequest: null,
      slashCommands: null,
      pagination: {
        hasOlderMessages: false,
        totalMessageCount: 0,
        returnedMessageCount: 0,
        totalCompactions: 0,
      },
    });

    const { result } = renderHook(() =>
      useSessionMessages({
        projectId: "proj-1",
        sessionId: "sess-1",
      }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    const first: Message = {
      uuid: "streaming-1",
      type: "assistant",
      _isStreaming: true,
      message: { role: "assistant", content: "partial" },
    };
    const updated: Message = {
      ...first,
      message: { role: "assistant", content: "partial done" },
    };
    const storeOnlyMessage: Message = {
      uuid: "store-only-1",
      type: "user",
      message: { role: "user", content: "store-only" },
    };

    act(() => {
      defaultSessionDetailMemoryCache.dispatch(defaultStoreEntryKey(), {
        type: "applyStreamMessage",
        message: storeOnlyMessage,
      });
      result.current.handleStreamingUpdate(first);
      result.current.handleStreamingUpdate(updated);
    });

    expect(result.current.messages.map((message) => message.uuid)).toEqual([
      "store-only-1",
      "streaming-1",
    ]);
    expect(result.current.messages[0]?._source).toBe("sdk");
    expect(result.current.messages[1]).toEqual(updated);
    expect(
      defaultSessionDetailMemoryCache
        .read(defaultStoreEntryKey())
        ?.messages.map((message) => message.uuid),
    ).toEqual(["store-only-1", "streaming-1"]);
  });

  it("clears main streaming placeholders through the session detail store", async () => {
    apiMocks.getSession.mockResolvedValueOnce({
      session: {
        provider: "codex",
        updatedAt: "2026-05-04T00:00:00.000Z",
      },
      messages: [
        {
          uuid: "durable-1",
          type: "assistant",
          message: { role: "assistant", content: "done" },
        },
      ],
      ownership: { owner: "self" },
      pendingInputRequest: null,
      slashCommands: null,
      pagination: {
        hasOlderMessages: false,
        totalMessageCount: 1,
        returnedMessageCount: 1,
        totalCompactions: 0,
      },
    });

    const { result } = renderHook(() =>
      useSessionMessages({
        projectId: "proj-1",
        sessionId: "sess-1",
      }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    const streaming: Message = {
      uuid: "streaming-1",
      type: "assistant",
      _isStreaming: true,
      message: { role: "assistant", content: "partial" },
    };
    const storeOnlyMessage: Message = {
      uuid: "store-only-1",
      type: "assistant",
      message: { role: "assistant", content: "store-only" },
    };

    act(() => {
      result.current.handleStreamingUpdate(streaming);
      defaultSessionDetailMemoryCache.dispatch(defaultStoreEntryKey(), {
        type: "applyStreamMessage",
        message: storeOnlyMessage,
      });
      result.current.clearStreamingPlaceholders();
    });

    expect(result.current.messages.map((message) => message.uuid)).toEqual([
      "durable-1",
      "store-only-1",
    ]);
    expect(
      defaultSessionDetailMemoryCache
        .read(defaultStoreEntryKey())
        ?.messages.map((message) => message.uuid),
    ).toEqual(["durable-1", "store-only-1"]);
  });

  it("updates session metadata through the session detail store", async () => {
    apiMocks.getSession.mockResolvedValueOnce({
      session: {
        id: "sess-1",
        projectId: "proj-1",
        provider: "codex",
        title: "Before",
        updatedAt: "2026-05-04T00:00:00.000Z",
      },
      messages: [],
      ownership: { owner: "self" },
      pendingInputRequest: null,
      slashCommands: null,
      pagination: {
        hasOlderMessages: false,
        totalMessageCount: 0,
        returnedMessageCount: 0,
        totalCompactions: 0,
      },
    });

    const { result } = renderHook(() =>
      useSessionMessages({
        projectId: "proj-1",
        sessionId: "sess-1",
      }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.updateSession((previous) =>
        previous
          ? {
              ...previous,
              title: "After",
              model: "gpt-5.4",
            }
          : previous,
      );
    });

    expect(result.current.session).toMatchObject({
      title: "After",
      model: "gpt-5.4",
    });
    expect(
      defaultSessionDetailMemoryCache.read(defaultStoreEntryKey())?.session,
    ).toMatchObject({
      title: "After",
      model: "gpt-5.4",
    });
  });

  it("defers discovery metadata until initial load and preserves transcript identity across coalesced updates", async () => {
    enableSessionTranscriptCache();
    window.localStorage.setItem(
      UI_KEYS.sessionScrollBehavior,
      "remember-place",
    );
    invalidateLocalStorageValues(UI_KEYS.sessionScrollBehavior);
    let releaseInitial!: (value: GetSessionResult) => void;
    apiMocks.getSession.mockImplementationOnce(
      () =>
        new Promise<GetSessionResult>((resolve) => {
          releaseInitial = resolve;
        }),
    );
    let releaseMetadata!: (value: unknown) => void;
    apiMocks.getSessionMetadata.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseMetadata = resolve;
        }),
    );
    const child = {
      id: "native-child",
      parentSessionId: "sess-1",
      title: "Reviewer",
      updatedAt: "2026-11-04T00:00:00.000Z",
    };
    apiMocks.getSessionMetadata.mockResolvedValueOnce({
      session: { providerChildren: [child] },
    });
    const { result } = renderHook(() =>
      useSessionMessages({ projectId: "proj-1", sessionId: "sess-1" }),
    );
    await act(async () => {
      await result.current.fetchSessionMetadata();
    });
    expect(apiMocks.getSessionMetadata).not.toHaveBeenCalled();
    await act(async () => {
      releaseInitial(sessionResponse("original-message"));
    });
    await waitFor(() =>
      expect(apiMocks.getSessionMetadata).toHaveBeenCalledTimes(1),
    );
    const messages = result.current.messages;
    const scroll = scrollSnapshot();
    act(() => result.current.updateRouteScrollSnapshot(scroll));
    // More commits while a reply is in flight require one later read, since the
    // first reply can predate those commits. They do not refetch the transcript.
    let refresh!: Promise<void>;
    act(() => {
      refresh = result.current.fetchSessionMetadata();
    });
    await act(async () => {
      releaseMetadata({ session: { providerChildren: [] } });
      await refresh;
    });
    await waitFor(() =>
      expect(result.current.session?.providerChildren).toEqual([child]),
    );
    expect(apiMocks.getSessionMetadata).toHaveBeenCalledTimes(2);
    expect(apiMocks.getSession).toHaveBeenCalledTimes(1);
    expect(result.current.messages).toBe(messages);
    expect(
      defaultSessionDetailMemoryCache.readScrollSnapshot(
        defaultStoreEntryKey(),
      ),
    ).toEqual(scroll);
    const acceptedSession = result.current.session;
    apiMocks.getSessionMetadata.mockResolvedValueOnce({
      session: { providerChildren: [{ ...child }] },
    });
    await act(async () => {
      await result.current.fetchSessionMetadata();
    });
    expect(result.current.session).toBe(acceptedSession);
    // An older server omitting the optional projection cannot erase known data.
    apiMocks.getSessionMetadata.mockResolvedValueOnce({ session: {} });
    await act(async () => {
      await result.current.fetchSessionMetadata();
    });
    expect(result.current.session).toBe(acceptedSession);
  });

  it("does not publish a retired source's discovery reply after navigation", async () => {
    apiMocks.getSession.mockResolvedValueOnce(sessionResponse("first-message"));
    const rendered = renderHook(
      ({ sessionId }) => useSessionMessages({ projectId: "proj-1", sessionId }),
      { initialProps: { sessionId: "sess-1" } },
    );
    await waitFor(() => expect(rendered.result.current.loading).toBe(false));
    let release!: (value: unknown) => void;
    apiMocks.getSessionMetadata.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    let pending!: Promise<void>;
    act(() => {
      pending = rendered.result.current.fetchSessionMetadata();
    });
    const next = sessionResponse("next-message");
    next.session.id = "sess-2";
    apiMocks.getSession.mockResolvedValueOnce(next);
    rendered.rerender({ sessionId: "sess-2" });
    await waitFor(() =>
      expect(rendered.result.current.session?.id).toBe("sess-2"),
    );
    await act(async () => {
      release({ session: { providerChildren: [] } });
      await pending;
    });
    expect(rendered.result.current.session?.providerChildren).toBeUndefined();
    expect(rendered.result.current.messages[0]?.uuid).toBe("next-message");
  });

  it("holds metadata after a fast warm HTTP reply until cached hydration applies", async () => {
    enableSessionTranscriptCache();
    apiMocks.getSession.mockResolvedValueOnce(
      sessionResponse("cached-message"),
    );
    const first = renderHook(() =>
      useSessionMessages({ projectId: "proj-1", sessionId: "sess-1" }),
    );
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    first.unmount();
    const reply = sessionResponse("cached-message");
    reply.session.providerChildren = [];
    apiMocks.getSession.mockResolvedValueOnce(reply);
    apiMocks.getSessionMetadata.mockReset();
    const children = [
      {
        id: "new-child",
        parentSessionId: "sess-1",
        updatedAt: "2026-11-04T00:00:00.000Z",
      },
    ];
    apiMocks.getSessionMetadata.mockResolvedValue({
      session: { providerChildren: children },
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const warm = renderHook(() =>
        useSessionMessages({ projectId: "proj-1", sessionId: "sess-1" }),
      );
      await act(async () => {
        for (let i = 0; i < 10; i++) await Promise.resolve();
      });
      expect(warm.result.current.loading).toBe(true);
      await act(async () => {
        await warm.result.current.fetchSessionMetadata();
      });
      expect(apiMocks.getSessionMetadata).not.toHaveBeenCalled();
      await act(async () => {
        await vi.runOnlyPendingTimersAsync();
      });
      expect(warm.result.current.loading).toBe(false);
      expect(warm.result.current.session?.providerChildren).toEqual(children);
      expect(
        warm.result.current.messages.map((message) => message.uuid),
      ).toEqual(["cached-message"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("mirrors loaded subagent content from the session detail store", async () => {
    apiMocks.getSession.mockResolvedValueOnce({
      session: {
        provider: "codex",
        updatedAt: "2026-05-04T00:00:00.000Z",
      },
      messages: [],
      ownership: { owner: "self" },
      pendingInputRequest: null,
      slashCommands: null,
      pagination: {
        hasOlderMessages: false,
        totalMessageCount: 0,
        returnedMessageCount: 0,
        totalCompactions: 0,
      },
    });

    const { result } = renderHook(() =>
      useSessionMessages({
        projectId: "proj-1",
        sessionId: "sess-1",
      }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    const loadedMessage: Message = {
      uuid: "agent-loaded-1",
      type: "assistant",
      message: { role: "assistant", content: "loaded" },
    };
    const storeOnlyMessage: Message = {
      uuid: "agent-store-only-1",
      type: "assistant",
      message: { role: "assistant", content: "store only" },
    };

    act(() => {
      defaultSessionDetailMemoryCache.dispatch(defaultStoreEntryKey(), {
        type: "mergeLoadedAgentContent",
        agentId: "task-store",
        content: {
          messages: [storeOnlyMessage],
          status: "completed",
        },
      });
      result.current.mergeLoadedAgentContent("task-1", {
        messages: [loadedMessage],
        status: "completed",
      });
    });

    expect(result.current.agentContent["task-store"]).toEqual({
      messages: [storeOnlyMessage],
      status: "completed",
    });
    expect(result.current.agentContent["task-1"]).toEqual({
      messages: [loadedMessage],
      status: "completed",
    });
    expect(
      defaultSessionDetailMemoryCache.read(defaultStoreEntryKey())
        ?.agentContent,
    ).toMatchObject({
      "task-1": {
        messages: [loadedMessage],
        status: "completed",
      },
      "task-store": {
        messages: [storeOnlyMessage],
        status: "completed",
      },
    });
  });

  it("mirrors agent context usage from the session detail store", async () => {
    apiMocks.getSession.mockResolvedValueOnce({
      session: {
        provider: "codex",
        updatedAt: "2026-05-04T00:00:00.000Z",
      },
      messages: [],
      ownership: { owner: "self" },
      pendingInputRequest: null,
      slashCommands: null,
      pagination: {
        hasOlderMessages: false,
        totalMessageCount: 0,
        returnedMessageCount: 0,
        totalCompactions: 0,
      },
    });

    const { result } = renderHook(() =>
      useSessionMessages({
        projectId: "proj-1",
        sessionId: "sess-1",
      }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    const contextUsage = { inputTokens: 1200, percentage: 24 };
    const storeOnlyMessage: Message = {
      uuid: "agent-store-only-1",
      type: "assistant",
      message: { role: "assistant", content: "store only" },
    };

    act(() => {
      defaultSessionDetailMemoryCache.dispatch(defaultStoreEntryKey(), {
        type: "mergeLoadedAgentContent",
        agentId: "task-store",
        content: {
          messages: [storeOnlyMessage],
          status: "completed",
        },
      });
      result.current.updateAgentContextUsage("task-1", contextUsage);
    });

    expect(result.current.agentContent["task-store"]).toEqual({
      messages: [storeOnlyMessage],
      status: "completed",
    });
    expect(result.current.agentContent["task-1"]).toEqual({
      messages: [],
      status: "running",
      contextUsage,
    });
    expect(
      defaultSessionDetailMemoryCache.read(defaultStoreEntryKey())
        ?.agentContent,
    ).toMatchObject({
      "task-1": {
        messages: [],
        status: "running",
        contextUsage,
      },
      "task-store": {
        messages: [storeOnlyMessage],
        status: "completed",
      },
    });
  });

  it("upserts subagent streaming placeholders through the session detail store", async () => {
    apiMocks.getSession.mockResolvedValueOnce({
      session: {
        provider: "codex",
        updatedAt: "2026-05-04T00:00:00.000Z",
      },
      messages: [],
      ownership: { owner: "self" },
      pendingInputRequest: null,
      slashCommands: null,
      pagination: {
        hasOlderMessages: false,
        totalMessageCount: 0,
        returnedMessageCount: 0,
        totalCompactions: 0,
      },
    });

    const { result } = renderHook(() =>
      useSessionMessages({
        projectId: "proj-1",
        sessionId: "sess-1",
      }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    const first: Message = {
      uuid: "agent-streaming-1",
      type: "assistant",
      _isStreaming: true,
      message: { role: "assistant", content: "partial" },
    };
    const updated: Message = {
      ...first,
      message: { role: "assistant", content: "partial done" },
    };
    const storeOnlyMessage: Message = {
      uuid: "agent-store-only-1",
      type: "assistant",
      message: { role: "assistant", content: "store only" },
    };

    act(() => {
      defaultSessionDetailMemoryCache.dispatch(defaultStoreEntryKey(), {
        type: "mergeLoadedAgentContent",
        agentId: "task-store",
        content: {
          messages: [storeOnlyMessage],
          status: "completed",
        },
      });
      result.current.handleStreamingUpdate(first, "task-1");
      result.current.handleStreamingUpdate(updated, "task-1");
    });

    expect(result.current.agentContent["task-store"]).toEqual({
      messages: [storeOnlyMessage],
      status: "completed",
    });
    expect(result.current.agentContent["task-1"]).toEqual({
      messages: [updated],
      status: "running",
    });
    expect(
      defaultSessionDetailMemoryCache.read(defaultStoreEntryKey())
        ?.agentContent["task-1"],
    ).toEqual({
      messages: [updated],
      status: "running",
    });
  });

  it("clears subagent streaming placeholders through the session detail store", async () => {
    apiMocks.getSession.mockResolvedValueOnce({
      session: {
        provider: "codex",
        updatedAt: "2026-05-04T00:00:00.000Z",
      },
      messages: [],
      ownership: { owner: "self" },
      pendingInputRequest: null,
      slashCommands: null,
      pagination: {
        hasOlderMessages: false,
        totalMessageCount: 0,
        returnedMessageCount: 0,
        totalCompactions: 0,
      },
    });

    const { result } = renderHook(() =>
      useSessionMessages({
        projectId: "proj-1",
        sessionId: "sess-1",
      }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    const durableMessage: Message = {
      uuid: "agent-durable-1",
      type: "assistant",
      message: { role: "assistant", content: "done" },
    };
    const streamingMessage: Message = {
      uuid: "agent-streaming-1",
      type: "assistant",
      _isStreaming: true,
      message: { role: "assistant", content: "partial" },
    };
    const storeOnlyMessage: Message = {
      uuid: "agent-store-only-1",
      type: "assistant",
      message: { role: "assistant", content: "store only" },
    };

    act(() => {
      result.current.mergeLoadedAgentContent("task-1", {
        messages: [durableMessage, streamingMessage],
        status: "running",
      });
      defaultSessionDetailMemoryCache.dispatch(defaultStoreEntryKey(), {
        type: "mergeLoadedAgentContent",
        agentId: "task-store",
        content: {
          messages: [storeOnlyMessage],
          status: "completed",
        },
      });
      result.current.clearAgentStreamingPlaceholders("task-1");
    });

    expect(result.current.agentContent["task-store"]).toEqual({
      messages: [storeOnlyMessage],
      status: "completed",
    });
    expect(result.current.agentContent["task-1"]).toEqual({
      messages: [durableMessage],
      status: "running",
    });
    expect(
      defaultSessionDetailMemoryCache.read(defaultStoreEntryKey())
        ?.agentContent,
    ).toMatchObject({
      "task-1": {
        messages: [durableMessage],
        status: "running",
      },
      "task-store": {
        messages: [storeOnlyMessage],
        status: "completed",
      },
    });
  });
});
