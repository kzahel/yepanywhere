import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fetchPlainJSON } from "../../api/plainFetch";
import { connectLocalPreview } from "./localPreviewConnection";

vi.mock("../../api/plainFetch", () => ({ fetchPlainJSON: vi.fn() }));
const host = { id: "local", displayName: "localhost", mode: "local" as const };
const query = { sessionId: "session", maxMessages: 20, anchorMessageId: null };
class FakeEventSource extends EventTarget {
  static instances: FakeEventSource[] = [];
  close = vi.fn();
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;
  constructor(readonly url: string) {
    super();
    FakeEventSource.instances.push(this);
  }
}
beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.mocked(fetchPlainJSON).mockReset();
});
afterEach(() => vi.unstubAllGlobals());

it("uses the ordinary same-origin request helper and aborts outstanding reads on disposal", async () => {
  const owner = new AbortController();
  const connection = await connectLocalPreview(host, owner.signal, vi.fn());
  vi.mocked(fetchPlainJSON).mockResolvedValue({ sessions: [] });
  await expect(connection.fetch("/sessions?limit=50")).resolves.toEqual({
    sessions: [],
  });
  const request = vi.mocked(fetchPlainJSON).mock.calls[0];
  expect(request?.[0]).toBe("/sessions?limit=50");
  expect(request?.[1]?.signal?.aborted).toBe(false);
  owner.abort();
  expect(request?.[1]?.signal?.aborted).toBe(true);
});

it("reports cookie authentication failures as sign-in required", async () => {
  const connection = await connectLocalPreview(
    host,
    new AbortController().signal,
    vi.fn(),
  );
  vi.mocked(fetchPlainJSON).mockRejectedValue(
    Object.assign(new Error("Denied"), { status: 401 }),
  );
  await expect(connection.fetch("/sessions?limit=50")).rejects.toMatchObject({
    name: "MultiHostSignInRequiredError",
  });
  connection.close();
});

it("delivers snapshots and closes streams without automatic retries or late events", async () => {
  const owner = new AbortController();
  const connection = await connectLocalPreview(host, owner.signal, vi.fn());
  const handlers = { onEvent: vi.fn(), onError: vi.fn() };
  connection.subscribeConversation("binding", query, handlers);
  const stream = FakeEventSource.instances[0]!;
  expect(stream.url).toContain("/api/experimental/conversation/subscribe?");
  expect(
    new URL(stream.url, "http://localhost").searchParams.get("subscriptionId"),
  ).toBe("binding");
  stream.dispatchEvent(
    new MessageEvent("snapshot", { data: '{"sequence":0}' }),
  );
  expect(handlers.onEvent).toHaveBeenCalledWith("snapshot", undefined, {
    sequence: 0,
  });
  stream.onerror?.();
  expect(stream.close).toHaveBeenCalledTimes(1);
  expect(handlers.onError).toHaveBeenCalledTimes(1);
  stream.dispatchEvent(
    new MessageEvent("snapshot", { data: '{"sequence":1}' }),
  );
  expect(handlers.onEvent).toHaveBeenCalledTimes(1);
  connection.subscribeConversation("next-binding", query, handlers);
  owner.abort();
  expect(FakeEventSource.instances[1]?.close).toHaveBeenCalledTimes(1);
  expect(() =>
    connection.subscribeConversation("closed", query, handlers),
  ).toThrow();
});

it("stops malformed JSON and releases an explicitly closed subscription", async () => {
  const connection = await connectLocalPreview(
    host,
    new AbortController().signal,
    vi.fn(),
  );
  const handlers = { onEvent: vi.fn(), onError: vi.fn() };
  connection.subscribeConversation("bad", query, handlers);
  const stream = FakeEventSource.instances[0]!;
  stream.dispatchEvent(new MessageEvent("snapshot", { data: "bad JSON" }));
  expect(handlers.onEvent).not.toHaveBeenCalled();
  expect(handlers.onError).toHaveBeenCalledTimes(1);
  expect(stream.close).toHaveBeenCalled();
  const subscription = connection.subscribeConversation(
    "good",
    query,
    handlers,
  );
  subscription.close();
  expect(FakeEventSource.instances[1]?.close).toHaveBeenCalledTimes(1);
  connection.close();
});
