import { ARTIFACT_SANDBOX } from "@yep-anywhere/shared";
import {
  type Ref,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useArtifactTabHandoff } from "../hooks/useArtifactTabHandoff";
import type { useSessionRightPane } from "../hooks/useSessionRightPane";
import { useViewerFind } from "../hooks/useViewerFind";
import { useI18n } from "../i18n";
import { createLocalStorageValue } from "../lib/localStorageValue";
import { UI_KEYS } from "../lib/storageKeys";
import styles from "./SessionRightPane.module.css";
import { AppViewerToolbar } from "./AppViewerToolbar";
import { LastViewIcon } from "./LastViewIcon";
import { ViewerFindField } from "./ViewerFindField";
import { ViewerWindowActions } from "./ViewerWindowActions";
import { Banner } from "./ui/Banner";
import { ButtonBase, buttonClassName, IconButton } from "./ui/Button";
import { ComposerMicAction } from "./ComposerMicAction";
import type { VoiceInputButtonRef } from "./VoiceInputButton";
import { suppressTooltipsFor } from "../hooks/useTooltipAppearance";
import { usePanelSlideAnimations } from "../hooks/usePanelSlideAnimations";
import { useClosingPaneContent } from "../hooks/useClosingPaneContent";

type Pane = ReturnType<typeof useSessionRightPane>;
const widthStore = createLocalStorageValue(
  UI_KEYS.sessionRightPaneWidth,
  480,
  (raw) => {
    const value = Number(raw);
    return Number.isFinite(value) && value >= 280 && value <= 1600
      ? value
      : undefined;
  },
);

export function SessionAppAction({ pane }: { pane: Pane }) {
  const { t } = useI18n();
  const app = pane.apps.at(-1);
  if (!app) return null;
  return pane.enabled ? (
    <IconButton
      className={styles.launcher}
      onClick={() =>
        pane.selected && pane.expanded ? pane.close() : pane.select(app.url)
      }
      aria-pressed={!!pane.selected && pane.expanded}
      label={t("sessionRightPaneApps")}
      tooltip={app.label}
    >
      {/* An icon, not a label, keeps the session title's room in the header. */}
      <LastViewIcon />
    </IconButton>
  ) : (
    <a
      className={buttonClassName({
        variant: "ghost",
        className: styles.launcher,
      })}
      href={app.url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`${t("sessionRightPaneApps")} ↗`}
      title={app.label}
    >
      <LastViewIcon /> ↗
    </a>
  );
}

/** Retain closing content only for the right pane's slide-out animation. */
export function SessionRightPane({
  projectApp,
  projectAppOpen = false,
  onHideProjectApp,
  voice,
  pane,
  wide,
  fullView = false,
  fileContentRef,
}: {
  projectApp?: ReactNode;
  projectAppOpen?: boolean;
  onHideProjectApp?: () => void;
  voice?: VoiceInputButtonRef | null;
  pane: Pane;
  wide: boolean;
  /** Cover the whole window, sidebar and session too, until minimized. */
  fullView?: boolean;
  fileContentRef?: Ref<HTMLDivElement>;
}) {
  const { panelSlideDurationMs } = usePanelSlideAnimations();
  const content = useClosingPaneContent(
    pane.selected || pane.paneViewer ? pane : null,
    panelSlideDurationMs,
  );
  return (
    <SessionRightPaneContent
      projectApp={projectApp}
      projectAppOpen={projectAppOpen}
      onHideProjectApp={onHideProjectApp}
      voice={voice}
      pane={content ?? pane}
      expanded={pane.expanded || projectAppOpen}
      wide={wide}
      fullView={fullView}
      fileContentRef={fileContentRef}
    />
  );
}

