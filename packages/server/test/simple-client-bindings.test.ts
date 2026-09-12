import {
  createConnectionState,
  createSendFn,
  handleMessage,
  type RelayHandlerDeps,
} from "../src/routes/ws-relay-handlers.js";
import {
  encryptToBinaryEnvelopeWithCompression,
  decryptBinaryEnvelope,
} from "../src/crypto/index.js";
import { getServerCapabilities } from "../src/routes/version.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import {
  CONVERSATION_API_REVISION,
  CONVERSATION_CHANNEL,
} from "@yep-anywhere/shared/experimental/conversation-protocol";
import { decodeSnapshot } from "@yep-anywhere/shared/experimental/simple-client.generated";
import { ConversationSubscriptions } from "../src/experimental/conversation-subscriptions.js";
import { createExperimentalConversationRoutes } from "../src/routes/experimental-conversation.js";
import { subscribeConversationRelay } from "../src/experimental/conversation-relay.js";
import type { RelaySubscribe } from "@yep-anywhere/shared";

const services: ConversationSubscriptions[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.close();
});
function harness() {
  const close = vi.fn();
  const open = vi.fn(async () => ({
    close,
    read: async () => ({
      sessionId: "s",
      messages: [{ type: "user" as const, uuid: "u", content: "Hello" }],
      activity: "idle" as const,
      pendingRequests: [],
      sourceCoverage: { complete: true, earlierOutsideScope: "no" as const },
    }),
  }));
  const service = new ConversationSubscriptions(open);
  services.push(service);
  const app = new Hono().route(
    "/api/experimental/conversation",
    createExperimentalConversationRoutes(service),
  );
  return { service, app, open, close };
}
function url(subscribe = false, fields: Record<string, string> = {}) {
  return `/api/experimental/conversation${subscribe ? "/subscribe" : ""}?${new URLSearchParams({ apiRevision: CONVERSATION_API_REVISION, subscriptionId: "binding", sessionId: "s", maxMessages: "20", ...fields })}`;
}
const message: RelaySubscribe = {
  type: "subscribe",
  subscriptionId: "binding",
  channel: CONVERSATION_CHANNEL,
  apiRevision: CONVERSATION_API_REVISION,
  query: { sessionId: "s", maxMessages: 20, anchorMessageId: null },
};

