import {
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n";
import { readComposerHistory } from "../lib/composerHistory";
import { replaceTextareaRangeUndoably } from "../lib/composerTextarea";
import { textareaDropCaret } from "../lib/textareaDropCaret";
import { useComposerPromptRail } from "../hooks/useComposerPromptRail";
import styles from "./PromptHistoryRail.module.css";
import { ButtonBase } from "./ui/Button";

interface PromptHistoryRailProps {
  scope: string | null;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onChange: (value: string) => void;
  children: ReactNode;
}

/**
 * Wrap `value` so text inserted at `offset` occupies its own line(s): a
 * newline separates it from any text before or after on the same line.
 */
export function lineIsolatedInsertion(
  value: string,
  offset: number,
  text: string,
): string {
  const before = value.slice(0, offset);
  const after = value.slice(offset);
  const lead = before && !before.endsWith("\n") ? "\n" : "";
  const trail = after && !after.startsWith("\n") ? "\n" : "";
  return `${lead}${text}${trail}`;
}

/** The rail is an opt-in Appearance setting; off, the composer is bare. */
export function PromptHistoryRail(props: PromptHistoryRailProps) {
  const { composerPromptRailEnabled } = useComposerPromptRail();
  if (!composerPromptRailEnabled) return <>{props.children}</>;
  return <EnabledPromptHistoryRail {...props} />;
}

function EnabledPromptHistoryRail({
  scope,
  textareaRef,
  onChange,
  children,
}: PromptHistoryRailProps) {
  const { t } = useI18n();
  const id = useId();
  const [history, setHistory] = useState<{
    scope: string;
    prompts: { text: string; at: number }[];
  } | null>(null);
  const [error, setError] = useState(false);
  const [preview, setPreview] = useState<{
    text: string;
    x: number;
    y: number;
    dragging: boolean;
  } | null>(null);
  const [caret, setCaret] =
    useState<ReturnType<typeof textareaDropCaret>>(null);
  const gesture = useRef<{
    pointer: number;
    x: number;
    y: number;
    text: string;
    dragging: boolean;
  } | null>(null);
  useEffect(() => {
    let active = true;
    setPreview(null);
    setCaret(null);
    gesture.current = null;
    setError(false);
    if (scope)
      void readComposerHistory(scope)
        .then((value) => {
          if (active) setHistory({ scope, prompts: value.prompts });
        })
        .catch(() => {
          if (active) setError(true);
        });
    return () => {
      active = false;
    };
  }, [scope]);
  useEffect(() => {
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        gesture.current = null;
        setPreview(null);
        setCaret(null);
      }
    };
    window.addEventListener("keydown", dismiss);
    return () => window.removeEventListener("keydown", dismiss);
  }, []);
  function cancel() {
    gesture.current = null;
    setPreview(null);
    setCaret(null);
  }
  function insert(text: string, offset: number) {
    const textarea = textareaRef.current;
    if (!textarea || textarea.disabled || textarea.readOnly) return;
    replaceTextareaRangeUndoably(
      textarea,
      offset,
      offset,
      lineIsolatedInsertion(textarea.value, offset, text),
    );
    onChange(textarea.value);
    cancel();
  }
  function show(text: string, node: HTMLElement) {
    const bounds = node.getBoundingClientRect();
    setPreview({ text, x: bounds.right + 6, y: bounds.top, dragging: false });
  }
  const prompts = history?.scope === scope ? history.prompts : [];
  const scale = preview?.dragging ? 0.5 : 1;
  const width = Math.min(360, window.innerWidth - 16);
  return (
    <div className={styles.composer}>
      <div
        className={styles.rail}
        role="group"
        aria-label={t("promptHistoryLabel")}
      >
        {prompts.map((item, index) => (
          <ButtonBase
            key={item.text}
            className={styles.target}
            aria-label={t("promptHistoryItem", { number: index + 1 })}
            aria-describedby={preview?.text === item.text ? id : undefined}
            onPointerEnter={(event) => {
              if (!gesture.current && event.pointerType === "mouse")
                show(item.text, event.currentTarget);
            }}
            onPointerLeave={() => {
              if (!gesture.current) setPreview(null);
            }}
            onFocus={(event) => show(item.text, event.currentTarget)}
            onBlur={() => {
              if (!gesture.current) setPreview(null);
            }}
            onPointerDown={(event) => {
              if (!event.isPrimary || event.button !== 0) return;
              event.preventDefault();
              event.currentTarget.setPointerCapture(event.pointerId);
              gesture.current = {
                pointer: event.pointerId,
                x: event.clientX,
                y: event.clientY,
                text: item.text,
                dragging: false,
              };
              show(item.text, event.currentTarget);
            }}
            onPointerMove={(event) => {
              const current = gesture.current;
              if (!current || current.pointer !== event.pointerId) return;
              current.dragging ||=
                Math.hypot(
                  event.clientX - current.x,
                  event.clientY - current.y,
                ) > 6;
              if (!current.dragging) return;
              setPreview({
                text: current.text,
                x: event.clientX + 16,
                y: event.clientY + 18,
                dragging: true,
              });
              setCaret(
                textareaRef.current
                  ? textareaDropCaret(
                      textareaRef.current,
                      event.clientX,
                      event.clientY,
                    )
                  : null,
              );
            }}
            onPointerUp={(event) => {
              const current = gesture.current;
              if (!current || current.pointer !== event.pointerId) return;
              const drop =
                current.dragging && textareaRef.current
                  ? textareaDropCaret(
                      textareaRef.current,
                      event.clientX,
                      event.clientY,
                    )
                  : null;
              if (drop) insert(current.text, drop.offset);
              else cancel();
            }}
            onPointerCancel={cancel}
            onLostPointerCapture={cancel}
            onKeyDown={(event) => {
              if (event.key === "Escape") cancel();
            }}
            onClick={(event) => {
              // Keyboard activation inserts at the saved caret; a pointer press only previews.
              if (event.detail === 0 && textareaRef.current)
                insert(item.text, textareaRef.current.selectionStart);
            }}
          >
            <span aria-hidden="true" />
          </ButtonBase>
        ))}
      </div>
      {children}
      {error && <small role="status">{t("promptHistoryError")}</small>}
      {preview &&
        createPortal(
          <div
            id={id}
            role="tooltip"
            className={styles.preview}
            style={{
              width,
              left: Math.max(
                8,
                Math.min(preview.x, window.innerWidth - width * scale - 8),
              ),
              top: Math.max(
                8,
                Math.min(preview.y, window.innerHeight - 180 * scale - 8),
              ),
              transform: `scale(${scale})`,
            }}
          >
            {preview.text}
          </div>,
          document.body,
        )}
      {caret &&
        createPortal(
          <div
            className={styles.caret}
            data-prompt-drop-caret
            aria-hidden="true"
            style={{ left: caret.x, top: caret.y, height: caret.height }}
          />,
          document.body,
        )}
    </div>
  );
}
