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

  const connect = useCallback(() => {
    if (!url) return;

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

    es.onerror = (error) => {
      setConnected(false);
      optionsRef.current.onError?.(error);

      // Auto-reconnect after 2s
      es.close();
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
    };
  }, [connect]);

  return { connected };
}
