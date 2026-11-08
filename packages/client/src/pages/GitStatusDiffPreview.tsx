import type {
  GitDiffPreviewSkipped,
  GitDiffResult,
  GitFileChange,
  GitFileDiffMode,
  PatchHunk,
  ReviewCommentRevision,
} from "@yep-anywhere/shared";
import {
  forwardRef,
  type CSSProperties,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api } from "../api/client";
import { CopyButton } from "../components/CopyButton";
import { FileRevisionLink } from "../components/FileRevisionLink";
import { MarkdownPreview } from "../components/MarkdownPreview";
import { IconButton } from "../components/ui/Button";
import { renderFixedFontRichContent } from "../components/ui/FixedFontMathToggle";
import { Modal } from "../components/ui/Modal";
import { useDiffViewMode } from "../hooks/useDiffViewMode";
import { isEditableKeyboardTarget } from "../hooks/useSourceKeyboard";
import { type DiffViewMode, resolveDiffViewMode } from "../lib/diffSideBySide";
import { isMarkdownLikeFile } from "../lib/markdownFiles";
import {
  captureScrollPositionAnchor,
  restoreScrollPositionAnchor,
  type ScrollPositionAnchor,
} from "../lib/scrollAnchor";
import { DiffCommentController } from "./DiffCommentLayer";
import { SideBySideDiff } from "./SideBySideDiff";
import { CHANGED_DIFF_LINE_SELECTOR, UnifiedDiff } from "./UnifiedDiff";
import type { MessageKey, TranslationFn } from "../i18n";
import styles from "./GitStatusDiffPreview.module.css";
import headerStyles from "../components/ViewerHeader.module.css";

const GIT_DIFF_MAX_RENDERED_HTML_CHARS = 1_000_000 * 20;

function getDiffSourceText(hunks: PatchHunk[]): string {
  return hunks.flatMap((hunk) => hunk.lines).join("\n");
}

function getPostChangeText(hunks: PatchHunk[]): string | null {
  if (hunks.length === 0) return null;
  return hunks
    .map((hunk) =>
      hunk.lines
        .filter((line) => line.startsWith(" ") || line.startsWith("+"))
        .map((line) => line.slice(1))
        .join("\n"),
    )
    .join("\n");
}

function getDiffScrollRoot(content: HTMLElement): HTMLElement {
  return (
    content.closest<HTMLElement>(".git-diff-preview-body, .modal-content") ??
    content
  );
}

export interface GitDiffViewState {
  showFullContext?: boolean;
  hideRemovedLines?: boolean;
  showMarkdownPreview?: boolean;
}

interface GitDiffPreviewRetentionProps {
  retainedDiffView?: GitDiffViewState;
  onRetainDiffView?: (fileKey: string, view: GitDiffViewState) => void;
}

interface GitDiffScrollRetentionProps {
  retainedScrollRatio?: number;
  onRetainScrollRatio?: (fileKey: string, ratio: number) => void;
}

interface DiffPaneHeader {
  title: string;
  path: string;
  actions?: ReactNode;
  revision?: ReactNode;
}

export interface GitDiffPreviewHandle {
  /** Advance to the next rendered diff hunk, wrapping at the end. */
  jumpToNextHunk: () => boolean;
  /** Move to the previous rendered diff hunk, wrapping at the start. */
  jumpToPreviousHunk: () => boolean;
  /** Scroll the rendered diff by one viewport without moving keyboard focus. */
  scrollByPage: (direction: -1 | 1) => void;
}

interface HunkNavigationHandlers {
  next: () => boolean;
  previous: () => boolean;
}

interface GitDiffPreviewProps
  extends GitDiffPreviewRetentionProps,
    GitDiffScrollRetentionProps {
  file: GitFileChange | null;
  fileKey: string | null;
  projectId: string;
  source?: GitDiffSource;
  /** Actions for the selected file, shown in the pane header (the file banner). */
  headerActions?: ReactNode;
  onCommentEditorOpenChange?: (open: boolean) => void;
  captureReviewProjections?: boolean;
  ignoreWhitespace?: boolean;
  onToggleIgnoreWhitespace?: () => void;
  onProjectionRequestFailure?: (error: unknown) => void;
  t: TranslationFn;
}

/**
 * Which revision a diff pane shows: the working tree (an `uncommitted`
 * comment anchor) or a specific commit (a `sha` anchor). The commit browser
 * reuses this whole diff+comment stack by passing `{ kind: "commit", sha }`,
 * so a comment left on a commit diff flows through the exact same
 * relocation/compose pipeline as a working-tree comment.
 */
export type GitDiffSource =
  | { kind: "worktree" }
  | { kind: "working-tree-history" }
  | { kind: "commit"; sha: string }
  | { kind: "comparison"; baseSha: string; headSha: string }
  | { kind: "inclusive-comparison"; baseSha: string; headSha: string }
  | { kind: "file-projection"; mode: GitFileDiffMode };

const WORKTREE_SOURCE: GitDiffSource = { kind: "worktree" };
const WORKING_TREE_HISTORY_SOURCE: GitDiffSource = {
  kind: "working-tree-history",
};

function revisionForDiffSource(source: GitDiffSource): string | undefined {
  if (source.kind === "commit") return source.sha;
  if (source.kind === "comparison" || source.kind === "inclusive-comparison") {
    return source.headSha;
  }
  return undefined;
}

function getRelativeScrollRatio(element: HTMLElement): number {
  const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
  if (maxScrollTop === 0) return 0;
  return Math.min(1, Math.max(0, element.scrollTop / maxScrollTop));
}

function restoreRelativeScrollRatio(element: HTMLElement, ratio: number): void {
  const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
  element.scrollTop = maxScrollTop * Math.min(1, Math.max(0, ratio));
}

/**
 * Rebuild a source from its primitives. Effects depend on (kind, sha) rather
 * than the source object, whose identity changes every render.
 */
function sourceFromPrimitives(
  kind: GitDiffSource["kind"],
  baseSha: string,
  headSha: string,
  fileDiffMode: GitFileDiffMode,
): GitDiffSource {
  return kind === "commit"
    ? { kind: "commit", sha: baseSha }
    : kind === "comparison" || kind === "inclusive-comparison"
      ? { kind, baseSha, headSha }
      : kind === "file-projection"
        ? { kind: "file-projection", mode: fileDiffMode }
        : kind === "working-tree-history"
          ? WORKING_TREE_HISTORY_SOURCE
          : WORKTREE_SOURCE;
}

