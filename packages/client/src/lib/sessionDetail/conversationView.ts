import {
  getEarliestMessageTimestampMs,
  getLatestMessageTimestampMs,
} from "../messageAge";
import { getDisplayBashCommandFromInput } from "../bashCommand";
import { getPathBasename } from "../text";
import { toolDeclaresCommentary } from "../toolCommentarySource";
import { toolRegistry } from "../../components/renderers/tools";
import { getToolSummary } from "../../components/tools/summaries";
import type {
  ConversationActivityItem,
  ConversationRecentActivity,
  ConversationThinkingPreview,
  ConversationThinkingPreviewSlot,
  RenderItem,
  ToolCallItem,
} from "@yep-anywhere/shared/transcript/items";
import { groupRenderItemsIntoTurns } from "./renderItems";

// Upper bound on activity rows produced; the visible count is decided by
// layout, not this constant. `.conversation-recent-activities` caps its height
// to the thinking-preview budget and clips the overflow, so the newest rows
// that fit are shown. This is the most that can fit that budget at the current
// row metrics, so short viewports still clip while tall ones fill.
const RECENT_ACTIVITY_LIMIT = 24;
const COMMAND_WRAPPERS = new Set(["command", "env", "exec", "sudo", "time"]);
const SETUP_COMMAND = /^(?:cd|export|popd|pushd)\b/;

export interface ConversationViewProjectionOptions {
  active: boolean;
  dismissedThinkingPreviewSlots?: ReadonlySet<ConversationThinkingPreviewSlot>;
  expandedActivityIds?: ReadonlySet<string>;
  nowMs: number;
}

export interface ConversationViewWindow {
  hiddenTurnCount: number;
  items: readonly RenderItem[];
  visibleTurnCount: number;
}

/**
 * Keep a suffix beginning at a user-turn boundary. This is a render projection:
 * the source transcript remains loaded and can be revealed without persistence
 * or a provider-history mutation.
 */
export function windowConversationViewItems(
  items: readonly RenderItem[],
  turnLimit: number,
): ConversationViewWindow {
  const userTurnIndexes: number[] = [];
  for (let index = 0; index < items.length; index += 1) {
    if (items[index]?.type === "user_prompt") {
      userTurnIndexes.push(index);
    }
  }

  const normalizedLimit = Math.max(1, Math.floor(turnLimit));
  const hiddenTurnCount = Math.max(0, userTurnIndexes.length - normalizedLimit);
  if (hiddenTurnCount === 0) {
    return {
      hiddenTurnCount: 0,
      items,
      visibleTurnCount: userTurnIndexes.length,
    };
  }

  const firstVisibleIndex = userTurnIndexes[hiddenTurnCount] ?? 0;
  return {
    hiddenTurnCount,
    items: items.slice(firstVisibleIndex),
    visibleTurnCount: userTurnIndexes.length - hiddenTurnCount,
  };
}

export function isMediaToolCall(item: ToolCallItem): boolean {
  return (item.toolResult?.media?.length ?? 0) > 0;
}

/**
 * Why Conversation view retains or condenses a render item.
 *
 * - `activity`: routine work folded into the per-turn summary.
 * - `error`: retained because it is a failure, not because it is conversation.
 * - `importance`: retained conversation content (prompts, prose, media, plans).
 */
export type ConversationViewSurfaceReason = "activity" | "error" | "importance";

export function conversationViewSurfaceReason(
  item: RenderItem,
): ConversationViewSurfaceReason {
  if (item.type === "thinking" || item.type === "conversation_activity") {
    return "activity";
  }
  if (item.type === "task_notification") {
    const status = item.status?.toLowerCase();
    return status === "failed" || status === "error" ? "error" : "activity";
  }
  if (item.type === "system") {
    return item.subtype === "subagent_activity" ? "activity" : "importance";
  }
  if (item.type !== "tool_call") {
    return "importance";
  }
  if (item.status === "error" || item.status === "incomplete") {
    return "error";
  }
  if (toolRegistry.metadata(item.toolName).tool === "UpdatePlan") {
    return "importance";
  }
  if (
    isMediaToolCall(item) ||
    toolDeclaresCommentary(item) ||
    (item.workflow?.markers.length ?? 0) > 0
  ) {
    return "importance";
  }
  return "activity";
}

/**
 * Errors and incomplete calls retain their ordinary renderer: Conversation
 * view may compress routine work, but it must not erase actionable failure
 * state. Media calls also retain their media-only renderer so images stay
 * associated with the assistant turn.
 */
