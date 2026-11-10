import {
  buildProjectFileViewerHref,
  type GitFileDiffMode,
} from "@yep-anywhere/shared";
import type { MouseEvent, ReactNode } from "react";
import type { useFileVersionControl } from "../hooks/useFileVersionControl";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import { useI18n } from "../i18n";
import { toBrowserAppHref } from "../lib/appHref";
import type { FileViewerMode } from "./FileViewer";
import styles from "./FileDiffViewLinks.module.css";

export type FileViewSelection = "source" | GitFileDiffMode;

/** Filename and optional actions share one hover/focus target. */
export function FileDiffLinkCluster({
  children,
  className,
  ...attributes
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span {...attributes} className={`${styles.cluster} ${className ?? ""}`}>
      {children}
    </span>
  );
}

export function buildProjectFileViewUrl({
  basePath = "",
  diffMode,
  filePath,
  folder,
  lineEnd,
  lineNumber,
  projectId,
  viewMode,
}: {
  basePath?: string;
  diffMode?: GitFileDiffMode;
  filePath: string;
  folder?: string;
  lineEnd?: number;
  lineNumber?: number;
  projectId: string;
  viewMode?: FileViewerMode;
}): string {
  return `${basePath}${buildProjectFileViewerHref({
    diffMode,
    filePath,
    folder,
    lineEnd,
    lineNumber,
    projectId,
    viewMode,
  })}`;
}

export function FileDiffViewLinks({
  activeView = "source",
  availability,
  className,
  onSelect,
  projectId,
  variant,
}: {
  activeView?: FileViewSelection;
  availability: ReturnType<typeof useFileVersionControl>;
  className?: string;
  onSelect?: (view: FileViewSelection) => void;
  projectId: string;
  variant: "header" | "inline";
}) {
  const { t } = useI18n();
  const basePath = useRemoteBasePath();
  const relativePath = availability.relativePath;
  if (
    !relativePath ||
    (!availability.worktreeFile && !availability.cumulativeFile)
  ) {
    return null;
  }

  const hrefFor = (mode: GitFileDiffMode) =>
    toBrowserAppHref(
      buildProjectFileViewUrl({
        basePath,
        diffMode: mode,
        filePath: relativePath,
        projectId,
      }),
    );
  const handleClick =
    (view: FileViewSelection) => (event: MouseEvent<HTMLAnchorElement>) => {
      event.stopPropagation();
      if (
        !onSelect ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      event.preventDefault();
      onSelect(view);
    };
  const linkClass = (view: FileViewSelection) =>
    [
      styles.link,
      variant === "header" ? styles.headerLink : styles.inlineLink,
      activeView === view ? styles.active : null,
    ]
      .filter(Boolean)
      .join(" ");

  return (
    <span
      className={[
        styles.root,
        variant === "header" ? styles.header : styles.inline,
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      data-file-diff-links={variant}
      role="group"
      aria-label={t("fileDiffViews" as never)}
    >
      {availability.worktreeFile && (
        <a
          className={linkClass("worktree")}
          href={hrefFor("worktree")}
          aria-current={activeView === "worktree" ? "page" : undefined}
          aria-label={t("fileDiffVsHeadTitle" as never, {
            path: relativePath,
          })}
          title={t("fileDiffVsHeadTitle" as never, { path: relativePath })}
          onClick={handleClick("worktree")}
        >
          {t("fileDiffVsHead" as never)}
        </a>
      )}
      {availability.cumulativeFile && (
        <a
          className={linkClass("cumulative")}
          href={hrefFor("cumulative")}
          aria-current={activeView === "cumulative" ? "page" : undefined}
          aria-label={t("fileDiffVsParentTitle" as never, {
            path: relativePath,
          })}
          title={t("fileDiffVsParentTitle" as never, {
            path: relativePath,
          })}
          onClick={handleClick("cumulative")}
        >
          {t("fileDiffVsParent" as never)}
        </a>
      )}
    </span>
  );
}
