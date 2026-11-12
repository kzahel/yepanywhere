import type {
  ApiSelection,
  ApiSessionInspection,
} from "../../packages/server/src/core-api/selection-contracts.js";
import type { CreateSessionRequest } from "../../packages/server/src/core-api/command-contracts.js";
import { thinkingOptionToConfig } from "../../packages/shared/src/types.js";

/** Fixed domain truth; the worker's inspection is derived from submitted controls. */
export const selection: ApiSelection = {
  provider: "codex",
  routing: "aar",
  available: true,
  observedAt: "2026-11-12T00:00:00Z",
  serviceTierSelection: true,
  policies: [{ id: "weekly-pace", label: "Weekly pace" }],
  pools: [
    {
      id: "release-pool",
      name: "Release pool",
      provider: "codex",
      accountIds: ["release-account"],
      policy: "weekly-pace",
      revision: 1,
    },
  ],
  accounts: [
    {
      id: "release-account",
      displayName: "Release account",
      provider: "codex",
      enabled: true,
      freshness: "fresh",
      catalogAt: null,
      models: [
        {
          id: "release-model",
          name: "Release model",
          supportedEffortLevels: ["low", "high"],
          serviceTiers: [{ id: "priority", name: "Fast" }],
        },
      ],
    },
  ],
};
export function selectedInspection(
  request: CreateSessionRequest,
): ApiSessionInspection {
  const converted = request.thinking
    ? thinkingOptionToConfig(request.thinking)
    : undefined;
  return {
    settings: {
      source: "live",
      requestedModel: request.model ?? null,
      model: request.model ?? null,
      thinking: converted?.thinking ?? null,
      effort: converted?.effort ?? null,
      permissionMode: request.permissionMode,
      serviceTier: request.serviceTier ?? null,
      revision: 1,
    },
    routing: request.routerPoolId
      ? {
          mode: "aar",
          routerId: "fixture-router",
          poolId: request.routerPoolId,
          accountId: "release-account",
          policy: request.routerPolicy ?? "weekly-pace",
        }
      : { mode: "direct" },
  };
}
export function correctSelection(value: ApiSessionInspection | undefined) {
  return (
    value?.settings.requestedModel === "release-model" &&
    value.settings.model === "release-model" &&
    value.settings.effort === "high" &&
    value.settings.serviceTier === "priority" &&
    value.settings.permissionMode === "plan" &&
    value.routing.mode === "aar" &&
    value.routing.poolId === "release-pool" &&
    value.routing.accountId === "release-account"
  );
}
