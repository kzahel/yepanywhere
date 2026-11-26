import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../../types";
import {
  applyVersionSnapshot,
  resetVersionQueryForTests,
} from "../../lib/versionQuery";

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  return {
    getProject: vi.fn(),
    getProjects: vi.fn(),
    isRemoteClient: vi.fn(() => false),
    remoteState: {
      connection: null as { connection: object | null } | null,
    },
    activityBus: {
      on: vi.fn((event: string, handler: (data: unknown) => void) => {
        let set = handlers.get(event);
        if (!set) {
          set = new Set();
          handlers.set(event, set);
        }
        set.add(handler);
        return () => handlers.get(event)?.delete(handler);
      }),
      emit(event: string, data?: unknown) {
        for (const handler of handlers.get(event) ?? []) {
          handler(data);
        }
      },
      reset() {
        handlers.clear();
      },
    },
  };
});

vi.mock("../../api/client", () => ({
  api: {
    getProject: mocks.getProject,
    getProjects: mocks.getProjects,
  },
}));

vi.mock("../../lib/activityBus", () => ({
  activityBus: {
    on: mocks.activityBus.on,
    onSource: (
      _sourceKey: string,
      event: string,
      handler: (data: unknown) => void,
    ) => mocks.activityBus.on(event, handler),
    retainSourceStream: vi.fn(() => () => {}),
  },
}));

vi.mock("../../lib/connection", () => ({
  isRemoteClient: mocks.isRemoteClient,
}));

vi.mock("../../contexts/RemoteConnectionContext", () => ({
  useOptionalRemoteConnection: () => mocks.remoteState.connection,
}));

import { resetClientQueryControllerForTests } from "../../lib/clientQueryController";
import {
  acquireClientQueryBootstrapSlot,
  resetClientQueryBootstrapForTests,
} from "../../lib/clientQueryBootstrap";
import { LOCAL_CLIENT_SUMMARY_SOURCE_KEY } from "../../lib/clientSummarySourceKey";
import { resetClientSummaryStoreForTests } from "../../lib/clientSummaryStore";
import { useProject, useProjects, useSessionProjects } from "../useProjects";
import { getSourceRuntimeRegistry } from "../../lib/sourceRuntime";
import {
  createClientSummaryHostSourceKey,
  setCurrentClientSummarySourceKey,
} from "../../lib/clientSummarySourceKey";

const RECENT = "2026-06-27T11:00:00.000Z";

function setVersion(current: string) {
  applyVersionSnapshot(
    { current, latest: null, updateAvailable: false },
    {
      sourceKey: LOCAL_CLIENT_SUMMARY_SOURCE_KEY,
      key: "version",
      coverage: {},
      requestStartedAt: Date.now(),
    },
  );
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
  });
}

function project(id: string, overrides: Partial<Project> = {}): Project {
  return {
    id,
    path: `/tmp/${id}`,
    name: `Project ${id}`,
    sessionCount: 1,
    activeOwnedCount: 0,
    activeExternalCount: 0,
    projectQueueBlockingCount: 0,
    lastActivity: RECENT,
    ...overrides,
  };
}

beforeEach(() => {
  setCurrentClientSummarySourceKey(LOCAL_CLIENT_SUMMARY_SOURCE_KEY);
  resetClientQueryBootstrapForTests();
  resetClientSummaryStoreForTests();
  resetClientQueryControllerForTests();
  mocks.getProject.mockReset();
  mocks.getProjects.mockReset();
  resetVersionQueryForTests();
  setVersion("0.9.2");
  vi.spyOn(
    getSourceRuntimeRegistry().getOrCreateSourceRuntime(
      LOCAL_CLIENT_SUMMARY_SOURCE_KEY,
    ).transport,
    "fetch",
  ).mockImplementation(mocks.getProjects);
  mocks.isRemoteClient.mockReset();
  mocks.isRemoteClient.mockReturnValue(false);
  mocks.remoteState.connection = null;
  mocks.activityBus.reset();
  mocks.activityBus.on.mockClear();
});

