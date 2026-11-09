/**
 * The shared anchored floating surface (plan 182, family 2): menus,
 * dropdowns and small panels that open from a trigger or at a point.
 *
 * - Renders through a portal into `document.body`, fixed-positioned above
 *   modals (`--z-popover`) and below tooltips, so no ancestor's overflow or
 *   stacking context clips it.
 * - Placement is computed by script from the anchor's rect (or a point, for
 *   context menus): it flips to the side with more room, shifts to stay
 *   inside the viewport and caps its height to the room left, and follows
 *   scrolling, resizing and its own size changes.
 * - Dismissal: a pointer press outside the surface and its anchor, Escape
 *   (through the modal layer stack, so a popover inside a Modal closes
 *   before the Modal does), and optionally the mobile back gesture. Focus
 *   inside the surface returns to the anchor when it closes.
 *
 * Why not the Popover API's top layer: the top layer would cover the
 * tooltip layer and toasts, `Modal`'s capture-phase Escape handler cancels
 * the key before a popover's close request, and `popover="auto"`'s light
 * dismiss races React-owned open state on the trigger's own click. CSS
 * anchor positioning is not in older iOS WebKit (the native shell), so the
 * script positions every popover through one path.
 */
import {
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useModalBackGesture, useModalLayer } from "./Modal";
import styles from "./Popover.module.css";

export type PopoverSide = "bottom" | "top" | "right" | "left";
export type PopoverAlign = "start" | "center" | "end";
export type PopoverPlacement =
  | PopoverSide
  | `${PopoverSide}-${"start" | "end"}`;

export type PopoverCloseReason =
  | "outside"
  | "escape"
  | "back"
  | "select"
  /** The anchor was hidden (a parked page) or scrolled out of view. */
  | "hidden";

export interface PopoverPoint {
  x: number;
  y: number;
}

export interface PopoverProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  open: boolean;
  onClose: (reason: PopoverCloseReason) => void;
  /** The trigger: anchors the surface, and pressing it is not "outside". */
  anchorRef?: RefObject<HTMLElement | null>;
  /** Anchor at a point instead (a context menu at the pointer). */
  anchorPoint?: PopoverPoint | null;
  /** Anchor at a measured rect instead (a trigger measured at open). */
  anchorRect?: PopoverRect | null;
  /** Default `bottom-start`. Flips to the opposite side when that has more room. */
  placement?: PopoverPlacement;
  /** Gap between anchor and surface, px. Default 4. */
  offset?: number;
  /** At least the anchor's width. */
  matchAnchorWidth?: boolean;
  /** Other elements whose presses do not dismiss (a wrapper around the trigger). */
  insideRefs?: readonly RefObject<HTMLElement | null>[];
  /**
   * Called before Escape closes the popover. `event.preventDefault()` keeps
   * it open and lets the key reach its target (a field cancelling an edit).
   */
  onEscapeKeyDown?: (event: KeyboardEvent) => void;
  /** Push a history entry so the phone's back gesture closes the popover. */
  closeOnBackGesture?: boolean;
  /** Return focus to the anchor when focus was inside at close. Default true. */
  returnFocus?: boolean;
  /**
   * On phones (≤768 px), present as a bottom sheet over a backdrop, with the
   * page scroll locked, instead of anchored. For long pickers.
   */
  phoneSheet?: boolean;
  /**
   * A cap below the room left in the viewport, as a CSS length
   * (`min(60vh, 480px)`), for long lists.
   */
  maxHeight?: string;
  /**
   * Frame and padding: `panel` (menus, 4 px), `card` (text and small forms,
   * roomier), `plain` (the content draws its own).
   */
  surface?: "panel" | "card" | "plain";
  ref?: RefObject<HTMLDivElement | null>;
  children: ReactNode;
}

const VIEWPORT_MARGIN_PX = 8;
const PHONE_SHEET_QUERY = "(max-width: 768px)";
/**
 * Open order. A press inside a popover opened later (a submenu, a picker
 * opened from a menu) is not outside an earlier one.
 */
let popoverLayerSequence = 0;

/**
 * Swallow the click that ends the press which closed a popover, as the old
 * dismiss overlays did: the press that dismisses a menu must not also press
 * what lay under it (a row, a link, a Modal's backdrop). Expires so a press
 * that never becomes a click (a scroll) cannot eat a later one.
 */
