import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { mergeJSONLMessages, mergeSSEMessage } from "../lib/mergeMessages";
import type {
  InputRequest,
  Message,
  PermissionMode,
  Session,
  SessionStatus,
} from "../types";
import {
  type FileChangeEvent,
  type SessionStatusEvent,
  useFileActivity,
} from "./useFileActivity";
import { useSSE } from "./useSSE";

export type ProcessState = "idle" | "running" | "waiting-input";

const THROTTLE_MS = 500;

export function useSession(projectId: string, sessionId: string) {
  const [session, setSession] = useState<Session | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [status, setStatus] = useState<SessionStatus>({ state: "idle" });
  const [processState, setProcessState] = useState<ProcessState>("idle");
  const [pendingInputRequest, setPendingInputRequest] =
    useState<InputRequest | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  // Permission mode state: localMode is UI-selected, serverMode is confirmed by server
  const [localMode, setLocalMode] = useState<PermissionMode>("default");
  const [serverMode, setServerMode] = useState<PermissionMode>("default");
  const [modeVersion, setModeVersion] = useState<number>(0);
  const lastKnownModeVersionRef = useRef<number>(0);

  // Mode is pending when local differs from server-confirmed
  const isModePending = localMode !== serverMode;

  // Update local mode (UI selection) and sync to server if process is active
  const setPermissionMode = useCallback(
    async (mode: PermissionMode) => {
      setLocalMode(mode);

      // If there's an active process, immediately sync to server
      if (status.state === "owned" || status.state === "external") {
        try {
          const result = await api.setPermissionMode(sessionId, mode);
          // Update server-confirmed mode
          if (result.modeVersion >= lastKnownModeVersionRef.current) {
            lastKnownModeVersionRef.current = result.modeVersion;
            setServerMode(result.permissionMode);
            setModeVersion(result.modeVersion);
          }
        } catch (err) {
          // If API fails (e.g., no active process), mode will be sent on next message
          console.warn("Failed to sync permission mode:", err);
        }
      }
    },
    [sessionId, status.state],
  );

  // Apply server mode update only if version is >= our last known version
  // This syncs both local and server mode to the confirmed value
  const applyServerModeUpdate = useCallback(
    (mode: PermissionMode, version: number) => {
      if (version >= lastKnownModeVersionRef.current) {
        lastKnownModeVersionRef.current = version;
        setServerMode(mode);
        setLocalMode(mode); // Sync local to server-confirmed mode
        setModeVersion(version);
      }
    },
    [],
  );

  // Throttle state for incremental fetching
  const throttleRef = useRef<{
    timer: ReturnType<typeof setTimeout> | null;
    pending: boolean;
  }>({ timer: null, pending: false });

  // Track last message ID for incremental fetching
  const lastMessageIdRef = useRef<string | undefined>(undefined);

  // Track temp ID → real ID mappings for parent chain resolution
  const tempIdMappingsRef = useRef<Map<string, string>>(new Map());

  // Add user message optimistically with a temp ID
  // Uses SDK message structure: { type, message: { role, content } }
  // Sets parentUuid for DAG-aware deduplication of identical messages
  const addUserMessage = useCallback((text: string) => {
    const tempId = `temp-${Date.now()}`;
    setMessages((prev) => {
      const lastMsg = prev[prev.length - 1];
      const msg: Message = {
        id: tempId,
        type: "user",
        message: { role: "user", content: text },
        parentUuid: lastMsg?.id ?? null,
        timestamp: new Date().toISOString(),
      };
      return [...prev, msg];
    });
  }, []);

  // Remove an optimistic message by matching content (used when send fails)
  const removeOptimisticMessage = useCallback((text: string) => {
    setMessages((prev) => {
      // Find the last temp message with matching content (iterate backwards)
      for (let i = prev.length - 1; i >= 0; i--) {
        const m = prev[i];
        if (!m) continue;
        if (
          m.id.startsWith("temp-") &&
          (m.message?.content === text || m.content === text)
        ) {
          return [...prev.slice(0, i), ...prev.slice(i + 1)];
        }
      }
      return prev;
    });
  }, []);

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
        // Tag messages from JSONL as authoritative
        const taggedMessages = data.messages.map((m) => ({
          ...m,
          _source: "jsonl" as const,
        }));
        setMessages(taggedMessages);
        setStatus(data.status);
        // Sync permission mode from server if owned
        if (
          data.status.state === "owned" &&
          data.status.permissionMode &&
          data.status.modeVersion !== undefined
        ) {
          applyServerModeUpdate(
            data.status.permissionMode,
            data.status.modeVersion,
          );
        }
      })
      .catch(setError)
      .finally(() => setLoading(false));
  }, [projectId, sessionId, applyServerModeUpdate]);

  // Fetch only new messages (incremental update)
  const fetchNewMessages = useCallback(async () => {
    try {
      const data = await api.getSession(
        projectId,
        sessionId,
        lastMessageIdRef.current,
      );
      if (data.messages.length > 0) {
        setMessages((prev) => {
          const result = mergeJSONLMessages(
            prev,
            data.messages,
            tempIdMappingsRef.current,
          );
          // Update mappings with any new temp→real ID mappings
          for (const [tempId, realId] of result.newMappings) {
            tempIdMappingsRef.current.set(tempId, realId);
          }
          return result.messages;
        });
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

      // Check if file matches current session (exact match to avoid false positives)
      // File format is: projects/<projectId>/<sessionId>.jsonl
      const filename = event.relativePath.split("/").pop();
      const fileSessionId = filename?.endsWith(".jsonl")
        ? filename.slice(0, -6)
        : null;
      if (fileSessionId !== sessionId) {
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
        // Pass through all fields without stripping
        const sdkMessage = data as Record<string, unknown> & {
          eventType: string;
        };

        // Extract id - prefer uuid, fall back to id field, then generate
        const rawUuid = sdkMessage.uuid;
        const rawId = sdkMessage.id;
        const id: string =
          (typeof rawUuid === "string" ? rawUuid : null) ??
          (typeof rawId === "string" ? rawId : null) ??
          `msg-${Date.now()}`;

        // Extract type and role
        const msgType =
          typeof sdkMessage.type === "string" ? sdkMessage.type : undefined;
        const msgRole = sdkMessage.role as Message["role"] | undefined;

        // Build message object, preserving all SDK fields
        const incoming: Message = {
          ...(sdkMessage as Partial<Message>),
          id,
          type: msgType,
          // Ensure role is set for user/assistant types
          role:
            msgRole ??
            (msgType === "user" || msgType === "assistant"
              ? msgType
              : undefined),
        };

        // Remove eventType from the message (it's SSE envelope, not message data)
        (incoming as { eventType?: string }).eventType = undefined;

        setMessages((prev) => {
          const result = mergeSSEMessage(
            prev,
            incoming,
            tempIdMappingsRef.current,
          );
          // Update mappings if a temp was replaced
          if (result.replacedTempId) {
            tempIdMappingsRef.current.set(result.replacedTempId, incoming.id);
          }
          return result.messages;
        });
      } else if (data.eventType === "status") {
        const statusData = data as {
          eventType: string;
          state: string;
          request?: InputRequest;
        };
        // Track process state (running, idle, waiting-input)
        if (
          statusData.state === "idle" ||
          statusData.state === "running" ||
          statusData.state === "waiting-input"
        ) {
          setProcessState(statusData.state as ProcessState);
        }
        // Capture pending input request when waiting for user input
        if (statusData.state === "waiting-input" && statusData.request) {
          setPendingInputRequest(statusData.request);
        } else {
          // Clear pending request when state changes away from waiting-input
          setPendingInputRequest(null);
        }
        // When subprocess goes idle, treat the session as idle from a UX perspective
        // (hides status indicator, changes placeholder to "Send a message to resume...")
        // even though the subprocess may still be alive in the warm pool
        if (statusData.state === "idle") {
          setStatus({ state: "idle" });
        }
      } else if (data.eventType === "complete") {
        setProcessState("idle");
        setStatus({ state: "idle" });
        setPendingInputRequest(null);
      } else if (data.eventType === "connected") {
        // Sync state and permission mode from connected event
        const connectedData = data as {
          eventType: string;
          state?: string;
          permissionMode?: PermissionMode;
          modeVersion?: number;
          request?: InputRequest;
        };
        // Sync process state so watching tabs see "processing" indicator
        if (
          connectedData.state === "idle" ||
          connectedData.state === "running" ||
          connectedData.state === "waiting-input"
        ) {
          setProcessState(connectedData.state as ProcessState);
        }
        // Restore pending input request if state is waiting-input, clear if not
        // (handles reconnection after another tab already approved/denied)
        if (connectedData.state === "waiting-input" && connectedData.request) {
          setPendingInputRequest(connectedData.request);
        } else {
          setPendingInputRequest(null);
        }
        if (
          connectedData.permissionMode &&
          connectedData.modeVersion !== undefined
        ) {
          applyServerModeUpdate(
            connectedData.permissionMode,
            connectedData.modeVersion,
          );
        }
      } else if (data.eventType === "mode-change") {
        // Handle mode change from another tab/client
        const modeData = data as {
          eventType: string;
          permissionMode?: PermissionMode;
          modeVersion?: number;
        };
        if (modeData.permissionMode && modeData.modeVersion !== undefined) {
          applyServerModeUpdate(modeData.permissionMode, modeData.modeVersion);
        }
      }
    },
    [applyServerModeUpdate],
  );

  // Handle SSE errors by checking if process is still alive
  // If process died (idle timeout), transition to idle state
  const handleSSEError = useCallback(async () => {
    try {
      const data = await api.getSession(projectId, sessionId);
      if (data.status.state !== "owned") {
        setStatus({ state: "idle" });
        setProcessState("idle");
      }
    } catch {
      // If session fetch fails, assume process is dead
      setStatus({ state: "idle" });
      setProcessState("idle");
    }
  }, [projectId, sessionId]);

  // Only connect to session stream when we own the session
  // External sessions are tracked via the activity stream instead
  const { connected } = useSSE(
    status.state === "owned" ? `/api/sessions/${sessionId}/stream` : null,
    { onMessage: handleSSEMessage, onError: handleSSEError },
  );

  return {
    session,
    messages,
    status,
    processState,
    pendingInputRequest,
    permissionMode: localMode, // UI-selected mode (sent with next message)
    isModePending, // True when local mode differs from server-confirmed
    modeVersion,
    loading,
    error,
    connected,
    setStatus,
    setProcessState,
    setPermissionMode,
    addUserMessage,
    removeOptimisticMessage,
  };
}
