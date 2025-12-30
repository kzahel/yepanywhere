// Shared types for the client - copied from server to avoid coupling
// TODO: Consider a shared package if these drift

export type PermissionMode =
  | "default"
  | "bypassPermissions"
  | "acceptEdits"
  | "plan";

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

export type SessionStatus =
  | { state: "idle" }
  | { state: "owned"; processId: string }
  | { state: "external" };

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
}

export interface Session extends SessionSummary {
  messages: Message[];
}