function swallowNextClick(
  press: "mousedown" | "touchstart",
  pressed: Node | null,
): void {
  const swallow = (event: MouseEvent) => {
    const target = event.target;
    // The click that ends the same press targets the pressed element or an
    // ancestor it shares with the release point. With no pressed element (a
    // backdrop that left with the popover), whatever is under the finger.
    if (pressed && target instanceof Node && !target.contains(pressed)) {
      stop();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    stop();
  };
  const stop = () => {
    clearTimeout(timer);
    document.removeEventListener("click", swallow, true);
    document.removeEventListener("pointerdown", stop, true);
    document.removeEventListener(press, stop, true);
  };
  const timer = setTimeout(stop, 1000);
  document.addEventListener("click", swallow, true);
  // The press that closed the popover fired its pointerdown already, so the
  // next press of either kind is a new one, which must reach its target. (A
  // touch's compatibility mousedown belongs to the same press, hence the
  // press kind rather than mousedown always.)
  document.addEventListener("pointerdown", stop, true);
  document.addEventListener(press, stop, true);
}

/** A dialog the anchor sits in: the popover portals inside it, or assistive technology would treat it as outside the modal dialog. */
function portalContainer(anchor: Element | null): HTMLElement {
  return anchor?.closest<HTMLElement>('[aria-modal="true"]') ?? document.body;
}

function anchorIsHidden(anchor: HTMLElement): boolean {
  if (!anchor.isConnected) return true;
  if (typeof anchor.checkVisibility === "function") {
    return !anchor.checkVisibility({ visibilityProperty: true });
  }
  const style = getComputedStyle(anchor);
  return style.visibility === "hidden" || style.display === "none";
}

/** Whether the anchor is scrolled out of the viewport or a clipping ancestor. */
function anchorIsClipped(anchor: HTMLElement): boolean {
  const rect = anchor.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false;
  const outside = (box: {
    top: number;
    bottom: number;
    left: number;
    right: number;
  }) =>
    rect.bottom <= box.top ||
    rect.top >= box.bottom ||
    rect.right <= box.left ||
    rect.left >= box.right;
  if (
    outside({
      top: 0,
      left: 0,
      bottom: window.innerHeight,
      right: window.innerWidth,
    })
  ) {
    return true;
  }
  for (
    let ancestor = anchor.parentElement;
    ancestor && ancestor !== document.body;
    ancestor = ancestor.parentElement
  ) {
    const { overflowX, overflowY } = getComputedStyle(ancestor);
    if (overflowX === "visible" && overflowY === "visible") continue;
    if (outside(ancestor.getBoundingClientRect())) return true;
  }
  return false;
}

function splitPlacement(placement: PopoverPlacement): {
  side: PopoverSide;
  align: PopoverAlign;
} {
  const [side, align] = placement.split("-") as [
    PopoverSide,
    "start" | "end" | undefined,
  ];
  return { side, align: align ?? "center" };
}

const OPPOSITE: Record<PopoverSide, PopoverSide> = {
  bottom: "top",
  top: "bottom",
  right: "left",
  left: "right",
};

export interface PopoverRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  height: number;
}

/** Fixed coordinates for a surface of `size` beside `anchor` in the viewport. */
export function computePopoverPosition({
  anchor,
  size,
  viewport,
  placement,
  offset,
}: {
  anchor: PopoverRect;
  size: { width: number; height: number };
  viewport: { width: number; height: number };
  placement: PopoverPlacement;
  offset: number;
}): { top: number; left: number; maxHeight: number; side: PopoverSide } {
  const margin = VIEWPORT_MARGIN_PX;
  const { side: preferred, align } = splitPlacement(placement);
  const room: Record<PopoverSide, number> = {
    bottom: viewport.height - anchor.bottom - offset - margin,
    top: anchor.top - offset - margin,
    right: viewport.width - anchor.right - offset - margin,
    left: anchor.left - offset - margin,
  };
  const vertical = preferred === "bottom" || preferred === "top";
  const needed = vertical ? size.height : size.width;
  const opposite = OPPOSITE[preferred];
  const side =
    room[preferred] < needed && room[opposite] > room[preferred]
      ? opposite
      : preferred;

  const clamp = (value: number, extent: number, limit: number) =>
    Math.max(margin, Math.min(value, limit - extent - margin));

  if (vertical) {
    const top =
      side === "bottom"
        ? anchor.bottom + offset
        : Math.max(margin, anchor.top - offset - size.height);
    const left =
      align === "start"
        ? anchor.left
        : align === "end"
          ? anchor.right - size.width
          : anchor.left + anchor.width / 2 - size.width / 2;
    return {
      side,
      top,
      left: clamp(left, size.width, viewport.width),
      maxHeight: Math.max(0, side === "bottom" ? room.bottom : room.top),
    };
  }
  const left =
    side === "right"
      ? anchor.right + offset
      : Math.max(margin, anchor.left - offset - size.width);
  const top =
    align === "start"
      ? anchor.top
      : align === "end"
        ? anchor.bottom - size.height
        : anchor.top + anchor.height / 2 - size.height / 2;
  return {
    side,
    top: clamp(top, size.height, viewport.height),
    left,
    maxHeight: Math.max(0, viewport.height - margin * 2),
  };
}

