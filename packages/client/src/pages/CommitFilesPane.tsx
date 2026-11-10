import columnsStyles from "../components/SourceColumnLayout.module.css";
import detailStyles from "./SourceDetail.module.css";
import statusStyles from "./SourceStatus.module.css";
import rowsStyles from "./SourceRows.module.css";
import type {
  GitCommitDetail,
  GitFileChange,
  GitRecentCommit,
  ReviewSiteStateSummary,
} from "@yep-anywhere/shared";
import {
  Fragment,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ChangesetFileFilter } from "../components/ChangesetFileFilter";
import { CopyButton } from "../components/CopyButton";
import { SourceFileOutline } from "../components/SourceFileOutline";
import { Banner } from "../components/ui/Banner";
import { Button } from "../components/ui/Button";
import {
  SourceFilePath,
  SourceFileRowButton,
  SourceFileStatusBadge,
  SourceReviewStateBadges,
} from "../components/SourceFileRow";
import {
  SourceRowMenuTrigger,
  sourceRowMenuSurface,
  type SourceContextMenuAction,
  useSourceContextMenu,
} from "../components/SourceContextMenu";
import {
  sourceFileDisplayPath,
  useChangesetFileFilter,
} from "../hooks/useChangesetFileFilter";
import {
  handleSourceListKeyDown,
  type SourcePageDirection,
} from "../hooks/useSourceKeyboard";
import { writeClipboardText } from "../lib/clipboard";
import { reflowCommitMessage } from "../lib/reflowCommitMessage";
import type { TranslationFn } from "../i18n";
import { CommitHistoryParentLink } from "./CommitHistoryParentLink";
import { SourceCommentCountBadge } from "./SourceCommentCountBadge";
import styles from "./CommitFilesPane.module.css";

const EMPTY_REVIEW_STATES = new Map<string, ReviewSiteStateSummary[]>();

/**
 * Selected revision's files pane. It owns the revision banner, changed-file
 * list, and file menus; diff rendering stays in the adjacent detail pane.
 */
