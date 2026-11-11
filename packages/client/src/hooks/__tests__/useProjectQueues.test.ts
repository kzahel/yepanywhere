import { SERVER_CAPABILITIES } from "@yep-anywhere/shared";
import {
  collectionView,
  diffCollectionView,
} from "@yep-anywhere/shared/collection-updates";
import { FakeSourceTransport } from "../../lib/transport/FakeSourceTransport";
import { getSourceRuntimeRegistry } from "../../lib/sourceRuntime";
// @vitest-environment jsdom

import type {
  ProjectQueueItemSummary,
  ProjectQueueProjectStatus,
  ProjectQueueRecoveredSessionQueueSummary,
} from "@yep-anywhere/shared";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const busMock = vi.hoisted(() => {
  const handlers = new Map<string, Set<(payload: unknown) => void>>();
  return {
    on: vi.fn((event: string, handler: (payload: unknown) => void) => {
      let set = handlers.get(event);
      if (!set) {
        set = new Set();
        handlers.set(event, set);
      }
      set.add(handler);
      return () => handlers.get(event)?.delete(handler);
    }),
    emit(event: string, payload?: unknown) {
      for (const handler of handlers.get(event) ?? []) handler(payload);
    },
    reset() {
      handlers.clear();
    },
  };
});

const apiMock = vi.hoisted(() => ({
  getProjectQueue: vi.fn(),
  getProjectQueueItems: vi.fn(),
  updateProjectQueueItem: vi.fn(),
  deleteProjectQueueItem: vi.fn(),
  deleteRecoveredQueuedMessage: vi.fn(),
  resumeRecoveredQueuedMessage: vi.fn(),
  retryProjectQueueItem: vi.fn(),
  moveProjectQueueItemToTop: vi.fn(),
  pauseProjectQueueDispatch: vi.fn(),
  resumeProjectQueueDispatch: vi.fn(),
  promoteProjectQueueNow: vi.fn(),
}));
const versionMock = vi.hoisted(() => ({
  version: { capabilities: [] as string[] } as {
    capabilities?: string[];
    remoteCompatibilityLevel?: number;
  },
}));
const connectionMock = vi.hoisted(() => ({
  isRemoteClient: vi.fn(() => false),
  remoteState: {
    connection: null as { connection: object | null } | null,
  },
}));

vi.mock("../../api/client", () => ({
  api: apiMock,
}));

vi.mock("../../lib/activityBus", () => ({
  activityBus: {
    on: busMock.on,
    onSource: (
      _sourceKey: string,
      event: string,
      handler: (payload: unknown) => void,
    ) => busMock.on(event, handler),
    retainSourceStream: vi.fn(() => () => {}),
  },
}));

vi.mock("../../lib/connection", () => ({
  isRemoteClient: connectionMock.isRemoteClient,
}));

vi.mock("../../contexts/RemoteConnectionContext", () => ({
  useOptionalRemoteConnection: () => connectionMock.remoteState.connection,
}));

vi.mock("../useVersion", () => ({
  useVersion: () => ({ version: versionMock.version }),
  useRetainedVersionInfo: () => versionMock.version,
}));

import { resetClientQueryControllerForTests } from "../../lib/clientQueryController";
import {
  asClientSummarySourceKey,
  resetClientSummaryStoreForTests,
  setCurrentClientSummarySourceKey,
} from "../../lib/clientSummaryStore";
import { PROJECT_QUEUE_CAPABILITY } from "@yep-anywhere/shared";
import {
  resetProjectQueueBackstopsForTests,
  useProjectQueues,
} from "../useProjectQueues";

const PROJECT_ID = "project-1" as ProjectQueueItemSummary["projectId"];
const PROJECT_ID_2 = "project-2" as ProjectQueueItemSummary["projectId"];
const PROJECT_ID_3 = "project-3" as ProjectQueueItemSummary["projectId"];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeItem(
  id: string,
  projectId: ProjectQueueItemSummary["projectId"] = PROJECT_ID,
  status: ProjectQueueItemSummary["status"] = "queued",
): ProjectQueueItemSummary {
  return {
    id,
    projectId,
    target: { type: "existing-session", sessionId: "session-1" },
    messagePreview: `Message ${id}`,
    message: { text: `Message ${id}` },
    createdAt: `2026-06-27T00:00:0${id}.000Z`,
    updatedAt: `2026-06-27T00:00:0${id}.000Z`,
    status,
    attachmentCount: 0,
  };
}

function makeRecoveredSessionQueue(
  id: string,
  projectId: ProjectQueueRecoveredSessionQueueSummary["projectId"] = PROJECT_ID,
): ProjectQueueRecoveredSessionQueueSummary {
  return {
    id,
    tempId: `temp-${id}`,
    sessionId: `session-${id}`,
    projectId,
    content: `Recovered ${id}`,
    timestamp: `2026-06-30T00:00:0${id}.000Z`,
    queuedAt: `2026-06-30T00:00:0${id}.000Z`,
    createdAt: `2026-06-30T00:00:0${id}.000Z`,
    updatedAt: `2026-06-30T00:00:0${id}.000Z`,
    kind: "patient",
    status: "paused-after-restart",
  };
}

function makeProjectStatusFor(
  projectId: ProjectQueueProjectStatus["projectId"],
  state: ProjectQueueProjectStatus["state"],
): ProjectQueueProjectStatus {
  return {
    projectId,
    state,
    idle: state !== "blocked",
    blockers: state === "blocked" ? ["session-1:in-turn"] : [],
    dispatchPaused: state === "paused",
    inFlight: state === "dispatching",
    quietWindowMs: 30_000,
    itemCount: 1,
    nextItemId: "1",
  };
}

function makeProjectStatus(
  state: ProjectQueueProjectStatus["state"],
): ProjectQueueProjectStatus {
  return makeProjectStatusFor(PROJECT_ID, state);
}

