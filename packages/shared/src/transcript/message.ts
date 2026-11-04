import type { AppContentBlock, AppMessageExtensions } from "../app-types.js";
import type { ToolResultMedia } from "../tool-result-media.js";

export type ContentBlock = AppContentBlock;

/**
 * Normalized transcript input used by semantic projection and web adapters.
 *
 * This is a flexible structural type compatible with AppMessage entries.
 * Messages should have at least one of `uuid` or `id` for identification.
 * Use getMessageId(m) helper which returns `uuid ?? id` for lookups.
 *
 * Key fields:
 * - uuid: SDK message identifier (primary identifier)
 * - id: Legacy identifier (optional - may not be present for SDK messages)
 * - type: Entry type (user/assistant/system/summary/etc.) - use this for discrimination
 * - message.content: Message content (SDK structure)
 * - content: Top-level content (convenience copy)
 *
 * Note: This interface is intentionally looser than AppMessage to support:
 * - Partial data during SSE streaming
 * - Test mocks with minimal fields
 * - Backward compatibility with existing code
 */
export interface Message {
  codexAgentMessageDelivery?: AppMessageExtensions["codexAgentMessageDelivery"];
  codexAsyncQuestions?: AppMessageExtensions["codexAsyncQuestions"];
  /** Legacy message identifier (may not be present - use getMessageId() helper) */
  id?: string;
  /** SDK message identifier (prefer this for lookups) */
  uuid?: string;
  /** Authoritative user-input identities represented by this row, including its primary ID. */
  inputMessageIds?: string[];
  /** Entry type - use for discrimination (user/assistant/system/summary/etc.) */
  type?: string;
  /** Legacy role field (use type instead) */
  role?: "user" | "assistant" | "system";
  /** Message content (convenience copy from message.content) */
  content?: string | AppContentBlock[];
  /** Timestamp */
  timestamp?: string;
  /** SDK message structure - canonical location for content */
  message?: {
    role?: "user" | "assistant";
    content?: string | AppContentBlock[];
    [key: string]: unknown;
  };
  /** DAG parent reference */
  parentUuid?: string | null;
  /** Tool use data (extracted for convenience) */
  toolUse?: {
    id: string;
    name: string;
    input: unknown;
  };
  /** Tool use result data */
  toolUseResult?: unknown;
  /** Session-scoped stored media captured from a tool result */
  toolResultMedia?: ToolResultMedia[];
  /** Tool use IDs without corresponding results (orphaned) */
  orphanedToolUseIds?: string[];
  /** Source tracking: "sdk" for streaming, "jsonl" for persisted */
  _source?: "sdk" | "jsonl";
  /** True if this message is from a Task subagent */
  isSubagent?: boolean;
  /** True if message is still being streamed (incomplete) */
  _isStreaming?: boolean;
  /**
   * Claude transcripts only: the provider aborted this assistant message
   * mid-stream to deliver a steering message, so its text stops wherever
   * generation was cut (see claude-sdk-schema AssistantEntrySchema).
   */
  isAbortedMidStream?: boolean;
  /** Allow any additional fields from SDK/server */
  [key: string]: unknown;
}

/** Canonical normalized record identity; callers decide how to handle absence. */
export function getMessageId(message: Message): string {
  return message.uuid ?? message.id ?? "";
}

const MAX_INPUT_MESSAGE_IDS = 1024;

/** Canonical row identity plus bounded, server-normalized contributing user IDs. */
export function getMessageIds(message: Message): string[] {
  const primary = getMessageId(message);
  const ids = new Set(primary ? [primary] : []);
  if (message.type === "user" && Array.isArray(message.inputMessageIds)) {
    for (const id of message.inputMessageIds.slice(0, MAX_INPUT_MESSAGE_IDS)) {
      if (typeof id === "string" && id.length > 0 && id.length <= 128)
        ids.add(id);
      if (ids.size >= MAX_INPUT_MESSAGE_IDS) break;
    }
  }
  return [...ids];
}

/** Lookups retain the canonical row ID while accepting proven contributing inputs. */
export function messageHasId(message: Message, id: string): boolean {
  if (!id) return false;
  if (getMessageId(message) === id) return true;
  if (message.type !== "user" || !Array.isArray(message.inputMessageIds))
    return false;
  for (
    let i = 0;
    i < Math.min(message.inputMessageIds.length, MAX_INPUT_MESSAGE_IDS);
    i++
  ) {
    if (message.inputMessageIds[i] === id && id.length <= 128) return true;
  }
  return false;
}

/** Collapse message snapshots by identity, retaining the first position and latest value. */
export function collapseMessageSnapshots<
  T extends Pick<Message, "uuid" | "id">,
>(messages: T[]): T[] {
  const positions = new Map<string, number>();
  const result: T[] = [];
  for (const message of messages) {
    const id = message.uuid ?? message.id;
    const position = id ? positions.get(id) : undefined;
    if (position !== undefined) {
      result[position] = message;
    } else {
      if (id) positions.set(id, result.length);
      result.push(message);
    }
  }
  return result.length === messages.length ? messages : result;
}
