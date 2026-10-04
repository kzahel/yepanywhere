import type { ModelInfo, ThinkingOption } from "./types.js";

export interface AgentAuthRouterStatus {
  state: "pairing" | "connected" | "revocation-pending" | "disconnected";
  routerId: string | null;
}

export type AgentAuthRouterIssueCode =
  | "unavailable"
  | "revoked"
  | "identity-mismatch"
  | "protocol-mismatch"
  | "unsafe-socket"
  | "unsupported"
  | "account-unavailable"
  | "operation-rejected";

export interface AgentAuthRouterAccount {
  displayName?: string;
  directAccountAccess?: boolean;
  id: string;
  provider: "claude" | "codex";
  enabled: boolean;
  renewal: string;
}

/** Owner-only, on-demand observation. Contains no socket paths or credentials. */
export interface AgentAuthRouterRecovery extends AgentAuthRouterStatus {
  checkedAt: string;
  reachable: boolean | null;
  pendingCancellations: number;
  accounts: AgentAuthRouterAccount[];
  issue?: { code: AgentAuthRouterIssueCode; message: string };
}

export type AgentAuthRouterPoolPolicy =
  | "manual"
  | "round-robin"
  | "most-remaining";
export interface AgentAuthRouterPool {
  id: string;
  name: string;
  provider: "claude" | "codex";
  accountIds: string[];
  policy: AgentAuthRouterPoolPolicy;
  revision: number;
  bindings: { accountId: string; count: number }[];
}
export type AgentAuthRouterPoolInput = Omit<AgentAuthRouterPool, "bindings">;
export interface AgentAuthRouterOverview {
  /** False for router-owned pools. Absent on legacy servers/routers. */
  canManagePools?: boolean;
  supportedPolicies?: AgentAuthRouterPoolPolicy[];
  admissionRefresh?: boolean;
  observedAt: string;
  quotaFreshSeconds: number;
  pools: AgentAuthRouterPool[];
  accounts: (AgentAuthRouterAccount & {
    freshness: "fresh" | "stale" | "unknown";
    models: ModelInfo[];
    catalogAt: string | null;
    attemptedAt: string | null;
    error: string | null;
    blocked?: "auth-unavailable" | "cooldown";
    cooldownUntil?: string;
    quota: { observedAt: string } | null;
    windows: {
      bucket: string;
      windowMinutes: number | null;
      usedPercent: number | null;
      remainingPercent: number | null;
      resetsAt: string | null;
      scope: "all" | "opus" | "sonnet" | "unknown";
    }[];
  })[];
  selection?: {
    poolId: string;
    policy?: AgentAuthRouterPoolPolicy;
    model: string | null;
    decisions: {
      accountId: string;
      reason: string;
      evidence?: {
        headroomPercent: number | null;
        limitingBuckets: string[];
        reservations: number;
        catalogAt: string | null;
        quotaAt: string | null;
      };
    }[];
  };
}

/** Explicit effort must come from the selected account, never the direct login. */
export function routerModelSupportsThinking(
  model: ModelInfo | undefined,
  thinking: ThinkingOption = "auto",
): boolean {
  if (!model) return false;
  if (thinking === "auto" || thinking === "off") return true;
  if (
    model.supportsEffort === false ||
    model.supportsAdaptiveThinking === false
  )
    return false;
  const effort = thinking.replace(/^on:/, "");
  return !!model.supportedReasoningEfforts?.some(
    (r) =>
      r.reasoningEffort === effort ||
      (effort === "max" && r.reasoningEffort === "ultra"),
  );
}

/** Resolve only ordinary family aliases, never composite modes or arbitrary names. */
export function resolveRouterModel(
  model: string | null | undefined,
  models: readonly ModelInfo[],
): string | undefined {
  if (!model) return undefined;
  if (models.some((m) => m.id === model)) return model;
  if (!["opus", "sonnet", "haiku", "fable"].includes(model)) return undefined;
  return models
    .filter((m) => m.id.startsWith(`claude-${model}-`))
    .sort((a, b) => b.id.localeCompare(a.id, "en", { numeric: true }))[0]?.id;
}
