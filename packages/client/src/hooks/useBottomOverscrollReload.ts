import { useEffect, useRef, useState } from "react";
import { hasTouchCapability } from "../lib/deviceDetection";

export type BottomOverscrollReloadStatus = "hidden" | "pull" | "armed";

const RELOAD_SCROLL_SELECTOR =
  "[data-session-messages], [data-page-scroll-container]";
const INTERACTIVE_TARGET_SELECTOR =
  "input, textarea, select, [contenteditable='true']";
const MIN_SCROLL_OVERFLOW_PX = 48;
const BOTTOM_TOLERANCE_PX = 2;
const INDICATOR_THRESHOLD_PX = 18;
export const BOTTOM_OVERSCROLL_RELOAD_THRESHOLD_PX = 84;

function targetToElement(target: EventTarget | null): Element | null {
  if (target instanceof Element) {
    return target;
  }
  if (target instanceof Node) {
    return target.parentElement;
  }
  return null;
}

export function hasSufficientScrollOverflow(container: HTMLElement): boolean {
  return (
    container.scrollHeight - container.clientHeight > MIN_SCROLL_OVERFLOW_PX
  );
}

export function isScrollContainerAtBottom(
  container: HTMLElement,
  tolerancePx = BOTTOM_TOLERANCE_PX,
): boolean {
  return (
    container.scrollHeight - container.clientHeight - container.scrollTop <=
    tolerancePx
  );
}

export function findBottomOverscrollReloadContainer(
  target: EventTarget | null,
): HTMLElement | null {
  const element = targetToElement(target);
  if (!element || element.closest(INTERACTIVE_TARGET_SELECTOR)) {
    return null;
  }

  const container = element.closest<HTMLElement>(RELOAD_SCROLL_SELECTOR);
  if (!container || !hasSufficientScrollOverflow(container)) {
    return null;
  }

  return container;
}

export function getBottomOverscrollDistance(
  startY: number,
  currentY: number,
): number {
  return Math.max(0, startY - currentY);
}

export function getBottomOverscrollReloadStatus(options: {
  distancePx: number;
  atBottom: boolean;
}): BottomOverscrollReloadStatus {
  if (!options.atBottom) {
    return "hidden";
  }
  if (options.distancePx >= BOTTOM_OVERSCROLL_RELOAD_THRESHOLD_PX) {
    return "armed";
  }
  if (options.distancePx >= INDICATOR_THRESHOLD_PX) {
    return "pull";
  }
  return "hidden";
}

interface GestureState {
  active: boolean;
  container: HTMLElement | null;
  startY: number;
  status: BottomOverscrollReloadStatus;
}

function createInitialGestureState(): GestureState {
  return {
    active: false,
    container: null,
    startY: 0,
    status: "hidden",
  };
}

export function useBottomOverscrollReload(
  onReload: () => void,
  options: { disabled?: boolean } = {},
): BottomOverscrollReloadStatus {
  const { disabled = false } = options;
  const [status, setStatus] = useState<BottomOverscrollReloadStatus>("hidden");
  const gestureRef = useRef<GestureState>(createInitialGestureState());
  const statusRef = useRef<BottomOverscrollReloadStatus>("hidden");

  useEffect(() => {
    if (disabled || !hasTouchCapability()) {
      setStatus("hidden");
      statusRef.current = "hidden";
      gestureRef.current = createInitialGestureState();
      return;
    }

    const updateStatus = (next: BottomOverscrollReloadStatus) => {
      if (statusRef.current === next) {
        return;
      }
      statusRef.current = next;
      setStatus(next);
    };

    const resetGesture = () => {
      gestureRef.current = createInitialGestureState();
      updateStatus("hidden");
    };

    const handleTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        resetGesture();
        return;
      }

      const container = findBottomOverscrollReloadContainer(event.target);
      if (!container || !isScrollContainerAtBottom(container)) {
        resetGesture();
        return;
      }

      gestureRef.current = {
        active: true,
        container,
        startY: event.touches[0]?.clientY ?? 0,
        status: "hidden",
      };
    };

    const handleTouchMove = (event: TouchEvent) => {
      const gesture = gestureRef.current;
      if (!gesture.active || !gesture.container || event.touches.length !== 1) {
        return;
      }

      const distancePx = getBottomOverscrollDistance(
        gesture.startY,
        event.touches[0]?.clientY ?? gesture.startY,
      );
      const nextStatus = getBottomOverscrollReloadStatus({
        distancePx,
        atBottom: isScrollContainerAtBottom(gesture.container),
      });

      gesture.status = nextStatus;
      updateStatus(nextStatus);
    };

    const finishGesture = () => {
      const gesture = gestureRef.current;
      const shouldReload =
        gesture.active &&
        gesture.status === "armed" &&
        !!gesture.container &&
        isScrollContainerAtBottom(gesture.container);

      resetGesture();

      if (shouldReload) {
        onReload();
      }
    };

    document.addEventListener("touchstart", handleTouchStart, {
      passive: true,
    });
    document.addEventListener("touchmove", handleTouchMove, {
      passive: true,
    });
    document.addEventListener("touchend", finishGesture, { passive: true });
    document.addEventListener("touchcancel", finishGesture, { passive: true });

    return () => {
      document.removeEventListener("touchstart", handleTouchStart);
      document.removeEventListener("touchmove", handleTouchMove);
      document.removeEventListener("touchend", finishGesture);
      document.removeEventListener("touchcancel", finishGesture);
    };
  }, [disabled, onReload]);

  return status;
}
