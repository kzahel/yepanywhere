import {
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n";
import { Button, buttonClassName, IconButton } from "./ui/Button";
import styles from "./ImageViewer.module.css";

interface ImageDimensions {
  height: number;
  width: number;
}

type ImageViewMode = "fit" | "zoom";

type NavigationChrome = "all" | "hidden" | "position";

const VIEW_MODE_CLASS: Record<ImageViewMode, string | undefined> = {
  fit: styles.fit,
  zoom: styles.zoom,
};

const NAVIGATION_CHROME_CLASS: Record<NavigationChrome, string | undefined> = {
  all: styles.visible,
  hidden: styles.hidden,
  position: styles.hidden,
};

const POSITION_CHROME_CLASS: Record<NavigationChrome, string | undefined> = {
  all: styles.visible,
  hidden: styles.hidden,
  position: styles.visible,
};

function cx(...classNames: (string | false | undefined)[]): string {
  return classNames.filter(Boolean).join(" ");
}

export interface ImageViewerNavigation {
  count: number;
  current: number;
  onNext: () => void;
  onPrevious: () => void;
}

export type ImageViewerNavigationInput = "controls" | "keyboard";

const IMAGE_VIEWER_PADDING_PX = 32;
const IMAGE_VIEWER_NAVIGATION_IDLE_MS = 1_800;
const IMAGE_VIEWER_NAVIGATION_TOUCH_IDLE_MS = 2_600;
const IMAGE_ZOOM_MIN = 0.1;
const IMAGE_ZOOM_MAX = 8;
const IMAGE_ZOOM_STEP = 1.25;

function ImageViewerChevron({ direction }: { direction: "next" | "previous" }) {
  return (
    <svg
      className={styles.navigationIcon}
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path d={direction === "previous" ? "m15 18-6-6 6-6" : "m9 6 6 6-6 6"} />
    </svg>
  );
}

function clampImageScale(scale: number): number {
  return Math.min(IMAGE_ZOOM_MAX, Math.max(IMAGE_ZOOM_MIN, scale));
}

function pointerDistance(
  first: { x: number; y: number },
  second: { x: number; y: number },
): number {
  return Math.hypot(second.x - first.x, second.y - first.y);
}

export function ImageViewer({
  fileName,
  initialNavigationChrome = "all",
  keyboardNavigationSequence = 0,
  navigation,
  onContextMenu,
  onNavigationInput,
  toolbarHost,
  url,
  vector = false,
}: {
  fileName: string;
  initialNavigationChrome?: "all" | "position";
  keyboardNavigationSequence?: number;
  navigation?: ImageViewerNavigation;
  onContextMenu?: (event: ReactMouseEvent<Element>) => void;
  onNavigationInput?: (input: ImageViewerNavigationInput) => void;
  toolbarHost?: HTMLElement | null;
  url: string;
  /**
   * Vector sources have no pixel grid to preserve, so "Fit" may enlarge them to
   * the stage. Raster sources stay shrink-only: scaling one past its natural
   * size shows interpolation, not detail.
   */
  vector?: boolean;
}) {
  const { t } = useI18n();
  const stageRef = useRef<HTMLDivElement>(null);
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const gestureRef = useRef<
    | {
        kind: "pan";
        scrollLeft: number;
        scrollTop: number;
        x: number;
        y: number;
      }
    | {
        contentX: number;
        contentY: number;
        distance: number;
        kind: "pinch";
        scale: number;
      }
    | null
  >(null);
  const suppressClickRef = useRef(false);
  const navigationFocusWithinRef = useRef(false);
  const navigationHideTimerRef = useRef<number | null>(null);
  const keyboardNavigationSequenceRef = useRef(keyboardNavigationSequence);
  const [dimensions, setDimensions] = useState<ImageDimensions | null>(null);
  const [viewMode, setViewMode] = useState<ImageViewMode>("fit");
  const [scale, setScale] = useState(1);
  const hasNavigation = Boolean(navigation);
  const [navigationChrome, setNavigationChrome] = useState<NavigationChrome>(
    () => (hasNavigation ? initialNavigationChrome : "hidden"),
  );

  const clearNavigationHideTimer = useCallback(() => {
    if (navigationHideTimerRef.current !== null) {
      window.clearTimeout(navigationHideTimerRef.current);
      navigationHideTimerRef.current = null;
    }
  }, []);

  const scheduleNavigationChromeHide = useCallback(
    (delay = IMAGE_VIEWER_NAVIGATION_IDLE_MS) => {
      clearNavigationHideTimer();
      navigationHideTimerRef.current = window.setTimeout(() => {
        navigationHideTimerRef.current = null;
        if (!navigationFocusWithinRef.current) {
          setNavigationChrome("hidden");
        }
      }, delay);
    },
    [clearNavigationHideTimer],
  );

  const revealNavigationChrome = useCallback(
    (mode: "all" | "position", delay = IMAGE_VIEWER_NAVIGATION_IDLE_MS) => {
      if (!hasNavigation) {
        return;
      }
      setNavigationChrome(
        mode === "position" && navigationFocusWithinRef.current ? "all" : mode,
      );
      scheduleNavigationChromeHide(delay);
    },
    [hasNavigation, scheduleNavigationChromeHide],
  );

  useEffect(() => {
    if (!hasNavigation) {
      clearNavigationHideTimer();
      setNavigationChrome("hidden");
      return;
    }
    revealNavigationChrome(initialNavigationChrome);
    return clearNavigationHideTimer;
  }, [
    clearNavigationHideTimer,
    hasNavigation,
    initialNavigationChrome,
    revealNavigationChrome,
  ]);

  useEffect(() => {
    if (keyboardNavigationSequenceRef.current === keyboardNavigationSequence) {
      return;
    }
    keyboardNavigationSequenceRef.current = keyboardNavigationSequence;
    revealNavigationChrome("position");
  }, [keyboardNavigationSequence, revealNavigationChrome]);

  const getFitScale = useCallback(() => {
    const stage = stageRef.current;
    if (!stage || !dimensions) {
      return 1;
    }
    const widthScale =
      (stage.clientWidth - IMAGE_VIEWER_PADDING_PX) / dimensions.width;
    const heightScale =
      (stage.clientHeight - IMAGE_VIEWER_PADDING_PX) / dimensions.height;
    const contained = Math.min(
      Math.max(IMAGE_ZOOM_MIN, widthScale),
      Math.max(IMAGE_ZOOM_MIN, heightScale),
    );
    return vector
      ? Math.min(IMAGE_ZOOM_MAX, contained)
      : Math.min(1, contained);
  }, [dimensions, vector]);

  const getCurrentScale = useCallback(
    () => (viewMode === "fit" ? getFitScale() : scale),
    [getFitScale, scale, viewMode],
  );

  const startPinch = useCallback(
    (first: { x: number; y: number }, second: { x: number; y: number }) => {
      const stage = stageRef.current;
      if (!stage) return;
      const rect = stage.getBoundingClientRect();
      const centerX = (first.x + second.x) / 2 - rect.left;
      const centerY = (first.y + second.y) / 2 - rect.top;
      gestureRef.current = {
        contentX: stage.scrollLeft + centerX,
        contentY: stage.scrollTop + centerY,
        distance: pointerDistance(first, second),
        kind: "pinch",
        scale: getCurrentScale(),
      };
    },
    [getCurrentScale],
  );

  const zoomAt = useCallback(
    (requestedScale: number, clientX?: number, clientY?: number) => {
      const stage = stageRef.current;
      const nextScale = clampImageScale(requestedScale);
      if (!stage) {
        setViewMode("zoom");
        setScale(nextScale);
        return;
      }

      const currentScale = getCurrentScale();
      const rect = stage.getBoundingClientRect();
      const viewportX =
        clientX === undefined ? stage.clientWidth / 2 : clientX - rect.left;
      const viewportY =
        clientY === undefined ? stage.clientHeight / 2 : clientY - rect.top;
      const contentX = stage.scrollLeft + viewportX;
      const contentY = stage.scrollTop + viewportY;
      setViewMode("zoom");
      setScale(nextScale);

      requestAnimationFrame(() => {
        const ratio = nextScale / currentScale;
        stage.scrollLeft = contentX * ratio - viewportX;
        stage.scrollTop = contentY * ratio - viewportY;
      });
    },
    [getCurrentScale],
  );

  const fitImage = useCallback(() => {
    setViewMode("fit");
    requestAnimationFrame(() => {
      const stage = stageRef.current;
      if (stage) {
        stage.scrollLeft = 0;
        stage.scrollTop = 0;
      }
    });
  }, []);

  const startRemainingPointerPan = useCallback(() => {
    const stage = stageRef.current;
    const remaining = pointersRef.current.values().next().value;
    gestureRef.current =
      stage && remaining
        ? {
            kind: "pan",
            scrollLeft: stage.scrollLeft,
            scrollTop: stage.scrollTop,
            x: remaining.x,
            y: remaining.y,
          }
        : null;
  }, []);

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== "touch") {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    pointersRef.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });
    const points = Array.from(pointersRef.current.values());
    if (points.length >= 2) {
      const [first, second] = points;
      if (!first || !second) {
        return;
      }
      startPinch(first, second);
      return;
    }
    startRemainingPointerPan();
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (
      event.pointerType !== "touch" ||
      !pointersRef.current.has(event.pointerId)
    ) {
      return;
    }
    pointersRef.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });
    const points = Array.from(pointersRef.current.values());
    if (points.length >= 2) {
      event.preventDefault();
      const [first, second] = points;
      if (!first || !second) {
        return;
      }
      const gesture = gestureRef.current;
      if (gesture?.kind !== "pinch") {
        startPinch(first, second);
        return;
      }
      const distance = pointerDistance(first, second);
      if (gesture.distance <= 0) {
        return;
      }
      suppressClickRef.current = true;
      const nextScale = clampImageScale(
        gesture.scale * (distance / gesture.distance),
      );
      const stage = stageRef.current;
      if (!stage) return;
      const rect = stage.getBoundingClientRect();
      const centerX = (first.x + second.x) / 2 - rect.left;
      const centerY = (first.y + second.y) / 2 - rect.top;
      setViewMode("zoom");
      setScale(nextScale);
      requestAnimationFrame(() => {
        const ratio = nextScale / gesture.scale;
        stage.scrollLeft = gesture.contentX * ratio - centerX;
        stage.scrollTop = gesture.contentY * ratio - centerY;
      });
      return;
    }

    const stage = stageRef.current;
    const gesture = gestureRef.current;
    const point = points[0];
    if (!point || gesture?.kind !== "pan") {
      return;
    }
    const dx = point.x - gesture.x;
    const dy = point.y - gesture.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) {
      suppressClickRef.current = true;
    }
    if (!stage || viewMode === "fit") {
      return;
    }
    stage.scrollLeft = gesture.scrollLeft - dx;
    stage.scrollTop = gesture.scrollTop - dy;
  };

  const handlePointerCancel = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== "touch") {
      return;
    }
    pointersRef.current.delete(event.pointerId);
    if (pointersRef.current.size === 0) {
      suppressClickRef.current = false;
    }
    startRemainingPointerPan();
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== "touch") {
      return;
    }
    pointersRef.current.delete(event.pointerId);
    const revealControls =
      pointersRef.current.size === 0 && !suppressClickRef.current;
    if (pointersRef.current.size === 0) {
      suppressClickRef.current = false;
    }
    startRemainingPointerPan();
    if (revealControls) {
      onNavigationInput?.("controls");
      revealNavigationChrome("all", IMAGE_VIEWER_NAVIGATION_TOUCH_IDLE_MS);
    }
  };

  const handleWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (!event.ctrlKey && !event.metaKey) {
      return;
    }
    event.preventDefault();
    zoomAt(
      getCurrentScale() * Math.exp(-event.deltaY * 0.002),
      event.clientX,
      event.clientY,
    );
  };

  const scaledDimensions =
    viewMode === "zoom" && dimensions
      ? {
          height: Math.max(1, Math.round(dimensions.height * scale)),
          width: Math.max(1, Math.round(dimensions.width * scale)),
        }
      : null;
  const canvasStyle = scaledDimensions
    ? ({
        height: scaledDimensions.height + IMAGE_VIEWER_PADDING_PX,
        width: scaledDimensions.width + IMAGE_VIEWER_PADDING_PX,
      } satisfies CSSProperties)
    : undefined;
  const imageStyle = scaledDimensions
    ? ({
        height: scaledDimensions.height,
        width: scaledDimensions.width,
      } satisfies CSSProperties)
    : undefined;
  const zoomLabel = `${Math.round(getCurrentScale() * 100)}%`;
  const toolbar = (
    <div
      className={cx(
        styles.toolbar,
        toolbarHost !== undefined && styles.headerToolbar,
      )}
      role="toolbar"
      aria-label={t("imageViewerControls")}
    >
      <Button
        variant="ghost"
        aria-pressed={viewMode === "fit"}
        onClick={fitImage}
      >
        {t("imageViewerFit")}
      </Button>
      <Button
        variant="ghost"
        aria-pressed={viewMode === "zoom" && scale === 1}
        onClick={() => zoomAt(1)}
      >
        {t("imageViewerActualSize")}
      </Button>
      <IconButton
        label={t("imageViewerZoomOut")}
        onClick={() => zoomAt(getCurrentScale() / IMAGE_ZOOM_STEP)}
      >
        −
      </IconButton>
      <output className={styles.zoomLevel} aria-live="polite">
        {zoomLabel}
      </output>
      <IconButton
        label={t("imageViewerZoomIn")}
        onClick={() => zoomAt(getCurrentScale() * IMAGE_ZOOM_STEP)}
      >
        +
      </IconButton>
      <a
        className={buttonClassName({
          variant: "ghost",
          className: styles.download,
        })}
        href={url}
        download={fileName}
        aria-label={t("imageViewerDownload", { name: fileName })}
      >
        {t("fileViewerDownload" as never)}
      </a>
    </div>
  );

  return (
    <div
      className={cx(
        styles.viewer,
        navigation && styles.hasNavigation,
        toolbarHost !== undefined && styles.toolbarPortaled,
      )}
    >
      {toolbarHost === undefined
        ? toolbar
        : toolbarHost
          ? createPortal(toolbar, toolbarHost)
          : null}
      <div
        className={styles.stageShell}
        onPointerMoveCapture={(event) => {
          if (event.pointerType !== "touch") {
            onNavigationInput?.("controls");
            revealNavigationChrome("all");
          }
        }}
      >
        <div
          ref={stageRef}
          className={cx(styles.stage, VIEW_MODE_CLASS[viewMode])}
          onPointerCancel={handlePointerCancel}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onWheel={handleWheel}
        >
          <div className={styles.canvas} style={canvasStyle}>
            <div className={cx(styles.surface, VIEW_MODE_CLASS[viewMode])}>
              <img
                className={cx(styles.image, vector && styles.vector)}
                src={url}
                alt={fileName}
                draggable={false}
                onContextMenu={onContextMenu}
                style={imageStyle}
                onLoad={(event) => {
                  setDimensions({
                    height: event.currentTarget.naturalHeight,
                    width: event.currentTarget.naturalWidth,
                  });
                }}
              />
            </div>
          </div>
        </div>
        {navigation ? (
          <div
            className={cx(
              styles.navigation,
              NAVIGATION_CHROME_CLASS[navigationChrome],
            )}
            role="group"
            aria-label={t("imageViewerGalleryNavigation")}
            onFocusCapture={() => {
              onNavigationInput?.("controls");
              navigationFocusWithinRef.current = true;
              clearNavigationHideTimer();
              setNavigationChrome("all");
            }}
            onBlurCapture={(event) => {
              if (
                event.relatedTarget instanceof Node &&
                event.currentTarget.contains(event.relatedTarget)
              ) {
                return;
              }
              navigationFocusWithinRef.current = false;
              scheduleNavigationChromeHide();
            }}
          >
            <IconButton
              variant="secondary"
              className={cx(styles.navigationButton, styles.previous)}
              label={t("imageViewerPrevious")}
              onClick={() => {
                onNavigationInput?.("controls");
                revealNavigationChrome("all");
                navigation.onPrevious();
              }}
            >
              <ImageViewerChevron direction="previous" />
            </IconButton>
            <IconButton
              variant="secondary"
              className={cx(styles.navigationButton, styles.next)}
              label={t("imageViewerNext")}
              onClick={() => {
                onNavigationInput?.("controls");
                revealNavigationChrome("all");
                navigation.onNext();
              }}
            >
              <ImageViewerChevron direction="next" />
            </IconButton>
          </div>
        ) : null}
      </div>
      {navigation ? (
        <output
          className={cx(
            styles.position,
            POSITION_CHROME_CLASS[navigationChrome],
          )}
          aria-live="polite"
        >
          {t("imageViewerGalleryPosition", {
            count: navigation.count,
            current: navigation.current,
          })}
        </output>
      ) : null}
    </div>
  );
}
