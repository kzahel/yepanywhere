import { visibleIssueText } from "../services/issues/extract.js";
import type {
  ClaudeSessionEntry,
  CodexAsyncUserInputQuestion,
  CodexCompactedEntry,
  CodexCustomToolCallPayload,
  CodexEventMsgEntry,
  CodexFunctionCallPayload,
  CodexMessagePayload,
  CodexReasoningPayload,
  CodexResponseItemEntry,
  CodexSessionEntry,
  CodexUserTurnMessageProvenance,
  CodexWebSearchCallPayload,
  GeminiAssistantMessage,
  GeminiSessionMessage,
  GeminiUserMessage,
  OpenCodeSessionEntry,
  OpenCodeStoredPart,
} from "@yep-anywhere/shared";
import {
  CODEX_TOOL_CORRELATION_FIELD,
  createCodexToolCorrelation,
  getCodexResponseItemTurnId,
  getGeminiUserMessageText,
  getMessageContent,
  isConversationEntry,
  normalizeCodexAsyncUserInputQuestions,
} from "@yep-anywhere/shared";
import {
  isCodexCorrelationDebugEnabled,
  logCodexCorrelationDebug,
  summarizeCodexNormalizedMessage,
} from "../codex/correlationDebugLogger.js";
import {
  type CodexToolCallContext,
  canonicalizeCodexToolName,
  isCodexBackgroundProcessOutput,
  isCodexInterruptedToolOutput,
  normalizeCodexCommandExecutionOutput,
  normalizeCodexCustomToolInvocation,
  normalizeCodexToolInvocation,
  normalizeCodexToolOutputWithContext,
  parseCodexToolArguments,
} from "../codex/normalization.js";
import { formatCodexSubagentActivity } from "../codex/subagentActivity.js";
import { attachToolResultMediaCandidates } from "../media/inlineImageData.js";
import { normalizeGeminiTool } from "../sdk/providers/gemini-tools.js";
import {
  normalizeOpenCodeTool,
  normalizeOpenCodeToolResult,
} from "../sdk/providers/opencode-tools.js";
import type { ContentBlock, Message, Session } from "../supervisor/types.js";
import { collectVisibleClaudeEntries } from "./claude-messages.js";
import {
  type CodexUserResponseKind,
  classifyCodexUserResponse,
  codexUserMessageEventClientId,
  codexUserMessageEventItemId,
  codexUserMessageEventText,
  isCodexUserMessageEventEntry,
  isCodexUserResponseEntry,
} from "./codex-user-turn-provenance.js";
import type { LoadedSession } from "./types.js";

interface CodexToolUseConversion {
  callId: string;
  message: Message;
  context: CodexToolCallContext;
}

const issueSourceIds = new WeakMap<Message, string>();
const CODEX_CONTEXT_COMPACTED_DEDUPE_WINDOW_MS = 5000;
const CODEX_PROVIDER_FORK_TURN_ID = Symbol("codexProviderForkTurnId");
const CODEX_NORMALIZATION_SOURCE = Symbol("codexNormalizationSource");
const CODEX_SOURCE_BYTE_OFFSET = Symbol("codexSourceByteOffset");
const CODEX_MESSAGE_SOURCE_BYTE_OFFSET = Symbol("codexMessageSourceByteOffset");

type CodexEntryWithSourceByteOffset = CodexSessionEntry & {
  [CODEX_SOURCE_BYTE_OFFSET]?: number;
};

type MessageWithCodexSourceByteOffset = Message & {
  [CODEX_MESSAGE_SOURCE_BYTE_OFFSET]?: number;
};

/** Keep plain-rollout message identities stable across bounded and full reads. */
export function tagCodexEntrySourceByteOffset(
  entry: CodexSessionEntry,
  sourceByteOffset: number,
): CodexSessionEntry {
  Object.defineProperty(entry, CODEX_SOURCE_BYTE_OFFSET, {
    configurable: false,
    enumerable: false,
    value: sourceByteOffset,
    writable: false,
  });
  return entry;
}

function tagCodexMessageSourceByteOffset(
  message: Message,
  entry: CodexSessionEntry,
): Message {
  const sourceByteOffset = (entry as CodexEntryWithSourceByteOffset)[
    CODEX_SOURCE_BYTE_OFFSET
  ];
  const ordinal = (entry as { ordinal?: unknown }).ordinal;
  if (Number.isSafeInteger(ordinal))
    issueSourceIds.set(message, `codex-ordinal-${ordinal}`);
  else if (sourceByteOffset !== undefined)
    issueSourceIds.set(message, `codex-byte-${sourceByteOffset}`);
  if (sourceByteOffset === undefined) return message;
  Object.defineProperty(message, CODEX_MESSAGE_SOURCE_BYTE_OFFSET, {
    configurable: false,
    enumerable: false,
    value: sourceByteOffset,
    writable: false,
  });
  return message;
}

function codexEntryPosition(
  entry: CodexSessionEntry,
  fallbackIndex: number,
): string {
  const sourceByteOffset = (entry as CodexEntryWithSourceByteOffset)[
    CODEX_SOURCE_BYTE_OFFSET
  ];
  return sourceByteOffset === undefined
    ? String(fallbackIndex)
    : `byte-${sourceByteOffset}`;
}

/** Recover the plain-rollout byte cursor carried by bounded-history paging. */
export function parseCodexSourceByteCursor(cursor: string): number | null {
  const match = /^codex-(?:compacted|cursor)-byte-(\d+)(?:-|$)/.exec(cursor);
  if (!match?.[1]) return null;
  const sourceByteOffset = Number(match[1]);
  return Number.isSafeInteger(sourceByteOffset) && sourceByteOffset >= 0
    ? sourceByteOffset
    : null;
}

/**
 * Return a source cursor for the first visible Codex message in a bounded read.
 * Compact boundaries retain their real message id; narrower turn windows use an
 * opaque cursor so durable message identity remains unchanged.
 */
export function getCodexMessageSourceByteCursor(
  message: Message,
): string | undefined {
  const sourceByteOffset = (message as MessageWithCodexSourceByteOffset)[
    CODEX_MESSAGE_SOURCE_BYTE_OFFSET
  ];
  if (sourceByteOffset === undefined) return undefined;

  const messageId =
    message.uuid ?? (typeof message.id === "string" ? message.id : undefined);
  return messageId && parseCodexSourceByteCursor(messageId) === sourceByteOffset
    ? messageId
    : `codex-cursor-byte-${sourceByteOffset}`;
}

type MessageWithCodexForkTurnId = Message & {
  [CODEX_PROVIDER_FORK_TURN_ID]?: string;
};

interface CodexNormalizationSource {
  source: object;
  entries: readonly CodexSessionEntry[];
}

type CodexEntriesWithNormalizationSource = CodexSessionEntry[] & {
  [CODEX_NORMALIZATION_SOURCE]?: CodexNormalizationSource;
};

/** Read server-only Codex turn identity retained during rollout normalization. */
export function getCodexProviderForkTurnId(message: Message): string | null {
  return (
    (message as MessageWithCodexForkTurnId)[CODEX_PROVIDER_FORK_TURN_ID] ?? null
  );
}

function attachCodexProviderForkTurnId(
  message: Message,
  turnId: string | null,
): void {
  if (!turnId) return;
  Object.defineProperty(message, CODEX_PROVIDER_FORK_TURN_ID, {
    configurable: false,
    enumerable: false,
    value: turnId,
    writable: false,
  });
}
interface CodexConversionState {
  messageIndex: number;
  hasUserMessageEvents: boolean;
  toolCallContexts: Map<string, CodexToolCallContext>;
  toolUseMessages: Map<string, Message>;
  closedToolResultIds: Set<string>;
  openToolUses: Map<string, Message>;
  compactedTimestampMs: number[];
  messagePositions: WeakMap<Message, number>;
}

interface CodexMessageCacheEntry {
  length: number;
  firstEntry: CodexSessionEntry | undefined;
  lastEntry: CodexSessionEntry | undefined;
  messages: Message[];
  state: CodexConversionState;
}

