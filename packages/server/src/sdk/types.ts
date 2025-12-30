// Core types for Claude SDK abstraction

export interface ContentBlock {
  type: "text" | "tool_use" | "tool_result" | "image";
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

export interface SDKMessage {
  type: "system" | "assistant" | "user" | "result" | "error";
  uuid?: string;
  subtype?: string;
  session_id?: string;
  message?: {
    content: string | ContentBlock[];
    role?: string;
  };
  // Tool use related
  tool_use_id?: string;
  tool_name?: string;
  tool_input?: unknown;
  // Input requests (tool approval, questions, etc.)
  input_request?: {
    id: string;
    type: "tool-approval" | "question" | "choice";
    prompt: string;
    options?: string[];
  };
}

export interface UserMessage {
  text: string;
  images?: string[]; // base64 or file paths
  documents?: string[];
  mode?: PermissionMode;
}

export interface SDKSessionOptions {
  cwd: string;
  resume?: string; // session ID to resume
}

// Legacy interface for mock SDK compatibility
export interface ClaudeSDK {
  startSession(options: SDKSessionOptions): AsyncIterableIterator<SDKMessage>;
}

// New interface for real SDK with full features
import type { MessageQueue } from "./messageQueue.js";

export type PermissionMode =
  | "default"
  | "bypassPermissions"
  | "acceptEdits"
  | "plan";

export interface ToolApprovalResult {
  behavior: "allow" | "deny";
  updatedInput?: unknown;
  message?: string;
}

export type CanUseTool = (
  toolName: string,
  input: unknown,
  options: { signal: AbortSignal },
) => Promise<ToolApprovalResult>;

export interface StartSessionOptions {
  cwd: string;
  initialMessage: UserMessage;
  resumeSessionId?: string;
  permissionMode?: PermissionMode;
  onToolApproval?: CanUseTool;
}

export interface StartSessionResult {
  iterator: AsyncIterableIterator<SDKMessage>;
  queue: MessageQueue;
  abort: () => void;
}

export interface RealClaudeSDKInterface {
  startSession(options: StartSessionOptions): Promise<StartSessionResult>;
}
