import type { RenderItem } from "@yep-anywhere/shared/transcript/items";
import { getLatestMessageTimestampMs } from "./messageAge";
import {
  getLastTimestampedRenderItem,
  type RenderTurnGroup,
} from "./sessionDetail/renderItems";
import type { SessionRouteScrollSnapshot } from "./sessionRouteSnapshots";

interface CompletedTurnCursor {
  id: string;
  timestampMs?: number;
  endRenderItemId: string;
}

interface SeenTurnCursor {
  id: string;
  timestampMs?: number;
  items: RenderItem[];
}

export interface VisibleSessionScrollCursor {
  completedTurn?: NonNullable<SessionRouteScrollSnapshot["completedTurn"]>;
  seenTurn?: NonNullable<SessionRouteScrollSnapshot["seenTurn"]>;
  anchor?: NonNullable<SessionRouteScrollSnapshot["anchor"]>;
}

function getCompletedTurnCursors(
  groups: readonly RenderTurnGroup[],
  turnActive: boolean,
): CompletedTurnCursor[] {
  const completed: CompletedTurnCursor[] = [];
  let userPrompt: RenderItem | null = null;
  let assistantEnd: RenderItem | null = null;

  const finishPendingTurn = (isActiveTail: boolean) => {
    if (!userPrompt || !assistantEnd || isActiveTail) {
      return;
    }
    const timestampMs = getLatestMessageTimestampMs(
      assistantEnd.sourceMessages,
    );
    completed.push({
      id: userPrompt.id,
      ...(timestampMs !== null ? { timestampMs } : {}),
      endRenderItemId: assistantEnd.id,
    });
  };

  for (const group of groups) {
    if (group.isUserPrompt) {
      finishPendingTurn(false);
      userPrompt =
        group.items.find((item) => item.type === "user_prompt") ?? null;
      assistantEnd = null;
      continue;
    }
    if (!group.isStandalone && userPrompt) {
      assistantEnd =
        getLastTimestampedRenderItem(group.items) ??
        group.items[group.items.length - 1] ??
        assistantEnd;
    }
  }
  finishPendingTurn(turnActive);
  return completed;
}

function getVisibleCompletedTurnCursor(
  scrollContainer: HTMLElement,
  groups: readonly RenderTurnGroup[],
  rowsById: ReadonlyMap<string, HTMLElement>,
  turnActive: boolean,
): Omit<CompletedTurnCursor, "endRenderItemId"> | null {
  const containerRect = scrollContainer.getBoundingClientRect();
  let visible: CompletedTurnCursor | null = null;
  for (const cursor of getCompletedTurnCursors(groups, turnActive)) {
    const row = rowsById.get(cursor.endRenderItemId);
    if (!row) {
      continue;
    }
    const rowRect = row.getBoundingClientRect();
    if (
      rowRect.bottom >= containerRect.top &&
      rowRect.bottom <= containerRect.bottom
    ) {
      visible = cursor;
    }
  }
  if (!visible) {
    return null;
  }
  return {
    id: visible.id,
    ...(visible.timestampMs !== undefined
      ? { timestampMs: visible.timestampMs }
      : {}),
  };
}

function getSeenTurnCursors(
  groups: readonly RenderTurnGroup[],
): SeenTurnCursor[] {
  const turns: SeenTurnCursor[] = [];
  let current: SeenTurnCursor | null = null;

  for (const group of groups) {
    if (group.isUserPrompt) {
      if (current) {
        turns.push(current);
      }
      const prompt =
        group.items.find((item) => item.type === "user_prompt") ?? null;
      if (!prompt) {
        current = null;
        continue;
      }
      const timestampMs = getLatestMessageTimestampMs(prompt.sourceMessages);
      current = {
        id: prompt.id,
        ...(timestampMs !== null ? { timestampMs } : {}),
        items: [prompt],
      };
      continue;
    }
    if (!group.isStandalone && current) {
      current.items.push(...group.items);
    }
  }
  if (current) {
    turns.push(current);
  }
  return turns;
}

function getVisibleSeenTurnCursor(
  scrollContainer: HTMLElement,
  groups: readonly RenderTurnGroup[],
  rowsById: ReadonlyMap<string, HTMLElement>,
  allItems: readonly RenderItem[],
): Pick<VisibleSessionScrollCursor, "anchor" | "seenTurn"> | null {
  const containerRect = scrollContainer.getBoundingClientRect();
  let visible: {
    turn: SeenTurnCursor;
    item: RenderItem;
    activityIndex: number;
    rowTop: number;
  } | null = null;

  for (const turn of getSeenTurnCursors(groups)) {
    for (
      let activityIndex = 0;
      activityIndex < turn.items.length;
      activityIndex += 1
    ) {
      const item = turn.items[activityIndex];
      if (!item) {
        continue;
      }
      const row = rowsById.get(item.id);
      if (!row) {
        continue;
      }
      const rowRect = row.getBoundingClientRect();
      if (
        rowRect.bottom > containerRect.top &&
        rowRect.top < containerRect.bottom
      ) {
        visible = { turn, item, activityIndex, rowTop: rowRect.top };
      }
    }
  }
  if (!visible) {
    return null;
  }

  const { activityIndex, item, rowTop, turn } = visible;
  const itemIndex = allItems.findIndex((candidate) => candidate.id === item.id);
  const previousId = itemIndex > 0 ? allItems[itemIndex - 1]?.id : undefined;
  const nextId = itemIndex >= 0 ? allItems[itemIndex + 1]?.id : undefined;
  const itemTimestampMs = getLatestMessageTimestampMs(item.sourceMessages);
  return {
    seenTurn: {
      id: turn.id,
      ...(turn.timestampMs !== undefined
        ? { timestampMs: turn.timestampMs }
        : {}),
      activityIndex,
    },
    anchor: {
      id: item.id,
      topOffset: rowTop - containerRect.top,
      ...(previousId ? { previousId } : {}),
      ...(nextId ? { nextId } : {}),
      ...(itemTimestampMs !== null ? { timestampMs: itemTimestampMs } : {}),
    },
  };
}

export function deriveVisibleSessionScrollCursor({
  scrollContainer,
  groups,
  rowsById,
  allItems,
  turnActive,
}: {
  scrollContainer: HTMLElement;
  groups: readonly RenderTurnGroup[];
  rowsById: ReadonlyMap<string, HTMLElement>;
  allItems: readonly RenderItem[];
  turnActive: boolean;
}): VisibleSessionScrollCursor {
  const visibleSeenTurn = getVisibleSeenTurnCursor(
    scrollContainer,
    groups,
    rowsById,
    allItems,
  );
  const completedTurn = getVisibleCompletedTurnCursor(
    scrollContainer,
    groups,
    rowsById,
    turnActive,
  );
  return {
    ...(completedTurn ? { completedTurn } : {}),
    ...visibleSeenTurn,
  };
}

export function getLatestSeenTurnRenderKey(
  groups: readonly RenderTurnGroup[],
): string | null {
  const turns = getSeenTurnCursors(groups);
  const latest = turns[turns.length - 1];
  const latestItem = latest?.items[latest.items.length - 1];
  return latest
    ? `${latest.id}:${latest.items.length}:${latestItem?.id}`
    : null;
}
