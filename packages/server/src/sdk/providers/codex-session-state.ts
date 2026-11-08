/**
 * Codex session state shared by the provider's session loop, the session
 * object and the provider commands.
 */

import type { EffortLevel, PermissionMode } from "@yep-anywhere/shared";
import type {
  SkillMetadata,
  ThreadGoalSetResponse,
} from "./codex-protocol/index.js";
import type { SandboxPolicy as CodexSandboxPolicy } from "./codex-protocol/generated/v2/SandboxPolicy.js";
import type { TokenUsageSnapshot } from "./codex-live-event-conversion.js";

export const ACCOUNT_RATE_LIMITS_TIMEOUT_MS = 8000;

export async function withCodexTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    timeout.unref?.();
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export interface CodexTurnRuntimeState {
  steeringMode?: import("@yep-anywhere/shared").SteeringMode;
  threadId: string;
  goalObjective?: string | null;
  goalStatus?: ThreadGoalSetResponse["goal"]["status"] | null;
  resolvedModel: string;
  turnModelOverride: string | null;
  latestTokenUsage?: TokenUsageSnapshot;
  activeTurnId: string | null;
  pendingTurnStart: Promise<string | null> | null;
  pendingCompaction?: {
    retryAttempt: number;
    requestAccepted: Promise<boolean>;
  };
  overloadRetryController?: AbortController;
  /** Signed-in account identity that scopes cyber access denials. */
  cyberAccessAccountKey?: string;
  activePermissionMode: PermissionMode;
  turnEffortOverride: EffortLevel | null | undefined;
  activeTurnHasEffortOverride?: boolean;
  /** Launch tier, or the live selection; null is an explicit Standard. */
  serviceTier: string | null | undefined;
  workspaceWriteSandboxPolicy: CodexSandboxPolicy | null;
  activeToolCallIds: Set<string>;
  backgroundToolCallIds: Set<string>;
  /** MCP App hosting as configured when this session's app-server started. */
  mcpAppViews: boolean;
  /** Latest `ui/update-model-context` per MCP App view, sent before the next turn. */
  mcpAppModelContext: Map<
    string,
    { server: string; tool: string; text: string }
  >;
}

export interface CodexSessionSkillInventory {
  skills: SkillMetadata[];
  stale: boolean;
}
