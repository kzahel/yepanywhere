import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { TranslationFn } from "../i18n";
import styles from "./ResizableSourceColumns.module.css";

export type SourceColumnLayout = "history" | "files";
type Boundary = "revisions" | "files";

const REVISION_MIN = 0;
const REVISION_MAX = 420;
const FILES_MIN = 220;
const DEFAULT_FILES_WIDTH = 380;
const KEYBOARD_STEP = 16;
const FALLBACK_COLUMN_GAP = 12;
const FALLBACK_HANDLE_WIDTH = 26;

interface Widths {
  revisions: number;
  files: number;
}

interface DragState {
  boundary: Boundary;
  startX: number;
  startWidths: Widths;
}

interface LayoutMetrics {
  containerWidth: number;
  gapWidth: number;
  handleWidth: number;
}

/**
 * Let the file pane consume all requested width while keeping the right edge
 * of its splitter handle inside the grid.
 */
export function calculateSourceFilesMaxWidth({
  layout,
  containerWidth,
  revisionWidth,
  gapWidth,
  handleWidth,
}: {
  layout: SourceColumnLayout;
  containerWidth: number;
  revisionWidth: number;
  gapWidth: number;
  handleWidth: number;
}): number {
  const precedingWidth = layout === "history" ? revisionWidth + gapWidth : 0;
  return Math.max(
    FILES_MIN,
    Math.floor(
      containerWidth - precedingWidth - gapWidth / 2 - handleWidth / 2,
    ),
  );
}

/**
 * Leave a measured detail pane just enough room, while allowing an oversized
 * file list to return toward its ordinary default. A deliberately narrower
 * user resize remains the automatic floor.
 */
export function calculateSourceAutoFilesWidth({
  containerWidth,
  gapWidth,
  naturalDetailWidth,
  currentFilesWidth,
  defaultFilesWidth,
  filesMax,
}: {
  containerWidth: number;
  gapWidth: number;
  naturalDetailWidth: number;
  currentFilesWidth: number;
  defaultFilesWidth: number;
  filesMax: number;
}): number {
  const automaticFloor = Math.min(currentFilesWidth, defaultFilesWidth);
  return clamp(
    Math.floor(containerWidth - gapWidth - naturalDetailWidth),
    automaticFloor,
    filesMax,
  );
}

/**
 * The narrowest files-column width that shows every file row unclipped: each
 * row's indent, badges, path text and counts, plus the column's own insets and
 * scrollbar. Paths stretch to fill their row, so their demand is read from the
 * text itself rather than the element. Returns 0 when no row is rendered.
 */
export function measureSourceFilesFit(column: HTMLElement): number {
  const columnWidth = column.getBoundingClientRect().width;
  const range = document.createRange();
  let fit = 0;
  for (const row of column.querySelectorAll<HTMLElement>(
    "[data-source-list-item]",
  )) {
    const rowWidth = row.getBoundingClientRect().width;
    if (rowWidth === 0) continue;
    const rowStyle = getComputedStyle(row);
    let natural =
      cssPixels(rowStyle.paddingLeft) +
      cssPixels(rowStyle.paddingRight) +
      cssPixels(rowStyle.borderLeftWidth) +
      cssPixels(rowStyle.borderRightWidth);
    let visible = 0;
    for (const child of row.children) {
      if (!(child instanceof HTMLElement)) continue;
      const style = getComputedStyle(child);
      if (style.display === "none" || style.position === "absolute") continue;
      visible++;
      natural += cssPixels(style.marginLeft) + cssPixels(style.marginRight);
      if (style.overflowX === "visible") {
        natural += child.getBoundingClientRect().width;
      } else {
        range.selectNodeContents(child);
        natural +=
          range.getBoundingClientRect().width +
          cssPixels(style.paddingLeft) +
          cssPixels(style.paddingRight);
      }
    }
    natural += Math.max(0, visible - 1) * cssPixels(rowStyle.columnGap);
    fit = Math.max(fit, columnWidth - rowWidth + natural);
  }
  return Math.ceil(fit);
}

/**
 * Desktop Source Control grids with edge-only resize handles. The tiny top and
 * bottom handles keep the pane interiors clean; interaction reveals one full
 * height guide while the grid reflows live. Until the user resizes it, the
 * files column fits its rows, never wider than the default.
 */
