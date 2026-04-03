import { useCallback, useState } from "react";
import { useToastContext } from "../../contexts/ToastContext";
import { useServerSettings } from "../../hooks/useServerSettings";
import { useI18n } from "../../i18n";

export function WorktreeSettings() {
  const { t } = useI18n();
  const { settings, isLoading, updateSetting } = useServerSettings();
  const { showToast } = useToastContext();

  const [basePath, setBasePath] = useState("");
  const [symlinks, setSymlinks] = useState("");
  const [postCreateCommand, setPostCreateCommand] = useState("");
  const [initialized, setInitialized] = useState(false);

  // Initialize local state from server settings once loaded
  if (!initialized && settings && !isLoading) {
    setBasePath(settings.worktreeBasePath ?? "");
    setSymlinks((settings.worktreeSymlinks ?? []).join("\n"));
    setPostCreateCommand(settings.worktreePostCreateCommand ?? "");
    setInitialized(true);
  }

  const handleToggleEnabled = useCallback(async () => {
    try {
      await updateSetting("worktreeEnabled", !settings?.worktreeEnabled);
      showToast(t("worktreeSettingsSaved"), "success");
    } catch {
      showToast(t("worktreeSettingsSaveError"), "error");
    }
  }, [settings?.worktreeEnabled, updateSetting, showToast, t]);

  const handleSaveConfig = useCallback(async () => {
    try {
      // Parse symlinks (one per line, filter empty)
      const symlinkList = symlinks
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);

      await updateSetting(
        "worktreeBasePath",
        basePath.trim() || undefined,
      );
      await updateSetting(
        "worktreeSymlinks",
        symlinkList.length > 0 ? symlinkList : undefined,
      );
      await updateSetting(
        "worktreePostCreateCommand",
        postCreateCommand.trim() || undefined,
      );
      showToast(t("worktreeSettingsSaved"), "success");
    } catch {
      showToast(t("worktreeSettingsSaveError"), "error");
    }
  }, [basePath, symlinks, postCreateCommand, updateSetting, showToast, t]);

  if (isLoading) {
    return (
      <section className="settings-section">
        <h2>{t("worktreeSettingsTitle")}</h2>
        <p>{t("newSessionLoading")}</p>
      </section>
    );
  }

  const isEnabled = settings?.worktreeEnabled ?? false;

  return (
    <section className="settings-section">
      <h2>{t("worktreeSettingsTitle")}</h2>
      <div className="settings-group">
        {/* Enable/disable toggle */}
        <div className="settings-item">
          <div className="settings-item-info">
            <strong>{t("worktreeSettingsEnabled")}</strong>
            <p>{t("worktreeSettingsEnabledDescription")}</p>
          </div>
          <button
            type="button"
            className={`settings-toggle ${isEnabled ? "active" : ""}`}
            onClick={handleToggleEnabled}
            aria-label={t("worktreeSettingsEnabled")}
          >
            <span className="settings-toggle-track">
              <span className="settings-toggle-thumb" />
            </span>
          </button>
        </div>

        {/* Base path */}
        <div className="settings-item settings-item-column">
          <div className="settings-item-info">
            <strong>{t("worktreeSettingsBasePath")}</strong>
            <p>{t("worktreeSettingsBasePathDescription")}</p>
          </div>
          <input
            type="text"
            className="settings-input"
            value={basePath}
            onChange={(e) => setBasePath(e.target.value)}
            placeholder={t("worktreeSettingsBasePathPlaceholder")}
          />
        </div>

        {/* Symlinks */}
        <div className="settings-item settings-item-column">
          <div className="settings-item-info">
            <strong>{t("worktreeSettingsSymlinks")}</strong>
            <p>{t("worktreeSettingsSymlinksDescription")}</p>
          </div>
          <textarea
            className="settings-textarea"
            value={symlinks}
            onChange={(e) => setSymlinks(e.target.value)}
            placeholder={t("worktreeSettingsSymlinksPlaceholder")}
            rows={4}
          />
        </div>

        {/* Post-create command */}
        <div className="settings-item settings-item-column">
          <div className="settings-item-info">
            <strong>{t("worktreeSettingsPostCreateCommand")}</strong>
            <p>{t("worktreeSettingsPostCreateCommandDescription")}</p>
          </div>
          <input
            type="text"
            className="settings-input"
            value={postCreateCommand}
            onChange={(e) => setPostCreateCommand(e.target.value)}
            placeholder={t("worktreeSettingsPostCreateCommandPlaceholder")}
          />
        </div>

        {/* Save button */}
        <div className="settings-item">
          <button
            type="button"
            className="new-session-defaults-button"
            onClick={handleSaveConfig}
          >
            {t("newSessionDefaultsAction")}
          </button>
        </div>
      </div>
    </section>
  );
}
