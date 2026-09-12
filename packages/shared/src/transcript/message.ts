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
