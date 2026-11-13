// Core types for Claude SDK abstraction

// Re-export PermissionMode from shared
export type { PermissionMode } from "@yep-anywhere/shared";
import type {
  CodexAsyncUserInputQuestion,
  PermissionMode,
  ProviderWorkItem,
  SessionLivenessProbeStatus,
  ToolDisplayAction,
  ToolResultMedia,
  UploadedFile,
  UserMessageMetadata,
} from "@yep-anywhere/shared";

export interface ContentBlock {
  type: "text" | "tool_use" | "tool_result" | "image" | "thinking";
  text?: string;
  /** For thinking blocks */
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  /** YA-derived presentation semantics; recomputed rather than persisted. */
  _displayActions?: ToolDisplayAction[];
  /** For tool_result blocks - references the tool_use id */
  tool_use_id?: string;
  /** For tool_result blocks - the result content */
  content?: string;
  /** For tool_result blocks - true when the tool failed */
  is_error?: boolean;
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
  /** Pinned Claude native reply-to-input evidence, absent on older producers. */
  user_message_uuid?: string;
  user_message_uuids?: string[];
  timestamp?: string;
  message?: {
    content: string | ContentBlock[];
    role?: string;
    /** Resolved model name from API response (e.g., "claude-sonnet-4-5-20250929") */
    model?: string;
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
  /** Private live evidence: Codex verified this command frame's native owner. */
  _codexOwnedCommand?: boolean;
  toolResultMedia?: ToolResultMedia[];
  // Input requests (tool approval, questions, etc.)
  input_request?: {
    id: string;
    type: "tool-approval" | "question" | "choice";
    prompt: string;
    options?: string[];
    toolName?: string;
    toolInput?: unknown;
  };
  /** Codex agent message delivered while its originating turn kept running. */
  codexAgentMessageDelivery?: "async";
  /** Structured questions attached to an asynchronous Codex agent message. */
  codexAsyncQuestions?: CodexAsyncUserInputQuestion[];
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

export type TimestampedSDKMessage<T extends SDKMessage = SDKMessage> = T & {
  timestamp: string;
};

export interface UserMessage {
  /** Server-owned queue control; never accepted from client message JSON. */
  queuedCompact?: { command: "compact"; argument: string };
  text: string;
  /** YA-internal automatic-turn source; never treated as fresh user intent. */
  automaticSource?: "project-queue" | "wake" | "instruction-restoration";
  /** YA-internal guard so deferred/recovered delivery is not re-accepted. */
  recapResumeHandled?: true;
  images?: string[]; // base64 or file paths
  documents?: string[];
  /** File attachments with paths for agent to access via Read tool */
  attachments?: UploadedFile[];
  mode?: PermissionMode;
  /** UUID to use for this message. If not provided, SDK will generate one. */
  uuid?: string;
  /** Client-generated temp ID for optimistic UI tracking. Echoed back in SSE. */
  tempId?: string;
  /**
   * Temp IDs of every chunk merged into this message (set by concatUserMessages
   * when a queued batch is bundled into one turn). Echoed back so the client can
   * clear all delivered queued chips by identity, not by re-matching turn text.
   */
  tempIds?: string[];
  /** YA-internal submission timing and delivery-intent metadata. */
  metadata?: UserMessageMetadata;
  /**
   * Claude CLI command-queue lane for this message ("now" aborts in-flight
   * sampling; "next" delivers after the current tool batch; "later" waits
   * for end of turn). Forwarded on the SDKUserMessage; other providers
   * ignore it. See topics/steer-queue-provider-differences.md.
   */
  priority?: "now" | "next" | "later";
}

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
  options: {
    signal: AbortSignal;
    /**
     * Provider-frozen mode for the turn that issued this request.
     * Falls back to the Process's current mode when omitted.
     */
    permissionMode?: PermissionMode;
  },
) => Promise<ToolApprovalResult>;

export interface ProviderLivenessProbeResult {
  status: SessionLivenessProbeStatus;
  source: string;
  detail?: string;
  checkedAt?: Date;
}

export interface ProviderActivitySnapshot {
  lastRawProviderEventAt?: Date | null;
  lastRawProviderEventSource?: string | null;
}

export interface ProviderRetentionSnapshot {
  retained: boolean;
  reasons: string[];
  backgroundTaskCount?: number;
  sessionCronCount?: number;
  liveTaskCount?: number;
  lastUpdatedAt?: Date | null;
  /** Recorded independently of `retained`; Codex work never retains. */
  backgroundWork?: ProviderWorkItem[];
  foregroundWaits?: ProviderWorkItem[];
}

export interface ProviderCommandOutput {
  /** Collapsed local-command row label. */
  summary: string;
  /** Expandable preformatted result sections. */
  details?: string[];
}

export interface ProviderCommandResult {
  /**
   * True when the provider owns this command and attempted to dispatch it
   * (whether or not it succeeded). False means "not a native command here" and
   * the caller should fall back to normal message delivery.
   */
  handled: boolean;
  /** Set when `handled` is true but the native dispatch failed. */
  error?: string;
  /** Dispatch transport failed without a definitive provider refusal. */
  uncertain?: true;
  /** Native work and persistence are confirmed complete and subsequent input is safe.
   * Omit for dispatch acknowledgements whose completion arrives on the event stream.
   */
  completion?: "completed";
  /** Optional YA-local result to publish without creating a provider turn. */
  output?: ProviderCommandOutput;
  /** Hidden slash-command line YA sent the provider while running this. */
  providerCommandText?: string;
}
