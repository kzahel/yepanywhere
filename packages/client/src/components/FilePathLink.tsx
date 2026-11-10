import modalStyles from "./ui/Modal.module.css";
import {
  fromUrlProjectId,
  isUrlProjectId,
  type GitFileDiffMode,
} from "@yep-anywhere/shared";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { api } from "../api/client";
import { projectRawFileApiPath } from "../api/fileClient";
import {
  buildPublicShareFileHref,
  usePublicShareContext,
} from "../contexts/PublicShareContext";
import { GlossaryProjectBoundary } from "../contexts/GlossaryContext";
import {
  QuoteReplyProvider,
  useQuoteReply,
} from "../contexts/QuoteReplyContext";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import { useFileVersionControl } from "../hooks/useFileVersionControl";
import { useCurrentSourceRuntime } from "../contexts/SourceRuntimeContext";
import { useTextTooltipAttributes } from "../hooks/useTooltipAppearance";
import { toBrowserAppHref } from "../lib/appHref";
import {
  writeClipboardRichTextLater,
  writeClipboardText,
  writeClipboardTextLater,
} from "../lib/clipboard";
import { QUOTE_SELECTION_ROOT_ATTRIBUTES } from "../lib/markdownSelectionCopy";
import { requireRenderedFileClipboardPayload } from "../lib/renderedFileClipboard";
import { toSourceTransportApiPath } from "../lib/sourceTransportPaths";
import { useOptionalSessionMetadata } from "../contexts/SessionMetadataContext";
import { useFileViewerController } from "../lib/fileViewerController";
import { rememberSessionLastFile } from "../lib/sessionLastFile";
import {
  clearSessionViewer,
  closeSessionViewer,
  minimizeSessionViewer,
  presentSessionViewer,
} from "../lib/sessionViewerController";
import {
  readReloadedSessionFile,
  saveReloadedSessionFileScroll,
  trackReloadedSessionFile,
} from "../lib/sessionViewerReload";
import {
  getAbsoluteFilePath,
  getPathBasename,
  getProjectRelativePath,
  isAbsoluteLikePath,
  normalizePathSeparators,
  stripTrailingPathSeparators,
} from "../lib/text";
import {
  FileViewer,
  type FileViewerMode,
  type FileViewerScrollMemory,
  type FileViewerSource,
} from "./FileViewer";
import {
  buildProjectFileViewUrl,
  FileDiffViewLinks,
  FileDiffLinkCluster,
} from "./FileDiffViewLinks";
import {
  FilePathContextMenu,
  type FileViewPresentation,
  type ResourceDownload,
  supportsSourceAndPreview,
  localSourceTarget,
  useStartNewSessionFromFile,
} from "./FileResourceActions";
import { createPublicShareFileViewerSource } from "./publicShareFileViewerSource";
import { CopyTextButton } from "./ui/CopyTextButton";
import {
  useModalBackGesture,
  useModalBackspace,
  useModalLayer,
} from "./ui/Modal";
import {
  useSessionViewerSessionId,
  useSessionFileViewerHost,
} from "./SessionManagedViewer";
import styles from "./FilePathLink.module.css";

/** Inline projections use the same session host or modal as a file link. */
export function FileVersionControlLinks({
  className,
  filePath,
  projectId,
}: {
  className?: string;
  filePath: string;
  projectId: string;
}) {
  const availability = useFileVersionControl(
    projectId,
    getProjectViewerFilePath(projectId, filePath),
  );
  const sessionId = useSessionViewerSessionId();
  const quoteReply = useQuoteReply();
  const id = useId();
  const [diffMode, setDiffMode] = useState<GitFileDiffMode>();
  const path = availability.relativePath;
  if (!path || (!availability.worktreeFile && !availability.cumulativeFile)) {
    return null;
  }
  return (
    <>
      <FileDiffViewLinks
        availability={availability}
        className={className}
        projectId={projectId}
        variant="inline"
        onSelect={(view) => {
          if (view === "source") return;
          if (sessionId) {
            presentProjectFileViewer({
              id,
              sessionId,
              projectId,
              filePath: path,
              diffMode: view,
              quoteReply,
            });
          } else {
            setDiffMode(view);
          }
        }}
      />
      {diffMode && (
        <FileViewerModal
          projectId={projectId}
          filePath={path}
          diffMode={diffMode}
          onClose={() => setDiffMode(undefined)}
        />
      )}
    </>
  );
}

