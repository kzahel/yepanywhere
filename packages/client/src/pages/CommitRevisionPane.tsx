import type { GitRecentCommit, GitStatusInfo } from "@yep-anywhere/shared";
import {
  type KeyboardEvent,
  type MouseEvent,
  type RefObject,
  useCallback,
  useLayoutEffect,
  useRef,
} from "react";
import {
  SourceRowMenuTrigger,
  sourceRowMenuSurface,
  type SourceContextMenuAction,
  useSourceContextMenu,
} from "../components/SourceContextMenu";
import { SearchMatchText } from "../components/SearchMatchText";
import { SourceShortcutHelp } from "../components/SourceShortcutHelp";
import { Banner } from "../components/ui/Banner";
import { Button } from "../components/ui/Button";
import { TextInput } from "../components/ui/Field";
import {
  handleSourceListKeyDown,
  suppressSourceKeyboardTooltips,
} from "../hooks/useSourceKeyboard";
import { writeClipboardText } from "../lib/clipboard";
import type { CommitSearchMatch } from "../lib/commitSearchIndex";
import { findTextMatch } from "../lib/searchMatch";
import type { TranslationFn } from "../i18n";
import { WORKING_TREE_KEY } from "./useCommitBrowserModel";
import { SourceCommentCountBadge } from "./SourceCommentCountBadge";
import styles from "./CommitRevisionPane.module.css";

/**
 * Commit-history master pane. It owns revision-row presentation and row menus;
 * the parent supplies the already-resolved list/search model and navigation.
 */
