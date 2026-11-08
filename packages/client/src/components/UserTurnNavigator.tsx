import {
  type CSSProperties,
  memo,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  type TouchEvent as ReactTouchEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  getCollapsedSearchPreviewText,
  normalizeSearchPreviewText as normalizePreviewText,
} from "@yep-anywhere/shared";
import { renderHighlightedText } from "./SearchPreview";
import { useI18n } from "../i18n";
import { findRenderRow, indexRenderRowsById } from "../lib/scrollAnchors";
import styles from "./UserTurnNavigator.module.css";
import { ButtonBase } from "./ui/Button";

export interface UserTurnNavAnchor {
  id: string;
  preview: string;
  searchText?: string;
  targetId?: string;
  timestampMs?: number | null;
}

export interface UserTurnNavSearchState {
  activeId: string | null;
  caseSensitive?: boolean;
  matchIds: ReadonlySet<string>;
  preview: string | null;
  previewsById: ReadonlyMap<string, string>;
  query: string;
}

export interface UserTurnNavMotionCue {
  direction: "up" | "down";
  token: number;
}

interface Props {
  anchors?: UserTurnNavAnchor[];
  getAnchors?: () => UserTurnNavAnchor[];
  messageListRef: RefObject<HTMLDivElement | null>;
  motionCue?: UserTurnNavMotionCue | null;
  onNavigateStart?: () => void;
  /** `close` jumps to the match and ends search, as Enter does. */
  onSearchMatchSelect?: (id: string, targetId: string, close?: boolean) => void;
  /** "Show from": load the client transcript from this turn (drop earlier). */
  onTrimAnchor?: (id: string) => void;
  /** Whether "Show from" is valid for a particular loaded turn. */
  canTrimAnchor?: (id: string) => boolean;
  /** Fork the session before this turn. */
  onForkBeforeAnchor?: (id: string) => void;
  /** Whether a before-turn boundary exists for a particular anchor. */
  canForkBeforeAnchor?: (id: string) => boolean;
  /** Fork after this completed turn. */
  onForkAfterAnchor?: (id: string) => void;
  /** Whether an after-turn fork is valid for a particular loaded turn. */
  canForkAfterAnchor?: (id: string) => boolean;
  /** Disable after-turn actions while the selected/latest response is active. */
  forkAfterDisabled?: boolean;
  /** Copy this turn's text to the clipboard. */
  onCopyAnchor?: (id: string) => void;
  /** Whether the external copy callback can resolve a particular turn. */
  canCopyAnchor?: (id: string) => boolean;
  /** Open a new session prefilled from this turn's conversation source. */
  onHandoffFromAnchor?: (id: string, options: { newTab: boolean }) => void;
  /** Reports the timestamp for a hovered/focused turn marker, if any. */
  onPreviewTimestampChange?: (timestampMs: number | null) => void;
  /** Estimated transcript offset for a render row outside the mounted window. */
  getRenderIdTop?: (id: string) => number | null;
  /** Mount the semantic transcript row that owns this render id. */
  revealRenderId?: (id: string) => boolean;
  searchState?: UserTurnNavSearchState | null;
}

interface UserTurnMarker extends UserTurnNavAnchor {
  topPct: number;
  scrollTopPx: number;
  /** Rendered fraction of the track for the dash/dot/hit-target (equals topPct
   *  when spread is off; de-clustered when MARKER_SPREAD_PX > 0). */
  renderTopPct: number;
  /** Hit/hover target height in px, sized to the gap to neighbors. */
  hitPx: number;
}

interface UserTurnNavLayout {
  top: number;
  right: number;
  height: number;
  thumbTopPct: number;
  thumbHeightPct: number;
  activeId: string;
  markers: UserTurnMarker[];
  previewMaxWidthPx: number;
  signature: string;
}

interface UserTurnPreviewLabel {
  id: string;
  targetId: string;
  topPx: number;
  verticalAnchor: "start" | "center" | "end";
  text: string;
  compact: boolean;
  short: boolean;
  active: boolean;
  expanded: boolean;
  pinned: boolean;
}

interface PreviewFacsimileLine {
  text: string;
  mono: boolean;
}

interface PreviewFacsimile {
  tags: string[];
  lines: PreviewFacsimileLine[];
}

const MOTION_CUE_CLASS: Record<UserTurnNavMotionCue["direction"], string> = {
  down: styles.motionDown ?? "",
  up: styles.motionUp ?? "",
};

const MIN_NAV_ANCHORS = 2;
const NAV_VERTICAL_INSET_PX = 8;
// Per-marker hit/hover target height is sized to the gap to its neighbors (so
// targets tile without overlap and don't activate blank space), clamped to this
// range. Dashes stay at their true positions (option B). See
// topics/turn-rail-marker-layout.md.
const MARKER_HIT_MIN_PX = 6;
const MARKER_HIT_MAX_PX = 18;
// De-cluster spread (option A): dense markers are pushed apart to at least this
// px gap via L2-optimal min-gap placement. NOTE this is in direct tension with
// conveying "work between turns": PAVA equalizes the spacing of any run denser
// than the gap, erasing the density signal there, so a long session pooled at a
// large gap looks almost evenly spaced. The knob trades density-signal (low)
// for separation (high). 3px ~= the dash height: only nudges near-coincident
// marks apart, leaving every larger gap (and its work signal) intact. 0 =
// fully accurate. Sparse markers always keep true positions; in extremely long
// sessions N*gap can exceed the rail and markers pile up at the bottom.
// Internal tuning constant, not a user setting.
const MARKER_SPREAD_PX = 3;
const PREVIEW_EDGE_MARGIN_PX = 1;
const PREVIEW_VERTICAL_MARGIN_PX = 5;
const PREVIEW_EDGE_ANCHOR_EPSILON_PX = 0.5;
// Half the hover preview's max rendered height (CSS max-height: 4.4em on
// .preview in the module). A centered preview reaches this far above/below its
// marker, so a marker within this distance of an edge must flip to an edge
// anchor or the box is clipped by the banner before its center reaches the top.
const PREVIEW_MAX_HALF_HEIGHT_PX = 32;
const PREVIEW_FULL_MIN_GAP_PX = 62;
const SEARCH_PREVIEW_COLLAPSED_LABEL_HEIGHT_PX = 15;
const SEARCH_PREVIEW_COLLAPSED_VISUAL_GAP_PX = 1;
const PREVIEW_COMPACT_MIN_GAP_PX =
  SEARCH_PREVIEW_COLLAPSED_LABEL_HEIGHT_PX +
  SEARCH_PREVIEW_COLLAPSED_VISUAL_GAP_PX;
const NAV_REVEAL_HOTZONE_PX = 64;
const MAX_SEARCH_PREVIEW_LABELS = 64;
const SHORT_PREVIEW_MAX_CHARS = 48;
const MOTION_CUE_CLEAR_MS = 760;
const SEARCH_MARKER_HOVER_STICKY_Y_PX = 1;

