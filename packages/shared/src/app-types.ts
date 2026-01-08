/**
 * App-specific types that extend SDK types with runtime/computed fields.
 *
 * These types are used by the client and server to work with messages
 * that may have additional metadata added during processing.
 *
 * Key principle: SDK types (UserEntry, AssistantEntry) represent what's in JSONL files.
 * App types extend these with runtime fields that are computed or added during processing.
 */

import type {
  AssistantEntry,
  SessionEntry,
  SummaryEntry,
  SystemEntry,
  UserEntry,
} from "./claude-sdk-schema/types.js";
import type { UrlProjectId } from "./projectId.js";
import type { PermissionMode, ProviderName } from "./types.js";

// =============================================================================
// App Message Extensions
// =============================================================================

/**
 * Content block type for app messages.
 * Loosely typed to preserve all fields from JSONL without stripping.
 */
export interface AppContentBlock {
  type: string;
  // text block
  text?: string;
  // thinking block
  thinking?: string;
  signature?: string;
  // tool_use block
  id?: string;
  name?: string;
  input?: unknown;
  // tool_result block
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
  // Allow any additional fields
  [key: string]: unknown;
}

/**
 * Runtime fields added to messages by our application.
 * These are computed or added during processing, not stored in JSONL.
 *
 * Includes convenience fields added by SessionReader.convertMessage():
 * - id: copied from uuid (or fallback to index-based)
 * - content: copied to top level from message.content
 * - role: added based on message type
 */
export interface AppMessageExtensions {
  /**
   * Message identifier - copied from uuid by SessionReader.
   * Fallback: "msg-{index}" when uuid is not available.
   */
  id?: string;

  /**
   * Message content copied to top level for convenience.
   * Original is in message.content for user/assistant entries.
   */
  content?: string | AppContentBlock[];

  /**
   * Role derived from message type (user/assistant).
   * Added by SessionReader for convenience.
   */
  role?: "user" | "assistant" | "system";

  /**
   * IDs of tool_use blocks that don't have a matching tool_result in the message history.
   * Computed by SessionReader via DAG analysis.
   *
   * NOTE: This is a misnomer. These aren't necessarily "orphaned" (abandoned) - they may be
   * actively pending (awaiting approval or currently executing). The client should check
   * process state to determine if tools are truly orphaned vs just pending.
   *
   * TODO: Consider renaming to `toolUsesWithoutResults` for clarity.
   */
  orphanedToolUseIds?: string[];

  /**
   * Source of this message data.
   * - "sdk": Message came from real-time SDK streaming
   * - "jsonl": Message was read from disk (authoritative)
   */
  _source?: "sdk" | "jsonl";

  /**
   * True if this message is still being streamed (incomplete).
   * Only set during active streaming; cleared when message is complete.
   */
  _isStreaming?: boolean;

  /**
   * True if this message is from a Task subagent.
   * Used for UI grouping and lazy-loading of subagent content.
   */
  isSubagent?: boolean;

  /**
   * Allow any additional fields from JSONL.
   * This makes the type compatible with pass-through of unknown fields.
   */
  [key: string]: unknown;
}

// =============================================================================
// App Message Types
// =============================================================================

/**
 * User message with app extensions.
 */
export type AppUserMessage = UserEntry & AppMessageExtensions;

/**
 * Assistant message with app extensions.
 */
export type AppAssistantMessage = AssistantEntry & AppMessageExtensions;

/**
 * System message with app extensions.
 */
export type AppSystemMessage = SystemEntry & AppMessageExtensions;

/**
 * Summary message with app extensions.
 */
export type AppSummaryMessage = SummaryEntry & AppMessageExtensions;

/**
 * Any JSONL entry type with app extensions.
 * This is the main message type used throughout the app.
 */
export type AppMessage = (SessionEntry | SummaryEntry) & AppMessageExtensions;

/**
 * Conversation messages only (user/assistant/system).
 * Excludes file_history_snapshot and queue_operation entries.
 */
