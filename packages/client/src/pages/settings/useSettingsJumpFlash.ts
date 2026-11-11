import { useCallback, useEffect, useRef, useState } from "react";
import { useSettingsJumpTarget } from "./SettingsSearchContext";

/** Consume a search destination after its normal pane has mounted. */
export function useSettingsJumpFlash(id: string, searching: boolean) {
  const jump = useSettingsJumpTarget();
  const ref = useRef<HTMLElement | null>(null);
  const setRef = useCallback((element: HTMLElement | null) => {
    ref.current = element;
  }, []);
  const [flash, setFlash] = useState(false);
  const targeted = !searching && jump?.target === id;
  const consume = jump?.consume;
  useEffect(() => {
    if (!targeted || !consume) return;
    consume();
    ref.current?.scrollIntoView({
      block: "center",
      behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
    });
    setFlash(true);
  }, [targeted, consume]);
  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => setFlash(false), 1800);
    return () => clearTimeout(timer);
  }, [flash]);
  return { ref: setRef, flash };
}