function fetchDiffForSource(
  projectId: string,
  file: GitFileChange,
  source: GitDiffSource,
  fullContext?: boolean,
  ignoreWhitespace?: boolean,
): Promise<GitDiffResult> {
  if (source.kind === "commit") {
    return api.getGitCommitDiff(projectId, {
      sha: source.sha,
      path: file.path,
      status: file.status,
      ...(file.origPath ? { origPath: file.origPath } : {}),
      fullContext,
      ...(ignoreWhitespace ? { ignoreWhitespace: true } : {}),
    });
  }
  if (source.kind === "comparison" || source.kind === "inclusive-comparison") {
    const getDiff =
      source.kind === "inclusive-comparison"
        ? api.getGitInclusiveComparisonDiff
        : api.getGitComparisonDiff;
    return getDiff(projectId, {
      baseSha: source.baseSha,
      headSha: source.headSha,
      path: file.path,
      status: file.status,
      ...(file.origPath ? { origPath: file.origPath } : {}),
      fullContext,
      ...(ignoreWhitespace ? { ignoreWhitespace: true } : {}),
    });
  }
  if (source.kind === "file-projection") {
    return api.getGitFileProjectionDiff(projectId, {
      path: file.path,
      mode: source.mode,
      ...(file.origPath ? { origPath: file.origPath } : {}),
      fullContext,
    });
  }
  return api.getGitDiff(projectId, {
    path: file.path,
    staged: file.staged,
    status: file.status,
    ...(source.kind === "working-tree-history"
      ? {
          againstHead: true,
          ...(file.origPath ? { origPath: file.origPath } : {}),
        }
      : {}),
    fullContext,
    ...(ignoreWhitespace ? { ignoreWhitespace: true } : {}),
  });
}

function commentRevisionsForSource(source: GitDiffSource):
  | {
      old: ReviewCommentRevision;
      new: ReviewCommentRevision;
    }
  | undefined {
  if (source.kind === "commit") {
    const revision: ReviewCommentRevision = {
      kind: "sha",
      sha: source.sha,
    };
    return { old: revision, new: revision };
  }
  if (source.kind === "comparison" || source.kind === "inclusive-comparison") {
    return {
      old: { kind: "sha", sha: source.baseSha },
      new: { kind: "sha", sha: source.headSha },
    };
  }
  return undefined;
}

export const GitDiffPreview = forwardRef<
  GitDiffPreviewHandle,
  GitDiffPreviewProps
>(function GitDiffPreview(
  {
    file,
    fileKey,
    projectId,
    source = WORKTREE_SOURCE,
    headerActions,
    retainedScrollRatio,
    retainedDiffView,
    onRetainScrollRatio,
    onRetainDiffView,
    onCommentEditorOpenChange,
    captureReviewProjections = false,
    ignoreWhitespace = false,
    onToggleIgnoreWhitespace,
    onProjectionRequestFailure,
    t,
  },
  ref,
) {
  const fileName = file ? file.path.split("/").pop() || file.path : null;
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const hunkNavigationRef = useRef<HunkNavigationHandlers | null>(null);
  const handleHunkNavigationChange = useCallback(
    (handlers: HunkNavigationHandlers | null) => {
      hunkNavigationRef.current = handlers;
    },
    [],
  );

  useImperativeHandle(
    ref,
    () => ({
      jumpToNextHunk: () => hunkNavigationRef.current?.next() ?? false,
      jumpToPreviousHunk: () => hunkNavigationRef.current?.previous() ?? false,
      scrollByPage: (direction) => {
        const body = bodyRef.current;
        if (!body) return;
        const maxScrollTop = Math.max(0, body.scrollHeight - body.clientHeight);
        body.scrollTop = Math.min(
          maxScrollTop,
          Math.max(0, body.scrollTop + direction * body.clientHeight),
        );
      },
    }),
    [],
  );

  useLayoutEffect(() => {
    const scrollContainer = bodyRef.current;
    return () => {
      if (!fileKey || !scrollContainer) {
        return;
      }
      onRetainScrollRatio?.(fileKey, getRelativeScrollRatio(scrollContainer));
    };
  }, [fileKey, onRetainScrollRatio]);

  return (
    <section className="git-diff-preview-pane">
      <div className="git-diff-preview-body" ref={bodyRef}>
        {file && fileKey ? (
          <GitDiffBody
            file={file}
            fileKey={fileKey}
            projectId={projectId}
            source={source}
            retainedScrollRatio={retainedScrollRatio}
            scrollContainerRef={bodyRef}
            retainedDiffView={retainedDiffView}
            onRetainDiffView={onRetainDiffView}
            paneHeader={{
              title: fileName ?? file.path,
              path: file.path,
              actions: headerActions,
              revision: (
                <FileRevisionLink
                  showAuthor
                  projectId={projectId}
                  path={file.path}
                  origPath={
                    revisionForDiffSource(source) ? undefined : file.origPath
                  }
                  rev={revisionForDiffSource(source)}
                  dirtyLabel={t("fileRevisionDirty" as never)}
                  uncommittedLabel={t("fileRevisionUncommitted" as never)}
                />
              ),
            }}
            onHunkNavigationChange={handleHunkNavigationChange}
            onCommentEditorOpenChange={onCommentEditorOpenChange}
            captureReviewProjections={captureReviewProjections}
            ignoreWhitespace={ignoreWhitespace}
            onToggleIgnoreWhitespace={onToggleIgnoreWhitespace}
            onProjectionRequestFailure={onProjectionRequestFailure}
            t={t}
          />
        ) : (
          <>
            <DiffPaneToolbar
              title={t("gitStatusDiffPreview")}
              path=""
              actions={headerActions}
            />
            <div className="git-diff-placeholder">
              {t("gitStatusSelectFileForDiff")}
            </div>
          </>
        )}
      </div>
    </section>
  );
});

