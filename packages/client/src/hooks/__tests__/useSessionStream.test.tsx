// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { asClientSummarySourceKey } from "../../lib/clientSummaryStore";
import type { YaSourceRuntime } from "../../lib/sourceRuntime";
import { SourceRuntimeProvider } from "../../lib/sourceRuntimeReact";
import {
  FakeSourceTransport,
  type FakeSourceTransportSubscriptionRecord,
} from "../../lib/transport";
import { useSessionStream } from "../useSessionStream";

function createRuntime(
  transport: FakeSourceTransport,
  sourceKey = "test:source",
): YaSourceRuntime {
  return {
    sourceKey: asClientSummarySourceKey(sourceKey),
    transport,
    api: {} as YaSourceRuntime["api"],
    summary: {} as YaSourceRuntime["summary"],
    sessionDetails: {} as YaSourceRuntime["sessionDetails"],
  };
}

function createWrapper(runtime: YaSourceRuntime) {
  return function TestSourceRuntimeProvider({
    children,
  }: {
    children: ReactNode;
  }) {
    return (
      <SourceRuntimeProvider runtime={runtime}>
        {children}
      </SourceRuntimeProvider>
    );
  };
}

function getOnlySessionSubscription(
  transport: FakeSourceTransport,
): FakeSourceTransportSubscriptionRecord {
  const subscriptions = transport.getSubscriptions("session");
  expect(subscriptions).toHaveLength(1);
  const subscription = subscriptions[0];
  if (!subscription) throw new Error("Expected session subscription");
  return subscription;
}

function getLastSessionSubscription(
  transport: FakeSourceTransport,
): FakeSourceTransportSubscriptionRecord {
  const subscription = transport.getSubscriptions("session").at(-1);
  if (!subscription) throw new Error("Expected session subscription");
  return subscription;
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  localStorage.clear();
});

describe("useSessionStream", () => {
  it("subscribes through the source runtime and forwards heartbeats", () => {
    const transport = new FakeSourceTransport();
    const onMessage = vi.fn();
    const onOpen = vi.fn();

    const { result } = renderHook(
      () => useSessionStream("session-1", { onMessage, onOpen }),
      { wrapper: createWrapper(createRuntime(transport)) },
    );

    const subscription = getOnlySessionSubscription(transport);
    expect(subscription).toMatchObject({
      sessionId: "session-1",
      lastEventId: undefined,
      options: { wantsLiveDeltas: false },
      closed: false,
    });

    act(() => {
      transport.openSubscription(subscription.id);
    });
    expect(result.current.connected).toBe(true);
    expect(onOpen).toHaveBeenCalledTimes(1);

    act(() => {
      transport.emitSubscriptionEvent(
        subscription.id,
        "heartbeat",
        {},
        "heartbeat-1",
      );
    });
    expect(onMessage).toHaveBeenCalledWith({ eventType: "heartbeat" });

    act(() => {
      transport.emitSubscriptionEvent(
        subscription.id,
        "message",
        { type: "assistant", role: "assistant" },
        "event-1",
      );
    });

    expect(onMessage).toHaveBeenCalledWith({
      eventType: "message",
      role: "assistant",
      type: "assistant",
    });
  });

  it("does not use heartbeat ids as resume cursors", () => {
    const transport = new FakeSourceTransport();

    renderHook(() => useSessionStream("session-1", { onMessage: vi.fn() }), {
      wrapper: createWrapper(createRuntime(transport)),
    });

    const first = getOnlySessionSubscription(transport);
    act(() => {
      transport.openSubscription(first.id);
      transport.emitSubscriptionEvent(first.id, "heartbeat", {}, "heartbeat-1");
      transport.setState("reconnecting");
      transport.setState("ready");
    });

    const second = getLastSessionSubscription(transport);
    expect(transport.getSubscriptions("session")).toHaveLength(2);
    expect(second).toMatchObject({
      sessionId: "session-1",
      lastEventId: undefined,
      closed: false,
    });
  });

  it("reconnect keeps the 50ms close-before-connect delay", async () => {
    vi.useFakeTimers();
    const transport = new FakeSourceTransport();

    const { result } = renderHook(
      () => useSessionStream("session-1", { onMessage: vi.fn() }),
      { wrapper: createWrapper(createRuntime(transport)) },
    );

    const first = getOnlySessionSubscription(transport);
    act(() => {
      transport.openSubscription(first.id);
      transport.emitSubscriptionEvent(first.id, "message", {}, "event-1");
    });

    act(() => {
      result.current.reconnect();
    });
    expect(transport.getSubscriptions("session")).toHaveLength(1);
    expect(transport.getSubscriptions("session")[0]).toMatchObject({
      id: first.id,
      closed: true,
      closeCalls: 1,
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(49);
    });
    expect(transport.getSubscriptions("session")).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    const second = getLastSessionSubscription(transport);
    expect(transport.getSubscriptions("session")).toHaveLength(2);
    expect(second).toMatchObject({
      sessionId: "session-1",
      lastEventId: "event-1",
      closed: false,
    });
  });

  it("isolates stream reconnects between source runtimes", () => {
    const firstTransport = new FakeSourceTransport();
    const secondTransport = new FakeSourceTransport();

    const first = renderHook(
      () => useSessionStream("session-1", { onMessage: vi.fn() }),
      {
        wrapper: createWrapper(
          createRuntime(firstTransport, "test:first-source"),
        ),
      },
    );
    const second = renderHook(
      () => useSessionStream("session-2", { onMessage: vi.fn() }),
      {
        wrapper: createWrapper(
          createRuntime(secondTransport, "test:second-source"),
        ),
      },
    );

    const firstSubscription = getOnlySessionSubscription(firstTransport);
    const secondSubscription = getOnlySessionSubscription(secondTransport);
    act(() => {
      firstTransport.openSubscription(firstSubscription.id);
      secondTransport.openSubscription(secondSubscription.id);
    });
    expect(first.result.current.connected).toBe(true);
    expect(second.result.current.connected).toBe(true);

    act(() => {
      firstTransport.setState("reconnecting");
    });

    expect(first.result.current.connected).toBe(false);
    expect(second.result.current.connected).toBe(true);
    expect(secondTransport.getSubscriptions("session")).toHaveLength(1);
    expect(secondTransport.getSubscriptions("session")[0]).toMatchObject({
      id: secondSubscription.id,
      closed: false,
    });

    act(() => {
      firstTransport.setState("ready");
    });

    expect(firstTransport.getSubscriptions("session")).toHaveLength(2);
    expect(secondTransport.getSubscriptions("session")).toHaveLength(1);
  });
});
