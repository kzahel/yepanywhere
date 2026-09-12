import type {
  RelaySubscribe,
  RelayEvent,
  RelayResponse,
} from "@yep-anywhere/shared";
import { parseConversationBinding } from "@yep-anywhere/shared/experimental/conversation-protocol";
import type { ConversationSubscriptions } from "./conversation-subscriptions.js";

export function subscribeConversationRelay(
  bindings: Map<string, () => void>,
  message: RelaySubscribe,
  send: (message: RelayEvent | RelayResponse) => void,
  service?: ConversationSubscriptions,
): void {
  const parsed = parseConversationBinding(message);
  if ("status" in parsed) {
    send({
      type: "response",
      id: message.subscriptionId,
      status: parsed.status,
      body: { error: parsed.error },
    });
    return;
  }
  if (!service) {
    send({
      type: "response",
      id: message.subscriptionId,
      status: 404,
      body: { error: "Experimental conversation unavailable" },
    });
    return;
  }
  const id = parsed.subscriptionId;
  let closed = false;
  let release: (() => void) | undefined;
  const close = () => {
    if (closed) return;
    closed = true;
    bindings.delete(id);
    send({ type: "event", subscriptionId: id, eventType: "closed", data: {} });
  };
  bindings.set(id, () => {
    try {
      close();
    } finally {
      release?.();
    }
  });
  try {
    release = service.subscribe(parsed.query, id, {
      send: (encoded) =>
        send({
          type: "event",
          subscriptionId: id,
          eventType: "snapshot",
          data: JSON.parse(encoded),
        }),
      close,
    });
    if (closed) release();
  } catch {
    bindings.delete(id);
    closed = true;
    send({
      type: "response",
      id,
      status: 503,
      body: { error: "Conversation capacity unavailable" },
    });
  }
}