const codexMessageCache = new WeakMap<object, CodexMessageCacheEntry>();

/**
 * Preserve one normalization identity across defensive copies of an accepted
 * reader snapshot. Structurally mutated copies stop matching its entry sequence.
 */
export function tagCodexEntriesNormalizationSource(
  entries: CodexSessionEntry[],
  source: object,
  sourceEntries: readonly CodexSessionEntry[],
): CodexSessionEntry[] {
  Object.defineProperty(entries, CODEX_NORMALIZATION_SOURCE, {
    configurable: false,
    enumerable: false,
    value: {
      source,
      entries: sourceEntries,
    } satisfies CodexNormalizationSource,
    writable: false,
  });
  return entries;
}

function getCodexMessageCacheKey(entries: CodexSessionEntry[]): object {
  const tagged = (entries as CodexEntriesWithNormalizationSource)[
    CODEX_NORMALIZATION_SOURCE
  ];
  if (tagged && tagged.entries.length === entries.length) {
    for (let index = 0; index < entries.length; index += 1) {
      if (tagged.entries[index] !== entries[index]) return entries;
    }
    return tagged.source;
  }
  return entries;
}

// Keyed by the reader's cache-stable entries array (claude-transcript-cache):
// an unchanged transcript skips DAG rebuild + per-message conversion, and
// eviction of the parsed transcript releases this copy via WeakMap semantics.
const claudeMessageCache = new WeakMap<
  ClaudeSessionEntry[],
  {
    length: number;
    lastEntry: ClaudeSessionEntry | undefined;
    messages: Message[];
  }
>();

function normalizeClaudeQueueOperationContent(content: unknown): string {
  if (content === undefined) {
    return "";
  }

  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((item) => {
      if (typeof item === "string") {
        return item;
      }

      if (!item || typeof item !== "object") {
        return "";
      }

      const type = (item as { type?: unknown }).type;
      if (type === "text") {
        const text = (item as { text?: unknown }).text;
        return typeof text === "string" ? text : "";
      }
      if (type === "image") return "[Image]";
      if (type === "document") return "[Document]";
      if (type === "tool_result") return "[Tool Result]";

      return "";
    })
    .join("\n");
}

/** Normalize a bounded provider acquisition using the existing presentation rules. */
export function normalizeConversationEntries(
  input:
    | { provider: "claude"; entries: ClaudeSessionEntry[] }
    | { provider: "codex"; entries: CodexSessionEntry[] },
  sessionId: string,
): Message[] {
  if (input.provider === "codex")
    return convertCodexEntries(input.entries, sessionId);
  const { entries, orphanedToolUses } = collectVisibleClaudeEntries(
    input.entries,
  );
  return entries.map((raw, index) =>
    convertClaudeMessage(raw, index, orphanedToolUses),
  );
}

/**
 * Normalize a UnifiedSession into the generic Session format expected by the frontend.
 */
export function normalizeSession(loaded: LoadedSession): Session {
  const { summary, data } = loaded;

  switch (data.provider) {
    case "claude":
    case "claude-gateway":
    case "claude-ollama": {
      const rawMessages = data.session.messages;
      const lastEntry = rawMessages[rawMessages.length - 1];
      const cached = claudeMessageCache.get(rawMessages);
      if (
        cached &&
        cached.length === rawMessages.length &&
        cached.lastEntry === lastEntry
      ) {
        return {
          ...summary,
          messages: cached.messages,
        };
      }

      const { entries, orphanedToolUses } =
        collectVisibleClaudeEntries(rawMessages);
      const messages: Message[] = entries.map((raw, index) =>
        convertClaudeMessage(raw, index, orphanedToolUses),
      );

      claudeMessageCache.set(rawMessages, {
        length: rawMessages.length,
        lastEntry,
        messages,
      });
      return {
        ...summary,
        messages,
      };
    }
    case "codex":
    case "codex-oss":
      return {
        ...summary,
        messages: convertCodexEntries(data.session.entries, summary.id),
      };
    case "gemini":
      return {
        ...summary,
        messages: convertGeminiMessages(data.session.messages),
      };
    case "grok":
      return {
        ...summary,
        messages: data.session.messages as Message[],
      };
    case "pi":
      // pi messages are already normalized YA messages (PiSessionReader maps
      // the v3 JSONL tree), like grok — pass through.
      return {
        ...summary,
        messages: data.session.messages as Message[],
      };
    case "opencode":
      return {
        ...summary,
        messages: convertOpenCodeEntries(data.session.messages),
      };
  }
}

/**
 * Detach the selected response window from provider-reader and normalization
 * caches before route-specific augmentation mutates nested message blocks.
 */
export function detachSessionMessageProjection(messages: Message[]): Message[] {
  return structuredClone(messages);
}

// --- Claude Conversion Logic ---

function convertClaudeMessage(
  raw: ClaudeSessionEntry,
  _index: number,
  orphanedToolUses: Set<string>,
): Message {
  if (raw.type === "queue-operation" && raw.operation === "enqueue") {
    const content = normalizeClaudeQueueOperationContent(raw.content).trim();
    const rawAny = raw as Record<string, unknown>;

    return {
      ...rawAny,
      id: `queue-operation-${_index}-${raw.timestamp}`,
      type: "user",
      role: "user",
      content,
      message: {
        role: "user",
        content,
      },
      deferred: true,
      deferredSource: "queue-operation",
    };
  }

  // Normalize content blocks - pass through all fields
  let content: string | ContentBlock[] | undefined;
  const rawContent = getMessageContent(raw);
  if (typeof rawContent === "string") {
    content = rawContent;
  } else if (Array.isArray(rawContent)) {
    // Pass through all fields from each content block
    // Filter out string items (which can appear in user message content)
    content = rawContent
      .filter((block) => typeof block !== "string")
      .map((block) => ({ ...(block as object) })) as ContentBlock[];
  }

  // Build message by spreading all raw fields, then override with normalized values
  // Use type assertion since we're converting to a looser Message type
  const rawAny = raw as Record<string, unknown>;
  const message: Message = {
    ...rawAny,
    // Include normalized content if message had content
    ...(isConversationEntry(raw) && {
      message: {
        ...(raw.message as Record<string, unknown>),
        ...(content !== undefined && { content }),
      },
    }),
    // Ensure type is set
    type: raw.type,
  };

  // Identify orphaned tool_use IDs in this message's content
  if (Array.isArray(content)) {
    const orphanedIds = content
      .filter(
        (b): b is ContentBlock & { id: string } =>
          b.type === "tool_use" &&
          typeof b.id === "string" &&
          orphanedToolUses.has(b.id),
      )
      .map((b) => b.id);

    if (orphanedIds.length > 0) {
      message.orphanedToolUseIds = orphanedIds;
    }
  }

  return message;
}

// --- Codex Conversion Logic ---

