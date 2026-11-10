import { useLayoutEffect, useRef, useState } from "react";
import type { RenderTurnGroup } from "../lib/sessionDetail/renderItems";
import type { TimelineEntryDisplayRow } from "../lib/sessionDetail/timeline";
const OLDER_PAGE_PREPEND_BATCH_TARGET = 8;

interface KeyedTimelineRow {
  key: string;
  kind: string;
}

interface ChunkedTimelinePrependState<TRow> {
  rows: readonly TRow[];
  start: number;
}

export function getTimelineRowRenderWeight(row: KeyedTimelineRow): number {
  if (row.kind !== "assistant" || !("rows" in row)) {
    return row.kind === "empty" ? 0 : 1;
  }
  const assistantRows = row.rows;
  return Array.isArray(assistantRows) ? Math.max(1, assistantRows.length) : 1;
}

export function getTimelineRowTargetIds(
  row: TimelineEntryDisplayRow<RenderTurnGroup, BtwAsideTimelineItem>,
): string[] {
  if (row.kind === "btw") {
    return [`btw-${row.aside.id}`];
  }
  if (row.kind === "empty") {
    return [];
  }
  if (row.kind === "standalone" || row.kind === "user") {
    return [row.item.id];
  }
  const ids = new Set(row.group.items.map((item) => item.id));
  for (const assistantRow of row.rows) {
    if (assistantRow.kind === "explored") {
      ids.add(assistantRow.id);
    } else {
      ids.add(assistantRow.item.id);
    }
  }
  return [...ids];
}

function getPreviousTimelineBatchStart<TRow extends KeyedTimelineRow>(
  rows: readonly TRow[],
  end: number,
): number {
  let start = Math.min(rows.length, Math.max(0, end));
  let weight = 0;
  while (start > 0 && weight < OLDER_PAGE_PREPEND_BATCH_TARGET) {
    start -= 1;
    const row = rows[start];
    if (row) {
      weight += getTimelineRowRenderWeight(row);
    }
  }
  return start;
}

function getPrependedTimelineRowCount<TRow extends KeyedTimelineRow>(
  previous: readonly TRow[],
  next: readonly TRow[],
): number {
  const added = next.length - previous.length;
  if (added <= 0) {
    return 0;
  }
  for (let index = 0; index < previous.length; index += 1) {
    if (previous[index]?.key !== next[index + added]?.key) {
      return 0;
    }
  }
  return added;
}

export function useChunkedTimelinePrepend<TRow extends KeyedTimelineRow>(
  rows: readonly TRow[],
  prependPending: boolean,
): { active: boolean; revision: number; rows: readonly TRow[] } {
  const stateRef = useRef<ChunkedTimelinePrependState<TRow>>({
    rows,
    start: 0,
  });
  const [revision, setRevision] = useState(0);
  let current = stateRef.current;

  if (current.rows !== rows) {
    const firstVisibleKey = current.rows[current.start]?.key;
    const preservedStart =
      current.start > 0 && firstVisibleKey
        ? rows.findIndex((row) => row.key === firstVisibleKey)
        : -1;
    const prepended = prependPending
      ? getPrependedTimelineRowCount(current.rows, rows)
      : 0;
    if (preservedStart >= 0) {
      current.rows = rows;
      current.start = preservedStart;
    } else {
      current = {
        rows,
        start:
          prepended > 0 ? getPreviousTimelineBatchStart(rows, prepended) : 0,
      };
      stateRef.current = current;
    }
  }

  useLayoutEffect(() => {
    if (current.start <= 0) {
      return;
    }
    const scheduledState = current;
    const frame = requestAnimationFrame(() => {
      if (stateRef.current !== scheduledState) {
        return;
      }
      const start = getPreviousTimelineBatchStart(
        scheduledState.rows,
        scheduledState.start,
      );
      if (start === scheduledState.start) {
        return;
      }
      stateRef.current = {
        ...scheduledState,
        start,
      };
      setRevision((previous) => previous + 1);
    });
    return () => cancelAnimationFrame(frame);
  }, [current]);

  return {
    active: current.start > 0,
    revision,
    rows: current.rows.slice(current.start),
  };
}

export interface BtwAsideTimelineItem {
  id: string;
  request: string;
  followUps: string[];
  status: "draft" | "starting" | "running" | "complete" | "failed" | "stopped";
  createdAt: string;
  updatedAt: string;
  historyAt?: string;
  preview?: string;
  error?: string;
  responses: string[];
  turns?: BtwAsideTranscriptTurn[];
  expanded?: boolean;
  isFocused?: boolean;
  canStop?: boolean;
}
import type { BtwAsideTranscriptTurn } from "./BtwAsidePane";
