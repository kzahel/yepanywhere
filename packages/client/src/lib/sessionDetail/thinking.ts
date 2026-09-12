import { getLatestMessageTimestampMs, parseTimestampMs } from "../messageAge";
import type { Message } from "../../types";
import type { RenderItem } from "@yep-anywhere/shared/transcript/items";

function getEarliestMessageTimestampMs(
  messages: readonly Message[],
): number | null {
  let earliest: number | null = null;
  for (const message of messages) {
    const timestampMs = parseTimestampMs(message.timestamp);
    if (timestampMs === null) {
      continue;
    }
    earliest =
      earliest === null ? timestampMs : Math.min(earliest, timestampMs);
  }
  return earliest;
}

function getRenderItemStartTimestampMs(item: RenderItem): number | null {
  return (
    getEarliestMessageTimestampMs(item.sourceMessages) ??
    getLatestMessageTimestampMs(item.sourceMessages)
  );
}

export function getThinkingDurationMs(
  item: RenderItem,
  items: readonly RenderItem[],
  index: number,
  nowMs: number,
): number | undefined {
  if (item.type !== "thinking") {
    return undefined;
  }

  const startMs = getRenderItemStartTimestampMs(item);
  if (startMs === null) {
    return undefined;
  }

  let endMs: number | null = item.status === "streaming" ? nowMs : null;
  for (let nextIndex = index + 1; nextIndex < items.length; nextIndex += 1) {
    const nextItem = items[nextIndex];
    if (!nextItem) {
      continue;
    }
    const nextTimestampMs = getRenderItemStartTimestampMs(nextItem);
    if (nextTimestampMs !== null && nextTimestampMs >= startMs) {
      endMs = nextTimestampMs;
      break;
    }
  }

  if (endMs === null) {
    const latestOwnMs = getLatestMessageTimestampMs(item.sourceMessages);
    endMs = latestOwnMs !== null && latestOwnMs > startMs ? latestOwnMs : null;
  }

  if (endMs === null) {
    return undefined;
  }

  const durationMs = endMs - startMs;
  return durationMs >= 100 && durationMs < 24 * 60 * 60 * 1000
    ? durationMs
    : undefined;
}

export function countThinkingItems(items: readonly RenderItem[]): number {
  let count = 0;
  for (const item of items) {
    if (item.type === "thinking") {
      count += 1;
    }
  }
  return count;
}

export function getLatestThinkingItemId(
  items: readonly RenderItem[],
): string | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.type === "thinking") {
      return item.id;
    }
  }
  return null;
}

export function getThinkingTextLengths(
  items: readonly RenderItem[],
): Map<string, number> {
  const lengths = new Map<string, number>();
  for (const item of items) {
    if (item.type === "thinking") {
      lengths.set(item.id, item.thinking.length);
    }
  }
  return lengths;
}

export function getThinkingItemIds(items: readonly RenderItem[]): Set<string> {
  const ids = new Set<string>();
  for (const item of items) {
    if (item.type === "thinking") {
      ids.add(item.id);
    }
  }
  return ids;
}

export interface VisibleThinkingTextDeltaInput {
  isThinkingItemExpanded: (itemId: string) => boolean;
  nextTextLengths: ReadonlyMap<string, number>;
  previousTextLengths: ReadonlyMap<string, number> | null;
  thinkingItemsVisible: boolean;
}

export function hasVisibleThinkingTextDelta({
  isThinkingItemExpanded,
  nextTextLengths,
  previousTextLengths,
  thinkingItemsVisible,
}: VisibleThinkingTextDeltaInput): boolean {
  if (previousTextLengths === null || !thinkingItemsVisible) {
    return false;
  }

  for (const [itemId, nextLength] of nextTextLengths) {
    if (!isThinkingItemExpanded(itemId)) {
      continue;
    }
    const previousLength = previousTextLengths.get(itemId) ?? 0;
    if (nextLength > previousLength) {
      return true;
    }
  }
  return false;
}

export interface ReconcileAutoExpandedThinkingItemIdsInput {
  currentThinkingIds: ReadonlySet<string>;
  previouslyObservedThinkingIds: ReadonlySet<string> | null;
  previousExpandedIds: ReadonlySet<string>;
  seedHistoricalThinking: boolean;
}

export function reconcileAutoExpandedThinkingItemIds({
  currentThinkingIds,
  previouslyObservedThinkingIds,
  previousExpandedIds,
  seedHistoricalThinking,
}: ReconcileAutoExpandedThinkingItemIdsInput): ReadonlySet<string> {
  const next = new Set<string>();
  let changed = false;

  for (const itemId of previousExpandedIds) {
    if (currentThinkingIds.has(itemId)) {
      next.add(itemId);
    } else {
      changed = true;
    }
  }

  if (seedHistoricalThinking) {
    for (const itemId of currentThinkingIds) {
      if (!next.has(itemId)) {
        next.add(itemId);
        changed = true;
      }
    }
  } else if (previouslyObservedThinkingIds !== null) {
    for (const itemId of currentThinkingIds) {
      if (!previouslyObservedThinkingIds.has(itemId) && !next.has(itemId)) {
        next.add(itemId);
        changed = true;
      }
    }
  }

  return changed ? next : previousExpandedIds;
}
