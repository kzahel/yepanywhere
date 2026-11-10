import styles from "./HostIdentityMarker.module.css";
import { useHostIdentity } from "../contexts/HostIdentityContext";
import { useI18n } from "../i18n";

export function HostIdentityMarker() {
  const { icon } = useHostIdentity();
  const { t } = useI18n();
  if (!icon) return null;

  const label = t("hostIdentityMarkerAria", { icon });
  return (
    <span className={styles.root} role="img" aria-label={label} title={label}>
      {icon}
    </span>
  );
}
