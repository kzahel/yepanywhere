import type { UrlProjectId } from "@claude-anywhere/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionStatus, SessionSummary } from "../types";

export type FileChangeType = "create" | "modify" | "delete";
export type FileType =
  | "session"
  | "agent-session"
  | "settings"
  | "credentials"
  | "telemetry"
  | "other";

export interface FileChangeEvent {
  type: "file-change";
  path: string;
  relativePath: string;
  changeType: FileChangeType;
  timestamp: string;
  fileType: FileType;
}

export interface SessionStatusEvent {
  type: "session-status-changed";
  sessionId: string;
  /** Base64url-encoded project path (UrlProjectId format) */
  projectId: UrlProjectId;
  status: SessionStatus;
  timestamp: string;
}

export interface SessionCreatedEvent {
  type: "session-created";
  session: SessionSummary;
  timestamp: string;
}

export interface SessionSeenEvent {
  type: "session-seen";
  sessionId: string;
  timestamp: string;
  messageId?: string;
}

/** Process state type - what the agent is doing */
export type ProcessStateType = "running" | "waiting-input";

export interface ProcessStateEvent {
  type: "process-state-changed";
  sessionId: string;
  /** Base64url-encoded project path (UrlProjectId format) */
  projectId: UrlProjectId;
  processState: ProcessStateType;
  timestamp: string;
}

export interface SessionMetadataChangedEvent {
  type: "session-metadata-changed";
  sessionId: string;
  /** Updated title (if changed) */
  title?: string;
  /** Updated archived status (if changed) */
  archived?: boolean;
  /** Updated starred status (if changed) */
  starred?: boolean;
  timestamp: string;
}

interface UseFileActivityOptions {
  /** Maximum number of events to keep in buffer (default: 500) */
  maxEvents?: number;
  /** Whether to connect on mount (default: true) */
  autoConnect?: boolean;
  /** Callback when a file change occurs */
  onFileChange?: (event: FileChangeEvent) => void;
  /** Callback when a session status changes */
  onSessionStatusChange?: (event: SessionStatusEvent) => void;
  /** Callback when a new session is created */
  onSessionCreated?: (event: SessionCreatedEvent) => void;
  /** Callback when a session is marked as seen (from another tab/device) */
  onSessionSeen?: (event: SessionSeenEvent) => void;
  /** Callback when a process state changes (running/waiting-input) */
  onProcessStateChange?: (event: ProcessStateEvent) => void;
  /** Callback when session metadata changes (title, archived, starred) */
  onSessionMetadataChange?: (event: SessionMetadataChangedEvent) => void;
  /** Callback when SSE connection is re-established after being disconnected */
  onReconnect?: () => void;
}

const API_BASE = "/api";
const DEFAULT_MAX_EVENTS = 500;

