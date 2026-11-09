import type {
  GitStatusInfo,
  GitWorkingTreeFile,
  GitWorkingTreePathKind,
  GitWorktreeCoverage,
  GitWorktreeDirectory,
  LocalSourceRoot,
} from "@yep-anywhere/shared";
import {
  type ReactNode,
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api } from "../api/client";
import { FileViewer } from "../components/FileViewer";
import { ResizableSourceColumns } from "../components/ResizableSourceColumns";
import {
  type SourceContextMenuAction,
  SourceRowMenuTrigger,
  sourceRowMenuSurface,
  useSourceContextMenu,
} from "../components/SourceContextMenu";
import {
  SourceFileOutline,
  SourceFileSectionDivider,
  type SourceOutlinePathProps,
} from "../components/SourceFileOutline";
import {
  SourceFilePath,
  SourceFileRowButton,
  SourceFileStatusBadge,
} from "../components/SourceFileRow";
import { Button, ButtonBase } from "../components/ui/Button";
import { TextInput } from "../components/ui/Field";
import { Modal } from "../components/ui/Modal";
import { SegmentedControl } from "../components/ui/SegmentedControl";
import { useProjectReviewComments } from "../hooks/useProjectReviewComments";
import { useProjectWorktree } from "../hooks/useProjectWorktree";
import {
  handleSourceListKeyDown,
  useSourceSearchShortcut,
} from "../hooks/useSourceKeyboard";
import type { TranslationFn } from "../i18n";
import { writeClipboardText } from "../lib/clipboard";
import { FileSearchIndex } from "../lib/fileSearchIndex";
import styles from "./BlameBrowser.module.css";
import { BlameView } from "./BlameView";

// The ignored dimension carries only this clone's `.git/info/exclude` paths —
// authored material the user keeps out of commits (private notes, reviews,
// task state) and still wants to read. `.gitignore` content (build output,
// dependencies) is never listed, so this section stays small enough to show
// without asking.
const DEFAULT_WORKTREE_COVERAGE: GitWorktreeCoverage = {
  tracked: true,
  untracked: true,
  ignored: true,
};

/**
 * Current working-tree content, with blame as an optional tracked-file projection.
 * Optional live sections replace the entry-time working-tree snapshot.
 */