export function GitDiffModal({
  file,
  fileKey,
  projectId,
  source = WORKTREE_SOURCE,
  headerActions,
  retainedScrollRatio,
  retainedDiffView,
  onRetainScrollRatio,
  onRetainDiffView,
  onCommentEditorOpenChange,
  captureReviewProjections = false,
  ignoreWhitespace = false,
  onToggleIgnoreWhitespace,
  onProjectionRequestFailure,
  t,
  onClose,
}: {
  file: GitFileChange;
  fileKey: string;
  projectId: string;
  source?: GitDiffSource;
  /** Actions for the selected file, shown above the diff (the file banner). */
  headerActions?: ReactNode;
  retainedScrollRatio?: number;
  retainedDiffView?: GitDiffViewState;
  onRetainScrollRatio?: (fileKey: string, ratio: number) => void;
  onRetainDiffView?: (fileKey: string, view: GitDiffViewState) => void;
  onCommentEditorOpenChange?: (open: boolean) => void;
  captureReviewProjections?: boolean;
  ignoreWhitespace?: boolean;
  onToggleIgnoreWhitespace?: () => void;
  onProjectionRequestFailure?: (error: unknown) => void;
  t: TranslationFn;
  onClose: () => void;
}) {
  const bodyRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const scrollContainer = bodyRef.current;
    return () => {
      if (!scrollContainer) return;
      onRetainScrollRatio?.(fileKey, getRelativeScrollRatio(scrollContainer));
    };
  }, [fileKey, onRetainScrollRatio]);

  return (
    <Modal
      title={file.path}
      onClose={onClose}
      closeOnBackGesture
      contentRef={bodyRef}
    >
      <div className="git-diff-preview-header-actions">
        <FileRevisionLink
          showAuthor
          projectId={projectId}
          path={file.path}
          origPath={revisionForDiffSource(source) ? undefined : file.origPath}
          rev={revisionForDiffSource(source)}
          dirtyLabel={t("fileRevisionDirty" as never)}
          uncommittedLabel={t("fileRevisionUncommitted" as never)}
        />
        {headerActions}
      </div>
      <GitDiffBody
        file={file}
        fileKey={fileKey}
        projectId={projectId}
        source={source}
        retainedScrollRatio={retainedScrollRatio}
        scrollContainerRef={bodyRef}
        retainedDiffView={retainedDiffView}
        onRetainDiffView={onRetainDiffView}
        onCommentEditorOpenChange={onCommentEditorOpenChange}
        captureReviewProjections={captureReviewProjections}
        ignoreWhitespace={ignoreWhitespace}
        onToggleIgnoreWhitespace={onToggleIgnoreWhitespace}
        onProjectionRequestFailure={onProjectionRequestFailure}
        t={t}
      />
    </Modal>
  );
}

