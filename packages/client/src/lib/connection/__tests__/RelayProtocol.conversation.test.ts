import type { RemoteClientMessage } from "@yep-anywhere/shared";
import { expect, it, vi } from "vitest";
import { RelayProtocol } from "../RelayProtocol";

it("uses the consumer binding ID on the experimental wire and unsubscribes it", async () => {
  const sent: RemoteClientMessage[] = [];
  const protocol = new RelayProtocol({
    sendMessage: (message) => sent.push(message),
    sendUploadChunk: vi.fn(),
    ensureConnected: async () => {},
    isConnected: () => true,
  });
  const onEvent = vi.fn();
  const query = {
    sessionId: "session",
    maxMessages: 20,
    anchorMessageId: null,
  };
  const subscription = protocol.subscribeConversation(
    "preview-binding",
    query,
    { onEvent },
  );
  await vi.waitFor(() =>
    expect(sent).toEqual([
      {
        type: "subscribe",
        subscriptionId: "preview-binding",
        channel: "/api/experimental/conversation/subscribe",
        apiRevision: "simple-client-spike-1",
        query,
      },
    ]),
  );
  protocol.routeMessage({
    type: "event",
    subscriptionId: "preview-binding",
    eventType: "snapshot",
    data: { sequence: 0 },
  });
  expect(onEvent).toHaveBeenCalledTimes(1);
  subscription.close();
  expect(sent.at(-1)).toEqual({
    type: "unsubscribe",
    subscriptionId: "preview-binding",
  });
  protocol.routeMessage({
    type: "event",
    subscriptionId: "preview-binding",
    eventType: "snapshot",
    data: { sequence: 1 },
  });
  expect(onEvent).toHaveBeenCalledTimes(1);
});
