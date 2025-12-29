import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";
import type { Message, SessionStatus } from "../types";
import { useSSE } from "./useSSE";

export function useSession(projectId: string, sessionId: string) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [status, setStatus] = useState<SessionStatus>({ state: "idle" });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  // Load initial data
  useEffect(() => {
    setLoading(true);
    api
      .getSession(projectId, sessionId)
      .then((data) => {
        setMessages(data.messages);
        setStatus(data.status);
      })
      .catch(setError)
      .finally(() => setLoading(false));
  }, [projectId, sessionId]);

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

  const { connected } = useSSE(
    status.state !== "idle" ? `/api/sessions/${sessionId}/stream` : null,
    { onMessage: handleSSEMessage },
  );

  return { messages, status, loading, error, connected };
}
