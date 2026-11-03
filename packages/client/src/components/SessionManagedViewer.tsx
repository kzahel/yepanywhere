import {
  createContext,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
} from "react";
import { createPortal } from "react-dom";
import { QUOTE_SELECTION_ROOT_ATTRIBUTES } from "../lib/markdownSelectionCopy";
import styles from "./SessionManagedViewer.module.css";
import headerStyles from "./ViewerHeader.module.css";
import { useSessionRightPaneSetting } from "../hooks/useSessionRightPaneSetting";
import { usePanelSlideAnimations } from "../hooks/usePanelSlideAnimations";
import { useClosingPaneContent } from "../hooks/useClosingPaneContent";
import { sessionViewerUsesRightPane } from "../lib/sessionViewerPlacement";
import { useCurrentSourceRuntime } from "../contexts/SourceRuntimeContext";
import { useRetainedVersionInfo } from "../hooks/useVersion";
import { isArtifactLink } from "../lib/artifactPreview";
import { ArtifactLinkViewer } from "./ArtifactLinkViewer";
import {
  type SendSessionViewerComment,
  SessionViewerCommentProvider,
} from "../contexts/SessionViewerCommentContext";
import {
  clearSessionViewer,
  presentSessionViewer,
  restoreSessionViewer,
  sessionViewerFreezesTranscript,
  type SessionViewerRenderState,
  useSessionViewerRenderState,
  useSessionViewerController,
} from "../lib/sessionViewerController";
import { Modal, ModalChrome, useModalLayer } from "./ui/Modal";
import { SessionAppLinkContext } from "./SessionAppLinks";
import {
  publicSessionLocalhostHref,
  rewriteSessionLocalhostHref,
  type SessionAppConfig,
  sessionLocalhostRewriteApplies,
} from "../lib/sessionVhostApps";
import { useRelayUsername } from "../hooks/useRemoteBasePath";

interface SessionManagedPanelProps {
  viewerId?: string;
  sessionId: string;
  title: ReactNode;
  actions?: ReactNode;
  contentRef?: RefObject<HTMLDivElement | null>;
  label: string;
  briefLabel?: string;
  children: ReactNode;
  onClose: () => void;
}

const SessionViewerContext = createContext<string | null>(null);
const SessionFileViewerHostContext = createContext<{
  target: HTMLElement | null;
  inactive: boolean;
  /**
   * The viewer is a column beside the live session (the wide right pane), not
   * a layer over it, so it must not take document-level Escape or the scroll
   * lock from the session's own controls.
   */
  docked: boolean;
} | null>(null);

export function useSessionFileViewerHost() {
  return useContext(SessionFileViewerHostContext);
}
const SessionArtifactLinkContext = createContext<
  ((url: string, label: string) => boolean) | null
>(null);

export function useSessionArtifactLink() {
  return useContext(SessionArtifactLinkContext);
}

export function useSessionViewerSessionId(): string | null {
  return useContext(SessionViewerContext);
}

/** Publishes a content panel to the session's shared managed-viewer host. */
export function SessionManagedPanel({
  viewerId: suppliedViewerId,
  sessionId,
  title,
  actions,
  contentRef,
  label,
  briefLabel,
  children,
  onClose,
}: SessionManagedPanelProps) {
  const generatedViewerId = useId();
  const viewerId = suppliedViewerId ?? generatedViewerId;
  const mountedRef = useRef(true);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    presentSessionViewer({
      id: viewerId,
      kind: "panel",
      sessionId,
      title,
      actions,
      contentRef,
      label,
      briefLabel,
      content: children,
      onClose: () => {
        if (mountedRef.current) onCloseRef.current();
      },
    });
  }, [
    actions,
    briefLabel,
    children,
    contentRef,
    label,
    sessionId,
    title,
    viewerId,
  ]);

  return null;
}