export function isConversationViewActivity(item: RenderItem): boolean {
  return conversationViewSurfaceReason(item) === "activity";
}

export function groupHasFollowingConversationText(
  items: readonly RenderItem[],
): boolean {
  let seenThinking = false;
  for (const item of items) {
    if (item.type === "thinking") {
      seenThinking = true;
      continue;
    }
    if (!seenThinking) continue;
    if (item.type === "text" && item.text.trim().length > 0) {
      return true;
    }
  }
  return false;
}

export function getConversationViewActivityCount(item: RenderItem): number {
  if (item.type !== "tool_call") {
    return 1;
  }
  return Math.max(1, item.displayActions?.length ?? 0);
}

function compactPathToken(token: string): string {
  const quote =
    (token.startsWith('"') && token.endsWith('"')) ||
    (token.startsWith("'") && token.endsWith("'"))
      ? token[0]
      : "";
  const unquoted = quote ? token.slice(1, -1) : token;
  if (
    !unquoted.startsWith("/") &&
    !unquoted.startsWith("./") &&
    !unquoted.startsWith("../")
  ) {
    return token;
  }
  const basename = getPathBasename(unquoted);
  return quote ? `${quote}${basename}${quote}` : basename;
}

function splitShellPreviewSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;

  const finishSegment = () => {
    const segment = current.trim();
    if (segment) segments.push(segment);
    current = "";
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (!char) continue;

    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      current += char;
      escaping = true;
      continue;
    }
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }

    const next = command[index + 1];
    if (char === ";" || char === "|" || (char === "&" && next === "&")) {
      finishSegment();
      if ((char === "|" || char === "&") && next === char) index += 1;
      continue;
    }
    current += char;
  }
  finishSegment();
  return segments;
}

export function compactCommandActivityPreview(command: string): string {
  const segments = splitShellPreviewSegments(
    command.replace(/\s+/g, " ").trim(),
  );
  const segment =
    segments.find((candidate) => !SETUP_COMMAND.test(candidate)) ??
    segments[0] ??
    "";
  const tokens = segment.match(/(?:"[^"]*"|'[^']*'|\S+)/g) ?? [];
  let executableIndex = 0;
  while (executableIndex < tokens.length) {
    const token = tokens[executableIndex] ?? "";
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      executableIndex += 1;
      continue;
    }
    if (COMMAND_WRAPPERS.has(token)) {
      executableIndex += 1;
      continue;
    }
    break;
  }
  return tokens.slice(executableIndex).map(compactPathToken).join(" ");
}

function getToolActivityPreview(
  item: ToolCallItem,
  canonicalToolName: string,
  summary: string,
): string | undefined {
  if (["Read", "Write", "Edit"].includes(canonicalToolName)) {
    return summary && summary !== "..." ? summary : undefined;
  }
  if (canonicalToolName !== "Bash") return undefined;
  if (
    item.toolInput &&
    typeof item.toolInput === "object" &&
    !Array.isArray(item.toolInput)
  ) {
    const description = (item.toolInput as Record<string, unknown>).description;
    if (typeof description === "string" && description.trim()) {
      return description.trim();
    }
  }
  const compact = compactCommandActivityPreview(
    getDisplayBashCommandFromInput(item.toolInput),
  );
  return compact || (summary && summary !== "..." ? summary : undefined);
}

function getRecentActivity(
  item: RenderItem,
): ConversationRecentActivity | null {
  if (item.type === "tool_call") {
    const renderer = toolRegistry.metadata(item.toolName);
    const prepared = toolRegistry.prepare(item.toolName, {
      input: item.toolInput,
      result: item.toolResult?.structured ?? item.toolResult?.content,
      status: item.status,
      isError: item.toolResult?.isError,
    });
    const label = prepared.getDisplayName("pending");
    const summary = getToolSummary(
      item.toolName,
      item.toolInput,
      item.toolResult,
      item.status,
      undefined,
      prepared,
    );
    const preview = getToolActivityPreview(item, renderer.tool, summary);
    return {
      label,
      detail: summary && summary !== "..." ? `${label}: ${summary}` : label,
      ...(preview ? { preview } : {}),
    };
  }
  if (item.type === "task_notification") {
    return {
      label: "Task",
      detail:
        item.summary?.trim() ||
        item.event?.trim() ||
        item.status?.trim() ||
        "Task activity",
    };
  }
  if (item.type === "system" && item.subtype === "subagent_activity") {
    return {
      label: "Agent",
      detail: item.content.trim() || "Agent activity",
    };
  }
  return null;
}

