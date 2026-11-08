import type {
  GitIncomingCommitListResult,
  GitStatusInfo,
} from "@yep-anywhere/shared";
import { useEffect, useState } from "react";
import { api } from "../api/client";
import { CopyButton } from "../components/CopyButton";
import { ButtonBase } from "../components/ui/Button";
import { Modal } from "../components/ui/Modal";
import type { TranslationFn } from "../i18n";
import { formatCommitDateTime } from "./CommitFilesPane";
import styles from "./RepoStatusBar.module.css";

/**
 * Persistent branch status in the Source Control identity header. Project,
 * branch, upstream, and clean/dirty state stay together while mode navigation
 * and repository actions use their own layout regions.
 */
export function RepoStatusBar({
  status,
  projectId,
  onSelectChanges,
  headCommitHref,
  onOpenHeadCommit,
  className,
  t,
}: {
  status: GitStatusInfo;
  projectId?: string;

  /** Make a dirty badge open the working-tree Changes mode. */
  onSelectChanges?: () => void;
  /** Standalone URL of the branch tip's commit view, for new-tab opening. */
  headCommitHref?: string;
  /** In-page navigation to that same commit, for plain left-click. */
  onOpenHeadCommit?: () => void;
  /** Caller-supplied placement class for the header region that holds the bar. */
  className?: string;
  t: TranslationFn;
}) {
  const [incomingOpen, setIncomingOpen] = useState(false);
  const outOfSync = status.ahead > 0 || status.behind > 0;
  const warn = !status.isClean || outOfSync;
  // Detached HEAD has no branch name but still has a tip, so the copy control
  // and the commit link both fall back to that SHA.
  const headCommit = status.recentCommits?.[0];
  const branchLabel = status.branch ?? t("gitStatusDetachedHead");
  const copyValue = status.branch ?? headCommit?.hash;
  const opensHeadCommit =
    headCommit !== undefined &&
    headCommitHref !== undefined &&
    onOpenHeadCommit !== undefined;
  const previewsIncoming = projectId !== undefined && status.upstream !== null;

  return (
    <>
      <div
        data-testid="repo-status-bar"
        className={[
          styles.bar,
          styles.inline,
          warn ? styles.warn : "",
          className ?? "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        <span className={styles.branch}>
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <line x1="6" y1="3" x2="6" y2="15" />
            <circle cx="18" cy="6" r="3" />
            <circle cx="6" cy="18" r="3" />
            <path d="M18 9a9 9 0 0 1-9 9" />
          </svg>
          {opensHeadCommit ? (
            <a
              className={`${styles.branchName} ${styles.branchLink}`}
              href={headCommitHref}
              title={t("sourceOpenHeadCommit", {
                commit: headCommit.shortHash,
              })}
              onClick={(event) => {
                if (
                  event.button !== 0 ||
                  event.metaKey ||
                  event.ctrlKey ||
                  event.shiftKey ||
                  event.altKey
                ) {
                  return;
                }
                event.preventDefault();
                onOpenHeadCommit();
              }}
            >
              {branchLabel}
            </a>
          ) : (
            <span className={styles.branchName}>{branchLabel}</span>
          )}
          {copyValue && (
            <CopyButton
              value={copyValue}
              title={
                status.branch
                  ? t("sourceCopyBranch")
                  : t("sourceCopyCommitHash")
              }
            />
          )}
        </span>
        {status.upstream &&
          (previewsIncoming ? (
            <ButtonBase
              className={`${styles.upstream} ${styles.upstreamButton}`}
              title={t("sourceOpenIncomingCommits", {
                upstream: status.upstream,
              })}
              onClick={() => setIncomingOpen(true)}
            >
              → {status.upstream}
            </ButtonBase>
          ) : (
            <span className={styles.upstream} title={status.upstream}>
              → {status.upstream}
            </span>
          ))}
        {outOfSync && (
          <span className={styles.sync}>
            {status.ahead > 0 && ` ↑${status.ahead}`}
            {status.behind > 0 && ` ↓${status.behind}`}
          </span>
        )}
        {!status.isClean && onSelectChanges ? (
          <ButtonBase
            className={`${styles.badge} ${styles.dirty} ${styles.badgeAction}`}
            title={t("sourceOpenChanges")}
            onClick={onSelectChanges}
          >
            {t("gitStatusDirty")}
          </ButtonBase>
        ) : (
          <span
            className={`${styles.badge} ${
              status.isClean ? styles.clean : styles.dirty
            }`}
          >
            {status.isClean ? t("gitStatusClean") : t("gitStatusDirty")}
          </span>
        )}
      </div>
      {incomingOpen && projectId && (
        <IncomingCommitsDialog
          projectId={projectId}
          onClose={() => setIncomingOpen(false)}
          t={t}
        />
      )}
    </>
  );
}

function IncomingCommitsDialog({
  projectId,
  onClose,
  t,
}: {
  projectId: string;
  onClose: () => void;
  t: TranslationFn;
}) {
  const [result, setResult] = useState<GitIncomingCommitListResult | null>(
    null,
  );
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    api
      .getGitIncomingCommits(projectId)
      .then((nextResult) => {
        if (active) setResult(nextResult);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [projectId]);

  return (
    <Modal title={t("sourceIncomingCommitsTitle")} onClose={onClose}>
      <div className={styles.incomingDialog}>
        <p className={styles.incomingIntro}>
          {t("sourceIncomingCommitsDescription")}
        </p>
        {error ? (
          <p className={styles.incomingState} role="alert">
            {t("sourceIncomingCommitsError")}
          </p>
        ) : result === null ? (
          <p className={styles.incomingState}>
            {t("sourceIncomingCommitsLoading")}
          </p>
        ) : result.commits.length === 0 ? (
          <p className={styles.incomingState}>
            {t("sourceIncomingCommitsEmpty", { upstream: result.upstream })}
          </p>
        ) : (
          <>
            <ul className={styles.incomingList}>
              {result.commits.map((commit) => (
                <li key={commit.hash} className={styles.incomingCommit}>
                  <span className={styles.incomingCommitHeader}>
                    <code title={commit.hash}>{commit.shortHash}</code>
                    <strong className={styles.incomingSubject}>
                      {commit.subject}
                    </strong>
                  </span>
                  <span className={styles.incomingMeta}>
                    {commit.authorName} ·{" "}
                    {formatCommitDateTime(commit.authorDate)}
                  </span>
                </li>
              ))}
            </ul>
            {result.truncated && (
              <p className={styles.incomingTruncated}>
                {t("sourceIncomingCommitsTruncated", { count: result.limit })}
              </p>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