export function CommitRevisionPane({
  status,
  isWideScreen,
  searchInputRef,
  searchQuery,
  searchIndexRequested,
  searchIndexing,
  indexedCount,
  totalCount,
  searchError,
  searchActive,
  displayedCommits,
  commitSearchMatches,
  selectedKey,
  selectedIsWorkingTree,
  showWorkingTreeRevision,
  loadingList,
  listError,
  hasMore,
  workingTreeCommentCount,
  commentCountBySha,
  isRead,
  onSearchQueryChange,
  onSearchIndexRequested,
  onOpenRevision,
  onEnterRevision,
  revisionHref,
  onFocusRevision,
  onLoadMore,
  onMarkReadTo,
  onMarkUnreadSince,
  displayedKeys,
  t,
}: {
  status?: GitStatusInfo;
  isWideScreen: boolean;
  searchInputRef: RefObject<HTMLInputElement | null>;
  searchQuery: string;
  searchIndexRequested: boolean;
  searchIndexing: boolean;
  indexedCount: number;
  totalCount: number;
  searchError: string | null;
  searchActive: boolean;
  displayedCommits: GitRecentCommit[];
  commitSearchMatches: ReadonlyMap<string, CommitSearchMatch>;
  displayedKeys: string[];
  selectedKey: string | null;
  selectedIsWorkingTree: boolean;
  showWorkingTreeRevision: boolean;
  loadingList: boolean;
  listError: string | null;
  hasMore: boolean;
  workingTreeCommentCount: number;
  commentCountBySha: ReadonlyMap<string, number>;
  isRead: (authorDate: string) => boolean;
  onSearchQueryChange: (query: string) => void;
  onSearchIndexRequested: () => void;
  onOpenRevision: (key: string) => void;
  onEnterRevision: (key: string) => void;
  revisionHref: (key: string) => string;
  onFocusRevision: (key: string) => void;
  onLoadMore: () => void;
  onMarkReadTo: (authorDate: string) => void;
  onMarkUnreadSince: (authorDate: string) => void;
  t: TranslationFn;
}) {
  const revisionMenu = useSourceContextMenu(t);
  const revisionListRef = useRef<HTMLOListElement>(null);
  const initialRevisionFocusPending = useRef(true);
  const revisionMenuActions = useCallback(
    (key: string, commit?: GitRecentCommit): SourceContextMenuAction[] => {
      const index = displayedKeys.indexOf(key);
      const newer = index > 0 ? displayedKeys[index - 1] : undefined;
      const older =
        index >= 0 && index < displayedKeys.length - 1
          ? displayedKeys[index + 1]
          : undefined;
      if (!commit) {
        return [
          {
            label: t("sourceCopyRevisionLabel"),
            onSelect: () => {
              void writeClipboardText(t("sourceWorkingTree"));
            },
          },
          {
            label: t("sourceNewerCommit"),
            disabled: !newer,
            onSelect: () => newer && onOpenRevision(newer),
          },
          {
            label: t("sourceOlderCommit"),
            disabled: !older,
            onSelect: () => older && onOpenRevision(older),
          },
        ];
      }
      return [
        {
          label: t("sourceCopyCommitHash"),
          onSelect: () => {
            void writeClipboardText(commit.hash);
          },
        },
        {
          label: t("sourceCopyCommitSubject"),
          onSelect: () => {
            void writeClipboardText(commit.subject);
          },
        },
        {
          label: t("sourceMarkReadToHere"),
          separatorBefore: true,
          onSelect: () => onMarkReadTo(commit.authorDate),
        },
        {
          label: t("sourceMarkUnreadSinceHere"),
          onSelect: () => onMarkUnreadSince(commit.authorDate),
        },
        {
          label: t("sourceNewerCommit"),
          separatorBefore: true,
          disabled: !newer,
          onSelect: () => newer && onOpenRevision(newer),
        },
        {
          label: t("sourceOlderCommit"),
          disabled: !older,
          onSelect: () => older && onOpenRevision(older),
        },
      ];
    },
    [displayedKeys, onMarkReadTo, onMarkUnreadSince, onOpenRevision, t],
  );

  const noVisibleRevisions =
    displayedCommits.length === 0 && !showWorkingTreeRevision;
  const workingTreeClean = status?.isClean === true;
  const workingTreeFileCount = status
    ? new Set(status.files.map((file) => file.path)).size
    : 0;
  const workingTreeMenuActions = revisionMenuActions(WORKING_TREE_KEY);
  const workingTreeTargetProps = revisionMenu.targetProps(
    workingTreeMenuActions,
    () => onOpenRevision(WORKING_TREE_KEY),
  );
  useLayoutEffect(() => {
    if (loadingList) {
      initialRevisionFocusPending.current = true;
      return;
    }
    if (!isWideScreen || !initialRevisionFocusPending.current || !selectedKey) {
      return;
    }
    const selectedRevision =
      revisionListRef.current?.querySelector<HTMLElement>(
        ".commit-list-item.selected",
      );
    if (!selectedRevision) return;
    initialRevisionFocusPending.current = false;
    suppressSourceKeyboardTooltips();
    selectedRevision.focus({ preventScroll: true });
  }, [isWideScreen, loadingList, selectedKey]);
  return (
    <>
      <div className="commit-list-column">
        <div className="source-search-field">
          <TextInput
            ref={searchInputRef}
            type="search"
            size="small"
            className="source-search-input"
            value={searchQuery}
            placeholder={t("sourceSearchCommits")}
            aria-label={t("sourceShortcutSearch")}
            aria-keyshortcuts="/"
            onFocus={onSearchIndexRequested}
            onKeyDown={(event) => {
              if (event.key === "Escape" && searchQuery) {
                event.preventDefault();
                onSearchQueryChange("");
              }
            }}
            onChange={(event) => {
              onSearchIndexRequested();
              onSearchQueryChange(event.target.value);
            }}
          />
          <kbd className="source-search-shortcut">/</kbd>
          <SourceShortcutHelp t={t} />
        </div>
        {searchIndexRequested && searchIndexing && (
          <div className="source-search-index-status">
            {totalCount > 0
              ? t("sourceIndexingCommits", {
                  indexed: indexedCount,
                  total: totalCount,
                })
              : t("sourcePreparingCommitIndex")}
          </div>
        )}
        {loadingList && !searchActive && noVisibleRevisions ? (
          <div className="git-diff-loading">{t("gitStatusLoading")}</div>
        ) : listError && !searchActive && noVisibleRevisions ? (
          <Banner tone="error">{listError}</Banner>
        ) : searchActive && searchIndexing && noVisibleRevisions ? (
          <div className="git-diff-loading">{t("sourceSearching")}</div>
        ) : searchActive && searchError && noVisibleRevisions ? (
          <Banner tone="error">{searchError}</Banner>
        ) : noVisibleRevisions ? (
          <div className="git-status-empty">
            {searchActive ? t("sourceNoMatches") : t("sourceNoCommits")}
          </div>
        ) : (
          <>
            <ol
              ref={revisionListRef}
              className="commit-list"
              onKeyDown={handleSourceListKeyDown}
            >
              {showWorkingTreeRevision && (
                <li
                  className={`commit-list-row commit-list-working-tree ${sourceRowMenuSurface}`}
                >
                  <a
                    className={`commit-list-item ${styles.link} unread ${
                      workingTreeClean ? "" : styles.dirty
                    } ${selectedIsWorkingTree ? "selected" : ""} ${
                      !workingTreeClean && selectedIsWorkingTree
                        ? styles.dirtySelected
                        : ""
                    }`}
                    href={revisionHref(WORKING_TREE_KEY)}
                    data-source-list-item
                    onFocus={() => {
                      if (isWideScreen) onFocusRevision(WORKING_TREE_KEY);
                    }}
                    {...workingTreeTargetProps}
                    onKeyDown={(event) => {
                      workingTreeTargetProps.onKeyDown(event);
                      handleRevisionEnter(
                        event,
                        WORKING_TREE_KEY,
                        onEnterRevision,
                      );
                    }}
                    onClick={(event) => {
                      if (isModifiedLinkActivation(event)) return;
                      event.preventDefault();
                      workingTreeTargetProps.onClick();
                    }}
                  >
                    <span className="commit-subject-row">
                      <span className="commit-subject">
                        {t("sourceWorkingTree")}
                      </span>
                      <SourceCommentCountBadge
                        count={workingTreeCommentCount}
                        t={t}
                      />
                    </span>
                    <span className="commit-meta">
                      {workingTreeClean ? (
                        <>
                          <span className={styles.cleanLabel}>
                            {t("gitStatusClean")}
                          </span>
                          <span>{t("sourceWorkingTreeCleanDescription")}</span>
                        </>
                      ) : (
                        <>
                          <span className={styles.dirtyLabel}>
                            {t("sourceUncommitted")}
                          </span>
                          <span>
                            {t("sourceChangedFileCount", {
                              count: workingTreeFileCount,
                            })}
                          </span>
                        </>
                      )}
                    </span>
                  </a>
                  <SourceRowMenuTrigger
                    actions={workingTreeMenuActions}
                    label={t("sourceMoreActions")}
                    onOpen={revisionMenu.openFromButton}
                  />
                </li>
              )}
              {displayedCommits.map((commit) => {
                const commentCount = commentCountBySha.get(commit.hash) ?? 0;
                const menuActions = revisionMenuActions(commit.hash, commit);
                const targetProps = revisionMenu.targetProps(menuActions, () =>
                  onOpenRevision(commit.hash),
                );
                const match = commitSearchMatches.get(commit.hash);
                const formattedDate = formatCommitDate(commit.authorDate);
                const matchContext = getCommitMatchContext(
                  match,
                  searchQuery,
                  formattedDate,
                );
                return (
                  <li
                    key={commit.hash}
                    className={`commit-list-row ${sourceRowMenuSurface}`}
                  >
                    <a
                      className={`commit-list-item ${styles.link} ${
                        selectedKey === commit.hash ? "selected" : ""
                      } ${isRead(commit.authorDate) ? "read" : "unread"}`}
                      href={revisionHref(commit.hash)}
                      data-source-list-item
                      onFocus={() => {
                        if (isWideScreen) onFocusRevision(commit.hash);
                      }}
                      {...targetProps}
                      onKeyDown={(event) => {
                        targetProps.onKeyDown(event);
                        handleRevisionEnter(
                          event,
                          commit.hash,
                          onEnterRevision,
                        );
                      }}
                      onClick={(event) => {
                        if (isModifiedLinkActivation(event)) return;
                        event.preventDefault();
                        targetProps.onClick();
                      }}
                    >
                      <span className="commit-subject-row">
                        <SearchMatchText
                          className="commit-subject"
                          text={commit.subject}
                          query={
                            match?.field === "subject" ? searchQuery : undefined
                          }
                          title={commit.subject}
                        />
                        <SourceCommentCountBadge count={commentCount} t={t} />
                      </span>
                      <span className="commit-meta">
                        <SearchMatchText
                          className="commit-hash"
                          text={commit.shortHash}
                          query={
                            match?.field === "shortHash"
                              ? searchQuery
                              : undefined
                          }
                        />
                        <SearchMatchText
                          className="commit-author"
                          text={commit.authorName}
                          query={
                            match?.field === "author" ? searchQuery : undefined
                          }
                        />
                        <SearchMatchText
                          className="commit-date"
                          text={formattedDate}
                          query={
                            match?.field === "date" &&
                            findTextMatch(formattedDate, searchQuery)
                              ? searchQuery
                              : undefined
                          }
                        />
                      </span>
                      {matchContext && (
                        <SearchMatchText
                          className={styles.matchContext}
                          text={matchContext}
                          query={searchQuery}
                          title={matchContext}
                        />
                      )}
                    </a>
                    <SourceRowMenuTrigger
                      actions={menuActions}
                      label={t("sourceMoreActions")}
                      onOpen={revisionMenu.openFromButton}
                    />
                  </li>
                );
              })}
            </ol>
            {listError && <Banner tone="error">{listError}</Banner>}
            {hasMore && !searchActive && (
              <Button className={styles.loadMore} onClick={onLoadMore}>
                {t("sourceLoadMore")}
              </Button>
            )}
          </>
        )}
      </div>
      {revisionMenu.menu}
    </>
  );
}

function handleRevisionEnter(
  event: KeyboardEvent<HTMLAnchorElement>,
  key: string,
  onEnterRevision: (key: string) => void,
): void {
  if (
    event.defaultPrevented ||
    event.key !== "Enter" ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey
  ) {
    return;
  }
  event.preventDefault();
  if (!event.repeat) onEnterRevision(key);
}

function isModifiedLinkActivation(
  event: MouseEvent<HTMLAnchorElement>,
): boolean {
  return (
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  );
}

function getCommitMatchContext(
  match: CommitSearchMatch | undefined,
  query: string,
  formattedDate: string,
): string | null {
  if (!match) return null;
  if (match.field === "change" || match.field === "hash") return match.text;
  if (match.field === "date" && !findTextMatch(formattedDate, query)) {
    return match.text;
  }
  return null;
}

function formatCommitDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
