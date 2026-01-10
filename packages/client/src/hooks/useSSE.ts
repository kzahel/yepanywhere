import { useCallback, useEffect, useRef, useState } from "react";

interface UseSSEOptions {
  onMessage: (data: { eventType: string; [key: string]: unknown }) => void;
  onError?: (error: Event) => void;
  onOpen?: () => void;
}

export function useSSE(url: string | null, options: UseSSEOptions) {
  const [connected, setConnected] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);
  const lastEventIdRef = useRef<string | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const optionsRef = useRef(options);
  optionsRef.current = options;
  // Track connected URL to skip StrictMode double-mount (not reset in cleanup)
  const mountedUrlRef = useRef<string | null>(null);

  const connect = useCallback(() => {
    if (!url) {
      // Reset tracking when URL becomes null so we can reconnect later
      // (e.g., when status goes idle → owned again for the same session)
      mountedUrlRef.current = null;
      return;
    }

    // Don't create duplicate connections
    if (eventSourceRef.current) return;

    // Skip StrictMode double-mount (same URL, already connected once)
    if (mountedUrlRef.current === url) return;
    mountedUrlRef.current = url;

    const fullUrl = lastEventIdRef.current
      ? `${url}?lastEventId=${lastEventIdRef.current}`
      : url;

    const es = new EventSource(fullUrl);

    es.onopen = () => {
      setConnected(true);
      optionsRef.current.onOpen?.();
    };

    // Handle named events from SSE stream
    const handleEvent = (eventType: string) => (event: MessageEvent) => {
      if (event.lastEventId) {
        lastEventIdRef.current = event.lastEventId;
      }
      // Guard against undefined data (can happen on connection errors)
      if (event.data === undefined || event.data === null) {
        return;
      }
      try {
        const data = JSON.parse(event.data);
        // Use eventType (SSE event name), not data.type (SDK message type)
        optionsRef.current.onMessage({ ...data, eventType });
      } catch {
        // Ignore malformed JSON
      }
    };

    es.addEventListener("connected", handleEvent("connected"));
    es.addEventListener("message", handleEvent("message"));
    es.addEventListener("status", handleEvent("status"));
    es.addEventListener("mode-change", handleEvent("mode-change"));
    es.addEventListener("error", handleEvent("error"));
    es.addEventListener("complete", handleEvent("complete"));
    es.addEventListener("heartbeat", handleEvent("heartbeat"));
    es.addEventListener("markdown-augment", handleEvent("markdown-augment"));
    es.addEventListener("pending", handleEvent("pending"));
    es.addEventListener("edit-augment", handleEvent("edit-augment"));
    es.addEventListener("claude-login", handleEvent("claude-login"));
    es.addEventListener(
      "session-id-changed",
      handleEvent("session-id-changed"),
    );

    es.onerror = (error) => {
      setConnected(false);
      optionsRef.current.onError?.(error);

      // Auto-reconnect after 2s
      es.close();
      eventSourceRef.current = null;
      mountedUrlRef.current = null; // Reset so reconnect isn't blocked
      reconnectTimeoutRef.current = setTimeout(connect, 2000);
    };

    eventSourceRef.current = es;
  }, [url]);

  useEffect(() => {
    connect();

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
      // Reset mountedUrlRef so the next mount can connect
      // This is needed for StrictMode where cleanup runs between mounts
      mountedUrlRef.current = null;
    };
  }, [connect]);

  return { connected };
}
