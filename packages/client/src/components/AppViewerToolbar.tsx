import {
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import { useI18n } from "../i18n";
import { Banner } from "./ui/Banner";
import { IconButton } from "./ui/Button";
import actions from "./ViewerWindowActions.module.css";
import styles from "./AppViewerToolbar.module.css";

/** Compact app controls that can fold into either top corner without reloading the app. */
export function AppViewerToolbar({
  viewerRef,
  children,
}: {
  viewerRef: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const [corner, setCorner] = useState<"left" | "right" | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [error, setError] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const gesture = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const changed = () =>
      setFullscreen(document.fullscreenElement === viewerRef.current);
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, [viewerRef]);
  function collapse(side: "left" | "right") {
    setCorner(side);
    toggle.current?.focus({ preventScroll: true });
  }
  async function toggleFullscreen() {
    setError(false);
    try {
      if (document.fullscreenElement === viewerRef.current) {
        await document.exitFullscreen();
      } else {
        await viewerRef.current?.requestFullscreen({ navigationUI: "hide" });
      }
    } catch {
      setError(true);
    }
  }
  const label = t(corner ? "appToolbarShow" : "appToolbarHide");
  return (
    <header
      className={`${styles.header} ${corner ? styles.floating : ""}`}
      data-corner={corner ?? undefined}
      onPointerDown={(event) => {
        if ((event.target as Element).closest("button, a, input, select"))
          return;
        gesture.current = { x: event.clientX, y: event.clientY };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerUp={(event) => {
        const start = gesture.current;
        gesture.current = null;
        if (!start) return;
        const dx = event.clientX - start.x;
        const dy = event.clientY - start.y;
        if (Math.abs(dx) >= 40 && Math.abs(dx) > Math.abs(dy) * 2) {
          collapse(dx < 0 ? "left" : "right");
        }
      }}
      onPointerCancel={() => {
        gesture.current = null;
      }}
    >
      <div className={styles.content} hidden={!!corner}>
        {children}
      </div>
      <div className={actions.actions}>
        {!corner && document.fullscreenEnabled && (
          <IconButton
            onClick={() => void toggleFullscreen()}
            label={t(fullscreen ? "appFullscreenExit" : "appFullscreenEnter")}
            aria-pressed={fullscreen}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              aria-hidden="true"
            >
              <path
                d={
                  fullscreen
                    ? "M4 9h5V4M20 9h-5V4M4 15h5v5M20 15h-5v5"
                    : "M9 4H4v5M15 4h5v5M4 15v5h5M20 15v5h-5"
                }
              />
            </svg>
          </IconButton>
        )}
        <IconButton
          ref={toggle}
          label={label}
          aria-expanded={!corner}
          onClick={() => (corner ? setCorner(null) : collapse("right"))}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            aria-hidden="true"
          >
            <path
              d={corner ? "M4 6h16M4 12h16M4 18h16" : "M4 8h16M8 15l4-4 4 4"}
            />
          </svg>
        </IconButton>
      </div>
      {error && (
        <Banner tone="error" compact className={styles.failure}>
          {t("appFullscreenFailed")}
        </Banner>
      )}
    </header>
  );
}