describe("experimental Conversation bindings", () => {
  it("releases demand even when the transport throws while sending closed", async () => {
    const h = harness();
    const bindings = new Map<string, () => void>();
    const send = vi.fn((event: { type: string; eventType?: string }) => {
      if (event.eventType === "closed") throw new Error("Closed socket");
    });
    subscribeConversationRelay(bindings, message, send, h.service);
    await vi.waitFor(() => expect(send).toHaveBeenCalled());
    expect(() => bindings.get("binding")!()).toThrow("Closed socket");
    expect(h.close).toHaveBeenCalledTimes(1);
    expect(bindings.size).toBe(0);
  });

  it("advertises the optional capability only when mounted and not denied", () => {
    const capability = "experimental-simple-client-conversation";
    expect(getServerCapabilities()).not.toContain(capability);
    expect(
      getServerCapabilities({
        getExperimentalConversationAvailable: () => true,
      }),
    ).toContain(capability);
    expect(
      getServerCapabilities({
        getExperimentalConversationAvailable: () => true,
        deniedCapabilities: [capability],
      }),
    ).not.toContain(capability);
  });

  it.each([false, true])(
    "carries snapshots through the authenticated dispatcher (encrypted=%s)",
    async (encrypted) => {
      const h = harness();
      const state = createConnectionState();
      state.authState = "authenticated";
      state.connectionPolicy = encrypted
        ? "srp_required"
        : "local_unrestricted";
      if (encrypted) {
        state.sessionKey = new Uint8Array(32).fill(3);
        state.connectionMode = "srp";
      }
      const ws = { send: vi.fn(), close: vi.fn() };
      const send = createSendFn(ws, state);
      const bindings = new Map<string, () => void>();
      const deps = {
        app: h.app,
        baseUrl: "http://localhost",
        supervisor: {},
        eventBus: {},
        uploadManager: {},
        conversationSubscriptions: h.service,
      } as unknown as RelayHandlerDeps;
      const encode = (msg: unknown, seq: number) =>
        encrypted
          ? encryptToBinaryEnvelopeWithCompression(
              JSON.stringify({ seq, msg }),
              state.sessionKey!,
              false,
            )
          : JSON.stringify(msg);
      await handleMessage(
        ws,
        bindings,
        new Map(),
        state,
        send,
        encode(message, 0),
        deps,
        { isBinary: encrypted },
      );
      await vi.waitFor(() => expect(ws.send).toHaveBeenCalled());
      const wire = ws.send.mock.calls[0]![0] as string | Uint8Array;
      const event =
        typeof wire === "string"
          ? JSON.parse(wire)
          : JSON.parse(decryptBinaryEnvelope(wire, state.sessionKey!)!).msg;
      expect(event.eventType).toBe("snapshot");
      expect(decodeSnapshot(JSON.stringify(event.data)).sequence).toBe(0);
      await handleMessage(
        ws,
        bindings,
        new Map(),
        state,
        send,
        encode({ type: "unsubscribe", subscriptionId: "binding" }, 1),
        deps,
        { isBinary: encrypted },
      );
      expect(bindings.size).toBe(0);
      expect(h.close).toHaveBeenCalledTimes(1);
      expect(ws.close).not.toHaveBeenCalled();
    },
  );

  it.each(["", "19.2", "0", "101", "1e1", "+2", "01"])(
    "rejects count %j without acquisition",
    async (maxMessages) => {
      const h = harness();
      const response = await h.app.request(url(false, { maxMessages }));
      expect(response.status).toBe(400);
      expect(h.open).not.toHaveBeenCalled();
    },
  );
  it("rejects revision mismatch in HTTP, SSE and relay before acquisition", async () => {
    const h = harness();
    for (const subscribe of [false, true])
      expect(
        (await h.app.request(url(subscribe, { apiRevision: "future" }))).status,
      ).toBe(409);
    const send = vi.fn();
    subscribeConversationRelay(
      new Map(),
      { ...message, apiRevision: "future" },
      send,
      h.service,
    );
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ status: 409 }));
    expect(h.open).not.toHaveBeenCalled();
  });
  it("releases one-shot demand after delivering a valid snapshot", async () => {
    const h = harness();
    const response = await h.app.request(url());
    expect(response.status).toBe(200);
    expect(decodeSnapshot(await response.text()).view.kind).toBe(
      "conversation",
    );
    expect(h.close).toHaveBeenCalledTimes(1);
  });
  it("releases SSE demand on response cancellation", async () => {
    const h = harness();
    const response = await h.app.request(url(true));
    const reader = response.body!.getReader();
    const first = await reader.read();
    const frame = new TextDecoder().decode(first.value);
    expect(frame).toMatch(/^event: snapshot\ndata: /);
    expect(decodeSnapshot(frame.split("data: ")[1]!.trim()).sequence).toBe(0);
    await reader.cancel();
    await Promise.resolve();
    expect(h.close).toHaveBeenCalledTimes(1);
  });
  it("releases an aborted request before its asynchronous source resolves", async () => {
    const h = harness();
    const abort = new AbortController();
    abort.abort();
    const response = await h.app.request(
      new Request(`http://localhost${url()}`, { signal: abort.signal }),
    );
    expect(response.status).toBe(499);
    expect(h.open).not.toHaveBeenCalled();
  });
  it("relay replacement bindings reset sequence and explicitly close", async () => {
    const h = harness();
    const bindings = new Map<string, () => void>();
    const send = vi.fn();
    subscribeConversationRelay(bindings, message, send, h.service);
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: "snapshot" }),
      ),
    );
    bindings.get("binding")!();
    expect(bindings.size).toBe(0);
    expect(send).toHaveBeenLastCalledWith(
      expect.objectContaining({ eventType: "closed" }),
    );
    subscribeConversationRelay(
      bindings,
      { ...message, subscriptionId: "new" },
      send,
      h.service,
    );
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          subscriptionId: "new",
          data: expect.objectContaining({ sequence: 0 }),
        }),
      ),
    );
  });
});