export function GitDiffBody({
  file,
  fileKey,
  projectId,
  source = WORKTREE_SOURCE,
  retainedDiffView,
  onRetainDiffView,
  paneHeader,
  onHunkNavigationChange,
  onCommentEditorOpenChange,
  captureReviewProjections = false,
  ignoreWhitespace = false,
  onToggleIgnoreWhitespace,
  onProjectionRequestFailure,
  retainedScrollRatio,
  scrollContainerRef,
  t,
}: {
  file: GitFileChange;
  fileKey: string;
  projectId: string;
  source?: GitDiffSource;
  paneHeader?: DiffPaneHeader;
  onHunkNavigationChange?: (handlers: HunkNavigationHandlers | null) => void;
  onCommentEditorOpenChange?: (open: boolean) => void;
  captureReviewProjections?: boolean;
  ignoreWhitespace?: boolean;
  onToggleIgnoreWhitespace?: () => void;
  onProjectionRequestFailure?: (error: unknown) => void;
  retainedScrollRatio?: number;
  scrollContainerRef?: RefObject<HTMLElement | null>;
  t: TranslationFn;
} & GitDiffPreviewRetentionProps) {
  // Depend on the source's primitives (a fresh `{kind,sha}` object each render
  // would refetch on every render); reconstruct it inside the effect.
  const sourceKind = source.kind;
  const sourceBaseSha =
    source.kind === "commit"
      ? source.sha
      : source.kind === "comparison" || source.kind === "inclusive-comparison"
        ? source.baseSha
        : "";
  const sourceHeadSha =
    source.kind === "comparison" || source.kind === "inclusive-comparison"
      ? source.headSha
      : "";
  const sourceFileDiffMode =
    source.kind === "file-projection" ? source.mode : "worktree";
  const requestKey = JSON.stringify([
    fileKey,
    sourceKind,
    sourceBaseSha,
    sourceHeadSha,
    sourceFileDiffMode,
    ignoreWhitespace,
  ]);
  const [loadState, setLoadState] = useState<{
    requestKey: string;
    result: GitDiffResult | null;
    loading: boolean;
    error: string | null;
  }>(() => ({
    requestKey,
    result: null,
    loading: true,
    error: null,
  }));
  const currentLoad =
    loadState.requestKey === requestKey
      ? loadState
      : {
          requestKey,
          result: null,
          loading: true,
          error: null,
        };
  const { result: diffResult, loading, error } = currentLoad;
  const liveDiffViewRef = useRef<{
    fileKey: string;
    view: GitDiffViewState | undefined;
  }>({ fileKey, view: retainedDiffView });
  if (liveDiffViewRef.current.fileKey !== fileKey) {
    liveDiffViewRef.current = { fileKey, view: retainedDiffView };
  }
  const retainLiveDiffView = useCallback(
    (retainedFileKey: string, view: GitDiffViewState) => {
      if (liveDiffViewRef.current.fileKey === retainedFileKey) {
        liveDiffViewRef.current.view = {
          ...liveDiffViewRef.current.view,
          ...view,
        };
      }
      onRetainDiffView?.(retainedFileKey, view);
    },
    [onRetainDiffView],
  );
  const visibleDiffResultRef = useRef(diffResult);
  const pendingScrollRef = useRef<{
    fileKey: string;
    ratio: number;
  } | null>(
    retainedScrollRatio === undefined
      ? null
      : { fileKey, ratio: retainedScrollRatio },
  );
  visibleDiffResultRef.current = diffResult;

  useLayoutEffect(() => {
    pendingScrollRef.current =
      retainedScrollRatio === undefined
        ? null
        : { fileKey, ratio: retainedScrollRatio };
  }, [fileKey, retainedScrollRatio]);

  useLayoutEffect(() => {
    const pendingScroll = pendingScrollRef.current;
    if (!diffResult || pendingScroll?.fileKey !== fileKey) return;
    const scrollContainer = scrollContainerRef?.current;
    if (!scrollContainer) return;
    restoreRelativeScrollRatio(scrollContainer, pendingScroll.ratio);
    pendingScrollRef.current = null;
  }, [diffResult, fileKey, scrollContainerRef]);

  useEffect(() => {
    let cancelled = false;
    // A working-tree status poll intentionally refetches the live diff, even
    // when its summary fields are unchanged, so `file` is a deliberate
    // dependency: a new snapshot must reload. The owning browser is
    // responsible for only handing over a new `file` when the snapshot
    // actually changed. Retain the current result while that request runs so
    // user-owned state inside GitDiffContent (notably an open comment editor)
    // remains mounted.
    setLoadState((current) =>
      current.requestKey === requestKey
        ? { ...current, loading: true, error: null }
        : {
            requestKey,
            result: null,
            loading: true,
            error: null,
          },
    );

    fetchDiffForSource(
      projectId,
      file,
      sourceFromPrimitives(
        sourceKind,
        sourceBaseSha,
        sourceHeadSha,
        sourceFileDiffMode,
      ),
      undefined,
      ignoreWhitespace,
    )
      .then((result) => {
        if (!cancelled) {
          const scrollContainer = scrollContainerRef?.current;
          if (visibleDiffResultRef.current && scrollContainer) {
            pendingScrollRef.current = {
              fileKey,
              ratio: getRelativeScrollRatio(scrollContainer),
            };
          }
          setLoadState({
            requestKey,
            result,
            loading: false,
            error: null,
          });
        }
      })
      .catch((err) => {
        if (!cancelled) {
          if (
            ignoreWhitespace ||
            sourceKind === "comparison" ||
            sourceKind === "inclusive-comparison"
          ) {
            onProjectionRequestFailure?.(err);
          }
          const message = err.message || t("gitStatusLoadDiffFailed");
          setLoadState((current) =>
            current.requestKey === requestKey
              ? { ...current, loading: false, error: message }
              : {
                  requestKey,
                  result: null,
                  loading: false,
                  error: message,
                },
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    projectId,
    file,
    fileKey,
    requestKey,
    sourceKind,
    sourceBaseSha,
    sourceHeadSha,
    sourceFileDiffMode,
    ignoreWhitespace,
    onProjectionRequestFailure,
    scrollContainerRef,
    t,
  ]);

  const initialLoading = loading && !diffResult;

  return (
    <>
      {paneHeader && (initialLoading || (!diffResult && error)) && (
        <DiffPaneToolbar
          title={paneHeader.title}
          path={paneHeader.path}
          actions={paneHeader.actions}
          revision={paneHeader.revision}
        />
      )}
      {initialLoading && (
        <div className="git-diff-loading">{t("gitStatusLoadingDiff")}</div>
      )}
      {!diffResult && error && <div className="git-diff-error">{error}</div>}
      {diffResult && (
        <>
          {error && <div className="git-diff-error">{error}</div>}
          <GitDiffContent
            key={requestKey}
            file={file}
            fileKey={fileKey}
            projectId={projectId}
            source={source}
            diffResult={diffResult}
            retainedDiffView={liveDiffViewRef.current.view}
            onRetainDiffView={retainLiveDiffView}
            paneHeader={paneHeader}
            onHunkNavigationChange={onHunkNavigationChange}
            onCommentEditorOpenChange={onCommentEditorOpenChange}
            captureReviewProjections={captureReviewProjections}
            ignoreWhitespace={ignoreWhitespace}
            onToggleIgnoreWhitespace={onToggleIgnoreWhitespace}
            onProjectionRequestFailure={onProjectionRequestFailure}
            t={t}
          />
        </>
      )}
    </>
  );
}

function GitDiffContent({
  file,
  fileKey,
  projectId,
  source = WORKTREE_SOURCE,
  diffResult,
  retainedDiffView,
  onRetainDiffView,
  paneHeader,
  onHunkNavigationChange,
  onCommentEditorOpenChange,
  captureReviewProjections = false,
  ignoreWhitespace = false,
  onToggleIgnoreWhitespace,
  onProjectionRequestFailure,
  t,
}: {
  file: GitFileChange;
  fileKey: string;
  projectId: string;
  source?: GitDiffSource;
  diffResult: GitDiffResult;
  paneHeader?: DiffPaneHeader;
  onHunkNavigationChange?: (handlers: HunkNavigationHandlers | null) => void;
  onCommentEditorOpenChange?: (open: boolean) => void;
  captureReviewProjections?: boolean;
  ignoreWhitespace?: boolean;
  onToggleIgnoreWhitespace?: () => void;
  onProjectionRequestFailure?: (error: unknown) => void;
  t: TranslationFn;
} & GitDiffPreviewRetentionProps) {
  const [showFullContext, setShowFullContext] = useState(
    () =>
      (retainedDiffView?.showFullContext ?? false) ||
      (retainedDiffView?.hideRemovedLines ?? false),
  );
  const [hideRemovedLines, setHideRemovedLines] = useState(
    () => retainedDiffView?.hideRemovedLines ?? false,
  );
  const fullContextRevisionKey = useMemo(
    () =>
      JSON.stringify([
        diffResult.structuredPatch,
        diffResult.previewSkipped ?? null,
      ]),
    [diffResult.previewSkipped, diffResult.structuredPatch],
  );
  const [fullContextLoad, setFullContextLoad] = useState<{
    revisionKey: string | null;
    result: GitDiffResult | null;
    loading: boolean;
    error: string | null;
  }>({
    revisionKey: null,
    result: null,
    loading: false,
    error: null,
  });
  const currentFullContextLoad =
    fullContextLoad.revisionKey === fullContextRevisionKey
      ? fullContextLoad
      : {
          revisionKey: fullContextRevisionKey,
          result: null,
          loading: false,
          error: null,
        };
  const {
    result: fullContextResult,
    loading: contextLoading,
    error: contextError,
  } = currentFullContextLoad;
  const [showMarkdownPreview, setShowMarkdownPreview] = useState(
    () => retainedDiffView?.showMarkdownPreview ?? false,
  );
  const contentRef = useRef<HTMLDivElement>(null);
  const pendingScrollAnchorRef = useRef<ScrollPositionAnchor | null>(null);
  const [contentElement, setContentElement] = useState<HTMLDivElement | null>(
    null,
  );
  const mountContent = useCallback((node: HTMLDivElement | null) => {
    contentRef.current = node;
    setContentElement(node);
  }, []);
  const [viewMode, setViewMode] = useDiffViewMode();
  const [paneWidth, setPaneWidth] = useState(0);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [toolbarHeight, setToolbarHeight] = useState(0);
  const sourceKind = source.kind;
  const sourceBaseSha =
    source.kind === "commit"
      ? source.sha
      : source.kind === "comparison" || source.kind === "inclusive-comparison"
        ? source.baseSha
        : "";
  const sourceHeadSha =
    source.kind === "comparison" || source.kind === "inclusive-comparison"
      ? source.headSha
      : "";
  const sourceFileDiffMode =
    source.kind === "file-projection" ? source.mode : "worktree";
  const commentRevisions = useMemo(
    () =>
      commentRevisionsForSource(
        sourceFromPrimitives(
          sourceKind,
          sourceBaseSha,
          sourceHeadSha,
          sourceFileDiffMode,
        ),
      ),
    [sourceBaseSha, sourceFileDiffMode, sourceHeadSha, sourceKind],
  );
  // Measure the diff pane (content width, not viewport) so `auto` can pick
  // side-by-side only when two readable code columns fit.
  useEffect(() => {
    const el = contentRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      setPaneWidth(el.clientWidth);
      setToolbarHeight(toolbarRef.current?.offsetHeight ?? 0);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    if (toolbarRef.current) observer.observe(toolbarRef.current);
    return () => observer.disconnect();
  }, []);

  const cycleViewMode = useCallback(() => {
    setViewMode(
      viewMode === "auto"
        ? "unified"
        : viewMode === "unified"
          ? "side-by-side"
          : "auto",
    );
  }, [viewMode, setViewMode]);

  const isMarkdown = isMarkdownLikeFile(file.path);
  const diffOnlyRendered = useMemo(
    () =>
      isMarkdown
        ? renderFixedFontRichContent(
            getDiffSourceText(diffResult.structuredPatch),
            {
              diffAware: true,
              baseFilePath: file.path,
              projectId,
            },
          )
        : null,
    [diffResult.structuredPatch, file.path, isMarkdown, projectId],
  );
  const fullContextText = useMemo(
    () =>
      fullContextResult
        ? getPostChangeText(fullContextResult.structuredPatch)
        : null,
    [fullContextResult],
  );
  const fullContextRendered = useMemo(
    () =>
      !isMarkdown || fullContextText === null || fullContextResult?.markdownHtml
        ? null
        : renderFixedFontRichContent(fullContextText, {
            baseFilePath: file.path,
            projectId,
          }),
    [
      file.path,
      fullContextResult?.markdownHtml,
      fullContextText,
      isMarkdown,
      projectId,
    ],
  );
  const fullContextRenderedHtml =
    fullContextResult?.markdownHtml || fullContextRendered?.html;
  const hasMarkdownPreview =
    isMarkdown &&
    (!!diffResult.markdownHtml ||
      diffOnlyRendered?.changed === true ||
      fullContextRendered?.changed === true);
  const showingMarkdownPreview = showMarkdownPreview && hasMarkdownPreview;
  const renderedPreviewHtml = showFullContext
    ? fullContextRenderedHtml
    : diffOnlyRendered?.html;

  const retainDiffView = useCallback(
    (view: GitDiffViewState) => {
      onRetainDiffView?.(fileKey, view);
    },
    [fileKey, onRetainDiffView],
  );

  const loadFullContext =
    useCallback(async (): Promise<GitDiffResult | null> => {
      if (fullContextResult) {
        return fullContextResult;
      }
      if (contextLoading) {
        return null;
      }
      const revisionKey = fullContextRevisionKey;
      setFullContextLoad((current) =>
        current.revisionKey === revisionKey
          ? { ...current, loading: true, error: null }
          : {
              revisionKey,
              result: null,
              loading: true,
              error: null,
            },
      );
      try {
        const result = await fetchDiffForSource(
          projectId,
          file,
          sourceFromPrimitives(
            sourceKind,
            sourceBaseSha,
            sourceHeadSha,
            sourceFileDiffMode,
          ),
          true,
          ignoreWhitespace,
        );
        setFullContextLoad((current) =>
          current.revisionKey === revisionKey
            ? { revisionKey, result, loading: false, error: null }
            : current,
        );
        return result;
      } catch (err) {
        if (
          ignoreWhitespace ||
          sourceKind === "comparison" ||
          sourceKind === "inclusive-comparison"
        ) {
          onProjectionRequestFailure?.(err);
        }
        const message =
          err instanceof Error ? err.message : t("gitStatusLoadContextFailed");
        setFullContextLoad((current) =>
          current.revisionKey === revisionKey
            ? {
                revisionKey,
                result: null,
                loading: false,
                error: message,
              }
            : current,
        );
        return null;
      }
    }, [
      fullContextResult,
      contextLoading,
      fullContextRevisionKey,
      projectId,
      file,
      sourceKind,
      sourceBaseSha,
      sourceHeadSha,
      sourceFileDiffMode,
      ignoreWhitespace,
      onProjectionRequestFailure,
      t,
    ]);

  const handleToggleContext = useCallback(async () => {
    const nextShowFullContext = !showFullContext;
    if (nextShowFullContext && !(await loadFullContext())) {
      return;
    }
    const content = contentRef.current;
    const scrollRoot = content ? getDiffScrollRoot(content) : null;
    pendingScrollAnchorRef.current = captureScrollPositionAnchor(
      scrollRoot,
      content?.querySelector(CHANGED_DIFF_LINE_SELECTOR) ?? null,
    );
    setShowFullContext(nextShowFullContext);
    if (!nextShowFullContext) setHideRemovedLines(false);
    retainDiffView({
      showFullContext: nextShowFullContext,
      ...(nextShowFullContext ? {} : { hideRemovedLines: false }),
    });
  }, [loadFullContext, retainDiffView, showFullContext]);

  const handleToggleRemovedLines = useCallback(async () => {
    const nextHideRemovedLines = !hideRemovedLines;
    if (nextHideRemovedLines && !(await loadFullContext())) return;
    const content = contentRef.current;
    const scrollRoot = content ? getDiffScrollRoot(content) : null;
    pendingScrollAnchorRef.current = captureScrollPositionAnchor(
      scrollRoot,
      content?.querySelector(CHANGED_DIFF_LINE_SELECTOR) ?? null,
    );
    if (nextHideRemovedLines) setShowFullContext(true);
    setHideRemovedLines(nextHideRemovedLines);
    retainDiffView({
      hideRemovedLines: nextHideRemovedLines,
      ...(nextHideRemovedLines ? { showFullContext: true } : {}),
    });
  }, [hideRemovedLines, loadFullContext, retainDiffView]);

  const handleToggleMarkdownPreview = useCallback(() => {
    const nextShowMarkdownPreview = !showMarkdownPreview;
    setShowMarkdownPreview(nextShowMarkdownPreview);
    retainDiffView({ showMarkdownPreview: nextShowMarkdownPreview });
  }, [retainDiffView, showMarkdownPreview]);

  const resolveCopyContent = useCallback(async () => {
    const result = showFullContext
      ? (fullContextResult ?? (await loadFullContext()))
      : diffResult;
    const content = result ? getPostChangeText(result.structuredPatch) : null;
    if (content === null) {
      throw new Error("Diff content is unavailable");
    }
    return content;
  }, [diffResult, fullContextResult, loadFullContext, showFullContext]);

  useEffect(() => {
    if (showFullContext && !fullContextResult && !contextLoading) {
      void loadFullContext();
    }
  }, [contextLoading, fullContextResult, loadFullContext, showFullContext]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: projection changes trigger restoring the ref-held DOM anchor
  useLayoutEffect(() => {
    const anchor = pendingScrollAnchorRef.current;
    if (!anchor) return;
    pendingScrollAnchorRef.current = null;
    restoreScrollPositionAnchor(
      anchor,
      contentRef.current?.querySelector(CHANGED_DIFF_LINE_SELECTOR) ?? null,
    );
  }, [showFullContext, hideRemovedLines, fullContextResult]);

  const displayResult =
    showFullContext && fullContextResult ? fullContextResult : diffResult;

  const plainDiff =
    displayResult.renderMode === "plain" ||
    displayResult.diffHtml.length > GIT_DIFF_MAX_RENDERED_HTML_CHARS;
  const diffHtml = plainDiff ? "" : displayResult.diffHtml;
  const binaryPatchSkip = useMemo(
    () =>
      displayResult.previewSkipped
        ? null
        : getBinaryPatchSkip(displayResult.structuredPatch),
    [displayResult.previewSkipped, displayResult.structuredPatch],
  );
  const previewSkipped = displayResult.previewSkipped ?? binaryPatchSkip;
  const [hunkPosition, setHunkPosition] = useState({ index: 0, count: 0 });
  const hunkPositionRef = useRef(hunkPosition);

  useEffect(() => {
    hunkPositionRef.current = hunkPosition;
  }, [hunkPosition]);

  const renderedHunks = useCallback((): HTMLElement[] => {
    if (showingMarkdownPreview || previewSkipped || !contentRef.current) {
      return [];
    }
    return Array.from(
      contentRef.current.querySelectorAll<HTMLElement>(".line-hunk"),
    );
  }, [previewSkipped, showingMarkdownPreview]);

  const updateHunkPosition = useCallback(() => {
    const content = contentRef.current;
    const hunks = renderedHunks();
    if (!content || hunks.length === 0) {
      setHunkPosition((current) =>
        current.count === 0 ? current : { index: 0, count: 0 },
      );
      return;
    }
    const scrollRoot = getDiffScrollRoot(content);
    const threshold =
      scrollRoot.getBoundingClientRect().top + toolbarHeight + 1;
    let index = 0;
    for (let i = 0; i < hunks.length; i++) {
      const hunk = hunks[i];
      if (hunk && hunk.getBoundingClientRect().top <= threshold) index = i;
      else break;
    }
    setHunkPosition((current) =>
      current.index === index && current.count === hunks.length
        ? current
        : { index, count: hunks.length },
    );
  }, [renderedHunks, toolbarHeight]);

  const jumpToHunk = useCallback(
    (direction: -1 | 1): boolean => {
      const hunks = renderedHunks();
      if (hunks.length === 0) return false;
      const current =
        hunkPositionRef.current.count === hunks.length
          ? hunkPositionRef.current.index
          : 0;
      const next = (current + direction + hunks.length) % hunks.length;
      const nextHunk = hunks[next];
      if (!nextHunk || typeof nextHunk.scrollIntoView !== "function") {
        return false;
      }
      nextHunk.scrollIntoView({ block: "start", behavior: "smooth" });
      setHunkPosition({ index: next, count: hunks.length });
      return true;
    },
    [renderedHunks],
  );
  const jumpToNextHunk = useCallback(() => jumpToHunk(1), [jumpToHunk]);
  const jumpToPreviousHunk = useCallback(() => jumpToHunk(-1), [jumpToHunk]);

  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const scrollRoot = getDiffScrollRoot(content);
    // Coalesce to one measurement per frame: the update queries every rendered
    // hunk's rect, which is too much work to repeat per scroll event.
    let frame = requestAnimationFrame(updateHunkPosition);
    let scheduled = false;
    const onScroll = () => {
      if (scheduled) return;
      scheduled = true;
      frame = requestAnimationFrame(() => {
        scheduled = false;
        updateHunkPosition();
      });
    };
    scrollRoot.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      scrollRoot.removeEventListener("scroll", onScroll);
    };
  }, [updateHunkPosition]);

  useEffect(() => {
    onHunkNavigationChange?.({
      next: jumpToNextHunk,
      previous: jumpToPreviousHunk,
    });
    return () => onHunkNavigationChange?.(null);
  }, [jumpToNextHunk, jumpToPreviousHunk, onHunkNavigationChange]);

  useLayoutEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (
        (key !== "n" && key !== "p") ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        isEditableKeyboardTarget(event.target)
      ) {
        return;
      }
      const moved = key === "n" ? jumpToNextHunk() : jumpToPreviousHunk();
      if (moved) event.preventDefault();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [jumpToNextHunk, jumpToPreviousHunk]);

  const hunkNavigation =
    hunkPosition.count > 0 ? (
      <span className="diff-hunk-navigation">
        <IconButton
          label={t("sourcePreviousHunkShortcut")}
          size="small"
          onClick={jumpToPreviousHunk}
        >
          ‹
        </IconButton>
        <span className="diff-hunk-indicator">
          {hunkPosition.index + 1}/{hunkPosition.count}
        </span>
        <IconButton
          label={t("sourceNextHunkShortcut")}
          size="small"
          onClick={jumpToNextHunk}
        >
          ›
        </IconButton>
      </span>
    ) : null;

  const toolbarButtons = (
    <>
      {hunkNavigation}
      {onToggleIgnoreWhitespace && (
        <IconButton
          label={
            ignoreWhitespace
              ? t("gitStatusIgnoreWhitespaceActive")
              : t("gitStatusIgnoreWhitespace")
          }
          size="small"
          onClick={onToggleIgnoreWhitespace}
          aria-pressed={ignoreWhitespace}
        >
          <span className="diff-whitespace-glyph" aria-hidden="true">
            _+
          </span>
        </IconButton>
      )}
      {hasMarkdownPreview && (
        <IconButton
          label={
            showingMarkdownPreview ? t("gitStatusDiff") : t("gitStatusPreview")
          }
          size="small"
          onClick={handleToggleMarkdownPreview}
          aria-pressed={showingMarkdownPreview}
        >
          <MarkdownModeIcon showDiff={showingMarkdownPreview} />
        </IconButton>
      )}
      <IconButton
        label={
          contextLoading
            ? t("gitStatusLoading")
            : showFullContext
              ? t("gitStatusDiffOnly")
              : t("gitStatusFullContext")
        }
        size="small"
        onClick={handleToggleContext}
        disabled={contextLoading}
        aria-pressed={showFullContext}
      >
        <ContextModeIcon expanded={showFullContext} />
      </IconButton>
      <IconButton
        label={
          hideRemovedLines
            ? t("gitStatusShowRemovedLines")
            : t("gitStatusHideRemovedLines")
        }
        size="small"
        onClick={handleToggleRemovedLines}
        disabled={contextLoading}
        aria-pressed={hideRemovedLines}
      >
        <RemovedLinesIcon hidden={hideRemovedLines} />
      </IconButton>
      <CopyButton
        value={resolveCopyContent}
        title={t("fileViewerCopyContent")}
        disabled={
          contextLoading ||
          !!previewSkipped ||
          displayResult.structuredPatch.length === 0
        }
        icon="content"
      />
      {!showingMarkdownPreview && !plainDiff && !hideRemovedLines && (
        <IconButton
          label={`${t("diffViewModeTitle")}: ${t(
            diffViewModeLabelKey(viewMode),
          )}`}
          size="small"
          onClick={cycleViewMode}
        >
          <DiffViewModeIcon mode={viewMode} />
        </IconButton>
      )}
    </>
  );

  const renderDiffProjection = (
    splitAfterLine: number | undefined,
    editor: ReactNode,
  ) =>
    displayResult.structuredPatch.length === 0 ? (
      <div className="git-diff-empty-projection">
        {ignoreWhitespace
          ? t("gitStatusWhitespaceChangesHidden")
          : t("gitStatusNoContentChanges")}
      </div>
    ) : diffHtml &&
      !hideRemovedLines &&
      resolveDiffViewMode(viewMode, paneWidth) === "side-by-side" ? (
      <SideBySideDiff
        diffHtml={diffHtml}
        structuredPatch={displayResult.structuredPatch}
        splitAfterLine={splitAfterLine}
        editor={editor}
      />
    ) : diffHtml ? (
      <UnifiedDiff
        diffHtml={diffHtml}
        structuredPatch={displayResult.structuredPatch}
        hideRemovedLines={hideRemovedLines}
        plain={plainDiff}
        splitAfterLine={splitAfterLine}
        editor={editor}
      />
    ) : (
      <UnifiedDiff
        diffHtml=""
        structuredPatch={displayResult.structuredPatch}
        hideRemovedLines={hideRemovedLines}
        plain={plainDiff}
        splitAfterLine={splitAfterLine}
        editor={editor}
      />
    );

  return (
    <>
      {paneHeader ? (
        <DiffPaneToolbar
          toolbarRef={toolbarRef}
          title={paneHeader.title}
          path={paneHeader.path}
          actions={paneHeader.actions}
          revision={paneHeader.revision}
        >
          {toolbarButtons}
        </DiffPaneToolbar>
      ) : (
        <div className="diff-context-controls source-diff-context-controls">
          <span className="diff-context-path">{file.path}</span>
          <div className="diff-context-buttons">{toolbarButtons}</div>
        </div>
      )}
      {contextError && <div className="diff-context-error">{contextError}</div>}
      <div
        className="diff-modal-content source-diff-pane diff-gutter-aligned"
        ref={mountContent}
        style={{ "--diff-sticky-top": `${toolbarHeight}px` } as CSSProperties}
      >
        {plainDiff && !previewSkipped && !showingMarkdownPreview && (
          <div className={styles.plainNotice}>
            {t("gitStatusDiffPlainMode")}
          </div>
        )}
        {showingMarkdownPreview && renderedPreviewHtml ? (
          <MarkdownPreview html={renderedPreviewHtml} sourcePath={file.path} />
        ) : previewSkipped ? (
          <GitDiffPreviewSkippedState
            file={file}
            previewSkipped={previewSkipped}
            t={t}
          />
        ) : contentElement ? (
          <DiffCommentController
            projectId={projectId}
            filePath={file.path}
            structuredPatch={displayResult.structuredPatch}
            revisions={commentRevisions}
            projections={
              captureReviewProjections
                ? displayResult.reviewProjections
                : undefined
            }
            container={contentElement}
            onOpenChange={onCommentEditorOpenChange}
            renderSource={({ openComment, editor }) =>
              renderDiffProjection(openComment?.flatIndex, editor)
            }
            t={t}
          />
        ) : (
          renderDiffProjection(undefined, null)
        )}
      </div>
    </>
  );
}

function DiffPaneToolbar({
  title,
  path,
  actions,
  revision,
  children,
  toolbarRef,
}: DiffPaneHeader & {
  children?: ReactNode;
  toolbarRef?: RefObject<HTMLDivElement | null>;
}) {
  const directoryPath =
    path && path !== title
      ? path.endsWith(title)
        ? path.slice(0, -title.length).replace(/\/$/, "")
        : path
      : "";
  return (
    <div
      ref={toolbarRef}
      className={`git-diff-pane-toolbar ${headerStyles.header}`}
    >
      <div className={headerStyles.identity}>
        <span className="git-diff-file-identity" title={path || title}>
          {directoryPath && (
            <>
              <span className="git-diff-toolbar-path">{directoryPath}</span>
              <span className="git-diff-toolbar-separator" aria-hidden="true">
                /
              </span>
            </>
          )}
          <h3 className="git-diff-preview-title">{title}</h3>
        </span>
        {revision}
      </div>
      <div className={headerStyles.actions}>
        {children && <div className="diff-context-buttons">{children}</div>}
        {actions && (
          <div className="git-diff-preview-header-actions">{actions}</div>
        )}
      </div>
    </div>
  );
}

function ContextModeIcon({ expanded }: { expanded: boolean }) {
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
      <path d="M5 12h14" />
      {expanded ? (
        <>
          <path d="m8 7 4-4 4 4" />
          <path d="m8 17 4 4 4-4" />
        </>
      ) : (
        <>
          <path d="m8 3 4 4 4-4" />
          <path d="m8 21 4-4 4 4" />
        </>
      )}
    </svg>
  );
}

