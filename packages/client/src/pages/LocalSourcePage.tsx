import type { LocalSourceRoot } from "@yep-anywhere/shared";
import { useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { PageHeader } from "../components/PageHeader";
import { Banner } from "../components/ui/Banner";
import { GlossaryProjectBoundary } from "../contexts/GlossaryContext";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { useI18n } from "../i18n";
import { MainContent, useNavigationLayout } from "../layouts";
import { getPathBasename } from "../lib/text";
import { BlameBrowser } from "./BlameBrowser";

/**
 * LocalSourcePage - Source Control's current-files browser for a path outside
 * the project, opened in a new tab from a path link's menu.
 * Route: /projects/:projectId/browse?path=<absolute path>
 *
 * The project only authorizes the reads; the browsed directory is not a
 * project, so the view is a one-shot snapshot with no live updates, review
 * comments, or blame.
 */
export function LocalSourcePage() {
  const { t } = useI18n();
  const { isWideScreen } = useNavigationLayout();
  const { projectId } = useParams<{ projectId: string }>();
  const [searchParams] = useSearchParams();
  const requestedPath = searchParams.get("path");
  const [root, setRoot] = useState<LocalSourceRoot | null>(null);
  const title = root?.path ?? requestedPath ?? t("gitStatusTitle");
  useDocumentTitle(getPathBasename(title), undefined, t("gitStatusTitle"));

  return (
    <MainContent isWideScreen={isWideScreen}>
      <PageHeader title={title} />
      <main className="page-scroll-container">
        <div className="page-content-inner">
          {!projectId || !requestedPath ? (
            <Banner tone="error">{t("fileInvalidUrl" as never)}</Banner>
          ) : (
            <GlossaryProjectBoundary projectId={projectId}>
              <div className="git-status">
                <BlameBrowser
                  key={requestedPath}
                  projectId={projectId}
                  isWideScreen={isWideScreen}
                  localSourcePath={requestedPath}
                  onLocalSourceRoot={setRoot}
                  t={t}
                />
              </div>
            </GlossaryProjectBoundary>
          )}
        </div>
      </main>
    </MainContent>
  );
}
