import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import type { Message, Session, SessionStatus } from "../types";
import {
  type FileChangeEvent,
  type SessionStatusEvent,
  useFileActivity,
} from "./useFileActivity";
import { useSSE } from "./useSSE";

const THROTTLE_MS = 500;

export function useSession(projectId: string, sessionId: string) {
  const [session, setSession] = useState<Session | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [status, setStatus] = useState<SessionStatus>({ state: "idle" });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  // Throttle state for incremental fetching
  const throttleRef = useRef<{
    timer: ReturnType<typeof setTimeout> | null;
    pending: boolean;
  }>({ timer: null, pending: false });

  // Track last message ID for incremental fetching
  const lastMessageIdRef = useRef<string | undefined>(undefined);

  // Update lastMessageIdRef when messages change
  useEffect(() => {
    const lastMessage = messages[messages.length - 1];
    if (lastMessage) {
      lastMessageIdRef.current = lastMessage.id;
    }
  }, [messages]);

  // Load initial data
  useEffect(() => {
    setLoading(true);
    api
      .getSession(projectId, sessionId)
      .then((data) => {
        setSession(data.session);
        setMessages(data.messages);
        setStatus(data.status);
      })
      .catch(setError)
      .finally(() => setLoading(false));
  }, [projectId, sessionId]);

  // Fetch only new messages (incremental update)
  const fetchNewMessages = useCallback(async () => {
    try {
      const data = await api.getSession(
        projectId,
        sessionId,
        lastMessageIdRef.current,
      );
      if (data.messages.length > 0) {
        setMessages((prev) => [...prev, ...data.messages]);
      }
      setStatus(data.status);
    } catch {
      // Silent fail for incremental updates
    }
  }, [projectId, sessionId]);

  // Leading + trailing edge throttle:
  // - Leading: fires immediately on first call
  // - Trailing: fires again after timeout if events came during window
  // This ensures no updates are lost
  const throttledFetch = useCallback(() => {
    const ref = throttleRef.current;

    if (!ref.timer) {
      // No active throttle - fire immediately (LEADING EDGE)
      fetchNewMessages();
      ref.timer = setTimeout(() => {
        ref.timer = null;
        if (ref.pending) {
          ref.pending = false;
          throttledFetch(); // Fire again (TRAILING EDGE)
        }
      }, THROTTLE_MS);
    } else {
      // Throttled - mark as pending for trailing edge
      ref.pending = true;
    }
  }, [fetchNewMessages]);

  // Handle file changes for external sessions
  const handleFileChange = useCallback(
    (event: FileChangeEvent) => {
      // Only care about session files
      if (event.fileType !== "session" && event.fileType !== "agent-session") {
        return;
      }

      // Check if file matches current session
      if (!event.relativePath.includes(sessionId)) {
        return;
      }

      // Skip if we own the session (we get updates via SSE stream)
      if (status.state === "owned") {
        return;
      }

      // Throttled refetch for external sessions
      throttledFetch();
    },
    [sessionId, status.state, throttledFetch],
  );

  // Listen for session status changes via SSE
  const handleSessionStatusChange = useCallback(
    (event: SessionStatusEvent) => {
      if (event.sessionId === sessionId) {
        setStatus(event.status);
      }
    },
    [sessionId],
  );

  useFileActivity({
    onSessionStatusChange: handleSessionStatusChange,
    onFileChange: handleFileChange,
  });

  // Cleanup throttle timer
  useEffect(() => {
    return () => {
      if (throttleRef.current.timer) {
        clearTimeout(throttleRef.current.timer);
      }
    };
  }, []);

  // Subscribe to live updates
  const handleSSEMessage = useCallback(
    (data: { eventType: string; [key: string]: unknown }) => {
      if (data.eventType === "message") {
        // The message event contains the SDK message directly
        // We need to convert it to our Message format
        const sdkMessage = data as {
          eventType: string;
          type: string;
          message?: { content: string; role?: string };
        };
        if (sdkMessage.message) {
          const msg: Message = {
            id: `msg-${Date.now()}`,
            role: (sdkMessage.message.role as Message["role"]) || "assistant",
            content: sdkMessage.message.content,
            timestamp: new Date().toISOString(),
          };
          setMessages((prev) => [...prev, msg]);
        }
      } else if (data.eventType === "status") {
        const statusData = data as { eventType: string; state: string };
        if (statusData.state === "idle") {
          setStatus({ state: "idle" });
        }
      } else if (data.eventType === "complete") {
        setStatus({ state: "idle" });
      }
    },
    [],
  );

  // Only connect to session stream when we own the session
  // External sessions are tracked via the activity stream instead
  const { connected } = useSSE(
    status.state === "owned" ? `/api/sessions/${sessionId}/stream` : null,
    { onMessage: handleSSEMessage },
  );

  return { session, messages, status, loading, error, connected, setStatus };
}
