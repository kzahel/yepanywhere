import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useI18n } from "../i18n";
import {
  openPdfjsDocument,
  type PdfjsDocument,
  type PdfjsViewport,
} from "../lib/pdfjsRenderer";
import { Button, IconButton } from "./ui/Button";
import styles from "./PdfjsDocumentView.module.css";

interface PdfjsDocumentViewProps {
  url: string;
  fileName: string;
  loading: string;
  onError: () => void;
}

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 5;
const ZOOM_STEP = 1.25;
/** Widest a page is drawn at zoom 1, so wide screens keep a readable page. */
const MAX_FIT_WIDTH = 960;
/** Horizontal padding of `.document` on each side, in CSS pixels. */
const DOCUMENT_PADDING = 12;
/** Canvas area cap: iOS refuses larger canvases, and memory grows with it. */
const MAX_CANVAS_PIXELS = 16_777_216;

const clampZoom = (zoom: number) =>
  Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));

/**
 * A PDF drawn by pdf.js in its own scroll area. Every page is laid out at its
 * aspect ratio when the document opens, so the scroll extent is stable; a
 * canvas is drawn while its page is within a screen of view and released
 * beyond that. The view zooms by pinch, ctrl+wheel (a trackpad pinch), or its
 * buttons, around the gesture's focal point. YA disables page-level pinch
 * zoom, so the view owns the gesture: it previews the scale with a transform
 * and redraws the pages sharp at the new size when the gesture settles.
 */
