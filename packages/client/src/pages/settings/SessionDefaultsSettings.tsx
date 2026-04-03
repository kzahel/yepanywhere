import type { PermissionMode } from "@yep-anywhere/shared";
import { useToastContext } from "../../contexts/ToastContext";
import { useServerSettings } from "../../hooks/useServerSettings";
import { useI18n } from "../../i18n";

const MODE_ORDER: PermissionMode[] = [
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
];

export function SessionDefaultsSettings() {
  const { t } = useI18n();
  const { settings, isLoading, updateSetting } = useServerSettings();
  const { showToast } = useToastContext();

  const currentMode = settings?.newSessionDefaults?.permissionMode ?? "default";

  const modeLabels: Record<PermissionMode, string> = {
    default: t("modeDefaultLabel"),
    acceptEdits: t("modeAcceptEditsLabel"),
    plan: t("modePlanLabel"),
    bypassPermissions: t("modeBypassPermissionsLabel"),
  };
  const modeDescriptions: Record<PermissionMode, string> = {
    default: t("modeDefaultDescription"),
    acceptEdits: t("modeAcceptEditsDescription"),
    plan: t("modePlanDescription"),
    bypassPermissions: t("modeBypassPermissionsDescription"),
  };

  const handleModeChange = async (mode: PermissionMode) => {
    try {
      await updateSetting("newSessionDefaults", {
        ...settings?.newSessionDefaults,
        permissionMode: mode,
      });
      showToast(t("sessionDefaultsSaved"), "success");
    } catch {
      showToast(t("sessionDefaultsSaveError"), "error");
    }
  };

  if (isLoading) {
    return (
      <section className="settings-section">
        <h2>{t("sessionDefaultsTitle")}</h2>
        <p>{t("loading")}</p>
      </section>
    );
  }

  return (
    <section className="settings-section">
      <h2>{t("sessionDefaultsTitle")}</h2>
      <div className="settings-group">
        <div className="settings-item">
          <div className="settings-item-info">
            <strong>{t("sessionDefaultsPermissionTitle")}</strong>
            <p>{t("sessionDefaultsPermissionDescription")}</p>
          </div>
          <div className="mode-options">
            {MODE_ORDER.map((m) => (
              <button
                key={m}
                type="button"
                className={`mode-option ${currentMode === m ? "selected" : ""}`}
                onClick={() => handleModeChange(m)}
              >
                <span className={`mode-option-dot mode-${m}`} />
                <div className="mode-option-content">
                  <span className="mode-option-label">{modeLabels[m]}</span>
                  <span className="mode-option-desc">
                    {modeDescriptions[m]}
                  </span>
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
