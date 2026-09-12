import {
  CODEX_TOOL_CORRELATION_FIELD,
  getCodexToolCorrelation,
  type CodexToolCorrelationMetadata,
} from "@yep-anywhere/shared";
import type { Message } from "../types";
import { getMessageId } from "@yep-anywhere/shared/transcript/message";
import { getMessageContent, mergeMessage } from "./mergeMessages";

// A durable tool call is written near its live nested-tool or plan-update
// event. Keep this window deliberately narrow and require exact normalized
// input plus the same provider turn; the timestamp is only used to pair
// repeated identical calls one-to-one.
const CODEX_TOOL_CORRELATION_WINDOW_MS = 10_000;

interface ToolUseCandidate {
  fingerprint: string;
  metadata: CodexToolCorrelationMetadata;
  timestampMs: number;
  toolUseId: string;
}

function isDurableOrigin(
  origin: CodexToolCorrelationMetadata["origin"],
): boolean {
  return origin === "custom_tool_call" || origin === "function_call";
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([left], [right]) => left.localeCompare(right),
    );
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return String(value);
}

function getToolBlock(
  message: Message,
  type: "tool_use" | "tool_result",
): Record<string, unknown> | null {
  const content = getMessageContent(message);
  if (!Array.isArray(content)) return null;
  const block = content.find(
    (item) =>
      !!item &&
      typeof item === "object" &&
      (item as { type?: unknown }).type === type,
  );
  return block && typeof block === "object"
    ? (block as Record<string, unknown>)
    : null;
}

function getToolUseFingerprint(block: Record<string, unknown>): string | null {
  if (typeof block.name !== "string") return null;
  if (block.name === "ViewImage") {
    const input = block.input;
    if (!input || typeof input !== "object" || Array.isArray(input))
      return null;
    const path = (input as { path?: unknown }).path;
    if (typeof path !== "string") return null;
    // Codex's live imageView omits outer-only view options such as detail.
    return `${block.name}:${stableStringify({ path })}`;
  }
  return `${block.name}:${stableStringify(block.input)}:${stableStringify(
    block._displayActions,
  )}`;
}

function getTimestampMs(
  message: Message,
  metadata: CodexToolCorrelationMetadata,
): number | null {
  const timestamp = metadata.startedAt ?? message.timestamp;
  if (typeof timestamp !== "string") return null;
  const timestampMs = Date.parse(timestamp);
  return Number.isFinite(timestampMs) ? timestampMs : null;
}

function collectToolUseCandidates(messages: Message[]): ToolUseCandidate[] {
  const candidates: ToolUseCandidate[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message) continue;
    const metadata = getCodexToolCorrelation(message);
    const block = getToolBlock(message, "tool_use");
    if (!metadata || !block) continue;
    const timestampMs = getTimestampMs(message, metadata);
    if (timestampMs === null) continue;
    const toolUseId = block.id;
    const fingerprint = getToolUseFingerprint(block);
    if (typeof toolUseId !== "string" || !fingerprint) continue;
    candidates.push({
      fingerprint,
      metadata,
      timestampMs,
      toolUseId,
    });
  }
  return candidates;
}

function replaceToolBlockId(
  message: Message,
  blockType: "tool_use" | "tool_result",
  durableCallId: string,
): Message {
  const replace = (content: Message["content"]): Message["content"] => {
    if (!Array.isArray(content)) return content;
    return content.map((block) => {
      if (!block || typeof block !== "object" || block.type !== blockType) {
        return block;
      }
      return blockType === "tool_use"
        ? { ...block, id: durableCallId }
        : { ...block, tool_use_id: durableCallId };
    });
  };

  const nestedContent = message.message?.content;
  const topContent = message.content;
  return {
    ...message,
    ...(Array.isArray(topContent) ? { content: replace(topContent) } : {}),
    ...(message.message && Array.isArray(nestedContent)
      ? {
          message: {
            ...message.message,
            content: replace(nestedContent),
          },
        }
      : {}),
  };
}

function withCorrelation(
  message: Message,
  metadata: CodexToolCorrelationMetadata,
): Message {
  return {
    ...message,
    [CODEX_TOOL_CORRELATION_FIELD]: metadata,
  };
}

function mergeCanonicalMessage(existing: Message, incoming: Message): Message {
  return mergeMessage(
    existing,
    incoming,
    (incoming._source ?? "sdk") === "jsonl" ? "jsonl" : "sdk",
  );
}

/**
 * Reconcile bounded Codex live/durable tool identity mismatches:
 *
 * - app-server exposes a nested command as commandExecution(exec-*);
 * - app-server exposes a nested image view as imageView(item-*);
 * - app-server exposes a checklist as turn/plan/updated without a call id;
 * - rollout persists the corresponding function/custom tool call(call_*).
 *
 * Exact normalized semantics, turn id, nearest timestamp, and one-to-one
 * pairing are all required. Once paired, the durable call id becomes the
 * canonical parent/result identity. Ambiguous or multi-call orchestration is
 * left untouched rather than content-deduped heuristically.
 */
