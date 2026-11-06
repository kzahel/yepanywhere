import {
  ALL_PERMISSION_MODES,
  type PermissionRules,
  type PromptSuggestionMode,
  type ProviderName,
  type RecapMode,
  type SessionCreationProvenance,
  type SessionSandboxLevel,
  type ShowThinking,
  type StagedAttachmentRef,
  type ThinkingOption,
  type UploadedFile,
  type UserMessageMetadata,
} from "@yep-anywhere/shared";
import type { PermissionMode } from "../sdk/types.js";
import type { ResumeMode } from "../supervisor/Supervisor.js";

export function permissionModeError(mode: unknown): string | undefined {
  if (
    mode !== undefined &&
    !ALL_PERMISSION_MODES.includes(mode as PermissionMode)
  ) {
    return "Invalid permission mode";
  }
  return undefined;
}

export interface StartSessionBody {
  intent?: "prepare";
  requestId?: string;
  stagedAttachments?: StagedAttachmentRef[];
  routerAccountId?: string;
  routerPoolId?: string;
  routerPolicy?: string;
  routerClaudeAiConnectors?: boolean;
  creationProvenance?: SessionCreationProvenance;
  computerControl?: boolean;
  machineControl?: boolean;
  message: string;
  images?: string[];
  documents?: string[];
  attachments?: UploadedFile[];
  mode?: PermissionMode;
  model?: string;
  serviceTier?: string;
  thinking?: ThinkingOption;
  /** Display preference for thinking rows (default/on/off). */
  showThinking?: ShowThinking;
  provider?: ProviderName;
  /** Browser-side timestamp for request latency tracking (epoch ms) */
  clientTimestamp?: number;
  /** YA-internal submission timing and delivery-intent metadata. */
  messageMetadata?: UserMessageMetadata;
  /** Client-generated temp ID for optimistic UI tracking */
  tempId?: string;
  /** SSH host alias for remote execution (undefined = local) */
  executor?: string;
  /** Default-off YA host filesystem confinement settled at session creation. */
  sandboxLevel?: SessionSandboxLevel;
  /** Public-only egress boundary for a project-write session. */
  sandboxNetworkFirewall?: boolean;
  /** Permission rules for tool filtering (deny/allow patterns) */
  permissions?: PermissionRules;
  /** Session recap behavior for future away-return triggers. */
  recapMode?: RecapMode;
  /** Browser-away duration before YA asks this session for a recap. */
  recapAfterSeconds?: number;
  /** Prompt suggestion behavior for this session. */
  promptSuggestionMode?: PromptSuggestionMode;
  /** Session-level helper side model for simulated helper features. */
  helperSideModel?: string;
  /** Resume strategy for existing sessions. */
  resumeMode?: ResumeMode;
  /** Removed lane target: explicit stale-client requests are refused. */
  workstreamId?: unknown;
}

export function hasSessionMessageContent(body: StartSessionBody): boolean {
  return (
    typeof body.message === "string" &&
    (body.message.length > 0 ||
      (Array.isArray(body.attachments) && body.attachments.length > 0) ||
      (Array.isArray(body.stagedAttachments) &&
        body.stagedAttachments.length > 0))
  );
}

export interface CreateSessionBody {
  routerAccountId?: string;
  routerPoolId?: string;
  routerPolicy?: string;
  routerClaudeAiConnectors?: boolean;
  creationProvenance?: SessionCreationProvenance;
  computerControl?: boolean;
  machineControl?: boolean;
  mode?: PermissionMode;
  model?: string;
  serviceTier?: string;
  thinking?: ThinkingOption;
  /** Display preference for thinking rows (default/on/off). */
  showThinking?: ShowThinking;
  provider?: ProviderName;
  /** SSH host alias for remote execution (undefined = local) */
  executor?: string;
  /** Default-off YA host filesystem confinement settled at session creation. */
  sandboxLevel?: SessionSandboxLevel;
  /** Public-only egress boundary for a project-write session. */
  sandboxNetworkFirewall?: boolean;
  /** Permission rules for tool filtering (deny/allow patterns) */
  permissions?: PermissionRules;
  /** Session recap behavior for future away-return triggers. */
  recapMode?: RecapMode;
  /** Browser-away duration before YA asks this session for a recap. */
  recapAfterSeconds?: number;
  /** Prompt suggestion behavior for this session. */
  promptSuggestionMode?: PromptSuggestionMode;
  /** Session-level helper side model for simulated helper features. */
  helperSideModel?: string;
  /** Removed lane target: explicit stale-client requests are refused. */
  workstreamId?: unknown;
}

export function parseOptionalJsonObjectBody(
  rawBody: string,
): { body: Record<string, unknown> } | { error: string } {
  if (rawBody.trim().length === 0) return { body: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { error: "Invalid JSON body" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: "Invalid JSON body" };
  }
  return { body: parsed as Record<string, unknown> };
}
