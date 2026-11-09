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

export type PopoverCloseReason = "outside" | "escape" | "back" | "select";

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
  /** Surface padding and frame. `plain` leaves both to the content. */
  surface?: "panel" | "plain";
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
    const place = () => {
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
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    window.visualViewport?.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
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

  const surfaceStyle: CSSProperties = { visibility: "hidden", ...style };
  return createPortal(
    <>
      {sheet ? <div className={styles.backdrop} aria-hidden="true" /> : null}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: focus tracking only; callers pass the surface's role (menu, dialog, listbox) */}
      <div
        {...rest}
        ref={setSurfaceRef}
        data-popover-layer={layerRef.current}
        className={[
          styles.popover,
          surface === "panel" ? styles.panel : undefined,
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
    document.body,
  );
}