beforeEach(() => {
  resetClientSummaryStoreForTests();
  resetClientQueryControllerForTests();
  versionMock.version = { capabilities: [PROJECT_QUEUE_CAPABILITY] };
  busMock.reset();
  busMock.on.mockClear();
  apiMock.getProjectQueue.mockReset();
  apiMock.getProjectQueueItems.mockReset();
  apiMock.updateProjectQueueItem.mockReset();
  apiMock.deleteProjectQueueItem.mockReset();
  apiMock.deleteRecoveredQueuedMessage.mockReset();
  apiMock.resumeRecoveredQueuedMessage.mockReset();
  apiMock.retryProjectQueueItem.mockReset();
  apiMock.moveProjectQueueItemToTop.mockReset();
  apiMock.pauseProjectQueueDispatch.mockReset();
  apiMock.resumeProjectQueueDispatch.mockReset();
  apiMock.promoteProjectQueueNow.mockReset();
  connectionMock.isRemoteClient.mockReset();
  connectionMock.isRemoteClient.mockReturnValue(false);
  connectionMock.remoteState.connection = null;
});

afterEach(() => {
  cleanup();
  resetClientQueryControllerForTests();
  resetClientSummaryStoreForTests();
});

describe("useProjectQueues", () => {
  it("fetches all queue items once for the supplied projects", async () => {
    apiMock.getProjectQueueItems.mockResolvedValue({
      items: [makeItem("1", PROJECT_ID), makeItem("2", PROJECT_ID_2)],
      projectStatuses: { [PROJECT_ID]: makeProjectStatus("waiting-quiet") },
    });

    const { result } = renderHook(() =>
      useProjectQueues(["project-1", "project-2"]),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(apiMock.getProjectQueueItems).toHaveBeenCalledTimes(1);
    expect(apiMock.getProjectQueue).not.toHaveBeenCalled();
    expect(result.current.items.map((item) => item.id)).toEqual(["1", "2"]);
    expect(result.current.projectStatusesByProject[PROJECT_ID]).toMatchObject({
      state: "waiting-quiet",
      nextItemId: "1",
    });
  });

  it("exposes recovered session queues for the supplied projects", async () => {
    apiMock.getProjectQueueItems.mockResolvedValue({
      items: [],
      recoveredSessionQueues: [
        makeRecoveredSessionQueue("1", PROJECT_ID),
        makeRecoveredSessionQueue("2", PROJECT_ID_2),
      ],
    });

    const { result } = renderHook(() => useProjectQueues(["project-1"]));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.recoveredSessionQueues).toMatchObject([
      {
        id: "1",
        projectId: PROJECT_ID,
        content: "Recovered 1",
        status: "paused-after-restart",
      },
    ]);
  });

  it("keeps recovered rows until delete is confirmed by a collection refetch", async () => {
    const deleteRequest = deferred<{
      deleted: boolean;
      deferredMessages: never[];
    }>();
    apiMock.getProjectQueueItems
      .mockResolvedValueOnce({
        items: [],
        recoveredSessionQueues: [makeRecoveredSessionQueue("1", PROJECT_ID)],
      })
      .mockResolvedValueOnce({ items: [], recoveredSessionQueues: [] });
    apiMock.deleteRecoveredQueuedMessage.mockReturnValue(deleteRequest.promise);

    const { result } = renderHook(() => useProjectQueues([PROJECT_ID]));
    await waitFor(() =>
      expect(result.current.recoveredSessionQueues).toHaveLength(1),
    );

    let mutation!: Promise<void>;
    act(() => {
      mutation = result.current.deleteRecoveredItem("session-1", "1");
    });
    await waitFor(() =>
      expect(result.current.mutatingRecoveredQueueId).toBe("1"),
    );
    expect(result.current.recoveredSessionQueues).toHaveLength(1);

    deleteRequest.resolve({ deleted: true, deferredMessages: [] });
    await act(async () => mutation);

    expect(apiMock.deleteRecoveredQueuedMessage).toHaveBeenCalledWith(
      "session-1",
      "1",
    );
    expect(apiMock.getProjectQueueItems).toHaveBeenCalledTimes(2);
    expect(result.current.recoveredSessionQueues).toEqual([]);
    expect(result.current.mutatingRecoveredQueueId).toBeNull();
  });

  it("accepts resume-through removal from the canonical collection", async () => {
    apiMock.getProjectQueueItems
      .mockResolvedValueOnce({
        items: [],
        recoveredSessionQueues: [
          makeRecoveredSessionQueue("1", PROJECT_ID),
          makeRecoveredSessionQueue("2", PROJECT_ID),
        ],
      })
      .mockResolvedValueOnce({ items: [], recoveredSessionQueues: [] });
    apiMock.resumeRecoveredQueuedMessage.mockResolvedValue({
      resumed: true,
      resumedCount: 2,
      processId: "process-1",
      deferredMessages: [],
      serverTimestamp: 1,
    });

    const { result } = renderHook(() => useProjectQueues([PROJECT_ID]));
    await waitFor(() =>
      expect(result.current.recoveredSessionQueues).toHaveLength(2),
    );

    await act(async () => {
      await result.current.resumeRecoveredItem("session-2", "2");
    });

    expect(apiMock.getProjectQueueItems).toHaveBeenCalledTimes(2);
    expect(result.current.recoveredSessionQueues).toEqual([]);
  });

  it("retains recovered rows and exposes resume failures", async () => {
    apiMock.getProjectQueueItems.mockResolvedValue({
      items: [],
      recoveredSessionQueues: [makeRecoveredSessionQueue("1", PROJECT_ID)],
    });
    apiMock.resumeRecoveredQueuedMessage.mockRejectedValue(
      new Error("Resume rejected"),
    );

    const { result } = renderHook(() => useProjectQueues([PROJECT_ID]));
    await waitFor(() =>
      expect(result.current.recoveredSessionQueues).toHaveLength(1),
    );

    await act(async () => {
      await expect(
        result.current.resumeRecoveredItem("session-1", "1"),
      ).rejects.toThrow("Resume rejected");
    });

    expect(apiMock.resumeRecoveredQueuedMessage).toHaveBeenCalledWith(
      "session-1",
      "1",
    );
    expect(result.current.recoveredSessionQueues).toHaveLength(1);
    expect(result.current.error?.message).toBe("Resume rejected");
    expect(result.current.mutatingRecoveredQueueId).toBeNull();
  });

  it("shares dispatch state with consumers that reuse a fresh query", async () => {
    apiMock.getProjectQueueItems.mockResolvedValue({
      items: [makeItem("1", PROJECT_ID)],
      dispatchState: {
        status: "paused",
        reason: "restart",
        pausedAt: "2026-07-01T07:41:12.926Z",
      },
      recoveredSessionQueues: [makeRecoveredSessionQueue("1", PROJECT_ID)],
      projectStatuses: {
        [PROJECT_ID]: makeProjectStatus("waiting-quiet"),
      },
    });

    const first = renderHook(() => useProjectQueues(["project-1"]));

    await waitFor(() =>
      expect(first.result.current.dispatchState).toMatchObject({
        status: "paused",
        reason: "restart",
      }),
    );

    const second = renderHook(() => useProjectQueues(["project-1"]));

    await waitFor(() => expect(second.result.current.loading).toBe(false));

    expect(apiMock.getProjectQueueItems).toHaveBeenCalledTimes(1);
    expect(second.result.current.dispatchState).toMatchObject({
      status: "paused",
      reason: "restart",
    });
    expect(
      second.result.current.recoveredSessionQueues.map((item) => item.id),
    ).toEqual(["1"]);
    expect(
      second.result.current.projectStatusesByProject[PROJECT_ID],
    ).toMatchObject({
      state: "waiting-quiet",
      nextItemId: "1",
    });
  });

  it("refetches recovered session queues after persistence changes", async () => {
    apiMock.getProjectQueueItems
      .mockResolvedValueOnce({
        items: [],
        recoveredSessionQueues: [makeRecoveredSessionQueue("1", PROJECT_ID)],
      })
      .mockResolvedValueOnce({
        items: [],
        recoveredSessionQueues: [makeRecoveredSessionQueue("3", PROJECT_ID)],
      });

    const { result } = renderHook(() => useProjectQueues(["project-1"]));

    await waitFor(() =>
      expect(
        result.current.recoveredSessionQueues.map((item) => item.id),
      ).toEqual(["1"]),
    );

    act(() => {
      busMock.emit("session-queue-persistence-changed", {
        type: "session-queue-persistence-changed",
        timestamp: "2026-06-30T00:00:10.000Z",
      });
    });

    await waitFor(
      () => expect(apiMock.getProjectQueueItems).toHaveBeenCalledTimes(2),
      { timeout: 1500 },
    );
    await waitFor(() =>
      expect(
        result.current.recoveredSessionQueues.map((item) => item.id),
      ).toEqual(["3"]),
    );
  });

  it("shares manual refetches across mounted consumers", async () => {
    apiMock.getProjectQueueItems
      .mockResolvedValueOnce({
        items: [makeItem("1", PROJECT_ID)],
      })
      .mockResolvedValueOnce({
        items: [makeItem("2", PROJECT_ID)],
      });

    const first = renderHook(() => useProjectQueues(["project-1"]));
    const second = renderHook(() => useProjectQueues(["project-1"]));

    await waitFor(() => expect(first.result.current.loading).toBe(false));
    await waitFor(() => expect(second.result.current.loading).toBe(false));
    expect(apiMock.getProjectQueueItems).toHaveBeenCalledTimes(1);

    await act(async () => {
      await Promise.all([
        first.result.current.refetch(),
        second.result.current.refetch(),
      ]);
    });

    expect(apiMock.getProjectQueueItems).toHaveBeenCalledTimes(2);
    expect(first.result.current.items.map((item) => item.id)).toEqual(["2"]);
    expect(second.result.current.items.map((item) => item.id)).toEqual(["2"]);
  });

  it("shares catalog and custom-title revalidation across mounted queue consumers", async () => {
    apiMock.getProjectQueueItems
      .mockResolvedValueOnce({ items: [makeItem("1")] })
      .mockResolvedValueOnce({
        items: [{ ...makeItem("1"), targetTitle: "Published title" }],
      })
      .mockResolvedValueOnce({
        items: [{ ...makeItem("1"), targetTitle: "Custom title" }],
      });
    const first = renderHook(() => useProjectQueues(["project-1"]));
    const second = renderHook(() => useProjectQueues(["project-1"]));
    await waitFor(() => expect(first.result.current.items).toHaveLength(1));
    act(() =>
      busMock.emit("session-catalog-updated", {
        type: "session-catalog-updated",
        catalog: {
          catalogEpoch: "catalog",
          catalogGeneration: 2,
          complete: true,
          refreshing: false,
        },
        timestamp: "2026-11-03T00:00:00.000Z",
      }),
    );
    await waitFor(() =>
      expect(second.result.current.items[0]?.targetTitle).toBe(
        "Published title",
      ),
    );
    expect(first.result.current.items[0]?.targetTitle).toBe("Published title");
    expect(apiMock.getProjectQueueItems).toHaveBeenCalledTimes(2);
    act(() =>
      busMock.emit("session-metadata-changed", {
        type: "session-metadata-changed",
        sessionId: "session-1",
        title: "Custom title",
        timestamp: "2026-11-03T00:00:00.000Z",
      }),
    );
    await waitFor(() =>
      expect(second.result.current.items[0]?.targetTitle).toBe("Custom title"),
    );
    expect(first.result.current.items[0]?.targetTitle).toBe("Custom title");
    expect(apiMock.getProjectQueueItems).toHaveBeenCalledTimes(3);
  });

  it("updates a project queue from activity events", async () => {
    apiMock.getProjectQueueItems.mockResolvedValue({
      items: [makeItem("1")],
    });

    const { result } = renderHook(() => useProjectQueues(["project-1"]));

    await waitFor(() => expect(result.current.items).toHaveLength(1));

    act(() => {
      busMock.emit("project-queue-changed", {
        type: "project-queue-changed",
        projectId: PROJECT_ID,
        items: [makeItem("2", PROJECT_ID, "failed")],
        reason: "failed",
        timestamp: "2026-06-27T00:00:10.000Z",
      });
    });

    await waitFor(() =>
      expect(result.current.items).toMatchObject([
        { id: "2", status: "failed" },
      ]),
    );
  });

  it("replaces state from delete and retry responses", async () => {
    apiMock.getProjectQueueItems.mockResolvedValue({
      items: [makeItem("1")],
    });
    apiMock.deleteProjectQueueItem.mockResolvedValue({
      deleted: true,
      queue: { projectId: PROJECT_ID, items: [] },
    });
    apiMock.retryProjectQueueItem.mockResolvedValue({
      item: makeItem("2", PROJECT_ID),
      queue: { projectId: PROJECT_ID, items: [makeItem("2", PROJECT_ID)] },
    });

    const { result } = renderHook(() => useProjectQueues(["project-1"]));

    await waitFor(() => expect(result.current.items).toHaveLength(1));
    await act(async () => {
      await result.current.deleteItem("project-1", "1");
    });

    expect(apiMock.deleteProjectQueueItem).toHaveBeenCalledWith(
      "project-1",
      "1",
    );
    await waitFor(() => expect(result.current.items).toEqual([]));

    await act(async () => {
      await result.current.retryItem("project-1", "2");
    });

    expect(apiMock.retryProjectQueueItem).toHaveBeenCalledWith(
      "project-1",
      "2",
    );
    expect(result.current.items.map((item) => item.id)).toEqual(["2"]);
  });

  it("replaces state from update responses", async () => {
    apiMock.getProjectQueueItems.mockResolvedValue({
      items: [makeItem("1")],
    });
    apiMock.updateProjectQueueItem.mockResolvedValue({
      item: makeItem("1", PROJECT_ID),
      queue: {
        projectId: PROJECT_ID,
        items: [
          {
            ...makeItem("1", PROJECT_ID),
            messagePreview: "Edited message",
            message: { text: "Edited message" },
          },
        ],
      },
    });

    const { result } = renderHook(() => useProjectQueues(["project-1"]));

    await waitFor(() => expect(result.current.items).toHaveLength(1));
    await act(async () => {
      await result.current.updateItem("project-1", "1", {
        message: { text: "Edited message" },
      });
    });

    expect(apiMock.updateProjectQueueItem).toHaveBeenCalledWith(
      "project-1",
      "1",
      { message: { text: "Edited message" } },
    );
    expect(result.current.items).toMatchObject([
      { id: "1", messagePreview: "Edited message" },
    ]);
  });

  it("sends an edited queued command with the command its new text spells", async () => {
    apiMock.getProjectQueueItems.mockResolvedValue({
      items: [makeItem("1")],
    });
    apiMock.updateProjectQueueItem.mockResolvedValue({
      item: makeItem("1", PROJECT_ID),
      queue: { projectId: PROJECT_ID, items: [makeItem("1", PROJECT_ID)] },
    });
    const stale = { name: "clearloop" as const, argument: "3 2: p" };

    const { result } = renderHook(() => useProjectQueues(["project-1"]));
    await waitFor(() => expect(result.current.items).toHaveLength(1));
    await act(async () => {
      await result.current.updateItem("project-1", "1", {
        message: { text: "/clearloop 3 5: q", yaCommand: stale },
      });
      await result.current.updateItem("project-1", "1", {
        message: { text: "summarize instead", yaCommand: stale },
      });
    });

    expect(
      apiMock.updateProjectQueueItem.mock.calls.map((call) => call[2]),
    ).toEqual([
      {
        message: {
          text: "/clearloop 3 5: q",
          yaCommand: { name: "clearloop", argument: "3 5: q" },
        },
      },
      { message: { text: "summarize instead" } },
    ]);
  });

  it("preserves queue order from move-to-top responses", async () => {
    apiMock.getProjectQueueItems.mockResolvedValue({
      items: [makeItem("1"), makeItem("2")],
    });
    apiMock.moveProjectQueueItemToTop.mockResolvedValue({
      item: makeItem("2", PROJECT_ID),
      queue: {
        projectId: PROJECT_ID,
        items: [makeItem("2", PROJECT_ID), makeItem("1", PROJECT_ID)],
      },
    });

    const { result } = renderHook(() => useProjectQueues(["project-1"]));

    await waitFor(() => expect(result.current.items).toHaveLength(2));
    await act(async () => {
      await result.current.moveItemToTop("project-1", "2");
    });

    expect(apiMock.moveProjectQueueItemToTop).toHaveBeenCalledWith(
      "project-1",
      "2",
    );
    expect(result.current.items.map((item) => item.id)).toEqual(["2", "1"]);
  });

  it("keeps project-local move-to-top while paused", async () => {
    apiMock.getProjectQueueItems.mockResolvedValue({
      items: [makeItem("1", PROJECT_ID), makeItem("2", PROJECT_ID)],
      dispatchState: {
        status: "paused",
        reason: "manual",
        pausedAt: "2026-06-30T00:00:00.000Z",
      },
    });
    apiMock.moveProjectQueueItemToTop.mockResolvedValue({
      item: makeItem("2", PROJECT_ID),
      queue: {
        projectId: PROJECT_ID,
        items: [makeItem("2", PROJECT_ID), makeItem("1", PROJECT_ID)],
      },
    });

    const { result } = renderHook(() => useProjectQueues(["project-1"]));

    await waitFor(() => expect(result.current.items).toHaveLength(2));
    await act(async () => {
      await result.current.moveItemToTop("project-1", "2");
    });

    expect(apiMock.moveProjectQueueItemToTop).toHaveBeenCalledWith(
      "project-1",
      "2",
    );
    expect(result.current.items.map((item) => item.id)).toEqual(["2", "1"]);
  });

  it("updates dispatch state from pause and resume responses", async () => {
    apiMock.getProjectQueueItems.mockResolvedValue({
      items: [makeItem("1")],
      dispatchState: { status: "running" },
    });
    apiMock.pauseProjectQueueDispatch.mockResolvedValue({
      items: [makeItem("1")],
      dispatchState: {
        status: "paused",
        reason: "manual",
        pausedAt: "2026-06-30T00:00:00.000Z",
      },
    });
    apiMock.resumeProjectQueueDispatch.mockResolvedValue({
      items: [makeItem("1")],
      dispatchState: { status: "running" },
    });

    const { result } = renderHook(() => useProjectQueues(["project-1"]));

    await waitFor(() => expect(result.current.items).toHaveLength(1));
    await act(async () => {
      await result.current.pauseDispatch();
    });

    expect(result.current.dispatchState).toMatchObject({
      status: "paused",
      reason: "manual",
    });

    await act(async () => {
      await result.current.resumeDispatch();
    });

    expect(result.current.dispatchState).toEqual({ status: "running" });
  });

  it("promotes a specific project queue item with optional force", async () => {
    apiMock.getProjectQueueItems.mockResolvedValue({
      items: [makeItem("1")],
      projectStatuses: { [PROJECT_ID]: makeProjectStatus("blocked") },
    });
    apiMock.promoteProjectQueueNow.mockResolvedValue({
      items: [],
      dispatchState: { status: "running" },
      projectStatuses: { [PROJECT_ID]: makeProjectStatus("empty") },
      promoteResult: {
        promoted: true,
        itemId: "1",
        sessionId: "session-1",
        reason: "promoted",
        status: makeProjectStatus("empty"),
      },
    });

    const { result } = renderHook(() => useProjectQueues(["project-1"]));

    await waitFor(() => expect(result.current.items).toHaveLength(1));
    await act(async () => {
      await result.current.promoteNow("project-1", "1", {
        force: true,
        deliveryIntent: "steer",
      });
    });

    expect(apiMock.promoteProjectQueueNow).toHaveBeenCalledWith("project-1", {
      itemId: "1",
      force: true,
      deliveryIntent: "steer",
    });
    expect(result.current.items).toEqual([]);
    expect(result.current.projectStatusesByProject[PROJECT_ID]).toMatchObject({
      state: "empty",
    });
  });
});