export function CommitFilesPane({
  columnRef,
  selectedSha,
  selectedCommit,
  detail,
  loading,
  detailError,
  compareToHead,
  isWideScreen,
  messageView,
  selectedFiles,
  selectedPath,
  fileFocusRequest,
  fileCommentCount,
  reviewStatesByPath = EMPTY_REVIEW_STATES,
  revisionNavigation,
  onBack,
  onToggleComparison,
  onCompareFileToHead,
  onShowMessage,
  onPageDiff,
  onFocusFile,
  onFilteredSelectionChange,
  onActivateFile,
  onBlameFile,
  onMarkReadTo,
  onMarkUnreadSince,
  t,
}: {
  columnRef: RefObject<HTMLDivElement | null>;
  selectedSha: string;
  selectedCommit?: GitRecentCommit;
  detail: GitCommitDetail | null;
  loading: boolean;
  detailError: string | null;
  compareToHead: boolean;

  isWideScreen: boolean;
  messageView: boolean;
  selectedFiles: GitFileChange[];
  selectedPath: string | null;
  fileFocusRequest: number;
  fileCommentCount: ReadonlyMap<string, number>;
  reviewStatesByPath?: ReadonlyMap<string, ReviewSiteStateSummary[]>;
  revisionNavigation: ReactNode;
  onBack?: () => void;
  onToggleComparison: () => void;
  onCompareFileToHead?: (file: GitFileChange) => void;
  onShowMessage: () => void;
  onPageDiff: (direction: SourcePageDirection) => void;
  onFocusFile: (file: GitFileChange) => void;
  onFilteredSelectionChange: (file: GitFileChange | null) => void;
  onActivateFile: (file: GitFileChange) => void;
  onBlameFile?: (path: string) => void;
  onMarkReadTo: (authorDate: string) => void;
  onMarkUnreadSince: (authorDate: string) => void;
  t: TranslationFn;
}) {
  const [fileQuery, setFileQuery] = useState("");
  const handledFileFocusRequest = useRef(0);
  const fileMenu = useSourceContextMenu(t);
  const queryFilteredFiles = useChangesetFileFilter(selectedFiles, fileQuery);
  const revealRequestedFile =
    fileFocusRequest > handledFileFocusRequest.current &&
    Boolean(fileQuery) &&
    Boolean(selectedPath) &&
    !queryFilteredFiles.some((file) => file.path === selectedPath);
  const filteredFiles = revealRequestedFile
    ? selectedFiles
    : queryFilteredFiles;
  const effectiveFileQuery = revealRequestedFile ? "" : fileQuery;
  const outlineItems = useMemo(
    () =>
      filteredFiles.map((file) => ({
        id: file.path,
        path: file.path,
        displayPath: sourceFileDisplayPath(file),
        statuses: [file.status],
        value: file,
      })),
    [filteredFiles],
  );
  const selectedDisplayPath = useMemo(() => {
    const selectedFile = selectedFiles.find(
      (file) => file.path === selectedPath || file.origPath === selectedPath,
    );
    return selectedFile ? sourceFileDisplayPath(selectedFile) : null;
  }, [selectedFiles, selectedPath]);

  useEffect(() => {
    if (fileFocusRequest <= handledFileFocusRequest.current) return;
    handledFileFocusRequest.current = fileFocusRequest;
    if (revealRequestedFile) setFileQuery("");
  }, [fileFocusRequest, revealRequestedFile]);

  useEffect(() => {
    if (!isWideScreen || loading) return;
    const selectableFiles = filteredFiles.filter(
      (file) => !file.path.endsWith("/"),
    );
    const nextFile =
      selectableFiles.find(
        (file) => file.path === selectedPath || file.origPath === selectedPath,
      ) ??
      selectableFiles[0] ??
      null;
    if ((nextFile?.path ?? null) !== selectedPath) {
      onFilteredSelectionChange(nextFile);
    }
  }, [
    filteredFiles,
    isWideScreen,
    loading,
    onFilteredSelectionChange,
    selectedPath,
  ]);

  const fileMenuActions = (file: GitFileChange): SourceContextMenuAction[] => [
    {
      label: t("sourceCopyPath"),
      onSelect: () => {
        void writeClipboardText(file.path);
      },
    },
    ...(onCompareFileToHead
      ? [
          {
            label: t("sourceCompareFileTreeToHead"),
            onSelect: () => onCompareFileToHead(file),
          },
        ]
      : []),
    ...(onBlameFile
      ? [
          {
            label: t("sourceToggleBlame"),
            onSelect: () => onBlameFile(file.path),
          },
        ]
      : []),
  ];

  const showMessageUnlessSelecting = () => {
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) return;
    onShowMessage();
  };
  const handleMessageKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onShowMessage();
  };

  return (
    <>
      <div
        className={[
          columnsStyles.commitFilesColumn,
          isWideScreen ? styles.desktopColumn : "",
        ]
          .filter(Boolean)
          .join(" ")}
        data-source-column="files"
        ref={columnRef}
      >
        {onBack && <CommitHistoryParentLink onClick={onBack} t={t} />}
        <div className={detailStyles.banner} data-source-detail-banner>
          {revisionNavigation}
          <span className={detailStyles.identity}>
            <span
              className={detailStyles.subject}
              data-source-detail-subject
              title={detail?.subject ?? selectedCommit?.subject}
            >
              {detail?.subject ?? selectedCommit?.subject ?? "…"}
            </span>
            <span
              className={detailStyles.title}
              title={
                selectedCommit
                  ? `${selectedCommit.hash}\n${formatCommitDateTime(
                      selectedCommit.authorDate,
                    )}`
                  : selectedSha
              }
            >
              {detail?.shortHash ?? selectedCommit?.shortHash ?? "…"}
            </span>
          </span>
          <Button
            variant="ghost"
            size="small"
            title={t("sourceCompareToHeadDescription")}
            aria-pressed={compareToHead}
            onClick={onToggleComparison}
          >
            {t("sourceCompareToHead")}
          </Button>
          <CopyButton value={selectedSha} title={t("sourceCopyCommitHash")} />
          <Button
            size="small"
            title={t("sourceMarkReadToHere")}
            aria-label={t("sourceMarkReadToHere")}
            disabled={!selectedCommit}
            onClick={() =>
              selectedCommit && onMarkReadTo(selectedCommit.authorDate)
            }
          >
            <EyeIcon />
            <span className={detailStyles.actionText}>
              {t("sourceMarkReadToHere")}
            </span>
          </Button>
          <Button
            size="small"
            title={t("sourceMarkUnreadSinceHere")}
            aria-label={t("sourceMarkUnreadSinceHere")}
            disabled={!selectedCommit}
            onClick={() =>
              selectedCommit && onMarkUnreadSince(selectedCommit.authorDate)
            }
          >
            <EyeIcon crossed />
            <span className={detailStyles.actionText}>
              {t("sourceMarkUnreadSinceHere")}
            </span>
          </Button>
          <ChangesetFileFilter
            query={fileQuery}
            disabled={selectedFiles.length === 0}
            onQueryChange={setFileQuery}
            t={t}
          />
        </div>
        {loading ? (
          <div className={statusStyles.diffLoading}>
            {t("gitStatusLoading")}
          </div>
        ) : detailError ? (
          <Banner tone="error">{detailError}</Banner>
        ) : detail ? (
          <>
            {detail.body && (
              <div
                className={[
                  styles.body,
                  !isWideScreen ? styles.mobile : "",
                  messageView ? styles.selected : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                role="button"
                tabIndex={0}
                aria-pressed={messageView}
                title={t("sourceShowFullMessage")}
                onClick={showMessageUnlessSelecting}
                onKeyDown={handleMessageKeyDown}
              >
                <strong>{detail.subject}</strong>
                {"\n\n"}
                {isWideScreen
                  ? reflowCommitMessage(detail.body)
                  : t("sourceShowFullMessage")}
              </div>
            )}
            {selectedDisplayPath && !messageView && (
              <div
                className={styles.selectedPath}
                data-source-selected-path={selectedDisplayPath}
                aria-live="polite"
                aria-atomic="true"
              >
                <span className={styles.selectedPathBox}>
                  <WrappingSourcePath path={selectedDisplayPath} />
                </span>
              </div>
            )}
            <SourceFileOutline
              className={rowsStyles.commitFileList}
              data-source-file-list
              items={outlineItems}
              scopeKey={`${selectedSha}:${compareToHead ? "to-head" : "commit"}`}
              query={effectiveFileQuery}
              activeItemId={selectedPath}
              focusRequest={fileFocusRequest}
              toggleAllOnEnter
              onKeyDown={(event) =>
                handleSourceListKeyDown(event, {
                  onPage: onPageDiff,
                })
              }
              renderFile={(item, visiblePath, pathProps) => {
                const file = item.value;
                const count = fileCommentCount.get(file.path) ?? 0;
                const isFolder = file.path.endsWith("/");
                const menuActions = fileMenuActions(file);
                return (
                  <li
                    key={file.path}
                    className={`${rowsStyles.commitFileRow} ${sourceRowMenuSurface}`}
                    data-source-file-row
                  >
                    <SourceFileRowButton
                      path={item.displayPath}
                      type="button"
                      className={`${rowsStyles.commitFileItem} ${
                        selectedPath === file.path ? rowsStyles.selected : ""
                      }`}
                      disabled={isFolder}
                      data-source-list-item
                      data-source-selected={
                        selectedPath === file.path || undefined
                      }
                      data-source-file-item
                      onFocus={() => {
                        if (isWideScreen && !isFolder) onFocusFile(file);
                      }}
                      {...fileMenu.targetProps(menuActions, () => {
                        if (!isFolder) onActivateFile(file);
                      })}
                    >
                      <SourceFileStatusBadge status={file.status} t={t} />
                      <SourceFilePath
                        {...pathProps}
                        query={effectiveFileQuery}
                        fullPath={item.displayPath}
                      >
                        {visiblePath}
                      </SourceFilePath>
                      {(file.linesAdded !== null ||
                        file.linesDeleted !== null) && (
                        <span className={rowsStyles.gitLineCounts}>
                          {file.linesAdded ? (
                            <span className={rowsStyles.gitLinesAdded}>
                              +{file.linesAdded}
                            </span>
                          ) : null}
                          {file.linesDeleted ? (
                            <span className={rowsStyles.gitLinesDeleted}>
                              −{file.linesDeleted}
                            </span>
                          ) : null}
                        </span>
                      )}
                      <SourceCommentCountBadge count={count} t={t} />
                      <SourceReviewStateBadges
                        states={reviewStatesByPath.get(file.path) ?? []}
                        t={t}
                      />
                    </SourceFileRowButton>
                    {!isFolder && (
                      <SourceRowMenuTrigger
                        actions={menuActions}
                        label={t("sourceMoreActions")}
                        onOpen={fileMenu.openFromButton}
                      />
                    )}
                  </li>
                );
              }}
              t={t}
            />
            {selectedFiles.length === 0 && (
              <div className={statusStyles.statusEmpty} data-source-empty>
                {compareToHead
                  ? t("sourceNoChangesToHead")
                  : t("sourceNoFiles")}
              </div>
            )}
            {selectedFiles.length > 0 && filteredFiles.length === 0 && (
              <div className={statusStyles.statusEmpty} data-source-empty>
                {t("sourceNoMatches")}
              </div>
            )}
          </>
        ) : null}
      </div>
      {fileMenu.menu}
    </>
  );
}

function WrappingSourcePath({ path }: { path: string }) {
  const segments = path.split("/");
  return segments.map((segment, index) => (
    <Fragment key={`${index}:${segment}`}>
      {segment}
      {index < segments.length - 1 && (
        <>
          /<wbr />
        </>
      )}
    </Fragment>
  ));
}

export function formatCommitDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function EyeIcon({ crossed = false }: { crossed?: boolean }) {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z" />
      <circle cx="12" cy="12" r="2.5" />
      {crossed && <path d="m4 4 16 16" />}
    </svg>
  );
}
