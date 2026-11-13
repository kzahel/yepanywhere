import styles from "./SettingsPane.module.css";
import { type ReactNode, Suspense } from "react";
import { ErrorBoundary } from "../../components/ErrorBoundary";
import { useI18n } from "../../i18n";

const SKELETON_ROWS = 4;

/** Placeholder rows for an open pane whose code chunk is still loading. */
function SettingsPaneSkeleton() {
  const { t } = useI18n();
  return (
    <div
      className={styles.skeleton}
      role="status"
      aria-label={t("loading")}
      data-settings-pane-skeleton
    >
      {Array.from({ length: SKELETON_ROWS }, (_, index) => (
        <div key={index} className={styles.row} aria-hidden="true">
          <div className={styles.lines}>
            <div className={`${styles.bar} ${styles.title}`} />
            <div className={`${styles.bar} ${styles.description}`} />
          </div>
          <div className={styles.control} />
        </div>
      ))}
    </div>
  );
}

/**
 * Keep pane acquisition and failure inside the Settings navigation shell.
 * An open pane shows placeholder rows while it loads; a labelled pane in
 * search results, one of many, shows a single status line instead.
 */
export function SettingsPane({
  children,
  label,
}: {
  children: ReactNode;
  label?: string;
}) {
  const { t } = useI18n();
  return (
    <div data-settings-pane>
      <ErrorBoundary>
        <Suspense
          fallback={
            label ? (
              <p role="status">
                {label}: {t("loading")}
              </p>
            ) : (
              <SettingsPaneSkeleton />
            )
          }
        >
          <div data-settings-pane-ready>{children}</div>
        </Suspense>
      </ErrorBoundary>
    </div>
  );
}