afterEach(() => {
  cleanup();
  resetClientQueryBootstrapForTests();
  resetClientQueryControllerForTests();
  resetClientSummaryStoreForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useProjects", () => {
  it("keeps a pending collection response bound to its original source", async () => {
    vi.useFakeTimers();
    let release!: (value: unknown) => void;
    mocks.getProjects.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const other = createClientSummaryHostSourceKey("other");
    const fetchOther = vi
      .spyOn(
        getSourceRuntimeRegistry().getOrCreateSourceRuntime(other).transport,
        "fetch",
      )
      .mockResolvedValue({ projects: [project("other-project")] });
    const hook = renderHook(() => useProjects({ bootstrapTier: "route" }));
    await settle();
    act(() => setCurrentClientSummarySourceKey(other));
    await settle();
    expect(hook.result.current.projects[0]?.id).toBe("other-project");
    act(() => release({ projects: [project("local-project")] }));
    await settle();
    expect(mocks.getProjects).toHaveBeenCalledExactlyOnceWith("/projects");
    expect(fetchOther).toHaveBeenCalledTimes(1);
    expect(hook.result.current.projects[0]?.id).toBe("other-project");
  });

  it("gates retained reads and waits for an incomplete collection to publish", async () => {
    vi.useFakeTimers();
    resetVersionQueryForTests();
    setVersion("0.9.4");
    mocks.getProjects
      .mockResolvedValueOnce({
        projects: [],
        catalog: { complete: false, refreshing: true },
      })
      .mockResolvedValueOnce({
        projects: [project("ready")],
        catalog: { complete: true, refreshing: false },
      });
    const first = renderHook(() => useProjects({ bootstrapTier: "route" }));
    const second = renderHook(() => useProjects({ bootstrapTier: "route" }));
    await settle();
    expect(mocks.getProjects).toHaveBeenCalledExactlyOnceWith(
      "/projects?summaryMode=retained",
    );
    expect(first.result.current.loading).toBe(true);
    expect(second.result.current.loading).toBe(true);
    await act(async () => {
      mocks.activityBus.emit("projects-changed", { projectIds: ["ready"] });
      await vi.advanceTimersByTimeAsync(500);
    });
    await settle();
    expect(first.result.current.loading).toBe(false);
    expect(second.result.current.projects[0]?.id).toBe("ready");
    expect(mocks.getProjects).toHaveBeenCalledTimes(2);
  });

  it("starts a route's project selector while unrelated route work is pending", async () => {
    vi.useFakeTimers();
    const unrelatedRoute = acquireClientQueryBootstrapSlot(
      LOCAL_CLIENT_SUMMARY_SOURCE_KEY,
      "route",
    );
    mocks.getProjects.mockResolvedValue({ projects: [project("project-a")] });
    renderHook(() => useProjects());
    await settle();
    expect(mocks.getProjects).not.toHaveBeenCalled();

    const selector = renderHook(() => useProjects({ bootstrapTier: "route" }));
    await settle();
    expect(selector.result.current.projects[0]?.id).toBe("project-a");
    expect(mocks.getProjects).toHaveBeenCalledTimes(1);
    expect(mocks.getProjects).toHaveBeenCalledWith("/projects");
    unrelatedRoute.settle();
    await settle();
    expect(mocks.getProjects).toHaveBeenCalledTimes(1);
  });

  it("feeds project list responses into the collection store", async () => {
    mocks.getProjects.mockResolvedValue({
      projects: [project("project-a"), project("project-b")],
    });

    const { result } = renderHook(() => useProjects());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBeNull();
    expect(result.current.projects.map((row) => row.id)).toEqual([
      "project-a",
      "project-b",
    ]);
    expect(mocks.getProjects).toHaveBeenCalledTimes(1);
  });

  it("coalesces project list refresh events through the retained query", async () => {
    vi.useFakeTimers();
    mocks.getProjects
      .mockResolvedValueOnce({
        projects: [project("project-a")],
      })
      .mockResolvedValueOnce({
        projects: [project("project-a"), project("project-b")],
      });

    const { result } = renderHook(() => useProjects());
    await settle();
    expect(result.current.loading).toBe(false);
    expect(mocks.getProjects).toHaveBeenCalledTimes(1);

    await act(async () => {
      mocks.activityBus.emit("refresh");
      mocks.activityBus.emit("reconnect");
      mocks.activityBus.emit("project-code-names-changed", {
        type: "project-code-names-changed",
        projectIds: ["project-a"],
        timestamp: RECENT,
      });
      await vi.advanceTimersByTimeAsync(499);
    });
    expect(mocks.getProjects).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.getProjects).toHaveBeenCalledTimes(2);
    expect(result.current.projects.map((row) => row.id)).toEqual([
      "project-a",
      "project-b",
    ]);
  });

  it("shares collection-backed project facts between list and detail hooks", async () => {
    mocks.getProjects.mockResolvedValue({
      projects: [project("project-a", { name: "List Project" })],
    });
    mocks.getProject.mockResolvedValue({
      project: project("project-a", {
        name: "Detail Project",
        sessionCount: 2,
      }),
    });

    const list = renderHook(() => useProjects());
    await waitFor(() => expect(list.result.current.loading).toBe(false));
    expect(list.result.current.projects[0]?.name).toBe("List Project");

    const detail = renderHook(() => useProject("project-a"));
    await waitFor(() => expect(detail.result.current.loading).toBe(false));

    expect(detail.result.current.project).toMatchObject({
      id: "project-a",
      name: "Detail Project",
      sessionCount: 2,
    });
    await waitFor(() =>
      expect(list.result.current.projects[0]?.name).toBe("Detail Project"),
    );
  });

  it("uses listed activity and reconnect changes, recovering detail for incomplete, missing or failed lists", async () => {
    vi.useFakeTimers();
    setVersion("0.9.4");
    const id = "streaming";
    const initial = project(id);
    const advanced = project(id, { lastActivity: "2026-07-01T10:00:00Z" });
    mocks.getProjects.mockResolvedValue({ projects: [initial] });
    mocks.getProject.mockResolvedValue({ project: initial });
    const sidebar = renderHook(() => useProjects());
    await settle();
    const view = renderHook(() => useSessionProjects(id));
    await settle();
    const detailAfterOpen = mocks.getProject.mock.calls.length;
    const listsAfterOpen = mocks.getProjects.mock.calls.length;
    async function refresh(event: string) {
      await act(async () => {
        mocks.activityBus.emit(event, { projectIds: [id] });
        await vi.advanceTimersByTimeAsync(500);
      });
      await settle();
    }
    mocks.getProjects.mockResolvedValue({ projects: [advanced] });
    await refresh("projects-changed");
    expect(view.result.current.project?.lastActivity).toBe(
      advanced.lastActivity,
    );
    const renamed = project(id, { name: "Reconnected" });
    mocks.getProjects.mockResolvedValue({ projects: [renamed] });
    await refresh("reconnect");
    expect(view.result.current.project?.name).toBe("Reconnected");
    expect(mocks.getProject).toHaveBeenCalledTimes(detailAfterOpen);
    expect(mocks.getProjects).toHaveBeenCalledTimes(listsAfterOpen + 2);

    // An incomplete snapshot retains old membership; the direct route remains
    // authoritative for that row and for directories absent from the list.
    mocks.getProjects.mockResolvedValue({
      projects: [],
      catalog: { complete: false },
    });
    const direct = project(id, { name: "Direct detail" });
    mocks.getProject.mockResolvedValue({ project: direct });
    await refresh("projects-changed");
    await refresh("projects-changed");
    expect(view.result.current.project?.name).toBe("Direct detail");
    mocks.getProjects.mockResolvedValue({ projects: [] });
    await refresh("projects-changed");
    expect(view.result.current.projects).toHaveLength(0);
    expect(view.result.current.project?.id).toBe(id);
    mocks.getProjects.mockResolvedValue({ projects: [renamed] });
    await refresh("reconnect");
    mocks.getProjects.mockRejectedValue(new Error("collection unavailable"));
    await refresh("projects-changed");
    expect(sidebar.result.current.complete).toBe(true);
    expect(sidebar.result.current.error).toBeNull();
    expect(view.result.current.project?.name).toBe("Direct detail");
    const before = mocks.getProject.mock.calls.length;
    await refresh("projects-changed");
    expect(mocks.getProject.mock.calls.length).toBeGreaterThan(before);
    expect(view.result.current.project?.name).toBe("Direct detail");
  });

  it("revalidates project detail for matching activity and code-name changes", async () => {
    vi.useFakeTimers();
    mocks.getProject
      .mockResolvedValueOnce({
        project: project("project-a", { activeOwnedCount: 1 }),
      })
      .mockResolvedValueOnce({
        project: project("project-a", { activeOwnedCount: 2 }),
      })
      .mockResolvedValueOnce({
        project: project("project-a", {
          activeOwnedCount: 2,
          codeName: "alp",
        }),
      });

    const detail = renderHook(() => useProject("project-a"));
    await settle();
    expect(detail.result.current.loading).toBe(false);
    expect(mocks.getProject).toHaveBeenCalledTimes(1);

    await act(async () => {
      mocks.activityBus.emit("process-state-changed", {
        type: "process-state-changed",
        sessionId: "session-b",
        projectId: "project-b",
        activity: "in-turn",
        timestamp: "2026-06-29T00:00:00.000Z",
      });
      await vi.advanceTimersByTimeAsync(500);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.getProject).toHaveBeenCalledTimes(1);

    await act(async () => {
      mocks.activityBus.emit("process-state-changed", {
        type: "process-state-changed",
        sessionId: "session-a",
        projectId: "project-a",
        activity: "in-turn",
        timestamp: "2026-06-29T00:00:01.000Z",
      });
      await vi.advanceTimersByTimeAsync(500);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.getProject).toHaveBeenCalledTimes(2);
    expect(detail.result.current.project?.activeOwnedCount).toBe(2);

    await act(async () => {
      mocks.activityBus.emit("project-code-names-changed", {
        type: "project-code-names-changed",
        projectIds: ["project-a"],
        timestamp: "2026-06-29T00:00:02.000Z",
      });
      await vi.advanceTimersByTimeAsync(500);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.getProject).toHaveBeenCalledTimes(3);
  });
});
