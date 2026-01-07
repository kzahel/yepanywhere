import type { MarkdownAugment } from "@yep-anywhere/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import {
  getMessageId,
  mergeJSONLMessages,
  mergeSSEMessage,
} from "../lib/mergeMessages";
import { findPendingTasks } from "../lib/pendingTasks";
import { extractSessionIdFromFileEvent } from "../lib/sessionFile";
import { getProvider } from "../providers/registry";
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
import {
  type StreamingMarkdownCallbacks,
  useStreamingContent,
} from "./useStreamingContent";

export type ProcessState = "idle" | "running" | "waiting-input" | "hold";

/** Content from a subagent (Task tool) */
export interface AgentContent {
  messages: Message[];
  status: "pending" | "running" | "completed" | "failed";
  /** Real-time context usage from message_start events */
  contextUsage?: {
    inputTokens: number;
    percentage: number;
  };
}

/** Map of agentId → agent content */
export type AgentContentMap = Record<string, AgentContent>;

const THROTTLE_MS = 500;

// Re-export StreamingMarkdownCallbacks for consumers
export type { StreamingMarkdownCallbacks } from "./useStreamingContent";

/** Pending message waiting for server confirmation */
export interface PendingMessage {
  tempId: string;
  content: string;
  timestamp: string;
}

