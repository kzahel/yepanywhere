import type { IssueItem } from "@yep-anywhere/shared";
import { Badge } from "../components/ui/Badge";
import { useI18n } from "../i18n";

/** Type colors describe the reference, never an inferred open/merged state. */
export function IssueTypeBadge({ item }: { item: IssueItem }) {
  const { t } = useI18n();
  const jira = item.provider === "jira";
  const pr = item.provider === "github" && item.kind === "pr";
  const issue = item.kind === "issue";
  const typeColor = jira
    ? "#1d4ed8"
    : pr
      ? "#7e22ce"
      : issue
        ? "#0f766e"
        : undefined;
  const icon = (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {pr ? (
        <>
          <circle cx="4" cy="3" r="1.5" />
          <circle cx="4" cy="13" r="1.5" />
          <circle cx="12" cy="13" r="1.5" />
          <path d="M4 4.5v7M9 2h1a2 2 0 0 1 2 2v7.5M9 2l2-2M9 2l2 2" />
        </>
      ) : (
        <>
          <circle cx="8" cy="8" r="6" />
          <path d="M8 4v4m0 3h.01" />
        </>
      )}
    </svg>
  );
  return (
    <Badge
      emphasis={typeColor ? "solid" : "soft"}
      icon={icon}
      palette={typeColor ? { color: typeColor, onSolid: "#fff" } : undefined}
    >
      {jira
        ? "Jira"
        : pr
          ? t("issuesTypePr")
          : item.provider === "github"
            ? t(issue ? "issuesTypeGithubIssue" : "issuesTypeGithubReference")
            : item.provider}
    </Badge>
  );
}
