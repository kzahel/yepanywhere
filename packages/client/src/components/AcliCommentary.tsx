import { Fragment, memo, useCallback, useId, useRef, useState } from "react";
import { useTooltipTrigger } from "../hooks/useTooltipTrigger";
import { useI18n } from "../i18n";
import type { PresentedCommentary } from "../lib/acliToolOutput";
import { TextBlock } from "./blocks/TextBlock";
import { ButtonBase, IconButton } from "./ui/Button";
import { Popover } from "./ui/Popover";
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
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [context, setContext] = useState("");
  const changeOpen = useCallback(
    (next: boolean) => {
      if (!item.getContext || (pinned && !next)) return;
      if (next) setContext(item.getContext());
      setOpen(next);
    },
    [item, pinned],
  );
  const trigger = useTooltipTrigger({ open, onOpenChange: changeOpen });
  const close = useCallback(() => {
    setPinned(false);
    setOpen(false);
  }, []);

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
      <Popover
        open={open}
        onClose={close}
        anchorRef={button}
        placement="bottom-start"
        offset={6}
        id={id}
        surface="card"
        className={styles.context}
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
      </Popover>
    </>
  );
}
