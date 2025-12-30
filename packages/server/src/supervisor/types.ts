import type { PermissionMode, SDKMessage } from "../sdk/types.js";

// Constants
export const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
export const SESSION_TITLE_MAX_LENGTH = 50;

// Re-export path utilities for backward compatibility
// See packages/server/src/projects/paths.ts for full documentation on encoding schemes
export { decodeProjectId, encodeProjectId } from "../projects/paths.js";

// Project discovery
export interface Project {
  id: string; // base64url encoded path
  path: string; // absolute path
  name: string; // directory name
  sessionCount: number;
  sessionDir: string; // path to session directory (e.g., ~/.claude/projects/hostname/-encoded-path/)
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
  projectId: string;
  title: string | null; // first 50 chars of first user message (truncated with ...)
  fullTitle: string | null; // complete first user message (for hover tooltip)
  createdAt: string; // ISO timestamp
  updatedAt: string;
  messageCount: number;
  status: SessionStatus;
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
  projectId: string;
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
  projectId: string;
  sessionId: string;
  idleTimeoutMs?: number; // default 5 minutes
  permissionMode?: PermissionMode;
}
