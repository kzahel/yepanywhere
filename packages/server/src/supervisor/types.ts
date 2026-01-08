import type {
  ContextUsage,
  InputRequest,
  PendingInputType,
  ProcessStateType,
  ProviderName,
  UrlProjectId,
} from "@yep-anywhere/shared";
import type { PermissionMode, SDKMessage } from "../sdk/types.js";

// Constants
export const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
export const DEFAULT_IDLE_PREEMPT_THRESHOLD_MS = 10 * 1000; // 10 seconds - workers idle longer than this can be preempted

// Re-export path utilities for backward compatibility
// See packages/server/src/projects/paths.ts for full documentation on encoding schemes
export { decodeProjectId, encodeProjectId } from "../projects/paths.js";

// Re-export shared types used by server
export type {
  ContextUsage,
  InputRequest,
  PendingInputType,
  ProcessStateType,
} from "@yep-anywhere/shared";

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
  provider: ProviderName; // which provider's sessions are in this project
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
  /** AI provider used for this session */
  provider: ProviderName;
  /** Model used for this session (extracted from JSONL, e.g. "claude-opus-4-5-20251101") */
  model?: string;
}

/**
 * Content block in messages - loosely typed to preserve all fields.
 * This is the server's internal representation for JSONL parsing.
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
 *
 * Note: Use `uuid` for message identification. The `message.content` nested
 * field contains the actual content. Use `type` for discrimination (user/assistant).
 */
export interface Message {
  type: string;
  uuid?: string;
  timestamp?: string;
  // DAG structure
  parentUuid?: string | null;
  // Nested message structure from SDK
  message?: {
    content?: string | ContentBlock[];
    role?: string;
    [key: string]: unknown;
  };
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

// Process state machine
export type ProcessState =
  | { type: "running" }
  | { type: "idle"; since: Date }
  | { type: "waiting-input"; request: InputRequest }
  | { type: "hold"; since: Date }
  | { type: "terminated"; reason: string; error?: Error };

// Process info (for API responses)
export interface ProcessInfo {
  id: string;
  sessionId: string;
  projectId: UrlProjectId;
  projectPath: string;
  projectName: string; // path.basename(projectPath)
  sessionTitle: string | null; // from session data
  state: ProcessStateType;
  startedAt: string;
  queueDepth: number;
  idleSince?: string; // ISO timestamp when entered idle
  holdSince?: string; // ISO timestamp when entered hold
  terminationReason?: string; // why it terminated
  terminatedAt?: string; // when it terminated (ISO timestamp)
  provider: ProviderName; // which provider is running this process
  /** Max thinking tokens this process was created with (undefined = thinking disabled) */
  maxThinkingTokens?: number;
  /** Model used for this session (e.g., "claude-opus-4-5-20251101") */
  model?: string;
}

// Process events for subscribers
export type ProcessEvent =
  | { type: "message"; message: SDKMessage }
  | { type: "state-change"; state: ProcessState }
  | { type: "mode-change"; mode: PermissionMode; version: number }
  | { type: "session-id-changed"; oldSessionId: string; newSessionId: string }
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
  provider: ProviderName; // which provider is running this process
  /** Max thinking tokens this process was created with (undefined = thinking disabled) */
  maxThinkingTokens?: number;
}