/** Minimized panes keep their frame mounted for restore. */
function SessionRightPaneContent({
  projectApp,
  projectAppOpen,
  onHideProjectApp,
  voice,
  pane,
  expanded,
  wide,
  fullView,
  fileContentRef,
}: {
  projectApp?: ReactNode;
  projectAppOpen: boolean;
  onHideProjectApp?: () => void;
  voice?: VoiceInputButtonRef | null;
  pane: Pane;
  expanded: boolean;
  wide: boolean;
  fullView: boolean;
  fileContentRef?: Ref<HTMLDivElement>;
}) {
  const { t } = useI18n();
  const root = useRef<HTMLElement>(null);
  const appRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(widthStore.read);
  const [maxWidth, setMaxWidth] = useState(1600);
  const visibleWidth = Math.min(width, maxWidth);
  const [dragging, setDragging] = useState(false);
  const [blockedUrl, setBlockedUrl] = useState<string | null>(null);
  // Remounting the frame refetches it; artifacts and apps serve per request.
  const [reloadKey, setReloadKey] = useState(0);
  // Only artifact frames carry the find agent; a proxied app keeps the
  // browser's own find.
  const [frame, setFrame] = useState<HTMLIFrameElement | null>(null);
  const artifactFrame = pane.selected?.artifactToken ? frame : null;
  const find = useViewerFind(
    useMemo(
      () =>
        artifactFrame
          ? ({ kind: "agent", frame: artifactFrame } as const)
          : null,
      [artifactFrame],
    ),
  );
  const url = pane.selected?.url;
  useArtifactTabHandoff(artifactFrame, url);
  const viewerIdentity =
    url ?? pane.paneViewer?.id ?? (projectApp ? "project-app" : undefined);
  const hide = projectAppOpen ? onHideProjectApp : pane.hide;
  useLayoutEffect(() => {
    if (!viewerIdentity) return;
    const parent = root.current?.parentElement;
    if (!parent) return;
    const measure = () =>
      setMaxWidth(Math.max(280, Math.min(1600, parent.clientWidth * 0.6)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    return () => observer.disconnect();
  }, [viewerIdentity]);
  useLayoutEffect(() => {
    if (!viewerIdentity) return;
    const parent = root.current?.parentElement;
    parent?.style.setProperty(
      "--session-right-pane-width",
      `${visibleWidth}px`,
    );
    return () => {
      parent?.style.removeProperty("--session-right-pane-width");
    };
  }, [visibleWidth, viewerIdentity]);
  useEffect(() => {
    if (!url) return;
    const blocked = (event: SecurityPolicyViolationEvent) => {
      if (
        event.effectiveDirective === "frame-src" &&
        (event.blockedURI === url || event.blockedURI === new URL(url).origin)
      )
        setBlockedUrl(url);
    };
    document.addEventListener("securitypolicyviolation", blocked);
    return () =>
      document.removeEventListener("securitypolicyviolation", blocked);
  }, [url]);
  // The pane's ancestors stack below the desktop sidebar, so full view hides
  // the sidebar rather than trying to paint over it.
  useEffect(() => {
    if (!fullView) return;
    document.documentElement.dataset.appFullView = "";
    return () => {
      delete document.documentElement.dataset.appFullView;
    };
  }, [fullView]);
  useEffect(() => {
    // Full view covers everything, so Escape leaves it at any width.
    if ((wide && !fullView) || !expanded || pane.paneViewer) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") hide?.();
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [wide, fullView, expanded, hide, pane.paneViewer]);
  function resize(value: number) {
    const next = Math.max(280, Math.min(maxWidth, value));
    setWidth(next);
    return next;
  }
  return (
    <>
      {!wide && expanded && (
        <ButtonBase
          className={styles.backdrop}
          onClick={hide}
          aria-label={t("sessionRightPaneHide")}
        />
      )}
      <aside
        ref={root}
        aria-label={t("sessionRightPaneLabel")}
        aria-hidden={!expanded}
        inert={!expanded}
        data-resizing={dragging}
        style={wide && !fullView ? { width: visibleWidth } : undefined}
        className={`${styles.pane} ${!expanded ? styles.hidden : ""} ${projectAppOpen ? styles.projectFullscreen : ""} ${fullView ? styles.fullView : ""}`}
      >
        {wide && (
          <div
            role="separator"
            tabIndex={0}
            aria-orientation="vertical"
            aria-label={t("sessionRightPaneResize")}
            aria-valuemin={280}
            aria-valuemax={maxWidth}
            aria-valuenow={visibleWidth}
            className={styles.splitter}
            onPointerDown={(event) => {
              event.preventDefault();
              event.currentTarget.setPointerCapture(event.pointerId);
              setDragging(true);
            }}
            onPointerMove={(event) => {
              if (!event.currentTarget.hasPointerCapture(event.pointerId))
                return;
              const right = root.current?.getBoundingClientRect().right;
              if (right !== undefined) resize(right - event.clientX);
            }}
            onPointerUp={(event) => {
              event.currentTarget.releasePointerCapture(event.pointerId);
              widthStore.set(width);
              setDragging(false);
            }}
            onLostPointerCapture={() => setDragging(false)}
            onKeyDown={(event) => {
              const next =
                event.key === "ArrowLeft"
                  ? visibleWidth + 20
                  : event.key === "ArrowRight"
                    ? visibleWidth - 20
                    : event.key === "Home"
                      ? 280
                      : event.key === "End"
                        ? maxWidth
                        : undefined;
              if (next === undefined) return;
              event.preventDefault();
              widthStore.set(resize(next));
            }}
          />
        )}
        {pane.selected && (
          <div
            ref={appRef}
            className={styles.appContent}
            hidden={projectAppOpen}
          >
            <AppViewerToolbar viewerRef={appRef}>
              <span className={styles.title} title={pane.selected.label}>
                {pane.selected.label}
              </span>
              <ViewerFindField find={find} />
              {voice && <ComposerMicAction voice={voice} />}
              <ViewerWindowActions
                url={pane.selected.url}
                copyUrl={pane.copyUrl}
                onMinimize={pane.hide}
                onReload={() => setReloadKey((value) => value + 1)}
                reloadLabel={
                  pane.selected.artifactToken
                    ? undefined
                    : t("sessionRightPaneReloadApp")
                }
                onClose={pane.canKill ? () => void pane.kill() : undefined}
                onMoveOut={pane.close}
                destructiveClose={!pane.selected.artifactToken}
                closeDisabled={pane.killing}
                minimizeLabel={t("sessionRightPaneHide")}
                closeLabel={t(
                  pane.selected.artifactToken
                    ? "sessionRightPaneClose"
                    : "sessionRightPaneKill",
                )}
              />
            </AppViewerToolbar>
            {pane.appStatus === "checking" ? (
              <p className={styles.status} role="status">
                {t("sessionRightPaneChecking")}
              </p>
            ) : pane.appStatus === "unavailable" ||
              pane.appStatus === "error" ? (
              <Banner tone="error" className={styles.message}>
                {pane.appError ?? t("sessionRightPaneUnavailable")}
              </Banner>
            ) : blockedUrl === url ? (
              <Banner tone="warning" className={styles.message}>
                {t("sessionRightPaneFrameBlocked")}
              </Banner>
            ) : (
              // biome-ignore lint/a11y/useIframeTitle: aria-label names the frame without a native tooltip over the app content.
              <iframe
                key={`${pane.frameKey}:${url}:${reloadKey}`}
                ref={setFrame}
                src={url}
                onLoad={pane.onFrameLoad}
                title=""
                aria-label={pane.selected.label}
                onPointerEnter={() => suppressTooltipsFor(0)}
                referrerPolicy="no-referrer"
                sandbox={
                  pane.selected.artifactToken
                    ? ARTIFACT_SANDBOX
                    : "allow-scripts allow-same-origin allow-forms allow-downloads"
                }
                className={styles.frame}
              />
            )}
          </div>
        )}
        {projectApp && (
          <div className={styles.appContent} hidden={!projectAppOpen}>
            {projectApp}
          </div>
        )}
        <div
          ref={fileContentRef}
          className={styles.fileContent}
          data-session-right-pane-layer
          hidden={!pane.paneViewer || projectAppOpen}
        />
        {dragging && <div className={styles.dragShield} />}
      </aside>
    </>
  );
}
