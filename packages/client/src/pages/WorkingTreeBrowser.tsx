import {
  mergeWorkingTreeFiles,
  sameWorktreeRow,
  type WorktreeFileChange,
} from "./worktreeFileChanges";
import { WorktreeStateMarker } from "./WorktreeStateMarker";
import columnsStyles from "../components/SourceColumnLayout.module.css";
import detailStyles from "./SourceDetail.module.css";
import rowsStyles from "./SourceRows.module.css";
import statusStyles from "./SourceStatus.module.css";
import {
  getSessionDisplayTitle,
  type GitFileChange,
  type GitStatusInfo,
  type GitUntrackedFileListResult,
  type GitUntrackedFolderInfo,
  type ReviewSiteStateSummary,
} from "@yep-anywhere/shared";
import {
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { ChangesetFileFilter } from "../components/ChangesetFileFilter";
import { FileViewer } from "../components/FileViewer";
import { ResizableSourceColumns } from "../components/ResizableSourceColumns";
import {
  SourceFileOutline,
  SourceFileSectionDivider,
  SourceFolderCount,
  type SourceOutlinePathProps,
} from "../components/SourceFileOutline";
import { SourceFileHeaderActions } from "../components/SourceFileHeaderActions";
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
  type SourceContextMenuController,
  type SourceContextMenuOpenOptions,
  useSourceContextMenu,
} from "../components/SourceContextMenu";
import {
  sourceFileDisplayPath,
  useChangesetFileFilter,
} from "../hooks/useChangesetFileFilter";
import { useProjectReviewComments } from "../hooks/useProjectReviewComments";
import {
  handleSourceListKeyDown,
  suppressSourceKeyboardTooltips,
} from "../hooks/useSourceKeyboard";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import type { TranslationFn } from "../i18n";
import {
  getClientSummarySnapshotForSource,
  reportSessionCollectionTitleSnapshot,
  useClientSummarySourceKey,
} from "../lib/clientSummaryStore";
import { writeClipboardText } from "../lib/clipboard";
import { Badge } from "../components/ui/Badge";
import { Banner } from "../components/ui/Banner";
import { Modal } from "../components/ui/Modal";
import { CommitHistoryParentLink } from "./CommitHistoryParentLink";
import { SourceCommentCountBadge } from "./SourceCommentCountBadge";
import styles from "./WorkingTreeBrowser.module.css";
import {
  GitDiffModal,
  GitDiffPreview,
  type GitDiffPreviewHandle,
  type GitDiffSource,
  type GitDiffViewState,
} from "./GitStatusDiffPreview";

const WORKING_TREE_SOURCE: GitDiffSource = {
  kind: "working-tree-history",
};

/**
 * Simultaneous untracked-folder expansions. Kept well under the browser's
 * per-host connection budget so foreground Source Control requests stay
 * responsive while a large untracked corpus fills in behind them.
 */
const UNTRACKED_FOLDER_CONCURRENCY = 4;

/** How long arriving expansions accumulate before one list re-render. */
const FOLDER_FLUSH_MS = 100;
const UNTRACKED_GROUP_COLLAPSE_THRESHOLD = 10;
const sessionTitleRequests = new Map<string, Promise<boolean>>();

const EMPTY_REVIEW_STATES: ReviewSiteStateSummary[] = [];

function hasSessionTitleObservation(
  session:
    | { title?: string | null; fullTitle?: string | null; customTitle?: string }
    | undefined,
): boolean {
  return (
    session?.title !== undefined ||
    session?.fullTitle !== undefined ||
    session?.customTitle !== undefined
  );
}

function fileMenuContextKey(file: WorktreeFileChange): string {
  return `${file.path}\0${file.lastEditor?.sessionId ?? ""}`;
}

type WorktreeListEntry =
  | {
      kind: "file";
      file: WorktreeFileChange;
      displayPath: string;
    }
  | {
      kind: "folder";
      path: string;
      info?: GitUntrackedFolderInfo;
      expanded: boolean;
      children: Array<{
        file: WorktreeFileChange;
        displayPath: string;
      }>;
    };