function convertCodexEntries(
  entries: CodexSessionEntry[],
  sessionId: string,
): Message[] {
  const cacheKey = getCodexMessageCacheKey(entries);
  const cached = codexMessageCache.get(cacheKey);
  const firstEntry = entries[0];
  const lastEntry = entries[entries.length - 1];
  if (
    cached &&
    cached.length === entries.length &&
    cached.firstEntry === firstEntry &&
    cached.lastEntry === lastEntry
  ) {
    return cached.messages;
  }

  const appendStart = cached ? codexAppendStart(cached, entries) : undefined;
  const incremental = appendStart !== undefined && cached !== undefined;
  const appendProjection = incremental
    ? cloneCodexAppendProjection(cached)
    : undefined;
  const messages = appendProjection?.messages ?? [];
  const state = appendProjection?.state ?? createCodexConversionState(entries);
  if (incremental && appendStart < cached.length) {
    state.messageIndex -= 1;
  }

  for (
    let entryIndex = appendStart ?? 0;
    entryIndex < entries.length;
    entryIndex += 1
  ) {
    const entry = entries[entryIndex];
    if (!entry) continue;
    const previousEntry = entries[entryIndex - 1];
    const nextEntry = entries[entryIndex + 1];
    const userResponseKind = isCodexUserResponseEntry(entry)
      ? classifyCodexUserResponse(entry, nextEntry, state.hasUserMessageEvents)
      : undefined;
    const pairedUserEvent =
      isCodexUserMessageEventEntry(entry) &&
      isCodexUserResponseEntry(previousEntry);

    if (
      isCodexToolLifecycleBoundary(entry, userResponseKind, pairedUserEvent)
    ) {
      markOpenCodexToolUsesOrphaned(state.openToolUses);
    }

    if (entry.type === "response_item") {
      const clientUserMessageId = isCodexUserResponseEntry(entry)
        ? isCodexUserMessageEventEntry(nextEntry)
          ? codexUserMessageEventClientId(nextEntry)
          : undefined
        : undefined;
      const msg = convertCodexResponseItem(
        entry,
        state.messageIndex++,
        state.toolCallContexts,
        state.toolUseMessages,
        state.closedToolResultIds,
        userResponseKind,
        clientUserMessageId,
      );
      if (msg) {
        tagCodexMessageSourceByteOffset(msg, entry);
        attachCodexProviderForkTurnId(
          msg,
          getCodexResponseItemTurnId(entry.payload),
        );
        if (isCodexCorrelationDebugEnabled()) {
          logCodexCorrelationDebug({
            sessionId,
            channel: "jsonl",
            authority: "durable",
            entryType: entry.type,
            payloadType: entry.payload.type,
            eventKind: getCodexResponseEventKind(entry.payload),
            callId: getCodexResponsePayloadCallId(entry.payload),
            itemId: getCodexResponsePayloadItemId(entry.payload),
            ...summarizeCodexNormalizedMessage(msg),
          });
        }
        messages.push(msg);
        state.messagePositions.set(msg, messages.length - 1);
        observeCodexToolLifecycleMessage(msg, state.openToolUses);
      }
    } else if (entry.type === "compacted") {
      const msg = convertCodexCompactedEntry(entry, state.messageIndex++);
      if (msg) {
        tagCodexMessageSourceByteOffset(msg, entry);
        if (isCodexCorrelationDebugEnabled()) {
          logCodexCorrelationDebug({
            sessionId,
            channel: "jsonl",
            authority: "durable",
            entryType: entry.type,
            eventKind: "context_compacted",
            ...summarizeCodexNormalizedMessage(msg),
          });
        }
        messages.push(msg);
        state.messagePositions.set(msg, messages.length - 1);
        observeCodexToolLifecycleMessage(msg, state.openToolUses);
      }
    } else if (entry.type === "event_msg") {
      attachCodexCodeModeCommandExecution(
        entry.payload,
        state.toolCallContexts,
        state.openToolUses,
      );
      if (entry.payload.type === "patch_apply_end") {
        attachCodexCodeModePatchResult(entry.payload, state.toolCallContexts);
      }
      const duplicateContextCompacted = isDuplicateCodexContextCompactedEvent(
        entry,
        state.compactedTimestampMs,
      );
      const shouldIncludeUserMessage =
        isCodexUserMessageEventEntry(entry) && !pairedUserEvent;
      const shouldIncludeAsyncAgentMessage =
        getCodexAsyncAgentMessageItem(entry) !== null;
      const shouldIncludeTaskComplete = entry.payload.type === "task_complete";
      const shouldIncludeTurnAborted = entry.payload.type === "turn_aborted";
      const shouldIncludeSubagentActivity =
        entry.payload.type === "sub_agent_activity";
      const shouldIncludeContextCompacted =
        entry.payload.type === "context_compacted" &&
        !duplicateContextCompacted;
      const shouldIncludeExecCommandEnd = isCodexExecCommandEndPayload(
        entry.payload,
      );
      // Ordinary agent/reasoning events duplicate full response items. The
      // canonical completed item is the standalone async-message record.
      if (
        shouldIncludeUserMessage ||
        shouldIncludeAsyncAgentMessage ||
        shouldIncludeTaskComplete ||
        shouldIncludeTurnAborted ||
        shouldIncludeSubagentActivity ||
        shouldIncludeContextCompacted ||
        shouldIncludeExecCommandEnd
      ) {
        const eventMessageIndex = state.messageIndex;
        // The turn-based completion ID must not renumber later positional IDs.
        if (!shouldIncludeTaskComplete) {
          state.messageIndex++;
        }
        const msg = convertCodexEventMsg(
          entry,
          eventMessageIndex,
          state.toolCallContexts,
          state.toolUseMessages,
          state.closedToolResultIds,
          sessionId,
        );
        if (msg) {
          tagCodexMessageSourceByteOffset(msg, entry);
          if (isCodexCorrelationDebugEnabled()) {
            logCodexCorrelationDebug({
              sessionId,
              channel: "jsonl",
              authority: "durable",
              entryType: entry.type,
              payloadType: entry.payload.type,
              eventKind: entry.payload.type,
              turnId: getCodexEventPayloadTurnId(entry.payload),
              itemId: getCodexEventPayloadItemId(entry.payload),
              ...summarizeCodexNormalizedMessage(msg),
            });
          }
          messages.push(msg);
          state.messagePositions.set(msg, messages.length - 1);
          observeCodexToolLifecycleMessage(msg, state.openToolUses);
        }
      } else if (duplicateContextCompacted) {
        // This event would previously have consumed a normalized message index.
        // Keep that gap so later Codex message IDs remain stable while the
        // duplicate compact boundary stops rendering and paginating.
        state.messageIndex++;
      }
    }
  }

  codexMessageCache.set(cacheKey, {
    length: entries.length,
    firstEntry,
    lastEntry,
    messages,
    state,
  });
  return messages;
}

function createCodexConversionState(
  entries: readonly CodexSessionEntry[],
): CodexConversionState {
  return {
    messageIndex: 0,
    hasUserMessageEvents: entries.some((entry) =>
      isCodexUserMessageEventEntry(entry),
    ),
    toolCallContexts: new Map(),
    toolUseMessages: new Map(),
    closedToolResultIds: new Set(),
    openToolUses: new Map(),
    compactedTimestampMs: collectCodexCompactedTimestampMs(entries),
    messagePositions: new WeakMap(),
  };
}

function codexAppendStart(
  cached: CodexMessageCacheEntry,
  entries: readonly CodexSessionEntry[],
): number | undefined {
  if (
    cached.length >= entries.length ||
    cached.firstEntry !== entries[0] ||
    cached.lastEntry !== entries[cached.length - 1]
  ) {
    return undefined;
  }

  for (let index = cached.length; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) continue;
    if (entry.type === "compacted") {
      return undefined;
    }
    if (
      !cached.state.hasUserMessageEvents &&
      isCodexUserMessageEventEntry(entry)
    ) {
      return undefined;
    }
  }

  const previousLast = entries[cached.length - 1];
  const firstAppended = entries[cached.length];
  if (
    cached.state.hasUserMessageEvents &&
    isCodexUserResponseEntry(previousLast) &&
    isCodexUserMessageEventEntry(firstAppended)
  ) {
    return cached.length - 1;
  }
  return cached.length;
}