/**
 * Faint copy-to-clipboard affordance rendered after a pathname. Copies the
 * project-relative path when the file is under the project (paste-safe at
 * the repo root), the path verbatim otherwise; no line suffix either way —
 * drag-selecting the text of a clickable link is fiddly. Click must not
 * bubble: path links live inside tool rows whose row click toggles expansion.
 */
export function FilePathCopyButton({ filePath }: { filePath: string }) {
  return (
    <CopyTextButton
      text={filePath}
      label="Copy path"
      copiedLabel="Copied path"
      className={styles.filePathCopy}
      data-file-path-copy
      variant="ghost"
      size="inline-icon"
      subdued
      onClick={(event) => event.stopPropagation()}
    />
  );
}

interface FilePathLinkProps {
  /** The file path to display and link to */
  filePath: string;
  /** Project ID for fetching file content */
  projectId: string;
  /** Optional line number to display */
  lineNumber?: number;
  /** Optional end line for range highlighting */
  lineEnd?: number;
  /** Optional column number to display */
  columnNumber?: number;
  /** Optional custom display text (defaults to filename) */
  displayText?: string;
  /** Whether to append the line/range suffix to the visible link text */
  showLineSuffix?: boolean;
  /** Whether to show full path or just filename */
  showFullPath?: boolean;
  /** Viewer mode. The range mode shows only the requested line range. */
  viewMode?: FileViewerMode;
  /** Whether to render the faint copy-path button after the link */
  showCopyButton?: boolean;
  /** Whether to append source-control affordances after the path. */
  showVersionControlLinks?: boolean;
}

function getProjectPath(projectId: string): string | null {
  if (!isUrlProjectId(projectId)) {
    return null;
  }
  try {
    const projectPath = fromUrlProjectId(projectId);
    return stripTrailingPathSeparators(projectPath);
  } catch {
    return null;
  }
}

export function getProjectViewerFilePath(
  projectId: string,
  filePath: string,
): string {
  const projectPath = getProjectPath(projectId);
  const projectRelativePath = getProjectRelativePath(filePath, projectPath);
  if (projectRelativePath !== null) {
    return projectRelativePath;
  }

  const normalizedPath = normalizePathSeparators(filePath);
  const isAbsolutePath =
    normalizedPath.startsWith("/") || /^[a-zA-Z]:\//.test(normalizedPath);
  return !isAbsolutePath && filePath.includes("\\")
    ? normalizePathSeparators(filePath)
    : filePath;
}

function formatLineSuffix(lineNumber?: number, lineEnd?: number): string {
  if (lineNumber === undefined) {
    return "";
  }
  if (lineEnd !== undefined && lineEnd > lineNumber) {
    return `:${lineNumber}-${lineEnd}`;
  }
  return `:${lineNumber}`;
}

/**
 * Present a project file in the session's one managed viewer, the way
 * activating a file link inside the session does. `filePath` is
 * project-relative, or absolute for an allowed file outside the project.
 */
export function presentProjectFileViewer({
  id,
  sessionId,
  projectId,
  filePath,
  lineNumber,
  lineEnd,
  viewMode = "full",
  diffMode,
  presentation,
  quoteReply,
  source,
  openInNewTabUrl,
}: {
  id: string;
  sessionId: string;
  projectId: string;
  filePath: string;
  lineNumber?: number;
  lineEnd?: number;
  viewMode?: FileViewerMode;
  diffMode?: GitFileDiffMode;
  presentation?: FileViewPresentation;
  quoteReply?: ReturnType<typeof useQuoteReply>;
  source?: FileViewerSource;
  openInNewTabUrl?: string | null;
}): void {
  const lineSuffix = formatLineSuffix(lineNumber, lineEnd);
  rememberSessionLastFile(
    sessionId,
    buildProjectFileViewUrl({
      projectId,
      filePath,
      lineNumber,
      lineEnd,
      viewMode,
      diffMode,
    }),
  );
  presentSessionViewer({
    id,
    kind: "file",
    sessionId,
    label: `${filePath}${lineSuffix}`,
    briefLabel: getPathBasename(filePath),
    filePath,
    lineSuffix,
    supportsRightPane: true,
    renderContent: (inactive, rightPane) => (
      <FileViewerModal
        key={id}
        managedViewerId={id}
        inactive={inactive}
        rightPane={rightPane}
        quoteReply={quoteReply}
        projectId={projectId}
        filePath={filePath}
        lineNumber={lineNumber}
        lineEnd={lineEnd}
        viewMode={viewMode}
        diffMode={diffMode}
        initialPresentation={presentation}
        source={source}
        openInNewTabUrl={openInNewTabUrl}
      />
    ),
  });
}

