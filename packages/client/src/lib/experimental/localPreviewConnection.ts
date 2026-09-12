import { conversationReadPath } from "@yep-anywhere/shared/experimental/conversation-client";
import { fetchPlainJSON } from "../../api/plainFetch";
import { MultiHostSignInRequiredError } from "../savedHostConnection";
import type { PreviewConnector } from "./previewController";

/** Same-origin cookie auth; the preview owns every request and SSE lifetime. */
export const connectLocalPreview: PreviewConnector = async (host, signal) => {
  if (host.mode !== "local") throw new Error("Expected a local preview source");
  signal.throwIfAborted();
  const owner = new AbortController();
  const streams = new Set<EventSource>();
  const close = () => {
    owner.abort();
    for (const stream of streams) stream.close();
    streams.clear();
    signal.removeEventListener("abort", close);
  };
  signal.addEventListener("abort", close, { once: true });
  return {
    close,
    async fetch<T>(path: string, init?: RequestInit): Promise<T> {
      try {
        return await fetchPlainJSON<T>(
          path,
          {
            ...init,
            signal: init?.signal
              ? AbortSignal.any([owner.signal, init.signal])
              : owner.signal,
          },
          { onLoginRequired: () => {} },
        );
      } catch (error) {
        if ((error as { status?: number })?.status === 401)
          throw new MultiHostSignInRequiredError("Authentication required");
        throw error;
      }
    },
    subscribeConversation(id, query, handlers) {
      owner.signal.throwIfAborted();
      const path = conversationReadPath(query, id).replace(
        "/conversation?",
        "/conversation/subscribe?",
      );
      const stream = new EventSource(path);
      streams.add(stream);
      let closed = false;
      const stop = () => {
        closed = true;
        stream.close();
        streams.delete(stream);
      };
      stream.onopen = () => {
        if (!closed && !owner.signal.aborted) handlers.onOpen?.();
      };
      stream.addEventListener("snapshot", (event) => {
        if (closed || owner.signal.aborted) return;
        try {
          handlers.onEvent(
            "snapshot",
            undefined,
            JSON.parse((event as MessageEvent).data),
          );
        } catch (error) {
          stop();
          handlers.onError?.(
            error instanceof Error ? error : new Error("Invalid snapshot"),
          );
        }
      });
      stream.onerror = () => {
        if (closed || owner.signal.aborted) return;
        // Disable EventSource's implicit retry: a fresh binding needs sequence 0.
        stop();
        handlers.onError?.(new Error("Conversation stream disconnected"));
      };
      return { close: stop };
    },
  };
};
