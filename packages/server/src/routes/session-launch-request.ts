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
import { getProvider } from "../sdk/providers/index.js";
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

export interface RestartSessionBody extends CreateSessionBody {
  reason?: string;
  /**
   * "handoff" (default): start a fresh session seeded with a bounded
   * transcript summary. "fork": copy the provider transcript into a new
   * session (real prefix fork; provider must support it — Claude today)
   * and continue there.
   */
  restartMode?: "handoff" | "fork";
  /**
   * Fork slice point: transcript message UUID (inclusive). Omit for a
   * full-transcript fork. Only meaningful with restartMode "fork".
   */
  forkUpToMessageId?: string;
  /**
   * The client URL the user was viewing when they triggered the handoff.
   * Surfaced in the handoff's Source Session block as a self-documenting,
   * clickable pointer back to the source session. Validated server-side.
   */
  sourceUrl?: string;
  /**
   * The handoff message to seed the successor with, replacing the text this
   * route would otherwise build. Set when the user edited the draft the
   * preview route returned. Ignored by "fork", which copies the real
   * transcript instead of sending a message.
   */
  handoffText?: string;
}

export function parseOptionalRestartSessionBody(
  rawBody: string,
): { body: RestartSessionBody } | { error: string } {
  const parsed = parseOptionalJsonObjectBody(rawBody);
  if ("error" in parsed) return parsed;
  const body = parsed.body;
  if (
    body.restartMode !== undefined &&
    body.restartMode !== "handoff" &&
    body.restartMode !== "fork"
  ) {
    return { error: 'restartMode must be "handoff" or "fork"' };
  }
  for (const [field, label] of [
    ["reason", "reason"],
    ["forkUpToMessageId", "forkUpToMessageId"],
    ["sourceUrl", "sourceUrl"],
    ["model", "model"],
  ] as const) {
    if (body[field] !== undefined && typeof body[field] !== "string") {
      return { error: `${label} must be a string` };
    }
  }
  if (
    body.provider !== undefined &&
    (typeof body.provider !== "string" ||
      !getProvider(body.provider as ProviderName))
  ) {
    return { error: "Invalid provider" };
  }

  return { body: body as RestartSessionBody };
}
