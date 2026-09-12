// Import AgentStatus for local use in AgentSession interface
import type {
  AgentStatus as AgentStatusType,
  AppContentBlock,
  ProviderName,
} from "@yep-anywhere/shared";

// Re-export shared types
export type {
  PermissionMode,
  ProviderName,
  RecapMode,
  PromptSuggestionMode,
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
  ProviderRuntimeStatus,
  AgentActivity,
  ContextUsage,
  SessionOwnership,
  AppSessionSummary,
  AppSession,
  AgentStatus,
  ProviderChildSessionSummary,
  UserQuestionAnswer,
  UserQuestionAnswers,
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

export type Message = import("@yep-anywhere/shared/transcript/message").Message;

// Type aliases for session types
import type {
  AppSessionSummary,
  PromptSuggestionMode,
  SessionEffectiveModelSettings,
  SessionLivenessSnapshot,
  SessionOwnership as SessionOwnershipType,
} from "@yep-anywhere/shared";

export type { SessionLivenessSnapshot };
export type SessionStatus = SessionOwnershipType;
export type SessionSummary = AppSessionSummary;

export interface SessionMetadata extends SessionSummary {
  effectiveModelSettings?: SessionEffectiveModelSettings;
  heartbeatTurnsEnabled?: boolean;
  heartbeatTurnsAfterMinutes?: number;
  heartbeatTurnText?: string;
  heartbeatForceAfterMinutes?: number;
  promptSuggestionMode?: PromptSuggestionMode;
  recapAfterSeconds?: number;
}

/**
 * Full session with messages.
 * Uses Message type (AppMessage with required id).
 */
export interface Session extends SessionMetadata {
  messages: Message[];
}

/**
 * Agent session content for Task subagents.
 * Uses Message type (AppMessage with required id).
 */
export interface AgentSession {
  messages: Message[];
  status: AgentStatusType;
  agentType?: string;
  description?: string;
  spawnDepth?: number;
}

/**
 * Project - client-specific type for project listings.
 */
export interface Project {
  id: string;
  path: string;
  name: string;
  /** Server-owned unique shorthand; absent on older servers. */
  codeName?: string;
  sessionCount: number;
  sessionCountsByProvider?: Partial<Record<ProviderName, number>>;
  activeOwnedCount: number;
  activeExternalCount: number;
  projectQueueBlockingCount?: number;
  projectQueueCount?: number;
  lastActivity: string | null;
}
