import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { mergeJSONLMessages, mergeSSEMessage } from "../lib/mergeMessages";
import type {
  ContentBlock,
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
import { getStreamingEnabled } from "./useStreamingEnabled";

export type ProcessState = "idle" | "running" | "waiting-input";

/** Content from a subagent (Task tool) */
export interface AgentContent {
  messages: Message[];
  status: "pending" | "running" | "completed" | "failed";
}

/** Map of agentId → agent content */
export type AgentContentMap = Record<string, AgentContent>;

const THROTTLE_MS = 500;

export function useSession(
  projectId: string,
  sessionId: string,
  initialStatus?: { state: "owned"; processId: string },
) {
  const [session, setSession] = useState<Session | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  // Use initial status if provided (from navigation state) to connect SSE immediately
  const [status, setStatus] = useState<SessionStatus>(
    initialStatus ?? { state: "idle" },
  );
  // If we have initial status, assume process is running (just started)
  const [processState, setProcessState] = useState<ProcessState>(
    initialStatus ? "running" : "idle",
  );
  const [pendingInputRequest, setPendingInputRequest] =
    useState<InputRequest | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  // Subagent content: messages from Task tool agents, keyed by agentId (session_id)
  // These are kept separate from main messages to maintain clean DAG structure
  const [agentContent, setAgentContent] = useState<AgentContentMap>({});

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

  // Streaming state: accumulates content from stream_event messages
  // Key is the message uuid, value is the accumulated content blocks
  const streamingContentRef = useRef<
    Map<string, { blocks: ContentBlock[]; isStreaming: boolean }>
  >(new Map());

  // Track current streaming message ID (from message_start event)
  // Each stream_event has its own uuid, but they all belong to the same message
  const currentStreamingIdRef = useRef<string | null>(null);

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
    // Reset agentContent when switching sessions
    setAgentContent({});
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
      // Update session metadata (including title) which may have changed
      setSession((prev) =>
        prev ? { ...prev, ...data.session, messages: prev.messages } : prev,
      );
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

  // Fetch session metadata only (title, etc.) - used when we need metadata
  // updates but already have messages from SSE
  const fetchSessionMetadata = useCallback(async () => {
    try {
      const data = await api.getSession(projectId, sessionId);
      setSession((prev) =>
        prev ? { ...prev, ...data.session, messages: prev.messages } : prev,
      );
    } catch {
      // Silent fail for metadata updates
    }
  }, [projectId, sessionId]);

  // Handle file changes - triggers metadata refetch for all sessions
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

      // For owned sessions: SSE provides real-time messages, but we still need
      // to fetch session metadata (like title) which isn't streamed
      if (status.state === "owned") {
        fetchSessionMetadata();
        return;
      }

      // For external/idle sessions: fetch both messages and metadata
      throttledFetch();
    },
    [sessionId, status.state, throttledFetch, fetchSessionMetadata],
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

  // Update messages with streaming content
  // Creates or updates a streaming placeholder message with accumulated content
  const updateStreamingMessage = useCallback((messageId: string) => {
    const streaming = streamingContentRef.current.get(messageId);
    if (!streaming) return;

    setMessages((prev) => {
      // Find existing streaming message or create new one
      const existingIdx = prev.findIndex((m) => m.id === messageId);

      const streamingMessage: Message = {
        id: messageId,
        type: "assistant",
        role: "assistant",
        message: {
          role: "assistant",
          content: streaming.blocks,
        },
        _isStreaming: true, // Marker for rendering
        _source: "sdk",
      };

      if (existingIdx >= 0) {
        // Update existing
        const updated = [...prev];
        updated[existingIdx] = streamingMessage;
        return updated;
      }
      // Add new
      return [...prev, streamingMessage];
    });
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

        // Handle stream_event messages (partial content from streaming API)
        if (msgType === "stream_event" && getStreamingEnabled()) {
          const event = sdkMessage.event as Record<string, unknown> | undefined;
          if (!event) return;

          const eventType = event.type as string | undefined;

          // Handle message_start to capture the message ID for this streaming response
          // Each stream_event has its own uuid, but they all belong to the same API message
          if (eventType === "message_start") {
            const message = event.message as
              | Record<string, unknown>
              | undefined;
            if (message?.id) {
              currentStreamingIdRef.current = message.id as string;
            }
            return;
          }

          // Use the captured message ID, or fall back to generating one
          const streamingId =
            currentStreamingIdRef.current ?? `stream-${Date.now()}`;

          // Handle different stream event types
          if (eventType === "content_block_start") {
            // New content block starting
            const index = event.index as number;
            const contentBlock = event.content_block as Record<
              string,
              unknown
            > | null;
            if (contentBlock) {
              const streaming = streamingContentRef.current.get(
                streamingId,
              ) ?? {
                blocks: [],
                isStreaming: true,
              };
              // Ensure array is long enough
              while (streaming.blocks.length <= index) {
                streaming.blocks.push({ type: "text", text: "" });
              }
              // Initialize the block with its type
              streaming.blocks[index] = {
                type: (contentBlock.type as string) ?? "text",
                text: (contentBlock.text as string) ?? "",
                thinking: (contentBlock.thinking as string) ?? undefined,
              };
              streamingContentRef.current.set(streamingId, streaming);
              updateStreamingMessage(streamingId);
            }
          } else if (eventType === "content_block_delta") {
            // Content delta - append to existing block
            const index = event.index as number;
            const delta = event.delta as Record<string, unknown> | null;
            if (delta) {
              const streaming = streamingContentRef.current.get(streamingId);
              if (streaming?.blocks[index]) {
                const block = streaming.blocks[index];
                const deltaType = delta.type as string;
                if (deltaType === "text_delta" && delta.text) {
                  block.text = (block.text ?? "") + (delta.text as string);
                } else if (deltaType === "thinking_delta" && delta.thinking) {
                  block.thinking =
                    (block.thinking ?? "") + (delta.thinking as string);
                }
                updateStreamingMessage(streamingId);
              }
            }
          } else if (eventType === "content_block_stop") {
            // Block complete - nothing special needed, final message will replace
          } else if (eventType === "message_stop") {
            // Message complete - clean up streaming ref state
            // DON'T clear currentStreamingIdRef here - we need it to remove the
            // streaming placeholder when the final assistant message arrives
            streamingContentRef.current.delete(streamingId);
          }
          return; // Don't process stream_event as a regular message
        }

        // For assistant messages, clear streaming state and remove ALL streaming placeholders
        // Due to race conditions (message_start arriving after content_block_start),
        // placeholders might have different IDs than currentStreamingIdRef
        if (msgType === "assistant") {
          // Clear all streaming content refs
          streamingContentRef.current.clear();
          currentStreamingIdRef.current = null;
          // Remove ALL streaming placeholder messages (those with _isStreaming flag)
          setMessages((prev) => prev.filter((m) => !m._isStreaming));
        }

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

        // Route subagent messages to agentContent instead of main messages
        // This keeps the parent session's DAG clean and allows proper nesting in UI
        if (
          sdkMessage.isSubagent &&
          typeof sdkMessage.session_id === "string"
        ) {
          const agentId = sdkMessage.session_id;
          setAgentContent((prev) => {
            const existing = prev[agentId] ?? {
              messages: [],
              status: "running" as const,
            };
            // Dedupe by message ID
            if (existing.messages.some((m) => m.id === incoming.id)) {
              return prev;
            }
            return {
              ...prev,
              [agentId]: {
                ...existing,
                messages: [...existing.messages, incoming],
                status: "running", // Mark as running while receiving messages
              },
            };
          });
          return; // Don't add to main messages
        }

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
    [applyServerModeUpdate, updateStreamingMessage],
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
    agentContent, // Subagent messages keyed by agentId (for Task tool)
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
