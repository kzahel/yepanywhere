import type { ProviderName } from "./types.js";

export type ProviderSubscriptionUsageScope =
  | {
      type: "provider";
      /** A provider-wide sub-bucket, when it is narrower than all account use. */
      category?: "oauthApps";
    }
  | {
      type: "models";
      /** YA model ids to which this provider bucket applies. */
      modelIds: string[];
      /** Provider-supplied bucket/model label for display and diagnostics. */
      label?: string;
    };

export interface ProviderSubscriptionUsageWindow {
  /** Stable within one provider response; opaque to clients. */
  id: string;
  /** Provider-reported utilization, normalized to the inclusive 0-100 range. */
  usedPercent: number;
  /** Included allowance remaining relative to this provider's USD 200 plan. */
  remainingCapacityUnits?: number | null;
  /** Rolling-window duration when the provider reports or defines it. */
  windowDurationMinutes?: number;
  /** ISO 8601 reset timestamp when the provider reports one. */
  resetsAt?: string;
  scope: ProviderSubscriptionUsageScope;
}

/**
 * Read-only account/subscription quota state. This is separate from session
 * token accounting: it may combine provider-wide and model-specific windows.
 */
export interface ProviderSubscriptionUsage {
  provider: ProviderName;
  windows: ProviderSubscriptionUsageWindow[];
  fetchedAt: string;
  accountLabel?: string;
  ordinaryUsageAllowed?: boolean;
}

export function getApplicableSubscriptionUsageWindows(
  usage: ProviderSubscriptionUsage | null | undefined,
  modelId?: string | null,
): ProviderSubscriptionUsageWindow[] {
  if (!usage) return [];
  return usage.windows.filter(
    (window) =>
      window.scope.type === "provider" ||
      (!!modelId && window.scope.modelIds.includes(modelId)),
  );
}

/**
 * Return the binding quota window for a model: maximum percent used, which is
 * equivalently the smallest remaining capacity.
 */
export function getMostUsedSubscriptionUsageWindow(
  usage: ProviderSubscriptionUsage | null | undefined,
  modelId?: string | null,
): ProviderSubscriptionUsageWindow | null {
  const applicable = getApplicableSubscriptionUsageWindows(usage, modelId);
  let mostUsed: ProviderSubscriptionUsageWindow | null = null;
  for (const window of applicable) {
    if (!mostUsed || window.usedPercent > mostUsed.usedPercent) {
      mostUsed = window;
    }
  }
  return mostUsed;
}