/**
 * FilePathLink - A clickable link component that opens a file viewer modal.
 * Used to make file paths in messages interactive.
 */
export const FilePathLink = memo(function FilePathLink({
  filePath,
  projectId,
  lineNumber,
  lineEnd,
  columnNumber,
  displayText,
  showLineSuffix = true,
  showFullPath = false,
  viewMode = "full",
  showCopyButton = true,
  showVersionControlLinks = true,
}: FilePathLinkProps) {
  const publicShareContext = usePublicShareContext();
  const sessionViewerSessionId = useSessionViewerSessionId();
  const quoteReply = useQuoteReply();
  const basePath = useRemoteBasePath();
  const transport = useCurrentSourceRuntime().transport;
  const managedViewerId = useId();
  const [showModal, setShowModal] = useState(false);
  const [modalPresentation, setModalPresentation] =
    useState<FileViewPresentation>();
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const viewerFilePath = useMemo(
    () => getProjectViewerFilePath(projectId, filePath),
    [projectId, filePath],
  );
  const startNewSession = useStartNewSessionFromFile(projectId, viewerFilePath);
  const projectPath = useMemo(() => getProjectPath(projectId), [projectId]);
  const projectRelativeCopyPath = useMemo(
    () =>
      isAbsoluteLikePath(viewerFilePath)
        ? getProjectRelativePath(viewerFilePath, projectPath)
        : normalizePathSeparators(viewerFilePath).replace(/^\.\/+/, ""),
    [projectPath, viewerFilePath],
  );
  const absoluteCopyPath = useMemo(() => {
    return getAbsoluteFilePath(
      isAbsoluteLikePath(filePath) ? filePath : viewerFilePath,
      projectPath,
    );
  }, [filePath, projectPath, viewerFilePath]);
  const localSource = localSourceTarget(
    projectId,
    absoluteCopyPath,
    projectRelativeCopyPath,
    publicShareContext !== null,
  );
  const hasPresentationChoice = supportsSourceAndPreview(viewerFilePath);
  const publicShareFileViewUrl = publicShareContext
    ? buildPublicShareFileHref(publicShareContext, {
        columnNumber,
        filePath: viewerFilePath,
        lineEnd,
        lineNumber,
        viewMode,
      })
    : null;
  const fileViewUrl =
    publicShareContext !== null
      ? publicShareFileViewUrl
      : toBrowserAppHref(
          buildProjectFileViewUrl({
            basePath,
            filePath: viewerFilePath,
            lineEnd,
            lineNumber,
            projectId,
            viewMode,
          }),
        );
  const publicShareFileViewerSource = useMemo(
    () =>
      publicShareContext
        ? createPublicShareFileViewerSource(publicShareContext)
        : undefined,
    [publicShareContext],
  );

  const openViewer = useCallback(
    (presentation?: FileViewPresentation) => {
      if (sessionViewerSessionId && publicShareContext === null) {
        presentProjectFileViewer({
          id: managedViewerId,
          sessionId: sessionViewerSessionId,
          projectId,
          filePath: viewerFilePath,
          lineNumber,
          lineEnd,
          viewMode,
          presentation,
          quoteReply,
          source: publicShareFileViewerSource,
          openInNewTabUrl: fileViewUrl,
        });
        return;
      }
      setModalPresentation(presentation);
      setShowModal(true);
    },
    [
      fileViewUrl,
      lineEnd,
      lineNumber,
      managedViewerId,
      projectId,
      publicShareContext,
      publicShareFileViewerSource,
      sessionViewerSessionId,
      quoteReply,
      viewMode,
      viewerFilePath,
    ],
  );

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
        return;
      }
      if (publicShareContext && !publicShareFileViewUrl) {
        e.preventDefault();
        return;
      }
      e.preventDefault();
      openViewer();
    },
    [openViewer, publicShareContext, publicShareFileViewUrl],
  );

  const handleClose = useCallback(() => {
    setShowModal(false);
  }, []);
  const handleContextMenu = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({ x: event.clientX, y: event.clientY });
  }, []);
  const closeContextMenu = useCallback(() => setContextMenu(null), []);
  const openFromMenu = useCallback(
    (presentation?: FileViewPresentation) => openViewer(presentation),
    [openViewer],
  );
  const handleCopyViewerLinkFromMenu = useCallback(() => {
    if (!fileViewUrl) return;
    void writeClipboardText(new URL(fileViewUrl, window.location.href).href);
  }, [fileViewUrl]);
  const handleCopyContentsFromMenu = useCallback(() => {
    const loadFile = publicShareFileViewerSource
      ? publicShareFileViewerSource.loadFile(projectId, viewerFilePath, false)
      : api.getFile(projectId, viewerFilePath);
    void writeClipboardTextLater(loadFile.then((file) => file.content ?? ""));
  }, [projectId, publicShareFileViewerSource, viewerFilePath]);
  const handleCopyRenderedContentsFromMenu = useCallback(() => {
    const loadFile = publicShareFileViewerSource
      ? publicShareFileViewerSource.loadFile(projectId, viewerFilePath, true)
      : api.getFile(projectId, viewerFilePath, true);
    void writeClipboardRichTextLater(
      loadFile.then((file) =>
        requireRenderedFileClipboardPayload(viewerFilePath, file),
      ),
    );
  }, [projectId, publicShareFileViewerSource, viewerFilePath]);
  const menuDownload = useCallback((): ResourceDownload => {
    const fetchShareBlob = publicShareFileViewerSource?.fetchRawFileBlob;
    return {
      fileName: getPathBasename(viewerFilePath),
      directUrl: publicShareFileViewerSource
        ? undefined
        : projectRawFileApiPath(projectId, viewerFilePath, true),
      loadBlob:
        publicShareFileViewerSource && fetchShareBlob
          ? () =>
              publicShareFileViewerSource
                .loadFile(projectId, viewerFilePath, false)
                .then((file) => fetchShareBlob(file, viewerFilePath, true))
          : () =>
              transport.fetchBlob(
                toSourceTransportApiPath(
                  projectRawFileApiPath(projectId, viewerFilePath, true),
                ),
              ),
    };
  }, [projectId, publicShareFileViewerSource, transport, viewerFilePath]);

  // Format the display text
  const fileName = showFullPath ? filePath : getPathBasename(filePath);
  const text = displayText || fileName;

  const lineSuffix = formatLineSuffix(lineNumber, lineEnd);
  const columnSuffix =
    lineSuffix && columnNumber !== undefined && lineEnd === undefined
      ? `:${columnNumber}`
      : "";
  const suffix = `${lineSuffix}${columnSuffix}`;
  const visibleSuffix = showLineSuffix ? suffix : "";
  const tooltipAttributes = useTextTooltipAttributes(`${filePath}${suffix}`);

  return (
    <>
      <FileDiffLinkCluster>
        <a
          href={fileViewUrl ?? "#"}
          className={styles.filePathLink}
          data-file-path-link
          onClick={handleClick}
          onContextMenu={handleContextMenu}
          {...tooltipAttributes}
        >
          <span className={styles.filePathLinkName} data-file-path-link-name>
            {text}
          </span>
          {visibleSuffix && (
            <span className={styles.filePathLinkLine} data-file-path-link-line>
              {visibleSuffix}
            </span>
          )}
        </a>
        {showCopyButton && <FilePathCopyButton filePath={viewerFilePath} />}
        {publicShareContext === null && showVersionControlLinks && (
          <FileVersionControlLinks
            projectId={projectId}
            filePath={viewerFilePath}
          />
        )}
      </FileDiffLinkCluster>
      {contextMenu && (
        <FilePathContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          canStartNewSession={publicShareContext === null}
          onClose={closeContextMenu}
          onOpen={() => openFromMenu()}
          newTabHref={fileViewUrl ?? undefined}
          download={menuDownload()}
          onOpenSource={
            hasPresentationChoice ? () => openFromMenu("source") : undefined
          }
          onOpenPreview={
            hasPresentationChoice ? () => openFromMenu("preview") : undefined
          }
          onStartNewSession={startNewSession}
          localSource={localSource}
          fileTarget={
            publicShareContext === null
              ? { projectId, path: projectRelativeCopyPath ?? viewerFilePath }
              : undefined
          }
          onCopyProjectRelativePath={
            projectRelativeCopyPath
              ? () => void writeClipboardText(projectRelativeCopyPath)
              : undefined
          }
          onCopyAbsolutePath={
            publicShareContext === null && absoluteCopyPath
              ? () => void writeClipboardText(absoluteCopyPath)
              : undefined
          }
          onCopyFilePath={
            !projectRelativeCopyPath && !absoluteCopyPath
              ? () => void writeClipboardText(viewerFilePath)
              : undefined
          }
          onCopyViewerLink={
            fileViewUrl ? handleCopyViewerLinkFromMenu : undefined
          }
          onCopyContents={handleCopyContentsFromMenu}
          onCopyRenderedContents={
            hasPresentationChoice
              ? handleCopyRenderedContentsFromMenu
              : undefined
          }
        />
      )}
      {showModal && (
        <FileViewerModal
          projectId={projectId}
          filePath={viewerFilePath}
          lineNumber={lineNumber}
          lineEnd={lineEnd}
          viewMode={viewMode}
          initialPresentation={modalPresentation}
          source={publicShareFileViewerSource}
          openInNewTabUrl={fileViewUrl}
          onClose={handleClose}
        />
      )}
    </>
  );
});