type LayoutUpdateKind = "full" | "scroll";

function getScrollContainer(
  messageList: HTMLDivElement | null,
): HTMLElement | null {
  return messageList?.parentElement ?? null;
}

/**
 * Optimal min-gap placement: given desired positions `xs` (ascending) and a
 * minimum gap, return positions with `out[i+1] - out[i] >= gap` minimizing the
 * sum of squared displacement from `xs`. Substituting `w_i = y_i - i*gap` turns
 * the gap constraint into "w non-decreasing", so this is isotonic regression
 * via pool-adjacent-violators (O(n)). Far-apart clusters keep their true
 * positions; only dense ones spread (to exactly `gap`, centered on their
 * centroid), so spreading one cluster never shoves it into the next. See
 * topics/turn-rail-marker-layout.md.
 */
function spreadMinGap(xs: number[], gap: number): number[] {
  const n = xs.length;
  if (gap <= 0 || n === 0) return xs.slice();
  const blocks: { sum: number; count: number }[] = [];
  for (let i = 0; i < n; i++) {
    let sum = (xs[i] ?? 0) - i * gap; // shift into isotonic space
    let count = 1;
    let prev = blocks[blocks.length - 1];
    while (prev && prev.sum / prev.count > sum / count) {
      blocks.pop();
      sum += prev.sum;
      count += prev.count;
      prev = blocks[blocks.length - 1];
    }
    blocks.push({ sum, count });
  }
  const out = Array.from({ length: n }, () => 0);
  let idx = 0;
  for (const block of blocks) {
    const mean = block.sum / block.count;
    for (let k = 0; k < block.count; k++) {
      out[idx] = mean + idx * gap; // shift back out
      idx++;
    }
  }
  return out;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function isShortSingleLinePreview(text: string): boolean {
  const normalizedText = normalizePreviewText(text);
  return (
    normalizedText.length <= SHORT_PREVIEW_MAX_CHARS &&
    !normalizedText.includes("\n")
  );
}

function isPreviewLineMono(line: string): boolean {
  return (
    /(^|\s)(cat|find|git|grep|pnpm|rg|sed|tsx?|vitest)\b/.test(line) ||
    /[/\\][\w.-]+/.test(line) ||
    /[`{}[\]()<>=|;]/.test(line)
  );
}

function splitPreviewFacsimile(text: string): PreviewFacsimile {
  const normalizedText = normalizePreviewText(text);
  const [firstLine = "", ...remainingLines] = normalizedText.split("\n");
  const separatorIndex = firstLine.indexOf(":");
  const tags =
    separatorIndex > 0 && separatorIndex <= 80
      ? firstLine
          .slice(0, separatorIndex)
          .split(/\s+\/\s+|\s+›\s+/)
          .map((tag) => tag.trim())
          .filter(Boolean)
      : [];
  const firstBodyLine =
    tags.length > 0
      ? firstLine.slice(separatorIndex + 1).trimStart()
      : firstLine;
  const bodyLines = [firstBodyLine, ...remainingLines]
    .map((line) => line.trim())
    .filter(Boolean);
  const lines = (bodyLines.length > 0 ? bodyLines : [normalizedText])
    .slice(0, 6)
    .map((line) => ({
      text: line,
      mono: isPreviewLineMono(line),
    }));

  return {
    tags,
    lines,
  };
}

function renderFacsimileLine(
  line: PreviewFacsimileLine,
  index: number,
  searchState: UserTurnNavSearchState,
) {
  return (
    <span
      key={`${index}:${line.text}`}
      className={[styles.facsimileLine, line.mono ? styles.mono : ""]
        .filter(Boolean)
        .join(" ")}
    >
      {renderHighlightedText(
        line.text,
        searchState.query,
        searchState.caseSensitive,
      )}
    </span>
  );
}

function renderPreviewFacsimile(
  label: UserTurnPreviewLabel,
  searchState: UserTurnNavSearchState,
) {
  const facsimile = splitPreviewFacsimile(label.text);
  return (
    <span className={styles.facsimile}>
      <span className={styles.facsimileRail} aria-hidden />
      <span className={styles.facsimileContent}>
        {facsimile.tags.length > 0 && (
          <span className={styles.facsimileTags}>
            {facsimile.tags.map((tag) => (
              <span key={tag} className={styles.facsimileTag}>
                {renderHighlightedText(
                  tag,
                  searchState.query,
                  searchState.caseSensitive,
                )}
              </span>
            ))}
          </span>
        )}
        <span className={styles.facsimileLines}>
          {facsimile.lines.map((line, index) =>
            renderFacsimileLine(line, index, searchState),
          )}
        </span>
      </span>
    </span>
  );
}

function renderPreviewLabelText(
  label: UserTurnPreviewLabel,
  searchState: UserTurnNavSearchState | null | undefined,
) {
  if (!searchState) {
    return label.text;
  }

  if (!label.expanded) {
    const collapsedText = getCollapsedSearchPreviewText(
      label.text,
      searchState.query,
      searchState.caseSensitive,
    );
    return renderHighlightedText(
      collapsedText,
      searchState.query,
      searchState.caseSensitive,
    );
  }

  return renderPreviewFacsimile(label, searchState);
}

// Small tolerance so a turn flush against the viewport top isn't treated as
// scrolled-off due to sub-pixel rounding.
const ACTIVE_TOP_TOLERANCE_PX = 2;

/**
 * The active (long) marker is the first user turn whose row top has reached the
 * viewport top — i.e. the topmost *fully visible* user turn. A user turn whose
 * row has scrolled off the top (you are now reading its trailing system output)
 * is skipped, so the long-dash tracks the visible turn, not the one whose output
 * fills the viewport. Recomputed on every scroll (real scrollbar and click-jump
 * alike go through updateScrollPosition), so the same rule governs both. Falls
 * back to the last marker when scrolled past all of them.
 */
function findActiveId(markers: UserTurnMarker[], scrollTop: number): string {
  if (markers.length === 0) return "";
  // Markers are sorted top→bottom by scrollTopPx (cached at layout time), so
  // lower-bound by binary search instead of scanning — O(log n) per scroll.
  const threshold = scrollTop - ACTIVE_TOP_TOLERANCE_PX;
  let lo = 0;
  let hi = markers.length; // first index with scrollTopPx >= threshold, in [lo,hi)
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((markers[mid]?.scrollTopPx ?? 0) >= threshold) hi = mid;
    else lo = mid + 1;
  }
  // lo is the first fully-visible turn; if scrolled past all, use the last.
  return (markers[lo] ?? markers[markers.length - 1])?.id ?? "";
}

function getAnimationFrame(): {
  request: (callback: FrameRequestCallback) => number;
  cancel: (id: number) => void;
} {
  if (typeof window.requestAnimationFrame === "function") {
    return {
      request: window.requestAnimationFrame.bind(window),
      cancel: window.cancelAnimationFrame.bind(window),
    };
  }
  return {
    request: (callback) =>
      window.setTimeout(() => callback(performance.now()), 16),
    cancel: window.clearTimeout.bind(window),
  };
}

function buildSignature(layout: Omit<UserTurnNavLayout, "signature">): string {
  const markerSignature = layout.markers
    .map(
      (marker) =>
        `${marker.id}:${marker.targetId ?? marker.id}:${Math.round(
          marker.topPct * 100,
        )}:${marker.timestampMs ?? ""}`,
    )
    .join("|");
  return [
    Math.round(layout.top),
    Math.round(layout.right),
    Math.round(layout.height),
    Math.round(layout.thumbTopPct * 100),
    Math.round(layout.thumbHeightPct * 100),
    layout.activeId,
    Math.round(layout.previewMaxWidthPx),
    markerSignature,
  ].join(":");
}

function measureLayout(
  anchors: UserTurnNavAnchor[],
  messageList: HTMLDivElement | null,
  minAnchors = MIN_NAV_ANCHORS,
  getRenderIdTop?: (id: string) => number | null,
): UserTurnNavLayout | null {
  if (anchors.length < minAnchors || !messageList) {
    return null;
  }

  const scrollContainer = getScrollContainer(messageList);
  if (!scrollContainer) {
    return null;
  }

  const scrollRect = scrollContainer.getBoundingClientRect();
  if (scrollRect.width <= 0 || scrollRect.height <= 0) {
    return null;
  }

  const scrollHeight = Math.max(scrollContainer.scrollHeight, 1);
  const clientHeight = Math.max(scrollContainer.clientHeight, 1);
  const markers: UserTurnMarker[] = [];
  const rowsById = indexRenderRowsById(messageList);

  for (const anchor of anchors) {
    const targetId = anchor.targetId ?? anchor.id;
    const row = rowsById.get(targetId);
    const virtualTop = row ? null : getRenderIdTop?.(targetId);
    if (!row && (virtualTop === null || virtualTop === undefined)) {
      continue;
    }
    const rowRect = row?.getBoundingClientRect();
    const scrollTopPx = rowRect
      ? scrollContainer.scrollTop + rowRect.top - scrollRect.top
      : (virtualTop ?? 0);
    const topPct = clamp(scrollTopPx / scrollHeight, 0, 1);
    markers.push({
      ...anchor,
      scrollTopPx,
      topPct,
      renderTopPct: topPct, // filled in below once track height is known
      hitPx: MARKER_HIT_MAX_PX,
    });
  }

  if (markers.length < minAnchors) {
    return null;
  }

  const top = scrollRect.top + NAV_VERTICAL_INSET_PX;
  const height = Math.max(scrollRect.height - NAV_VERTICAL_INSET_PX * 2, 1);

  // Render geometry (option B + optional spread A): place each marker, then size
  // its hit/hover target to the gap to its neighbors so targets tile without
  // overlap and don't activate blank space. MARKER_SPREAD_PX > 0 de-clusters
  // dense markers first (dashes spread to match their targets). True positions
  // are preserved when spread is 0. See topics/turn-rail-marker-layout.md.
  const rawPx = markers.map((marker) => marker.topPct * height);
  const renderPx =
    MARKER_SPREAD_PX > 0 ? spreadMinGap(rawPx, MARKER_SPREAD_PX) : rawPx;
  for (let i = 0; i < markers.length; i++) {
    const marker = markers[i];
    if (!marker) continue;
    const pos = renderPx[i] ?? marker.topPct * height;
    marker.renderTopPct = clamp(pos / height, 0, 1);
    const gapAbove =
      i > 0 ? pos - (renderPx[i - 1] ?? pos) : Number.POSITIVE_INFINITY;
    const gapBelow =
      i < markers.length - 1
        ? (renderPx[i + 1] ?? pos) - pos
        : Number.POSITIVE_INFINITY;
    marker.hitPx = clamp(
      Math.min(gapAbove, gapBelow),
      MARKER_HIT_MIN_PX,
      MARKER_HIT_MAX_PX,
    );
  }
  const right =
    window.innerWidth -
    scrollRect.right +
    (scrollContainer.offsetWidth - scrollContainer.clientWidth);
  const previewMaxWidthPx = clamp(window.innerWidth - right - 42, 160, 620);
  const layoutWithoutSignature = {
    top,
    right,
    height,
    thumbTopPct: clamp(scrollContainer.scrollTop / scrollHeight, 0, 1),
    thumbHeightPct: clamp(clientHeight / scrollHeight, 0.04, 1),
    activeId: findActiveId(markers, scrollContainer.scrollTop),
    markers,
    previewMaxWidthPx,
  };
  return {
    ...layoutWithoutSignature,
    signature: buildSignature(layoutWithoutSignature),
  };
}

function updateScrollPosition(
  layout: UserTurnNavLayout,
  scrollContainer: HTMLElement,
): UserTurnNavLayout {
  const scrollHeight = Math.max(scrollContainer.scrollHeight, 1);
  const clientHeight = Math.max(scrollContainer.clientHeight, 1);
  const nextLayout = {
    ...layout,
    thumbTopPct: clamp(scrollContainer.scrollTop / scrollHeight, 0, 1),
    thumbHeightPct: clamp(clientHeight / scrollHeight, 0.04, 1),
    activeId: findActiveId(layout.markers, scrollContainer.scrollTop),
  };
  return {
    ...nextLayout,
    signature: buildSignature(nextLayout),
  };
}

function spreadPreviewLabels(
  labels: UserTurnPreviewLabel[],
  layoutHeight: number,
  compact: boolean,
): UserTurnPreviewLabel[] {
  if (labels.length <= 1) {
    return labels.map((label) =>
      anchorPreviewLabelToRailEdge(label, layoutHeight),
    );
  }

  const preferredGap = compact
    ? PREVIEW_COMPACT_MIN_GAP_PX
    : PREVIEW_FULL_MIN_GAP_PX;
  const minTop = PREVIEW_VERTICAL_MARGIN_PX;
  const maxTop = Math.max(minTop, layoutHeight - PREVIEW_VERTICAL_MARGIN_PX);
  const availableHeight = Math.max(1, maxTop - minTop);
  const minGap = Math.min(preferredGap, availableHeight / (labels.length - 1));
  const placed = labels.map((label) => ({ ...label }));

  for (let index = 1; index < placed.length; index += 1) {
    const current = placed[index];
    const previous = placed[index - 1];
    if (!current || !previous) continue;
    current.topPx = Math.max(current.topPx, previous.topPx + minGap);
  }

  const lastPlaced = placed[placed.length - 1];
  const overflow = lastPlaced ? lastPlaced.topPx - maxTop : 0;
  if (overflow > 0) {
    for (const label of placed) {
      label.topPx -= overflow;
    }
  }

  const firstPlaced = placed[0];
  if (firstPlaced) {
    firstPlaced.topPx = Math.max(firstPlaced.topPx, minTop);
  }
  for (let index = 1; index < placed.length; index += 1) {
    const current = placed[index];
    const previous = placed[index - 1];
    if (!current || !previous) continue;
    current.topPx = Math.max(current.topPx, previous.topPx + minGap);
  }

  return placed.map((label) =>
    anchorPreviewLabelToRailEdge(
      {
        ...label,
        topPx: clamp(label.topPx, minTop, maxTop),
      },
      layoutHeight,
    ),
  );
}

// A preview centered on a marker near the top/bottom of the rail extends half
// its height past that edge, where a top banner (or the viewport) clips it.
// Within `flipZonePx` of an edge, anchor the box to the edge instead so it
// grows inward and stays fully visible: "start" pins the top and grows down,
// "end" pins the bottom and grows up. The flip zone must cover the box's half
// height, or a tall preview still overflows before its center reaches the edge.
// Shared by the hover preview and the active search label.
function resolvePreviewEdgeAnchor(
  topPx: number,
  layoutHeight: number,
  flipZonePx: number = PREVIEW_EDGE_ANCHOR_EPSILON_PX,
): { topPx: number; verticalAnchor: UserTurnPreviewLabel["verticalAnchor"] } {
  if (topPx <= PREVIEW_VERTICAL_MARGIN_PX + flipZonePx) {
    return { topPx: PREVIEW_EDGE_MARGIN_PX, verticalAnchor: "start" };
  }
  const maxCenterTop = Math.max(
    PREVIEW_VERTICAL_MARGIN_PX,
    layoutHeight - PREVIEW_VERTICAL_MARGIN_PX,
  );
  if (topPx >= maxCenterTop - flipZonePx) {
    return {
      topPx: Math.max(
        PREVIEW_EDGE_MARGIN_PX,
        layoutHeight - PREVIEW_EDGE_MARGIN_PX,
      ),
      verticalAnchor: "end",
    };
  }
  return { topPx, verticalAnchor: "center" };
}

function anchorPreviewLabelToRailEdge(
  label: UserTurnPreviewLabel,
  layoutHeight: number,
): UserTurnPreviewLabel {
  if (!label.active) {
    return { ...label, verticalAnchor: "center" };
  }
  return { ...label, ...resolvePreviewEdgeAnchor(label.topPx, layoutHeight) };
}

function getPreviewTranslateY(anchor: UserTurnPreviewLabel["verticalAnchor"]) {
  if (anchor === "start") return "0";
  if (anchor === "end") return "-100%";
  return "-50%";
}

function getSearchPreviewWindow(
  markers: UserTurnMarker[],
  activeId: string | null | undefined,
  layoutHeight: number,
): UserTurnMarker[] {
  if (markers.length <= 1) {
    return markers;
  }

  const capacity = Math.max(
    1,
    Math.min(
      MAX_SEARCH_PREVIEW_LABELS,
      Math.floor(
        Math.max(1, layoutHeight - PREVIEW_VERTICAL_MARGIN_PX * 2) /
          PREVIEW_COMPACT_MIN_GAP_PX,
      ) + 1,
    ),
  );
  if (markers.length <= capacity) {
    return markers;
  }

  const activeIndex = activeId
    ? markers.findIndex((marker) => marker.id === activeId)
    : -1;
  const centerIndex = activeIndex >= 0 ? activeIndex : markers.length - 1;
  const before = Math.floor((capacity - 1) / 2);
  const start = clamp(centerIndex - before, 0, markers.length - capacity);
  return markers.slice(start, start + capacity);
}

export const UserTurnNavigator = memo(function UserTurnNavigator({
  anchors = [],
  getAnchors,
  messageListRef,
  motionCue,
  onNavigateStart,
  onSearchMatchSelect,
  onTrimAnchor,
  canTrimAnchor,
  onForkBeforeAnchor,
  canForkBeforeAnchor,
  onForkAfterAnchor,
  canForkAfterAnchor,
  forkAfterDisabled = false,
  onCopyAnchor,
  canCopyAnchor,
  onHandoffFromAnchor,
  onPreviewTimestampChange,
  getRenderIdTop,
  revealRenderId,
  searchState,
}: Props) {
  const { t } = useI18n();
  const [layout, setLayout] = useState<UserTurnNavLayout | null>(null);
  // Right-click / long-press context menu for a turn notch (fork / copy / hide).
  const [notchMenu, setNotchMenu] = useState<{
    id: string;
    targetId: string;
    x: number;
    y: number;
  } | null>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressNextMarkerClickRef = useRef(false);
  // While the context menu is open, suppress the hover preview entirely: it
  // renders over the same notch and the two strobe at frame rate as each fights
  // to be under the cursor. The ref lets focusPreview (deps []) short-circuit.
  const notchMenuOpenRef = useRef(false);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [dismissedSearchPreview, setDismissedSearchPreview] = useState<{
    id: string;
    query: string;
  } | null>(null);
  const [previewWindowAnchorId, setPreviewWindowAnchorId] = useState<
    string | null
  >(null);
  const markerHoverBandRef = useRef<{ id: string; clientY: number } | null>(
    null,
  );
  const [railActive, setRailActive] = useState(false);
  const [internalMotionCue, setInternalMotionCue] =
    useState<UserTurnNavMotionCue | null>(null);
  const anchorsRef = useRef(anchors);
  const frameRef = useRef<number | null>(null);
  const jumpFrameRef = useRef<number | null>(null);
  const pendingUpdateKindRef = useRef<LayoutUpdateKind>("scroll");
  const motionCueTokenRef = useRef(0);
  const motionCueClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const visiblePreviewIdsRef = useRef<string[]>([]);
  const activeMotionCue = motionCue ?? internalMotionCue;
  const minAnchorCount = searchState ? 1 : MIN_NAV_ANCHORS;
  // Keep the rail mounted while the context menu is open: the menu portal is
  // rendered inside this component's output, which returns null when not
  // measuring. Without this, the menu's overlay triggers the scroll
  // container's pointerleave -> railActive=false -> unmount -> remount loop
  // (frame-rate strobe). See topics/fork-from-turn.md.
  const shouldMeasure =
    railActive || !!searchState || !!activeMotionCue || notchMenu !== null;
  const resolveAnchors = useCallback(
    () => (getAnchors ? getAnchors() : anchors),
    [anchors, getAnchors],
  );

  const updateFullLayout = useCallback(() => {
    if (!shouldMeasure) {
      anchorsRef.current = [];
      setLayout(null);
      return;
    }
    const nextAnchors = resolveAnchors();
    anchorsRef.current = nextAnchors;
    const nextLayout = measureLayout(
      nextAnchors,
      messageListRef.current,
      minAnchorCount,
      getRenderIdTop,
    );
    setLayout((previous) =>
      previous?.signature === nextLayout?.signature ? previous : nextLayout,
    );
  }, [
    getRenderIdTop,
    messageListRef,
    minAnchorCount,
    resolveAnchors,
    shouldMeasure,
  ]);

  const updateScrollLayout = useCallback(() => {
    if (!shouldMeasure) {
      setLayout(null);
      return;
    }
    const scrollContainer = getScrollContainer(messageListRef.current);
    if (!scrollContainer) {
      setLayout(null);
      return;
    }

    setLayout((previous) => {
      if (!previous) {
        return measureLayout(
          anchorsRef.current,
          messageListRef.current,
          minAnchorCount,
          getRenderIdTop,
        );
      }
      const nextLayout = updateScrollPosition(previous, scrollContainer);
      return previous.signature === nextLayout.signature
        ? previous
        : nextLayout;
    });
  }, [getRenderIdTop, messageListRef, minAnchorCount, shouldMeasure]);

  const scheduleLayoutUpdate = useCallback(
    (kind: LayoutUpdateKind = "scroll") => {
      if (kind === "full") {
        pendingUpdateKindRef.current = "full";
      }
      if (frameRef.current !== null) return;
      const frame = getAnimationFrame();
      frameRef.current = frame.request(() => {
        frameRef.current = null;
        const nextKind = pendingUpdateKindRef.current;
        pendingUpdateKindRef.current = "scroll";
        if (nextKind === "full") {
          updateFullLayout();
        } else {
          updateScrollLayout();
        }
      });
    },
    [updateFullLayout, updateScrollLayout],
  );

  useEffect(() => {
    if (shouldMeasure) {
      scheduleLayoutUpdate("full");
    } else {
      anchorsRef.current = [];
      setLayout(null);
    }
  }, [scheduleLayoutUpdate, shouldMeasure]);

  useEffect(() => {
    const messageList = messageListRef.current;
    const scrollContainer = getScrollContainer(messageList);
    if (!messageList || !scrollContainer) {
      setLayout(null);
      return;
    }

    const updatePointerReveal = (event: PointerEvent) => {
      if (searchState) return;
      if (notchMenuOpenRef.current) return; // freeze reveal while menu is open
      const rect = scrollContainer.getBoundingClientRect();
      const inVerticalRange =
        event.clientY >= rect.top && event.clientY <= rect.bottom;
      const nearScrollbar =
        event.clientX >= rect.right - NAV_REVEAL_HOTZONE_PX &&
        event.clientX <= rect.right + NAV_REVEAL_HOTZONE_PX;
      const nextActive = inVerticalRange && nearScrollbar;
      setRailActive((previous) => {
        if (previous === nextActive) return previous;
        return nextActive;
      });
    };
    const hideRail = () => {
      if (notchMenuOpenRef.current) return; // overlay covers the container; keep rail
      if (!searchState) {
        setRailActive(false);
      }
    };

    scrollContainer.addEventListener("pointermove", updatePointerReveal, {
      passive: true,
    });
    scrollContainer.addEventListener("pointerleave", hideRail);

    return () => {
      scrollContainer.removeEventListener("pointermove", updatePointerReveal);
      scrollContainer.removeEventListener("pointerleave", hideRail);
    };
  }, [messageListRef, searchState]);

  useEffect(() => {
    if (!shouldMeasure) {
      setLayout(null);
      return;
    }

    const messageList = messageListRef.current;
    const scrollContainer = getScrollContainer(messageList);
    if (!messageList || !scrollContainer) {
      setLayout(null);
      return;
    }

    const handleScroll = () => scheduleLayoutUpdate("scroll");
    const handleResize = () => scheduleLayoutUpdate("full");
    scrollContainer.addEventListener("scroll", handleScroll, { passive: true });
    window.addEventListener("resize", handleResize);
    window.visualViewport?.addEventListener("resize", handleResize);

    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(messageList);
    resizeObserver.observe(scrollContainer);
    scheduleLayoutUpdate("full");

    return () => {
      scrollContainer.removeEventListener("scroll", handleScroll);
      window.removeEventListener("resize", handleResize);
      window.visualViewport?.removeEventListener("resize", handleResize);
      resizeObserver.disconnect();
      if (frameRef.current !== null) {
        getAnimationFrame().cancel(frameRef.current);
        frameRef.current = null;
      }
      pendingUpdateKindRef.current = "scroll";
    };
  }, [messageListRef, scheduleLayoutUpdate, shouldMeasure]);

  useEffect(
    () => () => {
      if (motionCueClearTimerRef.current !== null) {
        clearTimeout(motionCueClearTimerRef.current);
      }
      if (jumpFrameRef.current !== null) {
        cancelAnimationFrame(jumpFrameRef.current);
      }
    },
    [],
  );

  const showInternalMotionCue = useCallback((direction: "up" | "down") => {
    if (motionCueClearTimerRef.current !== null) {
      clearTimeout(motionCueClearTimerRef.current);
    }
    motionCueTokenRef.current += 1;
    setInternalMotionCue({
      direction,
      token: motionCueTokenRef.current,
    });
    motionCueClearTimerRef.current = setTimeout(() => {
      setInternalMotionCue(null);
      motionCueClearTimerRef.current = null;
    }, MOTION_CUE_CLEAR_MS);
  }, []);

  const handleJump = useCallback(
    (id: string, targetId = id) => {
      const messageList = messageListRef.current;
      const scrollContainer = getScrollContainer(messageList);
      const row = findRenderRow(messageList, targetId);
      const virtualTop = row ? null : getRenderIdTop?.(targetId);
      if (
        !scrollContainer ||
        (!row && (virtualTop === null || virtualTop === undefined))
      ) {
        return;
      }

      onNavigateStart?.();
      const scrollRect = scrollContainer.getBoundingClientRect();
      const rowRect = row?.getBoundingClientRect();
      const nextTop = Math.max(
        0,
        rowRect
          ? scrollContainer.scrollTop + rowRect.top - scrollRect.top - 12
          : (virtualTop ?? 0) - 12,
      );
      const direction = nextTop < scrollContainer.scrollTop ? "up" : "down";
      showInternalMotionCue(direction);
      if (!row) {
        revealRenderId?.(targetId);
      }
      scrollContainer.scrollTo({ top: nextTop, behavior: "auto" });
      if (jumpFrameRef.current !== null) {
        cancelAnimationFrame(jumpFrameRef.current);
      }
      jumpFrameRef.current = requestAnimationFrame(() => {
        jumpFrameRef.current = null;
        const revealedList = messageListRef.current;
        const revealedContainer = getScrollContainer(revealedList);
        const revealedRow = findRenderRow(revealedList, targetId);
        if (revealedContainer && revealedRow) {
          const containerRect = revealedContainer.getBoundingClientRect();
          const revealedRect = revealedRow.getBoundingClientRect();
          revealedContainer.scrollTop = Math.max(
            0,
            revealedContainer.scrollTop +
              revealedRect.top -
              containerRect.top -
              12,
          );
        }
        scheduleLayoutUpdate("full");
      });
    },
    [
      getRenderIdTop,
      messageListRef,
      onNavigateStart,
      revealRenderId,
      scheduleLayoutUpdate,
      showInternalMotionCue,
    ],
  );
  const handleAnchorClick = useCallback(
    (id: string, targetId = id) => {
      if (searchState && onSearchMatchSelect) {
        setDismissedSearchPreview({ id, query: searchState.query });
        setPreviewId(null);
        setPreviewWindowAnchorId(null);
        onSearchMatchSelect(id, targetId);
        return;
      }
      handleJump(id, targetId);
    },
    [handleJump, onSearchMatchSelect, searchState],
  );
  const hasNotchMenu = Boolean(
    onForkBeforeAnchor ||
      onForkAfterAnchor ||
      onCopyAnchor ||
      onTrimAnchor ||
      onHandoffFromAnchor,
  );
  const openNotchMenu = useCallback(
    (id: string, targetId: string, x: number, y: number) => {
      // Suppress the hover preview synchronously before showing the menu so the
      // two never coexist over the same notch (which strobes).
      notchMenuOpenRef.current = true;
      setPreviewId(null);
      setPreviewWindowAnchorId(null);
      setRailActive(true); // keep the rail revealed + mounted under the menu
      setNotchMenu({ id, targetId, x, y });
    },
    [],
  );
  const closeNotchMenu = useCallback(() => {
    notchMenuOpenRef.current = false;
    setNotchMenu(null);
  }, []);
  const clearLongPress = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);
  const handleMarkerContextMenu = useCallback(
    (event: ReactMouseEvent, id: string, targetId: string) => {
      if (!hasNotchMenu) return;
      event.preventDefault();
      openNotchMenu(id, targetId, event.clientX, event.clientY);
    },
    [hasNotchMenu, openNotchMenu],
  );
  const handleMarkerTouchStart = useCallback(
    (event: ReactTouchEvent, id: string, targetId: string) => {
      if (!hasNotchMenu) return;
      const touch = event.touches[0];
      if (!touch) return;
      const { clientX, clientY } = touch;
      clearLongPress();
      longPressTimerRef.current = setTimeout(() => {
        suppressNextMarkerClickRef.current = true;
        window.setTimeout(() => {
          suppressNextMarkerClickRef.current = false;
        }, 800);
        openNotchMenu(id, targetId, clientX, clientY);
      }, 450);
    },
    [hasNotchMenu, clearLongPress, openNotchMenu],
  );
  useEffect(() => {
    if (!notchMenu) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeNotchMenu();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [notchMenu, closeNotchMenu]);
  useEffect(() => () => clearLongPress(), [clearLongPress]);
  const consumeLongPressClick = useCallback(() => {
    if (!suppressNextMarkerClickRef.current) {
      return false;
    }
    suppressNextMarkerClickRef.current = false;
    return true;
  }, []);
  const keepSearchFocusOnMouseDown = useCallback(
    (event: ReactMouseEvent) => {
      if (searchState) {
        event.preventDefault();
      }
    },
    [searchState],
  );
  const focusPreview = useCallback(
    (id: string, allowWindowShift = true) => {
      if (notchMenuOpenRef.current) return; // menu open: no preview (anti-strobe)
      setPreviewId((current) => (current === id ? current : id));
      if (allowWindowShift) {
        setPreviewWindowAnchorId((current) => {
          const visibleIds = visiblePreviewIdsRef.current;
          const visibleIndex = visibleIds.indexOf(id);
          const atVisibleEdge =
            visibleIndex === 0 || visibleIndex === visibleIds.length - 1;
          return visibleIndex === -1 || atVisibleEdge ? id : current;
        });
      }
      const marker = layout?.markers.find((candidate) => candidate.id === id);
      onPreviewTimestampChange?.(marker?.timestampMs ?? null);
    },
    [layout?.markers, onPreviewTimestampChange],
  );
  const focusMarkerPreview = useCallback(
    (id: string, event?: ReactPointerEvent<HTMLElement>) => {
      setDismissedSearchPreview(null);
      if (searchState && event) {
        const previousBand = markerHoverBandRef.current;
        if (
          previousBand &&
          previousBand.id !== id &&
          Math.abs(event.clientY - previousBand.clientY) <=
            SEARCH_MARKER_HOVER_STICKY_Y_PX
        ) {
          return;
        }
        if (!previousBand || previousBand.id !== id) {
          markerHoverBandRef.current = { id, clientY: event.clientY };
        }
      }
      focusPreview(id);
    },
    [focusPreview, searchState],
  );
  const clearPreview = useCallback(() => {
    markerHoverBandRef.current = null;
    setPreviewId(null);
    setPreviewWindowAnchorId(null);
    onPreviewTimestampChange?.(null);
  }, [onPreviewTimestampChange]);

  useLayoutEffect(() => {
    const retainedIds = new Set(
      layout?.markers.map((marker) => marker.id) ?? [],
    );
    clearLongPress();
    if (previewId && !retainedIds.has(previewId)) {
      clearPreview();
    } else if (
      previewWindowAnchorId &&
      !retainedIds.has(previewWindowAnchorId)
    ) {
      setPreviewWindowAnchorId(null);
    }
    if (
      markerHoverBandRef.current &&
      !retainedIds.has(markerHoverBandRef.current.id)
    ) {
      markerHoverBandRef.current = null;
    }
    if (notchMenu && !retainedIds.has(notchMenu.id)) {
      closeNotchMenu();
    }
    visiblePreviewIdsRef.current = visiblePreviewIdsRef.current.filter((id) =>
      retainedIds.has(id),
    );
  }, [
    clearLongPress,
    clearPreview,
    closeNotchMenu,
    layout,
    notchMenu,
    previewId,
    previewWindowAnchorId,
  ]);

  const searchActiveId = searchState?.activeId ?? null;
  useEffect(() => {
    if (!searchState) setDismissedSearchPreview(null);
  }, [searchState]);
  useEffect(() => {
    void searchActiveId;
    clearPreview();
  }, [clearPreview, searchActiveId]);

  useEffect(() => {
    if (!layout) {
      onPreviewTimestampChange?.(null);
    }
  }, [layout, onPreviewTimestampChange]);

  useEffect(
    () => () => {
      onPreviewTimestampChange?.(null);
    },
    [onPreviewTimestampChange],
  );

  const previewLabels = useMemo<UserTurnPreviewLabel[]>(() => {
    if (
      !layout ||
      (searchState &&
        dismissedSearchPreview?.id === searchState.activeId &&
        dismissedSearchPreview.query === searchState.query)
    ) {
      return [];
    }

    const searchMatchIds = searchState?.matchIds;
    const hasSearchMatches = !!searchMatchIds && searchMatchIds.size > 0;
    if (hasSearchMatches) {
      const matchedMarkers = layout.markers.filter((marker) =>
        searchMatchIds.has(marker.id),
      );
      const windowAnchorId =
        previewWindowAnchorId && searchMatchIds.has(previewWindowAnchorId)
          ? previewWindowAnchorId
          : searchState.activeId;
      const previewMarkers = getSearchPreviewWindow(
        matchedMarkers,
        windowAnchorId,
        layout.height,
      );
      const expandedId =
        previewId && searchMatchIds.has(previewId) ? previewId : null;
      const rawTops = previewMarkers.map((marker) =>
        clamp(
          marker.renderTopPct * layout.height,
          PREVIEW_VERTICAL_MARGIN_PX,
          Math.max(
            PREVIEW_VERTICAL_MARGIN_PX,
            layout.height - PREVIEW_VERTICAL_MARGIN_PX,
          ),
        ),
      );
      const crowded =
        previewMarkers.length > 1 &&
        (previewMarkers.length * PREVIEW_FULL_MIN_GAP_PX > layout.height ||
          rawTops.some(
            (top, index) =>
              index > 0 &&
              top - (rawTops[index - 1] ?? top) < PREVIEW_FULL_MIN_GAP_PX,
          ));
      const labels = previewMarkers.map((marker, index) => {
        const rawTopPx = rawTops[index] ?? PREVIEW_VERTICAL_MARGIN_PX;
        const text =
          searchState.previewsById.get(marker.id) ??
          (marker.id === searchState.activeId ? searchState.preview : null) ??
          marker.preview;
        const expanded = marker.id === expandedId;
        return {
          id: marker.id,
          targetId: marker.targetId ?? marker.id,
          topPx: rawTopPx,
          text,
          compact: crowded,
          short: !crowded && isShortSingleLinePreview(text),
          active: marker.id === searchState.activeId,
          expanded,
          verticalAnchor: "center" as const,
          pinned: expanded && marker.id === previewId,
        };
      });
      return spreadPreviewLabels(labels, layout.height, crowded);
    }

    const hoverPreviewMarker = previewId
      ? layout.markers.find((marker) => marker.id === previewId)
      : null;
    if (!hoverPreviewMarker) {
      return [];
    }

    const clampedTopPx = clamp(
      hoverPreviewMarker.renderTopPct * layout.height,
      PREVIEW_VERTICAL_MARGIN_PX,
      Math.max(
        PREVIEW_VERTICAL_MARGIN_PX,
        layout.height - PREVIEW_VERTICAL_MARGIN_PX,
      ),
    );
    // Flip to an edge anchor near the top/bottom so the preview is never
    // clipped by the banner above the rail; it moves inward to stay fully
    // visible instead of overflowing the edge. The flip zone is the box's max
    // half height so even a tall multi-line preview clears the banner.
    const edgeAnchored = resolvePreviewEdgeAnchor(
      clampedTopPx,
      layout.height,
      PREVIEW_MAX_HALF_HEIGHT_PX,
    );
    return [
      {
        id: hoverPreviewMarker.id,
        targetId: hoverPreviewMarker.targetId ?? hoverPreviewMarker.id,
        topPx: edgeAnchored.topPx,
        text: hoverPreviewMarker.preview,
        compact: false,
        short: isShortSingleLinePreview(hoverPreviewMarker.preview),
        active: false,
        expanded: false,
        verticalAnchor: edgeAnchored.verticalAnchor,
        pinned: false,
      },
    ];
  }, [
    dismissedSearchPreview,
    layout,
    previewId,
    previewWindowAnchorId,
    searchState,
  ]);

  useEffect(() => {
    visiblePreviewIdsRef.current = previewLabels.map((label) => label.id);
  }, [previewLabels]);

  if (!layout) {
    return null;
  }

  const activeMarkerId = searchState?.activeId ?? layout.activeId;
  const searchMatchIds = searchState?.matchIds;
  const hasSearchMatches = !!searchMatchIds && searchMatchIds.size > 0;
  const hasSingleSearchMatch = !!searchMatchIds && searchMatchIds.size === 1;
  const markersToRender = hasSearchMatches
    ? layout.markers.filter((marker) => searchMatchIds.has(marker.id))
    : layout.markers;
  const latestMarkerId = markersToRender[markersToRender.length - 1]?.id;

  return (
    <nav
      className={styles.root}
      aria-label="Turn navigation"
      /* Stable hook for deterministic transcript captures, which hide the rail
         because its markers track live scroll state. */
      data-turn-rail=""
      style={
        {
          top: `${layout.top}px`,
          right: `${layout.right}px`,
          height: `${layout.height}px`,
          "--user-turn-nav-preview-max-width": `${layout.previewMaxWidthPx}px`,
          "--user-turn-nav-search-preview-collapsed-height": `${SEARCH_PREVIEW_COLLAPSED_LABEL_HEIGHT_PX}px`,
        } as CSSProperties
      }
      onMouseLeave={clearPreview}
    >
      <div className={styles.track}>
        <div
          className={styles.thumb}
          style={{
            top: `${layout.thumbTopPct * 100}%`,
            height: `${layout.thumbHeightPct * 100}%`,
          }}
        />
        {activeMotionCue && (
          <span
            key={activeMotionCue.token}
            className={[
              styles.motionCue,
              MOTION_CUE_CLASS[activeMotionCue.direction],
            ]
              .filter(Boolean)
              .join(" ")}
            style={{ top: `${layout.thumbTopPct * 100}%` }}
          />
        )}
        {markersToRender.map((marker) => (
          <span key={marker.id}>
            <ButtonBase
              className={[
                styles.marker,
                marker.id === activeMarkerId ? styles.active : "",
                marker.id === latestMarkerId ? styles.latest : "",
                hasSearchMatches && searchMatchIds.has(marker.id)
                  ? styles.searchMatch
                  : "",
                hasSearchMatches && !searchMatchIds.has(marker.id)
                  ? styles.searchNonmatch
                  : "",
              ]
                .filter(Boolean)
                .join(" ")}
              style={{
                top: `${marker.renderTopPct * 100}%`,
                height: `${marker.hitPx}px`,
                marginTop: `${-marker.hitPx / 2}px`,
              }}
              aria-label={`${t("turnNotchJumpToTurn")}: ${marker.preview}`}
              title={marker.preview}
              onClick={() => {
                if (!consumeLongPressClick()) {
                  handleAnchorClick(marker.id, marker.targetId);
                }
              }}
              onContextMenu={(event) =>
                handleMarkerContextMenu(
                  event,
                  marker.id,
                  marker.targetId ?? marker.id,
                )
              }
              onTouchStart={(event) =>
                handleMarkerTouchStart(
                  event,
                  marker.id,
                  marker.targetId ?? marker.id,
                )
              }
              onTouchEnd={clearLongPress}
              onTouchMove={clearLongPress}
              onFocus={() => focusPreview(marker.id)}
              onBlur={clearPreview}
              onMouseDown={keepSearchFocusOnMouseDown}
              onPointerEnter={(event) => focusMarkerPreview(marker.id, event)}
              onPointerMove={(event) => focusMarkerPreview(marker.id, event)}
              onPointerDown={(event) => focusMarkerPreview(marker.id, event)}
            >
              <span className={styles.markerLine} />
            </ButtonBase>
            {onTrimAnchor && (canTrimAnchor?.(marker.id) ?? true) && (
              <ButtonBase
                className={styles.trimMarker}
                style={{
                  top: `${marker.renderTopPct * 100}%`,
                  height: `${marker.hitPx}px`,
                  marginTop: `${-marker.hitPx / 2}px`,
                }}
                aria-label={`${t("turnNotchShowFromTurn")}: ${marker.preview}`}
                onClick={() => {
                  if (!consumeLongPressClick()) {
                    onTrimAnchor(marker.id);
                  }
                }}
                onContextMenu={(event) =>
                  handleMarkerContextMenu(
                    event,
                    marker.id,
                    marker.targetId ?? marker.id,
                  )
                }
                onTouchStart={(event) =>
                  handleMarkerTouchStart(
                    event,
                    marker.id,
                    marker.targetId ?? marker.id,
                  )
                }
                onTouchEnd={clearLongPress}
                onTouchMove={clearLongPress}
                onFocus={() => focusPreview(marker.id)}
                onBlur={clearPreview}
                onPointerEnter={(event) => focusMarkerPreview(marker.id, event)}
                onPointerMove={(event) => focusMarkerPreview(marker.id, event)}
                onPointerDown={(event) => focusMarkerPreview(marker.id, event)}
              >
                <span className={styles.trimDot} />
              </ButtonBase>
            )}
          </span>
        ))}
        {previewLabels.map((label) => (
          <ButtonBase
            key={
              hasSingleSearchMatch && searchState
                ? `${label.id}:${searchState.query}`
                : label.id
            }
            className={[
              styles.preview,
              hasSearchMatches ? styles.searchPreview : "",
              hasSingleSearchMatch ? styles.singleSearchMatch : "",
              label.compact ? styles.compact : "",
              label.short ? styles.short : "",
              label.active ? styles.searchActive : "",
              label.expanded ? styles.expanded : "",
              label.pinned ? styles.pinnedExpanded : "",
            ]
              .filter(Boolean)
              .join(" ")}
            style={
              {
                top: `${label.topPx}px`,
                "--user-turn-nav-preview-translate-y": getPreviewTranslateY(
                  label.verticalAnchor,
                ),
              } as CSSProperties
            }
            aria-label={label.text}
            title={label.text}
            onClick={() => handleAnchorClick(label.id, label.targetId)}
            onContextMenu={(event) => {
              if (!hasSearchMatches || !onSearchMatchSelect) return;
              event.preventDefault();
              event.stopPropagation();
              onSearchMatchSelect(label.id, label.targetId, true);
            }}
            onMouseDown={keepSearchFocusOnMouseDown}
            onFocus={() => focusPreview(label.id, false)}
            onBlur={clearPreview}
            onPointerEnter={() => focusPreview(label.id, false)}
            onPointerMove={() => focusPreview(label.id, false)}
          >
            {hasSearchMatches
              ? renderPreviewLabelText(label, searchState)
              : label.text}
          </ButtonBase>
        ))}
      </div>
      {notchMenu &&
        createPortal(
          <>
            <ButtonBase
              className={styles.contextOverlay}
              aria-label={t("turnNotchDismissMenu")}
              onClick={closeNotchMenu}
              onContextMenu={(event) => {
                event.preventDefault();
                closeNotchMenu();
              }}
            />
            {/* Notches sit at the right edge, so anchor the menu's right side at
                the click and open leftward toward screen center. */}
            <div
              className={styles.contextMenu}
              role="menu"
              style={{
                top: Math.min(notchMenu.y, window.innerHeight - 220),
                right: Math.max(8, window.innerWidth - notchMenu.x),
              }}
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  handleAnchorClick(notchMenu.id, notchMenu.targetId);
                  closeNotchMenu();
                }}
              >
                {t("turnNotchJump")}
              </button>
              {onForkBeforeAnchor &&
                (canForkBeforeAnchor?.(notchMenu.id) ?? true) && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onForkBeforeAnchor(notchMenu.id);
                      closeNotchMenu();
                    }}
                  >
                    {t("turnNotchForkBefore")}
                  </button>
                )}
              {onForkAfterAnchor &&
                (canForkAfterAnchor?.(notchMenu.id) ?? true) && (
                  <button
                    type="button"
                    role="menuitem"
                    disabled={forkAfterDisabled}
                    title={
                      forkAfterDisabled ? t("forkTurnAfterDisabled") : undefined
                    }
                    onClick={() => {
                      onForkAfterAnchor(notchMenu.id);
                      closeNotchMenu();
                    }}
                  >
                    {t("turnNotchForkAfter")}
                  </button>
                )}
              {onCopyAnchor && (canCopyAnchor?.(notchMenu.id) ?? true) && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onCopyAnchor(notchMenu.id);
                    closeNotchMenu();
                  }}
                >
                  {t("turnNotchCopy")}
                </button>
              )}
              {onTrimAnchor && (canTrimAnchor?.(notchMenu.id) ?? true) && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onTrimAnchor(notchMenu.id);
                    closeNotchMenu();
                  }}
                >
                  {t("turnNotchShowFrom")}
                </button>
              )}
              {onHandoffFromAnchor && (
                <button
                  type="button"
                  role="menuitem"
                  onMouseDown={(event) => {
                    if (event.button === 1) event.preventDefault();
                  }}
                  onClick={() => {
                    onHandoffFromAnchor(notchMenu.id, { newTab: false });
                    closeNotchMenu();
                  }}
                  onAuxClick={(event) => {
                    if (event.button !== 1) return;
                    event.preventDefault();
                    onHandoffFromAnchor(notchMenu.id, { newTab: true });
                    closeNotchMenu();
                  }}
                >
                  {t("turnNotchHandoffFrom")}
                </button>
              )}
            </div>
          </>,
          document.body,
        )}
    </nav>
  );
});
