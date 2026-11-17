import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  findRenderRow,
  getFirstVisibleRenderAnchor,
  restoreScrollToAnchorRow,
  type VisibleRenderAnchor,
} from "../lib/scrollAnchors";

const RENDER_WINDOW_MIN_WEIGHT = 200;
const RENDER_WINDOW_OVERSCAN_VIEWPORTS = 1.25;
const RENDER_WINDOW_MAX_ROWS = 48;
const ESTIMATED_ROW_HEIGHT_PX = 96;
const MIN_ESTIMATED_ROW_HEIGHT_PX = 48;

interface KeyedTranscriptRow {
  key: string;
}

interface TranscriptRenderRowModel<TRow> {
  endPx: number;
  offsetPx: number;
  row: TRow;
}

interface TranscriptRenderModel<TRow> {
  active: boolean;
  rows: readonly TranscriptRenderRowModel<TRow>[];
  targetIndexes: ReadonlyMap<string, number>;
  totalHeightPx: number;
  totalWeight: number;
}

interface TranscriptViewport {
  clientHeight: number;
  listStartPx: number;
  ready: boolean;
  scrollTop: number;
}

interface TranscriptRenderRange {
  end: number;
  start: number;
}

interface UseTranscriptRenderWindowOptions<TRow extends KeyedTranscriptRow> {
  containerRef: RefObject<HTMLDivElement | null>;
  followTail: boolean;
  getRowTargetIds: (row: TRow) => readonly string[];
  getRowWeight: (row: TRow) => number;
  pinnedRenderId?: string | null;
  retainedRenderIds?: readonly string[];
  rows: readonly TRow[];
}

export interface TranscriptRenderWindow<TRow> {
  active: boolean;
  afterHeightPx: number;
  beforeHeightPx: number;
  getRenderIdTop: (id: string) => number | null;
  getRowSpacerBefore: (key: string) => number;
  registerListStart: (element: HTMLSpanElement | null) => void;
  registerRowEnd: (key: string, element: HTMLSpanElement | null) => void;
  registerRowStart: (key: string, element: HTMLSpanElement | null) => void;
  revealRenderId: (id: string) => boolean;
  /** Drop a scroll anchor captured before a programmatic jump. */
  discardPendingAnchor: () => void;
  rows: readonly TRow[];
  totalWeight: number;
}

function getEstimatedHeightPx(weight: number): number {
  return Math.max(
    MIN_ESTIMATED_ROW_HEIGHT_PX,
    Math.max(1, weight) * ESTIMATED_ROW_HEIGHT_PX,
  );
}

function findRowIndexAtOffset<TRow>(
  rows: readonly TranscriptRenderRowModel<TRow>[],
  offsetPx: number,
): number {
  if (rows.length === 0) return 0;
  const target = Math.max(0, offsetPx);
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((rows[middle]?.endPx ?? 0) <= target) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return Math.min(low, rows.length - 1);
}

function capRange(
  range: TranscriptRenderRange,
  rowCount: number,
  focusIndex: number,
): TranscriptRenderRange {
  if (range.end - range.start <= RENDER_WINDOW_MAX_ROWS) {
    return range;
  }
  const half = Math.floor(RENDER_WINDOW_MAX_ROWS / 2);
  const start = Math.max(
    0,
    Math.min(focusIndex - half, rowCount - RENDER_WINDOW_MAX_ROWS),
  );
  return { start, end: Math.min(rowCount, start + RENDER_WINDOW_MAX_ROWS) };
}