function cloneCodexAppendProjection(cached: CodexMessageCacheEntry): {
  messages: Message[];
  state: CodexConversionState;
} {
  const messages = cached.messages.slice();
  const messagePositions = new WeakMap<Message, number>();
  const clonedMessages = new Map<Message, Message>();

  const cloneStateMessage = (message: Message): Message => {
    const existing = clonedMessages.get(message);
    if (existing) return existing;
    const position = cached.state.messagePositions.get(message);
    if (position === undefined) {
      throw new Error("Missing Codex normalization state message position");
    }
    const cloned = cloneCodexStateMessage(message);
    messages[position] = cloned;
    messagePositions.set(cloned, position);
    clonedMessages.set(message, cloned);
    return cloned;
  };

  const toolUseMessages = new Map<string, Message>();
  for (const [callId, message] of cached.state.toolUseMessages) {
    toolUseMessages.set(callId, cloneStateMessage(message));
  }
  const openToolUses = new Map<string, Message>();
  for (const [callId, message] of cached.state.openToolUses) {
    openToolUses.set(callId, cloneStateMessage(message));
  }

  const toolCallContexts = new Map<string, CodexToolCallContext>();
  for (const [callId, context] of cached.state.toolCallContexts) {
    const message = toolUseMessages.get(callId);
    const input = message
      ? findCodexToolUseInput(message, callId)
      : cloneCodexToolInput(context.input);
    toolCallContexts.set(callId, { ...context, input });
  }

  return {
    messages,
    state: {
      messageIndex: cached.state.messageIndex,
      hasUserMessageEvents: cached.state.hasUserMessageEvents,
      toolCallContexts,
      toolUseMessages,
      closedToolResultIds: new Set(cached.state.closedToolResultIds),
      openToolUses,
      compactedTimestampMs: cached.state.compactedTimestampMs,
      messagePositions,
    },
  };
}

function cloneCodexStateMessage(message: Message): Message {
  const content = message.message?.content;
  const cloned: Message = {
    ...message,
    ...(message.orphanedToolUseIds
      ? { orphanedToolUseIds: [...message.orphanedToolUseIds] }
      : {}),
    ...(message.message
      ? {
          message: {
            ...message.message,
            ...(Array.isArray(content)
              ? {
                  content: content.map((block) =>
                    block.type === "tool_use"
                      ? { ...block, input: cloneCodexToolInput(block.input) }
                      : block,
                  ),
                }
              : {}),
          },
        }
      : {}),
  };
  const sourceByteOffset = (message as MessageWithCodexSourceByteOffset)[
    CODEX_MESSAGE_SOURCE_BYTE_OFFSET
  ];
  if (sourceByteOffset !== undefined) {
    Object.defineProperty(cloned, CODEX_MESSAGE_SOURCE_BYTE_OFFSET, {
      configurable: false,
      enumerable: false,
      value: sourceByteOffset,
      writable: false,
    });
  }
  attachCodexProviderForkTurnId(cloned, getCodexProviderForkTurnId(message));
  return cloned;
}

function cloneCodexToolInput(input: unknown): unknown {
  return isRecord(input) ? { ...input } : input;
}

function findCodexToolUseInput(message: Message, callId: string): unknown {
  const content = message.message?.content;
  if (!Array.isArray(content)) return undefined;
  return content.find(
    (block) => block.type === "tool_use" && block.id === callId,
  )?.input;
}

/** Native nested executions have their own IDs, not the outer exec call ID.
 * Only associate a single exact command in the same turn with one open Bash
 * call. Ambiguous/missing evidence must not turn arbitrary stdout into status.
 */
function attachCodexCodeModeCommandExecution(
  payload: CodexEventMsgEntry["payload"],
  contexts: Map<string, CodexToolCallContext>,
  openToolUses: Map<string, Message>,
): void {
  // Without a native parent ID, concurrent tool calls make attribution ambiguous.
  if (openToolUses.size !== 1) return;
  if (payload.type !== "item_completed" || typeof payload.turn_id !== "string")
    return;
  const item = payload.item;
  if (
    !isRecord(item) ||
    item.type !== "CommandExecution" ||
    typeof item.id !== "string" ||
    (item.status !== "completed" && item.status !== "failed") ||
    !Array.isArray(item.parsed_cmd) ||
    item.parsed_cmd.length !== 1
  )
    return;
  const command = item.parsed_cmd[0];
  if (!isRecord(command) || typeof command.cmd !== "string") return;
  if (
    item.exit_code != null &&
    (typeof item.exit_code !== "number" || !Number.isInteger(item.exit_code))
  )
    return;
  const callId = openToolUses.keys().next().value;
  const context = callId ? contexts.get(callId) : undefined;
  if (
    context?.toolName !== "Bash" ||
    context.codeModeTurnId !== payload.turn_id ||
    !isRecord(context.input) ||
    context.input.command !== command.cmd ||
    context.commandExecution === null
  )
    return;
  if (context.commandExecution && context.commandExecution.itemId !== item.id) {
    context.commandExecution = null;
    return;
  }
  context.commandExecution = {
    itemId: item.id,
    status: item.status,
    ...(typeof item.exit_code === "number" ? { exitCode: item.exit_code } : {}),
  };
}

function attachCodexCodeModePatchResult(
  payload: Extract<CodexEventMsgEntry["payload"], { type: "patch_apply_end" }>,
  toolCallContexts: Map<string, CodexToolCallContext>,
): void {
  const candidates = [...toolCallContexts.values()].filter(
    (context) =>
      context.toolName === "Edit" &&
      isRecord(context.input) &&
      typeof context.input._rawPatch === "string" &&
      context.patchApplyResult === undefined,
  );
  if (candidates.length !== 1) return;

  const context = candidates[0];
  if (!context || !isRecord(context.input)) return;
  context.patchApplyResult = {
    success: payload.success,
    ...(payload.stdout ? { stdout: payload.stdout } : {}),
    ...(payload.stderr ? { stderr: payload.stderr } : {}),
  };
  if (payload.changes) {
    context.input.changes = Object.entries(payload.changes).map(
      ([path, change]) =>
        isRecord(change) ? { path, ...change } : { path, change },
    );
  }
}

function isCodexToolLifecycleBoundary(
  entry: CodexSessionEntry,
  userResponseKind: CodexUserResponseKind | undefined,
  pairedUserEvent: boolean,
): boolean {
  if (isCodexUserResponseEntry(entry)) {
    return (
      userResponseKind === "user-authored" ||
      userResponseKind === "legacy-unknown"
    );
  }

  if (entry.type !== "event_msg") {
    return false;
  }

  return (
    (isCodexUserMessageEventEntry(entry) && !pairedUserEvent) ||
    entry.payload.type === "task_started" ||
    entry.payload.type === "task_complete" ||
    entry.payload.type === "turn_aborted" ||
    entry.payload.type === "context_compacted"
  );
}

function collectCodexCompactedTimestampMs(
  entries: readonly CodexSessionEntry[],
): number[] {
  const timestamps: number[] = [];
  for (const entry of entries) {
    if (entry.type !== "compacted") {
      continue;
    }
    const timestampMs = Date.parse(entry.timestamp);
    if (Number.isFinite(timestampMs)) {
      timestamps.push(timestampMs);
    }
  }
  return timestamps;
}

function isDuplicateCodexContextCompactedEvent(
  entry: CodexEventMsgEntry,
  compactedTimestampMs: readonly number[],
): boolean {
  if (entry.payload.type !== "context_compacted") {
    return false;
  }

  const eventTimestampMs = Date.parse(entry.timestamp);
  if (!Number.isFinite(eventTimestampMs)) {
    return false;
  }

  return compactedTimestampMs.some((compactedMs) => {
    return (
      compactedMs <= eventTimestampMs &&
      eventTimestampMs - compactedMs <= CODEX_CONTEXT_COMPACTED_DEDUPE_WINDOW_MS
    );
  });
}

function observeCodexToolLifecycleMessage(
  message: Message,
  openToolUses: Map<string, Message>,
): void {
  const content = message.message?.content;
  if (!Array.isArray(content)) {
    return;
  }

  for (const block of content) {
    if (block.type === "tool_use" && block.id) {
      openToolUses.set(block.id, message);
      continue;
    }
    if (block.type === "tool_result" && block.tool_use_id) {
      if (
        isCodexBackgroundProcessOutput(block.content) ||
        isCodexInterruptedToolOutput(block.content)
      ) {
        continue;
      }
      openToolUses.delete(block.tool_use_id);
    }
  }
}

function markOpenCodexToolUsesOrphaned(
  openToolUses: Map<string, Message>,
): void {
  for (const [toolUseId, message] of openToolUses) {
    const orphaned = new Set(message.orphanedToolUseIds ?? []);
    orphaned.add(toolUseId);
    message.orphanedToolUseIds = Array.from(orphaned);
    openToolUses.delete(toolUseId);
  }
}

