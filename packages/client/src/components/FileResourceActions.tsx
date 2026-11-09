import { SERVER_CAPABILITIES, serverHasCapability } from "@yep-anywhere/shared";
import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { ComposerInsertContext } from "../contexts/ComposerInsertContext";
import { useOptionalSessionMetadata } from "../contexts/SessionMetadataContext";
import { api } from "../api/client";
import { useCurrentSourceRuntime } from "../contexts/SourceRuntimeContext";
import { useOptionalToastContext } from "../contexts/ToastContext";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import { useProjectFileLink } from "../hooks/useProjectFileLink";
import { beginTooltipSuppression } from "../hooks/useTooltipAppearance";
import {
  useGitHubFileLink,
  type GitHubFileTarget,
} from "../hooks/useGitHubFileLink";
import { useRetainedVersionInfo, useVersion } from "../hooks/useVersion";
import { useI18n } from "../i18n";
import { toBrowserAppHref } from "../lib/appHref";
import { useClientSummarySourceKey } from "../lib/clientSummaryStore";
import { downloadBlob, downloadUrl } from "../lib/imageActions";
import { toSourceTransportApiPath } from "../lib/sourceTransportPaths";
import {
  canStreamDownloadToDisk,
  saveStreamedDownload,
} from "../lib/streamedDownload";
import { writeClipboardText } from "../lib/clipboard";
import { isMarkdownLikeFile } from "../lib/markdownFiles";
import {
  createNewSessionPrefillToken,
  setNewSessionPrefill,
  stashNewSessionPrefillToken,
  type NewSessionPrefillCaret,
} from "../lib/newSessionPrefill";
import { Menu, MenuGroup, MenuItem, MenuSeparator } from "./ui/Menu";
import styles from "./FileResourceActions.module.css";

export type FileViewPresentation = "preview" | "source";

export function supportsSourceAndPreview(
  filePath: string,
  renderMarkdown = false,
): boolean {
  return (
    renderMarkdown ||
    isMarkdownLikeFile(filePath) ||
    /\.(?:html?|xhtml)$/i.test(filePath)
  );
}

/**
 * What the resource menu's Download row saves: bytes the client fetches, or
 * a URL the browser downloads itself.
 */
export type ResourceDownload =
  | {
      fileName: string;
      loadBlob: () => Promise<Blob>;
      /**
       * The same bytes as a same-origin `/api` attachment URL. A transport
       * whose `/api` URLs the browser can address saves through it, so the
       * file streams to disk instead of being buffered whole in the page.
       */
      directUrl?: string;
    }
  | { url: string };

export interface ResourceContextMenuProps {
  x: number;
  y: number;
  canStartNewSession?: boolean;
  onClose: () => void;
  onCopyAbsolutePath?: () => void;
  onCopyContents?: () => void;
  onCopyRenderedContents?: () => void;
  onCopyFilePath?: () => void;
  onCopyImage?: () => void;
  /** Copy the link itself, for a resource that is a URL rather than a file. */
  onCopyLink?: () => void;
  onCopyProjectRelativePath?: () => void;
  onCopyPublicUrl?: () => void;
  onCopyViewerLink?: () => void;
  /** Copy a folder's entry names, one per line. */
  onCopyListing?: () => void;
  /** The resource is a folder: path copies name a folder, not a file. */
  folder?: boolean;
  /** A muted first line naming what the menu acts on. */
  heading?: string;
  fileTarget?: GitHubFileTarget;
  download?: ResourceDownload;
  /** An outside path whose checkout or directory may open in a new tab. */
  localSource?: LocalSourceTarget;
  onOpen: () => void;
  /** The resource's own app URL, offered as "Open in new tab" after Open. */
  newTabHref?: string;
  onOpenPreview?: () => void;
  onOpenSource?: () => void;
  onStartNewSession?: () => void;
  /** A running preview's stop action, shown last with `stopLabel`. */
  onStop?: () => void;
  stopLabel?: string;
}

