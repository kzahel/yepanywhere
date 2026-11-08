import { useId, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { useTextTooltipAttributes } from "../hooks/useTooltipAppearance";
import { GoalPanel } from "./GoalPanel";
import { ButtonBase } from "./ui/Button";
import { LinkifiedText } from "./ui/LinkifiedText";
import styles from "./GoalNotice.module.css";

export function GoalNotice({
  objective,
  status,
}: {
  objective: string;
  status?: string;
}) {
  const { t } = useI18n();
  return (
    <div className={styles.notice}>
      <strong className={styles.label}>{status || t("goalNoticeLabel")}</strong>
      <span className={styles.objective}>
        <LinkifiedText text={objective} />
      </span>
    </div>
  );
}

export function GoalFlag({
  objective,
  status,
  onCommand,
  onEdit,
}: {
  objective: string;
  status?: string | null;
  onCommand?: (argument: string) => Promise<boolean>;
  onEdit?: () => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const action =
    status === "active"
      ? "pause"
      : status === "paused" || status === "blocked" || status === "usageLimited"
        ? "resume"
        : undefined;
  const statusLabels: Record<string, string> = {
    active: t("goalStatusActive"),
    paused: t("goalStatusPaused"),
    blocked: t("goalStatusBlocked"),
    usageLimited: t("goalStatusUsageLimited"),
    budgetLimited: t("goalStatusBudgetLimited"),
    complete: t("goalStatusComplete"),
  };
  const statusLabel = status ? (statusLabels[status] ?? status) : undefined;
  const tooltip = useTextTooltipAttributes(
    [
      statusLabel && t("goalFlagStatus", { status: statusLabel }),
      objective,
      t("goalFlagOpenHint"),
    ]
      .filter(Boolean)
      .join("\n\n"),
  );
  return (
    <>
      <ButtonBase
        ref={buttonRef}
        className={styles.flag}
        {...tooltip}
        aria-label={t("goalFlagLabel", { objective })}
        data-goal-status={status ?? undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((value) => !value)}
        onMouseDown={(event) => {
          if (event.button === 2) event.preventDefault();
        }}
        onContextMenu={onEdit}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          aria-hidden="true"
        >
          <path d="M5 21V4m0 0c5-5 9 5 14 0v10c-5 5-9-5-14 0" />
        </svg>
      </ButtonBase>
      {open && (
        <GoalPanel
          id={panelId}
          objective={objective}
          statusLabel={statusLabel}
          action={action}
          triggerRef={buttonRef}
          onCommand={onCommand}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