function getRenderRange<TRow>(
  model: TranscriptRenderModel<TRow>,
  viewport: TranscriptViewport,
  listStartPx: number,
  followTail: boolean,
  targetIndex: number | null,
): TranscriptRenderRange {
  const rowCount = model.rows.length;
  if (!model.active || rowCount === 0) {
    return { start: 0, end: rowCount };
  }

  const clientHeight = Math.max(1, viewport.clientHeight || 600);
  if (targetIndex !== null) {
    const target = model.rows[targetIndex];
    if (target) {
      const overscan = clientHeight * RENDER_WINDOW_OVERSCAN_VIEWPORTS;
      const start = findRowIndexAtOffset(
        model.rows,
        target.offsetPx - overscan,
      );
      const end = Math.min(
        rowCount,
        findRowIndexAtOffset(model.rows, target.endPx + overscan) + 1,
      );
      return capRange({ start, end }, rowCount, targetIndex);
    }
  }

  if (followTail || !viewport.ready) {
    const visibleStart = Math.max(0, model.totalHeightPx - clientHeight);
    const start = findRowIndexAtOffset(
      model.rows,
      visibleStart - clientHeight * RENDER_WINDOW_OVERSCAN_VIEWPORTS,
    );
    return capRange(
      { start, end: rowCount },
      rowCount,
      Math.max(0, rowCount - 1),
    );
  }

  const relativeTop = Math.max(0, viewport.scrollTop - listStartPx);
  const overscan = clientHeight * RENDER_WINDOW_OVERSCAN_VIEWPORTS;
  const start = findRowIndexAtOffset(model.rows, relativeTop - overscan);
  const end = Math.min(
    rowCount,
    findRowIndexAtOffset(model.rows, relativeTop + clientHeight + overscan) + 1,
  );
  const focusIndex = findRowIndexAtOffset(
    model.rows,
    relativeTop + clientHeight / 2,
  );
  return capRange({ start, end }, rowCount, focusIndex);
}