function RemovedLinesIcon({ hidden }: { hidden: boolean }) {
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
      <path d="M5 7h14M5 12h14M5 17h14" />
      {hidden && <path d="M4 4l16 16" />}
    </svg>
  );
}

function MarkdownModeIcon({ showDiff }: { showDiff: boolean }) {
  return showDiff ? (
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
      <path d="m8 9-4 3 4 3M16 9l4 3-4 3M14 5l-4 14" />
    </svg>
  ) : (
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
    </svg>
  );
}

function DiffViewModeIcon({ mode }: { mode: DiffViewMode }) {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      {mode === "side-by-side" ? (
        <>
          <path d="M3 7h7M14 7h7" />
          <path d="M3 12h7M14 12h7" />
          <path d="M3 17h7M14 17h7" />
        </>
      ) : (
        <>
          <path d="M4 7h16M4 12h16M4 17h16" />
          {mode === "auto" && <path d="M5 4h4M5 4v3M19 20h-4M19 20v-3" />}
        </>
      )}
    </svg>
  );
}

function diffViewModeLabelKey(mode: DiffViewMode): MessageKey {
  switch (mode) {
    case "unified":
      return "diffViewModeUnified";
    case "side-by-side":
      return "diffViewModeSideBySide";
    default:
      return "diffViewModeAuto";
  }
}

