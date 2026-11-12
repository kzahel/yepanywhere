import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { encodeCapabilityIds, SERVER_CAPABILITIES } from "@yep-anywhere/shared";
import {
  collectionView,
  diffCollectionView,
  type CollectionUpdate,
} from "@yep-anywhere/shared/collection-updates";
import { useCollectionUpdates } from "../useCollectionUpdates";
import { FakeSourceTransport } from "../../lib/transport/FakeSourceTransport";
import {
  createSourceRuntimeRegistry,
  type YaSourceRuntime,
} from "../../lib/sourceRuntime";
import {
  collectionQueryIsLive,
  collectionQueryCoverage,
  expandCollectionUpdates,
  retainCollectionUpdates,
  pauseCollectionUpdates,
} from "../../lib/collectionUpdates";
import {
  ensureClientQuery,
  resetClientQueryControllerForTests,
} from "../../lib/clientQueryController";
import {
  getQueryRevalidationMetrics,
  resetQueryRevalidationForTests,
  retainQueryRevalidation,
} from "../../lib/clientQueryRevalidation";

import { asClientSummarySourceKey } from "../../lib/clientSummarySourceKey";

const version = vi.hoisted(() => ({
  current: { current: "0.12.0" } as Record<string, unknown> | null,
}));
vi.mock("../useVersion", () => ({
  useRetainedVersionInfo: () => version.current,
}));
interface Request {
  path: string;
  signal: AbortSignal;
  send(frame: CollectionUpdate, split?: boolean): void;
  sendMany(frames: CollectionUpdate[]): void;
}
const registries: Array<() => void> = [];
function fixture(rawSourceKey: string) {
  const sourceKey = asClientSummarySourceKey(rawSourceKey);
  const requests: Request[] = [];
  const transport = new FakeSourceTransport({
    fetchResponse: async (path, init) => {
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({
        start: (c) => {
          controller = c;
        },
      });
      const signal = init!.signal!;
      signal.addEventListener(
        "abort",
        () => {
          try {
            controller.close();
          } catch {}
        },
        { once: true },
      );
      requests.push({
        path,
        signal,
        sendMany: (frames) =>
          controller.enqueue(
            new TextEncoder().encode(
              frames.map((frame) => JSON.stringify(frame) + "\n").join(""),
            ),
          ),
        send: (frame, split) => {
          const bytes = new TextEncoder().encode(JSON.stringify(frame) + "\n");
          if (split) {
            controller.enqueue(bytes.slice(0, bytes.length - 3));
            controller.enqueue(bytes.slice(bytes.length - 3));
          } else controller.enqueue(bytes);
        },
      });
      return new Response(body, {
        headers: { "Content-Type": "application/x-ndjson" },
      });
    },
  });
  const registry = createSourceRuntimeRegistry();
  registries.push(() => registry.disposeSource(sourceKey));
  registry.registerSourceTransport(sourceKey, {
    kind: "custom",
    createTransport: () => transport,
  });
  return {
    runtime: registry.getOrCreateSourceRuntime(sourceKey),
    requests,
    transport,
  };
}
const key = "shared-query";
const path = "/sessions?limit=100";
const document = (title: string) =>
  collectionView({ sessions: [{ id: "same", title }], hasMore: false });
const initial = (title: string, query = path, revision = 1) =>
  diffCollectionView(query, revision, undefined, document(title))!;
const flush = async (assertion: () => void) => {
  await act(async () => {
    await vi.waitFor(assertion, { interval: 5 });
  });
};
function useObserve(
  runtime: YaSourceRuntime,
  publish: (body: Record<string, unknown>) => void,
  fallback = () => {},
  rows = 100,
) {
  useCollectionUpdates({
    runtime,
    key,
    path,
    rows,
    enabled: true,
    applySnapshot: publish,
    fallback,
  });
}
beforeEach(() => {
  version.current = { current: "0.12.0" };
});
afterEach(() => {
  cleanup();
  registries.splice(0).forEach((dispose) => {
    dispose();
  });
  resetClientQueryControllerForTests();
  resetQueryRevalidationForTests();
});

