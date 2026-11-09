import {
  ARTIFACT_SANDBOX,
  serverHasCapability,
  SERVER_CAPABILITIES,
  type LocalResourceRef,
  type UrlProjectId,
} from "@yep-anywhere/shared";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { ResourceContextMenu } from "./FileResourceActions";
import { useSessionAppAnnouncer } from "./SessionAppLinks";
import { ViewerModeToggle } from "./ViewerModeToggle";
import { useScriptlessPreviewLinks } from "../hooks/useScriptlessPreviewLinks";
import { useArtifactGrant } from "../hooks/useArtifactGrant";
import { useArtifactTabHandoff } from "../hooks/useArtifactTabHandoff";
import { usePublicFileSharesCreatable } from "../hooks/usePublicFileSharesCreatable";
import { useI18n } from "../i18n";
import { writeClipboardTextLater } from "../lib/clipboard";
import { reuseOrCreatePublicFileShareUrl } from "../lib/publicFileShareLink";
import { publicSharePlayUrlFromFileShareUrl } from "../lib/publicSharePlay";
import { createScriptlessHtmlPreviewDocument } from "../lib/scriptlessHtmlPreview";
import type { ViewerFindSource } from "../lib/viewerFind";
import { useCurrentSourceRuntime } from "../contexts/SourceRuntimeContext";
import { usePublicShareContext } from "../contexts/PublicShareContext";
import { useRetainedVersionInfo } from "../hooks/useVersion";
import { MANAGED_ARTIFACT_PARENTS } from "../lib/managedArtifactViewer";
import { ManagedArtifactPreview } from "./ManagedArtifactPreview";
import { Banner } from "./ui/Banner";
import styles from "./ArtifactPreview.module.css";

export interface ArtifactPreviewProps {
  html: string;
  path: string;
  projectId?: string;
  title: string;
  className?: string;
  /** Start only when the owning viewer received an explicit preview click. */
  autoStart?: boolean;
  /** The owning viewer may supply the source/preview toggle in its header. */
  showControls?: boolean;
  toolbarHost?: HTMLElement | null;
  /** Changing this remounts a running frame so it refetches from disk. */
  reloadKey?: number;
  /**
   * The frame now showing, so the owning viewer can search it: the scriptless
   * preview directly, a running artifact through its find agent.
   */
  onFindSource?: (source: ViewerFindSource | null) => void;
  /** The file's absolute path, so the preview's relative links name files. */
  documentPath?: string | null;
  /**
   * Opens a file the scriptless preview links to. The frame cannot open it
   * itself: it has no scripts, no popups, and no file base URL.
   */
  onLocalResourceLink?: (
    resource: LocalResourceRef,
    anchor: HTMLAnchorElement,
  ) => void;
}

/**
 * The scriptless preview is same-origin so the trusted viewer can search it,
 * and never also `allow-scripts`: the pair would hand the previewed HTML YA's
 * origin. Its CSP denies scripts as well (scriptlessHtmlPreview.ts).
 */
export const SCRIPTLESS_PREVIEW_SANDBOX = "allow-same-origin";

export function ArtifactPreview(props: ArtifactPreviewProps) {
  const runtime = useCurrentSourceRuntime();
  // Native capabilities arrive with hello. A retained cached version must not
  // leave the pane on its initial fallback after that source becomes ready.
  const statusStore = useMemo(
    () => ({
      subscribe: (listener: () => void) =>
        runtime.transport.status.subscribe(listener),
      getSnapshot: () =>
        runtime.transport.capabilities.packagedArtifactViewerVersion ?? 0,
    }),
    [runtime.transport],
  );
  const packagedViewerVersion = useSyncExternalStore(
    statusStore.subscribe,
    statusStore.getSnapshot,
    statusStore.getSnapshot,
  );
  const version = useRetainedVersionInfo(runtime.sourceKey);
  const share = usePublicShareContext();
  const managed =
    share === null &&
    (MANAGED_ARTIFACT_PARENTS.has(location.origin) ||
      (location.origin === "https://appassets.androidplatform.net" &&
        packagedViewerVersion === 1)) &&
    /Chrome|Chromium|Edg\//.test(navigator.userAgent) &&
    !version?.artifactViewer?.publicOrigin &&
    serverHasCapability(version, SERVER_CAPABILITIES.artifactRelayPreview.name);
  return managed ? (
    <ManagedArtifactPreview {...props} />
  ) : (
    <ConfiguredArtifactPreview {...props} />
  );
}