function getCodexResponseEventKind(
  payload: CodexResponseItemEntry["payload"],
): string {
  if (payload.type === "message") {
    return payload.role === "assistant" ? "assistant_message" : "user_message";
  }
  return payload.type;
}

function getCodexResponsePayloadCallId(
  payload: CodexResponseItemEntry["payload"],
): string | undefined {
  switch (payload.type) {
    case "function_call":
    case "function_call_output":
      return payload.call_id;
    case "custom_tool_call":
    case "custom_tool_call_output":
    case "web_search_call":
      return typeof payload.call_id === "string"
        ? payload.call_id
        : typeof payload.id === "string"
          ? payload.id
          : undefined;
    default:
      return undefined;
  }
}

function getCodexResponsePayloadItemId(
  payload: CodexResponseItemEntry["payload"],
): string | undefined {
  switch (payload.type) {
    case "function_call":
    case "function_call_output":
      return payload.call_id;
    case "custom_tool_call":
    case "custom_tool_call_output":
    case "web_search_call":
      return typeof payload.id === "string"
        ? payload.id
        : typeof payload.call_id === "string"
          ? payload.call_id
          : undefined;
    default:
      return undefined;
  }
}

function getCodexEventPayloadTurnId(
  payload: CodexEventMsgEntry["payload"],
): string | undefined {
  return "turn_id" in payload && typeof payload.turn_id === "string"
    ? payload.turn_id
    : undefined;
}

function getCodexEventPayloadItemId(
  payload: CodexEventMsgEntry["payload"],
): string | undefined {
  if (payload.type !== "item_completed") {
    return undefined;
  }

  if (!payload.item || typeof payload.item !== "object") {
    return undefined;
  }

  const item = payload.item as { id?: unknown };
  return typeof item.id === "string" ? item.id : undefined;
}

// Derive the durable message uuid for a Codex response item. Calls and outputs
// key on the globally-unique call_id. Native live tool items share that id;
// nested code-mode commandExecution items do not, so their scoped client
// reconciliation adopts this durable identity. Messages and reasoning use the
// persisted response-item id. A paired user turn prefers the client id that
// Codex persisted from turn/start or turn/steer.
function codexDurableResponseItemUuid(
  payload: CodexResponseItemEntry["payload"],
  positionalUuid: string,
  clientUserMessageId?: string,
): string {
  switch (payload.type) {
    case "message":
      return clientUserMessageId || payload.id || positionalUuid;
    case "reasoning":
      return payload.id || positionalUuid;
    case "function_call":
      return payload.call_id;
    case "function_call_output":
      return payload.call_id
        ? `${payload.call_id}-result`
        : payload.id || positionalUuid;
    case "custom_tool_call":
    case "web_search_call":
      return payload.call_id ?? payload.id ?? positionalUuid;
    case "custom_tool_call_output":
      return payload.call_id ? `${payload.call_id}-result` : positionalUuid;
    default:
      return positionalUuid;
  }
}

function convertCodexResponseItem(
  entry: CodexResponseItemEntry,
  index: number,
  toolCallContexts: Map<string, CodexToolCallContext>,
  toolUseMessages: Map<string, Message>,
  closedToolResultIds: Set<string>,
  userResponseKind?: CodexUserResponseKind,
  clientUserMessageId?: string,
): Message | null {
  const payload = entry.payload;
  const positionalUuid = `codex-${codexEntryPosition(entry, index)}-${entry.timestamp}`;
  const uuid = codexDurableResponseItemUuid(
    payload,
    positionalUuid,
    clientUserMessageId,
  );

  switch (payload.type) {
    case "message":
      if (payload.role === "developer") {
        return null;
      }
      if (
        userResponseKind === "hidden-provider-context" ||
        userResponseKind === "visible-provider-context"
      ) {
        return null;
      }
      return convertCodexMessagePayload(
        payload,
        uuid,
        entry.timestamp,
        userResponseKind === "user-authored"
          ? "paired"
          : userResponseKind === "legacy-unknown"
            ? "legacy-response"
            : undefined,
      );

    case "reasoning":
      return convertCodexReasoningPayload(payload, uuid, entry.timestamp);

    case "function_call": {
      const converted = convertCodexFunctionCallPayload(
        payload,
        uuid,
        entry.timestamp,
      );
      toolCallContexts.set(converted.callId, converted.context);
      const turnId = getCodexResponseItemTurnId(payload);
      const message = turnId
        ? {
            ...converted.message,
            [CODEX_TOOL_CORRELATION_FIELD]: createCodexToolCorrelation(
              "function_call",
              turnId,
              converted.callId,
            ),
          }
        : converted.message;
      toolUseMessages.set(converted.callId, message);
      return message;
    }

    case "function_call_output": {
      if (!payload.call_id) {
        return convertStandaloneCodexToolOutputPayload(
          payload.name,
          payload.namespace,
          payload.output,
          uuid,
          entry.timestamp,
        );
      }
      if (closedToolResultIds.has(payload.call_id)) {
        return null;
      }
      const message = convertCodexToolCallOutputPayload(
        payload.call_id,
        payload.output,
        uuid,
        entry.timestamp,
        toolCallContexts.get(payload.call_id),
      );
      if (
        !isCodexBackgroundProcessOutput(payload.output) &&
        !isCodexInterruptedToolOutput(payload.output)
      ) {
        toolCallContexts.delete(payload.call_id);
        toolUseMessages.delete(payload.call_id);
        closedToolResultIds.add(payload.call_id);
      }
      const turnId = getCodexResponseItemTurnId(payload);
      return turnId
        ? {
            ...message,
            [CODEX_TOOL_CORRELATION_FIELD]: createCodexToolCorrelation(
              "function_call",
              turnId,
              payload.call_id,
            ),
          }
        : message;
    }

    case "custom_tool_call": {
      const converted = convertCodexCustomToolCallPayload(
        payload,
        uuid,
        entry.timestamp,
      );
      toolCallContexts.set(converted.callId, converted.context);
      toolUseMessages.set(converted.callId, converted.message);
      return converted.message;
    }

    case "custom_tool_call_output": {
      const customCallId = payload.call_id ?? `${uuid}-custom-tool-result`;
      if (closedToolResultIds.has(customCallId)) {
        return null;
      }
      const message = convertCodexToolCallOutputPayload(
        customCallId,
        payload.output,
        uuid,
        entry.timestamp,
        toolCallContexts.get(customCallId),
      );
      if (
        !isCodexBackgroundProcessOutput(payload.output) &&
        !isCodexInterruptedToolOutput(payload.output)
      ) {
        toolCallContexts.delete(customCallId);
        toolUseMessages.delete(customCallId);
        closedToolResultIds.add(customCallId);
      }
      const turnId = getCodexResponseItemTurnId(payload);
      return turnId
        ? {
            ...message,
            [CODEX_TOOL_CORRELATION_FIELD]: createCodexToolCorrelation(
              "custom_tool_call",
              turnId,
              customCallId,
            ),
          }
        : message;
    }

    case "web_search_call":
      return convertCodexWebSearchCallPayload(payload, uuid, entry.timestamp);

    case "ghost_snapshot":
      return null;

    default:
      return null;
  }
}

function convertCodexMessagePayload(
  payload: CodexMessagePayload,
  uuid: string,
  timestamp: string,
  userTurnProvenance?: Exclude<CodexUserTurnMessageProvenance, "event-only">,
): Message {
  const content: ContentBlock[] = [];

  const fullText = payload.content
    .map((block) =>
      "text" in block && typeof block.text === "string" ? block.text : "",
    )
    .join("");
  if (fullText.trim()) {
    content.push({
      type: "text",
      text: fullText,
    });
  }

  for (const block of payload.content) {
    if (block.type !== "input_image") continue;
    content.push(normalizeCodexInputImageBlock(block));
  }

  if (content.length === 0) {
    return {
      uuid,
      type: payload.role,
      message: {
        role: payload.role,
        content: [],
      },
      ...(userTurnProvenance && {
        codexUserTurnProvenance: userTurnProvenance,
      }),
      timestamp,
    };
  }

  return {
    uuid,
    type: payload.role,
    message: {
      role: payload.role,
      content,
    },
    ...(userTurnProvenance && {
      codexUserTurnProvenance: userTurnProvenance,
    }),
    timestamp,
  };
}

