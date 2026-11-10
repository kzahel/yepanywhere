import styles from "./LoginLayout.module.css";
import { SelectableCard } from "../components/ui/SelectableCard";
/**
 * RemoteLoginModePage - Mode selection for remote client login.
 *
 * Landing page that lets users choose between:
 * - Relay connection (for NAT traversal via public relay server)
 * - Direct connection (for LAN, Tailscale, or direct WS URL)
 */

import { useNavigate } from "react-router-dom";
import { Spinner } from "../components/ui/Spinner";
import { YepAnywhereLogo } from "../components/YepAnywhereLogo";
import { useRemoteConnection } from "../contexts/RemoteConnectionContext";
import { useI18n } from "../i18n";

export function RemoteLoginModePage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { isAutoResuming } = useRemoteConnection();

  // If auto-resume is in progress, show a loading screen
  if (isAutoResuming) {
    return (
      <div className={styles.page}>
        <div className={styles.container}>
          <div className={styles.logo}>
            <YepAnywhereLogo variant="login" />
          </div>
          <p className={styles.subtitle}>Reconnecting...</p>
          <div className={styles.loading} data-testid="auto-resume-loading">
            <Spinner size="large" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.container}>
        <div className={styles.logo}>
          <YepAnywhereLogo variant="login" />
        </div>
        <p className={styles.subtitle}>{t("hostPickerHowToConnect")}</p>

        <div className={styles.modeOptions}>
          <SelectableCard
            className={styles.modeOption}
            onClick={() => navigate("/relay")}
            data-testid="relay-mode-button"
          >
            <span className={styles.modeOptionTitle}>
              {t("hostPickerRelayTitle")}
            </span>
            <span className={styles.modeOptionDesc}>
              {t("hostPickerRelayDescription")}
            </span>
          </SelectableCard>

          <SelectableCard
            className={styles.modeOption}
            variant="quiet"
            onClick={() => navigate("/direct")}
            data-testid="direct-mode-button"
          >
            <span className={styles.modeOptionTitle}>
              {t("hostPickerDirectTitle")}
            </span>
            <span className={styles.modeOptionDesc}>
              {t("hostPickerDirectDescription")}
            </span>
          </SelectableCard>
        </div>

        <p className={styles.hint}>{t("hostPickerEmptyHint")}</p>
      </div>
    </div>
  );
}
