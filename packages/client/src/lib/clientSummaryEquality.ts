/**
 * Structural equality checks the client summary store uses to keep unchanged
 * snapshots referentially stable.
 */
import type {
  ProjectQueueDispatchState,
  ProjectQueueItemSummary,
  ProjectQueueProjectStatus,
  ProjectQueueRecoveredSessionQueueSummary,
  ProviderRuntimeStatus,
} from "@yep-anywhere/shared";
import { INBOX_TIERS, type InboxTier } from "./inboxTiers";

export function normalizedJsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

export function projectQueueItemsEqual(
  a: readonly ProjectQueueItemSummary[],
  b: readonly ProjectQueueItemSummary[],
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((item, index) => {
    const other = b[index];
    if (!other) return false;
    return (
      item.id === other.id &&
      item.projectId === other.projectId &&
      normalizedJsonEqual(item.target, other.target) &&
      item.targetTitle === other.targetTitle &&
      item.targetFullTitle === other.targetFullTitle &&
      item.messagePreview === other.messagePreview &&
      normalizedJsonEqual(item.message, other.message) &&
      item.createdAt === other.createdAt &&
      item.updatedAt === other.updatedAt &&
      normalizedJsonEqual(item.createdFrom, other.createdFrom) &&
      item.status === other.status &&
      item.attachmentCount === other.attachmentCount &&
      item.lastError === other.lastError &&
      item.lastAttemptAt === other.lastAttemptAt
    );
  });
}

export function inboxTierIdsEqual(
  a: Record<InboxTier, readonly string[]>,
  b: Record<InboxTier, readonly string[]>,
): boolean {
  return INBOX_TIERS.every((tier) => {
    const aIds = a[tier];
    const bIds = b[tier];
    return (
      aIds.length === bIds.length &&
      aIds.every((id, index) => id === bIds[index])
    );
  });
}

export function stringSetsEqual(
  a: ReadonlySet<string>,
  b: ReadonlySet<string>,
): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const value of a) {
    if (!b.has(value)) {
      return false;
    }
  }
  return true;
}

export function projectQueueDispatchStatesEqual(
  a: ProjectQueueDispatchState,
  b: ProjectQueueDispatchState,
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function recoveredSessionQueuesEqual(
  a: readonly ProjectQueueRecoveredSessionQueueSummary[],
  b: readonly ProjectQueueRecoveredSessionQueueSummary[],
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function providerRuntimeStatusEqual(
  a: ProviderRuntimeStatus,
  b: ProviderRuntimeStatus,
): boolean {
  if (a === b) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

export function projectQueueProjectStatusesEqual(
  a: ProjectQueueProjectStatus,
  b: ProjectQueueProjectStatus,
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