export type AppConversationMessage =
  | AppUserMessage
  | AppAssistantMessage
  | AppSystemMessage
  | AppSummaryMessage;

// =============================================================================
// Session Types
// =============================================================================

/** Type of pending input request for notification badges */
export type PendingInputType = "tool-approval" | "user-question";

/** Process state type - what the agent is doing */
export type ProcessStateType =
  | "running"
  | "idle"
  | "waiting-input"
  | "hold"
  | "terminated";

/** Context usage information extracted from the last assistant message */
export interface ContextUsage {
  /** Total input tokens for the last request (fresh + cached) */
  inputTokens: number;
  /** Percentage of context window used (based on 200K limit) */
  percentage: number;
  /** Output tokens generated in the last response (optional - may not be available) */
  outputTokens?: number;
  /** Cache read tokens (tokens served from cache) */
  cacheReadTokens?: number;
  /** Cache creation tokens (new tokens added to cache) */
  cacheCreationTokens?: number;
}

/**
 * Session status - tracks ownership and active state.
 */
export type AppSessionStatus =
  | { state: "idle" } // no active process
  | {
      state: "owned";
      processId: string;
      permissionMode?: PermissionMode;
      modeVersion?: number;
    } // we control it
  | { state: "external" }; // another process owns it

/**
 * Session summary for list views.
 * Contains metadata without full message content.
 */
export interface AppSessionSummary {
  id: string;
  projectId: UrlProjectId;
  title: string | null;
  fullTitle: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  status: AppSessionStatus;
  // Provider field - which AI provider is running this session
  provider: ProviderName;
  // Model used for this session (resolved, not "default")
  model?: string;
  // Notification fields
  pendingInputType?: PendingInputType;
  processState?: ProcessStateType;
  lastSeenAt?: string;
  hasUnread?: boolean;
  // Metadata fields
  customTitle?: string;
  isArchived?: boolean;
  isStarred?: boolean;
  contextUsage?: ContextUsage;
}

/**
 * Full session with messages.
 */
export interface AppSession extends AppSessionSummary {
  messages: AppMessage[];
}

// =============================================================================
// Agent Session Types (for Task subagents)
// =============================================================================

/** Status of an agent session, inferred from its messages */
export type AgentStatus = "pending" | "running" | "completed" | "failed";

/**
 * Agent session content returned by getAgentSession API.
 * Used for lazy-loading completed Task subagent content.
 */
export interface AgentSession {
  messages: AppMessage[];
  status: AgentStatus;
}

// =============================================================================
// Input Request Types
// =============================================================================

/**
 * Input request for tool approval or user questions.
 */
export interface InputRequest {
  id: string;
  sessionId: string;
  type: "tool-approval" | "question" | "choice";
  prompt: string;
  options?: string[];
  toolName?: string;
  toolInput?: unknown;
  timestamp: string;
}

// =============================================================================
// Type Guards
// =============================================================================

/**
 * Check if a message is a user entry.
 */
export function isUserMessage(msg: AppMessage): msg is AppUserMessage {
  return msg.type === "user";
}

/**
 * Check if a message is an assistant entry.
 */
export function isAssistantMessage(
  msg: AppMessage,
): msg is AppAssistantMessage {
  return msg.type === "assistant";
}

/**
 * Check if a message is a system entry.
 */
export function isSystemMessage(msg: AppMessage): msg is AppSystemMessage {
  return msg.type === "system";
}

/**
 * Check if a message is a summary entry.
 */
export function isSummaryMessage(msg: AppMessage): msg is AppSummaryMessage {
  return msg.type === "summary";
}

/**
 * Check if a message is a conversation message (user/assistant/system/summary).
 */
export function isConversationMessage(
  msg: AppMessage,
): msg is AppConversationMessage {
  return (
    msg.type === "user" ||
    msg.type === "assistant" ||
    msg.type === "system" ||
    msg.type === "summary"
  );
}
