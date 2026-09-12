import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as compiler from "@yep-anywhere/shared/transcript/compiler";
import {
  decodeSnapshot,
  type ConversationQuery,
} from "@yep-anywhere/shared/experimental/simple-client.generated";
import {
  ConversationSubscriptions,
  MAX_CONVERSATION_SOURCES,
  MAX_CONVERSATION_SUBSCRIPTIONS,
  type ConversationConsumer,
  type ConversationSource,
} from "../src/experimental/conversation-subscriptions.js";
import type { ConversationInput } from "../src/experimental/conversation-projection.js";

function input(text = "Hello", sessionId = "session"): ConversationInput {
  return {
    sessionId,
    messages: [
      { type: "user", uuid: "u", content: "Question" },
      {
        type: "assistant",
        uuid: "a",
        content: [{ type: "text", text }],
      },
    ],
    activity: "working",
    pendingRequests: [],
    sourceCoverage: { complete: true, earlierOutsideScope: "no" },
  };
}
const query: ConversationQuery = {
  sessionId: "session",
  maxMessages: 20,
  anchorMessageId: null,
};
function consumer() {
  const frames: ReturnType<typeof decodeSnapshot>[] = [];
  return {
    frames,
    send: vi.fn((frame: string) => {
      frames.push(decodeSnapshot(frame));
    }),
    close: vi.fn(),
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function harness() {
  let current = input();
  let invalidate = () => {};
  let signal: AbortSignal;
  const source = {
    read: vi.fn(async () => current),
    close: vi.fn(),
  };
  const open = vi.fn(
    async (_id: string, notify: () => void, lifetime: AbortSignal) => {
      invalidate = notify;
      signal = lifetime;
      return source;
    },
  );
  const service = new ConversationSubscriptions(open);
  return {
    source,
    open,
    service,
    get signal() {
      return signal;
    },
    change(next: ConversationInput) {
      current = next;
      invalidate();
    },
  };
}

describe("shared Conversation subscriptions", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("shares one source, read and compilation across ten window consumers", async () => {
    const h = harness();
    const compile = vi.spyOn(compiler, "compileTranscriptProjection");
    const clients = Array.from({ length: 10 }, consumer);
    const stops = clients.map((client, index) =>
      h.service.subscribe(
        { ...query, maxMessages: index + 1 },
        `binding:${index}`,
        client,
      ),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(h.open).toHaveBeenCalledTimes(1);
    expect(h.source.read).toHaveBeenCalledTimes(1);
    expect(compile).toHaveBeenCalledTimes(1);
    expect(clients.every((client) => client.frames.length === 1)).toBe(true);
    expect(clients[0]!.frames[0]).toMatchObject({
      subscriptionId: "binding:0",
      sequence: 0,
      view: {
        messages: [{ id: "agent:u" }],
        coverage: { returnedMessages: 1 },
      },
    });
    for (const stop of stops.slice(0, 9)) stop();
    expect(h.source.close).not.toHaveBeenCalled();
    stops[9]!();
    expect(h.source.close).toHaveBeenCalledTimes(1);
    expect(h.signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("coalesces bursts, suppresses unchanged views and has no idle timer", async () => {
    const h = harness();
    const client = consumer();
    h.service.subscribe(query, "binding", client);
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 50; i++) h.change(input(`Update ${i}`));
    await vi.advanceTimersByTimeAsync(199);
    expect(h.source.read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.source.read).toHaveBeenCalledTimes(2);
    expect(client.frames[1]).toMatchObject({ sequence: 1 });
    expect(JSON.stringify(client.frames[1])).toContain("Update 49");
    h.change(input("Update 49"));
    await vi.advanceTimersByTimeAsync(60000);
    expect(h.source.read).toHaveBeenCalledTimes(3);
    expect(client.frames).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
    h.service.close();
  });

  it("does not overlap reads or publish a snapshot invalidated during acquisition", async () => {
    const h = harness();
    const first = deferred<ConversationInput>();
    h.source.read.mockImplementationOnce(() => first.promise);
    const client = consumer();
    h.service.subscribe(query, "binding", client);
    await vi.advanceTimersByTimeAsync(0);
    h.change(input("Latest"));
    await vi.advanceTimersByTimeAsync(500);
    expect(h.source.read).toHaveBeenCalledTimes(1);
    first.resolve(input("Obsolete"));
    await vi.advanceTimersByTimeAsync(0);
    expect(client.frames).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(h.source.read).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(client.frames[0])).toContain("Latest");
    h.service.close();
  });

  it("does not give a late joiner an already invalidated cached snapshot", async () => {
    const h = harness();
    h.service.subscribe(query, "first", consumer());
    await vi.advanceTimersByTimeAsync(0);
    h.change(input("New"));
    const late = consumer();
    h.service.subscribe(query, "late", late);
    expect(late.frames).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(late.frames).toHaveLength(1);
    expect(JSON.stringify(late.frames[0])).toContain("New");
    h.service.close();
  });

  it("reuses current state for late joiners and restarts sequence on reconnect", async () => {
    const h = harness();
    const stop = h.service.subscribe(query, "first", consumer());
    await vi.advanceTimersByTimeAsync(0);
    const second = consumer();
    const stopSecond = h.service.subscribe(query, "second", second);
    expect(second.frames[0]).toMatchObject({
      subscriptionId: "second",
      sequence: 0,
    });
    expect(h.source.read).toHaveBeenCalledTimes(1);
    stop();
    stopSecond();
    const third = consumer();
    h.service.subscribe(query, "third", third);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.open).toHaveBeenCalledTimes(2);
    expect(third.frames[0]).toMatchObject({
      subscriptionId: "third",
      sequence: 0,
    });
    h.service.close();
  });

  it("aborts pending acquisition and closes a source that opens after teardown", async () => {
    const opened = deferred<ConversationSource>();
    let signal: AbortSignal | undefined;
    const source = { read: vi.fn(async () => input()), close: vi.fn() };
    const service = new ConversationSubscriptions(
      async (_id, _notify, lifetime) => {
        signal = lifetime;
        return opened.promise;
      },
    );
    const client = consumer();
    const stop = service.subscribe(query, "binding", client);
    stop();
    stop();
    expect(signal?.aborted).toBe(true);
    opened.resolve(source);
    await vi.advanceTimersByTimeAsync(0);
    expect(source.read).not.toHaveBeenCalled();
    expect(source.close).toHaveBeenCalledTimes(1);
    expect(client.close).toHaveBeenCalledTimes(1);
    expect(client.frames).toHaveLength(0);
  });

  it("drops read completions and queued work after the final subscriber leaves", async () => {
    const h = harness();
    const reading = deferred<ConversationInput>();
    h.source.read.mockImplementationOnce(() => reading.promise);
    const client = consumer();
    const stop = h.service.subscribe(query, "binding", client);
    await vi.advanceTimersByTimeAsync(0);
    h.change(input("Later"));
    stop();
    reading.resolve(input());
    await vi.advanceTimersByTimeAsync(60000);
    expect(client.frames).toHaveLength(0);
    expect(h.source.read).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("isolates transport failure from healthy subscribers and releases its demand", async () => {
    const h = harness();
    const broken: ConversationConsumer = {
      send() {
        throw new Error("socket closed");
      },
      close() {
        throw new Error("already closed");
      },
    };
    h.service.subscribe(query, "broken", broken);
    const good = consumer();
    const stop = h.service.subscribe(query, "good", good);
    await vi.advanceTimersByTimeAsync(0);
    expect(good.frames).toHaveLength(1);
    expect(h.source.close).not.toHaveBeenCalled();
    stop();
    expect(h.source.close).toHaveBeenCalledTimes(1);
  });

  it("reports a source error without leaking details or scheduling idle retries", async () => {
    const h = harness();
    h.source.read.mockRejectedValueOnce(new Error("private provider path"));
    const client = consumer();
    h.service.subscribe(query, "binding", client);
    await vi.advanceTimersByTimeAsync(60000);
    expect(h.source.read).toHaveBeenCalledTimes(1);
    expect(client.frames[0]).toMatchObject({
      view: { kind: "error", code: "unavailable" },
    });
    expect(JSON.stringify(client.frames)).not.toContain(
      "private provider path",
    );
    h.change(input("Recovered"));
    await vi.advanceTimersByTimeAsync(0);
    expect(JSON.stringify(client.frames[1])).toContain("Recovered");
    h.service.close();
  });

  it("bounds admission before opening sources and releases capacity", async () => {
    const h = harness();
    const stops = Array.from({ length: MAX_CONVERSATION_SOURCES }, (_, i) =>
      h.service.subscribe(
        { ...query, sessionId: `session:${i}` },
        `binding:${i}`,
        consumer(),
      ),
    );
    expect(() => h.service.subscribe(query, "overflow", consumer())).toThrow(
      "source capacity",
    );
    expect(h.open).toHaveBeenCalledTimes(MAX_CONVERSATION_SOURCES);
    await vi.advanceTimersByTimeAsync(0);
    stops[0]!();
    h.service.subscribe(query, "admitted", consumer());
    h.service.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(() => h.service.subscribe(query, "closed", consumer())).toThrow(
      "are closed",
    );
  });

  it("bounds consumers independently of distinct source count", () => {
    const h = harness();
    for (let i = 0; i < MAX_CONVERSATION_SUBSCRIPTIONS; i++)
      h.service.subscribe(query, `binding:${i}`, consumer());
    expect(() => h.service.subscribe(query, "extra", consumer())).toThrow(
      "subscription capacity",
    );
    h.service.close();
  });

  it("rejects invalid queries before source acquisition", () => {
    const h = harness();
    expect(() =>
      h.service.subscribe({ ...query, maxMessages: 101 }, "id", consumer()),
    ).toThrow();
    expect(() => h.service.subscribe(query, "", consumer())).toThrow();
    expect(h.open).not.toHaveBeenCalled();
  });

  it("stops a publication superseded during a consumer callback", async () => {
    const h = harness();
    const first = consumer();
    first.send.mockImplementationOnce(() => {
      h.change(input("Newer"));
    });
    const second = consumer();
    h.service.subscribe(query, "first", first);
    h.service.subscribe(query, "second", second);
    await vi.advanceTimersByTimeAsync(0);
    expect(second.frames).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(second.frames[0]).toMatchObject({ sequence: 0 });
    expect(JSON.stringify(second.frames[0])).toContain("Newer");
    h.service.close();
  });

  it("retains admission slots while canceled source opens are still settling", async () => {
    const opens = Array.from({ length: MAX_CONVERSATION_SOURCES }, () =>
      deferred<ConversationSource>(),
    );
    let index = 0;
    const open = vi.fn(async () => opens[index++]!.promise);
    const service = new ConversationSubscriptions(open);
    for (let i = 0; i < MAX_CONVERSATION_SOURCES; i++) {
      const stop = service.subscribe(query, `binding:${i}`, consumer());
      stop();
    }
    expect(() => service.subscribe(query, "overflow", consumer())).toThrow(
      "source capacity",
    );
    expect(open).toHaveBeenCalledTimes(MAX_CONVERSATION_SOURCES);
    const source = { read: vi.fn(async () => input()), close: vi.fn() };
    for (const pending of opens) pending.resolve(source);
    await vi.advanceTimersByTimeAsync(0);
    expect(source.close).toHaveBeenCalledTimes(MAX_CONVERSATION_SOURCES);
    expect(source.read).not.toHaveBeenCalled();
    open.mockImplementation(async () => source);
    service.subscribe(query, "recovered", consumer());
    await vi.advanceTimersByTimeAsync(0);
    expect(source.read).toHaveBeenCalledTimes(1);
    service.close();
  });

  it("clears a scheduled refresh and closes every binding on shutdown", async () => {
    const h = harness();
    const clients = [consumer(), consumer()];
    clients.forEach((client, index) => {
      h.service.subscribe(query, `binding:${index}`, client);
    });
    await vi.advanceTimersByTimeAsync(0);
    h.change(input("Queued"));
    expect(vi.getTimerCount()).toBe(1);
    h.source.close.mockImplementation(() => {
      throw new Error("cleanup failed");
    });
    expect(() => h.service.close()).not.toThrow();
    await vi.advanceTimersByTimeAsync(60000);
    expect(h.source.read).toHaveBeenCalledTimes(1);
    expect(
      clients.every((client) => client.close.mock.calls.length === 1),
    ).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reconnects with a fresh owner when source abort synchronously triggers resubscription", async () => {
    const h = harness();
    const stop = h.service.subscribe(query, "first", consumer());
    await vi.advanceTimersByTimeAsync(0);
    const replacement = consumer();
    h.signal.addEventListener(
      "abort",
      () => {
        h.service.subscribe(query, "replacement", replacement);
      },
      { once: true },
    );
    stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.open).toHaveBeenCalledTimes(2);
    expect(replacement.frames[0]).toMatchObject({
      subscriptionId: "replacement",
      sequence: 0,
    });
    h.service.close();
  });
});