/**
 * Modal wrapper for FileViewer.
 */
type FileViewerModalProps = {
  nestedViewer?: boolean;
  quoteReply?: ReturnType<typeof useQuoteReply>;
  projectId: string;
  filePath: string;
  lineNumber?: number;
  lineEnd?: number;
  viewMode?: FileViewerMode;
  diffMode?: GitFileDiffMode;
  initialPresentation?: FileViewPresentation;
  source?: FileViewerSource;
  openInNewTabUrl?: string | null;
  /** The publishing modal's navigation, for the copy a session host renders. */
  onNavigateFile?: (filePath: string) => void;
} & (
  | {
      managedViewerId: string;
      inactive?: boolean;
      rightPane?: boolean;
      onClose?: never;
    }
  | {
      managedViewerId?: never;
      inactive?: never;
      rightPane?: never;
      onClose: () => void;
    }
);

function PublishedFileViewerModal(props: FileViewerModalProps) {
  return <FileViewerModal {...props} />;
}

export function FileViewerModal({
  projectId,
  filePath: requestedFilePath,
  lineNumber: requestedLineNumber,
  lineEnd: requestedLineEnd,
  viewMode: requestedViewMode = "full",
  diffMode: requestedDiffMode,
  initialPresentation,
  source: explicitSource,
  openInNewTabUrl,
  managedViewerId,
  inactive = false,
  rightPane = false,
  nestedViewer = false,
  quoteReply: suppliedQuoteReply,
  onNavigateFile: navigateFromPublisher,
  onClose,
}: FileViewerModalProps) {
  // A file chosen from the path's folder list replaces the shown one until
  // the caller names a different file. Line, range and diff targets belong to
  // the file they were given for.
  const [navigated, setNavigated] = useState<{
    from: string;
    path: string;
  } | null>(null);
  const navigatedPath =
    navigated?.from === requestedFilePath ? navigated.path : null;
  const filePath = navigatedPath ?? requestedFilePath;
  const lineNumber = navigatedPath ? undefined : requestedLineNumber;
  const lineEnd = navigatedPath ? undefined : requestedLineEnd;
  const viewMode = navigatedPath ? "full" : requestedViewMode;
  const diffMode = navigatedPath ? undefined : requestedDiffMode;
  const navigateFile = useCallback(
    (path: string) => setNavigated({ from: requestedFilePath, path }),
    [requestedFilePath],
  );
  const onNavigateFile = navigateFromPublisher ?? navigateFile;
  const publicShareContext = usePublicShareContext();
  // A share viewer has no authenticated project file route, so every modal
  // opened inside one reads through the share's own file endpoint.
  const shareSource = useMemo(
    () =>
      publicShareContext
        ? createPublicShareFileViewerSource(publicShareContext)
        : undefined,
    [publicShareContext],
  );
  const source = explicitSource ?? shareSource;
  const inheritedQuoteReply = useQuoteReply();
  const quoteReply = suppliedQuoteReply ?? inheritedQuoteReply;
  const hostSessionId = useSessionViewerSessionId();
  const parentHost = useSessionFileViewerHost();
  const nested =
    managedViewerId === undefined && (nestedViewer || parentHost !== null);
  const inRightPane = rightPane || (nested && !!parentHost?.target);
  const publishToHost =
    managedViewerId === undefined &&
    !nested &&
    !!hostSessionId &&
    publicShareContext === null;
  const sessionMetadata = useOptionalSessionMetadata();
  const generatedViewerId = useId();
  const minimizedViewerId = managedViewerId ?? generatedViewerId;
  const publishedViewer = useFileViewerController();
  const minimized = Boolean(
    inactive ||
      (nested && parentHost?.inactive) ||
      (publishedViewer?.id === minimizedViewerId && publishedViewer.minimized),
  );
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const close = useCallback(() => {
    if (managedViewerId !== undefined) {
      closeSessionViewer(minimizedViewerId);
      return;
    }
    clearSessionViewer(minimizedViewerId);
    onCloseRef.current?.();
  }, [minimizedViewerId, managedViewerId]);
  const minimize = useCallback(
    () => minimizeSessionViewer(minimizedViewerId),
    [minimizedViewerId],
  );
  useLayoutEffect(() => {
    if (managedViewerId !== undefined || nested) return;
    if (publicShareContext !== null) return;
    const lineSuffix = formatLineSuffix(lineNumber, lineEnd);
    presentSessionViewer({
      id: minimizedViewerId,
      kind: "file",
      sessionId: hostSessionId ?? sessionMetadata?.sessionId ?? "",
      label: `${filePath}${lineSuffix}`,
      briefLabel: getPathBasename(filePath),
      onClose: close,
      filePath,
      lineSuffix,
      ...(publishToHost
        ? {
            supportsRightPane: true,
            renderContent: (inactive: boolean, rightPane?: boolean) => (
              <PublishedFileViewerModal
                managedViewerId={minimizedViewerId}
                inactive={inactive}
                rightPane={rightPane}
                quoteReply={quoteReply}
                projectId={projectId}
                filePath={filePath}
                lineNumber={lineNumber}
                lineEnd={lineEnd}
                viewMode={viewMode}
                diffMode={diffMode}
                initialPresentation={initialPresentation}
                source={source}
                openInNewTabUrl={openInNewTabUrl}
                onNavigateFile={navigateFile}
              />
            ),
          }
        : {}),
    });
  }, [
    navigateFile,
    close,
    filePath,
    lineEnd,
    lineNumber,
    managedViewerId,
    nested,
    minimizedViewerId,
    publicShareContext,
    sessionMetadata?.sessionId,
    hostSessionId,
    publishToHost,
    projectId,
    viewMode,
    initialPresentation,
    diffMode,
    source,
    openInNewTabUrl,
    quoteReply,
  ]);
  useEffect(() => {
    if (managedViewerId !== undefined || publishToHost || nested) return;
    return () => clearSessionViewer(minimizedViewerId);
  }, [managedViewerId, minimizedViewerId, publishToHost, nested]);
  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      close();
    }
  };

  const interactive =
    !publishToHost &&
    !minimized &&
    (!inRightPane || nested || publishedViewer?.id === minimizedViewerId);
  const rememberedSessionId =
    hostSessionId ??
    (nested ? publishedViewer?.sessionId : undefined) ??
    sessionMetadata?.sessionId;
  useEffect(() => {
    if (
      managedViewerId !== undefined ||
      publicShareContext !== null ||
      !rememberedSessionId
    )
      return;
    rememberSessionLastFile(
      rememberedSessionId,
      buildProjectFileViewUrl({
        projectId,
        filePath: getProjectViewerFilePath(projectId, filePath),
        lineNumber,
        lineEnd,
        viewMode,
        diffMode,
      }),
    );
  }, [
    managedViewerId,
    publicShareContext,
    rememberedSessionId,
    diffMode,
    projectId,
    filePath,
    lineNumber,
    lineEnd,
    viewMode,
  ]);
  // The session's managed project-file viewer is what a reload reopens; a
  // share-sourced one reads through a route a reload cannot rebuild. Its
  // content renders in the viewer host, outside the session's context, so
  // the session comes from the viewer's own registration.
  const reloadedSessionId =
    managedViewerId !== undefined &&
    !nested &&
    publicShareContext === null &&
    !source &&
    publishedViewer?.id === managedViewerId
      ? publishedViewer.sessionId || null
      : null;
  const reloadRoute = buildProjectFileViewUrl({
    projectId,
    filePath: getProjectViewerFilePath(projectId, filePath),
    lineNumber,
    lineEnd,
    viewMode,
    diffMode,
  });
  const scrollMemory = useMemo<FileViewerScrollMemory | undefined>(() => {
    if (!reloadedSessionId || managedViewerId === undefined) return undefined;
    const saved = readReloadedSessionFile(reloadedSessionId);
    return {
      initialTop: saved?.route === reloadRoute ? saved.scrollTop : undefined,
      save: (top) =>
        saveReloadedSessionFileScroll(reloadedSessionId, managedViewerId, top),
    };
  }, [reloadedSessionId, managedViewerId, reloadRoute]);
  useEffect(() => {
    if (reloadedSessionId && managedViewerId !== undefined)
      trackReloadedSessionFile(reloadedSessionId, managedViewerId, reloadRoute);
  }, [reloadedSessionId, managedViewerId, reloadRoute]);
  // Beside the session, Escape belongs to whatever has focus there; only a
  // key pressed inside this viewer dismisses it.
  const docked = inRightPane && parentHost?.docked === true;
  useModalBackGesture(close, interactive, "__fileViewerModal");
  useModalBackspace(close, interactive);
  useModalLayer(close, interactive && !docked);

  if (publishToHost) return null;

  const fileViewer = (
    <FileViewer
      projectId={projectId}
      filePath={filePath}
      lineNumber={lineNumber}
      lineEnd={lineEnd}
      viewMode={viewMode}
      initialPresentation={initialPresentation}
      diffMode={diffMode}
      source={source}
      openInNewTabUrl={openInNewTabUrl}
      onClose={close}
      onMinimize={publicShareContext === null && !nested ? minimize : undefined}
      parentViewerId={managedViewerId}
      scrollMemory={scrollMemory}
      onNavigateFile={onNavigateFile}
    />
  );
  const viewer = quoteReply ? (
    <QuoteReplyProvider onQuoteTextBlock={quoteReply}>
      {fileViewer}
    </QuoteReplyProvider>
  ) : (
    fileViewer
  );
  if (inRightPane) {
    const paneContent = (
      <GlossaryProjectBoundary projectId={projectId}>
        <div
          className={`${styles.paneViewer} ${nested ? styles.nestedPaneViewer : ""}`}
          role="dialog"
          aria-label={filePath}
          onKeyDown={
            docked && interactive
              ? (event) => {
                  if (event.key !== "Escape" || event.defaultPrevented) return;
                  event.preventDefault();
                  event.stopPropagation();
                  close();
                }
              : undefined
          }
          {...QUOTE_SELECTION_ROOT_ATTRIBUTES}
        >
          {viewer}
        </div>
      </GlossaryProjectBoundary>
    );
    return nested && parentHost?.target
      ? createPortal(paneContent, parentHost.target)
      : paneContent;
  }

  const sessionViewerLayer =
    publicShareContext === null
      ? (document.querySelector<HTMLElement>(
          "[data-navigation-route-layer][data-navigation-active] [data-session-viewer-layer]",
        ) ?? document.querySelector<HTMLElement>("[data-session-viewer-layer]"))
      : null;
  const modalContent = (
    <div
      className={modalStyles.modalOverlay}
      data-modal-overlay
      aria-hidden={minimized || undefined}
      style={minimized ? { display: "none" } : undefined}
      onClick={handleOverlayClick}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: click only stops propagation, keyboard handled globally */}
      <dialog
        className={`${modalStyles.modal} ${styles.fileViewerModal} ${
          viewMode === "range" ? `${styles.fileViewerModalCompact}` : ""
        }`}
        data-modal-frame
        data-file-viewer-modal
        {...QUOTE_SELECTION_ROOT_ATTRIBUTES}
        open
        onClick={(e) => e.stopPropagation()}
      >
        {viewer}
      </dialog>
    </div>
  );

  const portalHost =
    publicShareContext === null
      ? (sessionViewerLayer ??
        document.querySelector<HTMLElement>(
          "[data-navigation-route-layer][data-navigation-active] .session-page",
        ) ??
        document.querySelector<HTMLElement>(".session-page"))
      : null;

  return createPortal(
    publicShareContext ? (
      modalContent
    ) : (
      <GlossaryProjectBoundary projectId={projectId}>
        {modalContent}
      </GlossaryProjectBoundary>
    ),
    portalHost ?? document.body,
  );
}