export function reconcileCodexToolMessages(messages: Message[]): Message[] {
  const candidates = collectToolUseCandidates(messages);
  const liveCandidates = candidates.filter(
    (candidate) => !isDurableOrigin(candidate.metadata.origin),
  );
  const durableCandidates = candidates.filter((candidate) =>
    isDurableOrigin(candidate.metadata.origin),
  );

  const liveToDurable = new Map<string, string>();
  const durableToLive = new Map<string, string>();
  for (const message of messages) {
    const metadata = getCodexToolCorrelation(message);
    if (!metadata) continue;
    if (!isDurableOrigin(metadata.origin) && metadata.durableCallId) {
      liveToDurable.set(metadata.itemId, metadata.durableCallId);
      durableToLive.set(metadata.durableCallId, metadata.itemId);
    }
    if (isDurableOrigin(metadata.origin) && metadata.liveItemId) {
      liveToDurable.set(metadata.liveItemId, metadata.itemId);
      durableToLive.set(metadata.itemId, metadata.liveItemId);
    }
  }

  if (
    liveToDurable.size === 0 &&
    (liveCandidates.length === 0 || durableCandidates.length === 0)
  ) {
    return messages;
  }

  const matchedLiveIds = new Set(liveToDurable.keys());
  for (const durable of durableCandidates) {
    if (durableToLive.has(durable.toolUseId)) continue;
    let best: ToolUseCandidate | null = null;
    let bestDeltaMs = Number.POSITIVE_INFINITY;
    for (const live of liveCandidates) {
      if (matchedLiveIds.has(live.metadata.itemId)) continue;
      if (live.metadata.turnId !== durable.metadata.turnId) continue;
      if (live.fingerprint !== durable.fingerprint) continue;
      const deltaMs = Math.abs(live.timestampMs - durable.timestampMs);
      if (deltaMs > CODEX_TOOL_CORRELATION_WINDOW_MS) continue;
      if (deltaMs < bestDeltaMs) {
        best = live;
        bestDeltaMs = deltaMs;
      }
    }
    if (!best) continue;
    liveToDurable.set(best.metadata.itemId, durable.toolUseId);
    durableToLive.set(durable.toolUseId, best.metadata.itemId);
    matchedLiveIds.add(best.metadata.itemId);
  }

  if (liveToDurable.size === 0) return messages;

  const canonicalIds = new Set<string>();
  let changed = false;
  const remapped = messages.map((message) => {
    const metadata = getCodexToolCorrelation(message);
    if (!metadata) return message;

    if (isDurableOrigin(metadata.origin)) {
      const toolUse = getToolBlock(message, "tool_use");
      const toolResult = getToolBlock(message, "tool_result");
      const durableCallId =
        typeof toolUse?.id === "string"
          ? toolUse.id
          : typeof toolResult?.tool_use_id === "string"
            ? toolResult.tool_use_id
            : metadata.itemId;
      const liveItemId = durableToLive.get(durableCallId);
      if (!liveItemId || metadata.liveItemId === liveItemId) return message;
      canonicalIds.add(durableCallId);
      changed = true;
      return withCorrelation(message, { ...metadata, liveItemId });
    }

    const durableCallId = liveToDurable.get(metadata.itemId);
    if (!durableCallId) return message;
    canonicalIds.add(durableCallId);
    const isToolUse = getToolBlock(message, "tool_use") !== null;
    const isToolResult = getToolBlock(message, "tool_result") !== null;
    if (!isToolUse && !isToolResult) return message;

    changed = true;
    const remappedMessage = replaceToolBlockId(
      message,
      isToolUse ? "tool_use" : "tool_result",
      durableCallId,
    );
    return withCorrelation(
      {
        ...remappedMessage,
        uuid: isToolUse ? durableCallId : `${durableCallId}-result`,
      },
      { ...metadata, durableCallId },
    );
  });

  if (!changed) return messages;

  const canonicalMessageIds = new Set(
    [...canonicalIds].flatMap((callId) => [callId, `${callId}-result`]),
  );
  const result: Message[] = [];
  const resultIndexById = new Map<string, number>();
  for (const message of remapped) {
    const messageId = getMessageId(message);
    const existingIndex = resultIndexById.get(messageId);
    if (existingIndex === undefined || !canonicalMessageIds.has(messageId)) {
      resultIndexById.set(messageId, result.length);
      result.push(message);
      continue;
    }
    const existing = result[existingIndex];
    if (existing) {
      result[existingIndex] = mergeCanonicalMessage(existing, message);
    }
  }
  return result;
}