export function useSession(
  projectId: string,
  sessionId: string,
  initialStatus?: { state: "owned"; processId: string },
  streamingMarkdownCallbacks?: StreamingMarkdownCallbacks,
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

  // Actual session ID from server (may differ from URL sessionId during temp→real ID transition)
  // This happens when createSession returns before the SDK sends the real session ID
  const [actualSessionId, setActualSessionId] = useState<string>(sessionId);

  // Subagent content: messages from Task tool agents, keyed by agentId (session_id)
  // These are kept separate from main messages to maintain clean DAG structure
  const [agentContent, setAgentContent] = useState<AgentContentMap>({});

  // Mapping from Task tool_use_id → subagent session_id (agentId)
  // Built during streaming when we receive system/init messages with parent_tool_use_id
  // This allows TaskRenderer to access agentContent before the tool_result arrives
  const [toolUseToAgent, setToolUseToAgent] = useState<Map<string, string>>(
    () => new Map(),
  );

  // Track last SSE activity timestamp for engagement tracking
  // This includes both main session and subagent messages, so we can properly
  // mark sessions as "seen" even when subagent content arrives (which doesn't
  // update the parent session file's mtime until completion)
  const [lastSSEActivityAt, setLastSSEActivityAt] = useState<string | null>(
    null,
  );

  // Pending messages queue - messages waiting for server confirmation
  // These are displayed separately from the main message list
  const [pendingMessages, setPendingMessages] = useState<PendingMessage[]>([]);

  // Markdown augments loaded from REST response (keyed by message ID)
  const [markdownAugments, setMarkdownAugments] = useState<
    Record<string, MarkdownAugment>
  >({});

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

  // Set hold state (soft pause) for the session
  const setHold = useCallback(
    async (hold: boolean) => {
      // Only works if there's an active process
      if (status.state !== "owned" && status.state !== "external") {
        console.warn("Cannot set hold: no active process");
        return;
      }

      try {
        const result = await api.setHold(sessionId, hold);
        // Process state will be updated via SSE state-change event
        // but we can optimistically update if needed
        if (result.state === "hold") {
          setProcessState("hold");
        } else if (result.state === "running") {
          setProcessState("running");
        }
      } catch (err) {
        console.warn("Failed to set hold:", err);
      }
    },
    [sessionId, status.state],
  );

  // Throttle state for incremental fetching
  const throttleRef = useRef<{
    timer: ReturnType<typeof setTimeout> | null;
    pending: boolean;
  }>({ timer: null, pending: false });

  // Track last message ID for incremental fetching
  const lastMessageIdRef = useRef<string | undefined>(undefined);

  // Add a message to the pending queue
  // Generates a tempId that will be sent to the server and echoed back in SSE
  const addPendingMessage = useCallback((content: string): string => {
    const tempId = `temp-${Date.now()}`;
    setPendingMessages((prev) => [
      ...prev,
      { tempId, content, timestamp: new Date().toISOString() },
    ]);
    return tempId;
  }, []);

  // Remove a pending message by tempId (used when server confirms or send fails)
  const removePendingMessage = useCallback((tempId: string) => {
    setPendingMessages((prev) => prev.filter((p) => p.tempId !== tempId));
  }, []);

  // Update lastMessageIdRef when messages change
  // Use getMessageId to prefer uuid over id
  useEffect(() => {
    const lastMessage = messages[messages.length - 1];
    if (lastMessage) {
      lastMessageIdRef.current = getMessageId(lastMessage);
    }
  }, [messages]);

  // Track if we've loaded pending agents for this session
  const pendingAgentsLoadedRef = useRef<string | null>(null);

  // Load initial data
  useEffect(() => {
    setLoading(true);
    // Reset agentContent when switching sessions
    setAgentContent({});
    pendingAgentsLoadedRef.current = null;
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
        // Set pending input request from API response immediately
        // This fixes race condition where SSE connection is delayed but tool approval is pending
        if (data.pendingInputRequest) {
          setPendingInputRequest(data.pendingInputRequest);
        }
      })
      .catch(setError)
      .finally(() => setLoading(false));
  }, [projectId, sessionId, applyServerModeUpdate]);

  // Load pending agent content on session load
  // This handles page reload while Tasks are running: loads agent content-so-far
  useEffect(() => {
    // Only run once per session after initial load
    if (loading || pendingAgentsLoadedRef.current === sessionId) return;
    if (messages.length === 0) return;

    const loadPendingAgents = async () => {
      // Mark as loaded to prevent re-running
      pendingAgentsLoadedRef.current = sessionId;

      // Find pending Tasks (tool_use without matching tool_result)
      const pendingTasks = findPendingTasks(messages);
      if (pendingTasks.length === 0) return;

      try {
        // Get agent mappings (toolUseId → agentId)
        const { mappings } = await api.getAgentMappings(projectId, sessionId);
        const mappingsMap = new Map(
          mappings.map((m) => [m.toolUseId, m.agentId]),
        );

        // Update the toolUseToAgent state with loaded mappings
        // This allows TaskRenderer to access agentContent even after page reload
        setToolUseToAgent((prev) => {
          const next = new Map(prev);
          for (const [toolUseId, agentId] of mappingsMap) {
            if (!next.has(toolUseId)) {
              next.set(toolUseId, agentId);
            }
          }
          return next;
        });

        // Load content for each pending task that has an agent file
        for (const task of pendingTasks) {
          const agentId = mappingsMap.get(task.toolUseId);
          if (!agentId) continue;

          try {
            const agentData = await api.getAgentSession(
              projectId,
              sessionId,
              agentId,
            );

            // Merge into agentContent state, deduping by message ID
            // Use getMessageId to prefer uuid over id
            setAgentContent((prev) => {
              const existing = prev[agentId];
              if (existing && existing.messages.length > 0) {
                // Already have content (maybe from SSE), merge without duplicates
                const existingIds = new Set(
                  existing.messages.map((m) => getMessageId(m)),
                );
                const newMessages = agentData.messages.filter(
                  (m) => !existingIds.has(getMessageId(m)),
                );
                return {
                  ...prev,
                  [agentId]: {
                    messages: [...existing.messages, ...newMessages],
                    status: agentData.status,
                  },
                };
              }
              // No existing content, use loaded data
              return {
                ...prev,
                [agentId]: agentData,
              };
            });
          } catch {
            // Skip agents that can't be loaded
          }
        }
      } catch {
        // Silent fail for agent mappings - not critical
      }
    };

    loadPendingAgents();
  }, [loading, messages, projectId, sessionId]);

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
          const result = mergeJSONLMessages(prev, data.messages, {
            skipDagOrdering: !getProvider(data.session.provider).capabilities
              .supportsDag,
          });
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
  // Uses lightweight metadata-only endpoint to avoid re-fetching all messages
  const fetchSessionMetadata = useCallback(async () => {
    try {
      const data = await api.getSessionMetadata(projectId, sessionId);
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
      const fileSessionId = extractSessionIdFromFileEvent(event);
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

  // Cleanup throttle timers
  useEffect(() => {
    return () => {
      if (throttleRef.current.timer) {
        clearTimeout(throttleRef.current.timer);
      }
    };
  }, []);

  // Callback for streaming content updates - routes to main messages or agentContent
  const handleStreamingUpdate = useCallback(
    (streamingMessage: Message, agentId?: string) => {
      const messageId = getMessageId(streamingMessage);
      if (!messageId) return;

      if (agentId) {
        // Route to agentContent
        setAgentContent((prev) => {
          const existing = prev[agentId] ?? {
            messages: [],
            status: "running" as const,
          };
          const existingIdx = existing.messages.findIndex(
            (m) => getMessageId(m) === messageId,
          );

          if (existingIdx >= 0) {
            const updated = [...existing.messages];
            updated[existingIdx] = streamingMessage;
            return { ...prev, [agentId]: { ...existing, messages: updated } };
          }
          return {
            ...prev,
            [agentId]: {
              ...existing,
              messages: [...existing.messages, streamingMessage],
            },
          };
        });
        return;
      }

      // Route to main messages
      setMessages((prev) => {
        const existingIdx = prev.findIndex(
          (m) => getMessageId(m) === messageId,
        );
        if (existingIdx >= 0) {
          const updated = [...prev];
          updated[existingIdx] = streamingMessage;
          return updated;
        }
        return [...prev, streamingMessage];
      });
    },
    [],
  );

  // Callback for toolUse→agent mapping
  const handleToolUseMapping = useCallback(
    (toolUseId: string, agentId: string) => {
      setToolUseToAgent((prev) => {
        if (prev.has(toolUseId)) return prev;
        const next = new Map(prev);
        next.set(toolUseId, agentId);
        return next;
      });
    },
    [],
  );

  // Callback for agent context usage updates
  const handleAgentContextUsage = useCallback(
    (agentId: string, usage: { inputTokens: number; percentage: number }) => {
      setAgentContent((prev) => {
        const existing = prev[agentId] ?? {
          messages: [],
          status: "running",
        };
        return {
          ...prev,
          [agentId]: { ...existing, contextUsage: usage },
        };
      });
    },
    [],
  );

  // Use streaming content hook for handling stream_event SSE messages
  const {
    handleStreamEvent,
    clearStreaming,
    cleanup: cleanupStreaming,
  } = useStreamingContent({
    onUpdateMessage: handleStreamingUpdate,
    onToolUseMapping: handleToolUseMapping,
    onAgentContextUsage: handleAgentContextUsage,
    streamingMarkdownCallbacks,
  });

  // Cleanup streaming timers on unmount
  useEffect(() => {
    return () => {
      cleanupStreaming();
    };
  }, [cleanupStreaming]);

  // Subscribe to live updates
  const handleSSEMessage = useCallback(
    (data: { eventType: string; [key: string]: unknown }) => {
      if (data.eventType === "message") {
        // Track SSE activity for engagement tracking
        // This ensures sessions are marked as "seen" even when receiving
        // subagent content (which doesn't update parent session file mtime)
        setLastSSEActivityAt(new Date().toISOString());

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
        // Delegate to useStreamingContent hook
        if (msgType === "stream_event") {
          if (handleStreamEvent(sdkMessage)) {
            return; // Event was handled, don't process as regular message
          }
        }

        // For assistant messages, clear streaming state and remove ALL streaming placeholders
        if (msgType === "assistant") {
          // Check if this is a subagent message
          // Use parentToolUseId as the routing key (it's the Task tool_use id)
          const isSubagentMsg =
            sdkMessage.isSubagent &&
            typeof sdkMessage.parentToolUseId === "string";
          const msgAgentId = isSubagentMsg
            ? (sdkMessage.parentToolUseId as string)
            : undefined;

          // Clear streaming state via hook
          clearStreaming();

          if (msgAgentId) {
            // Remove streaming placeholders from this agent's content
            setAgentContent((prev) => {
              const existing = prev[msgAgentId];
              if (!existing) return prev;
              const filtered = existing.messages.filter((m) => !m._isStreaming);
              if (filtered.length === existing.messages.length) return prev;
              return {
                ...prev,
                [msgAgentId]: { ...existing, messages: filtered },
              };
            });
          } else {
            // Remove ALL streaming placeholder messages from main messages
            setMessages((prev) => prev.filter((m) => !m._isStreaming));
          }
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

        // Handle tempId for pending message resolution
        // When server echoes back tempId, remove from pending queue
        const tempId = sdkMessage.tempId as string | undefined;
        if (msgType === "user" && tempId) {
          removePendingMessage(tempId);
        }

        // Route subagent messages to agentContent instead of main messages
        // This keeps the parent session's DAG clean and allows proper nesting in UI
        // Use parentToolUseId as the routing key (it's the Task tool_use id)
        if (
          sdkMessage.isSubagent &&
          typeof sdkMessage.parentToolUseId === "string"
        ) {
          const agentId = sdkMessage.parentToolUseId;

          // Capture toolUseId → agentId mapping on first subagent message
          // This allows TaskRenderer to access agentContent immediately
          // Note: Since agentId === parentToolUseId === toolUseId, the mapping is identity
          setToolUseToAgent((prev) => {
            if (prev.has(agentId)) return prev;
            const next = new Map(prev);
            next.set(agentId, agentId);
            return next;
          });

          setAgentContent((prev) => {
            const existing = prev[agentId] ?? {
              messages: [],
              status: "running" as const,
            };
            // Dedupe by message ID using getMessageId
            const incomingId = getMessageId(incoming);
            if (existing.messages.some((m) => getMessageId(m) === incomingId)) {
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
          const result = mergeSSEMessage(prev, incoming);
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
          // Also update actualSessionId from request in case it differs from URL
          // This handles the temp→real ID transition when state-change arrives
          // after the connected event (which may have had the temp ID)
          if (
            statusData.request.sessionId &&
            statusData.request.sessionId !== sessionId
          ) {
            setActualSessionId(statusData.request.sessionId);
          }
        } else {
          // Clear pending request when state changes away from waiting-input
          setPendingInputRequest(null);
        }
      } else if (data.eventType === "complete") {
        setProcessState("idle");
        setStatus({ state: "idle" });
        setPendingInputRequest(null);
      } else if (data.eventType === "connected") {
        // Sync state and permission mode from connected event
        const connectedData = data as {
          eventType: string;
          sessionId?: string;
          state?: string;
          permissionMode?: PermissionMode;
          modeVersion?: number;
          request?: InputRequest;
        };

        // Update actual session ID if server reports a different one
        // This handles the temp→real ID transition when createSession returns
        // before the SDK sends the real session ID
        // Check both the connected event's sessionId and the request's sessionId
        const serverSessionId =
          connectedData.sessionId ?? connectedData.request?.sessionId;
        if (serverSessionId && serverSessionId !== sessionId) {
          setActualSessionId(serverSessionId);
        }

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
      } else if (data.eventType === "markdown-augment") {
        // Handle markdown augment events (server-rendered)
        const augmentData = data as {
          eventType: string;
          blockIndex?: number;
          html: string;
          type?: string;
          messageId?: string;
        };

        // Two types of markdown-augment events:
        // 1. Final message augment: has messageId (uuid), no blockIndex
        //    → Store in markdownAugments for completed message rendering
        // 2. Streaming block augment: has blockIndex and type
        //    → Dispatch to streaming context for live rendering
        if (
          augmentData.messageId &&
          augmentData.blockIndex === undefined &&
          augmentData.html
        ) {
          // Final message augment - store in markdownAugments
          setMarkdownAugments((prev) => ({
            ...prev,
            [augmentData.messageId as string]: { html: augmentData.html },
          }));
        } else if (augmentData.blockIndex !== undefined) {
          // Streaming block augment - dispatch to context
          streamingMarkdownCallbacks?.onAugment?.({
            blockIndex: augmentData.blockIndex,
            html: augmentData.html,
            type: augmentData.type ?? "text",
            messageId: augmentData.messageId,
          });
        }
      } else if (data.eventType === "pending") {
        // Handle streaming markdown pending text events
        const pendingData = data as {
          eventType: string;
          html: string;
        };
        streamingMarkdownCallbacks?.onPending?.({
          html: pendingData.html,
        });
      }
    },
    [
      applyServerModeUpdate,
      sessionId,
      handleStreamEvent,
      clearStreaming,
      removePendingMessage,
      streamingMarkdownCallbacks,
    ],
  );

  // Handle SSE errors by checking if process is still alive
  // If process died (idle timeout), transition to idle state
  // Uses lightweight metadata endpoint to avoid re-fetching all messages
  const handleSSEError = useCallback(async () => {
    try {
      const data = await api.getSessionMetadata(projectId, sessionId);
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
    setAgentContent, // Setter for merging lazy-loaded agent content
    toolUseToAgent, // Mapping from Task tool_use_id → agentId (for rendering during streaming)
    markdownAugments, // Pre-rendered markdown HTML from REST response (keyed by blockId)
    status,
    processState,
    isHeld: processState === "hold", // Derived from process state
    pendingInputRequest,
    actualSessionId, // Real session ID from server (may differ from URL during temp→real transition)
    permissionMode: localMode, // UI-selected mode (sent with next message)
    isModePending, // True when local mode differs from server-confirmed
    modeVersion,
    loading,
    error,
    connected,
    lastSSEActivityAt, // Last SSE message timestamp for engagement tracking
    setStatus,
    setProcessState,
    setPermissionMode,
    setHold, // Set hold (soft pause) state
    pendingMessages, // Messages waiting for server confirmation
    addPendingMessage, // Add to pending queue, returns tempId
    removePendingMessage, // Remove from pending by tempId
  };
}