export function ResizableSourceColumns({
  layout,
  enabled = true,
  revisionPaneVisible = true,
  initialFilesWidth,
  naturalDetailWidth,
  className,
  children,
  t,
}: {
  layout: SourceColumnLayout;
  enabled?: boolean;
  /** Keep the revision track structurally present but fully hidden. */
  revisionPaneVisible?: boolean;
  initialFilesWidth?: number;
  naturalDetailWidth?: number;
  className: string;
  children: ReactNode;
  t: TranslationFn;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const previousRevisionPaneVisibleRef = useRef(revisionPaneVisible);
  const lastRevisionWidthRef = useRef(300);
  const dragMovedRef = useRef(false);
  const dragFrameRef = useRef<number | null>(null);
  const pendingDragClientXRef = useRef<number | null>(null);
  const liveDragWidthsRef = useRef<Widths | null>(null);
  const ignoreNextClickRef = useRef(false);
  /** Once the user sizes the files column, fitting no longer moves it. */
  const filesUserSizedRef = useRef(false);
  /** Widest fit seen, so filtering or collapsing rows never jitters the edge. */
  const filesFitRef = useRef(0);
  const defaultFilesWidth =
    initialFilesWidth ?? (layout === "history" ? 340 : DEFAULT_FILES_WIDTH);
  const [widths, setWidths] = useState<Widths>(() => ({
    revisions: 300,
    files: defaultFilesWidth,
  }));
  const [revisionsCollapsed, setRevisionsCollapsed] = useState(
    !revisionPaneVisible,
  );
  const [dragging, setDragging] = useState<DragState | null>(null);
  const [layoutMetrics, setLayoutMetrics] = useState<LayoutMetrics | null>(
    null,
  );
  const revisionWidth = revisionsCollapsed ? 0 : widths.revisions;
  const filesMax = layoutMetrics
    ? calculateSourceFilesMaxWidth({
        layout,
        containerWidth: layoutMetrics.containerWidth,
        revisionWidth,
        gapWidth: layoutMetrics.gapWidth,
        handleWidth: layoutMetrics.handleWidth,
      })
    : undefined;
  const filesMaxRef = useRef(filesMax);
  filesMaxRef.current = filesMax;

  useEffect(() => {
    if (previousRevisionPaneVisibleRef.current === revisionPaneVisible) return;
    previousRevisionPaneVisibleRef.current = revisionPaneVisible;
    setRevisionsCollapsed(!revisionPaneVisible);
  }, [revisionPaneVisible]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const measure = () => {
      const computedStyle = getComputedStyle(root);
      const parsedGap = Number.parseFloat(computedStyle.columnGap);
      const handle = root.querySelector<HTMLElement>(
        "[data-source-splitter-edge]",
      );
      const next = {
        containerWidth: root.clientWidth,
        gapWidth: Number.isFinite(parsedGap) ? parsedGap : FALLBACK_COLUMN_GAP,
        handleWidth: handle?.offsetWidth || FALLBACK_HANDLE_WIDTH,
      };
      if (next.containerWidth <= 0) return;
      setLayoutMetrics((current) =>
        current &&
        current.containerWidth === next.containerWidth &&
        current.gapWidth === next.gapWidth &&
        current.handleWidth === next.handleWidth
          ? current
          : next,
      );
    };

    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (filesMax === undefined) return;
    setWidths((current) =>
      current.files <= filesMax ? current : { ...current, files: filesMax },
    );
  }, [filesMax]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || !enabled) return;
    let frame: number | null = null;
    const fitFiles = () => {
      frame = null;
      if (filesUserSizedRef.current) return;
      const column = root.querySelector<HTMLElement>(
        '[data-source-column="files"]',
      );
      if (!column) return;
      filesFitRef.current = Math.max(
        filesFitRef.current,
        measureSourceFilesFit(column),
      );
      if (filesFitRef.current === 0) return;
      const files = clamp(
        filesFitRef.current,
        FILES_MIN,
        Math.min(defaultFilesWidth, filesMaxRef.current ?? defaultFilesWidth),
      );
      setWidths((current) =>
        current.files === files ? current : { ...current, files },
      );
    };
    const schedule = () => {
      if (frame === null) frame = window.requestAnimationFrame(fitFiles);
    };
    fitFiles();
    // Rows arrive and change after mount (status loads, folder expansion);
    // churn in the detail pane is not the file list's concern.
    const observer = new MutationObserver((records) => {
      const column = root.querySelector('[data-source-column="files"]');
      if (
        records.some(
          (record) =>
            !column ||
            column.contains(record.target) ||
            record.target.contains(column),
        )
      ) {
        schedule();
      }
    });
    observer.observe(root, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [defaultFilesWidth, enabled]);

  useLayoutEffect(() => {
    if (
      layout !== "files" ||
      naturalDetailWidth === undefined ||
      layoutMetrics === null ||
      filesMax === undefined
    ) {
      return;
    }
    setWidths((current) => {
      const files = calculateSourceAutoFilesWidth({
        containerWidth: layoutMetrics.containerWidth,
        gapWidth: layoutMetrics.gapWidth,
        naturalDetailWidth,
        currentFilesWidth: current.files,
        defaultFilesWidth,
        filesMax,
      });
      return files === current.files ? current : { ...current, files };
    });
  }, [defaultFilesWidth, filesMax, layout, layoutMetrics, naturalDetailWidth]);

  useEffect(() => {
    if (!dragging) return;
    const root = rootRef.current;
    if (!root) return;
    const applyPointerPosition = (clientX: number) => {
      const delta = clientX - dragging.startX;
      let nextWidths: Widths;
      if (dragging.boundary === "revisions") {
        const revisions = clamp(
          dragging.startWidths.revisions + delta,
          REVISION_MIN,
          REVISION_MAX,
        );
        const files = layoutMetrics
          ? Math.min(
              dragging.startWidths.files,
              calculateSourceFilesMaxWidth({
                layout,
                containerWidth: layoutMetrics.containerWidth,
                revisionWidth: revisions,
                gapWidth: layoutMetrics.gapWidth,
                handleWidth: layoutMetrics.handleWidth,
              }),
            )
          : dragging.startWidths.files;
        nextWidths = { revisions, files };
        if (revisions > 0) lastRevisionWidthRef.current = revisions;
        root.classList.toggle(styles.revisionsHidden!, revisions === 0);
        root.style.setProperty(
          "--source-revision-column-width",
          `${revisions}px`,
        );
        root.style.setProperty("--source-files-column-width", `${files}px`);
      } else {
        const files = clamp(
          dragging.startWidths.files + delta,
          FILES_MIN,
          filesMax ?? dragging.startWidths.files,
        );
        nextWidths = { ...dragging.startWidths, files };
        root.style.setProperty("--source-files-column-width", `${files}px`);
      }
      liveDragWidthsRef.current = nextWidths;
    };
    const flushPointerMove = () => {
      dragFrameRef.current = null;
      const clientX = pendingDragClientXRef.current;
      pendingDragClientXRef.current = null;
      if (clientX !== null) applyPointerPosition(clientX);
    };
    const handlePointerMove = (event: globalThis.PointerEvent) => {
      const delta = event.clientX - dragging.startX;
      if (Math.abs(delta) > 3) dragMovedRef.current = true;
      pendingDragClientXRef.current = event.clientX;
      if (dragFrameRef.current !== null) return;
      if (typeof window.requestAnimationFrame !== "function") {
        flushPointerMove();
        return;
      }
      dragFrameRef.current = window.requestAnimationFrame(flushPointerMove);
    };
    const handlePointerUp = () => {
      if (dragFrameRef.current !== null) {
        window.cancelAnimationFrame(dragFrameRef.current);
        dragFrameRef.current = null;
      }
      flushPointerMove();
      const nextWidths = liveDragWidthsRef.current ?? dragging.startWidths;
      setWidths(nextWidths);
      if (dragging.boundary === "files" && dragMovedRef.current) {
        filesUserSizedRef.current = true;
      }
      if (dragging.boundary === "revisions") {
        setRevisionsCollapsed(nextWidths.revisions === 0);
      }
      ignoreNextClickRef.current = dragMovedRef.current;
      window.setTimeout(() => {
        ignoreNextClickRef.current = false;
      }, 0);
      liveDragWidthsRef.current = null;
      setDragging(null);
    };
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp, { once: true });
    window.addEventListener("pointercancel", handlePointerUp, { once: true });
    document.body.setAttribute("data-source-pane-resizing", "");
    return () => {
      if (dragFrameRef.current !== null) {
        window.cancelAnimationFrame(dragFrameRef.current);
        dragFrameRef.current = null;
      }
      pendingDragClientXRef.current = null;
      liveDragWidthsRef.current = null;
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
      document.body.removeAttribute("data-source-pane-resizing");
    };
  }, [dragging, filesMax, layout, layoutMetrics]);

  const setBoundaryWidth = (boundary: Boundary, next: number) => {
    const value = clamp(
      next,
      boundary === "revisions" ? REVISION_MIN : FILES_MIN,
      boundary === "revisions" ? REVISION_MAX : (filesMax ?? widths.files),
    );
    if (boundary === "revisions") {
      if (value > 0) lastRevisionWidthRef.current = value;
      setRevisionsCollapsed(value === 0);
    } else {
      filesUserSizedRef.current = true;
    }
    setWidths((current) => ({ ...current, [boundary]: value }));
  };

  const startDrag = (event: PointerEvent<HTMLElement>, boundary: Boundary) => {
    if (event.button !== 0) return;
    event.preventDefault();
    dragMovedRef.current = false;
    pendingDragClientXRef.current = null;
    const startWidths =
      boundary === "revisions"
        ? { ...widths, revisions: revisionWidth }
        : widths;
    liveDragWidthsRef.current = startWidths;
    setDragging({
      boundary,
      startX: event.clientX,
      startWidths,
    });
  };

  const toggleRevisionPane = () => {
    if (ignoreNextClickRef.current) {
      ignoreNextClickRef.current = false;
      return;
    }
    if (revisionWidth === 0) {
      const revisions = lastRevisionWidthRef.current;
      setWidths((current) => ({ ...current, revisions }));
      setRevisionsCollapsed(false);
      return;
    }
    lastRevisionWidthRef.current = revisionWidth;
    setRevisionsCollapsed(true);
  };

  const handleKeyDown = (
    event: KeyboardEvent<HTMLElement>,
    boundary: Boundary,
  ) => {
    if (
      boundary === "revisions" &&
      (event.key === "Enter" || event.key === " ")
    ) {
      event.preventDefault();
      toggleRevisionPane();
      return;
    }
    const current = boundary === "revisions" ? revisionWidth : widths.files;
    const min = boundary === "revisions" ? REVISION_MIN : FILES_MIN;
    const max = boundary === "revisions" ? REVISION_MAX : (filesMax ?? current);
    const next =
      event.key === "ArrowLeft"
        ? current - KEYBOARD_STEP
        : event.key === "ArrowRight"
          ? current + KEYBOARD_STEP
          : event.key === "Home"
            ? min
            : event.key === "End"
              ? max
              : null;
    if (next === null) return;
    event.preventDefault();
    setBoundaryWidth(boundary, next);
  };

  const style = {
    "--source-revision-column-width": `${revisionWidth}px`,
    "--source-files-column-width": `${widths.files}px`,
  } as CSSProperties;
  const boundaries: Boundary[] =
    layout === "history" && revisionPaneVisible
      ? ["revisions", "files"]
      : ["files"];

  return (
    <div
      ref={rootRef}
      className={`${className} ${
        layout === "history" && revisionWidth === 0
          ? styles.revisionsHidden
          : ""
      }`.trimEnd()}
      style={style}
      data-source-column-layout={layout}
    >
      {children}
      {enabled &&
        boundaries.map((boundary) => (
          <div
            key={boundary}
            data-source-splitter={boundary}
            className={`${styles.splitter} ${boundary === "revisions" ? styles.splitterRevisions : styles.splitterFiles} ${
              dragging?.boundary === boundary ? styles.dragging : ""
            }`}
          >
            <span className={styles.splitterGuide} aria-hidden="true" />
            {(["top", "bottom"] as const).map((edge) => (
              <hr
                key={edge}
                data-source-splitter-edge={edge}
                className={`${styles.splitterHandle} ${styles.handleGlyph} ${edge === "top" ? styles.top : styles.bottom}`}
                aria-label={t(
                  boundary === "revisions"
                    ? "sourceResizeRevisionPane"
                    : "sourceResizeFilePane",
                )}
                aria-orientation="vertical"
                aria-valuemin={
                  boundary === "revisions" ? REVISION_MIN : FILES_MIN
                }
                aria-valuemax={
                  boundary === "revisions" ? REVISION_MAX : filesMax
                }
                aria-valuenow={
                  boundary === "revisions" ? revisionWidth : widths.files
                }
                title={
                  boundary === "revisions"
                    ? t(
                        revisionWidth === 0
                          ? "sourceShowRevisionPane"
                          : "sourceHideRevisionPane",
                      )
                    : undefined
                }
                tabIndex={0}
                onPointerDown={(event) => startDrag(event, boundary)}
                onClick={
                  boundary === "revisions" ? toggleRevisionPane : undefined
                }
                onKeyDown={(event) => handleKeyDown(event, boundary)}
              />
            ))}
          </div>
        ))}
    </div>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function cssPixels(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