function GitDiffPreviewSkippedState({
  file,
  previewSkipped,
  t,
}: {
  file: GitFileChange;
  previewSkipped: GitDiffPreviewSkipped;
  t: TranslationFn;
}) {
  return (
    <div className="git-diff-preview-skipped">
      <div className="git-diff-preview-skipped-title">
        {t("gitStatusDiffPreviewSkipped")}
      </div>
      <div className="git-diff-preview-skipped-message">
        {getDiffPreviewSkippedMessage(previewSkipped, t)}
      </div>
      <dl className="git-diff-preview-skipped-details">
        <div>
          <dt>{t("gitStatusDiffPreviewSkippedPath")}</dt>
          <dd>{file.path}</dd>
        </div>
        {previewSkipped.totalBytes !== undefined && (
          <div>
            <dt>{t("gitStatusDiffPreviewSkippedSize")}</dt>
            <dd>{formatBytes(previewSkipped.totalBytes)}</dd>
          </div>
        )}
        {previewSkipped.totalChars !== undefined && (
          <div>
            <dt>{t("gitStatusDiffPreviewSkippedCharacters")}</dt>
            <dd>{previewSkipped.totalChars.toLocaleString()}</dd>
          </div>
        )}
        {previewSkipped.totalLines !== undefined && (
          <div>
            <dt>{t("gitStatusDiffPreviewSkippedLines")}</dt>
            <dd>{previewSkipped.totalLines.toLocaleString()}</dd>
          </div>
        )}
        {previewSkipped.maxLineChars !== undefined && (
          <div>
            <dt>{t("gitStatusDiffPreviewSkippedLineLength")}</dt>
            <dd>{previewSkipped.maxLineChars.toLocaleString()}</dd>
          </div>
        )}
        {previewSkipped.htmlChars !== undefined && (
          <div>
            <dt>{t("gitStatusDiffPreviewSkippedHtmlSize")}</dt>
            <dd>{previewSkipped.htmlChars.toLocaleString()}</dd>
          </div>
        )}
      </dl>
    </div>
  );
}

