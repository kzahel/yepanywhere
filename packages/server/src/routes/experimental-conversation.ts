import { Hono } from "hono";
import { parseConversationBinding } from "@yep-anywhere/shared/experimental/conversation-protocol";
import type { ConversationSubscriptions } from "../experimental/conversation-subscriptions.js";

/** Existing app auth also protects these explicitly experimental routes. */
export function createExperimentalConversationRoutes(
  subscriptions: ConversationSubscriptions,
) {
  const routes = new Hono();
  routes.get("/:operation?", async (c) => {
    const operation = c.req.param("operation");
    if (operation !== undefined && operation !== "subscribe")
      return c.notFound();
    const params = c.req.query();
    const count = params.maxMessages;
    const parsed = parseConversationBinding({
      apiRevision: params.apiRevision,
      subscriptionId: params.subscriptionId,
      query: {
        sessionId: params.sessionId,
        maxMessages:
          count && /^(?:[1-9]\d?|100)$/.test(count) ? Number(count) : null,
        anchorMessageId: params.anchorMessageId ?? null,
      },
    });
    if ("status" in parsed)
      return c.json({ error: parsed.error }, parsed.status);
    c.header("Cache-Control", "no-store");
    const signal = c.req.raw.signal;
    if (operation !== "subscribe") {
      return new Promise<Response>((resolve) => {
        let release: (() => void) | undefined;
        let finished = false;
        const finish = (response: Response) => {
          if (finished) return;
          finished = true;
          signal.removeEventListener("abort", abort);
          resolve(response);
          queueMicrotask(() => release?.());
        };
        const abort = () => finish(new Response(null, { status: 499 }));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) {
          abort();
          return;
        }
        try {
          release = subscriptions.subscribe(
            parsed.query,
            parsed.subscriptionId,
            {
              send: (encoded) =>
                finish(
                  new Response(encoded, {
                    headers: {
                      "Content-Type": "application/json",
                      "Cache-Control": "no-store",
                    },
                  }),
                ),
              close: () => finish(new Response(null, { status: 503 })),
            },
          );
        } catch {
          finish(new Response(null, { status: 503 }));
        }
      });
    }
    let release: (() => void) | undefined;
    let pending: Uint8Array | undefined;
    let done = false;
    let closeStream: (() => void) | undefined;
    const close = () => {
      if (done) return;
      done = true;
      pending = undefined;
      signal.removeEventListener("abort", close);
      closeStream?.();
      queueMicrotask(() => release?.());
    };
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        closeStream = () => controller.close();
        signal.addEventListener("abort", close, { once: true });
        if (signal.aborted) {
          close();
          return;
        }
        try {
          release = subscriptions.subscribe(
            parsed.query,
            parsed.subscriptionId,
            {
              send(encoded) {
                if (done) return;
                const frame = new TextEncoder().encode(
                  `event: snapshot\ndata: ${encoded}\n\n`,
                );
                // At most one queued and one replacement frame per slow consumer.
                if ((controller.desiredSize ?? 0) > 0)
                  controller.enqueue(frame);
                else pending = frame;
              },
              close,
            },
          );
        } catch {
          close();
        }
      },
      pull(controller) {
        if (pending && !done) {
          controller.enqueue(pending);
          pending = undefined;
        }
      },
      cancel() {
        closeStream = undefined;
        close();
      },
    });
    return new Response(body, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
      },
    });
  });
  return routes;
}