export interface NewSessionPrefillOptions {
  caret?: NewSessionPrefillCaret;
  executor?: string;
  model?: string;
  newTab?: boolean;
  permissionMode?: string;
  provider?: string;
  thinking?: string;
}

function appendNewSessionOptionParams(
  params: URLSearchParams,
  options: NewSessionPrefillOptions,
): void {
  if (options.provider) params.set("provider", options.provider);
  if (options.model) params.set("model", options.model);
  if (options.thinking) params.set("thinking", options.thinking);
  if (options.permissionMode) {
    params.set("permissionMode", options.permissionMode);
  }
  if (options.executor) params.set("executor", options.executor);
}

function navigateInTab(url: string): void {
  window.history.pushState(window.history.state, "", url);
  const navigationEvent =
    typeof PopStateEvent === "function"
      ? new PopStateEvent("popstate", { state: window.history.state })
      : new Event("popstate");
  window.dispatchEvent(navigationEvent);
}

export function useStartNewSessionWithPrefillAction() {
  const basePath = useRemoteBasePath();
  const clientSummarySourceKey = useClientSummarySourceKey();

  return useCallback(
    (
      projectId: string,
      prefill: string,
      options: NewSessionPrefillOptions = {},
    ) => {
      const trimmed = prefill.trim();
      if (!projectId || !trimmed) return;
      const params = new URLSearchParams({ projectId });
      appendNewSessionOptionParams(params, options);
      if (options.newTab) {
        const token = createNewSessionPrefillToken();
        params.set("prefillToken", token);
        const opened = window.open(
          `${basePath}/new-session?${params.toString()}`,
          "_blank",
        );
        if (opened) {
          opened.opener = null;
          stashNewSessionPrefillToken(token, clientSummarySourceKey, trimmed, {
            caret: options.caret,
          });
          return;
        }
        params.delete("prefillToken");
      }
      setNewSessionPrefill(clientSummarySourceKey, trimmed, {
        caret: options.caret,
      });
      navigateInTab(`${basePath}/new-session?${params.toString()}`);
    },
    [basePath, clientSummarySourceKey],
  );
}

const HOST_PATH = /^(?:\/(?!\/)|~\/|[A-Za-z]:[\\/])/;

/**
 * Start a session about a file in the project that owns it. A host path may
 * belong to a different project than the conversation it was linked from; the
 * server resolves ownership, including symlinked roots, and the session opens
 * there with the project-relative path. A file inside no project, a failed
 * lookup, or an older server keeps the linking project and the path as
 * written, so the prefill never names a project it was not proven to be in.
 */
export function useStartNewSessionFromFileAction() {
  const startNewSession = useStartNewSessionWithPrefillAction();
  const sourceKey = useClientSummarySourceKey();
  const version = useRetainedVersionInfo(sourceKey);
  const canResolveOwner = serverHasCapability(
    version,
    SERVER_CAPABILITIES.fileOwnerProject.name,
  );
  return useCallback(
    (projectId: string, filePath: string) => {
      if (!canResolveOwner || !HOST_PATH.test(filePath)) {
        startNewSession(projectId, filePath);
        return;
      }
      void api
        .getFileOwner(projectId, filePath)
        .then(({ owner }) =>
          owner
            ? startNewSession(owner.projectId, owner.relativePath)
            : startNewSession(projectId, filePath),
        )
        .catch(() => startNewSession(projectId, filePath));
    },
    [canResolveOwner, startNewSession],
  );
}

export function useStartNewSessionFromFile(
  projectId: string,
  filePath: string,
) {
  const startNewSession = useStartNewSessionFromFileAction();
  return useCallback(() => {
    startNewSession(projectId, filePath);
  }, [filePath, projectId, startNewSession]);
}

/** An absolute path outside `projectId` that Source Control can browse. */
export interface LocalSourceTarget {
  projectId: string;
  path: string;
}

