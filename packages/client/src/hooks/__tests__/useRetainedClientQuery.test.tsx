import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ClientQueryCoverage,
  type ClientQueryRequestContext,
  getClientQueryState,
  invalidateClientQuery,
  resetClientQueryControllerForTests,
} from "../../lib/clientQueryController";
import {
  getQueryRevalidationMetrics,
  resetQueryRevalidationForTests,
} from "../../lib/clientQueryRevalidation";
import {
  asClientSummarySourceKey,
  type ClientSummarySourceKey,
} from "../../lib/clientSummaryStore";
import { useRetainedClientQuery } from "../useRetainedClientQuery";

const busMock = vi.hoisted(() => {
  const handlers = new Map<string, Set<(data?: unknown) => void>>();
  return {
    on: vi.fn((event: string, handler: (data?: unknown) => void) => {
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
  };
});

vi.mock("../../lib/activityBus", () => ({
  activityBus: { on: busMock.on },
}));

const SOURCE = asClientSummarySourceKey("host:test");

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

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
  });
}

function renderRetainedQuery({
  sourceKey = SOURCE,
  ready = true,
  fetcher = vi.fn(async () => "loaded"),
  coverage,
  applySnapshot = vi.fn(),
  shouldRevalidateEvent,
}: {
  sourceKey?: ClientSummarySourceKey;
  ready?: boolean;
  fetcher?: ReturnType<typeof vi.fn<() => Promise<string>>>;
  coverage?: ClientQueryCoverage;
  applySnapshot?: (result: string, context: ClientQueryRequestContext) => void;
  shouldRevalidateEvent?: (event: {
    eventType: string;
    data: unknown;
  }) => boolean;
} = {}) {
  return renderHook(
    (props: { ready: boolean }) =>
      useRetainedClientQuery({
        sourceKey,
        key: { endpoint: "test" },
        coverage,
        ready: props.ready,
        debounceMs: 50,
        revalidateOn: ["refresh", "reconnect"],
        shouldRevalidateEvent,
        fetcher,
        applySnapshot,
      }),
    { initialProps: { ready } },
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  busMock.reset();
  busMock.on.mockClear();
  resetClientQueryControllerForTests();
  resetQueryRevalidationForTests();
});

afterEach(() => {
  cleanup();
  resetQueryRevalidationForTests();
  resetClientQueryControllerForTests();
  vi.useRealTimers();
});