function ConfiguredArtifactPreview(props: ArtifactPreviewProps) {
  const { t } = useI18n();
  const [attempt, setAttempt] = useState(props.autoStart ? 1 : 0);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const { origin, grant, busy, failed, frameBlocked } = useArtifactGrant(
    props.path,
    props.projectId,
    attempt,
  );
  // A running preview is an App the session should be able to recall from
  // its App action after the viewer closes, minimized or not.
  const announceApp = useSessionAppAnnouncer();
  // Rendering reparses a possibly multi-megabyte document; do it per source.
  const scriptlessDocument = useMemo(
    () => createScriptlessHtmlPreviewDocument(props.html, props.documentPath),
    [props.html, props.documentPath],
  );
  const [frame, setFrame] = useState<HTMLIFrameElement | null>(null);
  const running = Boolean(grant);
  useArtifactTabHandoff(running ? frame : null, grant?.url);
  const { onFindSource } = props;
  useEffect(() => {
    onFindSource?.(frame ? { kind: running ? "agent" : "frame", frame } : null);
  }, [frame, running, onFindSource]);
  useEffect(() => () => onFindSource?.(null), [onFindSource]);
  useScriptlessPreviewLinks(frame, running, props.onLocalResourceLink);
  useEffect(() => {
    if (grant) announceApp(grant.url, props.title);
  }, [grant, props.title, announceApp]);

  const controls = origin && (props.showControls !== false || failed) && (
    <div className={styles.toolbar}>
      <ViewerModeToggle
        mode="interactive"
        source={{ path: props.path, projectId: props.projectId }}
        artifact
        active={Boolean(grant)}
        disabled={busy}
        onToggle={() =>
          grant ? setAttempt(0) : setAttempt((value) => value + 1)
        }
        onContextMenu={
          grant
            ? (event) => {
                event.preventDefault();
                setMenu({ x: event.clientX, y: event.clientY });
              }
            : undefined
        }
        label={t(
          grant
            ? "artifactStop"
            : busy
              ? "artifactChecking"
              : failed
                ? "artifactRetry"
                : "artifactRun",
        )}
      />
      {failed && <span role="status">{t("artifactUnavailable")}</span>}
    </div>
  );
  const runningMenu = menu && grant && (
    <RunningPreviewMenu
      x={menu.x}
      y={menu.y}
      grantUrl={grant.url}
      path={props.path}
      projectId={props.projectId}
      onClose={() => setMenu(null)}
      onStop={() => setAttempt(0)}
    />
  );
  return (
    <div className={`${styles.preview} ${props.className ?? ""}`}>
      {props.toolbarHost ? createPortal(controls, props.toolbarHost) : controls}
      {runningMenu}
      {props.showControls === false && busy && (
        <div className={styles.status} role="status">
          {t("artifactChecking")}
        </div>
      )}
      {props.autoStart && !origin && (
        <Banner tone="warning" className={styles.message}>
          {t("artifactUnavailable")}
        </Banner>
      )}
      {grant && frameBlocked ? (
        <Banner
          tone="warning"
          role="alert"
          className={styles.message}
          actions={
            <a
              className={styles.openLink}
              href={grant.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t("artifactOpenTab")}
            </a>
          }
        >
          {t("artifactFrameBlocked")}
        </Banner>
      ) : grant ? (
        <iframe
          key={`${grant.id}:${props.reloadKey ?? 0}`}
          ref={setFrame}
          className={styles.frame}
          title={props.title}
          aria-label={props.title}
          sandbox={ARTIFACT_SANDBOX}
          referrerPolicy="no-referrer"
          src={grant.url}
        />
      ) : (
        <iframe
          ref={setFrame}
          className={styles.frame}
          title={props.title}
          aria-label={props.title}
          sandbox={SCRIPTLESS_PREVIEW_SANDBOX}
          referrerPolicy="no-referrer"
          srcDoc={scriptlessDocument}
        />
      )}
    </div>
  );
}

/**
 * Right-click on the running toggle: open the grant in a tab, copy a public
 * URL, or stop. The public URL is the file's public file share in play form,
 * the same link the File Viewer's share dialog copies while the preview runs.
 * It is never a public artifact grant, which would expose the file's whole
 * directory with no way to list or revoke it.
 */
function RunningPreviewMenu({
  x,
  y,
  grantUrl,
  path,
  projectId,
  onClose,
  onStop,
}: {
  x: number;
  y: number;
  grantUrl: string;
  path: string;
  projectId: string | undefined;
  onClose: () => void;
  onStop: () => void;
}) {
  const { t } = useI18n();
  const canCreateFileShare = usePublicFileSharesCreatable();
  return (
    <ResourceContextMenu
      x={x}
      y={y}
      canStartNewSession={false}
      onClose={onClose}
      onOpen={() => window.open(grantUrl, "_blank", "noopener,noreferrer")}
      fileTarget={projectId ? { projectId, path } : undefined}
      onCopyPublicUrl={
        canCreateFileShare && projectId
          ? () =>
              void writeClipboardTextLater(
                reuseOrCreatePublicFileShareUrl(
                  projectId as UrlProjectId,
                  path,
                ).then((url) => publicSharePlayUrlFromFileShareUrl(url) ?? url),
              )
          : undefined
      }
      onStop={onStop}
      stopLabel={t("artifactStop")}
    />
  );
}
