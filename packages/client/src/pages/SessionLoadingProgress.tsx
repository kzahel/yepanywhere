import { useI18n } from "../i18n";
import pageStyles from "../layouts/PageLayout.module.css";
import type { SessionLoadProgress } from "../hooks/useSessionMessages";

export function SessionPageInvalidRoute() {
  const { t } = useI18n();
  return (
    <div className={pageStyles.error} data-error>
      {t("sessionInvalidUrl")}
    </div>
  );
}

export function getSessionLoadingProgressText(
  progress: SessionLoadProgress,
  t: ReturnType<typeof useI18n>["t"],
): string | null {
  switch (progress.stage) {
    case "fetching":
      return null;
    case "rendering":
      return t("sessionLoadingRenderingTranscript", {
        count: progress.messageCount ?? 0,
      });
    case "idle":
    case "complete":
    case "error":
      return null;
  }
}
