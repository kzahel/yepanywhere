import type {
  ConversationRecentActivity,
  ConversationThinkingPreview,
  RenderItem,
} from "@yep-anywhere/shared/transcript/items";
import { readProjectPathLinkTargets } from "@yep-anywhere/shared/transcript/projectPathLinks";

function getRenderItemKey(item: RenderItem): string {
  return `${item.type}:${item.id}`;
}

function sameArrayItems<T>(
  previous: readonly T[],
  next: readonly T[],
): boolean {
  if (previous.length !== next.length) {
    return false;
  }
  for (let index = 0; index < previous.length; index += 1) {
    if (previous[index] !== next[index]) {
      return false;
    }
  }
  return true;
}

function sameSourceMessages(previous: RenderItem, next: RenderItem): boolean {
  return sameArrayItems(previous.sourceMessages, next.sourceMessages);
}

function sameOptionalArrayItems<T>(
  previous: readonly T[] | undefined,
  next: readonly T[] | undefined,
  sameItem: (previousItem: T, nextItem: T) => boolean,
): boolean {
  if (previous === next) return true;
  if (!previous || !next || previous.length !== next.length) return false;
  return previous.every((item, index) => {
    const nextItem = next[index];
    return nextItem !== undefined && sameItem(item, nextItem);
  });
}

function sameThinkingPreview(
  previous: ConversationThinkingPreview,
  next: ConversationThinkingPreview,
): boolean {
  return (
    previous.id === next.id &&
    previous.kind === next.kind &&
    previous.slot === next.slot &&
    previous.thinking === next.thinking &&
    previous.status === next.status &&
    previous.endedAtMs === next.endedAtMs
  );
}

function sameRecentActivity(
  previous: ConversationRecentActivity,
  next: ConversationRecentActivity,
): boolean {
  return (
    previous.label === next.label &&
    previous.detail === next.detail &&
    previous.preview === next.preview
  );
}

function sameProjectPathLinks(
  previous: ReturnType<typeof readProjectPathLinkTargets>,
  next: ReturnType<typeof readProjectPathLinkTargets>,
): boolean {
  return sameOptionalArrayItems(
    previous,
    next,
    (previousLink, nextLink) =>
      previousLink.text === nextLink.text &&
      previousLink.filePath === nextLink.filePath,
  );
}

function toolInputProjectPathLinks(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  return readProjectPathLinkTargets(
    (input as Record<string, unknown>)._projectPathLinks,
  );
}

export function canReuseRenderItem(
  previous: RenderItem,
  next: RenderItem,
): boolean {
  if (
    previous.type !== next.type ||
    previous.id !== next.id ||
    previous.isSubagent !== next.isSubagent ||
    JSON.stringify(previous.workflow) !== JSON.stringify(next.workflow) ||
    !sameSourceMessages(previous, next)
  ) {
    return false;
  }

  switch (previous.type) {
    case "text":
      return (
        next.type === "text" &&
        previous.text === next.text &&
        previous.isStreaming === next.isStreaming &&
        previous.augmentHtml === next.augmentHtml &&
        sameProjectPathLinks(previous.projectPathLinks, next.projectPathLinks)
      );

    case "thinking":
      return (
        next.type === "thinking" &&
        previous.thinking === next.thinking &&
        previous.signature === next.signature &&
        previous.status === next.status
      );

    case "tool_call":
      // Source-message identity is checked above. Inputs, results, and display
      // actions are pure projections of those messages but are rebuilt as
      // fresh objects; comparing their references would invalidate history on
      // every tail update. Status is the one projection augmented by live
      // approval state, so keep it explicit.
      return (
        next.type === "tool_call" &&
        previous.toolName === next.toolName &&
        previous.status === next.status &&
        sameProjectPathLinks(
          toolInputProjectPathLinks(previous.toolInput),
          toolInputProjectPathLinks(next.toolInput),
        ) &&
        sameProjectPathLinks(
          previous.toolResult?.projectPathLinks,
          next.toolResult?.projectPathLinks,
        )
      );

    case "user_prompt":
      return (
        next.type === "user_prompt" &&
        previous.content === next.content &&
        sameProjectPathLinks(previous.projectPathLinks, next.projectPathLinks)
      );

    case "session_setup":
      return (
        next.type === "session_setup" &&
        previous.title === next.title &&
        sameArrayItems(previous.prompts, next.prompts)
      );

    case "transcript_display_object":
      return (
        next.type === "transcript_display_object" &&
        previous.object === next.object
      );

    case "system":
      return (
        next.type === "system" &&
        previous.subtype === next.subtype &&
        previous.content === next.content &&
        previous.status === next.status &&
        previous.configChanged === next.configChanged
      );

    case "task_notification":
      return next.type === "task_notification" && previous.raw === next.raw;

    case "conversation_activity":
      return (
        next.type === "conversation_activity" &&
        previous.activityCount === next.activityCount &&
        previous.active === next.active &&
        previous.expanded === next.expanded &&
        previous.hasFollowingConversationText ===
          next.hasFollowingConversationText &&
        sameOptionalArrayItems(
          previous.thinkingPreviews,
          next.thinkingPreviews,
          sameThinkingPreview,
        ) &&
        sameOptionalArrayItems(
          previous.recentActivities,
          next.recentActivities,
          sameRecentActivity,
        ) &&
        sameOptionalArrayItems(
          previous.tooltipActivities,
          next.tooltipActivities,
          sameRecentActivity,
        ) &&
        previous.startedAtMs === next.startedAtMs &&
        previous.endedAtMs === next.endedAtMs
      );
  }
}

export function stabilizeRenderItems(
  previousItems: readonly RenderItem[],
  nextItems: readonly RenderItem[],
): RenderItem[] {
  if (previousItems.length === 0 || nextItems.length === 0) {
    return [...nextItems];
  }

  const previousByKey = new Map<string, RenderItem[]>();
  for (const item of previousItems) {
    const key = getRenderItemKey(item);
    const bucket = previousByKey.get(key);
    if (bucket) {
      bucket.push(item);
    } else {
      previousByKey.set(key, [item]);
    }
  }

  return nextItems.map((nextItem) => {
    const candidates = previousByKey.get(getRenderItemKey(nextItem));
    if (!candidates) {
      return nextItem;
    }

    const index = candidates.findIndex((candidate) =>
      canReuseRenderItem(candidate, nextItem),
    );
    if (index === -1) {
      return nextItem;
    }

    const [reused] = candidates.splice(index, 1);
    return reused ?? nextItem;
  });
}
