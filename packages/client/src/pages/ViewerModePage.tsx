import { useNavigate, useSearchParams } from "react-router-dom";
import { useState } from "react";
import { ArtifactLinkViewer } from "../components/ArtifactLinkViewer";
import { LocalFileModal } from "../components/LocalMediaModal";
import { Banner } from "../components/ui/Banner";
import { useVersion } from "../hooks/useVersion";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import { isArtifactLink } from "../lib/artifactPreview";
import { useI18n } from "../i18n";
import styles from "./ViewerModePage.module.css";

/** Authenticated, source-host-preserving destination for viewer mode links. */
export function ViewerModePage() {
  const [query] = useSearchParams();
  const [artifactHost, setArtifactHost] = useState<HTMLDivElement | null>(null);
  const navigate = useNavigate();
  const base = useRemoteBasePath();
  const { version } = useVersion();
  const { t } = useI18n();
  const close = () => navigate(`${base}/sessions`);
  const path = query.get("path");
  const projectId = query.get("projectId");
  const artifactUrl = query.get("artifactUrl");
  const mode = query.get("mode");
  const position = (key: string) => {
    const number = Number(query.get(key));
    return Number.isSafeInteger(number) && number > 0 ? number : undefined;
  };
  if (mode !== "edit" && mode !== "interactive")
    return <Banner tone="error">{t("fileInvalidUrl")}</Banner>;
  if (artifactUrl) {
    if (!version) return <p role="status">{t("sourceEditorLoading")}</p>;
    if (
      !isArtifactLink(artifactUrl, version.artifactViewer, window.location.href)
    )
      return <Banner tone="error">{t("artifactUnavailable")}</Banner>;
    return (
      <div className={styles.artifactHost} ref={setArtifactHost}>
        {artifactHost && (
          <ArtifactLinkViewer
            standalone
            portalTarget={artifactHost}
            inactive={false}
            initiallyEditing={mode === "edit"}
            controller={{
              kind: "artifact",
              id: artifactUrl,
              sessionId: "standalone",
              label:
                new URL(artifactUrl).pathname.split("/").at(-1) ?? artifactUrl,
              url: artifactUrl,
              close,
              minimize: close,
              restore: () => {},
              minimized: false,
            }}
          />
        )}
      </div>
    );
  }
  if (!path) return <Banner tone="error">{t("fileMissingPath")}</Banner>;
  return (
    <LocalFileModal
      resource={
        projectId
          ? {
              kind: "project-file",
              projectId,
              path,
              lineNumber: position("line"),
              columnNumber: position("column"),
            }
          : {
              kind: "local-file",
              path,
              lineNumber: position("line"),
              columnNumber: position("column"),
            }
      }
      initialMode={mode}
      onClose={close}
    />
  );
}
