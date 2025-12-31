import type { UrlProjectId } from "@claude-anywhere/shared";
import type { PermissionMode, SDKMessage } from "../sdk/types.js";

// Constants
export const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
export const DEFAULT_IDLE_PREEMPT_THRESHOLD_MS = 10 * 1000; // 10 seconds - workers idle longer than this can be preempted
export const SESSION_TITLE_MAX_LENGTH = 120;

// Re-export path utilities for backward compatibility
// See packages/server/src/projects/paths.ts for full documentation on encoding schemes
export { decodeProjectId, encodeProjectId } from "../projects/paths.js";

// Project discovery
export interface Project {
  id: UrlProjectId; // base64url encoded path
  path: string; // absolute path
  name: string; // directory name
  sessionCount: number;
  sessionDir: string; // path to session directory (e.g., ~/.claude/projects/hostname/-encoded-path/)
  activeOwnedCount: number; // sessions owned by this server
  activeExternalCount: number; // sessions controlled by external processes
  lastActivity: string | null; // ISO timestamp of most recent session update
}

// Session status
export type SessionStatus =
  | { state: "idle" } // no active process
  | {
      state: "owned";
      processId: string;
      permissionMode?: PermissionMode;
      modeVersion?: number;
    } // we control it
  | { state: "external" }; // another process owns it

/** Type of pending input request for notification badges */
export type PendingInputType = "tool-approval" | "user-question";

/** Context usage information extracted from the last assistant message */
export interface ContextUsage {
  /** Total input tokens for the last request (fresh + cached) */
  inputTokens: number;
  /** Percentage of context window used (based on 200K limit) */
  percentage: number;
}

// Session metadata (light, for lists)
export interface SessionSummary {
  id: string;
  projectId: UrlProjectId;
  title: string | null; // first 120 chars of first user message (truncated with ...)
  fullTitle: string | null; // complete first user message (for hover tooltip)
  createdAt: string; // ISO timestamp
  updatedAt: string;
  messageCount: number;
  status: SessionStatus;
  // Notification fields (added by enrichSessionsWithNotifications)
  /** Type of pending input if session needs user action */
  pendingInputType?: PendingInputType;
  /** When the session was last viewed (if tracked) */
  lastSeenAt?: string;
  /** Whether session has new content since last viewed */
  hasUnread?: boolean;
  // Metadata fields (added from SessionMetadataService)
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
 * Message representation - loosely typed to preserve all JSONL fields.
 *
 * We pass through all fields from JSONL without stripping.
 * This preserves debugging info, DAG structure, and metadata.
 */
export interface Message {
  id: string;
  type: string;
  role?: "user" | "assistant" | "system";
  content?: string | ContentBlock[];
  timestamp?: string;
  // DAG structure
  parentUuid?: string | null;
  // Tool use related
  toolUse?: {
    id: string;
    name: string;
    input: unknown;
  };
  toolUseResult?: unknown;
  // Computed fields (added by SessionReader)
  orphanedToolUseIds?: string[];
  // Allow any additional fields from JSONL
  [key: string]: unknown;
}

// Full session with messages
export interface Session extends SessionSummary {
  messages: Message[];
}

// Process state types
export type ProcessStateType =
  | "running"
  | "idle"
  | "waiting-input"
  | "terminated";

// Input request (tool approval, question, etc.)
export interface InputRequest {
  id: string;
  sessionId: string;
  type: "tool-approval" | "question" | "choice";
  prompt: string;
  options?: string[]; // for choice type
  toolName?: string; // for tool-approval
  toolInput?: unknown; // for tool-approval
  timestamp: string;
}

// Process state machine
export type ProcessState =
  | { type: "running" }
  | { type: "idle"; since: Date }
  | { type: "waiting-input"; request: InputRequest }
  | { type: "terminated"; reason: string; error?: Error };

// Process info (for API responses)
export interface ProcessInfo {
  id: string;
  sessionId: string;
  projectId: UrlProjectId;
  projectPath: string;
  state: ProcessStateType;
  startedAt: string;
  queueDepth: number;
}

// Process events for subscribers
export type ProcessEvent =
  | { type: "message"; message: SDKMessage }
  | { type: "state-change"; state: ProcessState }
  | { type: "mode-change"; mode: PermissionMode; version: number }
  | { type: "error"; error: Error }
  | { type: "complete" }
  | { type: "terminated"; reason: string; error?: Error };

// Process options
export interface ProcessOptions {
  projectPath: string;
  projectId: UrlProjectId;
  sessionId: string;
  idleTimeoutMs?: number; // default 5 minutes
  permissionMode?: PermissionMode;
}
