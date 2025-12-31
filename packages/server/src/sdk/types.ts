// Core types for Claude SDK abstraction

// Re-export PermissionMode from shared
export type { PermissionMode } from "@claude-anywhere/shared";
import type { PermissionMode, UploadedFile } from "@claude-anywhere/shared";

export interface ContentBlock {
  type: "text" | "tool_use" | "tool_result" | "image";
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

/**
 * SDK Message - loosely typed to preserve all fields from the SDK.
 *
 * We intentionally use a loose type here to:
 * 1. Pass through all SDK fields without stripping
 * 2. Allow frontend to inspect any field for debugging
 * 3. Avoid breaking when SDK adds new fields
 *
 * Known fields are documented but not enforced.
 */
export interface SDKMessage {
  type: string;
  uuid?: string;
  subtype?: string;
  session_id?: string;
  timestamp?: string;
  message?: {
    content: string | ContentBlock[];
    role?: string;
  };
  // DAG structure
  parentUuid?: string | null;
  parent_tool_use_id?: string;
  // Message origin flags
  isSynthetic?: boolean;
  isReplay?: boolean;
  userType?: string;
  // Tool use related
  tool_use_id?: string;
  tool_name?: string;
  tool_input?: unknown;
  toolUseResult?: unknown;
  // Input requests (tool approval, questions, etc.)
  input_request?: {
    id: string;
    type: "tool-approval" | "question" | "choice";
    prompt: string;
    options?: string[];
  };
  // Result metadata
  duration_ms?: number;
  duration_api_ms?: number;
  total_cost_usd?: number;
  usage?: unknown;
  modelUsage?: unknown;
  num_turns?: number;
  // Error info
  error?: unknown;
  // Allow any additional fields from SDK
  [key: string]: unknown;
}

export interface UserMessage {
  text: string;
  images?: string[]; // base64 or file paths
  documents?: string[];
  /** File attachments with paths for agent to access via Read tool */
  attachments?: UploadedFile[];
  mode?: PermissionMode;
  /** UUID to use for this message. If not provided, SDK will generate one. */
  uuid?: string;
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

export interface ToolApprovalResult {
  behavior: "allow" | "deny";
  updatedInput?: unknown;
  message?: string;
  /**
   * If true, interrupt execution and do not continue.
   * Set to true when user denies without guidance (just clicks "No").
   * Leave false/unset when user provides feedback for Claude to incorporate.
   */
  interrupt?: boolean;
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