function convertCodexReasoningPayload(
  payload: CodexReasoningPayload,
  uuid: string,
  timestamp: string,
): Message | null {
  const summaryText = payload.summary
    ?.map((s) => s.text)
    .join("\n")
    .trim();

  if (summaryText) {
    return {
      uuid,
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: summaryText,
          },
        ],
      },
      timestamp,
    };
  }

  return null;
}

type CodexInputImageBlock = Extract<
  CodexMessagePayload["content"][number],
  { type: "input_image" }
>;

function normalizeCodexInputImageBlock(
  block: CodexInputImageBlock,
): ContentBlock {
  const normalized: ContentBlock = { type: "input_image" };

  const filePath =
    typeof block.file_path === "string" ? block.file_path.trim() : "";
  if (filePath) {
    normalized.file_path = filePath;
  }

  const mimeType = resolveCodexInputImageMimeType(block);
  if (mimeType) {
    normalized.mime_type = mimeType;
  }

  const imageUrl =
    typeof block.image_url === "string" ? block.image_url.trim() : "";
  if (imageUrl && !isDataUrl(imageUrl)) {
    normalized.image_url = imageUrl;
  }

  return normalized;
}

function resolveCodexInputImageMimeType(
  block: CodexInputImageBlock,
): string | undefined {
  const explicitMime =
    typeof block.mime_type === "string" ? block.mime_type.trim() : "";
  if (explicitMime) {
    return explicitMime;
  }

  if (typeof block.image_url !== "string") {
    return undefined;
  }

  const dataUrlMime = parseDataUrlMimeType(block.image_url);
  return dataUrlMime || undefined;
}

function isDataUrl(value: string): boolean {
  return value.startsWith("data:");
}

function parseDataUrlMimeType(dataUrl: string): string | null {
  const match = /^data:([^;,]+)[;,]/i.exec(dataUrl);
  return match?.[1] ?? null;
}

function convertCodexFunctionCallPayload(
  payload: CodexFunctionCallPayload,
  uuid: string,
  timestamp: string,
): CodexToolUseConversion {
  const rawToolName = payload.name;
  const canonicalToolName = canonicalizeCodexToolName(rawToolName);
  const parsedInput = parseCodexToolArguments(payload.arguments);
  const normalizedInvocation = normalizeCodexToolInvocation(
    canonicalToolName,
    parsedInput,
  );

  const content: ContentBlock[] = [
    {
      type: "tool_use",
      id: payload.call_id,
      name: normalizedInvocation.toolName,
      input: normalizedInvocation.input,
      ...(normalizedInvocation.displayActions
        ? { _displayActions: normalizedInvocation.displayActions }
        : {}),
    },
  ];

  const message: Message = {
    uuid,
    type: "assistant",
    message: {
      role: "assistant",
      content,
    },
    codexToolName: rawToolName,
    timestamp,
  };

  return {
    callId: payload.call_id,
    message,
    context: {
      toolName: normalizedInvocation.toolName,
      input: normalizedInvocation.input,
      readShellInfo: normalizedInvocation.readShellInfo,
      writeShellInfo: normalizedInvocation.writeShellInfo,
    },
  };
}

function convertCodexCustomToolCallPayload(
  payload: CodexCustomToolCallPayload,
  uuid: string,
  timestamp: string,
): CodexToolUseConversion {
  const callId = payload.call_id ?? payload.id ?? `${uuid}-custom-tool`;
  const rawToolName = payload.name ?? "custom_tool_call";
  const rawInput =
    payload.input !== undefined
      ? payload.input
      : parseCodexToolArguments(payload.arguments);
  const normalizedInvocation = normalizeCodexCustomToolInvocation(
    rawToolName,
    rawInput,
  );
  const turnId = getCodexResponseItemTurnId(payload);

  const content: ContentBlock[] = [
    {
      type: "tool_use",
      id: callId,
      name: normalizedInvocation.toolName,
      input: normalizedInvocation.input,
      ...(normalizedInvocation.displayActions
        ? { _displayActions: normalizedInvocation.displayActions }
        : {}),
    },
  ];

  const message: Message = {
    uuid,
    type: "assistant",
    message: {
      role: "assistant",
      content,
    },
    codexToolName: rawToolName,
    ...(turnId
      ? {
          [CODEX_TOOL_CORRELATION_FIELD]: createCodexToolCorrelation(
            "custom_tool_call",
            turnId,
            callId,
          ),
        }
      : {}),
    timestamp,
  };

  return {
    callId,
    message,
    context: {
      toolName: normalizedInvocation.toolName,
      input: normalizedInvocation.input,
      ...(rawToolName === "exec" && turnId ? { codeModeTurnId: turnId } : {}),
      readShellInfo: normalizedInvocation.readShellInfo,
      writeShellInfo: normalizedInvocation.writeShellInfo,
    },
  };
}

function convertCodexWebSearchCallPayload(
  payload: CodexWebSearchCallPayload,
  uuid: string,
  timestamp: string,
): Message {
  const callId = payload.call_id ?? payload.id ?? `${uuid}-web-search`;
  const rawToolName = payload.name ?? payload.type;
  const toolName = canonicalizeCodexToolName(rawToolName);

  const parsedArguments = parseCodexToolArguments(payload.arguments);
  let input: Record<string, unknown>;

  if (isRecord(payload.input)) {
    input = { ...payload.input };
  } else if (isRecord(parsedArguments)) {
    input = { ...parsedArguments };
  } else {
    input = {};
  }

  if (typeof payload.query === "string" && typeof input.query !== "string") {
    input.query = payload.query;
  }

  if (payload.action !== undefined && input.action === undefined) {
    input.action = payload.action;
  }

  const content: ContentBlock[] = [
    {
      type: "tool_use",
      id: callId,
      name: toolName,
      input,
    },
  ];

  return {
    uuid,
    type: "assistant",
    message: {
      role: "assistant",
      content,
    },
    codexToolName: rawToolName,
    timestamp,
  };
}

function convertCodexToolCallOutputPayload(
  callId: string,
  output: unknown,
  uuid: string,
  timestamp: string,
  context?: CodexToolCallContext,
): Message {
  const normalized = normalizeCodexToolOutputWithContext(output, context);
  const content = normalized.content;
  const structured = normalized.structured;
  const isError = normalized.isError;

  const toolResult: ContentBlock = {
    type: "tool_result",
    tool_use_id: callId,
    content,
    ...(isError && { is_error: true }),
  };

  const message: Message = {
    uuid,
    type: "user",
    message: {
      role: "user",
      content: [toolResult],
    },
    ...(structured !== undefined && {
      toolUseResult: structured,
    }),
    timestamp,
  };
  attachToolResultMediaCandidates(message, normalized.mediaCandidates);
  return message;
}