export function SessionViewerProvider({
  sessionId,
  inactive = false,
  onSendComment,
  onOpenApp,
  onAnnounceApp,
  appConfig,
  rightPaneTarget,
  rightPaneWide = false,
  children,
}: {
  sessionId: string;
  inactive?: boolean;
  onSendComment?: SendSessionViewerComment;
  onOpenApp?: (url: string) => boolean;
  onAnnounceApp?: (url: string, label: string) => void;
  appConfig?: SessionAppConfig;
  rightPaneTarget?: HTMLElement | null;
  /** The right pane is a side-by-side column rather than a drawer over the session. */
  rightPaneWide?: boolean;
  children: ReactNode;
}) {
  const runtime = useCurrentSourceRuntime();
  const version = useRetainedVersionInfo(runtime.sourceKey);
  const relayUsername = useRelayUsername();
  const viewerId = useId();
  const appLinks = useMemo(() => {
    if (inactive) return null;
    const relayed = relayUsername !== undefined;
    const linkContext = () => ({ clientUrl: window.location.href, relayed });
    return {
      config: appConfig,
      open: onOpenApp,
      announce: onAnnounceApp,
      // Without a rewriter, rendered HTML is not parsed at all; with one that
      // could never change a destination, every streamed block would be.
      rewriteHref: sessionLocalhostRewriteApplies(appConfig, linkContext())
        ? (url: string) =>
            rewriteSessionLocalhostHref(url, appConfig, linkContext())
        : undefined,
      publicHref: (url: string) =>
        publicSessionLocalhostHref(url, appConfig, linkContext()),
    };
  }, [inactive, appConfig, onOpenApp, onAnnounceApp, relayUsername]);
  const openArtifact = useCallback(
    (url: string, label: string) => {
      if (
        inactive ||
        !isArtifactLink(url, version?.artifactViewer, window.location.href)
      )
        return false;
      presentSessionViewer({
        id: viewerId,
        kind: "artifact",
        sessionId,
        url,
        label,
      });
      restoreSessionViewer(viewerId);
      // An opened artifact is an App the session recalls after this viewer
      // closes, the same as a file viewer's play activation.
      onAnnounceApp?.(url, label);
      return true;
    },
    [inactive, onAnnounceApp, sessionId, version?.artifactViewer, viewerId],
  );
  return (
    <SessionViewerContext.Provider value={sessionId}>
      <SessionArtifactLinkContext.Provider value={openArtifact}>
        <SessionViewerCommentProvider onSendComment={onSendComment}>
          {/* Viewers the host renders belong to the session: a play activation
              inside one announces its App like any transcript content. */}
          <SessionAppLinkContext.Provider value={appLinks}>
            {children}
            <SessionManagedViewerHost
              sessionId={sessionId}
              inactive={inactive}
              rightPaneTarget={rightPaneTarget}
              rightPaneWide={rightPaneWide}
            />
          </SessionAppLinkContext.Provider>
        </SessionViewerCommentProvider>
      </SessionArtifactLinkContext.Provider>
    </SessionViewerContext.Provider>
  );
}

/** Keeps covered transcript props stable behind an expensive covering modal. */
export function SessionViewerTranscriptGate({
  children,
}: {
  children: ReactNode;
}) {
  const sessionId = useSessionViewerSessionId();
  const controller = useSessionViewerController();
  useSessionRightPaneSetting();
  const viewerOpen = Boolean(
    controller?.sessionId === sessionId &&
      sessionViewerFreezesTranscript(controller),
  );
  const renderedChildrenRef = useRef(children);
  if (!viewerOpen) {
    renderedChildrenRef.current = children;
  }
  return renderedChildrenRef.current;
}