/**
 * The last thinking block that has finished, which bounds how far back the
 * activity names reach. Deliberately the last *complete* block rather than the
 * last block: while a new one streams, the reader is still working out of the
 * previous completed thought, so the activities that thought led to must stay
 * visible.
 */
function findLastCompleteThinkingId(
  items: readonly RenderItem[],
): string | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.type === "thinking" && item.status === "complete") {
      return item.id;
    }
  }
  return null;
}

/**
 * Activity names back to the last complete thinking block, newest first.
 *
 * The list answers "what has happened since the thought I just read", so the
 * thought is its lower bound. A boundary that is absent from these items — no
 * thinking yet, or the last complete block belongs to an earlier turn — leaves
 * every activity here after it, so all of them qualify.
 */
function getRecentActivities(
  items: readonly RenderItem[],
  boundaryThinkingId: string | null,
): ConversationRecentActivity[] | undefined {
  const boundaryIndex = boundaryThinkingId
    ? items.findIndex((item) => item.id === boundaryThinkingId)
    : -1;
  const activities: ConversationRecentActivity[] = [];
  for (
    let index = items.length - 1;
    index > boundaryIndex && activities.length < RECENT_ACTIVITY_LIMIT;
    index -= 1
  ) {
    const item = items[index];
    if (!item) continue;
    const activity = getRecentActivity(item);
    if (activity) activities.push(activity);
  }
  return activities.length > 0 ? activities : undefined;
}

/**
 * Where thinking stops being a candidate for preview.
 *
 * Agent-authored prose closes off the thinking that produced it: once the turn
 * has said something and *then* gone back to work, the reader is following the
 * fresh run of activity summarized beside the previews, and a thought from
 * before that prose is too stale to be one of the two shown. Prose with no
 * activity after it is a different case — the thought is still the most recent
 * thing the turn did, and the completed-turn glance and rollup carry it away on
 * their own schedule.
 *
 * @returns that prose item's index, or -1 when no thinking is stale.
 */
function findStaleThinkingBoundaryIndex(items: readonly RenderItem[]): number {
  let sawActivityAfterProse = false;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!item) continue;
    if (item.type === "text") {
      if (item.text.trim().length > 0 && sawActivityAfterProse) return index;
      continue;
    }
    if (isConversationViewActivity(item)) sawActivityAfterProse = true;
  }
  return -1;
}

/**
 * Keep the latest thinking block. While it is streaming, also keep the
 * immediately preceding completed block so a new turn starts with context;
 * once the latest block completes, the superseded preview disappears.
 * Ordering is by preview priority rather than transcript position.
 *
 * Both candidates are drawn from after the staleness boundary above, so a run
 * of activity that resumed after the turn already spoke shows its count alone
 * rather than a thought the prose has superseded.
 */
export function selectConversationThinkingPreviews(
  items: readonly RenderItem[],
): ConversationThinkingPreview[] {
  const staleBoundaryIndex = findStaleThinkingBoundaryIndex(items);
  let latestIndex = -1;
  for (let index = items.length - 1; index > staleBoundaryIndex; index -= 1) {
    if (items[index]?.type === "thinking") {
      latestIndex = index;
      break;
    }
  }
  if (latestIndex < 0) return [];

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

  for (let index = latestIndex - 1; index > staleBoundaryIndex; index -= 1) {
    const candidate = items[index];
    if (candidate?.type !== "thinking" || candidate.status !== "complete") {
      continue;
    }
    previews.push({
      id: candidate.id,
      kind: "previous",
      slot: "previous",
      thinking: candidate.thinking,
      status: candidate.status,
      endedAtMs: getLatestMessageTimestampMs(candidate.sourceMessages),
    });
    break;
  }
  return previews;
}

function getActivityTimestampBounds(
  activityItems: readonly RenderItem[],
  turnItems: readonly RenderItem[],
): {
  startedAtMs: number | null;
  endedAtMs: number | null;
} {
  let startedAtMs: number | null = null;
  let endedAtMs: number | null = null;
  for (const item of activityItems) {
    const itemStart = getEarliestMessageTimestampMs(item.sourceMessages);
    if (itemStart !== null) {
      startedAtMs =
        startedAtMs === null ? itemStart : Math.min(startedAtMs, itemStart);
    }
  }
  for (const item of turnItems) {
    const itemEnd = getLatestMessageTimestampMs(item.sourceMessages);
    if (itemEnd !== null) {
      endedAtMs = endedAtMs === null ? itemEnd : Math.max(endedAtMs, itemEnd);
    }
  }
  return { startedAtMs, endedAtMs };
}

