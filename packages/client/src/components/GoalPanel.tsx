import {
  type CSSProperties,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n";
import { Banner } from "./ui/Banner";
import { Button, IconButton } from "./ui/Button";
import { Field, Textarea } from "./ui/Field";
import { LinkifiedText } from "./ui/LinkifiedText";
import { CopyTextButton } from "./ui/CopyTextButton";
import { useModalBackGesture, useModalLayer } from "./ui/Modal";
import styles from "./GoalPanel.module.css";

export function GoalPanel({
  id,
  objective,
  statusLabel,
  action,
  triggerRef,
  onCommand,
  onClose,
}: {
  id: string;
  objective: string;
  statusLabel?: string;
  action?: "pause" | "resume";
  triggerRef: RefObject<HTMLButtonElement | null>;
  onCommand?: (argument: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [failed, setFailed] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({});
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const overlayPress = useRef(false);
  useModalLayer(onClose);
  useModalBackGesture(onClose);

  useLayoutEffect(() => {
    const place = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = window.visualViewport?.width ?? window.innerWidth;
      const height = window.visualViewport?.height ?? window.innerHeight;
      const top = Math.min(rect.bottom + 8, height - 200);
      setPosition({
        "--goal-panel-top": `${Math.max(8, top)}px`,
        "--goal-panel-left": `${Math.max(8, Math.min(rect.left, width - 436))}px`,
      } as CSSProperties);
    };
    place();
    window.addEventListener("resize", place);
    window.visualViewport?.addEventListener("resize", place);
    return () => {
      window.removeEventListener("resize", place);
      window.visualViewport?.removeEventListener("resize", place);
    };
  }, [triggerRef]);

  useEffect(() => {
    const trigger = triggerRef.current;
    return () => trigger?.focus({ preventScroll: true });
  }, [triggerRef]);

  useEffect(() => {
    (editing ? editorRef.current : closeRef.current)?.focus({
      preventScroll: true,
    });
  }, [editing]);

  const runCommand = async (argument: string) => {
    if (!onCommand || pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setFailed(false);
    try {
      if (await onCommand(argument)) {
        if (argument === "clear") onClose();
        setEditing(false);
      } else setFailed(true);
    } catch {
      setFailed(true);
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };

  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: pointer backdrop dismissal; Escape is owned by useModalLayer
    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard dismissal is handled by useModalLayer
    <div
      className={styles.overlay}
      onMouseDown={(event) => {
        overlayPress.current = event.target === event.currentTarget;
        event.stopPropagation();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && overlayPress.current)
          onClose();
        overlayPress.current = false;
        event.stopPropagation();
      }}
    >
      <div
        id={id}
        ref={panelRef}
        className={styles.panel}
        style={position}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-busy={pending}
        onKeyDown={(event) => {
          if (event.key !== "Tab") return;
          const controls = panelRef.current?.querySelectorAll<HTMLElement>(
            "button:not(:disabled), textarea:not(:disabled), a[href]",
          );
          const first = controls?.[0];
          const last = controls?.[controls.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }}
      >
        <div className={styles.header}>
          <div>
            <h2 id={`${id}-title`} className={styles.title}>
              {t("goalPanelTitle")}
            </h2>
            <span className={styles.status} role="status">
              {statusLabel ?? t("goalStatusUnknown")}
            </span>
          </div>
          <div className={styles.headerActions}>
            <CopyTextButton
              text={objective}
              label={t("goalPanelCopy")}
              copiedLabel={t("goalPanelCopied")}
              variant="ghost"
              size="default"
            />
            <IconButton
              ref={closeRef}
              label={t("modalClose")}
              onClick={onClose}
            >
              ×
            </IconButton>
          </div>
        </div>
        <div className={styles.body}>
          {editing ? (
            <Field label={t("goalPanelObjective")}>
              <Textarea
                ref={editorRef}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                disabled={pending}
                rows={8}
              />
            </Field>
          ) : (
            <div className={styles.objective}>
              <LinkifiedText text={objective} />
            </div>
          )}
          {action && !editing && (
            <p className={styles.hint}>
              {t(
                action === "pause"
                  ? "goalPanelPauseHint"
                  : "goalPanelResumeHint",
              )}
            </p>
          )}
          {failed && (
            <Banner tone="error" compact>
              {t("goalPanelFailed")}
            </Banner>
          )}
        </div>
        {onCommand && (
          <div className={styles.actions}>
            {editing ? (
              <>
                <Button disabled={pending} onClick={() => setEditing(false)}>
                  {t("goalPanelCancel")}
                </Button>
                <Button
                  variant="primary"
                  disabled={
                    pending || !draft.trim() || draft.trim() === objective
                  }
                  onClick={() => void runCommand(draft.trim())}
                >
                  {t("goalPanelSave")}
                </Button>
              </>
            ) : (
              <>
                <Button
                  disabled={pending}
                  onClick={() => {
                    setDraft(objective);
                    setEditing(true);
                    setFailed(false);
                  }}
                >
                  {t("goalPanelEdit")}
                </Button>
                <Button
                  disabled={pending}
                  onClick={() => void runCommand("clear")}
                >
                  {t("goalPanelClear")}
                </Button>
                {action && (
                  <Button
                    variant="primary"
                    disabled={pending}
                    onClick={() => void runCommand(action)}
                  >
                    {t(
                      action === "pause" ? "goalPanelPause" : "goalPanelResume",
                    )}
                  </Button>
                )}
              </>
            )}
            {pending && <span role="status">{t("goalFlagUpdating")}</span>}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
