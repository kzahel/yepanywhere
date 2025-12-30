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
  | { state: "owned"; processId: string } // we control it
  | { state: "external" }; // another process owns it

// Session metadata (light, for lists)
export interface SessionSummary {
  id: string;
  projectId: string;
  title: string | null; // first 50 chars of first user message
  createdAt: string; // ISO timestamp
  updatedAt: string;
  messageCount: number;
  status: SessionStatus;
}

// Content block in messages
export interface ContentBlock {
  type: "text" | "thinking" | "tool_use" | "tool_result";
  // text block
  text?: string;
  // thinking block
  thinking?: string;
  signature?: string; // Never rendered (but preserved for completeness)
  // tool_use block
  id?: string;
  name?: string;
  input?: unknown;
  // tool_result block
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
}

// Message representation
export interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string | ContentBlock[];
  timestamp: string;
  toolUse?: {
    id: string;
    name: string;
    input: unknown;
  };
  /** Structured tool result data (from JSONL toolUseResult field) */
  toolUseResult?: unknown;
  /** Raw JSONL entry for debugging (visible via ctrl+click) */
  rawJsonl?: unknown;
}

// Full session with messages
export interface Session extends SessionSummary {
  messages: Message[];
}

// Process state types
export type ProcessStateType = "running" | "idle" | "waiting-input";

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
  | { type: "waiting-input"; request: InputRequest };

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
  | { type: "error"; error: Error }
  | { type: "complete" };

// Process options
export interface ProcessOptions {
  projectPath: string;
  projectId: string;
  sessionId: string;
  idleTimeoutMs?: number; // default 5 minutes
  permissionMode?: PermissionMode;
}