export function SessionManagedViewerHost({
  sessionId,
  inactive = false,
  rightPaneTarget,
  rightPaneWide = false,
}: {
  sessionId: string;
  inactive?: boolean;
  rightPaneTarget?: HTMLElement | null;
  rightPaneWide?: boolean;
}) {
  const controller = useSessionViewerRenderState();
  const { sessionRightPaneEnabled } = useSessionRightPaneSetting();
  const { panelSlideDurationMs } = usePanelSlideAnimations();
  const controllerRef = useRef(controller);
  const lifecycleGenerationRef = useRef(0);
  controllerRef.current = controller;
  const activePanel =
    controller?.kind === "panel" && controller.sessionId === sessionId
      ? controller
      : null;
  const panel = useClosingPaneContent(
    activePanel,
    sessionRightPaneEnabled && (!controller || activePanel)
      ? panelSlideDurationMs
      : 0,
  );
  const activeFile =
    controller?.kind === "file" &&
    controller.sessionId === sessionId &&
    controller.renderContent
      ? controller
      : null;
  const file = useClosingPaneContent(
    activeFile,
    sessionRightPaneEnabled && (!controller || activeFile)
      ? panelSlideDurationMs
      : 0,
  );

  useEffect(() => {
    lifecycleGenerationRef.current += 1;
    return () => {
      const cleanupGeneration = lifecycleGenerationRef.current + 1;
      lifecycleGenerationRef.current = cleanupGeneration;
      queueMicrotask(() => {
        const active = controllerRef.current;
        if (
          lifecycleGenerationRef.current === cleanupGeneration &&
          active?.sessionId === sessionId
        ) {
          clearSessionViewer(active.id);
        }
      });
    };
  }, [sessionId]);

  if (file) {
    const content = (
      <SessionViewerContext.Provider value={null}>
        <SessionFileViewerHostContext.Provider
          value={{
            target: sessionViewerUsesRightPane(file)
              ? (rightPaneTarget ?? null)
              : null,
            inactive: inactive || file.minimized || controller?.id !== file.id,
            docked: sessionViewerUsesRightPane(file) && rightPaneWide,
          }}
        >
          {file.renderContent(inactive, sessionViewerUsesRightPane(file))}
        </SessionFileViewerHostContext.Provider>
      </SessionViewerContext.Provider>
    );
    if (sessionViewerUsesRightPane(file)) {
      if (!rightPaneTarget) return null;
      return createPortal(content, rightPaneTarget);
    }
    return content;
  }
  if (controller?.kind === "artifact" && controller.sessionId === sessionId)
    return (
      <ArtifactLinkViewer
        key={controller.url}
        controller={controller}
        inactive={inactive}
      />
    );
  if (!panel) return null;
  if (sessionViewerUsesRightPane(panel)) {
    if (!rightPaneTarget) return null;
    return createPortal(
      <SessionPanelPane
        panel={panel}
        inactive={inactive}
        docked={rightPaneWide}
      />,
      rightPaneTarget,
    );
  }
  return (
    <Modal
      title={panel.title}
      actions={panel.actions}
      contentRef={panel.contentRef}
      onClose={panel.close}
      onMinimize={panel.minimize}
      minimized={panel.minimized || inactive}
    >
      {panel.content}
    </Modal>
  );
}

/**
 * The session's detail panel as a right-pane column, in the covering modal's
 * chrome so a panel written for the modal needs no knowledge of where it is
 * shown. Docked beside the session it answers Escape only from inside itself;
 * as the narrow drawer over the session it is a modal layer.
 */
function SessionPanelPane({
  panel,
  inactive,
  docked,
}: {
  panel: Extract<SessionViewerRenderState, { kind: "panel" }>;
  inactive: boolean;
  docked: boolean;
}) {
  const hidden = panel.minimized || inactive;
  useModalLayer(panel.close, !hidden && !docked);
  return (
    <section
      className={styles.panePanel}
      role="dialog"
      aria-label={panel.label}
      hidden={hidden}
      onKeyDown={
        docked
          ? (event) => {
              if (event.key !== "Escape" || event.defaultPrevented) return;
              event.preventDefault();
              event.stopPropagation();
              panel.close();
            }
          : undefined
      }
      {...QUOTE_SELECTION_ROOT_ATTRIBUTES}
    >
      <ModalChrome
        title={panel.title}
        actions={panel.actions}
        headerClassName={headerStyles.header}
        identityClassName={headerStyles.identity}
        headerActionsClassName={headerStyles.actions}
        onMinimize={panel.minimize}
        onClose={panel.close}
        contentRef={panel.contentRef}
      >
        {panel.content}
      </ModalChrome>
    </section>
  );
}
