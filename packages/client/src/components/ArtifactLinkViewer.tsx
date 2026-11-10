import { ARTIFACT_SANDBOX } from "@yep-anywhere/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useArtifactTabHandoff } from "../hooks/useArtifactTabHandoff";
import { useViewerFind } from "../hooks/useViewerFind";
import { useI18n } from "../i18n";
import type { SessionViewerControllerState } from "../lib/sessionViewerController";
import {
  useModalBackGesture,
  useModalBackspace,
  useModalLayer,
} from "./ui/Modal";
import { Banner } from "./ui/Banner";
import styles from "./ArtifactLinkViewer.module.css";
import headerStyles from "./ViewerHeader.module.css";
import { ViewerFindField } from "./ViewerFindField";
import { ViewerWindowActions } from "./ViewerWindowActions";
import { SourceEditAction } from "./SourceEditor";

export function ArtifactLinkViewer({
  controller,
  inactive,
  initiallyEditing = false,
  portalTarget,
  standalone = false,
}: {
  controller: Extract<SessionViewerControllerState, { kind: "artifact" }>;
  inactive: boolean;
  initiallyEditing?: boolean;
  portalTarget?: HTMLElement;
  standalone?: boolean;
}) {
  const { t } = useI18n();
  const hidden = inactive || controller.minimized;
  const closeRef = useRef<HTMLButtonElement>(null);
  const [blocked, setBlocked] = useState(false);
  // Manual only: the artifact origin serves from disk per request with
  // no-store, so remounting the frame refetches; nothing watches the file.
  const [reloadKey, setReloadKey] = useState(0);
  const [frame, setFrame] = useState<HTMLIFrameElement | null>(null);
  const find = useViewerFind(
    useMemo(
      () => (frame ? ({ kind: "agent", frame } as const) : null),
      [frame],
    ),
  );
  useArtifactTabHandoff(frame, controller.url);
  useModalBackGesture(
    controller.close,
    !hidden && !standalone,
    "__artifactViewer",
  );
  useModalBackspace(controller.close, !hidden && !standalone);
  useModalLayer(controller.close, !hidden && !standalone);
  useEffect(() => {
    if (!hidden) closeRef.current?.focus();
  }, [hidden]);
  useEffect(() => {
    const origin = new URL(controller.url).origin;
    const onViolation = (event: SecurityPolicyViolationEvent) => {
      if (
        event.disposition === "enforce" &&
        event.effectiveDirective === "frame-src" &&
        (event.blockedURI === origin ||
          event.blockedURI.startsWith(`${origin}/`))
      )
        setBlocked(true);
    };
    document.addEventListener("securitypolicyviolation", onViolation);
    return () =>
      document.removeEventListener("securitypolicyviolation", onViolation);
  }, [controller.url]);
  const layer =
    portalTarget ??
    document.querySelector<HTMLElement>(
      "[data-navigation-route-layer][data-navigation-active] [data-session-viewer-layer]",
    ) ??
    document.querySelector<HTMLElement>("[data-session-viewer-layer]");
  if (!layer) return null;
  return createPortal(
    <section
      className={styles.viewer}
      role="dialog"
      aria-label={controller.label}
      hidden={hidden}
    >
      <header className={`${headerStyles.header} ${styles.header}`}>
        <span className={headerStyles.identity}>
          <span className={styles.title} title={controller.label}>
            {controller.label}
          </span>
        </span>
        <ViewerFindField find={find} />
        <SourceEditAction
          source={{ artifactUrl: controller.url }}
          artifact
          initiallyOpen={initiallyEditing}
        />
        <ViewerWindowActions
          className={headerStyles.actions}
          url={controller.url}
          onReload={() => setReloadKey((value) => value + 1)}
          onMinimize={controller.minimize}
          onClose={controller.close}
          closeRef={closeRef}
        />
      </header>
      {blocked ? (
        <Banner tone="warning" role="alert" className={styles.message}>
          {t("artifactLinkFrameBlocked")}
        </Banner>
      ) : (
        <iframe
          key={reloadKey}
          ref={setFrame}
          className={styles.frame}
          title={controller.label}
          src={controller.url}
          sandbox={ARTIFACT_SANDBOX}
          referrerPolicy="no-referrer"
        />
      )}
    </section>,
    layer,
  );
}
