import viewerStyles from "../components/FileViewer.module.css";
import filePageStyles from "./FilePageLayout.module.css";
import { DEFAULT_RELAY_URL, normalizeRelayUrl } from "@yep-anywhere/shared";
import { useMemo } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { FileViewer, type FileViewerSource } from "../components/FileViewer";
import { createPublicShareFileViewerSource } from "../components/publicShareFileViewerSource";
import { Banner } from "../components/ui/Banner";
import {
  type PublicShareContextValue,
  PublicShareProvider,
} from "../contexts/PublicShareContext";
import { useI18n } from "../i18n";

function parsePositiveInteger(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function PublicShareFilePage() {
  const { t } = useI18n();
  const { secret } = useParams<{ secret: string }>();
  const [searchParams] = useSearchParams();
  const filePath = searchParams.get("path") ?? "";
  const projectId = searchParams.get("projectId");
  const relayUsername = searchParams.get("h") ?? "";
  const standaloneFile = searchParams.get("standalone") === "1";
  const viewerId = searchParams.get("viewerId") ?? undefined;
  const lineNumber = parsePositiveInteger(searchParams.get("line"));
  const lineEnd = parsePositiveInteger(searchParams.get("lineEnd"));
  const viewMode =
    searchParams.get("view") === "range" ? ("range" as const) : "full";

  const relayConfig = useMemo((): { error: string | null; url: string } => {
    try {
      return {
        error: null,
        url: normalizeRelayUrl(searchParams.get("r") ?? DEFAULT_RELAY_URL),
      };
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : String(err),
        url: DEFAULT_RELAY_URL,
      };
    }
  }, [searchParams]);

  const publicShareContext = useMemo<PublicShareContextValue | null>(() => {
    if (!secret || !relayUsername) {
      return null;
    }
    return {
      projectId,
      relayUrl: relayConfig.url,
      relayUsername,
      secret,
      standaloneFile,
      viewerId,
    };
  }, [
    projectId,
    relayConfig.url,
    relayUsername,
    secret,
    standaloneFile,
    viewerId,
  ]);

  const shareHref = useMemo(() => {
    if (!secret) {
      return "/share";
    }
    const params = new URLSearchParams();
    if (relayUsername) params.set("h", relayUsername);
    if (relayConfig.url) params.set("r", relayConfig.url);
    if (projectId) params.set("projectId", projectId);
    if (viewerId) params.set("viewerId", viewerId);
    const query = params.toString();
    return `/share/${encodeURIComponent(secret)}${query ? `?${query}` : ""}`;
  }, [projectId, relayConfig.url, relayUsername, secret, viewerId]);

  const source = useMemo<FileViewerSource | null>(() => {
    if (!publicShareContext || !filePath || relayConfig.error) {
      return null;
    }
    return createPublicShareFileViewerSource(publicShareContext);
  }, [filePath, publicShareContext, relayConfig.error]);

  const content = (
    <div className={filePageStyles.root}>
      {!standaloneFile && (
        <div className={filePageStyles.nav}>
          <Link to={shareHref} className={filePageStyles.backLink}>
            <span>{t("publicShareBackToShare" as never)}</span>
          </Link>
        </div>
      )}
      <div className={filePageStyles.content}>
        {source ? (
          <FileViewer
            projectId={projectId ?? ""}
            filePath={filePath}
            lineEnd={lineEnd}
            lineNumber={lineNumber}
            source={source}
            standalone
            viewMode={viewMode}
          />
        ) : (
          <div className={viewerStyles.fileViewer} data-file-viewer>
            <Banner tone="error">
              {relayConfig.error || t("fileInvalidUrl" as never)}
            </Banner>
          </div>
        )}
      </div>
    </div>
  );

  return publicShareContext ? (
    <PublicShareProvider value={publicShareContext}>
      {content}
    </PublicShareProvider>
  ) : (
    content
  );
}
