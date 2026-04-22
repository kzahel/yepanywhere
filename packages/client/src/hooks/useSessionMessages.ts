import { useCallback, useEffect, useRef, useState } from "react";
import { type PaginationInfo, api } from "../api/client";
import {
  getMessageTimestampMs,
  hasEquivalentJsonlMessage,
  reconcileCodexLinearMessages,
} from "../lib/codexLinearMessages";
import {
  getMessageId,
  mergeJSONLMessages,
  mergeStreamMessage,
} from "../lib/mergeMessages";
import { getProvider } from "../providers/registry";
import type { Message, Session, SessionStatus } from "../types";
import { useServerSettings } from "./useServerSettings";

const DEFAULT_HISTORY_PAGE_SIZE = 2;
const DEFAULT_HISTORY_PAGINATION_MODE = "compactions";

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

/** Result from initial session load */
export interface SessionLoadResult {
  session: Session;
  status: SessionStatus;
  pendingInputRequest?: unknown;
  slashCommands?: Array<{
    name: string;
    description: string;
    argumentHint?: string;
  }> | null;
}

/** Options for useSessionMessages */
export interface UseSessionMessagesOptions {
  projectId: string;
  sessionId: string;
  /** Called when initial load completes with session data */
  onLoadComplete?: (result: SessionLoadResult) => void;
  /** Called on load error */
  onLoadError?: (error: Error) => void;
}

/** Result from useSessionMessages hook */
export interface UseSessionMessagesResult {
  /** Messages in the session */
  messages: Message[];
  /** Subagent content keyed by agentId */
  agentContent: AgentContentMap;
  /** Mapping from Task tool_use_id → agentId */
  toolUseToAgent: Map<string, string>;
  /** Whether initial load is in progress */
  loading: boolean;
  /** Session data from initial load */
  session: Session | null;
  /** Set session data (for stream connected event) */
  setSession: React.Dispatch<React.SetStateAction<Session | null>>;
  /** Handle streaming content updates (for useStreamingContent) */
  handleStreamingUpdate: (message: Message, agentId?: string) => void;
  /** Handle stream message event (buffered until initial load completes) */
  handleStreamMessageEvent: (incoming: Message) => void;
  /** Handle stream subagent message event */
  handleStreamSubagentMessage: (incoming: Message, agentId: string) => void;
  /** Register toolUse → agent mapping */
  registerToolUseAgent: (toolUseId: string, agentId: string) => void;
  /** Update agent content (for lazy loading) */
  setAgentContent: React.Dispatch<React.SetStateAction<AgentContentMap>>;
  /** Update toolUseToAgent mapping */
  setToolUseToAgent: React.Dispatch<React.SetStateAction<Map<string, string>>>;
  /** Direct messages setter (for clearing streaming placeholders) */
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  /** Fetch new messages incrementally (for file change events) */
  fetchNewMessages: () => Promise<void>;
  /** Fetch session metadata only */
  fetchSessionMetadata: () => Promise<void>;
  /** Pagination info from bounded session message loading */
  pagination: PaginationInfo | undefined;
  /** Whether older messages are being loaded */
  loadingOlder: boolean;
  /** Load the next chunk of older messages */
  loadOlderMessages: () => Promise<void>;
}

function isCodexProvider(provider?: string): boolean {
  return provider === "codex" || provider === "codex-oss";
}

function getMessageRole(message: Message): string {
  const nestedRole = (message.message as { role?: unknown } | undefined)?.role;
  if (nestedRole === "user" || nestedRole === "assistant") {
    return nestedRole;
  }
  if (
    message.role === "user" ||
    message.role === "assistant" ||
    message.role === "system"
  ) {
    return message.role;
  }
  return "unknown";
}