const WorkingTreeFileRow = memo(function WorkingTreeFileRow({
  file,
  displayPath = sourceFileDisplayPath(file),
  pathProps,
  query,
  selected,
  commentCount,
  reviewStates,
  isWideScreen,
  menuActionsForFile,
  menuOpenOptionsForFile,
  menuTargetProps,
  onOpenMenu,
  onActivateFile,
  t,
}: {
  file: WorktreeFileChange;
  displayPath?: string;
  pathProps?: SourceOutlinePathProps;
  query: string;
  selected: boolean;
  commentCount: number;
  reviewStates: ReviewSiteStateSummary[];
  isWideScreen: boolean;
  menuActionsForFile: (file: WorktreeFileChange) => SourceContextMenuAction[];
  menuOpenOptionsForFile: (
    file: WorktreeFileChange,
  ) => SourceContextMenuOpenOptions;
  menuTargetProps: SourceContextMenuController["targetProps"];
  onOpenMenu: SourceContextMenuController["openFromButton"];
  onActivateFile: (file: WorktreeFileChange, selected: boolean) => void;
  t: TranslationFn;
}) {
  const isFolder = file.path.endsWith("/");
  const menuActions = menuActionsForFile(file);
  const menuOpenOptions = menuOpenOptionsForFile(file);
  const fullDisplayPath = sourceFileDisplayPath(file);

  return (
    <li
      className={`${rowsStyles.commitFileRow} ${sourceRowMenuSurface}`}
      data-source-file-row
    >
      <SourceFileRowButton
        path={fullDisplayPath}
        type="button"
        className={`${rowsStyles.commitFileItem} ${selected ? rowsStyles.selected : ""}`}
        disabled={isFolder}
        data-source-list-item
        data-source-selected={selected || undefined}
        data-source-file-item
        onFocus={() => {
          if (isWideScreen && !isFolder && !selected) {
            onActivateFile(file, selected);
          }
        }}
        {...menuTargetProps(
          menuActions,
          () => {
            onActivateFile(file, selected);
          },
          menuOpenOptions,
        )}
      >
        <SourceFileStatusBadge status={file.status} t={t} />
        <WorktreeStateMarker state={file.worktreeState} t={t} />
        <SourceFilePath {...pathProps} query={query} fullPath={fullDisplayPath}>
          {displayPath}
        </SourceFilePath>
        {(file.linesAdded !== null || file.linesDeleted !== null) && (
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
        <SourceCommentCountBadge count={commentCount} t={t} />
        <SourceReviewStateBadges states={reviewStates} t={t} />
      </SourceFileRowButton>
      {!isFolder && (
        <SourceRowMenuTrigger
          actions={menuActions}
          label={t("sourceMoreActions")}
          onOpen={onOpenMenu}
          openOptions={menuOpenOptions}
        />
      )}
    </li>
  );
});

/**
 * The current HEAD-to-filesystem view shared by Changes and the optional
 * Working tree revision in Commits. Both entry points therefore keep one file
 * merge, diff, comment-anchor, and refresh-survival implementation.
 */
export function WorkingTreeBrowser({
  projectId,
  status,
  isWideScreen,
  supportsUntrackedCache = false,
  untrackedFiles = null,
  untrackedLoading = false,
  untrackedError = null,
  inventoryPending = false,
  inventoryLoading = false,
  inventoryError = null,
  initialWorkingTreePath,
  embeddedInHistory = false,
  fileFocusRequest = 0,
  onBackToRevisions,
  revisionNavigation,
  onBrowseHistory,
  onBlameFile,
  captureReviewProjections = false,
  ignoreWhitespace = false,
  onToggleIgnoreWhitespace,
  onProjectionRequestFailure,
  t,
}: {
  projectId: string;
  status: GitStatusInfo;
  isWideScreen: boolean;
  supportsUntrackedCache?: boolean;
  untrackedFiles?: GitUntrackedFileListResult | null;
  untrackedLoading?: boolean;
  untrackedError?: Error | null;
  inventoryPending?: boolean;
  inventoryLoading?: boolean;
  inventoryError?: Error | null;
  /** One-shot deep link to a dirty file from a session Edit block. */
  initialWorkingTreePath?: string;
  /** Let Commits place these same files/diff in its revision-detail columns. */
  embeddedInHistory?: boolean;
  /** Move keyboard focus from the selected revision into its first file. */
  fileFocusRequest?: number;
  /** Narrow-history drill-in returns to the revision list through this path. */
  onBackToRevisions?: () => void;
  /** Adjacent-revision controls supplied by the history owner. */
  revisionNavigation?: ReactNode;
  /** Open commit history while keeping Working tree as the default revision. */
  onBrowseHistory?: () => void;
  onBlameFile?: (path: string) => void;
  captureReviewProjections?: boolean;

  ignoreWhitespace?: boolean;
  onToggleIgnoreWhitespace?: () => void;
  onProjectionRequestFailure?: (error: unknown) => void;
  t: TranslationFn;
}) {
  const [expandedUntrackedFolders, setExpandedUntrackedFolders] = useState<
    Record<string, GitUntrackedFolderInfo>
  >({});
  const [untrackedFolderScan, setUntrackedFolderScan] = useState({
    loaded: 0,
    total: 0,
  });
  const [untrackedFolderExpansion, setUntrackedFolderExpansion] = useState<
    Record<string, boolean>
  >({});
  const [loadingUntrackedFolders, setLoadingUntrackedFolders] = useState<
    ReadonlySet<string>
  >(new Set());
  const [untrackedSearch, setUntrackedSearch] =
    useState<GitUntrackedFileListResult | null>(null);
  const [untrackedSearchLoading, setUntrackedSearchLoading] = useState(false);
  const [untrackedCacheError, setUntrackedCacheError] = useState(false);
  const folderRequestsRef = useRef(new Set<string>());
  const searchRequestRef = useRef(0);
  const [fileQuery, setFileQuery] = useState("");
  const [sessionTitleRevision, setSessionTitleRevision] = useState(0);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [commentEditorOpen, setCommentEditorOpen] = useState(false);
  const [appliedWorkingTreeLink, setAppliedWorkingTreeLink] = useState<
    string | null
  >(null);
  const retainedFileRef = useRef<WorktreeFileChange | null>(null);
  const retainedDiffViewRef = useRef(new Map<string, GitDiffViewState>());
  const retainedScrollRatioRef = useRef(new Map<string, number>());
  const diffPreviewRef = useRef<GitDiffPreviewHandle>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const handledFileFocusRequest = useRef(0);
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  useEffect(() => {
    navigateRef.current = navigate;
  }, [navigate]);
  const navigateTo = useCallback((href: string) => {
    navigateRef.current(href);
  }, []);
  const basePath = useRemoteBasePath();
  const clientSummarySourceKey = useClientSummarySourceKey();
  const fileMenu = useSourceContextMenu(t);
  const refreshFileMenuActions = fileMenu.refreshOpenActions;
  const { pending, siteStates } = useProjectReviewComments(
    projectId,
    captureReviewProjections,
  );

  const untrackedFolderKey = useMemo(
    () =>
      status.files
        .filter((file) => file.status === "?" && file.path.endsWith("/"))
        .map((file) => file.path)
        .join("\0"),
    [status.files],
  );

  useEffect(() => {
    setExpandedUntrackedFolders({});
    setUntrackedFolderExpansion({});
    setLoadingUntrackedFolders(new Set());
    folderRequestsRef.current.clear();
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (supportsUntrackedCache) {
      setUntrackedFolderScan({ loaded: 0, total: 0 });
      return undefined;
    }
    const paths = untrackedFolderKey ? untrackedFolderKey.split("\0") : [];
    setUntrackedFolderScan({ loaded: 0, total: paths.length });
    if (paths.length === 0) return undefined;

    // Each expansion is a separate `git status --untracked-files=all` on the
    // server, and a repository with hundreds of untracked directories has
    // hundreds of them to run. Bound the fan-out so this background enrichment
    // never occupies the whole per-host connection budget: the foreground
    // status and the selected file's diff must not queue behind it.
    let nextPath = 0;
    let completed = 0;
    const arrived: Record<string, GitUntrackedFolderInfo> = {};
    let flushHandle: ReturnType<typeof setTimeout> | null = null;

    // Coalesce arrivals and progress: one state update per folder would rerender
    // the whole changed-file list once per request.
    const flush = () => {
      flushHandle = null;
      if (cancelled) return;
      const batch = { ...arrived };
      for (const key of Object.keys(arrived)) delete arrived[key];
      if (Object.keys(batch).length > 0) {
        setExpandedUntrackedFolders((current) => ({ ...current, ...batch }));
      }
      setUntrackedFolderScan({ loaded: completed, total: paths.length });
    };
    const scheduleFlush = () => {
      if (flushHandle === null) {
        flushHandle = setTimeout(flush, FOLDER_FLUSH_MS);
      }
    };

    const runNext = async (): Promise<void> => {
      while (!cancelled) {
        const path = paths[nextPath++];
        if (path === undefined) return;
        try {
          const info = await api.getGitUntrackedFolder(projectId, path);
          if (cancelled) return;
          arrived[path] = info;
        } catch {
          // Keep the compact folder row visible; it stays non-previewable.
        } finally {
          if (!cancelled) {
            completed += 1;
            scheduleFlush();
          }
        }
      }
    };

    const workers = Array.from(
      { length: Math.min(UNTRACKED_FOLDER_CONCURRENCY, paths.length) },
      runNext,
    );
    void Promise.all(workers).then(() => {
      if (cancelled) return;
      if (flushHandle !== null) clearTimeout(flushHandle);
      flush();
    });

    return () => {
      cancelled = true;
      if (flushHandle !== null) clearTimeout(flushHandle);
    };
  }, [projectId, supportsUntrackedCache, untrackedFolderKey]);

  const cachedFolderCounts = useMemo(
    () =>
      new Map(
        (untrackedFiles?.folders ?? []).map(({ path, count }) => [path, count]),
      ),
    [untrackedFiles?.folders],
  );

  const loadUntrackedFolder = useCallback(
    async (path: string) => {
      if (folderRequestsRef.current.has(path)) return;
      folderRequestsRef.current.add(path);
      setLoadingUntrackedFolders(new Set(folderRequestsRef.current));
      setUntrackedCacheError(false);
      try {
        const result = await api.listGitUntrackedFiles(projectId, { path });
        setExpandedUntrackedFolders((current) => ({
          ...current,
          [path]: {
            path,
            files: result.files,
            ...(result.lastEditors ? { lastEditors: result.lastEditors } : {}),
            truncated: result.truncated,
            limit: result.limit,
          },
        }));
      } catch {
        setUntrackedCacheError(true);
      } finally {
        folderRequestsRef.current.delete(path);
        setLoadingUntrackedFolders(new Set(folderRequestsRef.current));
      }
    },
    [projectId],
  );

  useEffect(() => {
    if (!supportsUntrackedCache) return;
    for (const [path, count] of cachedFolderCounts) {
      if (
        count <= UNTRACKED_GROUP_COLLAPSE_THRESHOLD &&
        untrackedFolderExpansion[path] !== false &&
        !expandedUntrackedFolders[path]
      ) {
        void loadUntrackedFolder(path);
      }
    }
  }, [
    cachedFolderCounts,
    expandedUntrackedFolders,
    loadUntrackedFolder,
    supportsUntrackedCache,
    untrackedFolderExpansion,
  ]);

  useEffect(() => {
    searchRequestRef.current += 1;
    const requestId = searchRequestRef.current;
    const query = fileQuery.trim();
    if (!supportsUntrackedCache || query === "") {
      setUntrackedSearch(null);
      setUntrackedSearchLoading(false);
      return undefined;
    }

    setUntrackedSearchLoading(true);
    setUntrackedCacheError(false);
    const timer = setTimeout(() => {
      void api
        .listGitUntrackedFiles(projectId, { q: query })
        .then((result) => {
          if (requestId === searchRequestRef.current) {
            setUntrackedSearch(result);
          }
        })
        .catch(() => {
          if (requestId === searchRequestRef.current) {
            setUntrackedSearch(null);
            setUntrackedCacheError(true);
          }
        })
        .finally(() => {
          if (requestId === searchRequestRef.current) {
            setUntrackedSearchLoading(false);
          }
        });
    }, 150);
    return () => clearTimeout(timer);
  }, [fileQuery, projectId, supportsUntrackedCache]);

  const previousRowsRef = useRef<{
    statusFiles: GitFileChange[];
    byPath: Map<string, WorktreeFileChange>;
  } | null>(null);
  const currentFiles = useMemo(() => {
    const cachedSearchFiles = (untrackedSearch?.files ?? []).map((path) => ({
      path,
      status: "?",
      staged: false,
      linesAdded: null,
      linesDeleted: null,
      ...(untrackedSearch?.lastEditors?.[path]
        ? { lastEditor: untrackedSearch.lastEditors[path] }
        : {}),
    }));
    const merged = mergeWorkingTreeFiles([
      ...expandUntrackedFolders(status.files, expandedUntrackedFolders),
      ...cachedSearchFiles,
    ]);
    // Untracked-folder expansions arrive in batches and rebuild every row,
    // including the rows they did not touch. A row's object identity is the
    // signal the diff pane refetches on, so handing out a fresh-but-equal
    // object for the selected file recomputed its diff once per arriving
    // batch. Reuse the previous object whenever the row's state is unchanged.
    //
    // A new status snapshot deliberately falls through to fresh objects: that
    // is exactly the live-refresh signal the diff pane must reload on, whether
    // or not the summary fields moved.
    const previous =
      previousRowsRef.current?.statusFiles === status.files
        ? previousRowsRef.current.byPath
        : null;
    const byPath = new Map<string, WorktreeFileChange>();
    const rows = merged.map((row) => {
      const prior = previous?.get(row.path);
      const kept = prior && sameWorktreeRow(prior, row) ? prior : row;
      byPath.set(row.path, kept);
      return kept;
    });
    previousRowsRef.current = { statusFiles: status.files, byPath };
    return rows;
  }, [expandedUntrackedFolders, status.files, untrackedSearch]);
  useEffect(() => {
    if (!selectedPath) return;
    const selected = currentFiles.find((file) => file.path === selectedPath);
    if (selected) retainedFileRef.current = selected;
  }, [currentFiles, selectedPath]);
  const files = useMemo(() => {
    const retained = retainedFileRef.current;
    if (
      commentEditorOpen &&
      selectedPath &&
      retained?.path === selectedPath &&
      !currentFiles.some((file) => file.path === selectedPath)
    ) {
      return [...currentFiles, retained];
    }
    return currentFiles;
  }, [commentEditorOpen, currentFiles, selectedPath]);
  const previewableFiles = useMemo(
    () => files.filter((file) => !file.path.endsWith("/")),
    [files],
  );
  const matchingFiles = useChangesetFileFilter(files, fileQuery);
  const matchingPaths = useMemo(
    () => new Set(matchingFiles.map((file) => file.path)),
    [matchingFiles],
  );
  const listEntries = useMemo(
    () =>
      buildWorktreeListEntries({
        statusFiles: status.files,
        files,
        folders: expandedUntrackedFolders,
        folderCounts: cachedFolderCounts,
        folderExpansion: untrackedFolderExpansion,
        matchingPaths,
        query: fileQuery,
      }),
    [
      cachedFolderCounts,
      expandedUntrackedFolders,
      fileQuery,
      files,
      matchingPaths,
      status.files,
      untrackedFolderExpansion,
    ],
  );
  const trackedListEntries = useMemo(
    () =>
      listEntries.filter(
        (entry) =>
          entry.kind === "file" && entry.file.worktreeState !== "untracked",
      ),
    [listEntries],
  );
  const untrackedListEntries = useMemo(
    () =>
      listEntries.filter(
        (entry) =>
          entry.kind === "folder" || entry.file.worktreeState === "untracked",
      ),
    [listEntries],
  );
  const trackedOutlineItems = useMemo(
    () =>
      trackedListEntries.flatMap((entry) =>
        entry.kind === "file"
          ? [
              {
                id: entry.file.path,
                path: entry.file.path,
                displayPath: sourceFileDisplayPath(entry.file),
                statuses: [entry.file.status],
                value: entry.file,
              },
            ]
          : [],
      ),
    [trackedListEntries],
  );
  const untrackedOutlineItems = useMemo(
    () =>
      untrackedListEntries.flatMap((entry) =>
        entry.kind === "file"
          ? [
              {
                id: entry.file.path,
                path: entry.file.path,
                displayPath: sourceFileDisplayPath(entry.file),
                statuses: [entry.file.status],
                value: entry.file,
              },
            ]
          : [],
      ),
    [untrackedListEntries],
  );
  const untrackedFolderEntries = useMemo(
    () =>
      untrackedListEntries.filter(
        (entry): entry is Extract<WorktreeListEntry, { kind: "folder" }> =>
          entry.kind === "folder",
      ),
    [untrackedListEntries],
  );
  const visiblePreviewableFiles = useMemo(
    () =>
      [...trackedListEntries, ...untrackedListEntries].flatMap((entry) =>
        entry.kind === "file"
          ? [entry.file]
          : entry.children.map((child) => child.file),
      ),
    [trackedListEntries, untrackedListEntries],
  );
  const selectedFile =
    previewableFiles.find((file) => file.path === selectedPath) ?? null;
  const retainedDiffView = selectedFile
    ? retainedDiffViewRef.current.get(selectedFile.path)
    : undefined;
  const retainedScrollRatio = selectedFile
    ? retainedScrollRatioRef.current.get(selectedFile.path)
    : undefined;
  const linkedFile = initialWorkingTreePath
    ? previewableFiles.find((file) => file.path === initialWorkingTreePath)
    : undefined;
  const workingTreeLinkToken = initialWorkingTreePath
    ? `${projectId}\0${initialWorkingTreePath}`
    : null;
  const shouldApplyWorkingTreeLink =
    !!workingTreeLinkToken &&
    !!linkedFile &&
    appliedWorkingTreeLink !== workingTreeLinkToken;

  // Apply an Edit-block link once. Later status polls may update the diff, but
  // closing the phone modal must not force it open again.
  useEffect(() => {
    if (!shouldApplyWorkingTreeLink || !workingTreeLinkToken || !linkedFile) {
      return;
    }
    setAppliedWorkingTreeLink(workingTreeLinkToken);
    setSelectedPath(linkedFile.path);
    const linkedFolder = Object.entries(expandedUntrackedFolders).find(
      ([, info]) => info.files.includes(linkedFile.path),
    )?.[0];
    if (linkedFolder) {
      setUntrackedFolderExpansion((current) => ({
        ...current,
        [linkedFolder]: true,
      }));
    }
  }, [
    expandedUntrackedFolders,
    linkedFile,
    shouldApplyWorkingTreeLink,
    workingTreeLinkToken,
  ]);

  useEffect(() => {
    if (shouldApplyWorkingTreeLink) return;
    const selectionCandidates = visiblePreviewableFiles;
    const nextPath =
      selectedPath &&
      selectionCandidates.some((file) => file.path === selectedPath)
        ? selectedPath
        : isWideScreen
          ? (selectionCandidates[0]?.path ?? null)
          : null;
    if (nextPath !== selectedPath) {
      setSelectedPath(nextPath);
    }
  }, [
    isWideScreen,
    selectedPath,
    shouldApplyWorkingTreeLink,
    visiblePreviewableFiles,
  ]);

  useLayoutEffect(() => {
    if (fileFocusRequest <= handledFileFocusRequest.current) return;
    const firstFile = rootRef.current?.querySelector<HTMLElement>(
      "[data-source-file-item]",
    );
    if (!firstFile) return;
    handledFileFocusRequest.current = fileFocusRequest;
    suppressSourceKeyboardTooltips();
    firstFile.focus({ preventScroll: true });
  }, [fileFocusRequest]);

  const fileCommentCount = useMemo(() => {
    const counts = new Map<string, number>();
    for (const comment of pending) {
      if (comment.anchor.revision.kind !== "uncommitted") continue;
      counts.set(
        comment.anchor.path,
        (counts.get(comment.anchor.path) ?? 0) + 1,
      );
    }
    return counts;
  }, [pending]);
  const reviewStatesByPath = useMemo(() => {
    const states = new Map<string, typeof siteStates>();
    for (const state of siteStates) {
      const current = states.get(state.path);
      if (current) current.push(state);
      else states.set(state.path, [state]);
    }
    return states;
  }, [siteStates]);

  const toggleUntrackedFolder = useCallback(
    (path: string, expanded: boolean, loaded: boolean) => {
      if (supportsUntrackedCache && !loaded) {
        setUntrackedFolderExpansion((current) => ({
          ...current,
          [path]: true,
        }));
        void loadUntrackedFolder(path);
        return;
      }
      setUntrackedFolderExpansion((current) => ({
        ...current,
        [path]: !expanded,
      }));
    },
    [loadUntrackedFolder, supportsUntrackedCache],
  );

  const handleFileClick = useCallback(
    (file: WorktreeFileChange, selected: boolean) => {
      if (file.path.endsWith("/")) return;
      if (
        isWideScreen &&
        selected &&
        diffPreviewRef.current?.jumpToNextHunk()
      ) {
        return;
      }
      setSelectedPath(file.path);
    },
    [isWideScreen],
  );

  const retainDiffView = useCallback(
    (fileKey: string, view: GitDiffViewState) => {
      retainedDiffViewRef.current.set(fileKey, {
        ...retainedDiffViewRef.current.get(fileKey),
        ...view,
      });
    },
    [],
  );
  const retainScrollRatio = useCallback((fileKey: string, ratio: number) => {
    retainedScrollRatioRef.current.set(fileKey, ratio);
  }, []);

  const lastEditorSessionLabel = useCallback(
    (sessionId: string) => {
      void sessionTitleRevision;
      const session = getClientSummarySnapshotForSource(
        clientSummarySourceKey,
      ).sessions.entities.get(sessionId);
      const title = getSessionDisplayTitle(session);
      return t("sourceOpenLastEditorSessionNamed", {
        title: title === "Untitled" ? sessionId.slice(0, 8) : title,
      });
    },
    [clientSummarySourceKey, sessionTitleRevision, t],
  );

  const fileMenuActions = useCallback(
    (file: WorktreeFileChange): SourceContextMenuAction[] => {
      const lastEditorSessionHref = file.lastEditor
        ? `${basePath}/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(file.lastEditor.sessionId)}`
        : undefined;
      const editorSessionLabel = file.lastEditor
        ? lastEditorSessionLabel(file.lastEditor.sessionId)
        : t("sourceOpenLastEditorSession");
      return [
        {
          label: t("sourceCopyPath"),
          onSelect: () => {
            void writeClipboardText(file.path);
          },
        },
        ...(lastEditorSessionHref
          ? [
              {
                label: editorSessionLabel,
                onSelect: () => navigateTo(lastEditorSessionHref),
              },
            ]
          : []),
        ...(onBlameFile
          ? [
              {
                label: t("sourceBlameAtHead"),
                onSelect: () => onBlameFile(file.path),
              },
            ]
          : []),
      ];
    },
    [basePath, lastEditorSessionLabel, navigateTo, onBlameFile, projectId, t],
  );

  const loadSessionTitle = useCallback(
    (sessionId: string): Promise<boolean> | null => {
      const session = getClientSummarySnapshotForSource(
        clientSummarySourceKey,
      ).sessions.entities.get(sessionId);
      if (hasSessionTitleObservation(session)) return null;

      const requestKey = `${clientSummarySourceKey}\0${projectId}\0${sessionId}`;
      let request = sessionTitleRequests.get(requestKey);
      if (!request) {
        const requestStartedAt = Date.now();
        request = api.getSessionMetadata(projectId, sessionId).then(
          (response) => {
            reportSessionCollectionTitleSnapshot(
              clientSummarySourceKey,
              response.session,
              requestStartedAt,
            );
            return true;
          },
          () => false,
        );
        sessionTitleRequests.set(requestKey, request);
        void request.finally(() => {
          if (sessionTitleRequests.get(requestKey) === request) {
            sessionTitleRequests.delete(requestKey);
          }
        });
      }
      return request;
    },
    [clientSummarySourceKey, projectId],
  );

  const menuOpenOptionsForFile = useCallback(
    (file: WorktreeFileChange): SourceContextMenuOpenOptions => {
      const contextKey = fileMenuContextKey(file);
      return {
        contextKey,
        onOpen: () => {
          const sessionId = file.lastEditor?.sessionId;
          if (!sessionId) return;
          const request = loadSessionTitle(sessionId);
          if (!request) return;
          void request.then((loaded) => {
            if (!loaded) return;
            setSessionTitleRevision((revision) => revision + 1);
            refreshFileMenuActions(contextKey, fileMenuActions(file));
          });
        },
      };
    },
    [fileMenuActions, loadSessionTitle, refreshFileMenuActions],
  );

  const lastEditorSessionHref = selectedFile?.lastEditor
    ? `${basePath}/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(selectedFile.lastEditor.sessionId)}`
    : undefined;
  const selectedLastEditorSessionLabel = selectedFile?.lastEditor
    ? lastEditorSessionLabel(selectedFile.lastEditor.sessionId)
    : undefined;
  const fileActions = selectedFile ? (
    <SourceFileHeaderActions
      path={selectedFile.path}
      lastEditorSessionHref={lastEditorSessionHref}
      lastEditorSessionLabel={selectedLastEditorSessionLabel}
      onBlameFile={onBlameFile}
      t={t}
    />
  ) : null;
  const renderFileRow = (
    {
      file,
      displayPath,
    }: {
      file: WorktreeFileChange;
      displayPath: string;
    },
    visiblePath = displayPath,
    pathProps?: SourceOutlinePathProps,
  ) => (
    <WorkingTreeFileRow
      key={file.path}
      file={file}
      displayPath={visiblePath}
      pathProps={pathProps}
      query={fileQuery}
      selected={selectedPath === file.path}
      commentCount={fileCommentCount.get(file.path) ?? 0}
      reviewStates={reviewStatesByPath.get(file.path) ?? EMPTY_REVIEW_STATES}
      isWideScreen={isWideScreen}
      menuActionsForFile={fileMenuActions}
      menuOpenOptionsForFile={menuOpenOptionsForFile}
      menuTargetProps={fileMenu.targetProps}
      onOpenMenu={fileMenu.openFromButton}
      onActivateFile={handleFileClick}
      t={t}
    />
  );

  const hasRetainedEditorTarget = commentEditorOpen && selectedFile !== null;
  const rootClassName = `${columnsStyles.workingTreeBrowser} ${
    embeddedInHistory ? columnsStyles.workingTreeBrowserHistory : ""
  }`.trim();
  const openHistory = onBackToRevisions ?? onBrowseHistory;
  const historyParentLink = openHistory ? (
    <CommitHistoryParentLink onClick={openHistory} t={t} />
  ) : null;
  const untrackedCacheIncomplete =
    supportsUntrackedCache && untrackedFiles === null;
  const effectiveInventoryPending =
    inventoryPending || untrackedCacheIncomplete;
  const effectiveInventoryLoading =
    (inventoryPending && inventoryLoading) ||
    (untrackedCacheIncomplete && untrackedLoading);
  const effectiveInventoryError =
    (inventoryPending ? inventoryError : null) ??
    (untrackedCacheIncomplete ? untrackedError : null);
  if (
    (status.isClean || currentFiles.length === 0) &&
    !hasRetainedEditorTarget &&
    !effectiveInventoryPending
  ) {
    return (
      <div
        ref={rootRef}
        className={rootClassName}
        data-testid="working-tree-browser"
      >
        {historyParentLink}
        {embeddedInHistory ? (
          <div
            className={`${styles.cleanState} ${columnsStyles.workingTreeHistoryClean}`}
          >
            <span className={styles.cleanIcon} aria-hidden="true">
              ✓
            </span>
            <div className={statusStyles.statusEmpty} data-source-empty>
              {t("gitStatusWorkingTreeClean")}
            </div>
            <p>{t("sourceWorkingTreeCleanDescription")}</p>
          </div>
        ) : (
          <div className={styles.cleanLanding}>
            <div className={styles.cleanState}>
              <span className={styles.cleanIcon} aria-hidden="true">
                ✓
              </span>
              <div className={statusStyles.statusEmpty} data-source-empty>
                {t("gitStatusWorkingTreeClean")}
              </div>
              <p>{t("sourceWorkingTreeCleanDescription")}</p>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      className={rootClassName}
      data-testid="working-tree-browser"
    >
      {historyParentLink}
      <ResizableSourceColumns
        layout="files"
        enabled={!embeddedInHistory}
        className={columnsStyles.workingTreeBrowserColumns!}
        t={t}
      >
        <div
          className={`${columnsStyles.commitFilesColumn} ${columnsStyles.workingTreeFilesColumn}`}
          data-source-column="files"
          data-source-working-files
        >
          <div className={detailStyles.banner} data-source-detail-banner>
            {revisionNavigation}
            {embeddedInHistory ? (
              <span
                className={`${detailStyles.identity} working-tree-detail-identity`}
              >
                <span className={styles.detailTitleRow}>
                  <span
                    className={detailStyles.subject}
                    data-source-detail-subject
                  >
                    {t("sourceWorkingTree")}
                  </span>
                  <Badge
                    shape="count"
                    size="small"
                    role="img"
                    aria-label={t("sourceChangedFileCount", {
                      count: files.length,
                    })}
                    tooltip={t("sourceChangedFileCount", {
                      count: files.length,
                    })}
                  >
                    {files.length}
                  </Badge>
                </span>
                <span
                  className={detailStyles.title}
                  title={t("sourceWorkingTreeDescription")}
                >
                  {t("sourceUncommitted")}
                </span>
              </span>
            ) : (
              <>
                <span
                  className={detailStyles.title}
                  title={t("sourceWorkingTreeDescription")}
                >
                  {t("sourceUncommittedChanges")}
                </span>
                <span className={detailStyles.count}>
                  {t("sourceChangedFileCount", { count: files.length })}
                </span>
              </>
            )}
            {untrackedFolderScan.total > 0 && (
              <span className={styles.scanProgress} role="status">
                {t("sourceUntrackedFolderScanProgress", {
                  loaded: untrackedFolderScan.loaded,
                  total: untrackedFolderScan.total,
                })}
              </span>
            )}
            {effectiveInventoryLoading && (
              <span className={styles.scanProgress} role="status">
                {t("gitStatusLoading")}
              </span>
            )}
            {effectiveInventoryPending && effectiveInventoryError && (
              <Banner tone="error" compact className={styles.scanNotice}>
                {t("gitStatusErrorPrefix")} {effectiveInventoryError.message}
              </Banner>
            )}
            {supportsUntrackedCache && untrackedFiles?.truncated && (
              <span className={styles.scanProgress} role="status">
                {t("sourceUntrackedCacheBounded", {
                  count: untrackedFiles.total,
                })}
              </span>
            )}
            {untrackedSearchLoading && (
              <span className={styles.scanProgress} role="status">
                {t("sourceUntrackedSearchLoading")}
              </span>
            )}
            {untrackedSearch?.truncated && (
              <span className={styles.scanProgress} role="status">
                {t("sourceUntrackedSearchTruncated", {
                  count: untrackedSearch.files.length,
                })}
              </span>
            )}
            {untrackedCacheError && (
              <Banner tone="warning" compact className={styles.scanNotice}>
                {t("sourceUntrackedCacheError")}
              </Banner>
            )}
            <ChangesetFileFilter
              query={fileQuery}
              onQueryChange={setFileQuery}
              t={t}
            />
          </div>
          {/* biome-ignore lint/a11y/noStaticElementInteractions: delegates arrow traversal across tracked, untracked, and folder rows to their nested controls */}
          <div onKeyDown={handleSourceListKeyDown}>
            {trackedOutlineItems.length > 0 && (
              <SourceFileOutline
                className={rowsStyles.commitFileList}
                data-source-file-list
                items={trackedOutlineItems}
                scopeKey={`${projectId}:working-tree:tracked`}
                query={fileQuery}
                renderFile={(item, visiblePath, pathProps) =>
                  renderFileRow(
                    { file: item.value, displayPath: item.displayPath },
                    visiblePath,
                    pathProps,
                  )
                }
                t={t}
              />
            )}
            {untrackedListEntries.length > 0 && (
              <>
                <SourceFileSectionDivider>
                  {t("sourceUntrackedFiles")}
                </SourceFileSectionDivider>
                {untrackedOutlineItems.length > 0 && (
                  <SourceFileOutline
                    className={rowsStyles.commitFileList}
                    data-source-file-list
                    items={untrackedOutlineItems}
                    scopeKey={`${projectId}:working-tree:untracked`}
                    query={fileQuery}
                    renderFile={(item, visiblePath, pathProps) =>
                      renderFileRow(
                        { file: item.value, displayPath: item.displayPath },
                        visiblePath,
                        pathProps,
                      )
                    }
                    t={t}
                  />
                )}
                {untrackedFolderEntries.length > 0 && (
                  <ul
                    className={rowsStyles.commitFileList}
                    data-source-file-list
                  >
                    {untrackedFolderEntries.map((entry) => (
                      <li key={entry.path} className={styles.folderGroup}>
                        <div className={styles.folderHeader}>
                          <SourceFileRowButton
                            path={entry.path}
                            type="button"
                            className={rowsStyles.commitFileItem}
                            data-source-file-item
                            disabled={
                              loadingUntrackedFolders.has(entry.path) ||
                              (!supportsUntrackedCache && !entry.info) ||
                              (supportsUntrackedCache
                                ? (cachedFolderCounts.get(entry.path) ?? 0) ===
                                  0
                                : !entry.info || entry.info.files.length === 0)
                            }
                            aria-expanded={
                              supportsUntrackedCache || entry.info
                                ? entry.expanded
                                : undefined
                            }
                            aria-label={t(
                              loadingUntrackedFolders.has(entry.path) ||
                                (!supportsUntrackedCache && !entry.info)
                                ? "sourceLoadingUntrackedFolder"
                                : entry.expanded
                                  ? "sourceCollapseUntrackedFolder"
                                  : "sourceExpandUntrackedFolder",
                              { path: entry.path },
                            )}
                            data-source-list-item
                            onClick={() =>
                              toggleUntrackedFolder(
                                entry.path,
                                entry.expanded,
                                entry.info !== undefined,
                              )
                            }
                          >
                            <span
                              className={styles.disclosure}
                              aria-hidden="true"
                            >
                              {loadingUntrackedFolders.has(entry.path) ||
                              (!supportsUntrackedCache && !entry.info)
                                ? "…"
                                : entry.expanded
                                  ? "−"
                                  : "+"}
                            </span>
                            <SourceFileStatusBadge status="?" t={t} />
                            <SourceFilePath
                              query={fileQuery}
                              fullPath={entry.path}
                            >
                              {entry.path}
                            </SourceFilePath>
                            <SourceFolderCount
                              className={styles.folderCount}
                              count={
                                cachedFolderCounts.get(entry.path) ??
                                entry.info?.files.length
                              }
                              truncated={entry.info?.truncated}
                              t={t}
                            />
                          </SourceFileRowButton>
                        </div>
                        {entry.children.length > 0 && (
                          <SourceFileOutline
                            className={styles.folderChildren}
                            items={entry.children.map((child) => ({
                              id: child.file.path,
                              path: child.displayPath,
                              displayPath: child.displayPath,
                              statuses: [child.file.status],
                              value: child.file,
                            }))}
                            scopeKey={`${projectId}:working-tree:${entry.path}`}
                            query={fileQuery}
                            renderFile={(item, visiblePath, pathProps) =>
                              renderFileRow(
                                {
                                  file: item.value,
                                  displayPath: item.displayPath,
                                },
                                visiblePath,
                                pathProps,
                              )
                            }
                            t={t}
                          />
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
          {listEntries.length === 0 && !effectiveInventoryPending && (
            <div className={statusStyles.statusEmpty} data-source-empty>
              {t("sourceNoMatches")}
            </div>
          )}
        </div>

        {isWideScreen &&
          selectedFile &&
          (selectedFile.worktreeState === "untracked" ? (
            <section className={styles.currentContent}>
              {fileActions && (
                <div className={styles.currentContentActions}>
                  {fileActions}
                </div>
              )}
              <FileViewer projectId={projectId} filePath={selectedFile.path} />
            </section>
          ) : (
            <GitDiffPreview
              ref={diffPreviewRef}
              file={selectedFile}
              fileKey={selectedFile.path}
              projectId={projectId}
              source={WORKING_TREE_SOURCE}
              retainedScrollRatio={retainedScrollRatio}
              retainedDiffView={retainedDiffView}
              onRetainScrollRatio={retainScrollRatio}
              onRetainDiffView={retainDiffView}
              headerActions={fileActions}
              onCommentEditorOpenChange={setCommentEditorOpen}
              captureReviewProjections={captureReviewProjections}
              ignoreWhitespace={ignoreWhitespace}
              onToggleIgnoreWhitespace={onToggleIgnoreWhitespace}
              onProjectionRequestFailure={onProjectionRequestFailure}
              t={t}
            />
          ))}
      </ResizableSourceColumns>
      {fileMenu.menu}

      {!isWideScreen &&
        selectedFile &&
        (selectedFile.worktreeState === "untracked" ? (
          <Modal
            title={selectedFile.path}
            onClose={() => setSelectedPath(null)}
            closeOnBackGesture
          >
            {fileActions && (
              <div className={styles.currentContentActions}>{fileActions}</div>
            )}
            <FileViewer projectId={projectId} filePath={selectedFile.path} />
          </Modal>
        ) : (
          <GitDiffModal
            file={selectedFile}
            fileKey={selectedFile.path}
            projectId={projectId}
            source={WORKING_TREE_SOURCE}
            retainedScrollRatio={retainedScrollRatio}
            retainedDiffView={retainedDiffView}
            onRetainScrollRatio={retainScrollRatio}
            onRetainDiffView={retainDiffView}
            headerActions={fileActions}
            onCommentEditorOpenChange={setCommentEditorOpen}
            captureReviewProjections={captureReviewProjections}
            ignoreWhitespace={ignoreWhitespace}
            onToggleIgnoreWhitespace={onToggleIgnoreWhitespace}
            onProjectionRequestFailure={onProjectionRequestFailure}
            t={t}
            onClose={() => setSelectedPath(null)}
          />
        ))}
    </div>
  );
}

function buildWorktreeListEntries({
  statusFiles,
  files,
  folders,
  folderCounts,
  folderExpansion,
  matchingPaths,
  query,
}: {
  statusFiles: GitFileChange[];
  files: WorktreeFileChange[];
  folders: Record<string, GitUntrackedFolderInfo>;
  folderCounts: ReadonlyMap<string, number>;
  folderExpansion: Record<string, boolean>;
  matchingPaths: ReadonlySet<string>;
  query: string;
}): WorktreeListEntry[] {
  const normalizedQuery = query.trim().toLowerCase();
  const byPath = new Map(files.map((file) => [file.path, file]));
  const emitted = new Set<string>();
  const entries: WorktreeListEntry[] = [];

  for (const statusFile of statusFiles) {
    const isCompactUntrackedFolder =
      statusFile.status === "?" && statusFile.path.endsWith("/");
    if (isCompactUntrackedFolder) {
      const info = folders[statusFile.path];
      const allChildren =
        info?.files.flatMap((path) => {
          emitted.add(path);
          const file = byPath.get(path);
          return file
            ? [
                {
                  file,
                  displayPath: path.startsWith(statusFile.path)
                    ? path.slice(statusFile.path.length)
                    : path,
                },
              ]
            : [];
        }) ?? [];
      const matchingChildren = normalizedQuery
        ? allChildren.filter(({ file }) => matchingPaths.has(file.path))
        : allChildren;
      const folderMatches = statusFile.path
        .toLowerCase()
        .includes(normalizedQuery);
      emitted.add(statusFile.path);
      if (normalizedQuery && !folderMatches && matchingChildren.length === 0) {
        continue;
      }
      const descendantCount =
        folderCounts.get(statusFile.path) ?? info?.files.length;
      const userExpanded =
        folderExpansion[statusFile.path] ??
        (descendantCount !== undefined
          ? descendantCount <= UNTRACKED_GROUP_COLLAPSE_THRESHOLD
          : false);
      const expanded = normalizedQuery
        ? matchingChildren.length > 0
        : userExpanded;
      entries.push({
        kind: "folder",
        path: statusFile.path,
        ...(info ? { info } : {}),
        expanded,
        children: normalizedQuery
          ? matchingChildren
          : expanded
            ? allChildren
            : [],
      });
      continue;
    }

    const file = byPath.get(statusFile.path);
    if (!file || emitted.has(file.path)) continue;
    emitted.add(file.path);
    if (normalizedQuery && !matchingPaths.has(file.path)) continue;
    entries.push({
      kind: "file",
      file,
      displayPath: sourceFileDisplayPath(file),
    });
  }

  for (const file of files) {
    if (emitted.has(file.path) || file.path.endsWith("/")) continue;
    if (normalizedQuery && !matchingPaths.has(file.path)) continue;
    entries.push({
      kind: "file",
      file,
      displayPath: sourceFileDisplayPath(file),
    });
  }

  return entries;
}

function expandUntrackedFolders(
  files: GitFileChange[],
  expanded: Record<string, GitUntrackedFolderInfo>,
): GitFileChange[] {
  return files.flatMap((file) => {
    const folder = expanded[file.path];
    if (file.status !== "?" || !file.path.endsWith("/") || !folder) {
      return [file];
    }
    return folder.files.map((path) => {
      const lastEditor = folder.lastEditors?.[path];
      return {
        path,
        status: "?",
        staged: false,
        linesAdded: null,
        linesDeleted: null,
        ...(lastEditor ? { lastEditor } : {}),
      };
    });
  });
}