export function PdfjsDocumentView({
  url,
  fileName,
  loading,
  onError,
}: PdfjsDocumentViewProps) {
  const { t } = useI18n();
  const [opened, setOpened] = useState<{
    document: PdfjsDocument;
    sizes: PdfjsViewport[];
  } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pagesRef = useRef<HTMLDivElement>(null);
  const [fitWidth, setFitWidth] = useState<number | null>(null);
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const pendingScroll = useRef<{ left: number; top: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setOpened(null);
    setZoom(1);
    const task = openPdfjsDocument(url);
    task.promise
      .then(async (document) => {
        const sizes: PdfjsViewport[] = [];
        for (let number = 1; number <= document.numPages; number += 1)
          sizes.push(
            (await document.getPage(number)).getViewport({ scale: 1 }),
          );
        if (!cancelled) setOpened({ document, sizes });
      })
      .catch(() => {
        if (!cancelled) onError();
      });
    return () => {
      cancelled = true;
      task.destroy();
    };
  }, [url, onError]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the scroll area mounts only once the document has opened.
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const measure = () =>
      setFitWidth(
        Math.max(
          1,
          Math.min(MAX_FIT_WIDTH, scroller.clientWidth - 2 * DOCUMENT_PADDING),
        ),
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [opened]);

  /**
   * Settle a zoom by `scale` about a point in client coordinates, keeping
   * the document point under it in place.
   */
  const commitZoom = useCallback(
    (scale: number, clientX: number, clientY: number) => {
      const scroller = scrollRef.current;
      const current = zoomRef.current;
      const next = clampZoom(current * scale);
      if (!scroller || next === current) {
        clearPreview(pagesRef.current);
        return;
      }
      const rect = scroller.getBoundingClientRect();
      const x = clientX - rect.left;
      const y = clientY - rect.top;
      const ratio = next / current;
      pendingScroll.current = {
        left: (scroller.scrollLeft + x) * ratio - x,
        top: (scroller.scrollTop + y) * ratio - y,
      };
      setZoom(next);
    },
    [],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs after each zoom's layout, before paint.
  useLayoutEffect(() => {
    // Swap the transform preview for the laid-out zoom in one frame.
    clearPreview(pagesRef.current);
    const scroller = scrollRef.current;
    const target = pendingScroll.current;
    pendingScroll.current = null;
    if (scroller && target) {
      scroller.scrollLeft = target.left;
      scroller.scrollTop = target.top;
    }
  }, [zoom]);

  usePinchZoom(scrollRef, pagesRef, zoomRef, commitZoom, opened !== null);

  const zoomAboutCenter = (scale: number) => {
    const rect = scrollRef.current?.getBoundingClientRect();
    if (rect)
      commitZoom(scale, rect.left + rect.width / 2, rect.top + rect.height / 2);
  };

  if (!opened) return <div className="file-viewer-loading">{loading}</div>;
  const pageWidth = fitWidth === null ? null : fitWidth * zoom;
  return (
    <div className={styles.view}>
      <div ref={scrollRef} className={styles.scroller}>
        <div
          ref={pagesRef}
          className={styles.document}
          role="document"
          aria-label={fileName}
        >
          {pageWidth !== null &&
            opened.sizes.map((size, index) => (
              <PdfjsPageCanvas
                key={index}
                document={opened.document}
                pageNumber={index + 1}
                size={size}
                width={pageWidth}
                root={scrollRef}
                onError={onError}
              />
            ))}
        </div>
      </div>
      <div className={styles.zoomControls}>
        <IconButton
          onClick={() => zoomAboutCenter(1 / ZOOM_STEP)}
          disabled={zoom <= MIN_ZOOM}
          label={t("pdfjsZoomOut" as never)}
        >
          −
        </IconButton>
        <Button
          variant="ghost"
          className={styles.zoomLevel}
          onClick={() => zoomAboutCenter(1 / zoom)}
          aria-label={t("pdfjsZoomFit" as never)}
        >
          {Math.round(zoom * 100)}%
        </Button>
        <IconButton
          onClick={() => zoomAboutCenter(ZOOM_STEP)}
          disabled={zoom >= MAX_ZOOM}
          label={t("pdfjsZoomIn" as never)}
        >
          +
        </IconButton>
      </div>
    </div>
  );
}

function clearPreview(pages: HTMLElement | null) {
  if (!pages) return;
  pages.style.transform = "";
  pages.style.transformOrigin = "";
}

/**
 * Two-finger pinch and ctrl+wheel on the scroll area. While a gesture runs,
 * the pages are scaled by a transform about its focal point; the settled
 * scale goes to `commit`, which lays the pages out at the new zoom.
 */
function usePinchZoom(
  scrollRef: RefObject<HTMLDivElement | null>,
  pagesRef: RefObject<HTMLDivElement | null>,
  zoomRef: RefObject<number>,
  commit: (scale: number, clientX: number, clientY: number) => void,
  active: boolean,
) {
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!active || !scroller) return;
    let gesture: {
      scale: number;
      clientX: number;
      clientY: number;
      startDistance: number;
    } | null = null;
    let wheelTimer: ReturnType<typeof setTimeout> | undefined;

    const preview = (scale: number, clientX: number, clientY: number) => {
      const pages = pagesRef.current;
      if (!pages) return scale;
      const bounded = clampZoom(zoomRef.current * scale) / zoomRef.current;
      const rect = pages.getBoundingClientRect();
      pages.style.transformOrigin = `${clientX - rect.left}px ${clientY - rect.top}px`;
      pages.style.transform = `scale(${bounded})`;
      return bounded;
    };
    const distance = (touches: TouchList) =>
      Math.hypot(
        touches[0]!.clientX - touches[1]!.clientX,
        touches[0]!.clientY - touches[1]!.clientY,
      );

    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 2) return;
      const [a, b] = [event.touches[0]!, event.touches[1]!];
      gesture = {
        scale: 1,
        clientX: (a.clientX + b.clientX) / 2,
        clientY: (a.clientY + b.clientY) / 2,
        startDistance: distance(event.touches),
      };
    };
    const onTouchMove = (event: TouchEvent) => {
      if (!gesture || event.touches.length !== 2) return;
      event.preventDefault();
      gesture.scale = preview(
        distance(event.touches) / gesture.startDistance,
        gesture.clientX,
        gesture.clientY,
      );
    };
    const onTouchEnd = (event: TouchEvent) => {
      if (!gesture || event.touches.length >= 2) return;
      const settled = gesture;
      gesture = null;
      commit(settled.scale, settled.clientX, settled.clientY);
    };
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      gesture ??= {
        scale: 1,
        clientX: event.clientX,
        clientY: event.clientY,
        startDistance: 0,
      };
      // A trackpad pinch arrives as small deltas where e^(-delta/100) is the
      // pinch scale; a mouse notch (large, or counted in lines) is one step.
      const notch =
        event.deltaMode !== WheelEvent.DOM_DELTA_PIXEL ||
        Math.abs(event.deltaY) >= 50;
      const factor = notch
        ? event.deltaY < 0
          ? ZOOM_STEP
          : 1 / ZOOM_STEP
        : Math.exp(-event.deltaY / 100);
      gesture.scale = preview(
        gesture.scale * factor,
        gesture.clientX,
        gesture.clientY,
      );
      clearTimeout(wheelTimer);
      wheelTimer = setTimeout(() => {
        const settled = gesture;
        gesture = null;
        if (settled) commit(settled.scale, settled.clientX, settled.clientY);
      }, 150);
    };

    scroller.addEventListener("touchstart", onTouchStart, { passive: true });
    scroller.addEventListener("touchmove", onTouchMove, { passive: false });
    scroller.addEventListener("touchend", onTouchEnd);
    scroller.addEventListener("touchcancel", onTouchEnd);
    scroller.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      clearTimeout(wheelTimer);
      scroller.removeEventListener("touchstart", onTouchStart);
      scroller.removeEventListener("touchmove", onTouchMove);
      scroller.removeEventListener("touchend", onTouchEnd);
      scroller.removeEventListener("touchcancel", onTouchEnd);
      scroller.removeEventListener("wheel", onWheel);
    };
  }, [scrollRef, pagesRef, zoomRef, commit, active]);
}

