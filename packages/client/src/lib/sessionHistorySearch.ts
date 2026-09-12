import type { TranscriptDisplayObject } from "@yep-anywhere/shared";
import type { SessionIsearchScope } from "./sessionIsearchGuide";
import { getLatestMessageTimestampMs } from "./messageAge";
import {
  getActiveSearchAnchors,
  getAllTurnSearchAnchors,
  getFullSessionSearchAnchors,
  getSearchMatchProjection,
  getUserTurnSearchAnchors,
} from "./sessionDetail/search";
import { groupRenderItemsIntoTurns } from "./sessionDetail/renderItems";
import { canonicalizeToolName } from "./toolNames";
import { insertTranscriptDisplayObjects } from "./transcriptDisplayObjects";
import { compileWebTranscriptProjection } from "./webTranscriptProjection";
import type { Message } from "../types";
import type {
  ConversationActivityItem,
  ConversationThinkingPreview,
  RenderItem,
} from "@yep-anywhere/shared/transcript/items";

export const HISTORY_SEARCH_PAGE_MATCH_LIMIT = 200;

export interface SessionHistorySearchPageInput {
  caseSensitive: boolean;
  conversationViewEnabled: boolean;
  messages: Message[];
  provider?: string;
  query: string;
  recentProjectPathLinksEnabled?: boolean;
  scope: SessionIsearchScope;
  thinkingItemsVisible: boolean;
  transcriptDisplayObjects?: readonly TranscriptDisplayObject[];
}

export interface SessionHistorySearchMatch {
  id: string;
  preview: string;
  targetId?: string;
  timestampMs?: number | null;
}

export interface SessionHistorySearchPageResult {
  matches: SessionHistorySearchMatch[];
  matchesTruncated: boolean;
}

function isConversationSearchActivity(item: RenderItem): boolean {
  if (item.type === "thinking") return true;
  if (item.type === "task_notification") {
    const status = item.status?.toLowerCase();
    return status !== "failed" && status !== "error";
  }
  if (item.type === "system") return item.subtype === "subagent_activity";
  if (item.type !== "tool_call") return false;
  return (
    canonicalizeToolName(item.toolName) !== "UpdatePlan" &&
    (item.toolResult?.media?.length ?? 0) === 0 &&
    item.status !== "error" &&
    item.status !== "incomplete"
  );
}

function selectConversationSearchThinkingPreviews(
  items: readonly RenderItem[],
): ConversationThinkingPreview[] {
  let latestIndex = -1;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index]?.type === "thinking") {
      latestIndex = index;
      break;
    }
  }
  const latest = items[latestIndex];
  if (latest?.type !== "thinking") return [];

  const previews: ConversationThinkingPreview[] = [
    {
      id: latest.id,
      kind: latest.status === "streaming" ? "current" : "latest",
      slot: "latest",
      thinking: latest.thinking,
      status: latest.status,
      endedAtMs: getLatestMessageTimestampMs(latest.sourceMessages),
    },
  ];
  if (latest.status !== "streaming") return previews;
  for (let index = latestIndex - 1; index >= 0; index -= 1) {
    const previous = items[index];
    if (previous?.type !== "thinking" || previous.status !== "complete") {
      continue;
    }
    previews.push({
      id: previous.id,
      kind: "previous",
      slot: "previous",
      thinking: previous.thinking,
      status: previous.status,
      endedAtMs: getLatestMessageTimestampMs(previous.sourceMessages),
    });
    break;
  }
  return previews;
}

/**
 * Search needs Conversation View's structural projection, but none of its UI
 * renderer metadata. Keeping this projection worker-safe also prevents an
 * explicit history search from importing the React tool-renderer graph.
 */