function convertStandaloneCodexToolOutputPayload(
  name: string | undefined,
  namespace: string | undefined,
  output: unknown,
  uuid: string,
  timestamp: string,
): Message {
  const normalized = normalizeCodexToolOutputWithContext(output);
  const message: Message = {
    uuid,
    type: "system",
    subtype: "tool_output",
    content: normalized.content,
    ...(name ? { codexToolName: name } : {}),
    ...(namespace ? { codexToolNamespace: namespace } : {}),
    ...(normalized.structured !== undefined
      ? { toolUseResult: normalized.structured }
      : {}),
    timestamp,
  };
  attachToolResultMediaCandidates(message, normalized.mediaCandidates);
  return message;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export interface CodexAsyncAgentMessageItem {
  id: string;
  text: string;
  questions?: CodexAsyncUserInputQuestion[];
}

/** Read the canonical persisted form of a Codex asynchronous agent message. */
export function getCodexAsyncAgentMessageItem(
  entry: CodexSessionEntry | undefined,
): CodexAsyncAgentMessageItem | null {
  if (entry?.type !== "event_msg" || entry.payload.type !== "item_completed") {
    return null;
  }
  const item = entry.payload.item;
  if (
    !isRecord(item) ||
    item.type !== "AgentMessage" ||
    item.delivery !== "async" ||
    typeof item.id !== "string" ||
    !Array.isArray(item.content)
  ) {
    return null;
  }

  const textParts: string[] = [];
  for (const content of item.content) {
    if (
      !isRecord(content) ||
      content.type !== "Text" ||
      typeof content.text !== "string"
    ) {
      return null;
    }
    textParts.push(content.text);
  }

  const questions = normalizeCodexAsyncUserInputQuestions(item.questions);
  if (item.questions !== undefined && !questions) return null;

  return {
    id: item.id,
    text: textParts.join(""),
    ...(item.questions !== undefined ? { questions } : {}),
  };
}

function getStringField(
  record: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = record[field];
  return typeof value === "string" ? value : undefined;
}

function getNumberField(
  record: Record<string, unknown>,
  field: string,
): number | undefined {
  const value = record[field];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function isCodexExecCommandEndPayload(payload: unknown): payload is Record<
  string,
  unknown
> & {
  type: "exec_command_end";
  call_id: string;
} {
  return (
    isRecord(payload) &&
    payload.type === "exec_command_end" &&
    typeof payload.call_id === "string"
  );
}

function convertCodexExecCommandEndPayload(
  payload: Record<string, unknown> & { call_id: string },
  uuid: string,
  timestamp: string,
  context?: CodexToolCallContext,
): Message {
  const aggregatedOutput =
    getStringField(payload, "aggregated_output") ??
    getStringField(payload, "aggregatedOutput") ??
    getStringField(payload, "formatted_output") ??
    [getStringField(payload, "stdout"), getStringField(payload, "stderr")]
      .filter((value): value is string => !!value)
      .join("\n");
  const normalized = normalizeCodexCommandExecutionOutput(
    {
      aggregatedOutput,
      exitCode:
        getNumberField(payload, "exit_code") ??
        getNumberField(payload, "exitCode"),
      status: getStringField(payload, "status"),
    },
    context,
  );

  const toolResult: ContentBlock = {
    type: "tool_result",
    tool_use_id: payload.call_id,
    content: normalized.content,
    ...(normalized.isError && { is_error: true }),
  };

  return {
    uuid,
    type: "user",
    message: {
      role: "user",
      content: [toolResult],
    },
    ...(normalized.structured !== undefined && {
      toolUseResult: normalized.structured,
    }),
    timestamp,
  };
}

const CODEX_COMPACT_HISTORY_PREVIEW_MAX_ITEMS = 12;
const CODEX_COMPACT_HISTORY_PREVIEW_MAX_CHARS = 4_000;

/**
 * Build a short, expandable preview of turns Codex kept after compaction.
 * The full replacement_history can be huge; this is for the transcript chip.
 */
function formatCodexCompactReplacementHistory(
  history: unknown[] | undefined,
): string | undefined {
  if (!history || history.length === 0) {
    return undefined;
  }
  const lines: string[] = [];
  for (const item of history) {
    if (lines.length >= CODEX_COMPACT_HISTORY_PREVIEW_MAX_ITEMS) {
      lines.push(
        `…and ${history.length - CODEX_COMPACT_HISTORY_PREVIEW_MAX_ITEMS} more retained items`,
      );
      break;
    }
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const role =
      typeof record.role === "string"
        ? record.role
        : record.type === "message" && typeof record.role === "string"
          ? record.role
          : undefined;
    const content = record.content;
    let text = "";
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .map((block) => {
          if (!block || typeof block !== "object") return "";
          const b = block as Record<string, unknown>;
          if (typeof b.text === "string") return b.text;
          if (typeof b.input_text === "string") return b.input_text;
          if (typeof b.output_text === "string") return b.output_text;
          return "";
        })
        .filter(Boolean)
        .join("\n");
    }
    text = text.trim();
    if (!text) continue;
    const label =
      role ?? (typeof record.type === "string" ? record.type : "item");
    const clipped =
      text.length > 500 ? `${text.slice(0, 500).trimEnd()}…` : text;
    lines.push(`[${label}] ${clipped}`);
  }
  if (lines.length === 0) {
    return undefined;
  }
  let body = `Preserved after compact (${history.length} history item${history.length === 1 ? "" : "s"}):\n\n${lines.join("\n\n")}`;
  if (body.length > CODEX_COMPACT_HISTORY_PREVIEW_MAX_CHARS) {
    body = `${body.slice(0, CODEX_COMPACT_HISTORY_PREVIEW_MAX_CHARS).trimEnd()}…`;
  }
  return body;
}

function convertCodexCompactedEntry(
  entry: CodexCompactedEntry,
  index: number,
): Message {
  const uuid = `codex-compacted-${codexEntryPosition(entry, index)}-${entry.timestamp}`;
  const providerMessage =
    typeof entry.payload.message === "string"
      ? entry.payload.message.trim()
      : "";
  const compactSummaryText =
    providerMessage ||
    formatCodexCompactReplacementHistory(entry.payload.replacement_history);
  return {
    uuid,
    type: "system",
    subtype: "compact_boundary",
    // Short chip label; expandable body lives in compactSummaryText.
    content: "Context compacted",
    ...(compactSummaryText ? { compactSummaryText } : {}),
    timestamp: entry.timestamp,
  };
}

function convertCodexEventMsg(
  entry: CodexEventMsgEntry,
  index: number,
  toolCallContexts: Map<string, CodexToolCallContext>,
  toolUseMessages: Map<string, Message>,
  closedToolResultIds: Set<string>,
  sessionId: string,
): Message | null {
  const payloadUnknown: unknown = entry.payload;
  const uuid = `codex-event-${codexEntryPosition(entry, index)}-${entry.timestamp}`;

  if (isCodexExecCommandEndPayload(payloadUnknown)) {
    const context = toolCallContexts.get(payloadUnknown.call_id);
    if (!context) {
      return null;
    }
    // Tool result: key on call_id so it matches the live stream's result uuid.
    const message = convertCodexExecCommandEndPayload(
      payloadUnknown,
      `${payloadUnknown.call_id}-result`,
      entry.timestamp,
      context,
    );
    toolCallContexts.delete(payloadUnknown.call_id);
    toolUseMessages.delete(payloadUnknown.call_id);
    closedToolResultIds.add(payloadUnknown.call_id);
    return message;
  }

  const payload = entry.payload;

  if (isCodexUserMessageEventEntry(entry)) {
    return {
      uuid:
        codexUserMessageEventClientId(entry) ??
        codexUserMessageEventItemId(entry) ??
        uuid,
      type: "user",
      codexUserTurnProvenance: "event-only",
      message: {
        role: "user",
        content: codexUserMessageEventText(entry),
      },
      timestamp: entry.timestamp,
    };
  }

  switch (payload.type) {
    case "agent_message":
      return {
        uuid,
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: payload.message }],
        },
        timestamp: entry.timestamp,
      };

    case "agent_reasoning":
      return {
        uuid,
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: payload.text }],
        },
        timestamp: entry.timestamp,
      };

    case "task_complete":
      return {
        uuid: `codex-turn-complete-${payload.turn_id}-${entry.timestamp}`,
        type: "system",
        subtype: "turn_complete",
        session_id: sessionId,
        codexTurnId: payload.turn_id,
        timestamp: entry.timestamp,
      };

    case "turn_aborted":
      return {
        uuid,
        type: "system",
        subtype: "turn_aborted",
        content: payload.reason ?? payload.message ?? "Turn aborted",
        timestamp: entry.timestamp,
      };

    case "sub_agent_activity":
      return {
        uuid,
        type: "system",
        subtype: "subagent_activity",
        content: formatCodexSubagentActivity(payload.kind, payload.agent_path),
        codexSubagentKind: payload.kind,
        codexSubagentThreadId: payload.agent_thread_id,
        codexSubagentPath: payload.agent_path,
        timestamp: entry.timestamp,
      };

    case "context_compacted":
      return {
        uuid,
        type: "system",
        subtype: "compact_boundary",
        content: "Context compacted",
        timestamp: entry.timestamp,
      };

    case "item_completed": {
      const asyncMessage = getCodexAsyncAgentMessageItem(entry);
      if (!asyncMessage) return null;
      return {
        uuid: asyncMessage.id,
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: asyncMessage.text }],
        },
        codexAgentMessageDelivery: "async",
        ...(asyncMessage.questions
          ? { codexAsyncQuestions: asyncMessage.questions }
          : {}),
        timestamp: entry.timestamp,
      };
    }

    default:
      return null;
  }
}

