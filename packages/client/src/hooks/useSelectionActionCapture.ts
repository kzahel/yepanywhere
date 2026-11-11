import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  SELECTION_ACTION_BUTTON_MOBILE_SIZE_PX,
  SELECTION_ACTION_BUTTON_SIZE_PX,
  SELECTION_ACTION_GAP_PX,
} from "../components/ui/SelectionActionCluster";
import {
  extractMarkdownSnippetsFromSelection,
  getQuoteSelectionRoot,
  getQuoteSelectionRootForTarget,
  type MarkdownSelectionSnippet,
} from "../lib/markdownSelectionCopy";
import { createCommentAnchor, type CommentAnchor } from "../lib/commentAnchors";
import { getSelectionPlainText } from "../lib/selectionClipboard";

const TRANSCRIPT_SELECTION_ACTIVE_ATTRIBUTE =
  "data-session-transcript-selection-active";
const SELECTION_ACTION_UPDATE_INTERVAL_MS = 50;

export type FloatingActionPlacement = "above" | "after" | "before" | "below";

export interface SelectionActionSnapshot {
  anchors: readonly CommentAnchor[];
  snippets: readonly MarkdownSelectionSnippet[];
  ranges: readonly Range[];
  root: HTMLElement;
}

export interface SelectionActionState {
  top: number;
  left: number;
  side: FloatingActionPlacement;
  docked: boolean;
  mobile: boolean;
  snapshot: SelectionActionSnapshot;
}

interface UseSelectionActionCaptureOptions {
  actionCount: number;
  getActionCount?: (snapshot: SelectionActionSnapshot) => number;
  containerRef: RefObject<HTMLDivElement | null>;
  inert: boolean;
  isInteractiveTarget: (target: EventTarget | null) => boolean;
}

export interface SelectionActionCaptureController {
  captureSnapshot: () => SelectionActionSnapshot | null;
  dismiss: () => void;
  state: SelectionActionState | null;
}

