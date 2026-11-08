import type { PermissionMode } from "@yep-anywhere/shared";
import type { SessionSandboxRuntime } from "../../session-sandbox.js";
import type { ProviderForkOptions, StartSessionOptions } from "./types.js";
import type {
  AskForApproval as CodexAskForApproval,
  SandboxMode as CodexSandboxMode,
  ThreadItem as CodexThreadItem,
  ThreadReadParams,
  ThreadReadResponse,
  ThreadStartParams,
  TurnStartParams,
} from "./codex-protocol/index.js";
import type { SandboxPolicy as CodexSandboxPolicy } from "./codex-protocol/generated/v2/SandboxPolicy.js";
import type { CodexAppServerClient } from "./codex-app-server-client.js";
import { getOptionalString } from "./codex-item-conversion.js";

/**
 * Local debug knobs for Codex app-server policy behavior.
 *
 * Set `approvalPolicy` to `"untrusted"` to force Codex to request approval for
 * command/file actions more aggressively, even when `"on-request"` would not.
 * Leave as `null` for normal behavior.
 */
export const CODEX_POLICY_OVERRIDES: {
  approvalPolicy: CodexAskForApproval | null;
  sandbox: CodexSandboxMode | null;
} = {
  approvalPolicy: null,
  sandbox: null,
};

export interface CodexThreadPolicy {
  approvalPolicy: CodexAskForApproval;
  sandbox: CodexSandboxMode;
}

export type CodexThreadTurn = ThreadReadResponse["thread"]["turns"][number];

interface CodexForkAnchor {
  turnIndex: number;
  itemIndex: number | null;
}

export function mapPermissionModeToThreadPolicy(
  permissionMode?: StartSessionOptions["permissionMode"],
): CodexThreadPolicy {
  const applyOverrides = (policy: CodexThreadPolicy): CodexThreadPolicy => ({
    approvalPolicy:
      CODEX_POLICY_OVERRIDES.approvalPolicy ?? policy.approvalPolicy,
    sandbox: CODEX_POLICY_OVERRIDES.sandbox ?? policy.sandbox,
  });

  if (permissionMode === "bypassPermissions") {
    return applyOverrides({
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
  }

  if (permissionMode === "plan") {
    return applyOverrides({
      approvalPolicy: "on-request",
      sandbox: "read-only",
    });
  }

  return applyOverrides({
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
  });
}

export function normalizePermissionMode(
  permissionMode?: StartSessionOptions["permissionMode"],
): PermissionMode {
  return permissionMode && permissionMode !== "auto"
    ? permissionMode
    : "default";
}

function mapThreadSandboxToTurnSandbox(
  sandbox: CodexSandboxMode,
  workspaceWriteSandboxPolicy: CodexSandboxPolicy | null = null,
): CodexSandboxPolicy {
  switch (sandbox) {
    case "danger-full-access":
      return { type: "dangerFullAccess" };
    case "read-only":
      return { type: "readOnly", networkAccess: false };
    case "workspace-write":
      if (workspaceWriteSandboxPolicy?.type === "workspaceWrite") {
        return workspaceWriteSandboxPolicy;
      }
      return {
        type: "workspaceWrite",
        writableRoots: [],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      };
  }
}

export function limitedUserThreadInstructions(
  sandbox?: SessionSandboxRuntime,
): Pick<ThreadStartParams, "developerInstructions"> {
  const instructions = sandbox?.instructions;
  if (!instructions) return {};
  // Saved threads retain their base prompt; editable text must not be frozen into it.
  return { developerInstructions: instructions.text };
}

/** Maps a legacy message-id fork anchor to the last completed turn to keep. */
export async function resolveCodexForkLastTurnId(
  appServer: CodexAppServerClient,
  nativeSessionId: ProviderForkOptions["nativeSessionId"],
  upToMessageId: string,
): Promise<string | undefined> {
  const response = await appServer.request<ThreadReadResponse>("thread/read", {
    threadId: nativeSessionId,
    includeTurns: true,
  } satisfies ThreadReadParams);
  const turns = response.thread.turns ?? [];
  return computeCodexForkLastTurnId(turns, upToMessageId);
}

function computeCodexForkLastTurnId(
  turns: CodexThreadTurn[],
  upToMessageId: string,
): string | undefined {
  const anchor = findCodexForkAnchor(turns, upToMessageId);
  if (!anchor) {
    throw new Error(
      `Codex fork anchor ${upToMessageId} was not found in source thread`,
    );
  }

  if (anchor.itemIndex !== null) {
    const turn = turns[anchor.turnIndex];
    if (!turn) {
      throw new Error(
        `Codex fork anchor ${upToMessageId} resolved to a missing turn`,
      );
    }
    if (anchor.itemIndex < turn.items.length - 1) {
      throw new Error(
        `Codex fork anchor ${upToMessageId} is inside a turn; Codex can only fork at completed turn boundaries`,
      );
    }
  }

  return anchor.turnIndex < turns.length - 1
    ? turns[anchor.turnIndex]?.id
    : undefined;
}

function findCodexForkAnchor(
  turns: CodexThreadTurn[],
  upToMessageId: string,
): CodexForkAnchor | null {
  for (const [turnIndex, turn] of turns.entries()) {
    if (
      turn.id === upToMessageId ||
      `codex-turn-interrupted-${turn.id}` === upToMessageId
    ) {
      return { turnIndex, itemIndex: null };
    }

    for (const [itemIndex, item] of turn.items.entries()) {
      if (codexItemMatchesForkAnchor(item, turn.id, upToMessageId)) {
        return { turnIndex, itemIndex };
      }
    }

    if (`codex-compaction-${turn.id}` === upToMessageId) {
      return { turnIndex, itemIndex: turn.items.length - 1 };
    }
  }
  return null;
}

function codexItemMatchesForkAnchor(
  item: CodexThreadItem,
  turnId: string,
  upToMessageId: string,
): boolean {
  const candidates = new Set<string>();
  candidates.add(item.id);
  candidates.add(`${item.id}-${turnId}`);
  candidates.add(`${item.id}-result`);

  const itemRecord = item as Record<string, unknown>;
  const clientId = getOptionalString(itemRecord.clientId);
  if (clientId) {
    candidates.add(clientId);
    candidates.add(`${clientId}-${turnId}`);
  }

  return candidates.has(upToMessageId);
}

export function buildThreadPermissionParams(
  policy: CodexThreadPolicy,
): Pick<ThreadStartParams, "approvalPolicy" | "sandbox"> {
  return {
    approvalPolicy: policy.approvalPolicy,
    sandbox: policy.sandbox,
  };
}

export function buildTurnPermissionParams(
  policy: CodexThreadPolicy | null,
  workspaceWriteSandboxPolicy: CodexSandboxPolicy | null = null,
): Partial<Pick<TurnStartParams, "approvalPolicy" | "sandboxPolicy">> {
  if (!policy) return {};
  return {
    approvalPolicy: policy.approvalPolicy,
    sandboxPolicy: mapThreadSandboxToTurnSandbox(
      policy.sandbox,
      workspaceWriteSandboxPolicy,
    ),
  };
}
