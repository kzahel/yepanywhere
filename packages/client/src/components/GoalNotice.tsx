import { useState } from "react";
import { useI18n } from "../i18n";
import { useTextTooltipAttributes } from "../hooks/useTooltipAppearance";
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
    <div className={styles.notice} title={status}>
      <strong className={styles.label}>{t("goalNoticeLabel")}</strong>
      <span className={styles.objective}>
        <LinkifiedText text={objective} />
      </span>
    </div>
  );
}

export function GoalFlag({
  objective,
  status,
  onToggle,
  onEdit,
}: {
  objective: string;
  status?: string | null;
  onToggle?: (action: "pause" | "resume") => Promise<unknown>;
  onEdit?: () => void;
}) {
  const { t } = useI18n();
  const [pending, setPending] = useState(false);
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
      pending
        ? t("goalFlagUpdating")
        : onToggle && action
          ? t(action === "pause" ? "goalFlagPauseHint" : "goalFlagResumeHint")
          : undefined,
    ]
      .filter(Boolean)
      .join("\n\n"),
  );
  return (
    <button
      type="button"
      className={styles.flag}
      {...tooltip}
      aria-label={t("goalFlagLabel", { objective })}
      data-goal-status={status ?? undefined}
      aria-busy={pending}
      aria-disabled={pending}
      onClick={async () => {
        if (pending || !action || !onToggle) return;
        setPending(true);
        try {
          await onToggle(action);
        } finally {
          setPending(false);
        }
      }}
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
    </button>
  );
}
