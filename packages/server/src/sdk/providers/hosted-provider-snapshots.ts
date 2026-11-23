import { normalizeProviderWorkItems } from "@yep-anywhere/shared";
import type {
  ProviderActivitySnapshot,
  ProviderRetentionSnapshot,
} from "../types.js";

/**
 * A worker's activity and retention snapshots as Hono receives them, as
 * JSON: dates revived, work items normalized.
 */
export function reviveActivity(
  value: ProviderActivitySnapshot | undefined,
): ProviderActivitySnapshot {
  return {
    lastRawProviderEventAt: value?.lastRawProviderEventAt
      ? new Date(value.lastRawProviderEventAt)
      : null,
    lastRawProviderEventSource: value?.lastRawProviderEventSource ?? null,
  };
}

export function reviveRetention(
  value: ProviderRetentionSnapshot | undefined,
): ProviderRetentionSnapshot {
  return {
    retained: value?.retained ?? false,
    reasons: value?.reasons ?? [],
    backgroundTaskCount: value?.backgroundTaskCount,
    sessionCronCount: value?.sessionCronCount,
    liveTaskCount: value?.liveTaskCount,
    lastUpdatedAt: value?.lastUpdatedAt ? new Date(value.lastUpdatedAt) : null,
    backgroundWork: normalizeProviderWorkItems(value?.backgroundWork),
    foregroundWaits: normalizeProviderWorkItems(value?.foregroundWaits),
  };
}