it("shares a query stream, fences a late REST response, and cancels queued whole-list revalidation", async () => {
  const { runtime, requests } = fixture("stream-one");
  const accepted: unknown[] = [];
  let oldResolve!: (body: unknown) => void;
  const old = ensureClientQuery({
    sourceKey: runtime.sourceKey,
    key,
    fetcher: () =>
      new Promise((resolve) => {
        oldResolve = resolve;
      }),
    applySnapshot: (body) => {
      accepted.push(body);
    },
  });
  const first = renderHook(() =>
    useObserve(runtime, (body) => {
      accepted.push(body);
    }),
  );
  const second = renderHook(() =>
    useObserve(runtime, (body) => {
      accepted.push(body);
    }),
  );
  await flush(() => expect(requests).toHaveLength(1));
  const run = vi.fn();
  const revalidation = retainQueryRevalidation({
    sourceKey: runtime.sourceKey,
    key,
    subscriber: { events: ["session-catalog-updated"], debounceMs: 500, run },
  });
  revalidation.schedule();
  expect(getQueryRevalidationMetrics().armedTimers).toBe(1);
  requests[0]!.send(initial("héllo 😺"), true);
  await flush(() => expect(accepted).toHaveLength(1));
  expect(collectionQueryIsLive(runtime, key)).toBe(true);
  expect(getQueryRevalidationMetrics().armedTimers).toBe(0);
  oldResolve({ sessions: [{ id: "old" }] });
  await old;
  expect(accepted).toHaveLength(1);
  requests[0]!.send(
    diffCollectionView(path, 2, document("héllo 😺"), document("changed"))!,
  );
  await flush(() => expect(accepted).toHaveLength(2));
  expect(accepted[1]).toEqual({
    sessions: [{ id: "same", title: "changed" }],
    hasMore: false,
  });
  first.unmount();
  expect(requests[0]!.signal.aborted).toBe(false);
  second.unmount();
  await flush(() => expect(requests[0]!.signal.aborted).toBe(true));
  expect(collectionQueryIsLive(runtime, key)).toBe(false);
  revalidation.release();
});

it("fences an old stream around REST pagination and widens shared coverage before resuming", async () => {
  const { runtime, requests } = fixture("stream-pagination");
  const accepted: unknown[] = [];
  renderHook(() =>
    useObserve(runtime, (body) => {
      accepted.push(body);
    }),
  );
  await flush(() => expect(requests).toHaveLength(1));
  requests[0]!.send(initial("first"));
  await flush(() => expect(accepted).toHaveLength(1));
  const resume = pauseCollectionUpdates(runtime, key);
  requests[0]!.send(
    diffCollectionView(path, 2, document("first"), document("obsolete"))!,
  );
  resume(200);
  await flush(() => expect(requests).toHaveLength(2));
  const queries = JSON.parse(
    new URL(requests[1]!.path, "http://source").searchParams.get("queries")!,
  );
  expect(queries).toEqual(["/sessions?limit=200"]);
  expect(accepted).toHaveLength(1);
  requests[1]!.send(initial("fresh page", "/sessions?limit=200"));
  await flush(() => expect(accepted).toHaveLength(2));
  const release = pauseCollectionUpdates(runtime, key);
  release(600);
  await flush(() => expect(requests[1]!.signal.aborted).toBe(true));
  expect(collectionQueryIsLive(runtime, key)).toBe(false);
});

