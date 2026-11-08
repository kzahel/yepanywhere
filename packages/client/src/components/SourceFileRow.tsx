import type { ReviewSiteStateSummary } from "@yep-anywhere/shared";
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";
import { useTextTooltipAttributes } from "../hooks/useTooltipAppearance";
import type { MessageKey, TranslationFn } from "../i18n";
import { findTextMatch } from "../lib/searchMatch";
import { SearchMatchText } from "./SearchMatchText";
import { ButtonBase } from "./ui/Button";
import styles from "./SourceFileRow.module.css";

type SourceFileRowButtonProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "title"
> & {
  path: string;
  children: ReactNode;
};

/**
 * The row button owns the complete path tooltip. This keeps native and themed
 * tooltips working even when the visible path child is ellipsized.
 */
export function SourceFileRowButton({
  path,
  children,
  ...buttonProps
}: SourceFileRowButtonProps) {
  const tooltipAttributes = useTextTooltipAttributes(path);

  return (
    <ButtonBase {...buttonProps} {...tooltipAttributes}>
      {children}
    </ButtonBase>
  );
}

export function SourceFilePath({
  children,
  query,
  fullPath,
  className,
  ...spanProps
}: HTMLAttributes<HTMLSpanElement> & {
  query?: string;
  fullPath?: string;
}) {
  const text = typeof children === "string" ? children : null;
  const pathClassName = [
    styles.path,
    text && findTextMatch(text, query) ? styles.pathWithMatch : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  if (!text) {
    return (
      <span {...spanProps} className={pathClassName}>
        {children}
      </span>
    );
  }

  return (
    <SearchMatchText
      {...spanProps}
      className={pathClassName}
      data-source-path={fullPath ?? text}
      text={text}
      query={query}
      wrapMatchOnNarrow
    />
  );
}

const STATUS_LABEL_KEYS: Record<string, MessageKey> = {
  M: "sourceFileStatusModified",
  A: "sourceFileStatusAdded",
  D: "sourceFileStatusDeleted",
  R: "sourceFileStatusRenamed",
  C: "sourceFileStatusCopied",
  T: "sourceFileStatusTypeChanged",
  U: "sourceFileStatusUnmerged",
  "?": "sourceFileStatusUntracked",
};

export function SourceFileStatusBadge({
  status,
  t,
}: {
  status: string;
  t: TranslationFn;
}) {
  const meaning = t(STATUS_LABEL_KEYS[status] ?? "sourceFileStatusChanged");
  const label = `${status} — ${meaning}`;
  const tooltipAttributes = useTextTooltipAttributes(label);

  return (
    <span
      className={`git-status-badge git-status-${status.toLowerCase()}`}
      role="img"
      aria-label={label}
      {...tooltipAttributes}
    >
      {status}
    </span>
  );
}

/** Independent discussion/source axes for unresolved sites on this file. */
export function SourceReviewStateBadges({
  states,
  t,
}: {
  states: ReviewSiteStateSummary[];
  t: TranslationFn;
}) {
  if (states.length === 0) return null;
  const open = states.filter((state) => state.state === "open").length;
  const addressed = states.length - open;
  const changed = states.filter(
    (state) => state.changeStatus === "changed",
  ).length;
  const unchanged = states.filter(
    (state) => state.changeStatus === "unchanged",
  ).length;
  const unavailable = states.length - changed - unchanged;
  const discussion =
    open > 0
      ? {
          label: t("sourceReviewStateOpen"),
          count: open,
          className: styles.open!,
        }
      : {
          label: t("sourceReviewStateAddressed"),
          count: addressed,
          className: styles.addressed!,
        };
  const source =
    changed > 0
      ? {
          label: t("sourceReviewSourceChanged"),
          count: changed,
          className: styles.changed!,
        }
      : unchanged > 0
        ? {
            label: t("sourceReviewSourceUnchanged"),
            count: unchanged,
            className: styles.unchanged!,
          }
        : {
            label: t("sourceReviewSourceUnavailable"),
            count: unavailable,
            className: styles.unavailable!,
          };

  return (
    <span className={styles.reviewStates}>
      <ReviewStateBadge {...discussion} t={t} />
      <ReviewStateBadge {...source} t={t} />
    </span>
  );
}

function ReviewStateBadge({
  label,
  count,
  className,
  t,
}: {
  label: string;
  count: number;
  className: string;
  t: TranslationFn;
}) {
  const title = t("sourceReviewSiteStateCount", { state: label, count });
  const tooltipAttributes = useTextTooltipAttributes(title);
  return (
    <span
      className={`${styles.reviewState} ${className}`}
      {...tooltipAttributes}
    >
      {label} {count}
    </span>
  );
}
