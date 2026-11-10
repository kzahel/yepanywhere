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
      <div className="login-page">
        <div className="login-container">
          <div className="login-logo">
            <YepAnywhereLogo />
          </div>
          <p className="login-subtitle">Reconnecting...</p>
          <div className="login-loading" data-testid="auto-resume-loading">
            <Spinner size="large" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="login-page">
      <div className="login-container">
        <div className="login-logo">
          <YepAnywhereLogo />
        </div>
        <p className="login-subtitle">{t("hostPickerHowToConnect")}</p>

        <div className="login-mode-options">
          <SelectableCard
            className="login-mode-option"
            onClick={() => navigate("/relay")}
            data-testid="relay-mode-button"
          >
            <span className="login-mode-option-title">
              {t("hostPickerRelayTitle")}
            </span>
            <span className="login-mode-option-desc">
              {t("hostPickerRelayDescription")}
            </span>
          </SelectableCard>

          <SelectableCard
            className="login-mode-option"
            variant="quiet"
            onClick={() => navigate("/direct")}
            data-testid="direct-mode-button"
          >
            <span className="login-mode-option-title">
              {t("hostPickerDirectTitle")}
            </span>
            <span className="login-mode-option-desc">
              {t("hostPickerDirectDescription")}
            </span>
          </SelectableCard>
        </div>

        <p className="login-hint">{t("hostPickerEmptyHint")}</p>
      </div>
    </div>
  );
}