export function BlameBrowser({
  projectId,
  isWideScreen,
  initialPath,
  status,
  supportsWorktreeSections = false,
  supportsCompleteFilesystemScan = false,
  onOpenCommit,
  captureReviewProjections = false,
  localSourcePath,
  onLocalSourceRoot,
  t,
}: {
  projectId: string;
  isWideScreen: boolean;
  /** Seed the open file (the commit-diff → file bridge). */
  initialPath?: string;
  /**
   * Browse this allowed absolute path outside the project instead: one
   * snapshot of its checkout or directory, with no live lease, review
   * comments, or blame. The project only authorizes the reads. Callers
   * leave worktree sections off.
   */
  localSourcePath?: string;
  onLocalSourceRoot?: (root: LocalSourceRoot) => void;
  status?: GitStatusInfo;
  supportsWorktreeSections?: boolean;
  supportsCompleteFilesystemScan?: boolean;
  /** Open a populated blame hash in the commit browser. */
  onOpenCommit?: (sha: string) => void;
  captureReviewProjections?: boolean;
  t: TranslationFn;
}) {
  const [workingTreeFiles, setWorkingTreeFiles] = useState<
    GitWorkingTreeFile[]
  >([]);
  const [coverage, setCoverage] = useState<GitWorktreeCoverage>(
    DEFAULT_WORKTREE_COVERAGE,
  );
  const [storedExpandedPrefixes, setStoredExpandedPrefixes] = useState<
    string[]
  >([]);
  const [storedCompleteFilesystemScan, setStoredCompleteFilesystemScan] =
    useState(false);
  const expandedPrefixesProjectId = useRef(projectId);
  const expandedPrefixes =
    expandedPrefixesProjectId.current === projectId
      ? storedExpandedPrefixes
      : [];
  const completeFilesystemScan =
    expandedPrefixesProjectId.current === projectId &&
    storedCompleteFilesystemScan;
  const lazyFilesystemInventory =
    supportsWorktreeSections && status?.isGitRepo === false;
  const liveCoverage = useMemo<GitWorktreeCoverage>(
    () => ({
      ...coverage,
      ...(lazyFilesystemInventory ? { expandedPrefixes } : {}),
      ...(lazyFilesystemInventory &&
      supportsCompleteFilesystemScan &&
      completeFilesystemScan
        ? { filesystemScan: "complete" as const }
        : {}),
    }),
    [
      completeFilesystemScan,
      coverage,
      expandedPrefixes,
      lazyFilesystemInventory,
      supportsCompleteFilesystemScan,
    ],
  );
  const [pointerMoving, setPointerMoving] = useState(false);
  const pointerQuietTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handlePointerMove = useCallback(() => {
    setPointerMoving(true);
    if (pointerQuietTimer.current) clearTimeout(pointerQuietTimer.current);
    pointerQuietTimer.current = setTimeout(() => {
      pointerQuietTimer.current = null;
      setPointerMoving(false);
    }, 200);
  }, []);
  useEffect(
    () => () => {
      if (pointerQuietTimer.current) clearTimeout(pointerQuietTimer.current);
    },
    [],
  );
  useEffect(() => {
    if (expandedPrefixesProjectId.current === projectId) return;
    expandedPrefixesProjectId.current = projectId;
    setStoredExpandedPrefixes([]);
    setStoredCompleteFilesystemScan(false);
  }, [projectId]);
  const liveWorktree = useProjectWorktree(
    projectId,
    liveCoverage,
    supportsWorktreeSections,
    undefined,
    pointerMoving,
  );
  const [inventoryTruncated, setInventoryTruncated] = useState(false);
  const [detailMode, setDetailMode] = useState<"contents" | "blame">(
    "contents",
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selectedPath, setSelectedPath] = useState<string | null>(
    initialPath ?? null,
  );
  const [localRoot, setLocalRoot] = useState<LocalSourceRoot | null>(null);
  const onLocalSourceRootRef = useRef(onLocalSourceRoot);
  onLocalSourceRootRef.current = onLocalSourceRoot;
  // Outside Git every file is equally "untracked"; list them plainly.
  const plainInventory = localRoot !== null && !localRoot.isGitRepo;
  const fileMenu = useSourceContextMenu(t);
  const { pending } = useProjectReviewComments(
    localSourcePath === undefined ? projectId : undefined,
  );
  const pathCommentCount = useMemo(() => {
    const counts = new Map<string, number>();
    for (const comment of pending) {
      counts.set(
        comment.anchor.path,
        (counts.get(comment.anchor.path) ?? 0) + 1,
      );
    }
    return counts;
  }, [pending]);

  // Static snapshots are also used for allowed paths outside the project.
  // Optional live sections own their own inventory and subscription.
  useEffect(() => {
    if (supportsWorktreeSections) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setWorkingTreeFiles([]);
    setInventoryTruncated(false);
    setSelectedPath((current) => initialPath ?? current);
    const request = api
      .listGitWorkingTreeFiles(projectId, undefined, localSourcePath)
      .then((result) => ({
        workingTreeFiles: result.files,
        truncated: result.truncated,
        root: result.root,
      }));
    request
      .then((result) => {
        if (cancelled) return;
        setWorkingTreeFiles(result.workingTreeFiles);
        setInventoryTruncated(result.truncated);
        if (result.root) {
          const root = result.root;
          setLocalRoot(root);
          if (root.requestedFile) setSelectedPath(root.requestedFile);
          onLocalSourceRootRef.current?.(root);
        }
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, initialPath, localSourcePath, supportsWorktreeSections]);

  const effectiveWorkingTreeFiles = useMemo(
    () =>
      supportsWorktreeSections
        ? liveWorktree.files.filter(
            (file) =>
              file.present !== false &&
              coverage[workingTreeKind(file) ?? "untracked"],
          )
        : workingTreeFiles,
    [coverage, liveWorktree.files, supportsWorktreeSections, workingTreeFiles],
  );
  const effectiveFiles = useMemo(
    () => effectiveWorkingTreeFiles.map((file) => file.path),
    [effectiveWorkingTreeFiles],
  );
  const effectiveLoading = supportsWorktreeSections
    ? liveWorktree.loading
    : loading;
  const effectiveError = supportsWorktreeSections
    ? (liveWorktree.error?.message ?? null)
    : error;
  const effectiveInventoryTruncated = supportsWorktreeSections
    ? liveWorktree.truncated
    : inventoryTruncated;
  const effectiveDirectories = lazyFilesystemInventory
    ? liveWorktree.directories
    : [];
  const fileIndex = useMemo(
    () => new FileSearchIndex(effectiveFiles),
    [effectiveFiles],
  );
  const filtered = useMemo(() => fileIndex.search(query), [fileIndex, query]);
  const workingTreeFileByPath = useMemo(
    () =>
      new Map(
        effectiveWorkingTreeFiles.map((file) => [file.path, file] as const),
      ),
    [effectiveWorkingTreeFiles],
  );
  const dirtyStatusByPath = useMemo(() => {
    const dirty = new Map<string, string>();
    if (supportsWorktreeSections) {
      for (const file of liveWorktree.files) {
        const change = file.worktreeChanges?.at(-1);
        if (change) dirty.set(file.path, change.status);
      }
    } else {
      for (const file of status?.files ?? []) dirty.set(file.path, file.status);
    }
    return dirty;
  }, [liveWorktree.files, status?.files, supportsWorktreeSections]);
  const trackedFiles = useMemo(
    () =>
      filtered.filter(
        (path) =>
          workingTreeKind(workingTreeFileByPath.get(path)) === "tracked",
      ),
    [filtered, workingTreeFileByPath],
  );
  const untrackedFiles = useMemo(
    () =>
      filtered.filter(
        (path) =>
          workingTreeKind(workingTreeFileByPath.get(path)) === "untracked",
      ),
    [filtered, workingTreeFileByPath],
  );
  const ignoredFiles = useMemo(
    () =>
      filtered.filter(
        (path) =>
          workingTreeKind(workingTreeFileByPath.get(path)) === "ignored",
      ),
    [filtered, workingTreeFileByPath],
  );
  const selectedWorkingTreeFile = selectedPath
    ? workingTreeFileByPath.get(selectedPath)
    : undefined;

  useEffect(() => {
    if (selectedPath !== null) setDetailMode("contents");
  }, [selectedPath]);

  // A wide file browser is a master-detail view: keep the detail pane useful
  // by selecting the first visible file when there is no still-visible
  // selection. Mobile deliberately stays on the list until the user taps.
  useEffect(() => {
    if (
      !isWideScreen ||
      effectiveLoading ||
      effectiveError ||
      filtered.length === 0
    ) {
      return;
    }
    setSelectedPath((current) =>
      current && filtered.includes(current) ? current : (filtered[0] ?? null),
    );
  }, [effectiveError, effectiveLoading, filtered, isWideScreen]);

  const fileMenuActions = useCallback(
    (file: string): SourceContextMenuAction[] => [
      {
        label: t("sourceOpenFile"),
        onSelect: () => setSelectedPath(file),
      },
      {
        label: t("sourceCopyPath"),
        onSelect: () => {
          void writeClipboardText(file);
        },
      },
    ],
    [t],
  );
  const toggleCoverage = useCallback((kind: GitWorkingTreePathKind) => {
    setCoverage((current) => ({ ...current, [kind]: !current[kind] }));
  }, []);
  const expandedDirectorySet = useMemo(
    () => new Set(expandedPrefixes),
    [expandedPrefixes],
  );
  const toggleDirectory = useCallback((path: string, expanded: boolean) => {
    setStoredExpandedPrefixes((current) => {
      if (!expanded) {
        return current.filter(
          (prefix) => prefix !== path && !prefix.startsWith(`${path}/`),
        );
      }
      const next = new Set(current);
      const segments = path.split("/");
      for (let length = 1; length <= segments.length; length += 1) {
        next.add(segments.slice(0, length).join("/"));
      }
      return [...next].sort((left, right) => {
        const depth = left.split("/").length - right.split("/").length;
        return depth !== 0 ? depth : left.localeCompare(right);
      });
    });
  }, []);
  const renderFileRow = (
    file: string,
    visiblePath = file,
    pathProps?: SourceOutlinePathProps,
  ): ReactNode => {
    const count = pathCommentCount.get(file) ?? 0;
    const menuActions = fileMenuActions(file);
    const inventoryEntry = workingTreeFileByPath.get(file);
    const fileStatus =
      dirtyStatusByPath.get(file) ??
      (!plainInventory && workingTreeKind(inventoryEntry) === "untracked"
        ? "?"
        : undefined);
    return (
      <li key={file} className={`commit-file-row ${sourceRowMenuSurface}`}>
        <SourceFileRowButton
          path={file}
          type="button"
          className={`blame-file-item ${
            selectedPath === file ? "selected" : ""
          }`}
          data-source-list-item
          onFocus={() => {
            if (isWideScreen) setSelectedPath(file);
          }}
          {...fileMenu.targetProps(menuActions, () => {
            setSelectedPath(file);
          })}
        >
          <SourceFilePath {...pathProps} query={query} fullPath={file}>
            {visiblePath}
          </SourceFilePath>
          {fileStatus && <SourceFileStatusBadge status={fileStatus} t={t} />}
          {count > 0 && (
            <span
              className="source-comment-badge"
              title={t("sourceCommentCount", { count })}
            >
              {count}
            </span>
          )}
        </SourceFileRowButton>
        <SourceRowMenuTrigger
          actions={menuActions}
          label={t("sourceMoreActions")}
          onOpen={fileMenu.openFromButton}
        />
      </li>
    );
  };

  return (
    <div className="blame-browser">
      <ResizableSourceColumns
        layout="files"
        initialFilesWidth={340}
        className="blame-browser-columns"
        t={t}
      >
        <div
          className="blame-file-column"
          onPointerMove={
            supportsWorktreeSections ? handlePointerMove : undefined
          }
        >
          {supportsWorktreeSections && (
            <WorktreeSectionControls
              coverage={coverage}
              onToggle={toggleCoverage}
              t={t}
            />
          )}
          <WorkingTreeFilter onQueryChange={setQuery} t={t} />
          {effectiveLoading ? (
            <div className="git-diff-loading">{t("gitStatusLoading")}</div>
          ) : effectiveError ? (
            <div className="git-diff-error">{effectiveError}</div>
          ) : (
            <WorkingTreeFileList
              trackedFiles={plainInventory ? filtered : trackedFiles}
              untrackedFiles={plainInventory ? [] : untrackedFiles}
              ignoredFiles={ignoredFiles}
              directories={effectiveDirectories}
              coverage={coverage}
              sectionsEnabled={supportsWorktreeSections}
              onToggle={toggleCoverage}
              {...(lazyFilesystemInventory
                ? {
                    expandedDirectories: expandedDirectorySet,
                    onToggleDirectory: toggleDirectory,
                  }
                : {})}
              scopeKey={projectId}
              query={query}
              truncated={effectiveInventoryTruncated}
              totalFiles={liveWorktree.totalFiles}
              onShowAll={
                lazyFilesystemInventory &&
                supportsCompleteFilesystemScan &&
                !completeFilesystemScan &&
                liveWorktree.totalFiles !== null &&
                liveWorktree.totalFiles > liveWorktree.files.length
                  ? () => setStoredCompleteFilesystemScan(true)
                  : undefined
              }
              renderFile={renderFileRow}
              t={t}
            />
          )}
        </div>

        {isWideScreen && selectedPath && (
          <WorkingTreeFileDetail
            projectId={projectId}
            path={selectedPath}
            viewerPath={
              localRoot
                ? joinLocalSourcePath(localRoot.path, selectedPath)
                : selectedPath
            }
            tracked={
              localRoot === null && (selectedWorkingTreeFile?.tracked ?? false)
            }
            mode={detailMode}
            onModeChange={setDetailMode}
            onOpenCommit={onOpenCommit}
            captureReviewProjections={captureReviewProjections}
            t={t}
          />
        )}
      </ResizableSourceColumns>
      {fileMenu.menu}

      {!isWideScreen && selectedPath && (
        <Modal
          title={selectedPath}
          onClose={() => setSelectedPath(null)}
          closeOnBackGesture
        >
          <WorkingTreeFileDetail
            projectId={projectId}
            path={selectedPath}
            viewerPath={
              localRoot
                ? joinLocalSourcePath(localRoot.path, selectedPath)
                : selectedPath
            }
            tracked={
              localRoot === null && (selectedWorkingTreeFile?.tracked ?? false)
            }
            mode={detailMode}
            onModeChange={setDetailMode}
            onOpenCommit={onOpenCommit}
            captureReviewProjections={captureReviewProjections}
            t={t}
          />
        </Modal>
      )}
    </div>
  );
}

/** Keep input acknowledgement outside inventory and file-detail rendering. */
function WorkingTreeFilter({
  onQueryChange,
  t,
}: {
  onQueryChange: (query: string) => void;
  t: TranslationFn;
}) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useSourceSearchShortcut(inputRef);
  const update = (next: string) => {
    setValue(next);
    startTransition(() => onQueryChange(next));
  };
  return (
    <div className="source-search-field">
      <TextInput
        ref={inputRef}
        type="search"
        size="small"
        className="source-search-input"
        value={value}
        placeholder={t("sourceFilterFiles")}
        aria-keyshortcuts="/"
        onKeyDown={(event) => {
          if (event.key === "Escape" && value) {
            event.preventDefault();
            update("");
          }
        }}
        onChange={(event) => update(event.target.value)}
      />
      <kbd className="source-search-shortcut">/</kbd>
    </div>
  );
}

function WorktreeSectionControls({
  coverage,
  onToggle,
  t,
}: {
  coverage: GitWorktreeCoverage;
  onToggle: (kind: GitWorkingTreePathKind) => void;
  t: TranslationFn;
}) {
  const sections: Array<{
    kind: GitWorkingTreePathKind;
    label: string;
  }> = [
    { kind: "tracked", label: t("sourceTrackedFiles") },
    { kind: "untracked", label: t("sourceUntrackedFiles") },
    { kind: "ignored", label: t("sourceIgnoredFiles") },
  ];
  return (
    <fieldset
      className={styles.sectionControls}
      aria-label={t("sourceWorkingTreeSections")}
    >
      {sections.map(({ kind, label }) => (
        <ButtonBase
          key={kind}
          className={`${styles.sectionToggle} ${
            coverage[kind] ? styles.activeSectionToggle : ""
          }`}
          aria-pressed={coverage[kind]}
          onClick={() => onToggle(kind)}
        >
          <span aria-hidden="true">{coverage[kind] ? "●" : "○"}</span>
          {label}
        </ButtonBase>
      ))}
    </fieldset>
  );
}

function WorkingTreeFileList({
  trackedFiles,
  untrackedFiles,
  ignoredFiles,
  directories,
  coverage,
  sectionsEnabled,
  onToggle,
  expandedDirectories,
  onToggleDirectory,
  scopeKey,
  query,
  truncated,
  totalFiles,
  onShowAll,
  renderFile,
  t,
}: {
  trackedFiles: string[];
  untrackedFiles: string[];
  ignoredFiles: string[];
  directories: readonly GitWorktreeDirectory[];
  coverage: GitWorktreeCoverage;
  sectionsEnabled: boolean;
  onToggle: (kind: GitWorkingTreePathKind) => void;
  expandedDirectories?: ReadonlySet<string>;
  onToggleDirectory?: (path: string, expanded: boolean) => void;
  scopeKey: string;
  query: string;
  truncated: boolean;
  totalFiles: number | null;
  onShowAll?: () => void;
  renderFile: (
    path: string,
    visiblePath?: string,
    pathProps?: SourceOutlinePathProps,
  ) => ReactNode;
  t: TranslationFn;
}) {
  const searching = query.trim().length > 0;
  const renderOutline = (
    files: string[],
    section: string,
    sectionDirectories: readonly GitWorktreeDirectory[] = [],
  ) => (
    <SourceFileOutline
      className="blame-file-list"
      items={files.map((path) => ({
        id: path,
        path,
        displayPath: path,
        value: path,
      }))}
      directories={sectionDirectories}
      {...(expandedDirectories && onToggleDirectory
        ? { expandedDirectories, onToggleDirectory }
        : {})}
      scopeKey={`${scopeKey}:${section}`}
      query={query}
      renderFile={(item, visiblePath, pathProps) =>
        renderFile(item.value, visiblePath, pathProps)
      }
      t={t}
    />
  );
  const sections: Array<{
    kind: GitWorkingTreePathKind;
    label: string;
    files: string[];
  }> = [
    {
      kind: "tracked",
      label: t("sourceTrackedFiles"),
      files: trackedFiles,
    },
    {
      kind: "untracked",
      label: t("sourceUntrackedFiles"),
      files: untrackedFiles,
    },
    {
      kind: "ignored",
      label: t("sourceIgnoredFiles"),
      files: ignoredFiles,
    },
  ];

  if (!sectionsEnabled) {
    return (
      // biome-ignore lint/a11y/noStaticElementInteractions: delegates arrow traversal across the sectioned file lists to their nested controls
      <div className={styles.inventory} onKeyDown={handleSourceListKeyDown}>
        {trackedFiles.length > 0 && renderOutline(trackedFiles, "tracked")}
        {untrackedFiles.length > 0 && (
          <>
            <SourceFileSectionDivider>
              {t("sourceUntrackedFiles")}
            </SourceFileSectionDivider>
            {renderOutline(untrackedFiles, "untracked")}
          </>
        )}
      </div>
    );
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: delegates arrow traversal across the sectioned file lists to their nested controls
    <div className={styles.inventory} onKeyDown={handleSourceListKeyDown}>
      {sections.map(({ kind, label, files }) => (
        <div key={kind}>
          <SourceFileSectionDivider
            expanded={coverage[kind]}
            onToggle={() => onToggle(kind)}
          >
            {label}
          </SourceFileSectionDivider>
          {coverage[kind] &&
            (files.length > 0 ||
              (kind === "untracked" && directories.length > 0)) &&
            renderOutline(files, kind, kind === "untracked" ? directories : [])}
        </div>
      ))}
      {truncated && !searching && (
        <div className={styles.truncated} role="status">
          <span aria-hidden="true">…</span>
          {onShowAll && totalFiles !== null ? (
            <Button variant="ghost" size="small" onClick={onShowAll}>
              {t("sourceWorkingTreeShowAll", { count: totalFiles })}
            </Button>
          ) : totalFiles !== null ? (
            t("sourceWorkingTreeFilesIncomplete", { count: totalFiles })
          ) : (
            t("sourceWorkingTreeFilesTruncated", {
              count:
                trackedFiles.length +
                untrackedFiles.length +
                ignoredFiles.length,
            })
          )}
        </div>
      )}
    </div>
  );
}

function workingTreeKind(
  file: GitWorkingTreeFile | undefined,
): GitWorkingTreePathKind | undefined {
  return (
    file?.kind ?? (file ? (file.tracked ? "tracked" : "untracked") : undefined)
  );
}

/** Absolute viewer path for an inventory path under a local source root. */
function joinLocalSourcePath(root: string, path: string): string {
  const separator = root.includes("/") || !root.includes("\\") ? "/" : "\\";
  return `${root.replace(/[\\/]+$/, "")}${separator}${path}`;
}

function WorkingTreeFileDetail({
  projectId,
  path,
  viewerPath,
  tracked,
  mode,
  onModeChange,
  onOpenCommit,
  captureReviewProjections,
  t,
}: {
  projectId: string;
  path: string;
  /** What the contents viewer opens; differs from `path` for a local root. */
  viewerPath: string;
  tracked: boolean;
  mode: "contents" | "blame";
  onModeChange: (mode: "contents" | "blame") => void;
  onOpenCommit?: (sha: string) => void;
  captureReviewProjections: boolean;
  t: TranslationFn;
}) {
  const effectiveMode = tracked ? mode : "contents";
  return (
    <section className={styles.detail}>
      {tracked && (
        <div className={styles.detailModes}>
          <SegmentedControl
            size="small"
            aria-label={t("sourceViewMode")}
            options={[
              { value: "contents", label: t("sourceViewContents") },
              { value: "blame", label: t("sourceViewBlame") },
            ]}
            value={effectiveMode}
            onChange={onModeChange}
          />
        </div>
      )}
      {effectiveMode === "blame" ? (
        <BlameView
          projectId={projectId}
          path={path}
          onOpenCommit={onOpenCommit}
          captureReviewProjections={captureReviewProjections}
          t={t}
        />
      ) : (
        <FileViewer projectId={projectId} filePath={viewerPath} />
      )}
    </section>
  );
}
