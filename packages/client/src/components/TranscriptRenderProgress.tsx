import { useI18n } from "../i18n";
import pageStyles from "../layouts/PageLayout.module.css";

export function TranscriptRenderProgress({
  showDetails,
  percent,
}: {
  showDetails: boolean;
  percent: number;
}) {
  const { t } = useI18n();
  return (
    <div
      className={`session-render-progress ${pageStyles.loading}`}
      data-loading
      role="status"
    >
      <div>{t("sessionLoading")}</div>
      {showDetails && (
        <>
          <div
            className={`${pageStyles.loadingDetail} session-render-progress-label`}
            data-loading-detail
          >
            {t("sessionProgressiveRenderingStatus", {
              percent: percent,
            })}
          </div>
          <div
            className="session-render-progress-bar"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            aria-label={t("sessionProgressiveRenderingAriaLabel")}
          >
            <div
              className="session-render-progress-fill"
              style={{ width: `${percent}%` }}
            />
          </div>
        </>
      )}
    </div>
  );
}
