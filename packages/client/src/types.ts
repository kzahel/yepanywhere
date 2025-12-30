// Re-export shared types
export type { PermissionMode, SessionStatus } from "@claude-anywhere/shared";
import type { SessionStatus } from "@claude-anywhere/shared";

export interface Project {
  id: string;
  path: string;
  name: string;
  sessionCount: number;
}

export interface SessionSummary {
  id: string;
  projectId: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  status: SessionStatus;
}

export interface ContentBlock {
  type: "text" | "thinking" | "tool_use" | "tool_result" | "image";
  text?: string;
  // thinking block
  thinking?: string;
  // tool_use block
  id?: string;
  name?: string;
  input?: unknown;
  // tool_result block
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
}

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
  /** Tool use IDs that are orphaned (process killed before result) */
  orphanedToolUseIds?: string[];
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