/**
 * The target for a path's menu: absolute, outside the project, and not in a
 * public share. Deciding this needs no server state, so links stay free of
 * version lookups until a menu actually opens.
 */
export function localSourceTarget(
  projectId: string,
  absolutePath: string | null,
  projectRelativePath: string | null,
  inPublicShare: boolean,
): LocalSourceTarget | undefined {
  return !inPublicShare && !projectRelativePath && absolutePath
    ? { projectId, path: absolutePath }
    : undefined;
}

/**
 * Opens the target's checkout or directory in a new tab of Source Control's
 * current-files browser. Mounted only inside an open menu, so the capability
 * lookup costs nothing for the many links that are never right-clicked; it
 * renders nothing on a server without `local-source-browse`.
 */
function OpenLocalSourceMenuItem({
  target,
  onHover,
}: {
  target: LocalSourceTarget;
  onHover?: () => void;
}) {
  const { t } = useI18n();
  const basePath = useRemoteBasePath();
  const { version } = useVersion();
  if (!serverHasCapability(version, SERVER_CAPABILITIES.localSourceBrowse.name))
    return null;
  const open = () => {
    const params = new URLSearchParams({ path: target.path });
    window.open(
      toBrowserAppHref(
        `${basePath}/projects/${target.projectId}/browse?${params.toString()}`,
      ),
      "_blank",
      "noopener",
    );
  };
  return (
    <MenuItem onMouseEnter={onHover} onSelect={open}>
      {t("fileLinkMenuOpenInSourceControl" as never)}
    </MenuItem>
  );
}

/**
 * Saves a resource download. On a transport whose `/api` URLs the browser can
 * address, a `directUrl` goes to the browser's own download, which reports
 * its failures. Otherwise fetched bytes go under `fileName`, and a failed
 * fetch is reported in an error toast: the menu has closed by the time the
 * fetch settles, and a viewer's download failure must not replace the file it
 * is showing. A URL is handed to the browser, whose own download UI reports
 * its failures.
 */
export function useSaveResourceDownload() {
  const { t } = useI18n();
  const showToast = useOptionalToastContext()?.showToast;
  const transport = useCurrentSourceRuntime().transport;
  const sameOriginUrls = transport.capabilities.sameOriginUrls;
  return useCallback(
    (download: ResourceDownload) => {
      if ("url" in download) {
        const anchor = document.createElement("a");
        anchor.href = download.url;
        anchor.click();
        return;
      }
      const { directUrl, fileName, loadBlob } = download;
      if (directUrl && sameOriginUrls) {
        downloadUrl(directUrl, fileName);
        return;
      }
      // A transport that streams bodies hands this one to the service worker,
      // which writes it to disk as it arrives; otherwise it is collected.
      const save =
        directUrl && transport.fetchStream && canStreamDownloadToDisk()
          ? transport
              .fetchStream(toSourceTransportApiPath(directUrl))
              .then((response) => saveStreamedDownload(response, fileName))
          : loadBlob().then((blob) => downloadBlob(blob, fileName));
      void save.catch((error: unknown) => {
        showToast?.(
          t("resourceDownloadFailed" as never, {
            fileName,
            reason: error instanceof Error ? error.message : String(error),
          }),
          "error",
        );
      });
    },
    [sameOriginUrls, showToast, t, transport],
  );
}

function CopyIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="5" y="5" width="9" height="9" rx="1.5" />
      <path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2H3.5A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" />
    </svg>
  );
}

