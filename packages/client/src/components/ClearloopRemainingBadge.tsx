import {
  type SessionClearloopBadge,
  formatDurationSeconds,
} from "@yep-anywhere/shared";
import { useI18n } from "../i18n";
import {
  type SourceContextMenuAction,
  useSourceContextMenu,
} from "./SourceContextMenu";
import { ButtonBase } from "./ui/Button";
import styles from "./ClearloopRemainingBadge.module.css";

export interface ClearloopBadgeControls {
  /** Cancel: the current turn finishes and no further rewind happens. */
  onCancel: () => void;
  /** Turn the wait for project idleness on or off for the next boundary. */
  onSetPatient: (patient: boolean) => void;
  /** End the current iteration now, skipping the window and any wait. */
  onStartNow: () => void;
}

/**
 * Count of `/clearloop` iterations still to run, shown beside a session's
 * title in the sidebar, the Agents view, and the session header
 * (topics/session-rewind.md). Green while the loop waits only on this
 * session's inactivity window, purple while it is patient and also waits for
 * the project to go idle. Its tooltip states the loop's contract.
 *
 * With `controls` it is the header's live control: click cancels, and
 * right-click (or long-press, or the context-menu key) offers Stop, the
 * patience toggle, and Start now.
 */
export function ClearloopRemainingBadge({
  badge,
  controls,
}: {
  badge: SessionClearloopBadge;
  controls?: ClearloopBadgeControls;
}) {
  const { t } = useI18n();
  const menu = useSourceContextMenu(t, {
    dismiss: t("clearloopMenuDismiss"),
    menu: t("clearloopMenu"),
  });
  const contract = t(
    badge.patient ? "clearloopBadgeContractPatient" : "clearloopBadgeContract",
    {
      remaining: String(badge.remaining),
      total: String(badge.total),
      window:
        badge.windowSeconds !== undefined
          ? formatDurationSeconds(badge.windowSeconds)
          : t("clearloopBadgeWindowUnknown"),
      index: String(badge.cutTurnIndex),
      prompt: badge.prompt,
    },
  );
  const className = `${styles.badge}${badge.patient ? ` ${styles.patient}` : ""}`;

  if (!controls) {
    return (
      <span
        className={className}
        role="img"
        aria-label={contract}
        title={contract}
      >
        {badge.remaining}
      </span>
    );
  }

  const actions: SourceContextMenuAction[] = [
    { label: t("clearloopMenuStop"), onSelect: controls.onCancel },
    badge.patient
      ? {
          label: t("clearloopMenuImpatient"),
          onSelect: () => controls.onSetPatient(false),
        }
      : {
          label: t("clearloopMenuPatient"),
          onSelect: () => controls.onSetPatient(true),
        },
    { label: t("clearloopMenuStartNow"), onSelect: controls.onStartNow },
  ];
  const label = `${contract} ${t("clearloopRemainingBadgeCancelHint")}`;
  const targetProps = menu.targetProps(actions, controls.onCancel);
  return (
    <>
      <ButtonBase
        className={`${className} ${styles.cancelable}`}
        aria-label={label}
        title={label}
        {...targetProps}
        onClick={(event) => {
          event.stopPropagation();
          targetProps.onClick();
        }}
        onContextMenu={(event) => {
          event.stopPropagation();
          targetProps.onContextMenu(event);
        }}
      >
        {badge.remaining}
      </ButtonBase>
      {menu.menu}
    </>
  );
}