it("keeps colliding sources separate and recovers a missed delta with a new authoritative snapshot", async () => {
  const a = fixture("stream-a"),
    b = fixture("stream-b");
  const receivedA: unknown[] = [],
    receivedB: unknown[] = [];
  const fallback = vi.fn();
  renderHook(() =>
    useObserve(
      a.runtime,
      (body) => {
        receivedA.push(body);
      },
      fallback,
    ),
  );
  renderHook(() =>
    useObserve(b.runtime, (body) => {
      receivedB.push(body);
    }),
  );
  await flush(() => {
    expect(a.requests).toHaveLength(1);
    expect(b.requests).toHaveLength(1);
  });
  a.requests[0]!.send(initial("host A"));
  b.requests[0]!.send(initial("host B"));
  await flush(() => {
    expect(receivedA).toHaveLength(1);
    expect(receivedB).toHaveLength(1);
  });
  a.requests[0]!.send({ ...initial("missing"), base: 8, revision: 9 });
  await flush(() => expect(fallback).toHaveBeenCalledTimes(1));
  expect(a.requests[0]!.signal.aborted).toBe(true);
  await flush(() => expect(a.requests).toHaveLength(2));
  a.requests[1]!.send(initial("host A recovered", path, 12));
  await flush(() => expect(receivedA).toHaveLength(2));
  expect(receivedB).toEqual([
    { sessions: [{ id: "same", title: "host B" }], hasMore: false },
  ]);
  a.transport.emitVisibilityRestored();
  await flush(() => expect(a.requests).toHaveLength(3));
  expect(b.requests).toHaveLength(1);
});

it.each([
  null,
  { current: "0.11.0" },
  { current: "0.12.0", deniedCapabilityBits: encodeCapabilityIds([156]) },
])(
  "keeps the existing reader without issuing an unsupported stream request: %j",
  async (value) => {
    version.current = value;
    const { runtime, requests } = fixture("stream-unsupported");
    renderHook(() => useObserve(runtime, () => {}));
    await act(async () => {
      await Promise.resolve();
    });
    expect(requests).toHaveLength(0);
  },
);

it("parses valid coalesced lines whose combined transport chunk exceeds the per-frame bound", async () => {
  const { runtime, requests } = fixture("stream-coalesced");
  const accepted: Record<string, unknown>[] = [];
  const fallback = vi.fn();
  renderHook(() =>
    useObserve(
      runtime,
      (body) => {
        accepted.push(body);
      },
      fallback,
    ),
  );
  await flush(() => expect(requests).toHaveLength(1));
  const first = collectionView({
    sessions: [{ id: "same", title: "first" }],
    padding: "x".repeat(1_100_000),
  });
  const next = collectionView({
    sessions: [{ id: "same", title: "last" }],
    padding: "y".repeat(1_100_000),
  });
  requests[0]!.sendMany([
    diffCollectionView(path, 1, undefined, first)!,
    diffCollectionView(path, 2, first, next)!,
  ]);
  await flush(() =>
    expect((accepted.at(-1)?.padding as string | undefined)?.slice(0, 3)).toBe(
      "yyy",
    ),
  );
  expect(fallback).not.toHaveBeenCalled();
  expect(collectionQueryIsLive(runtime, key)).toBe(true);
});

it("keeps an expanded query attached with another view retained and preserves failed expansion coverage", async () => {
  const { runtime, requests } = fixture("stream-expansion");
  const accepted: unknown[] = [];
  const fallback = vi.fn();
  const inbox = retainCollectionUpdates(runtime, "inbox", {
    path: "/inbox",
    rows: 0,
    publish: async () => {},
    fallback: () => {},
  });
  const hook = renderHook(
    ({ rows }) =>
      useObserve(
        runtime,
        (body) => {
          accepted.push(body);
        },
        fallback,
        rows,
      ),
    { initialProps: { rows: 100 } },
  );
  await flush(() => expect(requests).toHaveLength(1));
  requests[0]!.send(initial("first"));
  await flush(() => expect(accepted).toHaveLength(1));
  expect(expandCollectionUpdates(runtime, key, 200)).toBe(true);
  await flush(() => expect(requests).toHaveLength(2));
  requests[1]!.send(initial("second", "/sessions?limit=200"));
  await flush(() => expect(accepted).toHaveLength(2));
  hook.rerender({ rows: 200 });
  await act(async () => {});
  expect(requests).toHaveLength(2);
  requests[1]!.send(
    diffCollectionView(
      "/sessions?limit=200",
      2,
      document("second"),
      document("third"),
    )!,
  );
  await flush(() => expect(accepted).toHaveLength(3));
  expect(expandCollectionUpdates(runtime, key, 300)).toBe(true);
  expect(collectionQueryCoverage(runtime, key)).toBe(300);
  await flush(() => expect(requests).toHaveLength(3));
  requests[2]!.send({
    ...initial("missed", "/sessions?limit=300"),
    base: 8,
    revision: 9,
  });
  await flush(() => expect(fallback).toHaveBeenCalled());
  expect(collectionQueryCoverage(runtime, key)).toBe(300);
  hook.unmount();
  inbox();
});