export function ResourceContextMenu({
  x,
  y,
  canStartNewSession = true,
  onClose,
  onCopyAbsolutePath,
  onCopyContents,
  onCopyRenderedContents,
  onCopyFilePath,
  onCopyImage,
  onCopyLink,
  onCopyProjectRelativePath,
  onCopyPublicUrl,
  onCopyViewerLink,
  onCopyListing,
  folder = false,
  heading,
  download,
  localSource,
  onOpen,
  newTabHref,
  onOpenPreview,
  onOpenSource,
  onStartNewSession,
  onStop,
  stopLabel,
  fileTarget,
}: ResourceContextMenuProps) {
  const { t } = useI18n();
  const saveDownload = useSaveResourceDownload();
  const githubLink = useGitHubFileLink(fileTarget);
  const projectAppLink = useProjectFileLink(fileTarget);
  const insertDraft = useContext(ComposerInsertContext);
  const session = useOptionalSessionMetadata();
  const commentPath =
    insertDraft && fileTarget && session?.projectId === fileTarget.projectId
      ? () => {
          insertDraft(`${fileTarget.path}\n\n`);
        }
      : null;
  // A declared app presentation outranks the caller's YA file-share fallback;
  // the File Viewer's Share surface still offers both.
  const copyPublicUrl = projectAppLink
    ? () => {
        void writeClipboardText(projectAppLink);
      }
    : onCopyPublicUrl;
  const [panel, setPanel] = useState<"open" | "root">("root");
  // A submenu opened by hover leaves focus where it is; by click or key, it
  // takes focus.
  const [submenuTakesFocus, setSubmenuTakesFocus] = useState(false);
  const openItemRef = useRef<HTMLButtonElement | null>(null);
  const backItemRef = useRef<HTMLButtonElement | null>(null);
  const hasPresentationChoice = Boolean(onOpenSource && onOpenPreview);
  const hasCopyActions = Boolean(
    onCopyLink ||
      onCopyProjectRelativePath ||
      copyPublicUrl ||
      onCopyAbsolutePath ||
      onCopyFilePath ||
      onCopyImage ||
      onCopyViewerLink ||
      onCopyListing ||
      onCopyContents ||
      onCopyRenderedContents ||
      githubLink,
  );
  const usesHoverFlyout =
    window.innerWidth >= 520 &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  const githubDescription = githubLink
    ? !githubLink.pushed
      ? t("fileLinkGitHubUnpushed")
      : githubLink.dirty
        ? t("fileLinkGitHubDirty")
        : null
    : null;

  // The right-click that opened this menu came from a link that was almost
  // certainly showing its hover tooltip, and the pointer then holds still — so
  // without this the tooltip sits over the menu's first entries until the
  // reader moves far enough to shake it off.
  useEffect(() => beginTooltipSuppression(), []);

  // Opened at a point, the menu has no trigger to return focus to; focus
  // inside it at close goes back to what held focus when it opened.
  const [opener] = useState(() =>
    document.activeElement instanceof HTMLElement &&
    document.activeElement !== document.body
      ? document.activeElement
      : null,
  );
  const focusInsideRef = useRef(false);
  useLayoutEffect(
    () => () => {
      if (focusInsideRef.current && opener?.isConnected) {
        opener.focus({ preventScroll: true });
      }
    },
    [opener],
  );

  // The touch drill-in swaps the menu's items: keep focus on the panel shown.
  const shownPanelRef = useRef(panel);
  useLayoutEffect(() => {
    if (usesHoverFlyout || shownPanelRef.current === panel) return;
    shownPanelRef.current = panel;
    (panel === "open" ? backItemRef : openItemRef).current?.focus({
      preventScroll: true,
    });
  }, [panel, usesHoverFlyout]);

  const showSubmenu = (takeFocus: boolean) => {
    setSubmenuTakesFocus(takeFocus);
    setPanel("open");
  };
  const drilledIn = !usesHoverFlyout && panel === "open";
  const onRootHover = usesHoverFlyout ? () => setPanel("root") : undefined;

  const presentationItems = (
    <>
      {onOpenSource ? (
        <MenuItem
          onSelect={() => {
            onOpenSource();
            if (usesHoverFlyout) onClose();
          }}
        >
          {t("fileViewerSource" as never)}
        </MenuItem>
      ) : null}
      {onOpenPreview ? (
        <MenuItem
          onSelect={() => {
            onOpenPreview();
            if (usesHoverFlyout) onClose();
          }}
        >
          {t("fileViewerPreview" as never)}
        </MenuItem>
      ) : null}
    </>
  );

  const rootActions = (
    <>
      <MenuItem
        ref={openItemRef}
        keepOpen={hasPresentationChoice}
        aria-haspopup={hasPresentationChoice ? "menu" : undefined}
        aria-expanded={hasPresentationChoice ? panel === "open" : undefined}
        shortcut={hasPresentationChoice ? "›" : undefined}
        onMouseEnter={
          usesHoverFlyout && hasPresentationChoice
            ? () => showSubmenu(false)
            : undefined
        }
        onKeyDown={(event) => {
          if (event.key !== "ArrowRight" || !hasPresentationChoice) return;
          event.preventDefault();
          showSubmenu(true);
        }}
        onSelect={() => (hasPresentationChoice ? showSubmenu(true) : onOpen())}
      >
        {t("fileLinkMenuOpen" as never)}
      </MenuItem>
      {usesHoverFlyout && hasPresentationChoice ? (
        <Menu
          open={panel === "open"}
          onClose={(reason) => {
            setPanel("root");
            if (reason === "escape") openItemRef.current?.focus();
          }}
          anchorRef={openItemRef}
          placement="right-start"
          autoFocus={submenuTakesFocus}
          // Focus goes back by hand: a leaf that closes the whole menu must
          // not pull focus onto the Open item as it unmounts.
          returnFocus={false}
          aria-label={t("fileLinkMenuOpen" as never)}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft") return;
            event.preventDefault();
            setPanel("root");
            openItemRef.current?.focus();
          }}
        >
          {presentationItems}
        </Menu>
      ) : null}
      {newTabHref ? (
        <MenuItem
          onMouseEnter={onRootHover}
          onSelect={() => window.open(newTabHref, "_blank", "noopener")}
        >
          {t("fileLinkMenuOpenInNewTab" as never)}
        </MenuItem>
      ) : null}
      {commentPath ? (
        <MenuItem onMouseEnter={onRootHover} onSelect={commentPath}>
          {t("projectPathComment")}
        </MenuItem>
      ) : null}
      {download ? (
        <MenuItem
          onMouseEnter={onRootHover}
          onSelect={() => saveDownload(download)}
        >
          {t("resourceMenuDownload" as never)}
        </MenuItem>
      ) : null}
      {canStartNewSession && onStartNewSession ? (
        <MenuItem
          onMouseEnter={onRootHover}
          onSelect={() => onStartNewSession()}
        >
          {t("fileLinkMenuNewSession" as never)}
        </MenuItem>
      ) : null}
      {localSource ? (
        <OpenLocalSourceMenuItem target={localSource} onHover={onRootHover} />
      ) : null}
      {hasCopyActions ? <MenuSeparator /> : null}
      {onCopyImage ? (
        <MenuItem
          icon={<CopyIcon />}
          onMouseEnter={onRootHover}
          onSelect={() => onCopyImage()}
        >
          {t("fileLinkMenuCopyImage" as never)}
        </MenuItem>
      ) : null}
      {onCopyLink ? (
        <MenuItem
          icon={<CopyIcon />}
          onMouseEnter={onRootHover}
          onSelect={() => onCopyLink()}
        >
          {t("fileLinkMenuCopyLink")}
        </MenuItem>
      ) : null}
      {onCopyProjectRelativePath ? (
        <MenuItem
          icon={<CopyIcon />}
          onMouseEnter={onRootHover}
          onSelect={() => onCopyProjectRelativePath()}
        >
          {t("fileLinkMenuCopyProjectRelativePath" as never)}
        </MenuItem>
      ) : null}
      {copyPublicUrl ? (
        <MenuItem
          icon={<CopyIcon />}
          onMouseEnter={onRootHover}
          onSelect={() => copyPublicUrl()}
        >
          {t("fileLinkMenuCopyPublicUrl" as never)}
        </MenuItem>
      ) : null}
      {onCopyAbsolutePath ? (
        <MenuItem
          icon={<CopyIcon />}
          onMouseEnter={onRootHover}
          onSelect={() => onCopyAbsolutePath()}
        >
          {folder
            ? t("folderMenuCopyAbsolutePath" as never)
            : t("fileLinkMenuCopyAbsolutePath" as never)}
        </MenuItem>
      ) : null}
      {onCopyFilePath ? (
        <MenuItem
          icon={<CopyIcon />}
          onMouseEnter={onRootHover}
          onSelect={() => onCopyFilePath()}
        >
          {t("fileLinkMenuCopyFilePath" as never)}
        </MenuItem>
      ) : null}
      {onCopyViewerLink ? (
        <MenuItem
          icon={<CopyIcon />}
          onMouseEnter={onRootHover}
          onSelect={() => onCopyViewerLink()}
        >
          {t("fileLinkMenuCopyViewerLink" as never)}
        </MenuItem>
      ) : null}
      {onCopyListing ? (
        <MenuItem
          icon={<CopyIcon />}
          onMouseEnter={onRootHover}
          onSelect={() => onCopyListing()}
        >
          {t("folderMenuCopyListing" as never)}
        </MenuItem>
      ) : null}
      {onCopyContents ? (
        <MenuItem
          icon={<CopyIcon />}
          onMouseEnter={onRootHover}
          onSelect={() => onCopyContents()}
        >
          {t("fileLinkMenuCopyContents" as never)}
        </MenuItem>
      ) : null}
      {onCopyRenderedContents ? (
        <MenuItem
          icon={<CopyIcon />}
          onMouseEnter={onRootHover}
          onSelect={() => onCopyRenderedContents()}
        >
          {t("fileLinkMenuCopyRenderedContents" as never)}
        </MenuItem>
      ) : null}
      {onStop && stopLabel ? (
        <>
          <MenuSeparator />
          <MenuItem onMouseEnter={onRootHover} onSelect={() => onStop()}>
            {stopLabel}
          </MenuItem>
        </>
      ) : null}
      {githubLink ? (
        <MenuItem
          icon={<CopyIcon />}
          disabled={!githubLink.pushed}
          description={githubDescription}
          onMouseEnter={onRootHover}
          onSelect={() => void writeClipboardText(githubLink.url)}
        >
          {t("fileLinkMenuCopyGitHubLink")}
        </MenuItem>
      ) : null}
    </>
  );
  // The path names the actions below it: a labelled group, since a menu
  // holds only items, groups and separators.
  const rootItems = heading ? (
    <MenuGroup
      label={
        <span className={styles.heading} title={heading}>
          {/* Elide from the left; the path itself stays left-to-right. */}
          <bdi dir="ltr">{heading}</bdi>
        </span>
      }
    >
      {rootActions}
    </MenuGroup>
  ) : (
    rootActions
  );

  return (
    <Menu
      open
      onClose={() => onClose()}
      anchorPoint={{ x, y }}
      placement="bottom-start"
      returnFocus={false}
      aria-label={
        drilledIn
          ? t("fileLinkMenuOpen" as never)
          : (heading ?? t("resourceMenuActions" as never))
      }
      onFocus={() => {
        focusInsideRef.current = true;
      }}
      onBlur={(event) => {
        const next = event.relatedTarget;
        focusInsideRef.current =
          next instanceof Node && event.currentTarget.contains(next);
      }}
    >
      {drilledIn ? (
        <>
          <MenuItem
            ref={backItemRef}
            keepOpen
            icon="‹"
            onSelect={() => setPanel("root")}
          >
            {t("fileLinkMenuBack" as never)}
          </MenuItem>
          <MenuSeparator />
          {presentationItems}
        </>
      ) : (
        rootItems
      )}
    </Menu>
  );
}

/** File-oriented compatibility name for existing call sites. */
export const FilePathContextMenu = ResourceContextMenu;