describe("useRetainedClientQuery", () => {
  it("does not fetch before ready and fetches when ready flips true", async () => {
    const fetcher = vi.fn(async () => "loaded");
    const applySnapshot = vi.fn();
    const hook = renderRetainedQuery({
      ready: false,
      fetcher,
      applySnapshot,
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(hook.result.current.loading).toBe(true);

    hook.rerender({ ready: true });

    await settle();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(hook.result.current.loading).toBe(false);
    expect(applySnapshot).toHaveBeenCalledWith(
      "loaded",
      expect.objectContaining({ sourceKey: SOURCE }),
    );
  });

  it("coalesces refresh and reconnect events into one forced request", async () => {
    const fetcher = vi.fn(async () => "loaded");
    renderRetainedQuery({ fetcher });

    await settle();
    expect(fetcher).toHaveBeenCalledTimes(1);

    await act(async () => {
      busMock.emit("refresh");
      busMock.emit("reconnect");
      await vi.advanceTimersByTimeAsync(49);
    });
    expect(fetcher).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("lets callers ignore revalidation events", async () => {
    const fetcher = vi.fn(async () => "loaded");
    const shouldRevalidateEvent = vi.fn(() => false);
    renderRetainedQuery({ fetcher, shouldRevalidateEvent });

    await settle();
    expect(fetcher).toHaveBeenCalledTimes(1);

    await act(async () => {
      busMock.emit("refresh", { reason: "known-local-update" });
      await vi.advanceTimersByTimeAsync(50);
    });

    await settle();
    expect(shouldRevalidateEvent).toHaveBeenCalledWith({
      eventType: "refresh",
      data: { reason: "known-local-update" },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("shares a forced refresh across mounted retained consumers", async () => {
    const revalidation = deferred<string>();
    const fetcher = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("loaded")
      .mockReturnValueOnce(revalidation.promise);
    renderRetainedQuery({ fetcher });
    renderRetainedQuery({ fetcher });

    await settle();
    expect(fetcher).toHaveBeenCalledTimes(1);

    await act(async () => {
      busMock.emit("refresh");
      await vi.advanceTimersByTimeAsync(50);
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(getClientQueryState(SOURCE, { endpoint: "test" })).toMatchObject({
      inFlight: true,
      stale: true,
    });

    revalidation.resolve("updated");
    await settle();

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(getClientQueryState(SOURCE, { endpoint: "test" })).toMatchObject({
      inFlight: false,
      stale: false,
    });
  });

  it("does not publish a dominated foreground failure after broader coverage lands", async () => {
    const narrowRequest = deferred<string>();
    const broadRequest = deferred<string>();
    const fetcher = vi
      .fn<() => Promise<string>>()
      .mockReturnValueOnce(narrowRequest.promise)
      .mockReturnValueOnce(broadRequest.promise);
    let snapshot: string | null = null;
    const applySnapshot = vi.fn((result: string) => {
      snapshot = result;
    });

    const narrow = renderRetainedQuery({
      coverage: { minRows: 50 },
      fetcher,
      applySnapshot,
    });
    const broad = renderRetainedQuery({
      coverage: { minRows: 100 },
      fetcher,
      applySnapshot,
    });
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(2);

    broadRequest.resolve("broad");
    await settle();
    narrowRequest.reject(new Error("obsolete narrow failure"));
    await settle();

    expect(snapshot).toBe("broad");
    expect(narrow.result.current.error).toBeNull();
    expect(narrow.result.current.loading).toBe(false);
    expect(broad.result.current.error).toBeNull();
    expect(getClientQueryState(SOURCE, { endpoint: "test" })).toMatchObject({
      coverage: { minRows: 100 },
      stale: false,
      error: undefined,
    });
  });

  it("does not treat an obsolete no-data failure as a successful acquisition", async () => {
    const generationA = deferred<string>();
    const generationB = deferred<string>();
    const fetcher = vi
      .fn<() => Promise<string>>()
      .mockReturnValueOnce(generationA.promise)
      .mockReturnValueOnce(generationB.promise)
      .mockRejectedValueOnce(new Error("later current failure"));

    const first = renderRetainedQuery({ fetcher });
    const second = renderRetainedQuery({ ready: false, fetcher });
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(1);

    act(() => {
      invalidateClientQuery(SOURCE, { endpoint: "test" });
    });
    second.rerender({ ready: true });
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(2);

    generationB.reject(new Error("generation B failure"));
    await settle();
    expect(second.result.current.error?.message).toBe("generation B failure");

    generationA.reject(new Error("obsolete generation A failure"));
    await settle();
    expect(first.result.current.error).toBeNull();

    await act(async () => {
      busMock.emit("refresh");
      await vi.advanceTimersByTimeAsync(50);
    });
    await settle();

    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(first.result.current.error?.message).toBe("later current failure");
  });

  it("keeps background revalidation errors quiet after data has loaded", async () => {
    const fetcher = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("loaded")
      .mockRejectedValueOnce(new Error("offline"));
    const hook = renderRetainedQuery({ fetcher });

    await settle();
    expect(hook.result.current.loading).toBe(false);
    expect(hook.result.current.error).toBeNull();

    await act(async () => {
      busMock.emit("refresh");
      await vi.advanceTimersByTimeAsync(50);
    });

    await settle();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(hook.result.current.error).toBeNull();
    expect(hook.result.current.loading).toBe(false);
  });

  it("cleans up subscriptions and pending timers on unmount", async () => {
    const fetcher = vi.fn(async () => "loaded");
    const hook = renderRetainedQuery({ fetcher });
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(1);

    await act(async () => {
      busMock.emit("refresh");
    });
    hook.unmount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(fetcher).toHaveBeenCalledTimes(1);

    await act(async () => {
      busMock.emit("reconnect");
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("useRetainedClientQuery revalidation ownership", () => {
  it("installs one listener set and one timer for many consumers", async () => {
    const fetcher = vi.fn(async () => "loaded");
    for (let i = 0; i < 20; i += 1) renderRetainedQuery({ fetcher });
    await settle();

    const metrics = getQueryRevalidationMetrics();
    expect(metrics.owners).toBe(1);
    expect(metrics.subscribers).toBe(20);
    // The union of `revalidateOn`, once — not once per consumer.
    expect(metrics.eventSubscriptions).toBe(2);

    await act(async () => {
      busMock.emit("reconnect");
    });
    expect(getQueryRevalidationMetrics().armedTimers).toBe(1);
  });

  it("costs one request per event even when the response beats the debounce", async () => {
    // The defect this ownership change exists to remove. With a per-consumer
    // debounce, the first hook's revalidation could complete before the second
    // hook's timer fired, leaving no in-flight request to join, so one
    // `reconnect` cost two round trips. It is latency-dependent, so an
    // instantly-resolving fetcher is the case that reproduces it.
    const fetcher = vi.fn(async () => "loaded");
    renderRetainedQuery({ fetcher });
    renderRetainedQuery({ fetcher });
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(1);

    await act(async () => {
      busMock.emit("reconnect");
      await vi.advanceTimersByTimeAsync(50);
    });
    await settle();

    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("releases listeners only when the last consumer unmounts", async () => {
    const fetcher = vi.fn(async () => "loaded");
    const first = renderRetainedQuery({ fetcher });
    const second = renderRetainedQuery({ fetcher });
    await settle();
    expect(getQueryRevalidationMetrics().owners).toBe(1);

    first.unmount();
    expect(getQueryRevalidationMetrics()).toMatchObject({
      owners: 1,
      subscribers: 1,
      eventSubscriptions: 2,
    });

    second.unmount();
    expect(getQueryRevalidationMetrics()).toMatchObject({
      owners: 0,
      subscribers: 0,
      eventSubscriptions: 0,
      armedTimers: 0,
    });
  });

  it("keeps separate owners per source", async () => {
    const fetcher = vi.fn(async () => "loaded");
    renderRetainedQuery({ fetcher, sourceKey: SOURCE });
    renderRetainedQuery({
      fetcher,
      sourceKey: asClientSummarySourceKey("host:other"),
    });
    await settle();

    expect(getQueryRevalidationMetrics().owners).toBe(2);
  });
});