// --- Gemini Conversion Logic ---

function convertGeminiMessages(
  sessionMessages: GeminiSessionMessage[],
): Message[] {
  const messages: Message[] = [];
  for (const msg of sessionMessages) {
    if (msg.type === "user") {
      const userMsg = msg as GeminiUserMessage;
      messages.push({
        uuid: userMsg.id,
        type: "user",
        message: {
          role: "user",
          content: getGeminiUserMessageText(userMsg.content),
        },
        timestamp: userMsg.timestamp,
      });
    } else if (msg.type === "gemini") {
      const assistantMsg = msg as GeminiAssistantMessage;
      const content: ContentBlock[] = [];

      if (assistantMsg.thoughts) {
        for (const thought of assistantMsg.thoughts) {
          content.push({
            type: "thinking",
            thinking: `${thought.subject}: ${thought.description}`,
          });
        }
      }

      if (assistantMsg.content) {
        content.push({
          type: "text",
          text: assistantMsg.content,
        });
      }

      if (assistantMsg.toolCalls) {
        for (const toolCall of assistantMsg.toolCalls) {
          const { name, input } = normalizeGeminiTool(
            toolCall.name,
            toolCall.args,
          );
          content.push({
            type: "tool_use",
            id: toolCall.id,
            name,
            input,
          });
        }
      }

      messages.push({
        uuid: assistantMsg.id,
        type: "assistant",
        message: {
          role: "assistant",
          content,
        },
        timestamp: assistantMsg.timestamp,
      });

      if (assistantMsg.toolCalls) {
        for (const toolCall of assistantMsg.toolCalls) {
          if (toolCall.result && toolCall.result.length > 0) {
            for (const result of toolCall.result) {
              const toolUseResult = {
                tool_use_id: result.functionResponse.id,
                content: result.functionResponse.response.output,
              };
              messages.push({
                uuid: `${assistantMsg.id}-result-${result.functionResponse.id}`,
                type: "user",
                message: {
                  role: "user",
                  content: [
                    {
                      type: "tool_result",
                      ...toolUseResult,
                      ...(toolCall.status === "error"
                        ? { is_error: true }
                        : {}),
                    },
                  ],
                },
                timestamp: toolCall.timestamp ?? assistantMsg.timestamp,
              });
            }
          }
        }
      }
    }
  }
  return messages;
}

// --- OpenCode Conversion Logic ---

function convertOpenCodeEntries(entries: OpenCodeSessionEntry[]): Message[] {
  const messages: Message[] = [];

  for (const entry of entries) {
    const { message, parts } = entry;
    const uuid = message.id;
    const timestamp = message.time?.created
      ? new Date(message.time.created).toISOString()
      : undefined;

    const content = convertOpenCodeParts(parts);
    const assistantContent =
      message.role === "assistant"
        ? content.filter((block) => block.type !== "tool_result")
        : content;

    messages.push({
      uuid,
      type: message.role,
      message: {
        role: message.role,
        content: assistantContent,
        model: message.modelID,
        usage: message.tokens
          ? {
              input_tokens: message.tokens.input,
              output_tokens: message.tokens.output,
              cache_read_input_tokens: message.tokens.cache?.read,
            }
          : undefined,
      },
      timestamp,
      // Include OpenCode-specific fields
      ...(message.parentID && { parentId: message.parentID }),
      ...(message.mode && { mode: message.mode }),
      ...(message.agent && { agent: message.agent }),
      ...(message.finish && { finish: message.finish }),
    });

    if (message.role !== "assistant") continue;
    for (const part of parts) {
      const result = convertOpenCodeToolResultPart(part);
      if (!result) continue;
      messages.push({
        uuid: `${uuid}:${part.callID}:result`,
        type: "user",
        message: {
          role: "user",
          content: [result.block],
        },
        timestamp,
        ...(result.toolUseResult !== undefined
          ? { toolUseResult: result.toolUseResult }
          : {}),
      });
    }
  }

  return messages;
}

export function convertOpenCodeParts(
  parts: OpenCodeStoredPart[],
): ContentBlock[] {
  const blocks: ContentBlock[] = [];

  for (const part of parts) {
    switch (part.type) {
      case "text":
        if (part.text) {
          blocks.push({
            type: "text",
            text: part.text,
          });
        }
        break;

      case "reasoning":
        // Durable thinking — the live path already maps reasoning to a thinking
        // block; without this, reloaded OpenCode history dropped all thought
        // text. Some reasoning parts carry empty text (timing-only); skip those.
        if (part.text) {
          blocks.push({
            type: "thinking",
            thinking: part.text,
          });
        }
        break;

      case "tool":
        if (part.tool && part.callID) {
          // Tool use block, with name/fields normalized to YA's rich renderers.
          const normalized = normalizeOpenCodeTool(
            part.tool,
            part.state?.input,
          );
          blocks.push({
            type: "tool_use",
            id: part.callID,
            name: normalized.name,
            input: normalized.input,
          });

          // Once the tool settles (completed OR error), add a result block.
          // Previously only "completed" was handled, so failed tools silently
          // dropped their error text on reload.
          const result = convertOpenCodeToolResultPart(part);
          if (result) blocks.push(result.block);
        }
        break;

      // Metadata / markers with no rich content of their own:
      // - step-start/step-finish: turn-step boundaries (token usage is carried
      //   at the message level in convertOpenCodeEntries).
      // - patch: a snapshot {hash, files} of a file change; the actual edit is
      //   already rendered by its edit/write tool block, so this is redundant.
      // - compaction: a context-compaction marker (opencode 1.16+).
      case "step-start":
      case "step-finish":
      case "patch":
      case "compaction":
        break;

      default:
        // Unknown part type - skip
        break;
    }
  }

  return blocks;
}

function convertOpenCodeToolResultPart(
  part: OpenCodeStoredPart,
): { block: ContentBlock; toolUseResult?: unknown } | undefined {
  if (part.type !== "tool" || !part.tool || !part.callID) return undefined;
  const status = part.state?.status;
  if (status !== "completed" && status !== "error") return undefined;
  const error = part.state?.error;
  const content =
    error ??
    (typeof part.state?.output === "string"
      ? part.state.output
      : JSON.stringify(part.state?.output ?? ""));
  return {
    block: {
      type: "tool_result",
      tool_use_id: part.callID,
      content,
      is_error: status === "error" || Boolean(error),
    },
    toolUseResult: normalizeOpenCodeToolResult(
      part.tool,
      part.state?.attachments,
    ),
  };
}

/** The issue index shares the transcript parser's visibility and identity rules. */
export function normalizeIssueEntries(
  provider: "claude" | "codex",
  entries: Array<ClaudeSessionEntry | CodexSessionEntry>,
): import("../services/issues/extract.js").IssueText[] {
  const messages =
    provider === "claude"
      ? (entries as ClaudeSessionEntry[]).map((entry, index) =>
          convertClaudeMessage(entry, index, new Set()),
        )
      : convertCodexEntries(entries as CodexSessionEntry[], "issue-index");
  return messages.flatMap((message) => {
    const text = issueMessageText(message);
    return text ? [text] : [];
  });
}

export function issueMessageText(
  message: Message,
): import("../services/issues/extract.js").IssueText | null {
  const text = visibleIssueText(message);
  return text ? { ...text, sourceId: issueSourceIds.get(message) } : null;
}
