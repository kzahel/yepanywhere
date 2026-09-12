import type { TranscriptDisplayObject } from "@yep-anywhere/shared";
import { getLatestMessageTimestampMs, parseTimestampMs } from "../messageAge";
import type { RenderItem } from "@yep-anywhere/shared/transcript/items";
import { stabilizeRenderItems } from "../stableRenderItems";
import { insertTranscriptDisplayObjects } from "../transcriptDisplayObjects";
import type { ActiveToolApproval } from "@yep-anywhere/shared/transcript/types";
import { getCachedWebTranscriptProjection } from "../webTranscriptProjection";
import type { Message } from "../../types";
import type { WorkflowSchemaFiles } from "@yep-anywhere/shared/transcript/workflowTags";
import type { MarkdownAugmentMap, SessionDetailState } from "./types";

export interface SessionDetailRenderItemInput {
  messages: Message[];
  provider?: string;
  markdownAugments?: MarkdownAugmentMap;
  activeToolApproval?: ActiveToolApproval;
  transcriptDisplayObjects?: readonly TranscriptDisplayObject[];
  previousRenderItems?: readonly RenderItem[];
  recentProjectPathLinksEnabled?: boolean;
  workflowTagsEnabled?: boolean;
  workflowSchemaFiles?: WorkflowSchemaFiles;
}

export interface RenderTurnGroup {
  isUserPrompt: boolean;
  isStandalone?: boolean;
  items: RenderItem[];
}

export interface TimestampedTailInput {
  timestamp?: string | null;
}

export interface TimestampedAsideInput {
  historyAt?: string | null;
  updatedAt?: string | null;
}

export interface LatestVisibleTimestampInput<
  TPending extends TimestampedTailInput = TimestampedTailInput,
  TDeferred extends TimestampedTailInput = TimestampedTailInput,
  TProjectQueue extends TimestampedTailInput = TimestampedTailInput,
  TAside extends TimestampedAsideInput = TimestampedAsideInput,
> {
  asides?: readonly TAside[];
  deferredMessages?: readonly TDeferred[];
  displayRenderItems: readonly RenderItem[];
  pendingMessages?: readonly TPending[];
  projectQueueMessages?: readonly TProjectQueue[];
}

export function buildSessionDetailRenderItems({
  messages,
  provider,
  markdownAugments,
  activeToolApproval,
  transcriptDisplayObjects = [],
  previousRenderItems = [],
  recentProjectPathLinksEnabled = false,
  workflowTagsEnabled = false,
  workflowSchemaFiles,
}: SessionDetailRenderItemInput): RenderItem[] {
  const preprocessed = getCachedWebTranscriptProjection(
    messages,
    {
      markdown: markdownAugments,
      activeToolApproval,
      workflowTags: workflowTagsEnabled,
      workflowSchemaFiles,
    },
    recentProjectPathLinksEnabled,
  );
  // The Responses adapter needs the signed block for later tool turns, but its
  // empty-summary sentinel is provider activity rather than transcript prose.
  const providerProjected =
    provider === "claude-gateway"
      ? preprocessed.filter(
          (item) => item.type !== "thinking" || item.thinking !== "Thinking...",
        )
      : preprocessed;
  const inserted = insertTranscriptDisplayObjects(
    providerProjected,
    transcriptDisplayObjects,
  );
  return stabilizeRenderItems(previousRenderItems, inserted);
}

export function selectSessionDetailRenderItems(
  state: SessionDetailState,
  options: Omit<
    SessionDetailRenderItemInput,
    "messages" | "markdownAugments"
  > = {},
): RenderItem[] {
  return buildSessionDetailRenderItems({
    ...options,
    messages: state.messages,
    markdownAugments: state.markdownAugments,
  });
}

export function groupRenderItemsIntoTurns(
  items: readonly RenderItem[],
): RenderTurnGroup[] {
  const groups: RenderTurnGroup[] = [];
  let currentAssistantGroup: RenderItem[] = [];

  for (const item of items) {
    if (item.type === "transcript_display_object") {
      if (currentAssistantGroup.length > 0) {
        groups.push({ isUserPrompt: false, items: currentAssistantGroup });
        currentAssistantGroup = [];
      }
      groups.push({
        isUserPrompt: false,
        isStandalone: true,
        items: [item],
      });
    } else if (item.type === "user_prompt" || item.type === "session_setup") {
      if (currentAssistantGroup.length > 0) {
        groups.push({ isUserPrompt: false, items: currentAssistantGroup });
        currentAssistantGroup = [];
      }
      groups.push({ isUserPrompt: true, items: [item] });
    } else {
      currentAssistantGroup.push(item);
    }
  }

  if (currentAssistantGroup.length > 0) {
    groups.push({ isUserPrompt: false, items: currentAssistantGroup });
  }

  return groups;
}