describe("useProjectQueues backstop", () => {
  const NOW_MS = Date.parse("2026-08-05T00:00:00.000Z");

  function statusFor(
    projectId: ProjectQueueProjectStatus["projectId"],
    state: ProjectQueueProjectStatus["state"],
    overrides: Partial<ProjectQueueProjectStatus> = {},
  ): ProjectQueueProjectStatus {
    return { ...makeProjectStatusFor(projectId, state), ...overrides };
  }

  function statusWith(
    state: ProjectQueueProjectStatus["state"],
    overrides: Partial<ProjectQueueProjectStatus> = {},
  ): ProjectQueueProjectStatus {
    return statusFor(PROJECT_ID, state, overrides);
  }

  async function settle() {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    resetProjectQueueBackstopsForTests();
  });

  afterEach(() => {
    resetProjectQueueBackstopsForTests();
    vi.useRealTimers();
  });

  it("arms one backstop for the whole source, not one per consumer", async () => {
    apiMock.getProjectQueueItems.mockResolvedValue({
      items: [makeItem("1", PROJECT_ID)],
      projectStatuses: { [PROJECT_ID]: statusWith("dispatching") },
    });

    renderHook(() => useProjectQueues(["project-1"]));
    renderHook(() => useProjectQueues(["project-1"]));
    renderHook(() => useProjectQueues(["project-1"]));
    await settle();
    expect(apiMock.getProjectQueueItems).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    // Three mounted consumers used to mean three five-second intervals.
    expect(apiMock.getProjectQueueItems).toHaveBeenCalledTimes(2);
  });

  it("does not slide an active fallback across equivalent rerenders", async () => {
    apiMock.getProjectQueueItems.mockResolvedValue({
      items: [makeItem("1", PROJECT_ID)],
      projectStatuses: { [PROJECT_ID]: statusWith("dispatching") },
    });

    const hook = renderHook(
      ({ projectIds }: { projectIds: string[] }) =>
        useProjectQueues(projectIds),
      { initialProps: { projectIds: [PROJECT_ID] } },
    );
    await settle();

    for (let second = 0; second < 4; second += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      hook.rerender({ projectIds: [PROJECT_ID] });
      await settle();
    }
    expect(apiMock.getProjectQueueItems).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(apiMock.getProjectQueueItems).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("waits out a reported quiet window instead of sampling through it", async () => {
    apiMock.getProjectQueueItems.mockResolvedValue({
      items: [makeItem("1", PROJECT_ID)],
      projectStatuses: {
        [PROJECT_ID]: statusWith("waiting-quiet", {
          quietEligibleAt: new Date(NOW_MS + 30_000).toISOString(),
        }),
      },
    });

    renderHook(() => useProjectQueues(["project-1"]));
    await settle();
    expect(apiMock.getProjectQueueItems).toHaveBeenCalledTimes(1);

    // The old interval would have read six times before the window elapsed.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(29_000);
    });
    expect(apiMock.getProjectQueueItems).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(apiMock.getProjectQueueItems).toHaveBeenCalledTimes(2);
  });

  it("backs off persistent deadline failures with one bounded timer", async () => {
    apiMock.getProjectQueueItems
      .mockResolvedValueOnce({
        items: [makeItem("1", PROJECT_ID)],
        projectStatuses: {
          [PROJECT_ID]: statusWith("waiting-quiet", {
            quietEligibleAt: new Date(NOW_MS + 1_000).toISOString(),
          }),
        },
      })
      .mockRejectedValue(new Error("queue unavailable"));

    renderHook(() => useProjectQueues([PROJECT_ID]));
    await settle();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(apiMock.getProjectQueueItems).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(499);
    });
    expect(apiMock.getProjectQueueItems).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(apiMock.getProjectQueueItems).toHaveBeenCalledTimes(3);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(999);
    });
    expect(apiMock.getProjectQueueItems).toHaveBeenCalledTimes(3);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(apiMock.getProjectQueueItems).toHaveBeenCalledTimes(4);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_999);
    });
    expect(apiMock.getProjectQueueItems).toHaveBeenCalledTimes(6);
    expect(vi.getTimerCount()).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(apiMock.getProjectQueueItems).toHaveBeenCalledTimes(7);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("consumes a retry before a slow refetch can rerender and rearm it", async () => {
    const slowRetry = deferred<{
      items: ProjectQueueItemSummary[];
      projectStatuses: Record<string, ProjectQueueProjectStatus>;
    }>();
    apiMock.getProjectQueueItems
      .mockResolvedValueOnce({
        items: [makeItem("1", PROJECT_ID)],
        projectStatuses: {
          [PROJECT_ID]: statusWith("waiting-quiet", {
            quietEligibleAt: new Date(NOW_MS + 1_000).toISOString(),
          }),
        },
      })
      .mockRejectedValueOnce(new Error("queue unavailable"))
      .mockReturnValueOnce(slowRetry.promise);

    const hook = renderHook(
      ({ projectIds }: { projectIds: string[] }) =>
        useProjectQueues(projectIds),
      { initialProps: { projectIds: [PROJECT_ID] } },
    );
    await settle();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(apiMock.getProjectQueueItems).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);

    hook.rerender({ projectIds: [PROJECT_ID] });
    await settle();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(apiMock.getProjectQueueItems).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);

    slowRetry.resolve({
      items: [makeItem("2", PROJECT_ID)],
      projectStatuses: { [PROJECT_ID]: statusWith("blocked") },
    });
    await settle();
    expect(hook.result.current.items.map((item) => item.id)).toEqual(["2"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps B's source retry when A changes to a blocked scope", async () => {
    apiMock.getProjectQueueItems
      .mockResolvedValueOnce({
        items: [
          makeItem("1", PROJECT_ID),
          makeItem("2", PROJECT_ID_2),
          makeItem("3", PROJECT_ID_3),
        ],
        projectStatuses: {
          [PROJECT_ID]: statusFor(PROJECT_ID, "waiting-quiet", {
            quietEligibleAt: new Date(NOW_MS + 10_000).toISOString(),
          }),
          [PROJECT_ID_2]: statusFor(PROJECT_ID_2, "waiting-quiet", {
            quietEligibleAt: new Date(NOW_MS + 1_000).toISOString(),
          }),
          [PROJECT_ID_3]: statusFor(PROJECT_ID_3, "blocked"),
        },
      })
      .mockRejectedValueOnce(new Error("B deadline failure"))
      .mockResolvedValueOnce({
        items: [makeItem("2", PROJECT_ID_2)],
        projectStatuses: {
          [PROJECT_ID_2]: statusFor(PROJECT_ID_2, "blocked"),
        },
      });

    const first = renderHook(
      ({ projectId }: { projectId: string }) => useProjectQueues([projectId]),
      { initialProps: { projectId: PROJECT_ID } },
    );
    renderHook(() => useProjectQueues([PROJECT_ID_2]));
    await settle();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(apiMock.getProjectQueueItems).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);

    first.rerender({ projectId: PROJECT_ID_3 });
    await settle();
    expect(vi.getTimerCount()).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(apiMock.getProjectQueueItems).toHaveBeenCalledTimes(3);
  });

  it("keeps B's source attempt when A changes to a blocked scope", async () => {
    const sourceAttempt = deferred<{
      items: ProjectQueueItemSummary[];
      projectStatuses: Record<string, ProjectQueueProjectStatus>;
    }>();
    apiMock.getProjectQueueItems
      .mockResolvedValueOnce({
        items: [
          makeItem("1", PROJECT_ID),
          makeItem("2", PROJECT_ID_2),
          makeItem("3", PROJECT_ID_3),
        ],
        projectStatuses: {
          [PROJECT_ID]: statusFor(PROJECT_ID, "waiting-quiet", {
            quietEligibleAt: new Date(NOW_MS + 10_000).toISOString(),
          }),
          [PROJECT_ID_2]: statusFor(PROJECT_ID_2, "waiting-quiet", {
            quietEligibleAt: new Date(NOW_MS + 1_000).toISOString(),
          }),
          [PROJECT_ID_3]: statusFor(PROJECT_ID_3, "blocked"),
        },
      })
      .mockReturnValueOnce(sourceAttempt.promise)
      .mockResolvedValueOnce({
        items: [makeItem("2", PROJECT_ID_2)],
        projectStatuses: {
          [PROJECT_ID_2]: statusFor(PROJECT_ID_2, "blocked"),
        },
      });

    const first = renderHook(
      ({ projectId }: { projectId: string }) => useProjectQueues([projectId]),
      { initialProps: { projectId: PROJECT_ID } },
    );
    renderHook(() => useProjectQueues([PROJECT_ID_2]));
    await settle();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(apiMock.getProjectQueueItems).toHaveBeenCalledTimes(2);

    first.rerender({ projectId: PROJECT_ID_3 });
    await settle();
    expect(vi.getTimerCount()).toBe(0);
    sourceAttempt.reject(new Error("B pending failure"));
    await settle();
    expect(vi.getTimerCount()).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(apiMock.getProjectQueueItems).toHaveBeenCalledTimes(3);
  });

  it("serializes nearby retainer deadlines through one source attempt", async () => {
    const firstAttempt = deferred<{
      items: ProjectQueueItemSummary[];
      projectStatuses: Record<string, ProjectQueueProjectStatus>;
    }>();
    apiMock.getProjectQueueItems
      .mockResolvedValueOnce({
        items: [makeItem("1", PROJECT_ID), makeItem("2", PROJECT_ID_2)],
        projectStatuses: {
          [PROJECT_ID]: statusFor(PROJECT_ID, "waiting-quiet", {
            quietEligibleAt: new Date(NOW_MS + 1_000).toISOString(),
          }),
          [PROJECT_ID_2]: statusFor(PROJECT_ID_2, "waiting-quiet", {
            quietEligibleAt: new Date(NOW_MS + 1_100).toISOString(),
          }),
        },
      })
      .mockReturnValueOnce(firstAttempt.promise)
      .mockRejectedValueOnce(new Error("second deadline failure"))
      .mockResolvedValueOnce({
        items: [makeItem("2", PROJECT_ID_2)],
        projectStatuses: {
          [PROJECT_ID]: statusFor(PROJECT_ID, "blocked"),
          [PROJECT_ID_2]: statusFor(PROJECT_ID_2, "blocked"),
        },
      });

    const first = renderHook(() => useProjectQueues([PROJECT_ID]));
    renderHook(() => useProjectQueues([PROJECT_ID_2]));
    await settle();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_250);
    });
    expect(apiMock.getProjectQueueItems).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);

    firstAttempt.reject(new Error("first deadline failure"));
    await settle();
    expect(vi.getTimerCount()).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(apiMock.getProjectQueueItems).toHaveBeenCalledTimes(3);

    first.unmount();
    expect(vi.getTimerCount()).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(apiMock.getProjectQueueItems).toHaveBeenCalledTimes(4);
  });

  it("keeps a source attempt when a later-deadline retainer releases", async () => {
    const sourceAttempt = deferred<{
      items: ProjectQueueItemSummary[];
      projectStatuses: Record<string, ProjectQueueProjectStatus>;
    }>();
    apiMock.getProjectQueueItems
      .mockResolvedValueOnce({
        items: [makeItem("1", PROJECT_ID), makeItem("2", PROJECT_ID_2)],
        projectStatuses: {
          [PROJECT_ID]: statusFor(PROJECT_ID, "waiting-quiet", {
            quietEligibleAt: new Date(NOW_MS + 1_000).toISOString(),
          }),
          [PROJECT_ID_2]: statusFor(PROJECT_ID_2, "waiting-quiet", {
            quietEligibleAt: new Date(NOW_MS + 1_100).toISOString(),
          }),
        },
      })
      .mockReturnValueOnce(sourceAttempt.promise)
      .mockResolvedValueOnce({
        items: [makeItem("1", PROJECT_ID)],
        projectStatuses: {
          [PROJECT_ID]: statusFor(PROJECT_ID, "blocked"),
          [PROJECT_ID_2]: statusFor(PROJECT_ID_2, "blocked"),
        },
      });

    renderHook(() => useProjectQueues([PROJECT_ID]));
    const second = renderHook(() => useProjectQueues([PROJECT_ID_2]));
    await settle();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_250);
    });
    expect(apiMock.getProjectQueueItems).toHaveBeenCalledTimes(2);

    second.unmount();
    expect(vi.getTimerCount()).toBe(0);
    sourceAttempt.reject(new Error("source attempt failure"));
    await settle();
    expect(vi.getTimerCount()).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(apiMock.getProjectQueueItems).toHaveBeenCalledTimes(3);
  });

  it("recovers from a deadline failure and returns to server-owned scheduling", async () => {
    apiMock.getProjectQueueItems
      .mockResolvedValueOnce({
        items: [makeItem("1", PROJECT_ID)],
        projectStatuses: {
          [PROJECT_ID]: statusWith("waiting-quiet", {
            quietEligibleAt: new Date(NOW_MS + 1_000).toISOString(),
          }),
        },
      })
      .mockRejectedValueOnce(new Error("queue unavailable"))
      .mockResolvedValueOnce({
        items: [makeItem("2", PROJECT_ID)],
        projectStatuses: { [PROJECT_ID]: statusWith("blocked") },
      });

    const hook = renderHook(() => useProjectQueues([PROJECT_ID]));
    await settle();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(apiMock.getProjectQueueItems).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    await settle();
    expect(apiMock.getProjectQueueItems).toHaveBeenCalledTimes(3);
    expect(hook.result.current.items.map((item) => item.id)).toEqual(["2"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the later scope's deadline when the earlier scope unmounts", async () => {
    apiMock.getProjectQueueItems.mockResolvedValue({
      items: [makeItem("1", PROJECT_ID), makeItem("2", PROJECT_ID_2)],
      projectStatuses: {
        [PROJECT_ID]: statusFor(PROJECT_ID, "waiting-quiet", {
          quietEligibleAt: new Date(NOW_MS + 10_000).toISOString(),
        }),
        [PROJECT_ID_2]: statusFor(PROJECT_ID_2, "waiting-quiet", {
          quietEligibleAt: new Date(NOW_MS + 20_000).toISOString(),
        }),
      },
    });

    const earlier = renderHook(() => useProjectQueues([PROJECT_ID]));
    renderHook(() => useProjectQueues([PROJECT_ID_2]));
    await settle();
    expect(apiMock.getProjectQueueItems).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);

    earlier.unmount();
    expect(vi.getTimerCount()).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(apiMock.getProjectQueueItems).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(apiMock.getProjectQueueItems).toHaveBeenCalledTimes(2);
  });

  it("keeps the earlier scope's deadline when the later scope mounted first", async () => {
    apiMock.getProjectQueueItems.mockResolvedValue({
      items: [makeItem("1", PROJECT_ID), makeItem("2", PROJECT_ID_2)],
      projectStatuses: {
        [PROJECT_ID]: statusFor(PROJECT_ID, "waiting-quiet", {
          quietEligibleAt: new Date(NOW_MS + 10_000).toISOString(),
        }),
        [PROJECT_ID_2]: statusFor(PROJECT_ID_2, "waiting-quiet", {
          quietEligibleAt: new Date(NOW_MS + 20_000).toISOString(),
        }),
      },
    });

    const later = renderHook(() => useProjectQueues([PROJECT_ID_2]));
    renderHook(() => useProjectQueues([PROJECT_ID]));
    await settle();
    expect(apiMock.getProjectQueueItems).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);

    later.unmount();
    expect(vi.getTimerCount()).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(apiMock.getProjectQueueItems).toHaveBeenCalledTimes(2);
  });

  it("starts deadline revalidation in a new query generation", async () => {
    const preDeadlineFetch = deferred<{
      items: ProjectQueueItemSummary[];
      projectStatuses: Record<string, ProjectQueueProjectStatus>;
    }>();
    const deadlineResponse = {
      items: [makeItem("2", PROJECT_ID)],
      projectStatuses: { [PROJECT_ID]: statusWith("blocked") },
    };
    apiMock.getProjectQueueItems
      .mockResolvedValueOnce({
        items: [makeItem("1", PROJECT_ID)],
        projectStatuses: {
          [PROJECT_ID]: statusWith("waiting-quiet", {
            quietEligibleAt: new Date(NOW_MS + 1_000).toISOString(),
          }),
        },
      })
      .mockReturnValueOnce(preDeadlineFetch.promise)
      .mockResolvedValueOnce(deadlineResponse);

    const hook = renderHook(() => useProjectQueues([PROJECT_ID]));
    await settle();
    act(() => {
      busMock.emit("refresh");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(apiMock.getProjectQueueItems).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(apiMock.getProjectQueueItems).toHaveBeenCalledTimes(3);
    await settle();
    expect(hook.result.current.items.map((item) => item.id)).toEqual(["2"]);

    preDeadlineFetch.resolve({
      items: [makeItem("stale", PROJECT_ID)],
      projectStatuses: {
        [PROJECT_ID]: statusWith("waiting-quiet", {
          quietEligibleAt: new Date(NOW_MS + 1_000).toISOString(),
        }),
      },
    });
    await settle();
    expect(hook.result.current.items.map((item) => item.id)).toEqual(["2"]);
  });

  it("fences a pending deadline fetch when its hook switches sources", async () => {
    const sourceA = asClientSummarySourceKey("host:queue-a");
    const sourceB = asClientSummarySourceKey("host:queue-b");
    const oldDeadlineFetch = deferred<{
      items: ProjectQueueItemSummary[];
      projectStatuses: Record<string, ProjectQueueProjectStatus>;
    }>();
    const sourceAResponse = {
      items: [makeItem("1", PROJECT_ID)],
      projectStatuses: {
        [PROJECT_ID]: statusWith("waiting-quiet", {
          quietEligibleAt: new Date(NOW_MS + 1_000).toISOString(),
        }),
      },
    };
    apiMock.getProjectQueueItems
      .mockResolvedValueOnce(sourceAResponse)
      .mockReturnValueOnce(oldDeadlineFetch.promise)
      .mockResolvedValueOnce({
        items: [makeItem("2", PROJECT_ID)],
        projectStatuses: { [PROJECT_ID]: statusWith("blocked") },
      });
    setCurrentClientSummarySourceKey(sourceA);

    const hook = renderHook(() => useProjectQueues([PROJECT_ID]));
    await settle();
    expect(apiMock.getProjectQueueItems).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(apiMock.getProjectQueueItems).toHaveBeenCalledTimes(2);

    act(() => {
      setCurrentClientSummarySourceKey(sourceB);
    });
    hook.rerender();
    await settle();
    expect(apiMock.getProjectQueueItems).toHaveBeenCalledTimes(3);
    expect(hook.result.current.items.map((item) => item.id)).toEqual(["2"]);
    expect(vi.getTimerCount()).toBe(0);

    oldDeadlineFetch.resolve(sourceAResponse);
    await settle();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(apiMock.getProjectQueueItems).toHaveBeenCalledTimes(3);
    expect(hook.result.current.items.map((item) => item.id)).toEqual(["2"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("arms no timer for a blocked backlog that only events can release", async () => {
    apiMock.getProjectQueueItems.mockResolvedValue({
      items: [makeItem("1", PROJECT_ID)],
      projectStatuses: { [PROJECT_ID]: statusWith("blocked") },
    });

    renderHook(() => useProjectQueues(["project-1"]));
    await settle();
    expect(apiMock.getProjectQueueItems).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(apiMock.getProjectQueueItems).toHaveBeenCalledTimes(1);
  });

  it("releases the backstop when the last consumer unmounts", async () => {
    apiMock.getProjectQueueItems.mockResolvedValue({
      items: [makeItem("1", PROJECT_ID)],
      projectStatuses: { [PROJECT_ID]: statusWith("dispatching") },
    });

    const first = renderHook(() => useProjectQueues(["project-1"]));
    const second = renderHook(() => useProjectQueues(["project-1"]));
    await settle();
    expect(apiMock.getProjectQueueItems).toHaveBeenCalledTimes(1);

    first.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    // One consumer left, so the backstop is still owned.
    expect(apiMock.getProjectQueueItems).toHaveBeenCalledTimes(2);

    second.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(apiMock.getProjectQueueItems).toHaveBeenCalledTimes(2);
  });
});

it("retires the browser deadline backstop while live and restores it after stream failure", async () => {
  vi.useFakeTimers();
  const sourceKey = asClientSummarySourceKey("queue-live-backstop");
  const registry = getSourceRuntimeRegistry();
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  const transport = new FakeSourceTransport({
    fetchResponse: async (_path, init) => {
      const body = new ReadableStream<Uint8Array>({
        start: (controller) => {
          streams.push(controller);
          init!.signal!.addEventListener(
            "abort",
            () => {
              try {
                controller.close();
              } catch {}
            },
            { once: true },
          );
        },
      });
      return new Response(body, {
        headers: { "Content-Type": "application/x-ndjson" },
      });
    },
  });
  registry.registerSourceTransport(sourceKey, {
    kind: "custom",
    createTransport: () => transport,
  });
  setCurrentClientSummarySourceKey(sourceKey);
  versionMock.version = {
    capabilities: [
      PROJECT_QUEUE_CAPABILITY,
      SERVER_CAPABILITIES.projectCollectionUpdates.name,
    ],
  };
  const response = {
    items: [makeItem("live", PROJECT_ID)],
    projectStatuses: { [PROJECT_ID]: makeProjectStatus("ready") },
  };
  apiMock.getProjectQueueItems.mockResolvedValue(response);
  const settleLive = async () => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  };
  try {
    const hook = renderHook(() => useProjectQueues([PROJECT_ID]));
    await settleLive();
    expect(streams.length).toBeGreaterThan(0);
    const active = streams.at(-1)!;
    const seed = diffCollectionView(
      "/project-queue",
      1,
      undefined,
      collectionView(response, "/project-queue"),
    )!;
    await act(async () => {
      active.enqueue(new TextEncoder().encode(JSON.stringify(seed) + "\n"));
    });
    await settleLive();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(11000);
    });
    expect(apiMock.getProjectQueueItems).toHaveBeenCalledTimes(1);
    await act(async () => {
      active.enqueue(
        new TextEncoder().encode(
          JSON.stringify({ ...seed, revision: 100, base: 99 }) + "\n",
        ),
      );
    });
    await settleLive();
    expect(apiMock.getProjectQueueItems).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(apiMock.getProjectQueueItems).toHaveBeenCalledTimes(3);
    hook.unmount();
    await settleLive();
  } finally {
    registry.disposeSource(sourceKey);
    resetProjectQueueBackstopsForTests();
    vi.useRealTimers();
  }
});
