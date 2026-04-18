// Import AgentStatus for local use in AgentSession interface
import type {
  AgentStatus as AgentStatusType,
  AppContentBlock,
  AppMessage,
} from "@yep-anywhere/shared";

// Re-export shared types
export type {
  PermissionMode,
  ProviderName,
  UrlProjectId,
  // SDK schema types (for strict typing when needed)
  AssistantEntry,
  UserEntry,
  SystemEntry,
  SummaryEntry,
  SessionEntry,
  AssistantMessage,
  AssistantMessageContent,
  UserMessage,
  UserMessageContent,
  TextContent,
  ThinkingContent,
  ToolUseContent,
  ToolResultContent,
  ImageContent,
  DocumentContent,
  // App types
  AppMessageExtensions,
  AppUserMessage,
  AppAssistantMessage,
  AppSystemMessage,
  AppSummaryMessage,
  AppMessage,
  AppConversationMessage,
  AppContentBlock,
  PendingInputType,
  AgentActivity,
  ContextUsage,
  SessionOwnership,
  AppSessionSummary,
  AppSession,
  AgentStatus,
  InputRequest,
} from "@yep-anywhere/shared";

// Re-export type guards
export {
  isUserMessage,
  isAssistantMessage,
  isSystemMessage,
  isSummaryMessage,
  isConversationMessage,
} from "@yep-anywhere/shared";

/**
 * Content block for rendering - loosely typed to handle all possible fields.
 * Uses AppContentBlock from shared as the base.
 *
 * Note: The renderers have their own stricter ContentBlock type in
 * components/renderers/types.ts for type-safe rendering.
 */
export type ContentBlock = AppContentBlock;

/**
 * Message type for client-side use.
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
  /** Tool use IDs without corresponding results (orphaned) */
  orphanedToolUseIds?: string[];
  /** Source tracking: "sdk" for streaming, "jsonl" for persisted */
  _source?: "sdk" | "jsonl";
  /** True if this message is from a Task subagent */
  isSubagent?: boolean;
  /** True if message is still being streamed (incomplete) */
  _isStreaming?: boolean;
  /** Allow any additional fields from SDK/server */
  [key: string]: unknown;
}

// Type aliases for session types
import type {
  AppSessionSummary,
  SessionOwnership as SessionOwnershipType,
} from "@yep-anywhere/shared";

export type SessionStatus = SessionOwnershipType;
export type SessionSummary = AppSessionSummary;

/**
 * Full session with messages.
 * Uses Message type (AppMessage with required id).
 */
export interface Session extends SessionSummary {
  messages: Message[];
}

/**
 * Agent session content for Task subagents.
 * Uses Message type (AppMessage with required id).
 */
export interface AgentSession {
  messages: Message[];
  status: AgentStatusType;
}

/**
 * Project - client-specific type for project listings.
 */
export interface Project {
  id: string;
  path: string;
  name: string;
  sessionCount: number;
  activeOwnedCount: number;
  activeExternalCount: number;
  lastActivity: string | null;
}

export interface HiddenProject {
  id: string;
  path: string;
  name: string;
  hiddenAt: string;
}
