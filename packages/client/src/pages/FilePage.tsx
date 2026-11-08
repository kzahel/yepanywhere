import { Link, useParams, useSearchParams } from "react-router-dom";
import { BackArrowIcon } from "../components/BackArrowIcon";
import { FileViewer } from "../components/FileViewer";
import { SidebarLauncher } from "../components/SidebarLauncher";
import { buttonClassName } from "../components/ui/Button";
import { GlossaryProjectBoundary } from "../contexts/GlossaryContext";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import { useI18n } from "../i18n";
import { useNavigationLayout } from "../layouts";

/**
 * FilePage - Standalone page for viewing files.
 * Route: /projects/:projectId/file?path=<path>
 */
export function FilePage() {
  const { t } = useI18n();
  const { openSidebar } = useNavigationLayout();
  const basePath = useRemoteBasePath();
  const { projectId } = useParams<{ projectId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const filePath = searchParams.get("path");
  const lineNumber = parsePositiveInteger(searchParams.get("line"));
  const lineEnd = parsePositiveInteger(searchParams.get("lineEnd"));
  const diffMode = parseFileDiffMode(searchParams.get("diff"));
  const viewMode =
    searchParams.get("view") === "range" ? ("range" as const) : "full";
  const initialFolder = searchParams.get("folder") ?? undefined;

  if (!projectId) {
    return (
      <div className="file-page file-page-error">
        <div className="file-page-error-content">
          <h1>{t("fileInvalidUrl" as never)}</h1>
          <p>{t("fileMissingProjectId" as never)}</p>
          <Link to={`${basePath}/projects`} className="file-page-back-link">
            {t("fileGoToProjects" as never)}
          </Link>
        </div>
      </div>
    );
  }

  if (!filePath) {
    return (
      <div className="file-page file-page-error">
        <div className="file-page-error-content">
          <h1>{t("fileInvalidUrl" as never)}</h1>
          <p>{t("fileMissingPath" as never)}</p>
          <Link
            to={`${basePath}/projects/${projectId}`}
            className="file-page-back-link"
          >
            {t("fileGoToProject" as never)}
          </Link>
        </div>
      </div>
    );
  }

  return (
    <GlossaryProjectBoundary projectId={projectId}>
      <div className="file-page">
        <div className="file-page-content">
          <FileViewer
            projectId={projectId}
            filePath={filePath}
            lineNumber={lineNumber}
            lineEnd={lineEnd}
            viewMode={viewMode}
            diffMode={diffMode}
            initialFolder={initialFolder}
            standalone
            // A sibling chosen from the path's folder list is a new page
            // visit: Back returns to this file. Line and diff targets belong
            // to the file they were given for.
            onNavigateFile={(path) => setSearchParams({ path })}
            headerLeading={
              <>
                <SidebarLauncher
                  label={t("actionOpenSidebar")}
                  newSessionLabel={t("sidebarNewSession")}
                  onActivate={openSidebar}
                />
                <Link
                  to={`${basePath}/projects/${projectId}`}
                  className={buttonClassName({ variant: "ghost", icon: true })}
                  title={t("fileBackToProject" as never)}
                  aria-label={t("fileBackToProject" as never)}
                >
                  <BackArrowIcon />
                </Link>
              </>
            }
          />
        </div>
      </div>
    </GlossaryProjectBoundary>
  );
}

function parseFileDiffMode(value: string | null) {
  return value === "worktree" || value === "cumulative" ? value : undefined;
}

function parsePositiveInteger(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return undefined;
  }
  return parsed;
}
