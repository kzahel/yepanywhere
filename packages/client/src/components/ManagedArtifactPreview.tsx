import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ARTIFACT_SANDBOX } from "@yep-anywhere/shared";
import { ComposerInsertContext } from "../contexts/ComposerInsertContext";
import { useCurrentSourceRuntime } from "../contexts/SourceRuntimeContext";
import { useScriptlessPreviewLinks } from "../hooks/useScriptlessPreviewLinks";
import { useLocalFileScope } from "../hooks/useLocalFileScope";
import { useOptionalSessionMetadata } from "../contexts/SessionMetadataContext";
import { getResolvedTheme } from "../hooks/useTheme";
import {
  reclaimArtifactPreviewLeases,
  retainArtifactPreviewLease,
} from "../lib/artifactPreviewLeaseCleanup";
import { useI18n } from "../i18n";
import {
  type ArtifactPreviewLease,
  connectManagedArtifactViewer,
  managedArtifactUrl,
} from "../lib/managedArtifactViewer";
import { createScriptlessHtmlPreviewDocument } from "../lib/scriptlessHtmlPreview";
import type { ArtifactPreviewProps } from "./ArtifactPreview";
import { SCRIPTLESS_PREVIEW_SANDBOX } from "./ArtifactPreview";
import { ViewerModeToggle } from "./ViewerModeToggle";
import styles from "./ArtifactPreview.module.css";

