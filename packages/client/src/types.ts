// Re-export shared types
export type { PermissionMode, SessionStatus } from "@claude-anywhere/shared";
import type { SessionStatus } from "@claude-anywhere/shared";

export interface Project {
  id: string;
  path: string;
  name: string;
  sessionCount: number;
  activeOwnedCount: number;
  activeExternalCount: number;
  lastActivity: string | null;
}

/** Type of pending input request for notification badges */
export type PendingInputType = "tool-approval" | "user-question";

/** Process state type - what the agent is doing */
export type ProcessStateType = "running" | "waiting-input";

/** Context usage information extracted from the last assistant message */
export interface ContextUsage {
  /** Total input tokens for the last request (fresh + cached) */
  inputTokens: number;
  /** Percentage of context window used (based on 200K limit) */
  percentage: number;
}

export interface SessionSummary {
  id: string;
  projectId: string;
  title: string | null; // truncated title (max 120 chars)
  fullTitle: string | null; // complete title for hover tooltip
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  status: SessionStatus;
  // Notification fields (added by server when available)
  /** Type of pending input if session needs user action */
  pendingInputType?: PendingInputType;
  /** Current process state (running/waiting-input) for activity indicators */
  processState?: ProcessStateType;
  /** When the session was last viewed (if tracked) */
  lastSeenAt?: string;
  /** Whether session has new content since last viewed */
  hasUnread?: boolean;
  // Metadata fields (from SessionMetadataService)
  /** Custom title that overrides auto-generated title */
  customTitle?: string;
  /** Whether the session is archived (hidden from default list) */
  isArchived?: boolean;
  /** Whether the session is starred/favorited */
  isStarred?: boolean;
  /** Context usage from the last assistant message */
  contextUsage?: ContextUsage;
}

/**
 * Content block in messages - loosely typed to preserve all fields.
 */
export interface ContentBlock {
  type: string;
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
 * Message representation - loosely typed to preserve all server fields.
 *
 * Messages may come from:
 * 1. SDK streaming (real-time, may be missing some fields)
 * 2. JSONL from disk (authoritative, complete)
 *
 * The client merges these with JSONL taking precedence.
 */
export interface Message {
  id: string;
  type?: string;
  role?: "user" | "assistant" | "system";
  content?: string | ContentBlock[];
  timestamp?: string;
  // SDK message structure - content and role nested in message object
  message?: {
    role?: "user" | "assistant";
    content?: string | ContentBlock[];
  };
  // DAG structure
  parentUuid?: string | null;
  // Tool use related
  toolUse?: {
    id: string;
    name: string;
    input: unknown;
  };
  toolUseResult?: unknown;
  // Computed fields
  orphanedToolUseIds?: string[];
  // Source tracking for merge
  _source?: "sdk" | "jsonl";
  // Subagent marker - true if this message is from a Task subagent
  isSubagent?: boolean;
  // Allow any additional fields
  [key: string]: unknown;
}

export interface Session extends SessionSummary {
  messages: Message[];
}

/**
 * Get the display title for a session.
 * Priority: customTitle > title > "Untitled"
 */
export function getSessionDisplayTitle(
  session: Pick<SessionSummary, "customTitle" | "title"> | null | undefined,
): string {
  if (!session) return "Untitled";
  return session.customTitle ?? session.title ?? "Untitled";
}

// Input request for tool approval or user questions
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