export function useFileActivity(options: UseFileActivityOptions = {}) {
  const {
    maxEvents = DEFAULT_MAX_EVENTS,
    autoConnect = true,
    onFileChange,
    onSessionStatusChange,
    onSessionCreated,
    onSessionSeen,
    onProcessStateChange,
    onSessionMetadataChange,
    onReconnect,
  } = options;

  const [events, setEvents] = useState<FileChangeEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [paused, setPaused] = useState(false);

  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  // Track if we've connected before (to distinguish reconnect from initial connect)
  const hasConnectedRef = useRef(false);
  const onFileChangeRef = useRef(onFileChange);
  onFileChangeRef.current = onFileChange;
  const onSessionStatusChangeRef = useRef(onSessionStatusChange);
  onSessionStatusChangeRef.current = onSessionStatusChange;
  const onSessionCreatedRef = useRef(onSessionCreated);
  onSessionCreatedRef.current = onSessionCreated;
  const onSessionSeenRef = useRef(onSessionSeen);
  onSessionSeenRef.current = onSessionSeen;
  const onProcessStateChangeRef = useRef(onProcessStateChange);
  onProcessStateChangeRef.current = onProcessStateChange;
  const onSessionMetadataChangeRef = useRef(onSessionMetadataChange);
  onSessionMetadataChangeRef.current = onSessionMetadataChange;
  const onReconnectRef = useRef(onReconnect);
  onReconnectRef.current = onReconnect;

  const connect = useCallback(() => {
    if (eventSourceRef.current) return;

    const es = new EventSource(`${API_BASE}/activity/stream`);

    es.onopen = () => {
      const isReconnect = hasConnectedRef.current;
      hasConnectedRef.current = true;
      setConnected(true);
      if (isReconnect) {
        onReconnectRef.current?.();
      }
    };

    const handleFileChange = (event: MessageEvent) => {
      if (event.data === undefined || event.data === null) return;

      try {
        const data = JSON.parse(event.data) as FileChangeEvent;

        // Call the callback
        onFileChangeRef.current?.(data);

        // Add to events buffer (unless paused)
        setEvents((prev) => {
          const next = [data, ...prev];
          return next.slice(0, maxEvents);
        });
      } catch {
        // Ignore malformed JSON
      }
    };

    const handleSessionStatusChange = (event: MessageEvent) => {
      if (event.data === undefined || event.data === null) return;

      try {
        const data = JSON.parse(event.data) as SessionStatusEvent;
        onSessionStatusChangeRef.current?.(data);
      } catch {
        // Ignore malformed JSON
      }
    };

    const handleSessionCreated = (event: MessageEvent) => {
      if (event.data === undefined || event.data === null) return;

      try {
        const data = JSON.parse(event.data) as SessionCreatedEvent;
        onSessionCreatedRef.current?.(data);
      } catch {
        // Ignore malformed JSON
      }
    };

    const handleSessionSeen = (event: MessageEvent) => {
      if (event.data === undefined || event.data === null) return;

      try {
        const data = JSON.parse(event.data) as SessionSeenEvent;
        onSessionSeenRef.current?.(data);
      } catch {
        // Ignore malformed JSON
      }
    };

    const handleProcessStateChange = (event: MessageEvent) => {
      if (event.data === undefined || event.data === null) return;

      try {
        const data = JSON.parse(event.data) as ProcessStateEvent;
        onProcessStateChangeRef.current?.(data);
      } catch {
        // Ignore malformed JSON
      }
    };

    const handleSessionMetadataChange = (event: MessageEvent) => {
      if (event.data === undefined || event.data === null) return;

      try {
        const data = JSON.parse(event.data) as SessionMetadataChangedEvent;
        onSessionMetadataChangeRef.current?.(data);
      } catch {
        // Ignore malformed JSON
      }
    };

    es.addEventListener("connected", () => {
      // Connection acknowledged
    });

    es.addEventListener("file-change", handleFileChange);
    es.addEventListener("session-status-changed", handleSessionStatusChange);
    es.addEventListener("session-created", handleSessionCreated);
    es.addEventListener("session-seen", handleSessionSeen);
    es.addEventListener("process-state-changed", handleProcessStateChange);
    es.addEventListener(
      "session-metadata-changed",
      handleSessionMetadataChange,
    );
    es.addEventListener("heartbeat", () => {
      // Keep-alive, no action needed
    });

    es.onerror = () => {
      setConnected(false);
      es.close();
      eventSourceRef.current = null;

      // Auto-reconnect after 2s
      reconnectTimeoutRef.current = setTimeout(connect, 2000);
    };

    eventSourceRef.current = es;
  }, [maxEvents]);

  const disconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    setConnected(false);
  }, []);

  const clearEvents = useCallback(() => {
    setEvents([]);
  }, []);

  const togglePause = useCallback(() => {
    setPaused((p) => !p);
  }, []);

  // Filter helpers
  const filterByPath = useCallback(
    (pattern: string) => {
      const regex = new RegExp(pattern, "i");
      return events.filter((e) => regex.test(e.relativePath));
    },
    [events],
  );

  const filterByType = useCallback(
    (fileType: FileType) => {
      return events.filter((e) => e.fileType === fileType);
    },
    [events],
  );

  // Auto-connect on mount
  useEffect(() => {
    if (autoConnect) {
      connect();
    }

    return () => {
      disconnect();
    };
  }, [autoConnect, connect, disconnect]);

  return {
    events,
    connected,
    paused,
    connect,
    disconnect,
    clearEvents,
    togglePause,
    filterByPath,
    filterByType,
  };
}
