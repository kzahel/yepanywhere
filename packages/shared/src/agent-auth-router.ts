import type { ModelInfo, ThinkingOption } from "./types.js";

export interface AgentAuthRouterStatus {
  state: "pairing" | "connected" | "revocation-pending" | "disconnected";
  routerId: string | null;
  /**
   * Whether the saved pairing uses a socket other than AAR's default, so the
   * UI can say which without receiving the path. Absent while disconnected
   * and from servers before 2026-10-24.
   */
  customSocket?: boolean;
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

/**
 * An AAR pool policy id. The router owns the set; YA offers whatever it lists
 * in `supportedPolicies`/`policies`. Only "manual" changes YA behavior: it
 * needs an account.
 */
export type AgentAuthRouterPoolPolicy = string;
/** A router policy with the router's English display name. */
export interface AgentAuthRouterPolicyInfo {
  id: AgentAuthRouterPoolPolicy;
  label: string;
}
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
  /** Router display names; absent from routers before 2026-10-11. */
  policies?: AgentAuthRouterPolicyInfo[];
  admissionRefresh?: boolean;
  /** YA and AAR both validate tier-aware account selection. Absent means unavailable. */
  serviceTierSelection?: boolean;
  /**
   * Claude discovery when YA and AAR (`gateway-token-header-v1`) can keep
   * claude.ai connectors in a routed session. `login` is this computer's
   * claude.ai login, null without one. Absent means unavailable.
   */
  claudeAiConnectors?: { login: { email?: string } | null };
  observedAt: string;
  quotaFreshSeconds: number;
  pools: AgentAuthRouterPool[];
  accounts: (AgentAuthRouterAccount & {
    freshness: "fresh" | "stale" | "unknown";
    models: ModelInfo[];
    catalogAt: string | null;
    /**
     * The account's own Claude CLI model rows (AAR `catalog-cli-models-v1`),
     * mapped by YA's server exactly like the direct Claude model list. Absent
     * for Codex, older routers, and accounts whose CLI has not been read yet.
     */
    cliModels?: ModelInfo[];
    cliModelsAt?: string;
    attemptedAt: string | null;
    error: string | null;
    blocked?: "auth-unavailable" | "cooldown";
    cooldownUntil?: string;
    /** `source` is absent from routers without quota-inference-headers-v1. */
    quota: {
      observedAt: string;
      source?: "probe" | "inference";
      ordinaryUsageAllowed?: boolean;
      planType?: string;
      planCapacityUnits?: number;
    } | null;
    windows: {
      bucket: string;
      windowMinutes: number | null;
      usedPercent: number | null;
      remainingPercent: number | null;
      remainingCapacityUnits?: number | null;
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

/**
 * One row of AAR's `cliModels`: the account CLI's `initialize.models` entry,
 * the same shape as the Claude Agent SDK's `supportedModels()` rows.
 */
export interface AgentAuthRouterCliModel {
  value: string;
  displayName: string;
  description?: string;
  resolvedModel?: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: string[];
  supportsAdaptiveThinking?: boolean;
  supportsFastMode?: boolean;
  supportsAutoMode?: boolean;
}

const routerText = (value: unknown, max: number): string | undefined =>
  typeof value === "string" && value.length > 0
    ? value.slice(0, max)
    : undefined;

/**
 * Type-check and bound router-reported CLI rows with the same limits AAR
 * applies. YA does not rely on the router having done so.
 */
export function sanitizeRouterCliModels(
  value: unknown,
): AgentAuthRouterCliModel[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.slice(0, 64).flatMap((entry): AgentAuthRouterCliModel[] => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const row = entry as Record<string, unknown>;
    if (
      typeof row.value !== "string" ||
      !row.value.length ||
      row.value.length > 200
    )
      return [];
    const model: AgentAuthRouterCliModel = {
      value: row.value,
      displayName: routerText(row.displayName, 200) ?? row.value,
    };
    const description = routerText(row.description, 300);
    if (description) model.description = description;
    if (
      typeof row.resolvedModel === "string" &&
      row.resolvedModel.length > 0 &&
      row.resolvedModel.length <= 200
    )
      model.resolvedModel = row.resolvedModel;
    for (const flag of [
      "supportsEffort",
      "supportsAdaptiveThinking",
      "supportsFastMode",
      "supportsAutoMode",
    ] as const) {
      if (typeof row[flag] === "boolean") model[flag] = row[flag];
    }
    if (Array.isArray(row.supportedEffortLevels))
      model.supportedEffortLevels = [
        ...new Set(
          row.supportedEffortLevels
            .slice(0, 16)
            .filter((level): level is string => typeof level === "string")
            .map((level) => level.slice(0, 32)),
        ),
      ];
    return [model];
  });
}

/**
 * The concrete catalog id a CLI row launches. The CLI reports extended-context
 * variants as `<id>[1m]`; router catalogs and admission use the bare id.
 */
export function routerCliModelTarget(model: ModelInfo): string | undefined {
  return model.resolvedModel?.replace(/\[1m\]$/, "") || undefined;
}

/**
 * What each CLI row launches across these accounts: the concrete id they all
 * report, or `null` when they disagree or report none. Empty when no account
 * carries CLI rows, as with routers older than `catalog-cli-models-v1`.
 */
export function routerAliasTargets(
  accounts: readonly { cliModels?: ModelInfo[] }[],
): Map<string, string | null> {
  const targets = new Map<string, string | null>();
  for (const account of accounts)
    for (const model of account.cliModels ?? []) {
      const target = routerCliModelTarget(model) ?? null;
      const previous = targets.get(model.id);
      targets.set(
        model.id,
        previous === undefined || previous === target ? target : null,
      );
    }
  return targets;
}

/**
 * Resolve a selection to a concrete catalog id. With CLI rows (`aliases`
 * non-empty) only the accounts' reported targets count; without them, only
 * ordinary family aliases are guessed, never composite modes or arbitrary
 * names.
 */
export function resolveRouterModel(
  model: string | null | undefined,
  models: readonly ModelInfo[],
  aliases: ReadonlyMap<string, string | null> = new Map(),
): string | undefined {
  if (!model) return undefined;
  if (models.some((m) => m.id === model)) return model;
  if (aliases.size) {
    const target = aliases.get(model);
    return target && models.some((m) => m.id === target) ? target : undefined;
  }
  if (!["opus", "sonnet", "haiku", "fable"].includes(model)) return undefined;
  return models
    .filter((m) => m.id.startsWith(`claude-${model}-`))
    .sort((a, b) => b.id.localeCompare(a.id, "en", { numeric: true }))[0]?.id;
}

/** Tier availability belongs to the pinned account and exact model. */
export function routerModelSupportsServiceTier(
  model: ModelInfo | undefined,
  tier?: string | null,
): boolean {
  return (
    !!model &&
    (!tier ||
      tier === "default" ||
      !!model.serviceTiers?.some((t) => t.id === tier))
  );
}