function getBinaryPatchSkip(
  structuredPatch: PatchHunk[],
): GitDiffPreviewSkipped | null {
  let characters = 0;
  let suspiciousControls = 0;

  for (const hunk of structuredPatch) {
    for (const line of hunk.lines) {
      for (const char of line) {
        const codePoint = char.codePointAt(0);
        if (codePoint === undefined) continue;
        if (codePoint === 0 || codePoint === 0xfffd) {
          return { reason: "binary" };
        }
        characters += 1;
        if (
          (codePoint < 0x20 &&
            codePoint !== 0x08 &&
            codePoint !== 0x09 &&
            codePoint !== 0x0a &&
            codePoint !== 0x0c &&
            codePoint !== 0x0d &&
            codePoint !== 0x1b) ||
          codePoint === 0x7f
        ) {
          suspiciousControls += 1;
        }
      }
    }
  }

  return suspiciousControls / Math.max(characters, 1) > 0.01
    ? { reason: "binary" }
    : null;
}

function getDiffPreviewSkippedMessage(
  previewSkipped: GitDiffPreviewSkipped,
  t: TranslationFn,
): string {
  switch (previewSkipped.reason) {
    case "binary":
      return t("gitStatusDiffPreviewSkippedBinary");
    case "content-too-large":
      return t("gitStatusDiffPreviewSkippedContentTooLarge");
    case "line-too-long":
      return t("gitStatusDiffPreviewSkippedLineTooLong");
    case "html-too-large":
      return t("gitStatusDiffPreviewSkippedHtmlTooLarge");
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${formatFraction(bytes / 1024)} KB`;
  }
  return `${formatFraction(bytes / (1024 * 1024))} MB`;
}

function formatFraction(value: number): string {
  return value >= 10 ? value.toFixed(0) : value.toFixed(1);
}