function projectConversationSearchView(
  items: readonly RenderItem[],
): RenderItem[] {
  const groups = groupRenderItemsIntoTurns(items);
  let lastActivityGroupIndex = -1;
  const summaryIds = groups.map((group, groupIndex) => {
    const firstHiddenItem = group.items.find(isConversationSearchActivity);
    if (!firstHiddenItem) return null;
    lastActivityGroupIndex = groupIndex;
    return `conversation-activity-${firstHiddenItem.id}`;
  });
  const thinkingPreviews = selectConversationSearchThinkingPreviews(items);

  return groups.flatMap((group, groupIndex) => {
    if (group.isUserPrompt || group.isStandalone) return group.items;
    const hiddenItems = group.items.filter(isConversationSearchActivity);
    if (hiddenItems.length === 0) return group.items;
    const summary: ConversationActivityItem = {
      type: "conversation_activity",
      id:
        summaryIds[groupIndex] ??
        `conversation-activity-${hiddenItems[0]?.id ?? groupIndex}`,
      activityCount: hiddenItems.reduce(
        (count, item) =>
          count +
          (item.type === "tool_call"
            ? Math.max(1, item.displayActions?.length ?? 0)
            : 1),
        0,
      ),
      active: false,
      expanded: false,
      thinkingPreviews:
        groupIndex === lastActivityGroupIndex && thinkingPreviews.length > 0
          ? thinkingPreviews
          : undefined,
      startedAtMs: null,
      endedAtMs: null,
      sourceMessages: hiddenItems.flatMap((item) => item.sourceMessages),
    };
    return [
      ...group.items.filter((item) => !isConversationSearchActivity(item)),
      summary,
    ];
  });
}

/**
 * Compile and search one bounded durable-history page with the same transcript
 * projection used by the live message list. The caller runs this in a lazy
 * worker and retains only the returned excerpts.
 */
export function searchSessionHistoryPage({
  caseSensitive,
  conversationViewEnabled,
  messages,
  provider,
  query,
  recentProjectPathLinksEnabled = false,
  scope,
  thinkingItemsVisible,
  transcriptDisplayObjects = [],
}: SessionHistorySearchPageInput): SessionHistorySearchPageResult {
  const compiledItems = compileWebTranscriptProjection(
    messages,
    undefined,
    recentProjectPathLinksEnabled,
  );
  const providerProjected =
    provider === "claude-gateway"
      ? compiledItems.filter(
          (item) => item.type !== "thinking" || item.thinking !== "Thinking...",
        )
      : compiledItems;
  const insertedItems = insertTranscriptDisplayObjects(
    providerProjected,
    transcriptDisplayObjects,
  );
  const renderItems = thinkingItemsVisible
    ? insertedItems
    : insertedItems.filter((item) => item.type !== "thinking");
  const displayRenderItems = conversationViewEnabled
    ? projectConversationSearchView(renderItems)
    : renderItems;
  const anchors = getActiveSearchAnchors({
    allAnchors: getAllTurnSearchAnchors(displayRenderItems),
    fullAnchors: getFullSessionSearchAnchors(
      groupRenderItemsIntoTurns(displayRenderItems),
    ),
    scope,
    userAnchors: getUserTurnSearchAnchors(displayRenderItems),
  });
  const projection = getSearchMatchProjection({
    anchors,
    caseSensitive,
    query,
    searchReady: true,
  });
  const firstRetainedIndex = Math.max(
    0,
    projection.matches.length - HISTORY_SEARCH_PAGE_MATCH_LIMIT,
  );
  return {
    matches: projection.matches.slice(firstRetainedIndex).map((anchor) => ({
      id: anchor.id,
      preview: projection.previewsById.get(anchor.id) ?? anchor.preview,
      ...(anchor.targetId ? { targetId: anchor.targetId } : {}),
      ...(anchor.timestampMs !== undefined
        ? { timestampMs: anchor.timestampMs }
        : {}),
    })),
    matchesTruncated: firstRetainedIndex > 0,
  };
}

export interface SessionHistorySearchWorkerRequest
  extends SessionHistorySearchPageInput {
  requestId: number;
}

export interface SessionHistorySearchWorkerResponse
  extends SessionHistorySearchPageResult {
  requestId: number;
}