/** Whether an open `phoneSheet` popover is on a phone; idle while closed. */
function usePhoneSheet(enabled: boolean): boolean {
  const [phone, setPhone] = useState(false);
  useLayoutEffect(() => {
    if (!enabled || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(PHONE_SHEET_QUERY);
    setPhone(query.matches);
    const onChange = (event: MediaQueryListEvent) => setPhone(event.matches);
    query.addEventListener?.("change", onChange);
    return () => query.removeEventListener?.("change", onChange);
  }, [enabled]);
  return enabled && phone;
}

function pointBox({ x, y }: PopoverPoint): PopoverRect {
  return { top: y, bottom: y, left: x, right: x, width: 0, height: 0 };
}

export function Popover({
  open,
  onClose,
  anchorRef,
  anchorPoint,
  anchorRect,
  placement = "bottom-start",
  offset = 4,
  matchAnchorWidth = false,
  insideRefs,
  onEscapeKeyDown,
  closeOnBackGesture = false,
  returnFocus = true,
  surface = "panel",
  phoneSheet = false,
  maxHeight,
  className,
  style,
  ref,
  children,
  onFocus,
  onBlur,
  ...rest
}: PopoverProps) {
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const onEscapeRef = useRef(onEscapeKeyDown);
  onEscapeRef.current = onEscapeKeyDown;
  const insideRefsRef = useRef(insideRefs);
  insideRefsRef.current = insideRefs;
  // Whether focus is inside the surface, read when it closes. Removing a
  // focused element moves focus to <body> without a blur event, so this is
  // tracked rather than read from document.activeElement afterwards.
  const focusInsideRef = useRef(false);
  const layerRef = useRef(0);
  if (open && layerRef.current === 0) {
    popoverLayerSequence += 1;
    layerRef.current = popoverLayerSequence;
  } else if (!open) {
    layerRef.current = 0;
  }
  const sheet = usePhoneSheet(phoneSheet && open);
  const containerRef = useRef<HTMLElement | null>(null);
  if (open && !containerRef.current && typeof document !== "undefined") {
    const anchorElement =
      anchorRef?.current ??
      (typeof document.elementFromPoint !== "function"
        ? null
        : anchorPoint
          ? document.elementFromPoint(anchorPoint.x, anchorPoint.y)
          : anchorRect
            ? document.elementFromPoint(
                anchorRect.left + anchorRect.width / 2,
                anchorRect.top + anchorRect.height / 2,
              )
            : null);
    containerRef.current = portalContainer(anchorElement);
  } else if (!open) {
    containerRef.current = null;
  }

  const setSurfaceRef = useCallback(
    (element: HTMLDivElement | null) => {
      surfaceRef.current = element;
      if (ref) ref.current = element;
    },
    [ref],
  );

  useModalLayer(
    (event) => {
      onEscapeRef.current?.(event);
      if (event.defaultPrevented) return false;
      onCloseRef.current("escape");
      return true;
    },
    open,
    { lockScroll: sheet },
  );
  useModalBackGesture(
    () => onCloseRef.current("back"),
    open && closeOnBackGesture,
    "yaPopover",
  );

  // Dismiss on a press outside. Capture phase, so a Modal or row that stops
  // its own mousedown still lets the popover see it.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (surfaceRef.current?.contains(target)) return;
      if (anchorRef?.current?.contains(target)) return;
      if (insideRefsRef.current?.some((r) => r.current?.contains(target))) {
        return;
      }
      const layer =
        target instanceof Element
          ? target.closest<HTMLElement>("[data-popover-layer]")
          : null;
      if (Number(layer?.dataset.popoverLayer) > layerRef.current) return;
      swallowNextClick(
        event.type === "touchstart" ? "touchstart" : "mousedown",
        target instanceof Element && target.closest("[data-popover-backdrop]")
          ? null
          : target,
      );
      onCloseRef.current("outside");
    };
    document.addEventListener("mousedown", onPointerDown, true);
    document.addEventListener("touchstart", onPointerDown, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown, true);
      document.removeEventListener("touchstart", onPointerDown, true);
    };
  }, [open, anchorRef]);

  // Place before paint, then follow scrolling, resizing and size changes.
  const pointX = anchorPoint?.x;
  const pointY = anchorPoint?.y;
  const rectTop = anchorRect?.top;
  const rectLeft = anchorRect?.left;
  const rectWidth = anchorRect?.width;
  const rectHeight = anchorRect?.height;
  useLayoutEffect(() => {
    if (!open) return;
    const element = surfaceRef.current;
    if (!element) return;
    const anchorElement = anchorRef?.current ?? null;
    // The portal leaves a nested theme (a playground cell); carry it over.
    const themed = anchorElement?.closest<HTMLElement>("[data-theme]");
    if (themed && themed !== document.documentElement) {
      element.dataset.theme = themed.dataset.theme;
    }
    // An anchor on a page that was parked or hidden, or scrolled out of
    // view, takes its popover with it.
    const anchorGone = () => {
      if (!anchorElement || sheet) return false;
      if (!anchorIsHidden(anchorElement) && !anchorIsClipped(anchorElement)) {
        return false;
      }
      onCloseRef.current("hidden");
      return true;
    };
    const place = () => {
      if (anchorGone()) return;
      if (sheet) {
        element.style.removeProperty("top");
        element.style.removeProperty("left");
        element.style.visibility = "visible";
        return;
      }
      const anchor =
        (rectTop !== undefined &&
        rectLeft !== undefined &&
        rectWidth !== undefined &&
        rectHeight !== undefined
          ? {
              top: rectTop,
              left: rectLeft,
              width: rectWidth,
              height: rectHeight,
              bottom: rectTop + rectHeight,
              right: rectLeft + rectWidth,
            }
          : undefined) ??
        (pointX !== undefined && pointY !== undefined
          ? pointBox({ x: pointX, y: pointY })
          : anchorElement?.getBoundingClientRect());
      if (!anchor) return;
      if (matchAnchorWidth) {
        element.style.minWidth = `${anchor.width}px`;
      }
      const position = computePopoverPosition({
        anchor,
        size: { width: element.offsetWidth, height: element.offsetHeight },
        viewport: {
          width: document.documentElement.clientWidth || window.innerWidth,
          height: window.innerHeight,
        },
        placement,
        offset,
      });
      element.style.top = `${position.top}px`;
      element.style.left = `${position.left}px`;
      element.style.setProperty(
        "--popover-available-height",
        `${position.maxHeight}px`,
      );
      element.dataset.side = position.side;
      element.style.visibility = "visible";
    };
    place();
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(place);
    };
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(schedule);
    observer?.observe(element);
    if (anchorElement) observer?.observe(anchorElement);
    // Parking a page hides it by a class or style on an ancestor.
    const ancestry =
      anchorElement && typeof MutationObserver !== "undefined"
        ? new MutationObserver(() => anchorGone())
        : null;
    for (
      let ancestor = anchorElement?.parentElement;
      ancestry && ancestor && ancestor !== document.body;
      ancestor = ancestor.parentElement
    ) {
      ancestry.observe(ancestor, {
        attributes: true,
        attributeFilter: ["class", "style", "hidden"],
      });
    }
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    window.visualViewport?.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      ancestry?.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      window.visualViewport?.removeEventListener("resize", schedule);
    };
  }, [
    open,
    anchorRef,
    pointX,
    pointY,
    rectTop,
    rectLeft,
    rectWidth,
    rectHeight,
    placement,
    offset,
    matchAnchorWidth,
    sheet,
  ]);

  // Focus inside at close goes back to the trigger, not to <body>.
  useLayoutEffect(() => {
    if (!open || !returnFocus) return;
    const anchorElement = anchorRef?.current ?? null;
    return () => {
      const focusWasInside = focusInsideRef.current;
      focusInsideRef.current = false;
      if (focusWasInside && anchorElement?.isConnected) {
        anchorElement.focus({ preventScroll: true });
      }
    };
  }, [open, returnFocus, anchorRef]);

  if (!open || typeof document === "undefined") return null;

  const surfaceStyle: CSSProperties = {
    visibility: "hidden",
    ...(maxHeight
      ? {
          maxHeight: `min(var(--popover-available-height, 100dvh), ${maxHeight})`,
        }
      : null),
    ...style,
  };
  return createPortal(
    <>
      {sheet ? (
        <div
          className={styles.backdrop}
          aria-hidden="true"
          data-popover-backdrop=""
        />
      ) : null}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: focus tracking only; callers pass the surface's role (menu, dialog, listbox) */}
      <div
        {...rest}
        ref={setSurfaceRef}
        data-popover-layer={layerRef.current}
        className={[
          styles.popover,
          surface === "plain" ? undefined : styles.panel,
          surface === "card" ? styles.card : undefined,
          sheet ? styles.sheet : undefined,
          className,
        ]
          .filter(Boolean)
          .join(" ")}
        style={surfaceStyle}
        onFocus={(event) => {
          focusInsideRef.current = true;
          onFocus?.(event);
        }}
        onBlur={(event) => {
          const next = event.relatedTarget;
          focusInsideRef.current =
            next instanceof Node && event.currentTarget.contains(next);
          onBlur?.(event);
        }}
      >
        {children}
      </div>
    </>,
    containerRef.current ?? document.body,
  );
}