function canReuseRenderTurnGroup(
  previous: RenderTurnGroup,
  next: RenderTurnGroup,
): boolean {
  if (
    previous.isUserPrompt !== next.isUserPrompt ||
    previous.isStandalone !== next.isStandalone ||
    previous.items.length !== next.items.length
  ) {
    return false;
  }

  return previous.items.every((item, index) => item === next.items[index]);
}

function getRenderTurnGroupKey(group: RenderTurnGroup, index: number): string {
  const firstItem = group.items[0];
  return firstItem
    ? `${group.isUserPrompt ? "user" : "assistant"}:${firstItem.type}:${firstItem.id}`
    : `empty:${index}`;
}

/** Keep unchanged turn arrays stable when only a live tail item changed. */
export function stabilizeRenderTurnGroups(
  previousGroups: readonly RenderTurnGroup[],
  nextGroups: readonly RenderTurnGroup[],
): RenderTurnGroup[] {
  if (previousGroups.length === 0 || nextGroups.length === 0) {
    return [...nextGroups];
  }

  const previousByKey = new Map<string, RenderTurnGroup[]>();
  previousGroups.forEach((group, index) => {
    const key = getRenderTurnGroupKey(group, index);
    const bucket = previousByKey.get(key);
    if (bucket) {
      bucket.push(group);
    } else {
      previousByKey.set(key, [group]);
    }
  });

  return nextGroups.map((nextGroup, index) => {
    const candidates = previousByKey.get(
      getRenderTurnGroupKey(nextGroup, index),
    );
    if (!candidates) return nextGroup;
    const candidateIndex = candidates.findIndex((previousGroup) =>
      canReuseRenderTurnGroup(previousGroup, nextGroup),
    );
    if (candidateIndex === -1) return nextGroup;
    const [reused] = candidates.splice(candidateIndex, 1);
    return reused ?? nextGroup;
  });
}

export function getLatestRenderItemsTimestampMs(
  items: readonly RenderItem[],
): number | null {
  let latest: number | null = null;
  for (const item of items) {
    const timestampMs = getLatestMessageTimestampMs(item.sourceMessages);
    if (timestampMs === null) {
      continue;
    }
    latest = latest === null ? timestampMs : Math.max(latest, timestampMs);
  }
  return latest;
}

export function getLastTimestampedRenderItem(
  items: readonly RenderItem[],
): RenderItem | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item && getLatestMessageTimestampMs(item.sourceMessages) !== null) {
      return item;
    }
  }
  return null;
}

export function groupEndsVisibleTurn(
  group: RenderTurnGroup,
  nextGroup: RenderTurnGroup | undefined,
): boolean {
  if (group.isStandalone) {
    return true;
  }
  if (!group.isUserPrompt) {
    return true;
  }
  return (
    !nextGroup || nextGroup.isUserPrompt || nextGroup.isStandalone === true
  );
}

export function getLatestVisibleTimestampMs({
  asides = [],
  deferredMessages = [],
  displayRenderItems,
  pendingMessages = [],
  projectQueueMessages = [],
}: LatestVisibleTimestampInput): number | null {
  let latest: number | null = null;
  const includeTimestamp = (timestampMs: number | null) => {
    if (timestampMs === null) return;
    latest = latest === null ? timestampMs : Math.max(latest, timestampMs);
  };

  for (const item of displayRenderItems) {
    includeTimestamp(getLatestMessageTimestampMs(item.sourceMessages));
  }
  for (const pending of pendingMessages) {
    includeTimestamp(parseTimestampMs(pending.timestamp));
  }
  for (const deferred of deferredMessages) {
    includeTimestamp(parseTimestampMs(deferred.timestamp));
  }
  for (const projectQueue of projectQueueMessages) {
    includeTimestamp(parseTimestampMs(projectQueue.timestamp));
  }
  for (const aside of asides) {
    includeTimestamp(parseTimestampMs(aside.historyAt ?? aside.updatedAt));
  }

  return latest;
}

export function getDisplayRenderItems(
  items: readonly RenderItem[],
  options: { thinkingItemsVisible: boolean },
): readonly RenderItem[] {
  return options.thinkingItemsVisible
    ? items
    : items.filter((item) => item.type !== "thinking");
}