export function useTranscriptRenderWindow<TRow extends KeyedTranscriptRow>({
  containerRef,
  followTail,
  getRowTargetIds,
  getRowWeight,
  pinnedRenderId = null,
  retainedRenderIds = [],
  rows,
}: UseTranscriptRenderWindowOptions<TRow>): TranscriptRenderWindow<TRow> {
  const measuredHeightsRef = useRef(new Map<string, number>());
  const rowStartsRef = useRef(new Map<string, HTMLSpanElement>());
  const rowEndsRef = useRef(new Map<string, HTMLSpanElement>());
  const listStartRef = useRef<HTMLSpanElement | null>(null);
  const followTailRef = useRef(followTail);
  const pendingAnchorRef = useRef<VisibleRenderAnchor | null>(null);
  const revealingRef = useRef(false);
  const viewportFrameRef = useRef<number | null>(null);
  const measurementFrameRef = useRef<number | null>(null);
  const [heightRevision, setHeightRevision] = useState(0);
  const [forcedRenderId, setForcedRenderId] = useState<string | null>(null);
  const [viewport, setViewport] = useState<TranscriptViewport>({
    clientHeight: 600,
    listStartPx: 0,
    ready: false,
    scrollTop: 0,
  });

  const model = useMemo<TranscriptRenderModel<TRow>>(() => {
    void heightRevision;
    const targetIndexes = new Map<string, number>();
    const modeledRows: Array<TranscriptRenderRowModel<TRow>> = [];
    let offsetPx = 0;
    let totalWeight = 0;
    rows.forEach((row, index) => {
      const weight = Math.max(0, getRowWeight(row));
      const measuredHeight = measuredHeightsRef.current.get(row.key);
      const heightPx = measuredHeight ?? getEstimatedHeightPx(weight);
      const targetIds = getRowTargetIds(row);
      for (const targetId of targetIds) {
        if (!targetIndexes.has(targetId)) {
          targetIndexes.set(targetId, index);
        }
      }
      totalWeight += weight;
      modeledRows.push({
        endPx: offsetPx + heightPx,
        offsetPx,
        row,
      });
      offsetPx += heightPx;
    });
    return {
      active: totalWeight >= RENDER_WINDOW_MIN_WEIGHT,
      rows: modeledRows,
      targetIndexes,
      totalHeightPx: offsetPx,
      totalWeight,
    };
  }, [getRowTargetIds, getRowWeight, heightRevision, rows]);

  const getListStartPx = useCallback((): number => {
    const messageList = containerRef.current;
    const scrollContainer = messageList?.parentElement;
    const marker = listStartRef.current;
    if (!scrollContainer || !marker) return 0;
    const scrollRect = scrollContainer.getBoundingClientRect();
    const markerRect = marker.getBoundingClientRect();
    return scrollContainer.scrollTop + markerRect.top - scrollRect.top;
  }, [containerRef]);

  const targetRenderId = forcedRenderId ?? pinnedRenderId;
  const targetIndex = targetRenderId
    ? (model.targetIndexes.get(targetRenderId) ?? null)
    : null;
  const range = getRenderRange(
    model,
    viewport,
    viewport.listStartPx,
    followTail,
    targetIndex,
  );
  const selectedIndexes = new Set<number>();
  for (let index = range.start; index < range.end; index += 1) {
    selectedIndexes.add(index);
  }
  if (model.active) {
    for (const retainedRenderId of retainedRenderIds) {
      const retainedIndex = model.targetIndexes.get(retainedRenderId);
      if (retainedIndex !== undefined) {
        selectedIndexes.add(retainedIndex);
      }
    }
  }
  const selectedRows = [...selectedIndexes]
    .sort((left, right) => left - right)
    .map((index) => model.rows[index])
    .filter((row): row is TranscriptRenderRowModel<TRow> => row !== undefined);
  const visibleRows = selectedRows.map((row) => row.row);
  const beforeHeightPx = selectedRows[0]?.offsetPx ?? 0;
  const spacerBeforeByKey = new Map<string, number>();
  for (let index = 1; index < selectedRows.length; index += 1) {
    const previous = selectedRows[index - 1];
    const current = selectedRows[index];
    if (!previous || !current) continue;
    const spacerHeightPx = current.offsetPx - previous.endPx;
    if (spacerHeightPx > 0) {
      spacerBeforeByKey.set(current.row.key, spacerHeightPx);
    }
  }
  const afterHeightPx =
    model.totalHeightPx - (selectedRows[selectedRows.length - 1]?.endPx ?? 0);

  const captureVisibleAnchor = useCallback(() => {
    if (followTailRef.current) return;
    const messageList = containerRef.current;
    const scrollContainer = messageList?.parentElement;
    if (!messageList || !scrollContainer) return;
    pendingAnchorRef.current = getFirstVisibleRenderAnchor(
      messageList,
      scrollContainer,
    );
  }, [containerRef]);

  const measureMountedRows = useCallback(() => {
    if (!model.active) return;
    let changed = false;
    for (const [key, start] of rowStartsRef.current) {
      const end = rowEndsRef.current.get(key);
      if (!end) continue;
      const heightPx = Math.max(
        0,
        end.getBoundingClientRect().top - start.getBoundingClientRect().top,
      );
      if (heightPx < 1) continue;
      const previous = measuredHeightsRef.current.get(key);
      if (previous !== undefined && Math.abs(previous - heightPx) < 0.5) {
        continue;
      }
      measuredHeightsRef.current.set(key, heightPx);
      changed = true;
    }
    if (changed) {
      captureVisibleAnchor();
      setHeightRevision((revision) => revision + 1);
    }
  }, [captureVisibleAnchor, model.active]);

  const scheduleMeasurement = useCallback(() => {
    if (measurementFrameRef.current !== null) return;
    measurementFrameRef.current = requestAnimationFrame(() => {
      measurementFrameRef.current = null;
      measureMountedRows();
    });
  }, [measureMountedRows]);

  const registerListStart = useCallback((element: HTMLSpanElement | null) => {
    listStartRef.current = element;
  }, []);
  const registerRowStart = useCallback(
    (key: string, element: HTMLSpanElement | null) => {
      if (element) {
        rowStartsRef.current.set(key, element);
        scheduleMeasurement();
      } else {
        rowStartsRef.current.delete(key);
      }
    },
    [scheduleMeasurement],
  );
  const registerRowEnd = useCallback(
    (key: string, element: HTMLSpanElement | null) => {
      if (element) {
        rowEndsRef.current.set(key, element);
        scheduleMeasurement();
      } else {
        rowEndsRef.current.delete(key);
      }
    },
    [scheduleMeasurement],
  );

  const getRenderIdTop = useCallback(
    (id: string): number | null => {
      const index = model.targetIndexes.get(id);
      const row = index === undefined ? undefined : model.rows[index];
      return row ? getListStartPx() + row.offsetPx : null;
    },
    [getListStartPx, model.rows, model.targetIndexes],
  );
  const getRowSpacerBefore = useCallback(
    (key: string) => spacerBeforeByKey.get(key) ?? 0,
    [spacerBeforeByKey],
  );

  const discardPendingAnchor = useCallback(() => {
    pendingAnchorRef.current = null;
  }, []);

  const revealRenderId = useCallback(
    (id: string): boolean => {
      if (!model.targetIndexes.has(id)) return false;
      pendingAnchorRef.current = null;
      revealingRef.current = true;
      setForcedRenderId(id);
      return true;
    },
    [model.targetIndexes],
  );

  useLayoutEffect(() => {
    followTailRef.current = followTail;
    const pendingAnchor = pendingAnchorRef.current;
    pendingAnchorRef.current = null;
    // The transcript's live-tail owner can re-pin between capture and commit.
    if (!pendingAnchor || followTail) return;
    const messageList = containerRef.current;
    const scrollContainer = messageList?.parentElement;
    const anchorRow = findRenderRow(messageList, pendingAnchor.id);
    if (scrollContainer && anchorRow) {
      restoreScrollToAnchorRow(
        scrollContainer,
        anchorRow,
        pendingAnchor.topOffset,
      );
    }
  });

  useEffect(() => {
    if (!forcedRenderId || targetIndex === null) return;
    if (targetIndex < range.start || targetIndex >= range.end) return;
    const frame = requestAnimationFrame(() => {
      revealingRef.current = false;
      setForcedRenderId(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [forcedRenderId, range.end, range.start, targetIndex]);

  useEffect(() => {
    const messageList = containerRef.current;
    const scrollContainer = messageList?.parentElement;
    if (!messageList || !scrollContainer) return;

    const publishViewport = () => {
      setViewport((previous) => {
        const next = {
          clientHeight: scrollContainer.clientHeight,
          listStartPx: getListStartPx(),
          ready: true,
          scrollTop: scrollContainer.scrollTop,
        };
        return previous.ready &&
          previous.clientHeight === next.clientHeight &&
          Math.abs(previous.listStartPx - next.listStartPx) < 0.5 &&
          Math.abs(previous.scrollTop - next.scrollTop) < 0.5
          ? previous
          : next;
      });
    };
    const scheduleViewport = () => {
      if (viewportFrameRef.current !== null) return;
      if (model.active && !revealingRef.current) {
        captureVisibleAnchor();
      }
      viewportFrameRef.current = requestAnimationFrame(() => {
        viewportFrameRef.current = null;
        publishViewport();
      });
    };
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(scheduleMeasurement);
    resizeObserver?.observe(messageList);
    resizeObserver?.observe(scrollContainer);
    scrollContainer.addEventListener("scroll", scheduleViewport, {
      passive: true,
    });
    window.addEventListener("resize", scheduleViewport);
    publishViewport();
    scheduleMeasurement();

    return () => {
      resizeObserver?.disconnect();
      scrollContainer.removeEventListener("scroll", scheduleViewport);
      window.removeEventListener("resize", scheduleViewport);
      if (viewportFrameRef.current !== null) {
        cancelAnimationFrame(viewportFrameRef.current);
        viewportFrameRef.current = null;
      }
      if (measurementFrameRef.current !== null) {
        cancelAnimationFrame(measurementFrameRef.current);
        measurementFrameRef.current = null;
      }
    };
  }, [
    captureVisibleAnchor,
    containerRef,
    getListStartPx,
    model.active,
    scheduleMeasurement,
  ]);

  useEffect(() => {
    const liveKeys = new Set(rows.map((row) => row.key));
    for (const key of measuredHeightsRef.current.keys()) {
      if (!liveKeys.has(key)) {
        measuredHeightsRef.current.delete(key);
      }
    }
  }, [rows]);

  return {
    active: model.active,
    afterHeightPx,
    beforeHeightPx,
    getRenderIdTop,
    getRowSpacerBefore,
    registerListStart,
    registerRowEnd,
    registerRowStart,
    revealRenderId,
    discardPendingAnchor,
    rows: visibleRows,
    totalWeight: model.totalWeight,
  };
}
