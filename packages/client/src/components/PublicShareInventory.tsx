import type { PublicSessionShareMode } from "@yep-anywhere/shared";
import type { ReactNode } from "react";
import styles from "./PublicShareInventory.module.css";
import { IconButton } from "./ui/Button";

export interface PublicShareRowAction {
  disabled?: boolean;
  label: string;
  onClick: () => void;
  working?: boolean;
}

interface PublicShareInventoryListProps {
  children: ReactNode;
  compact?: boolean;
}

interface PublicShareInventoryRowProps {
  children: ReactNode;
  copyAction: PublicShareRowAction;
  freezeAction?: PublicShareRowAction;
  highlighted?: boolean;
  mode: PublicSessionShareMode;
  modeLabel: string;
  revokeAction: PublicShareRowAction;
  title: string;
  warning?: string;
}

export function PublicShareInventoryList({
  children,
  compact = false,
}: PublicShareInventoryListProps) {
  return (
    <div
      className={`${styles.list} ${compact ? styles.listCompact : ""}`}
      role="list"
    >
      {children}
    </div>
  );
}

export function PublicShareInventoryRow({
  children,
  copyAction,
  freezeAction,
  highlighted = false,
  mode,
  modeLabel,
  revokeAction,
  title,
  warning,
}: PublicShareInventoryRowProps) {
  return (
    <div
      className={`${styles.row} ${highlighted ? styles.rowHighlighted : ""}`}
      role="listitem"
    >
      <div className={styles.rowMain}>
        <strong>{title}</strong>
        {children}
        {warning && <span className={styles.warning}>{warning}</span>}
      </div>
      <div className={styles.rowActions}>
        <span
          className={`${styles.rowTypeIcon} ${
            mode === "live" ? styles.rowTypeIconLive : ""
          }`}
          title={modeLabel}
          aria-label={modeLabel}
          role="img"
        >
          <PublicShareFilterIcon kind={mode} />
        </span>
        <IconButton
          label={copyAction.label}
          variant="secondary"
          size="small"
          disabled={copyAction.disabled}
          onClick={copyAction.onClick}
        >
          {copyAction.working ? "…" : <CopyIcon />}
        </IconButton>
        {freezeAction && (
          <IconButton
            label={freezeAction.label}
            variant="secondary"
            size="small"
            className={styles.iconButtonFreeze}
            disabled={freezeAction.disabled}
            onClick={freezeAction.onClick}
          >
            {freezeAction.working ? "…" : <PublicShareFreezeIcon />}
          </IconButton>
        )}
        <IconButton
          label={revokeAction.label}
          variant="danger-outline"
          size="small"
          className={styles.iconButtonDanger}
          disabled={revokeAction.disabled}
          onClick={revokeAction.onClick}
        >
          {revokeAction.working ? "…" : <PublicShareRevokeIcon />}
        </IconButton>
      </div>
    </div>
  );
}

export function PublicShareInventoryMeta({
  children,
}: {
  children: ReactNode;
}) {
  return <span className={styles.rowMeta}>{children}</span>;
}

export function PublicShareInventoryEmpty({
  children,
  loading = false,
}: {
  children: ReactNode;
  loading?: boolean;
}) {
  return (
    <div className={styles.empty} role={loading ? "status" : undefined}>
      {children}
    </div>
  );
}

export function PublicShareInventoryCount({
  children,
}: {
  children: ReactNode;
}) {
  return <div className={styles.count}>{children}</div>;
}

export function PublicShareFeedback({
  children,
  tone,
}: {
  children: ReactNode;
  tone: "error" | "notice";
}) {
  return (
    <div
      className={tone === "error" ? styles.error : styles.notice}
      role={tone === "error" ? "alert" : "status"}
    >
      {children}
    </div>
  );
}

export function PublicSharePlusIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}

export function PublicShareRevokeIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.25"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="m4 4 8 8M12 4l-8 8" />
    </svg>
  );
}

export function PublicShareFreezeIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="7" width="10" height="7" rx="1.5" />
      <path d="M5.5 7V4.75a2.5 2.5 0 0 1 5 0V7M8 10v1.5" />
    </svg>
  );
}

export function PublicShareConfirmIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m3 8.5 3.2 3.2L13 4.8" />
    </svg>
  );
}

export function PublicShareFilterIcon({
  kind,
}: {
  kind: "all" | "project" | "session" | PublicSessionShareMode;
}) {
  const paths = {
    all: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18M12 3c3 3.2 3 14.8 0 18M12 3c-3 3.2-3 14.8 0 18" />
      </>
    ),
    project: <path d="M3 6.5h7l2 2h9v10.5H3zM3 6.5V5h7l2 2" />,
    session: (
      <>
        <rect x="3" y="4" width="18" height="14" rx="3" />
        <path d="m8 21 4-3h5M7 9h10M7 13h7" />
      </>
    ),
    frozen: (
      <>
        <rect x="5" y="10" width="14" height="11" rx="2" />
        <path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" />
      </>
    ),
    live: (
      <>
        <circle cx="12" cy="12" r="2" fill="currentColor" stroke="none" />
        <path d="M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7M5.5 5.5a9 9 0 0 0 0 13M18.5 5.5a9 9 0 0 1 0 13" />
      </>
    ),
  };
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[kind]}
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="5" y="5" width="9" height="9" rx="1.5" />
      <path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2H3.5A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" />
    </svg>
  );
}
