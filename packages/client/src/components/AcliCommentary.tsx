import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useTooltipTrigger } from "../hooks/useTooltipTrigger";
import { useI18n } from "../i18n";
import type { PresentedCommentary } from "../lib/acliToolOutput";
import { TextBlock } from "./blocks/TextBlock";
import { ButtonBase, IconButton } from "./ui/Button";
import { WorkflowBoundary, WorkflowContext } from "./WorkflowOutput";
import styles from "./AcliCommentary.module.css";

export const AcliCommentary = memo(function AcliCommentary({
  items,
  command,
  onOpenOutput,
}: {
  items: readonly PresentedCommentary[];
  command: string;
  onOpenOutput: () => void;
}) {
  return items.map((item) =>
    item.segments ? (
      <Fragment key={item.id}>
        {item.segments.length && !item.segments[0]?.marker ? (
          <WorkflowContext
            workflow={{ markers: [], parent: item.workflow?.parent }}
          />
        ) : null}
        {item.segments.map((segment, index) => (
          <Fragment key={index}>
            {segment.marker ? (
              <WorkflowBoundary marker={segment.marker} />
            ) : null}
            {segment.text.trim() || segment.marker ? (
              <TextBlock
                text={segment.text}
                augmentHtml={segment.html}
                timelineAction={
                  <ContextBullet
                    item={item}
                    command={command}
                    onOpenOutput={onOpenOutput}
                  />
                }
              />
            ) : null}
          </Fragment>
        ))}
      </Fragment>
    ) : (
      <TextBlock
        key={item.id}
        text={item.text}
        augmentHtml={item.html}
        timelineAction={
          <ContextBullet
            item={item}
            command={command}
            onOpenOutput={onOpenOutput}
          />
        }
      />
    ),
  );
});

function ContextBullet({
  item,
  command,
  onOpenOutput,
}: {
  item: PresentedCommentary;
  command: string;
  onOpenOutput: () => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [context, setContext] = useState("");
  const [position, setPosition] = useState({ left: 8, top: 8, maxHeight: 320 });
  const changeOpen = useCallback(
    (next: boolean) => {
      if (!item.getContext || (pinned && !next)) return;
      if (next) {
        setContext(item.getContext());
        const rect = button.current?.getBoundingClientRect();
        if (rect) {
          const width = Math.min(480, window.innerWidth - 16);
          const top = Math.max(
            8,
            Math.min(rect.bottom + 6, window.innerHeight * 0.55),
          );
          setPosition({
            left: Math.max(
              8,
              Math.min(rect.left, window.innerWidth - width - 8),
            ),
            top,
            maxHeight: window.innerHeight - top - 8,
          });
        }
      }
      setOpen(next);
    },
    [item, pinned],
  );
  const trigger = useTooltipTrigger({ open, onOpenChange: changeOpen });
  const close = useCallback(() => {
    setPinned(false);
    setOpen(false);
  }, []);

  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => {
      if (
        event.target instanceof Node &&
        (popup.current?.contains(event.target) ||
          button.current?.contains(event.target))
      )
        return;
      close();
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
        button.current?.focus();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("scroll", outside, true);
    document.addEventListener("keydown", keydown);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("scroll", outside, true);
      document.removeEventListener("keydown", keydown);
      window.removeEventListener("resize", close);
    };
  }, [open, close]);

  return (
    <>
      <ButtonBase
        ref={button}
        className={styles.bullet}
        aria-label={t(
          item.getContext ? "acliCommentaryContext" : "acliCommentaryOutput",
        )}
        aria-expanded={item.getContext ? open : undefined}
        aria-controls={open ? id : undefined}
        title={item.getContext ? undefined : command}
        onPointerEnter={trigger.onPointerEnter}
        onPointerMove={trigger.onPointerMove}
        onPointerLeave={trigger.onPointerLeave}
        onFocus={trigger.onFocus}
        onBlur={trigger.onBlur}
        onClick={() => {
          if (!item.getContext) {
            onOpenOutput();
            return;
          }
          if (pinned) close();
          else {
            changeOpen(true);
            setPinned(true);
          }
        }}
      />
      {open
        ? createPortal(
            <div
              ref={popup}
              id={id}
              className={styles.context}
              style={position}
              role="dialog"
              aria-label={t("acliCommentaryContext")}
            >
              <IconButton
                size="small"
                className={styles.close}
                onClick={close}
                label={t("acliCommentaryCloseContext")}
              >
                ×
              </IconButton>
              <pre>{context}</pre>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