function PdfjsPageCanvas({
  document,
  pageNumber,
  size,
  width,
  root,
  onError,
}: {
  document: PdfjsDocument;
  pageNumber: number;
  size: PdfjsViewport;
  /** Laid-out page width in CSS pixels. */
  width: number;
  root: RefObject<HTMLDivElement | null>;
  onError: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let render: { cancel(): void } | null = null;
    let drawn = false;
    let cancelled = false;
    const draw = async () => {
      drawn = true;
      const page = await document.getPage(pageNumber);
      const wanted = width * window.devicePixelRatio;
      const height = (wanted * size.height) / size.width;
      const fit = Math.min(1, Math.sqrt(MAX_CANVAS_PIXELS / (wanted * height)));
      const viewport = page.getViewport({
        scale: (wanted * fit) / size.width,
      });
      if (cancelled || !drawn) return;
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      const task = page.render({ canvas, viewport });
      render = task;
      await task.promise;
    };
    const release = () => {
      drawn = false;
      render?.cancel();
      render = null;
      canvas.width = 0;
      canvas.height = 0;
    };
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.some((entry) => entry.isIntersecting);
        if (visible && !drawn)
          // Cancelling an in-flight render rejects it too. A real failure
          // surfaces as the fallback to the browser's viewer.
          draw().catch((error: unknown) => {
            if (!cancelled && drawn && !isRenderCancel(error)) onError();
          });
        // Also drops a bitmap drawn at an earlier zoom.
        else if (!visible && (drawn || canvas.width > 0)) release();
      },
      { root: root.current, rootMargin: "100% 50%" },
    );
    observer.observe(canvas);
    return () => {
      cancelled = true;
      observer.disconnect();
      render?.cancel();
    };
  }, [document, pageNumber, size, width, root, onError]);

  return (
    <canvas
      ref={canvasRef}
      className={styles.page}
      style={{ width, aspectRatio: `${size.width} / ${size.height}` }}
    />
  );
}

function isRenderCancel(error: unknown): boolean {
  return error instanceof Error && error.name === "RenderingCancelledException";
}