/**
 * Project a transcript into Conversation view at the render-item boundary.
 * User turns and standalone transcript objects pass through unchanged.
 * Routine assistant activity is summarized once at the end of its turn.
 */
export function projectConversationView(
  items: readonly RenderItem[],
  {
    active,
    dismissedThinkingPreviewSlots = new Set<ConversationThinkingPreviewSlot>(),
    expandedActivityIds = new Set<string>(),
    nowMs,
  }: ConversationViewProjectionOptions,
): RenderItem[] {
  const groups = groupRenderItemsIntoTurns(items);
  let lastAssistantGroupIndex = -1;
  let lastActivityGroupIndex = -1;
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index];
    if (group && !group.isUserPrompt && !group.isStandalone) {
      lastAssistantGroupIndex = index;
      break;
    }
  }

  const summaryIds = groups.map((group, groupIndex) => {
    const firstHiddenItem = group.items.find(isConversationViewActivity);
    if (!firstHiddenItem) return null;
    lastActivityGroupIndex = groupIndex;
    return `conversation-activity-${firstHiddenItem.id}`;
  });
  const expandedThinkingIds = new Set<string>();
  groups.forEach((group, groupIndex) => {
    const summaryId = summaryIds[groupIndex];
    if (!summaryId || !expandedActivityIds.has(summaryId)) return;
    for (const item of group.items) {
      if (item.type === "thinking") expandedThinkingIds.add(item.id);
    }
  });
  const thinkingPreviews = selectConversationThinkingPreviews(items).filter(
    (preview) =>
      !expandedThinkingIds.has(preview.id) &&
      !dismissedThinkingPreviewSlots.has(preview.slot),
  );
  // Global, not per-turn: the bound is the last completed thought anywhere in
  // the transcript, so a turn that did no thinking of its own still measures
  // from the one the reader last saw.
  const lastCompleteThinkingId = findLastCompleteThinkingId(items);

  return groups.flatMap((group, groupIndex) => {
    if (group.isUserPrompt || group.isStandalone) {
      return group.items;
    }

    const hiddenItems = group.items.filter(isConversationViewActivity);
    if (hiddenItems.length === 0) {
      return group.items;
    }

    const summaryId =
      summaryIds[groupIndex] ??
      `conversation-activity-${hiddenItems[0]?.id ?? groupIndex}`;
    const expanded = expandedActivityIds.has(summaryId);
    const isActive = active && groupIndex === lastAssistantGroupIndex;
    const { startedAtMs, endedAtMs } = getActivityTimestampBounds(
      hiddenItems,
      group.items,
    );
    const summary: ConversationActivityItem = {
      type: "conversation_activity",
      id: summaryId,
      activityCount: hiddenItems.reduce(
        (count, item) => count + getConversationViewActivityCount(item),
        0,
      ),
      active: isActive,
      expanded,
      thinkingPreviews:
        groupIndex === lastActivityGroupIndex && thinkingPreviews.length > 0
          ? thinkingPreviews
          : undefined,
      hasFollowingConversationText:
        groupIndex === lastActivityGroupIndex && thinkingPreviews.length > 0
          ? groupHasFollowingConversationText(group.items)
          : undefined,
      // Not gated on the turn still being active: a finished turn keeps the
      // activities that followed its last thought, which is the part the
      // reader has not accounted for yet. Everything before that thought is
      // already summarized by the count, so it stays folded away.
      recentActivities:
        groupIndex === lastActivityGroupIndex && thinkingPreviews.length > 0
          ? getRecentActivities(hiddenItems, lastCompleteThinkingId)
          : undefined,
      tooltipActivities: getRecentActivities(hiddenItems, null),
      startedAtMs,
      endedAtMs: isActive ? nowMs : endedAtMs,
      sourceMessages: hiddenItems.flatMap((item) => item.sourceMessages),
    };

    return [
      ...(expanded
        ? group.items
        : group.items.filter((item) => !isConversationViewActivity(item))),
      summary,
    ];
  });
}