it("does not broaden session-update support to withdrawn project query support", async () => {
  version.current = {
    current: "0.12.0",
    deniedCapabilityBits: encodeCapabilityIds([157]),
  };
  const { runtime, requests } = fixture("project-capability-withdrawal");
  renderHook(() =>
    useCollectionUpdates({
      runtime,
      key: "projects",
      path: "/projects?summaryMode=retained",
      enabled: true,
      capability: SERVER_CAPABILITIES.projectCollectionUpdates.name,
      applySnapshot: () => {},
      fallback: () => {},
    }),
  );
  renderHook(() => useObserve(runtime, () => {}));
  await flush(() => expect(requests).toHaveLength(1));
  const queries = JSON.parse(
    new URL(requests[0]!.path, "http://source").searchParams.get("queries")!,
  );
  expect(queries).toEqual([path]);
});

it("does not restart supported streams when a legacy-only query performs a REST read", async () => {
  const { runtime, requests } = fixture("legacy-query-pause");
  renderHook(() => useObserve(runtime, () => {}));
  await flush(() => expect(requests).toHaveLength(1));
  requests[0]!.send(initial("supported"));
  await flush(() => expect(collectionQueryIsLive(runtime, key)).toBe(true));
  const resume = pauseCollectionUpdates(runtime, "unsupported-project-query");
  await act(async () => {});
  expect(requests[0]!.signal.aborted).toBe(false);
  resume();
  await act(async () => {});
  expect(requests).toHaveLength(1);
});

it("negotiates metadata fields explicitly and returns to legacy after capability withdrawal", async () => {
  version.current = {
    current: "0.12.0",
    capabilityBits: encodeCapabilityIds([
      SERVER_CAPABILITIES.collectionQueryUpdates.id,
      SERVER_CAPABILITIES.collectionMetadataFields.id,
    ]),
  };
  const { runtime, requests } = fixture("metadata-fields");
  const accepted: Record<string, unknown>[] = [];
  const hook = renderHook(() =>
    useObserve(runtime, (body) => {
      accepted.push(body);
    }),
  );
  await flush(() => expect(requests).toHaveLength(1));
  expect(requests[0]!.path).toContain("metadata=fields");
  const first = collectionView({
    sessions: [{ id: "same" }],
    projects: [{ id: "p" }],
    catalog: { generation: 1 },
    nextTransitionAt: 10,
  });
  const second = collectionView({
    sessions: [{ id: "same" }],
    projects: [{ id: "p" }],
    catalog: { generation: 2 },
  });
  requests[0]!.send(diffCollectionView(path, 1, undefined, first, true)!);
  await flush(() => expect(accepted).toHaveLength(1));
  requests[0]!.send(diffCollectionView(path, 2, first, second, true)!);
  await flush(() => expect(accepted).toHaveLength(2));
  expect(accepted[1]).toEqual({
    sessions: [{ id: "same" }],
    projects: [{ id: "p" }],
    catalog: { generation: 2 },
  });
  expect(accepted[1]!.projects).toBe(accepted[0]!.projects);
  version.current = { current: "0.12.0" };
  hook.rerender();
  await flush(() => expect(requests).toHaveLength(2));
  expect(requests[0]!.signal.aborted).toBe(true);
  expect(requests[1]!.path).not.toContain("metadata=fields");
  requests[1]!.send(diffCollectionView(path, 3, undefined, first)!);
  await flush(() => expect(accepted).toHaveLength(3));
  expect(accepted[2]!.nextTransitionAt).toBe(10);
});
