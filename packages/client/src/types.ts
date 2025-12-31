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

export interface SessionSummary {
  id: string;
  projectId: string;
  title: string | null; // truncated title (max 50 chars)
  fullTitle: string | null; // complete title for hover tooltip
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  status: SessionStatus;
  // Notification fields (added by server when available)
  /** Type of pending input if session needs user action */
  pendingInputType?: PendingInputType;
  /** When the session was last viewed (if tracked) */
  lastSeenAt?: string;
  /** Whether session has new content since last viewed */
  hasUnread?: boolean;
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