type ViewerLease = ArtifactPreviewLease & {
  viewer: string;
  url: string;
  admission: string;
};
export function ManagedArtifactPreview(props: ArtifactPreviewProps) {
  const { t } = useI18n();
  const runtime = useCurrentSourceRuntime();
  const sessionId = useLocalFileScope()?.sessionId;
  const projectPath = useOptionalSessionMetadata()?.projectPath;
  const insert = useContext(ComposerInsertContext);
  const identity = `${runtime.sourceKey}:${sessionId ?? ""}:${props.path}`;
  const callbacks = useRef({
    insert,
    onFindSource: props.onFindSource,
    identity,
    title: props.title,
  });
  callbacks.current = {
    insert,
    onFindSource: props.onFindSource,
    identity,
    title: props.title,
  };
  const [stoppedIdentity, setStoppedIdentity] = useState<string | null>(null);
  const stopped = stoppedIdentity === identity;
  const [revision, setRevision] = useState(0);
  const admission = `${identity}:${revision}:${props.reloadKey ?? 0}`;
  const [lease, setLease] = useState<ViewerLease | null>(null);
  const [frame, setFrame] = useState<HTMLIFrameElement | null>(null);
  const [busy, setBusy] = useState(true);
  const [failed, setFailed] = useState(false);
  const state = useRef<{ path: string; value: unknown }>({
    path: identity,
    value: null,
  });
  if (state.current.path !== identity)
    state.current = { path: identity, value: null };
  const base = sessionId
    ? `/sessions/${encodeURIComponent(sessionId)}/artifact-previews`
    : "/artifact-previews";
  const path = props.documentPath ?? props.path;
  const entry =
    sessionId &&
    !path.startsWith("/") &&
    !/^[A-Za-z]:[\\/]/.test(path) &&
    !path.startsWith("~") &&
    projectPath
      ? `${projectPath.replace(/\/+$/, "")}/${path}`
      : path;
  const scriptless = useMemo(
    () => createScriptlessHtmlPreviewDocument(props.html, props.documentPath),
    [props.html, props.documentPath],
  );
  useEffect(() => {
    if (stopped) {
      setLease(null);
      setBusy(false);
      return;
    }
    let cancelled = false;
    let cleanup: (() => Promise<void>) | undefined;
    const release = () => {
      void cleanup?.().catch(() => {});
    };
    setLease(null);
    setBusy(true);
    setFailed(false);
    void reclaimArtifactPreviewLeases(runtime.sourceKey, runtime.transport)
      .then(async () => {
        if (cancelled) return;
        const value = await runtime.transport.fetch<ArtifactPreviewLease>(
          base,
          {
            method: "POST",
            body: JSON.stringify({
              path: entry,
              ...(!sessionId && props.projectId
                ? { projectId: props.projectId }
                : {}),
            }),
          },
        );
        if (
          !value ||
          typeof value.id !== "string" ||
          typeof value.entry !== "string" ||
          typeof value.expiresAt !== "number"
        )
          throw new Error("Invalid preview lease");
        cleanup = await retainArtifactPreviewLease(
          runtime.sourceKey,
          base,
          value,
          runtime.transport,
        );
        if (cancelled) {
          release();
          return;
        }
        const viewer = crypto.randomUUID().replaceAll("-", "");
        setLease({
          ...value,
          admission,
          viewer,
          url: managedArtifactUrl(viewer, location.origin),
        });
      })
      .catch(() => {
        if (!cancelled) {
          setBusy(false);
          setFailed(true);
        }
      });
    return () => {
      cancelled = true;
      release();
    };
  }, [entry, base, props.projectId, runtime, sessionId, stopped, admission]);
  useEffect(() => {
    if (!frame || !lease || failed || frame.src !== lease.url) return;
    const ownedState = state.current;
    const close = connectManagedArtifactViewer({
      frame,
      viewerId: lease.viewer,
      lease,
      base,
      transport: runtime.transport,
      title: callbacks.current.title,
      theme: getResolvedTheme(),
      widgetState: ownedState.value,
      onWidgetState: (value) => {
        ownedState.value = value;
      },
      onFollowUp: (text) => {
        if (callbacks.current.identity === identity)
          callbacks.current.insert?.(text);
      },
      onReady: () => setBusy(false),
      onFailure: () => {
        setFailed(true);
        setBusy(false);
        void runtime.transport
          .fetch(`${base}/${encodeURIComponent(lease.id)}`, {
            method: "DELETE",
          })
          .catch(() => {});
      },
    });
    return () => {
      void close();
    };
  }, [frame, lease, base, runtime, failed, identity]);
  useEffect(() => {
    callbacks.current.onFindSource?.(
      frame ? { kind: lease && !failed ? "agent" : "frame", frame } : null,
    );
    return () => callbacks.current.onFindSource?.(null);
  }, [frame, lease, failed]);
  const running =
    lease !== null && lease.admission === admission && !failed && !stopped;
  useScriptlessPreviewLinks(frame, running, props.onLocalResourceLink);
  const preparing =
    !stopped && !failed && (!lease || lease.admission !== admission || busy);
  const controls = (props.showControls !== false || failed) && (
    <div className={styles.toolbar}>
      <ViewerModeToggle
        mode="interactive"
        source={{ path: props.path, projectId: props.projectId }}
        artifact
        active={running}
        disabled={busy}
        onToggle={() => {
          if (running) setStoppedIdentity(identity);
          else {
            setStoppedIdentity(null);
            setRevision((n) => n + 1);
          }
        }}
        label={t(
          running
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
  return (
    <div className={`${styles.preview} ${props.className ?? ""}`}>
      {props.toolbarHost ? createPortal(controls, props.toolbarHost) : controls}
      {busy && props.showControls === false && (
        <div className={styles.status} role="status">
          {t("artifactChecking")}
        </div>
      )}
      {running ? (
        <iframe
          key={lease.viewer}
          ref={setFrame}
          className={styles.frame}
          title={props.title}
          aria-label={props.title}
          sandbox={ARTIFACT_SANDBOX}
          referrerPolicy="no-referrer"
          src={lease.url}
        />
      ) : preparing ? null : (
        <iframe
          ref={setFrame}
          className={styles.frame}
          title={props.title}
          aria-label={props.title}
          sandbox={SCRIPTLESS_PREVIEW_SANDBOX}
          referrerPolicy="no-referrer"
          srcDoc={scriptless}
        />
      )}
    </div>
  );
}