function isEmptyAssistantContent(message: Message): boolean {
  if (message.type !== "assistant") {
    return false;
  }

  const content = message.message?.content;
  if (typeof content === "string") {
    return content.trim().length === 0;
  }

  if (!Array.isArray(content)) {
    return false;
  }

  return content.every((block) => {
    if (!block || typeof block !== "object") {
      return true;
    }

    const typedBlock = block as Record<string, unknown>;
    if (typedBlock.type === "text") {
      return (
        typeof typedBlock.text !== "string" || typedBlock.text.trim() === ""
      );
    }
    if (typedBlock.type === "thinking") {
      return (
        typeof typedBlock.thinking !== "string" ||
        typedBlock.thinking.trim() === ""
      );
    }
    return false;
  });
}

/**
 * Hook for managing session messages with stream buffering.
 *
 * Handles:
 * - Initial REST load of messages
 * - Buffering stream messages until initial load completes
 * - Merging stream and JSONL messages
 * - Routing subagent messages to agentContent
 */
export function useSessionMessages(
  options: UseSessionMessagesOptions,
): UseSessionMessagesResult {
  const { projectId, sessionId, onLoadComplete, onLoadError } = options;
  const { settings: serverSettings, isLoading: serverSettingsLoading } =
    useServerSettings();

  // Core state
  const [messages, setMessages] = useState<Message[]>([]);
  const [agentContent, setAgentContent] = useState<AgentContentMap>({});
  const [toolUseToAgent, setToolUseToAgent] = useState<Map<string, string>>(
    () => new Map(),
  );
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<Session | null>(null);
  const [pagination, setPagination] = useState<PaginationInfo | undefined>();
  const [loadingOlder, setLoadingOlder] = useState(false);

  const historyPaginationMode =
    serverSettings?.sessionHistoryPaginationMode ??
    DEFAULT_HISTORY_PAGINATION_MODE;
  const historyPageSize = Math.max(
    serverSettings?.sessionHistoryPageSize ?? DEFAULT_HISTORY_PAGE_SIZE,
    1,
  );

  // Buffering: queue stream messages until initial load completes
  const streamBufferRef = useRef<
    Array<
      | { type: "message"; msg: Message }
      | { type: "subagent"; msg: Message; agentId: string }
    >
  >([]);
  const initialLoadCompleteRef = useRef(false);

  // Track provider for DAG ordering decisions
  const providerRef = useRef<string | undefined>(undefined);

  // Track last message ID for incremental fetching
  const lastMessageIdRef = useRef<string | undefined>(undefined);
  // Highest timestamp observed from persisted JSONL messages.
  // Used to suppress startup replay events that are already on disk.
  const maxPersistedTimestampMsRef = useRef<number>(Number.NEGATIVE_INFINITY);

  const updatePersistedTimestampWatermark = useCallback(
    (persistedMessages: Message[]) => {
      let maxMs = maxPersistedTimestampMsRef.current;
      for (const message of persistedMessages) {
        const ts = getMessageTimestampMs(message);
        if (ts !== null && ts > maxMs) {
          maxMs = ts;
        }
      }
      maxPersistedTimestampMsRef.current = maxMs;
    },
    [],
  );

  // Update lastMessageIdRef when messages change
  useEffect(() => {
    const lastMessage = messages[messages.length - 1];
    if (lastMessage) {
      lastMessageIdRef.current = getMessageId(lastMessage);
    }
  }, [messages]);

  // Process a stream message event.
  // When replaying buffered startup events for Codex, suppress entries that are
  // semantically identical to already-loaded JSONL messages but have different UUIDs.
  const processStreamMessage = useCallback(
    (incoming: Message, fromBufferedReplay = false) => {
      const provider = providerRef.current;
      const isReplay = incoming.isReplay === true;
      const shouldApplyReplayDedupe =
        (fromBufferedReplay || isReplay) && isCodexProvider(provider);
      const incomingTimestampMs = getMessageTimestampMs(incoming);
      const isPersistedReplay =
        isReplay &&
        incomingTimestampMs !== null &&
        incomingTimestampMs <= maxPersistedTimestampMsRef.current;

      setMessages((prev) => {
        // Replay history from the stream should not re-add messages that are
        // already persisted and loaded from JSONL.
        if (isPersistedReplay) {
          return prev;
        }

        if (shouldApplyReplayDedupe) {
          if (isEmptyAssistantContent(incoming)) {
            return prev;
          }
          if (hasEquivalentJsonlMessage(prev, incoming)) {
            return prev;
          }
        }

        const result = mergeStreamMessage(prev, incoming);
        return isCodexProvider(provider)
          ? reconcileCodexLinearMessages(result.messages)
          : result.messages;
      });
    },
    [],
  );

  // Process a buffered stream subagent message
  const processStreamSubagentMessage = useCallback(
    (incoming: Message, agentId: string) => {
      setAgentContent((prev) => {
        const existing = prev[agentId] ?? {
          messages: [],
          status: "running" as const,
        };
        const incomingId = getMessageId(incoming);
        if (existing.messages.some((m) => getMessageId(m) === incomingId)) {
          return prev;
        }
        return {
          ...prev,
          [agentId]: {
            ...existing,
            messages: [...existing.messages, incoming],
            status: "running",
          },
        };
      });
    },
    [],
  );

  // Flush buffered stream messages after initial load
  const flushBuffer = useCallback(() => {
    const buffer = streamBufferRef.current;
    streamBufferRef.current = [];
    for (const item of buffer) {
      if (item.type === "message") {
        processStreamMessage(item.msg, true);
      } else {
        processStreamSubagentMessage(item.msg, item.agentId);
      }
    }
  }, [processStreamMessage, processStreamSubagentMessage]);

  // Initial load
  useEffect(() => {
    if (serverSettingsLoading) {
      return;
    }

    initialLoadCompleteRef.current = false;
    streamBufferRef.current = [];
    maxPersistedTimestampMsRef.current = Number.NEGATIVE_INFINITY;
    setLoading(true);
    setAgentContent({});

    api
      .getSession(projectId, sessionId, undefined, {
        ...(historyPaginationMode === "compactions"
          ? { tailCompactions: historyPageSize }
          : { tailMessages: historyPageSize }),
      })
      .then((data) => {
        setSession(data.session);
        setPagination(data.pagination);
        providerRef.current = data.session.provider;

        // Tag messages from JSONL as authoritative
        const taggedMessages = data.messages.map((m) => ({
          ...m,
          _source: "jsonl" as const,
        }));
        updatePersistedTimestampWatermark(taggedMessages);
        setMessages(
          isCodexProvider(data.session.provider)
            ? reconcileCodexLinearMessages(taggedMessages)
            : taggedMessages,
        );

        // Update lastMessageIdRef synchronously to avoid race condition:
        // stream "connected" event calls fetchNewMessages() immediately, but the
        // useEffect that normally updates lastMessageIdRef runs asynchronously.
        // Without this, fetchNewMessages() would use undefined and refetch everything.
        const lastMessage = taggedMessages[taggedMessages.length - 1];
        if (lastMessage) {
          lastMessageIdRef.current = getMessageId(lastMessage);
        }

        // Mark ready and flush buffer
        initialLoadCompleteRef.current = true;
        flushBuffer();

        setLoading(false);

        // Notify parent
        onLoadComplete?.({
          session: data.session,
          status: data.ownership,
          pendingInputRequest: data.pendingInputRequest,
          slashCommands: data.slashCommands,
        });
      })
      .catch((err) => {
        setLoading(false);
        onLoadError?.(err);
      });
  }, [
    historyPaginationMode,
    historyPageSize,
    serverSettingsLoading,
    projectId,
    sessionId,
    onLoadComplete,
    onLoadError,
    flushBuffer,
    updatePersistedTimestampWatermark,
  ]);

  // Handle streaming content updates (from useStreamingContent)
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

  // Handle stream message event (with buffering)
  const handleStreamMessageEvent = useCallback(
    (incoming: Message) => {
      if (!initialLoadCompleteRef.current) {
        streamBufferRef.current.push({ type: "message", msg: incoming });
        return;
      }
      processStreamMessage(incoming);
    },
    [processStreamMessage],
  );

  // Handle stream subagent message event (with buffering)
  const handleStreamSubagentMessage = useCallback(
    (incoming: Message, agentId: string) => {
      if (!initialLoadCompleteRef.current) {
        streamBufferRef.current.push({
          type: "subagent",
          msg: incoming,
          agentId,
        });
        return;
      }
      processStreamSubagentMessage(incoming, agentId);
    },
    [processStreamSubagentMessage],
  );

  // Register toolUse → agent mapping
  const registerToolUseAgent = useCallback(
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

  // Fetch new messages incrementally (for file change events)
  const fetchNewMessages = useCallback(async () => {
    try {
      const data = await api.getSession(
        projectId,
        sessionId,
        lastMessageIdRef.current,
      );
      if (data.messages.length > 0) {
        updatePersistedTimestampWatermark(data.messages);
        setMessages((prev) => {
          const result = mergeJSONLMessages(prev, data.messages, {
            skipDagOrdering: !getProvider(data.session.provider).capabilities
              .supportsDag,
          });
          return isCodexProvider(data.session.provider)
            ? reconcileCodexLinearMessages(result.messages)
            : result.messages;
        });
      }
      // Update session metadata (including title, model, contextUsage) which may have changed
      // For new sessions, prev may be null if JSONL didn't exist on initial load
      setSession((prev) =>
        prev
          ? { ...prev, ...data.session, messages: prev.messages }
          : data.session,
      );
    } catch {
      // Silent fail for incremental updates
    }
  }, [projectId, sessionId, updatePersistedTimestampWatermark]);

  // Load older messages (previous chunk before the current truncation point)
  const loadOlderMessages = useCallback(async () => {
    if (!pagination?.hasOlderMessages || !pagination.truncatedBeforeMessageId) {
      return;
    }
    setLoadingOlder(true);
    try {
      const data = await api.getSession(projectId, sessionId, undefined, {
        ...(historyPaginationMode === "compactions"
          ? { tailCompactions: historyPageSize }
          : { tailMessages: historyPageSize }),
        beforeMessageId: pagination.truncatedBeforeMessageId,
      });
      setMessages((prev) => {
        const taggedOlder = data.messages.map((m) => ({
          ...m,
          _source: "jsonl" as const,
        }));
        updatePersistedTimestampWatermark(taggedOlder);
        const combined = [...taggedOlder, ...prev];
        return isCodexProvider(data.session.provider)
          ? reconcileCodexLinearMessages(combined)
          : combined;
      });
      setPagination(data.pagination);
    } catch {
      // Silent fail for loading older messages
    } finally {
      setLoadingOlder(false);
    }
  }, [
    historyPaginationMode,
    historyPageSize,
    projectId,
    sessionId,
    pagination,
    updatePersistedTimestampWatermark,
  ]);

  // Fetch session metadata only
  const fetchSessionMetadata = useCallback(async () => {
    try {
      const data = await api.getSessionMetadata(projectId, sessionId);
      // For new sessions, prev may be null if JSONL didn't exist on initial load
      setSession((prev) =>
        prev
          ? { ...prev, ...data.session, messages: prev.messages }
          : { ...data.session, messages: [] },
      );
    } catch {
      // Silent fail for metadata updates
    }
  }, [projectId, sessionId]);

  return {
    messages,
    agentContent,
    toolUseToAgent,
    loading,
    session,
    setSession,
    handleStreamingUpdate,
    handleStreamMessageEvent,
    handleStreamSubagentMessage,
    registerToolUseAgent,
    setAgentContent,
    setToolUseToAgent,
    setMessages,
    fetchNewMessages,
    fetchSessionMetadata,
    pagination,
    loadingOlder,
    loadOlderMessages,
  };
}
