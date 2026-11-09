import type { ReviewSiteStateSummary } from "@yep-anywhere/shared";
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";
import { useTextTooltipAttributes } from "../hooks/useTooltipAppearance";
import type { MessageKey, TranslationFn } from "../i18n";
import { findTextMatch } from "../lib/searchMatch";
import { SearchMatchText } from "./SearchMatchText";
import { Badge, type BadgeTone } from "./ui/Badge";
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

const STATUS_TONES: Record<string, BadgeTone> = {
  M: "warning",
  A: "success",
  D: "danger",
  R: "info",
  C: "info",
  T: "info",
  U: "danger",
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
      className={styles.status}
      role="img"
      aria-label={label}
      {...tooltipAttributes}
    >
      <Badge tone={STATUS_TONES[status] ?? "neutral"} size="small" mono>
        {status}
      </Badge>
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
  type ReviewState = { label: string; count: number; tone?: BadgeTone };
  const discussion: ReviewState =
    open > 0
      ? { label: t("sourceReviewStateOpen"), count: open, tone: "warning" }
      : {
          label: t("sourceReviewStateAddressed"),
          count: addressed,
          tone: "accent",
        };
  const source: ReviewState =
    changed > 0
      ? {
          label: t("sourceReviewSourceChanged"),
          count: changed,
          tone: "success",
        }
      : unchanged > 0
        ? {
            label: t("sourceReviewSourceUnchanged"),
            count: unchanged,
          }
        : {
            label: t("sourceReviewSourceUnavailable"),
            count: unavailable,
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
  tone,
  t,
}: {
  label: string;
  count: number;
  tone?: BadgeTone;
  t: TranslationFn;
}) {
  return (
    <Badge
      tone={tone}
      size="small"
      tooltip={t("sourceReviewSiteStateCount", { state: label, count })}
    >
      {label} {count}
    </Badge>
  );
}
