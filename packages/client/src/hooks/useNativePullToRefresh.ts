import { useEffect, useState } from "react";

type Status = "hidden" | "pull" | "armed";

/** WebView has no browser pull-to-refresh. Respect nested scrolling and inputs. */
export function useNativePullToRefresh(onReload: () => void): Status {
  const [status, setStatus] = useState<Status>("hidden");
  useEffect(() => {
    let gesture: { container: HTMLElement; x: number; y: number } | null = null;
    let current: Status = "hidden";
    const update = (next: Status) => {
      if (current !== next) {
        current = next;
        setStatus(next);
      }
    };
    const reset = () => {
      gesture = null;
      update("hidden");
    };
    const start = (event: TouchEvent) => {
      reset();
      const touch = event.touches[0];
      if (event.touches.length !== 1 || !touch) return;
      let element = event.target instanceof HTMLElement ? event.target : null;
      if (element?.closest("input, textarea, select, [contenteditable='true']"))
        return;
      while (element) {
        // A nested scroll surface owns the gesture, even at its own top.
        if (
          element.matches("[data-page-scroll-container], .session-messages")
        ) {
          if (element.scrollTop <= 2)
            gesture = {
              container: element,
              x: touch.clientX,
              y: touch.clientY,
            };
          return;
        }
        if (
          element.scrollHeight > element.clientHeight &&
          /auto|scroll/.test(getComputedStyle(element).overflowY)
        )
          return;
        element = element.parentElement;
      }
    };
    const move = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!gesture) return;
      if (
        event.touches.length !== 1 ||
        !touch ||
        gesture.container.scrollTop > 2
      ) {
        reset();
        return;
      }
      const dy = touch.clientY - gesture.y;
      const dx = Math.abs(touch.clientX - gesture.x);
      if (dy < -8 || (dx > 8 && dx > dy)) {
        reset();
        return;
      }
      if (dy > 8 && event.cancelable) event.preventDefault();
      update(dy >= 84 ? "armed" : dy >= 18 ? "pull" : "hidden");
    };
    const end = () => {
      const reload =
        current === "armed" && gesture && gesture.container.scrollTop <= 2;
      reset();
      if (reload) onReload();
    };
    document.addEventListener("touchstart", start, { passive: true });
    document.addEventListener("touchmove", move, { passive: false });
    document.addEventListener("touchend", end, { passive: true });
    document.addEventListener("touchcancel", reset, { passive: true });
    return () => {
      document.removeEventListener("touchstart", start);
      document.removeEventListener("touchmove", move);
      document.removeEventListener("touchend", end);
      document.removeEventListener("touchcancel", reset);
    };
  }, [onReload]);
  return status;
}
