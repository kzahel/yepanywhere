import type {
  GitFileRevision,
  GitFileRevisionCommit,
} from "@yep-anywhere/shared";
import { useEffect, useState } from "react";
import { api } from "../api/client";
import { usePublicShareContext } from "../contexts/PublicShareContext";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import { toBrowserAppHref } from "../lib/appHref";
import { useClientSummarySourceKey } from "../lib/clientSummaryStore";
import styles from "./FileRevisionLink.module.css";
import { ResourceContextMenu } from "./FileResourceActions";

export interface FileRevisionLinkProps {
  projectId: string;
  path: string;
  /** Immutable content revision; omission describes the live filesystem. */
  rev?: string;
  /** Historical path for a live, not-yet-committed rename. */
  origPath?: string;
  dirtyLabel: string;
  uncommittedLabel: string;
  className?: string;
  showAuthor?: boolean;
}

/** Compact last-revision provenance shared by every file-viewing surface. */
export function FileRevisionLink({
  projectId,
  path,
  rev,
  origPath,
  dirtyLabel,
  uncommittedLabel,
  className,
  showAuthor = false,
}: FileRevisionLinkProps) {
  const sourceKey = useClientSummarySourceKey();
  const authenticatedView = usePublicShareContext() === null;
  const basePath = useRemoteBasePath();
  const identity = `${sourceKey}\0${projectId}\0${path}\0${rev ?? ""}\0${origPath ?? ""}`;
  const [loaded, setLoaded] = useState<{
    identity: string;
    value: GitFileRevision | null;
  }>({ identity, value: null });
  const revision = loaded.identity === identity ? loaded.value : null;
  const [contextMenu, setContextMenu] = useState<{
    identity: string;
    x: number;
    y: number;
  } | null>(null);

  useEffect(() => {
    if (!authenticatedView || !projectId || !path) return;
    let cancelled = false;
    void api
      .getGitFileRevision(projectId, { path, rev, origPath })
      .then((value) => {
        if (!cancelled) setLoaded({ identity, value });
      })
      .catch(() => {
        if (!cancelled) setLoaded({ identity, value: null });
      });
    return () => {
      cancelled = true;
    };
  }, [authenticatedView, identity, origPath, path, projectId, rev]);

  if (!authenticatedView || !revision?.isGitRepo) return null;
  if (!revision.commit) {
    return (
      <span
        className={`${styles.root} ${styles.uncommitted} ${className ?? ""}`}
      >
        {uncommittedLabel}
      </span>
    );
  }

  const params = new URLSearchParams({
    projectId,
    rev: revision.commit.hash,
    commitFile: rev ? path : (origPath ?? path),
  });
  const href = toBrowserAppHref(`${basePath}/git-status?${params.toString()}`);
  const tooltip = formatRevisionTooltip(revision.commit);

  return (
    <span
      className={`${styles.root} ${showAuthor ? styles.withAuthor : ""} ${className ?? ""}`}
    >
      <a
        className={styles.commit}
        href={href}
        title={tooltip}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setContextMenu({ identity, x: event.clientX, y: event.clientY });
        }}
      >
        {revision.commit.shortHash}
      </a>
      {showAuthor && (
        <span className={styles.author}>{revision.commit.authorName}</span>
      )}
      <span className={styles.age}>
        ({formatRevisionAge(revision.commit.authorDate)})
      </span>
      {revision.dirty && <span className={styles.dirty}>{dirtyLabel}</span>}
      {contextMenu?.identity === identity && (
        <ResourceContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          onOpen={() => window.open(href, "_blank", "noopener,noreferrer")}
          fileTarget={{
            projectId,
            path: rev ? path : (origPath ?? path),
            rev: revision.commit.hash,
          }}
        />
      )}
    </span>
  );
}

export function formatRevisionAge(
  authorDate: string,
  now = Date.now(),
): string {
  const elapsedSeconds = Math.max(
    0,
    Math.floor((now - new Date(authorDate).getTime()) / 1000),
  );
  if (elapsedSeconds < 60) return "now";
  const minutes = Math.floor(elapsedSeconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

export function formatRevisionTooltip(commit: GitFileRevisionCommit): string {
  const absoluteTime = new Date(commit.authorDate).toLocaleString();
  const message = `${commit.message}${commit.messageTruncated ? "\n..." : ""}`;
  return `${commit.authorName}\n${absoluteTime}\n\n${message}`;
}
