import type { IssueItem } from "@yep-anywhere/shared";
import { useI18n } from "../i18n";
import { Badge, type BadgeTone } from "./ui/Badge";
import styles from "./TrackerStatusBadge.module.css";

export const TRACKER_STATUS_LABELS = {
  open: "issuesStatus_open",
  draft: "issuesStatus_draft",
  merged: "issuesStatus_merged",
  closed: "issuesStatus_closed",
} as const;

/** GitHub's state hues; merged keeps its purple, which no tone carries. */
const TONES: Record<keyof typeof TRACKER_STATUS_LABELS, BadgeTone> = {
  open: "success",
  draft: "neutral",
  merged: "info",
  closed: "danger",
};

/** The tracker's reported state; nothing at all when the server sent none. */
export function TrackerStatusBadge({
  item,
  className,
}: {
  item: IssueItem;
  className?: string;
}) {
  const { t } = useI18n();
  const status = item.trackerStatus;
  // A state a later server adds is left out rather than shown unlabelled.
  const label = status && TRACKER_STATUS_LABELS[status.state];
  if (!status || !label) return null;
  return (
    <Badge
      tone={TONES[status.state]}
      emphasis="solid"
      palette={
        status.state === "merged"
          ? { color: "#8250df", onSolid: "#fff" }
          : undefined
      }
      tooltip={[
        status.checkedAt,
        status.mergedAt
          ? t("issuesMergedOn", {
              date: new Date(status.mergedAt).toLocaleString(),
            })
          : "",
        status.mergeCommitSha
          ? t("issuesMergeCommit", { sha: status.mergeCommitSha })
          : "",
      ]
        .filter(Boolean)
        .join(" · ")}
      className={[styles.badge, className].filter(Boolean).join(" ")}
    >
      {t(label)}
    </Badge>
  );
}
