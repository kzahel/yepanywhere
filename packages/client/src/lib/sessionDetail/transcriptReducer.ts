import {
  getMessageTimestampMs,
  hasEquivalentJsonlMessage,
  reconcileClaudeQueueOperationEchoes,
  reconcileCodexSteerEchoes,
  reconcileLinearMessages,
  reconcileSelfSendUserEchoes,
} from "../linearMessageDedup";
import { isUnconfirmedSelfSend } from "../deliveryState";
import { reconcileCodexToolMessages } from "../codexToolReconciliation";
import { getMessageId } from "@yep-anywhere/shared/transcript/message";
import {
  findMessageIndexById,
  mergeJSONLMessages,
  mergeStreamMessage,
} from "../mergeMessages";
import { getProvider } from "../../providers/registry";
import type { Message } from "../../types";
import type {
  AgentContextUsage,
  AgentContent,
  AgentContentMap,
  MarkdownAugmentMap,
  SessionDetailAction,
  SessionDetailState,
} from "./types";
import { trimSessionDetailLoadedWindow } from "./trimLoadedWindow";

export function createInitialSessionDetailState(): SessionDetailState {
  return {
    messages: [],
    session: null,
    agentContent: {},
    markdownAugments: {},
    toolUseToAgentEntries: [],
    maxPersistedTimestampMs: Number.NEGATIVE_INFINITY,
    deferredMessages: [],
    activeWindowTrimRevision: 0,
  };
}

function usesApproxMessageDedup(
  provider: string | undefined,
  codexStreamDurableIdAlignment: boolean,
): boolean {
  return (
    getProvider(provider).capabilities.needsApproxMessageDedup ||
    (provider === "codex" && !codexStreamDurableIdAlignment)
  );
}

function usesQueueOperationEchoDedup(provider?: string): boolean {
  return getProvider(provider).capabilities.dedupQueueOperationEchoes === true;
}

function usesSelfSendUserEchoDedup(provider?: string): boolean {
  return getProvider(provider).capabilities.dedupSelfSendUserEchoes === true;
}

function approxDedupOptions(
  provider: string | undefined,
  codexStreamDurableIdAlignment: boolean,
): { excludeTools: boolean } {
  return {
    excludeTools:
      getProvider(provider).capabilities.approxDedupExcludesTools === true ||
      (provider === "codex" && !codexStreamDurableIdAlignment),
  };
}

function isDurableRecapOverlay(message: Message): boolean {
  return typeof message.yaRecapSource === "string";
}

export function findLastJsonlMessageId(
  messages: readonly Message[],
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (
      message &&
      (message._source ?? "sdk") === "jsonl" &&
      !isDurableRecapOverlay(message)
    ) {
      return getMessageId(message);
    }
  }
  return undefined;
}

function updatePersistedTimestampWatermark(
  current: number,
  persistedMessages: readonly Message[],
): number {
  let maxMs = current;
  for (const message of persistedMessages) {
    if (isDurableRecapOverlay(message)) {
      continue;
    }
    const timestampMs = getMessageTimestampMs(message);
    if (timestampMs !== null && timestampMs > maxMs) {
      maxMs = timestampMs;
    }
  }
  return maxMs;
}

export function tagJsonlMessages(messages: readonly Message[]): Message[] {
  return messages.map((message) => ({
    ...message,
    _source: "jsonl" as const,
  }));
}

function mergePersistedMessagesForProvider(
  baseMessages: Message[],
  taggedMessages: Message[],
  provider: string | undefined,
  codexStreamDurableIdAlignment: boolean,
): Message[] {
  const result = mergeJSONLMessages(baseMessages, taggedMessages, {
    skipDagOrdering: !getProvider(provider).capabilities.supportsDag,
  });
  return maybeReconcileApprox(
    result.messages,
    provider,
    codexStreamDurableIdAlignment,
  );
}

function replacePersistedTailForProvider(
  previousMessages: Message[],
  taggedMessages: Message[],
  provider: string | undefined,
  codexStreamDurableIdAlignment: boolean,
): Message[] {
  let messages = taggedMessages;
  for (const previousMessage of previousMessages) {
    if (!isUnconfirmedSelfSend(previousMessage)) {
      continue;
    }
    messages = mergeStreamMessage(messages, previousMessage).messages;
  }
  return maybeReconcileApprox(
    messages,
    provider,
    codexStreamDurableIdAlignment,
  );
}

export function clearStreamingPlaceholderMessages(
  messages: Message[],
): Message[] {
  const filtered = messages.filter((message) => !message._isStreaming);
  return filtered.length === messages.length ? messages : filtered;
}