interface PointerEnd {
  clientX: number;
  clientY: number;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function rangeSideIsClear(
  snippet: MarkdownSelectionSnippet,
  side: "after" | "before",
  lineRect: Pick<DOMRect, "bottom" | "top">,
): boolean {
  const remainder = snippet.sourceElement.ownerDocument.createRange();
  remainder.selectNodeContents(snippet.sourceElement);
  if (side === "after") {
    remainder.setStart(snippet.range.endContainer, snippet.range.endOffset);
  } else {
    remainder.setEnd(snippet.range.startContainer, snippet.range.startOffset);
  }
  if (!remainder.toString().trim()) {
    return true;
  }
  if (typeof remainder.getClientRects !== "function") {
    return true;
  }
  return !Array.from(remainder.getClientRects()).some(
    (rect) =>
      rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom > lineRect.top + 1 &&
      rect.top < lineRect.bottom - 1,
  );
}

function selectionSourceTextRects(
  snippets: readonly MarkdownSelectionSnippet[],
): DOMRect[] {
  const sourceElements = new Set(
    snippets.map((snippet) => snippet.sourceElement),
  );
  const rects: DOMRect[] = [];
  for (const sourceElement of sourceElements) {
    const contentRange = sourceElement.ownerDocument.createRange();
    contentRange.selectNodeContents(sourceElement);
    if (typeof contentRange.getClientRects !== "function") {
      continue;
    }
    rects.push(
      ...Array.from(contentRange.getClientRects()).filter(
        (rect) => rect.width > 0 && rect.height > 0,
      ),
    );
  }
  return rects;
}

function rectanglesOverlap(
  first: Pick<DOMRect, "bottom" | "left" | "right" | "top">,
  second: Pick<DOMRect, "bottom" | "left" | "right" | "top">,
): boolean {
  return (
    first.left < second.right &&
    first.right > second.left &&
    first.top < second.bottom &&
    first.bottom > second.top
  );
}

export function usesCoarsePrimaryPointer(win: Window): boolean {
  return win.matchMedia?.("(pointer: coarse)").matches === true;
}

export function selectionContextMenuBelongsToBrowser(
  event: MouseEvent,
  win: Window,
): boolean {
  if (usesCoarsePrimaryPointer(win)) return true;
  const pointerType = (event as MouseEvent & { pointerType?: string })
    .pointerType;
  return pointerType === "touch" || pointerType === "pen";
}

export function pointIntersectsSelection(
  snapshot: SelectionActionSnapshot,
  x: number,
  y: number,
): boolean {
  if (x === 0 && y === 0) return true;
  return snapshot.ranges.some((range) => {
    if (typeof range.getClientRects !== "function") return true;
    return Array.from(range.getClientRects()).some(
      (rect) =>
        x >= rect.left - 1 &&
        x <= rect.right + 1 &&
        y >= rect.top - 1 &&
        y <= rect.bottom + 1,
    );
  });
}

export function placeSelectionActions(
  root: HTMLDivElement,
  selection: Selection,
  snapshot: SelectionActionSnapshot,
  actionCount: number,
  pointerEnd?: PointerEnd,
): SelectionActionState | null {
  const { snippets } = snapshot;
  const selectionRoot = snapshot.root;
  const win = root.ownerDocument.defaultView ?? window;
  const mobile = usesCoarsePrimaryPointer(win);
  const buttonSize = mobile
    ? SELECTION_ACTION_BUTTON_MOBILE_SIZE_PX
    : SELECTION_ACTION_BUTTON_SIZE_PX;

  const range = selection.getRangeAt(selection.rangeCount - 1);
  const rangeRect =
    typeof range.getBoundingClientRect === "function"
      ? range.getBoundingClientRect()
      : null;
  const lineRects =
    typeof range.getClientRects === "function"
      ? Array.from(range.getClientRects()).filter(
          (rect) => rect.width !== 0 || rect.height !== 0,
        )
      : [];
  const hasRangeRect =
    rangeRect && (rangeRect.width !== 0 || rangeRect.height !== 0);
  if (!hasRangeRect && !pointerEnd) {
    return null;
  }
  const rootRect = selectionRoot.getBoundingClientRect();
  const selectionRect = hasRangeRect
    ? rangeRect
    : {
        top: pointerEnd?.clientY ?? rootRect.top,
        right: pointerEnd?.clientX ?? rootRect.left,
        bottom: pointerEnd?.clientY ?? rootRect.top,
        left: pointerEnd?.clientX ?? rootRect.left,
        width: 0,
        height: 0,
      };
  const firstLineRect = lineRects[0] ?? selectionRect;
  const lastLineRect = lineRects.at(-1) ?? selectionRect;
  const clusterWidth =
    actionCount * buttonSize + (actionCount - 1) * SELECTION_ACTION_GAP_PX;
  const firstSnippet = snippets[0];
  const lastSnippet = snippets.at(-1);
  const afterIsClear = lastSnippet
    ? rangeSideIsClear(lastSnippet, "after", lastLineRect)
    : false;
  const beforeIsClear = firstSnippet
    ? rangeSideIsClear(firstSnippet, "before", firstLineRect)
    : false;
  const spaceAfter = rootRect.right - lastLineRect.right;
  const spaceBefore = firstLineRect.left - rootRect.left;
  const spaceBelow = rootRect.bottom - selectionRect.bottom;
  const spaceAbove = selectionRect.top - rootRect.top;
  const maxTop = Math.max(0, selectionRoot.clientHeight - buttonSize);
  const maxLeft = Math.max(0, selectionRoot.clientWidth - clusterWidth);
  const centeredLeft =
    selectionRect.left -
    rootRect.left +
    (selectionRect.width - clusterWidth) / 2;
  const candidates: Record<
    FloatingActionPlacement,
    { left: number; top: number }
  > = {
    after: {
      top:
        lastLineRect.top -
        rootRect.top +
        (lastLineRect.height - buttonSize) / 2,
      left: lastLineRect.right - rootRect.left + SELECTION_ACTION_GAP_PX,
    },
    before: {
      top:
        firstLineRect.top -
        rootRect.top +
        (firstLineRect.height - buttonSize) / 2,
      left:
        firstLineRect.left -
        rootRect.left -
        clusterWidth -
        SELECTION_ACTION_GAP_PX,
    },
    below: {
      top: selectionRect.bottom - rootRect.top + SELECTION_ACTION_GAP_PX,
      left: centeredLeft,
    },
    above: {
      top:
        selectionRect.top - rootRect.top - buttonSize - SELECTION_ACTION_GAP_PX,
      left: centeredLeft,
    },
  };
  const sourceTextRects = selectionSourceTextRects(snippets);
  const candidateIsClear = (side: FloatingActionPlacement) => {
    if (side === "after" && !afterIsClear) return false;
    if (side === "before" && !beforeIsClear) return false;
    const candidate = candidates[side];
    if (
      candidate.left < 0 ||
      candidate.top < 0 ||
      candidate.left + clusterWidth > selectionRoot.clientWidth ||
      candidate.top + buttonSize > selectionRoot.clientHeight
    ) {
      return false;
    }
    const viewportCandidate = {
      top: rootRect.top + candidate.top,
      right: rootRect.left + candidate.left + clusterWidth,
      bottom: rootRect.top + candidate.top + buttonSize,
      left: rootRect.left + candidate.left,
    };
    if (
      viewportCandidate.left < 0 ||
      viewportCandidate.top < 0 ||
      viewportCandidate.right > win.innerWidth ||
      viewportCandidate.bottom > win.innerHeight
    ) {
      return false;
    }
    return !sourceTextRects.some((rect) =>
      rectanglesOverlap(viewportCandidate, rect),
    );
  };
  const side =
    (["after", "before", "below", "above"] as const).find(candidateIsClear) ??
    (
      [
        ["after", spaceAfter - clusterWidth],
        ["before", spaceBefore - clusterWidth],
        ["below", spaceBelow - buttonSize],
        ["above", spaceAbove - buttonSize],
      ] as const
    ).reduce((best, candidate) =>
      candidate[1] > best[1] ? candidate : best,
    )[0];
  const position = candidates[side];
  return {
    side,
    docked: mobile && selectionRoot === root,
    mobile,
    snapshot,
    top: clampNumber(position.top, 0, maxTop),
    left: clampNumber(position.left, 0, maxLeft),
  };
}

export function useSelectionActionCapture({
  actionCount,
  getActionCount,
  containerRef,
  inert,
  isInteractiveTarget,
}: UseSelectionActionCaptureOptions): SelectionActionCaptureController {
  const selectionPointerStartedRef = useRef(false);
  const [state, setState] = useState<SelectionActionState | null>(null);
  const dismiss = useCallback(() => setState(null), []);

  const captureSnapshot = useCallback(() => {
    const root = containerRef.current;
    const selection = root?.ownerDocument.getSelection();
    if (
      !root ||
      !selection ||
      selection.isCollapsed ||
      selection.rangeCount === 0
    ) {
      return null;
    }
    const selectionRoot = getQuoteSelectionRoot(root, selection);
    if (!selectionRoot) {
      return null;
    }
    const snippets = extractMarkdownSnippetsFromSelection(selectionRoot);
    if (snippets.length === 0) {
      return null;
    }
    return {
      anchors: snippets.map(createCommentAnchor),
      snippets,
      ranges: snippets.map((snippet) => snippet.range.cloneRange()),
      root: selectionRoot,
    } satisfies SelectionActionSnapshot;
  }, [containerRef]);

  useEffect(() => {
    if (inert) return;
    const handleCopy = (event: ClipboardEvent) => {
      if (event.defaultPrevented || !event.clipboardData) return;
      const root = containerRef.current;
      if (!root) return;
      const selectionRoot = getQuoteSelectionRoot(root);
      if (selectionRoot) {
        const snippets = extractMarkdownSnippetsFromSelection(selectionRoot);
        if (snippets.length === 0) return;
        event.clipboardData.setData(
          "text/plain",
          getSelectionPlainText(snippets),
        );
        event.preventDefault();
      }
    };

    document.addEventListener("copy", handleCopy);
    return () => document.removeEventListener("copy", handleCopy);
  }, [containerRef, inert]);

  useEffect(() => {
    if (inert) return;
    const root = containerRef.current;
    const doc = root?.ownerDocument ?? document;
    const handleMouseDown = (event: MouseEvent) => {
      const currentRoot = containerRef.current;
      if (
        event.button !== 0 ||
        !currentRoot ||
        isInteractiveTarget(event.target)
      ) {
        return;
      }
      const selection = doc.getSelection();
      const selectionRoot = getQuoteSelectionRoot(currentRoot, selection);
      const targetRoot = getQuoteSelectionRootForTarget(
        currentRoot,
        event.target,
      );
      if (selectionRoot && selectionRoot === targetRoot) {
        selection?.removeAllRanges();
      }
    };

    doc.addEventListener("mousedown", handleMouseDown, true);
    return () => doc.removeEventListener("mousedown", handleMouseDown, true);
  }, [containerRef, inert, isInteractiveTarget]);

  useEffect(() => {
    if (inert) return;
    const root = containerRef.current;
    const doc = root?.ownerDocument ?? document;
    const win = doc.defaultView ?? window;
    if (!usesCoarsePrimaryPointer(win)) return;

    let activeSessionPage: HTMLElement | null = null;
    let activeBody: HTMLElement | null = null;
    const setTranscriptSelectionActive = (active: boolean) => {
      const currentRoot = containerRef.current;
      const sessionPage =
        currentRoot?.closest<HTMLElement>("[data-session-page]") ?? null;
      const body = currentRoot?.ownerDocument.body ?? null;
      if (activeSessionPage && activeSessionPage !== sessionPage) {
        activeSessionPage.removeAttribute(
          TRANSCRIPT_SELECTION_ACTIVE_ATTRIBUTE,
        );
      }
      if (activeBody && activeBody !== body) {
        activeBody.removeAttribute(TRANSCRIPT_SELECTION_ACTIVE_ATTRIBUTE);
      }
      activeSessionPage = sessionPage;
      activeBody = body;
      sessionPage?.toggleAttribute(
        TRANSCRIPT_SELECTION_ACTIVE_ATTRIBUTE,
        active,
      );
      body?.toggleAttribute(
        TRANSCRIPT_SELECTION_ACTIVE_ATTRIBUTE,
        active && sessionPage !== null,
      );
    };
    const updateTranscriptSelectionActive = () => {
      const currentRoot = containerRef.current;
      setTranscriptSelectionActive(
        currentRoot
          ? getQuoteSelectionRoot(
              currentRoot,
              currentRoot.ownerDocument.getSelection(),
            ) !== null
          : false,
      );
    };

    doc.addEventListener("selectionchange", updateTranscriptSelectionActive);
    doc.addEventListener("pointerup", updateTranscriptSelectionActive, true);
    doc.addEventListener("keyup", updateTranscriptSelectionActive, true);
    win.addEventListener("blur", updateTranscriptSelectionActive);
    return () => {
      doc.removeEventListener(
        "selectionchange",
        updateTranscriptSelectionActive,
      );
      doc.removeEventListener(
        "pointerup",
        updateTranscriptSelectionActive,
        true,
      );
      doc.removeEventListener("keyup", updateTranscriptSelectionActive, true);
      win.removeEventListener("blur", updateTranscriptSelectionActive);
      activeSessionPage?.removeAttribute(TRANSCRIPT_SELECTION_ACTIVE_ATTRIBUTE);
      activeBody?.removeAttribute(TRANSCRIPT_SELECTION_ACTIVE_ATTRIBUTE);
    };
  }, [containerRef, inert]);

  useEffect(() => {
    if (inert || actionCount === 0) {
      setState(null);
      return;
    }

    const rootDocument = containerRef.current?.ownerDocument ?? document;
    const rootWindow = rootDocument.defaultView ?? window;
    let rateLimitTimer: number | undefined;
    let rateLimitedUpdateQueued = false;

    const cancelRateLimitedUpdate = () => {
      rateLimitedUpdateQueued = false;
      if (rateLimitTimer === undefined) return;
      rootWindow.clearTimeout(rateLimitTimer);
      rateLimitTimer = undefined;
    };

    const updateSelectionActions = (pointerEnd?: PointerEnd) => {
      if (selectionPointerStartedRef.current && !pointerEnd) {
        setState(null);
        return;
      }
      const root = containerRef.current;
      const selection = root?.ownerDocument.getSelection();
      const snapshot = captureSnapshot();
      if (!root || !selection || !snapshot) {
        setState(null);
        return;
      }
      const resolvedActionCount = getActionCount?.(snapshot) ?? actionCount;
      if (resolvedActionCount === 0) {
        setState(null);
        return;
      }
      setState(
        placeSelectionActions(
          root,
          selection,
          snapshot,
          resolvedActionCount,
          pointerEnd,
        ),
      );
    };
    const startRateLimitWindow = () => {
      rateLimitTimer = rootWindow.setTimeout(() => {
        rateLimitTimer = undefined;
        if (!rateLimitedUpdateQueued) return;
        rateLimitedUpdateQueued = false;
        updateSelectionActions();
        startRateLimitWindow();
      }, SELECTION_ACTION_UPDATE_INTERVAL_MS);
    };
    const scheduleRateLimitedUpdate = () => {
      if (rateLimitTimer !== undefined) {
        rateLimitedUpdateQueued = true;
        return;
      }
      updateSelectionActions();
      startRateLimitWindow();
    };
    const scheduleViewportUpdate = () => {
      const selection = rootDocument.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
        cancelRateLimitedUpdate();
        return;
      }
      scheduleRateLimitedUpdate();
    };
    const handlePointerDown = (event: PointerEvent) => {
      const root = containerRef.current;
      if (
        event.target instanceof Element &&
        event.target.closest('[data-selection-action-cluster="true"]')
      ) {
        selectionPointerStartedRef.current = false;
        cancelRateLimitedUpdate();
        return;
      }
      cancelRateLimitedUpdate();
      if (!root || !getQuoteSelectionRootForTarget(root, event.target)) {
        selectionPointerStartedRef.current = false;
        return;
      }
      selectionPointerStartedRef.current = true;
      setState(null);
    };
    const handlePointerUp = (event: PointerEvent) => {
      const selectionPointerStarted = selectionPointerStartedRef.current;
      selectionPointerStartedRef.current = false;
      if (!selectionPointerStarted) return;
      cancelRateLimitedUpdate();
      rootWindow.setTimeout(() => {
        cancelRateLimitedUpdate();
        updateSelectionActions({
          clientX: event.clientX,
          clientY: event.clientY,
        });
      }, 0);
    };
    const handlePointerCancel = () => {
      selectionPointerStartedRef.current = false;
      cancelRateLimitedUpdate();
    };
    const updateFromSelectionRange = () => {
      if (selectionPointerStartedRef.current) {
        cancelRateLimitedUpdate();
        return;
      }
      const selection = rootDocument.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
        cancelRateLimitedUpdate();
        setState(null);
        return;
      }
      scheduleRateLimitedUpdate();
    };

    rootDocument.addEventListener("selectionchange", updateFromSelectionRange);
    rootDocument.addEventListener("pointerdown", handlePointerDown, true);
    rootDocument.addEventListener("pointercancel", handlePointerCancel, true);
    rootDocument.addEventListener("pointerup", handlePointerUp, true);
    rootWindow.addEventListener("resize", scheduleViewportUpdate);
    rootWindow.addEventListener("scroll", scheduleViewportUpdate, true);
    return () => {
      cancelRateLimitedUpdate();
      rootDocument.removeEventListener(
        "selectionchange",
        updateFromSelectionRange,
      );
      rootDocument.removeEventListener("pointerdown", handlePointerDown, true);
      rootDocument.removeEventListener(
        "pointercancel",
        handlePointerCancel,
        true,
      );
      rootDocument.removeEventListener("pointerup", handlePointerUp, true);
      rootWindow.removeEventListener("resize", scheduleViewportUpdate);
      rootWindow.removeEventListener("scroll", scheduleViewportUpdate, true);
    };
  }, [actionCount, captureSnapshot, containerRef, getActionCount, inert]);

  return { captureSnapshot, dismiss, state };
}
