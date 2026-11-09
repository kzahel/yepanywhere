import { useVersion } from "../hooks/useVersion";
import { useI18n } from "../i18n";
import styles from "./ProviderHostDegradedBanner.module.css";
import { Banner } from "./ui/Banner";

export function shouldShowProviderHostDegradedBanner(
  version: { providerHostDegraded?: boolean } | null | undefined,
): boolean {
  return version?.providerHostDegraded === true;
}

export function ProviderHostDegradedBanner() {
  const { t } = useI18n();
  const { version } = useVersion();
  if (!shouldShowProviderHostDegradedBanner(version)) return null;

  return (
    <Banner
      tone="error"
      className={styles.root}
      title={t("providerHostDegradedTitle")}
      data-provider-host-degraded="true"
    >
      <p className={styles.body}>{t("providerHostDegradedDescription")}</p>
    </Banner>
  );
}