function messageMatchesTempId(message: Message, tempId: string): boolean {
  const messageTempId = (message as { tempId?: unknown }).tempId;
  if (messageTempId === tempId) {
    return true;
  }
  const tempIds = (message as { tempIds?: unknown }).tempIds;
  return Array.isArray(tempIds) && tempIds.includes(tempId);
}

function removeUnconfirmedSelfSend(
  messages: Message[],
  tempId: string,
): Message[] {
  const filtered = messages.filter(
    (message) =>
      !isUnconfirmedSelfSend(message) || !messageMatchesTempId(message, tempId),
  );
  return filtered.length === messages.length ? messages : filtered;
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

function maybeReconcileApprox(
  messages: Message[],
  provider: string | undefined,
  codexStreamDurableIdAlignment: boolean,
): Message[] {
  const providerReconciled =
    provider === "codex" || provider === "codex-oss"
      ? reconcileCodexToolMessages(messages)
      : messages;
  const approx = usesApproxMessageDedup(provider, codexStreamDurableIdAlignment)
    ? reconcileLinearMessages(
        providerReconciled,
        approxDedupOptions(provider, codexStreamDurableIdAlignment),
      )
    : providerReconciled;
  const steerReconciled =
    provider === "codex-oss" ||
    (provider === "codex" && !codexStreamDurableIdAlignment)
      ? reconcileCodexSteerEchoes(approx)
      : approx;
  const selfSendReconciled = usesSelfSendUserEchoDedup(provider)
    ? reconcileSelfSendUserEchoes(steerReconciled)
    : steerReconciled;
  return usesQueueOperationEchoDedup(provider)
    ? reconcileClaudeQueueOperationEchoes(selfSendReconciled)
    : selfSendReconciled;
}

function maxOptionalNumber(
  left: number | undefined,
  right: number | undefined,
): number | undefined {
  if (left === undefined) {
    return right;
  }
  if (right === undefined) {
    return left;
  }
  return Math.max(left, right);
}

function updateCatchupPaginationCounts(
  current: SessionDetailState["pagination"],
  incoming: SessionDetailState["pagination"],
  messageCount: number,
): SessionDetailState["pagination"] {
  if (!current) {
    return undefined;
  }

  const totalUserTurns = maxOptionalNumber(
    current.totalUserTurns,
    incoming?.totalUserTurns,
  );

  return {
    ...current,
    totalMessageCount: Math.max(
      current.totalMessageCount,
      incoming?.totalMessageCount ?? 0,
      messageCount,
    ),
    returnedMessageCount: Math.max(
      current.returnedMessageCount,
      incoming?.returnedMessageCount ?? 0,
      messageCount,
    ),
    totalCompactions: Math.max(
      current.totalCompactions,
      incoming?.totalCompactions ?? 0,
    ),
    ...(totalUserTurns !== undefined && { totalUserTurns }),
  };
}

function applyStreamMessage(
  state: SessionDetailState,
  action: Extract<SessionDetailAction, { type: "applyStreamMessage" }>,
): SessionDetailState {
  const provider = state.session?.provider;
  const incoming = action.message;
  const isReplay = incoming.isReplay === true;
  const incomingTimestampMs = getMessageTimestampMs(incoming);
  const incomingId = getMessageId(incoming);
  const hasPersistedIdentity =
    incomingId !== undefined &&
    state.messages.some(
      (message) =>
        (message._source ?? "sdk") === "jsonl" &&
        getMessageId(message) === incomingId,
    );
  const isPersistedReplay =
    isReplay &&
    (provider === "codex" && action.codexStreamDurableIdAlignment === true
      ? hasPersistedIdentity
      : incomingTimestampMs !== null &&
        incomingTimestampMs <= state.maxPersistedTimestampMs);

  if (incoming._isStreaming === true && action.streamingEnabled === false) {
    const messages = clearStreamingPlaceholderMessages(state.messages);
    return messages === state.messages ? state : { ...state, messages };
  }

  if (isPersistedReplay) {
    return state;
  }

  const shouldApplyReplayDedupe =
    (action.fromBufferedReplay || isReplay) &&
    usesApproxMessageDedup(
      provider,
      action.codexStreamDurableIdAlignment === true,
    );
  if (shouldApplyReplayDedupe) {
    if (isEmptyAssistantContent(incoming)) {
      return state;
    }
    if (
      hasEquivalentJsonlMessage(
        state.messages,
        incoming,
        approxDedupOptions(
          provider,
          action.codexStreamDurableIdAlignment === true,
        ),
      )
    ) {
      return state;
    }
  }

  const result = mergeStreamMessage(state.messages, incoming);
  const messages = maybeReconcileApprox(
    result.messages,
    provider,
    action.codexStreamDurableIdAlignment === true,
  );
  return messages === state.messages ? state : { ...state, messages };
}

export function applyStreamSubagentMessageToMap(
  agentContent: AgentContentMap,
  agentId: string,
  message: Message,
  streamingEnabled?: boolean,
): AgentContentMap {
  const existing = agentContent[agentId] ?? {
    messages: [],
    status: "running" as const,
  };

  if (message._isStreaming === true && streamingEnabled === false) {
    const messages = clearStreamingPlaceholderMessages(existing.messages);
    if (messages === existing.messages) {
      return agentContent;
    }
    if (messages.length === 0 && existing.contextUsage === undefined) {
      const next = { ...agentContent };
      delete next[agentId];
      return next;
    }
    return {
      ...agentContent,
      [agentId]: {
        ...existing,
        messages,
      },
    };
  }

  const incomingId = getMessageId(message);
  if (findMessageIndexById(existing.messages, incomingId) !== -1) {
    return agentContent;
  }

  return {
    ...agentContent,
    [agentId]: {
      ...existing,
      messages: [...existing.messages, message],
      status: "running",
    },
  };
}

function applyStreamSubagentMessage(
  state: SessionDetailState,
  action: Extract<SessionDetailAction, { type: "applyStreamSubagentMessage" }>,
): SessionDetailState {
  const agentContent = applyStreamSubagentMessageToMap(
    state.agentContent,
    action.agentId,
    action.message,
    action.streamingEnabled,
  );
  return agentContent === state.agentContent
    ? state
    : { ...state, agentContent };
}

export function upsertStreamingPlaceholderMessages(
  messages: Message[],
  streamingMessage: Message,
): Message[] {
  const messageId = getMessageId(streamingMessage);
  if (!messageId) {
    return messages;
  }
  const existingIdx = findMessageIndexById(messages, messageId);
  if (existingIdx >= 0) {
    const updated = [...messages];
    updated[existingIdx] = streamingMessage;
    return updated;
  }
  return [...messages, streamingMessage];
}

export function upsertAgentStreamingPlaceholderMap(
  agentContent: AgentContentMap,
  agentId: string,
  streamingMessage: Message,
): AgentContentMap {
  const existing = agentContent[agentId] ?? {
    messages: [],
    status: "running" as const,
  };
  const messages = upsertStreamingPlaceholderMessages(
    existing.messages,
    streamingMessage,
  );
  if (messages === existing.messages) {
    return agentContent;
  }
  return {
    ...agentContent,
    [agentId]: {
      ...existing,
      messages,
    },
  };
}

export function mergeLoadedAgentContentMap(
  agentContent: AgentContentMap,
  agentId: string,
  content: AgentContent,
): AgentContentMap {
  const existing = agentContent[agentId];
  if (existing) {
    const loadedIds = new Set(
      content.messages.map((message) => getMessageId(message)),
    );
    const liveOnlyMessages = existing.messages.filter(
      (message) => !loadedIds.has(getMessageId(message)),
    );
    return {
      ...agentContent,
      [agentId]: {
        messages: [...content.messages, ...liveOnlyMessages],
        status: existing.status === "running" ? "running" : content.status,
      },
    };
  }

  return {
    ...agentContent,
    [agentId]: content,
  };
}

export function updateAgentContextUsageMap(
  agentContent: AgentContentMap,
  agentId: string,
  contextUsage: AgentContextUsage,
): AgentContentMap {
  const existing = agentContent[agentId] ?? {
    messages: [],
    status: "running" as const,
  };
  return {
    ...agentContent,
    [agentId]: {
      ...existing,
      contextUsage,
    },
  };
}

export function clearAgentStreamingPlaceholdersMap(
  agentContent: AgentContentMap,
  agentId: string,
): AgentContentMap {
  const existing = agentContent[agentId];
  if (!existing) {
    return agentContent;
  }

  const messages = clearStreamingPlaceholderMessages(existing.messages);
  if (messages === existing.messages) {
    return agentContent;
  }

  return {
    ...agentContent,
    [agentId]: {
      ...existing,
      messages,
    },
  };
}

function findEquivalentJsonlMessageId(
  previousMessage: Message,
  nextMessages: readonly Message[],
  provider: string | undefined,
  codexStreamDurableIdAlignment: boolean,
): string | undefined {
  if (!usesApproxMessageDedup(provider, codexStreamDurableIdAlignment)) {
    return undefined;
  }

  for (const candidate of nextMessages) {
    if ((candidate._source ?? "sdk") !== "jsonl") {
      continue;
    }
    const candidateId = getMessageId(candidate);
    if (!candidateId) {
      continue;
    }
    if (
      hasEquivalentJsonlMessage(
        [candidate],
        previousMessage,
        approxDedupOptions(provider, codexStreamDurableIdAlignment),
      )
    ) {
      return candidateId;
    }
  }

  return undefined;
}

function reconcileMarkdownAugmentMessageIds(
  state: SessionDetailState,
  nextMessages: readonly Message[],
  provider: string | undefined,
  codexStreamDurableIdAlignment: boolean,
  markdownAugments: MarkdownAugmentMap = state.markdownAugments,
): MarkdownAugmentMap {
  const augmentEntries = Object.entries(markdownAugments);
  if (augmentEntries.length === 0) {
    return markdownAugments;
  }

  const nextMessageIds = new Set(
    nextMessages.map((message) => getMessageId(message)).filter(Boolean),
  );
  const previousMessagesById = new Map(
    state.messages
      .map((message) => [getMessageId(message), message] as const)
      .filter(([messageId]) => messageId.length > 0),
  );

  let nextAugments = markdownAugments;
  for (const [messageId, augment] of augmentEntries) {
    if (nextMessageIds.has(messageId)) {
      continue;
    }

    const previousMessage = previousMessagesById.get(messageId);
    if (!previousMessage) {
      continue;
    }

    const durableMessageId = findEquivalentJsonlMessageId(
      previousMessage,
      nextMessages,
      provider,
      codexStreamDurableIdAlignment,
    );
    if (!durableMessageId || durableMessageId === messageId) {
      continue;
    }

    if (nextAugments === markdownAugments) {
      nextAugments = { ...markdownAugments };
    }
    if (!nextAugments[durableMessageId]) {
      nextAugments[durableMessageId] = augment;
    }
    delete nextAugments[messageId];
  }

  return nextAugments;
}

export function reduceSessionDetailState(
  state: SessionDetailState,
  action: SessionDetailAction,
): SessionDetailState {
  switch (action.type) {
    case "restoreRouteSnapshot":
      return {
        ...state,
        messages: action.snapshot.messages,
        session: action.snapshot.session,
        pagination: action.snapshot.pagination,
        agentContent: action.snapshot.agentContent,
        markdownAugments: action.snapshot.markdownAugments ?? {},
        toolUseToAgentEntries: action.snapshot.toolUseToAgentEntries,
        deferredMessages: [],
        lastMessageId:
          action.snapshot.lastMessageId ??
          findLastJsonlMessageId(action.snapshot.messages),
        maxPersistedTimestampMs: action.snapshot.maxPersistedTimestampMs,
      };

    case "loadPersistedTranscript": {
      const taggedMessages = tagJsonlMessages(action.messages);
      const messages = maybeReconcileApprox(
        taggedMessages,
        action.session.provider,
        action.codexStreamDurableIdAlignment === true,
      );
      const markdownAugments = action.markdownAugments
        ? { ...state.markdownAugments, ...action.markdownAugments }
        : state.markdownAugments;
      return {
        ...state,
        messages,
        session: action.session,
        pagination: action.pagination,
        agentContent: action.agentContent ?? {},
        markdownAugments: reconcileMarkdownAugmentMessageIds(
          state,
          messages,
          action.session.provider,
          action.codexStreamDurableIdAlignment === true,
          markdownAugments,
        ),
        toolUseToAgentEntries: action.toolUseToAgentEntries ?? [],
        deferredMessages: action.deferredMessages ?? [],
        lastMessageId: findLastJsonlMessageId(messages),
        maxPersistedTimestampMs: updatePersistedTimestampWatermark(
          Number.NEGATIVE_INFINITY,
          taggedMessages,
        ),
      };
    }

    case "setSessionMetadata":
      return action.session === state.session
        ? state
        : { ...state, session: action.session };

    case "applyStreamMessage":
      return applyStreamMessage(state, action);

    case "applyStreamSubagentMessage":
      return applyStreamSubagentMessage(state, action);

    case "upsertStreamingPlaceholder": {
      if (action.agentId) {
        const agentContent = upsertAgentStreamingPlaceholderMap(
          state.agentContent,
          action.agentId,
          action.message,
        );
        return agentContent === state.agentContent
          ? state
          : { ...state, agentContent };
      }
      const messages = upsertStreamingPlaceholderMessages(
        state.messages,
        action.message,
      );
      return messages === state.messages ? state : { ...state, messages };
    }

    case "mergeLoadedAgentContent":
      return {
        ...state,
        agentContent: mergeLoadedAgentContentMap(
          state.agentContent,
          action.agentId,
          action.content,
        ),
      };

    case "updateAgentContextUsage":
      return {
        ...state,
        agentContent: updateAgentContextUsageMap(
          state.agentContent,
          action.agentId,
          action.contextUsage,
        ),
      };

    case "clearAgentStreamingPlaceholders": {
      const agentContent = clearAgentStreamingPlaceholdersMap(
        state.agentContent,
        action.agentId,
      );
      return agentContent === state.agentContent
        ? state
        : { ...state, agentContent };
    }

    case "clearStreamingPlaceholders": {
      const messages = clearStreamingPlaceholderMessages(state.messages);
      return messages === state.messages ? state : { ...state, messages };
    }

    case "removeUnconfirmedSelfSend": {
      const messages = removeUnconfirmedSelfSend(state.messages, action.tempId);
      return messages === state.messages ? state : { ...state, messages };
    }

    case "registerToolUseAgent": {
      if (
        state.toolUseToAgentEntries.some(
          ([toolUseId]) => toolUseId === action.toolUseId,
        )
      ) {
        return state;
      }
      return {
        ...state,
        toolUseToAgentEntries: [
          ...state.toolUseToAgentEntries,
          [action.toolUseId, action.agentId],
        ],
      };
    }

    case "applyCatchupMessages": {
      const taggedMessages = tagJsonlMessages(action.messages);
      const session = action.session ?? state.session;
      const provider = session?.provider;
      const messages = mergePersistedMessagesForProvider(
        state.messages,
        taggedMessages,
        provider,
        action.codexStreamDurableIdAlignment === true,
      );
      return {
        ...state,
        messages,
        session,
        pagination: updateCatchupPaginationCounts(
          state.pagination,
          action.pagination,
          messages.length,
        ),
        markdownAugments: reconcileMarkdownAugmentMessageIds(
          state,
          messages,
          provider,
          action.codexStreamDurableIdAlignment === true,
        ),
        lastMessageId: findLastJsonlMessageId(messages),
        maxPersistedTimestampMs: updatePersistedTimestampWatermark(
          state.maxPersistedTimestampMs,
          taggedMessages,
        ),
      };
    }

    case "replaceTailWindow": {
      const taggedMessages = tagJsonlMessages(action.messages);
      const messages = replacePersistedTailForProvider(
        state.messages,
        taggedMessages,
        action.session.provider,
        action.codexStreamDurableIdAlignment === true,
      );
      return {
        ...state,
        messages,
        session: action.session,
        pagination: action.pagination,
        markdownAugments: reconcileMarkdownAugmentMessageIds(
          state,
          messages,
          action.session.provider,
          action.codexStreamDurableIdAlignment === true,
        ),
        lastMessageId: findLastJsonlMessageId(messages),
        maxPersistedTimestampMs: updatePersistedTimestampWatermark(
          state.maxPersistedTimestampMs,
          taggedMessages,
        ),
      };
    }

    case "trimLoadedWindow":
      return trimSessionDetailLoadedWindow(state, action);

    case "prependOlderMessages": {
      const taggedMessages = tagJsonlMessages(action.messages);
      const provider = state.session?.provider;
      const combined = [...taggedMessages, ...state.messages];
      const messages = maybeReconcileApprox(
        combined,
        provider,
        action.codexStreamDurableIdAlignment === true,
      );
      return {
        ...state,
        messages,
        pagination: action.pagination ?? state.pagination,
        markdownAugments: reconcileMarkdownAugmentMessageIds(
          state,
          messages,
          provider,
          action.codexStreamDurableIdAlignment === true,
        ),
        lastMessageId: findLastJsonlMessageId(messages),
        maxPersistedTimestampMs: updatePersistedTimestampWatermark(
          state.maxPersistedTimestampMs,
          taggedMessages,
        ),
      };
    }

    case "applyFinalMarkdownAugment": {
      const existing = state.markdownAugments[action.messageId];
      if (existing?.html === action.augment.html) {
        return state;
      }
      return {
        ...state,
        markdownAugments: {
          ...state.markdownAugments,
          [action.messageId]: action.augment,
        },
      };
    }
  }
}

export function reduceSessionDetailActions(
  actions: readonly SessionDetailAction[],
  initialState = createInitialSessionDetailState(),
): SessionDetailState {
  return actions.reduce(reduceSessionDetailState, initialState);
}
