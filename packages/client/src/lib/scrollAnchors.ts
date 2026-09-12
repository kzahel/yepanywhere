import { getLatestMessageTimestampMs } from "./messageAge";
import type { SessionRouteScrollSnapshot } from "./sessionRouteSnapshots";
import type { RenderItem } from "@yep-anywhere/shared/transcript/items";

export interface VisibleRenderAnchor {
  id: string;
  topOffset: number;
  previousId?: string;
  nextId?: string;
  timestampMs?: number;
}

function isTopLevelRenderRow(
  messageList: HTMLElement,
  row: HTMLElement,
): boolean {
  const parentRow = row.parentElement?.closest("[data-render-id]");
  return !parentRow || !messageList.contains(parentRow);
}

/**
 * Map each `data-render-id` to its transcript row. Explored-group entries
 * nest another `[data-render-id]` under the group; jumps and rail layout
 * must prefer the top-level row so preview position and scroll target agree.
 */
export function indexRenderRowsById(
  messageList: HTMLDivElement | null,
): Map<string, HTMLElement> {
  const topLevelById = new Map<string, HTMLElement>();
  const nestedById = new Map<string, HTMLElement>();
  if (!messageList) {
    return topLevelById;
  }

  for (const row of messageList.querySelectorAll<HTMLElement>(
    "[data-render-id]",
  )) {
    const id = row.dataset.renderId;
    if (!id) {
      continue;
    }
    if (isTopLevelRenderRow(messageList, row)) {
      if (!topLevelById.has(id)) {
        topLevelById.set(id, row);
      }
      continue;
    }
    if (!nestedById.has(id)) {
      nestedById.set(id, row);
    }
  }

  for (const [id, row] of nestedById) {
    if (!topLevelById.has(id)) {
      topLevelById.set(id, row);
    }
  }
  return topLevelById;
}

export function findRenderRow(
  messageList: HTMLDivElement | null,
  id: string,
): HTMLElement | null {
  return indexRenderRowsById(messageList).get(id) ?? null;
}

function getRowRenderId(row: HTMLElement | undefined): string | undefined {
  const id = row?.dataset.renderId;
  return id && id.length > 0 ? id : undefined;
}

function getRenderItemsById(
  items: readonly RenderItem[],
): Map<string, RenderItem> {
  const itemsById = new Map<string, RenderItem>();
  for (const item of items) {
    itemsById.set(item.id, item);
  }
  return itemsById;
}

function getRenderItemTimestampMs(item: RenderItem | undefined): number | null {
  return item ? getLatestMessageTimestampMs(item.sourceMessages) : null;
}

export function restoreScrollToAnchorRow(
  container: HTMLElement,
  row: HTMLElement,
  topOffset: number,
): void {
  const containerRect = container.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  container.scrollTop = Math.max(
    0,
    container.scrollTop + rowRect.top - containerRect.top - topOffset,
  );
}

export function getFirstVisibleRenderAnchor(
  messageList: HTMLDivElement,
  scrollContainer: HTMLElement,
  items: readonly RenderItem[] = [],
): VisibleRenderAnchor | null {
  const containerRect = scrollContainer.getBoundingClientRect();
  const rows = Array.from(
    messageList.querySelectorAll<HTMLElement>("[data-render-id]"),
  );
  const itemsById = getRenderItemsById(items);
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (!row) {
      continue;
    }
    const id = getRowRenderId(row);
    if (!id) {
      continue;
    }
    const rowRect = row.getBoundingClientRect();
    if (
      rowRect.bottom > containerRect.top &&
      rowRect.top < containerRect.bottom
    ) {
      const previousId = getRowRenderId(rows[index - 1]);
      const nextId = getRowRenderId(rows[index + 1]);
      const timestampMs = getRenderItemTimestampMs(itemsById.get(id));
      return {
        id,
        topOffset: rowRect.top - containerRect.top,
        ...(previousId ? { previousId } : {}),
        ...(nextId ? { nextId } : {}),
        ...(timestampMs !== null ? { timestampMs } : {}),
      };
    }
  }
  return null;
}

function findNearestTimestampedRenderRow(
  messageList: HTMLDivElement,
  timestampMs: number | undefined,
  items: readonly RenderItem[],
): HTMLElement | null {
  if (timestampMs === undefined) {
    return null;
  }
  const itemsById = getRenderItemsById(items);
  let best: { row: HTMLElement; distanceMs: number } | null = null;

  for (const row of messageList.querySelectorAll<HTMLElement>(
    "[data-render-id]",
  )) {
    const id = getRowRenderId(row);
    const rowTimestampMs = getRenderItemTimestampMs(
      id ? itemsById.get(id) : undefined,
    );
    if (rowTimestampMs === null) {
      continue;
    }
    const distanceMs = Math.abs(rowTimestampMs - timestampMs);
    if (!best || distanceMs < best.distanceMs) {
      best = { row, distanceMs };
    }
  }

  return best?.row ?? null;
}

export function findFallbackRenderAnchorRow(
  messageList: HTMLDivElement,
  anchor: NonNullable<SessionRouteScrollSnapshot["anchor"]>,
  items: readonly RenderItem[],
): HTMLElement | null {
  for (const id of [anchor.previousId, anchor.nextId]) {
    if (!id) {
      continue;
    }
    const row = findRenderRow(messageList, id);
    if (row) {
      return row;
    }
  }

  return findNearestTimestampedRenderRow(
    messageList,
    anchor.timestampMs,
    items,
  );
}
