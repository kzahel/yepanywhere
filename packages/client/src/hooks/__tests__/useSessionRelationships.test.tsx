import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resetClientQueryControllerForTests } from "../../lib/clientQueryController";
import { useSessionRelationships } from "../useSessionRelationships";

const mocks = vi.hoisted(() => {
  const fetchA = vi.fn(),
    fetchB = vi.fn();
  return {
    fetchA,
    fetchB,
    runtime: { sourceKey: "host:a", transport: { fetch: fetchA } },
    handlers: new Map<string, Set<(data?: unknown) => void>>(),
  };
});
vi.mock("../../contexts/SourceRuntimeContext", () => ({
  useCurrentSourceRuntime: () => mocks.runtime,
}));
vi.mock("../../contexts/RemoteConnectionContext", () => ({
  useOptionalRemoteConnection: () => null,
}));
vi.mock("../../lib/connection", () => ({ isRemoteClient: () => false }));
vi.mock("../../lib/activityBus", () => ({
  activityBus: {
    on: (event: string, listener: (data?: unknown) => void) => {
      const listeners = mocks.handlers.get(event) ?? new Set();
      mocks.handlers.set(event, listeners);
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    retainSourceStream: () => () => {},
  },
}));

const page = (id: string) => ({
  relationships: [
    {
      type: "launched_harness",
      source: { kind: "session", sessionId: id },
      target: { kind: "session", sessionId: "child" },
      evidence: [],
    },
  ],
  nextCursor: null,
});
async function settle(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
beforeEach(() => {
  vi.useFakeTimers();
  resetClientQueryControllerForTests();
  mocks.handlers.clear();
  mocks.fetchA.mockReset();
  mocks.fetchB.mockReset();
  mocks.runtime = { sourceKey: "host:a", transport: { fetch: mocks.fetchA } };
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("shares snapshots, event refresh and request lifetime; the last release drops data and forces later reacquisition", async () => {
  mocks.fetchA.mockResolvedValue(page("first"));
  const a = renderHook(() => useSessionRelationships("project", "parent"));
  const b = renderHook(() => useSessionRelationships("project", "parent"));
  await settle();
  expect(mocks.fetchA).toHaveBeenCalledTimes(1);
  expect(a.result.current.page).toEqual(page("first"));
  expect(b.result.current.page).toBe(a.result.current.page);
  const signal = mocks.fetchA.mock.calls[0]![1].signal as AbortSignal;
  a.unmount();
  expect(signal.aborted).toBe(false);
  mocks.fetchA.mockResolvedValue(page("updated"));
  act(() => {
    for (let i = 0; i < 20; i++)
      for (const handler of mocks.handlers.get("session-metadata-changed") ??
        [])
        handler();
  });
  await settle(500);
  expect(mocks.fetchA).toHaveBeenCalledTimes(2);
  expect(b.result.current.page).toEqual(page("updated"));
  b.unmount();
  expect(signal.aborted).toBe(true);
  const c = renderHook(() => useSessionRelationships("project", "parent"));
  await settle();
  expect(mocks.fetchA).toHaveBeenCalledTimes(3);
  expect(c.result.current.page).toEqual(page("updated"));
});

it("does not publish a released request into a replacement owner or a different source", async () => {
  let finish!: (value: unknown) => void;
  mocks.fetchA
    .mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    )
    .mockResolvedValue(page("replacement"));
  const old = renderHook(() => useSessionRelationships("project", "parent"));
  await settle();
  old.unmount();
  const current = renderHook(() =>
    useSessionRelationships("project", "parent"),
  );
  await settle();
  expect(current.result.current.page).toEqual(page("replacement"));
  await act(async () => {
    finish(page("obsolete"));
  });
  expect(current.result.current.page).toEqual(page("replacement"));
  mocks.fetchB.mockResolvedValue(page("other-host"));
  mocks.runtime = { sourceKey: "host:b", transport: { fetch: mocks.fetchB } };
  current.rerender();
  await settle();
  expect(current.result.current.page).toEqual(page("other-host"));
  expect(mocks.fetchB).toHaveBeenCalledTimes(1);
});

it("keys pages by the opaque cursor and keeps later pages stable until explicit refresh", async () => {
  mocks.fetchA
    .mockResolvedValueOnce(page("first"))
    .mockResolvedValueOnce(page("second"));
  const hook = renderHook(
    ({ cursor }) => useSessionRelationships("project", "parent", cursor),
    { initialProps: { cursor: undefined as string | undefined } },
  );
  await settle();
  hook.rerender({ cursor: "opaque_cursor" });
  await settle();
  expect(hook.result.current.page).toEqual(page("second"));
  expect(mocks.fetchA.mock.calls[1]![0]).toContain("cursor=opaque_cursor");
  act(() => {
    for (const handler of mocks.handlers.get("session-metadata-changed") ?? [])
      handler();
  });
  await settle(500);
  expect(mocks.fetchA).toHaveBeenCalledTimes(2);
});

it("retries an unresolved anchor after the existing catalog publishes its identity", async () => {
  mocks.fetchA
    .mockRejectedValueOnce(
      Object.assign(new Error("Session not found"), { status: 404 }),
    )
    .mockResolvedValueOnce(page("published"));
  const hook = renderHook(() => useSessionRelationships("project", "parent"));
  await settle();
  expect(hook.result.current.page).toBeNull();
  expect(hook.result.current.error).toBeInstanceOf(Error);
  act(() => {
    for (const handler of mocks.handlers.get("session-catalog-updated") ?? [])
      handler({ catalog: { refreshing: true } });
  });
  await settle(500);
  expect(mocks.fetchA).toHaveBeenCalledTimes(1);
  act(() => {
    for (const handler of mocks.handlers.get("session-catalog-updated") ?? [])
      handler({ catalog: { refreshing: false } });
  });
  await settle(500);
  expect(hook.result.current.page).toEqual(page("published"));
  expect(hook.result.current.error).toBeNull();
});
