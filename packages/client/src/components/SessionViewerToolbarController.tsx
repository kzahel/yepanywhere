import type { CSSProperties, RefObject } from "react";
import { useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { useI18n } from "../i18n";
import { writeClipboardText } from "../lib/clipboard";
import type { SessionViewerControllerState } from "../lib/sessionViewerController";
import styles from "./SessionViewerToolbarController.module.css";
import { ButtonBase } from "./ui/Button";

type ToolbarTranslate = ReturnType<typeof useI18n>["t"];

export interface SessionViewerToolbarControllerProps {
  controller: SessionViewerControllerState;
  t: ToolbarTranslate;
  waveformButtonBackgroundOpacityPercent?: number;
}

function useToolbarPortalPosition(minimized: boolean): {
  slotRef: RefObject<HTMLSpanElement | null>;
  floatingRef: RefObject<HTMLDivElement | null>;
} {
  const slotRef = useRef<HTMLSpanElement | null>(null);
  const floatingRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const slot = slotRef.current;
    const floating = floatingRef.current;
    if (!slot || !floating || typeof window === "undefined") return;

    floating.dataset.fileViewerState = minimized ? "parked" : "open";
    let frameId = 0;
    const updatePosition = () => {
      frameId = 0;
      const rect = slot.getBoundingClientRect();
      floating.style.left = `${rect.left}px`;
      floating.style.top = `${rect.top}px`;
      floating.style.width = `${rect.width}px`;
      floating.style.height = `${rect.height}px`;
    };
    const schedulePositionUpdate = () => {
      window.cancelAnimationFrame(frameId);
      frameId = window.requestAnimationFrame(updatePosition);
    };
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(schedulePositionUpdate);
    resizeObserver?.observe(slot);
    window.addEventListener("resize", schedulePositionUpdate);
    window.visualViewport?.addEventListener("resize", schedulePositionUpdate);
    window.visualViewport?.addEventListener("scroll", schedulePositionUpdate);
    updatePosition();

    return () => {
      window.cancelAnimationFrame(frameId);
      resizeObserver?.disconnect();
      window.removeEventListener("resize", schedulePositionUpdate);
      window.visualViewport?.removeEventListener(
        "resize",
        schedulePositionUpdate,
      );
      window.visualViewport?.removeEventListener(
        "scroll",
        schedulePositionUpdate,
      );
    };
  }, [minimized]);

  return { slotRef, floatingRef };
}

function FileViewerRestoreIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 3.5h10v9H3z" />
      <path d="M5.5 6.5L8 4l2.5 2.5M8 4v5" />
    </svg>
  );
}

function FileViewerMinimizeIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M3 11.5h10" />
    </svg>
  );
}

function FileViewerCloseIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

export function SessionViewerToolbarController({
  controller,
  t,
  waveformButtonBackgroundOpacityPercent,
}: SessionViewerToolbarControllerProps) {
  const { slotRef, floatingRef } = useToolbarPortalPosition(
    controller.minimized,
  );
  const location = controller.label;
  const closeAction = controller.closeAction;
  const closeLabel = closeAction
    ? t(closeAction.label, { name: location })
    : "";
  const fullLocation =
    controller.kind === "file" ? controller.filePath : location;
  const briefLocation =
    controller.kind === "file"
      ? `…/${controller.briefLabel ?? controller.filePath}`
      : (controller.briefLabel ?? location);
  const toggleLabel = controller.minimized
    ? t(
        controller.kind === "file"
          ? "fileViewerRestore"
          : "sessionViewerRestore",
        { name: location },
      )
    : t(
        controller.kind === "file"
          ? "fileViewerMinimizeNamed"
          : "sessionViewerMinimizeNamed",
        { name: location },
      );
  const control = (
    <div
      ref={floatingRef}
      className={`${styles.controller} ${
        controller.minimized ? styles.parked : ""
      }${
        waveformButtonBackgroundOpacityPercent === undefined
          ? ""
          : ` ${styles.waveformActive}`
      }`}
      style={
        waveformButtonBackgroundOpacityPercent === undefined
          ? undefined
          : ({
              "--waveform-control-surface-opacity": `${waveformButtonBackgroundOpacityPercent}%`,
            } as CSSProperties)
      }
      role="group"
      aria-label={t(
        controller.kind === "file"
          ? "fileViewerController"
          : "sessionViewerController",
        { name: location },
      )}
    >
      <ButtonBase
        className={styles.toggle}
        onClick={
          controller.minimized ? controller.restore : controller.minimize
        }
        onContextMenu={
          controller.kind === "file"
            ? (event) => {
                event.preventDefault();
                void writeClipboardText(controller.filePath);
              }
            : undefined
        }
        title={toggleLabel}
        aria-label={toggleLabel}
      >
        {controller.minimized ? (
          <FileViewerRestoreIcon />
        ) : (
          <FileViewerMinimizeIcon />
        )}
        <span className={styles.location} aria-hidden="true">
          <span className={styles.path}>
            <bdi>{fullLocation}</bdi>
          </span>
          <span className={styles.briefPath}>
            <bdi>{briefLocation}</bdi>
          </span>
          {controller.kind === "file" && controller.lineSuffix && (
            <span className={styles.line}>{controller.lineSuffix}</span>
          )}
        </span>
      </ButtonBase>
      {closeAction && (
        <ButtonBase
          className={`${styles.close} ${closeAction.destructive ? styles.kill : ""}`}
          disabled={closeAction.busy}
          onClick={closeAction.run}
          title={closeLabel}
          aria-label={closeLabel}
        >
          <FileViewerCloseIcon />
        </ButtonBase>
      )}
    </div>
  );

  return (
    <>
      <span
        ref={slotRef}
        className={styles.slot}
        data-file-viewer-controller-slot="true"
        aria-hidden="true"
      />
      {typeof document === "undefined"
        ? null
        : createPortal(control, document.body)}
    </>
  );
}
