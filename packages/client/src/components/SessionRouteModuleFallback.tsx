import pageStyles from "../layouts/PageLayout.module.css";
import { useI18n } from "../i18n";

/**
 * The status shown while the session page's lazily loaded transcript or
 * composer module loads. Moved verbatim from `SessionPage.tsx`
 * (docs/tactical/182-session-page-header-and-footer.md slice 5).
 */
export function SessionRouteModuleFallback({
  label,
}: {
  label: "loading" | "sessionLoading";
}) {
  const { t } = useI18n();
  return (
    <div className={pageStyles.loading} data-loading role="status">
      {t(label)}
    </div>
  );
}
