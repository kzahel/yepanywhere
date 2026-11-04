import {
  type DragEvent,
  type HTMLAttributes,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useToastContext } from "../contexts/ToastContext";
import { useI18n } from "../i18n";
import styles from "./FileDropZone.module.css";

interface FileDropZoneProps extends HTMLAttributes<HTMLDivElement> {
  enabled: boolean;
  onFiles: (files: File[]) => void;
  newSession?: boolean;
  /** Retire a drag when the source, draft or session owner changes. */
  ownerKey: string;
}

function hasFiles(event: DragEvent) {
  return Array.from(event.dataTransfer.types).includes("Files");
}

/** File intake only; text/link dragging keeps its native browser behavior. */
export function FileDropZone({
  enabled,
  onFiles,
  newSession = false,
  ownerKey,
  children,
  ...props
}: FileDropZoneProps) {
  const { t } = useI18n();
  const { showToast } = useToastContext();
  const root = useRef<HTMLDivElement>(null);
  const depth = useRef(0);
  const [bounds, setBounds] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  const active = bounds !== null;
  // React events from portaled dialogs also bubble through this component.
  // Only the actual content surface owns file intake.
  const isSurfaceFileDrag = (event: DragEvent) =>
    hasFiles(event) && root.current?.contains(event.target as Node);

  const reset = useCallback(() => {
    depth.current = 0;
    setBounds(null);
  }, []);
  const measure = useCallback(() => {
    const rect = root.current?.getBoundingClientRect();
    if (!rect) return;
    const left = Math.max(8, rect.left - 8);
    const top = Math.max(8, rect.top - 8);
    const width = Math.max(0, Math.min(innerWidth - 8, rect.right + 8) - left);
    const height = Math.max(
      0,
      Math.min(innerHeight - 8, rect.bottom + 8) - top,
    );
    setBounds((previous) =>
      previous?.left === left &&
      previous.top === top &&
      previous.width === width &&
      previous.height === height
        ? previous
        : { left, top, width, height },
    );
  }, []);

  useEffect(() => {
    // An unchanged enabled value can still belong to a different draft.
    void enabled;
    void ownerKey;
    reset();
  }, [enabled, ownerKey, reset]);

  useEffect(() => {
    if (!active) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") reset();
    };
    window.addEventListener("blur", reset);
    window.addEventListener("dragend", reset);
    window.addEventListener("drop", reset, true);
    window.addEventListener("keydown", handleEscape);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("blur", reset);
      window.removeEventListener("dragend", reset);
      window.removeEventListener("drop", reset, true);
      window.removeEventListener("keydown", handleEscape);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [active, measure, reset]);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: File drops enhance the existing keyboard-accessible attachment chooser.
    <div
      {...props}
      ref={root}
      data-file-drop-surface="true"
      onDragEnter={(event) => {
        if (!isSurfaceFileDrag(event)) return;
        event.preventDefault();
        event.stopPropagation();
        if (enabled && depth.current++ === 0) measure();
      }}
      onDragOver={(event) => {
        if (!isSurfaceFileDrag(event)) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = enabled ? "copy" : "none";
      }}
      onDragLeave={(event) => {
        if (!isSurfaceFileDrag(event)) return;
        event.preventDefault();
        event.stopPropagation();
        if (--depth.current <= 0) reset();
      }}
      onDrop={(event) => {
        if (!isSurfaceFileDrag(event)) return;
        event.preventDefault();
        event.stopPropagation();
        reset();
        if (!enabled) return;
        const items = Array.from(event.dataTransfer.items);
        if (items.some((item) => item.webkitGetAsEntry?.()?.isDirectory)) {
          showToast(t("attachmentDropFolderError"), "error");
          return;
        }
        const files = Array.from(event.dataTransfer.files);
        if (files.length) onFiles(files);
      }}
    >
      {children}
      {enabled &&
        bounds &&
        createPortal(
          <div className={styles.overlay} style={bounds} role="status">
            <div className={styles.message}>
              <svg
                width="40"
                height="40"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <path d="M14 2v6h6M12 18v-7m-3 3 3-3 3 3" />
              </svg>
              <strong>{t("attachmentDropTitle")}</strong>
              <p>
                {t(
                  newSession
                    ? "attachmentDropNewSession"
                    : "attachmentDropSession",
                )}
              </p>
              <small>
                {t(
                  newSession
                    ? "attachmentDropNewSessionHint"
                    : "attachmentDropSessionHint",
                )}
              </small>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
