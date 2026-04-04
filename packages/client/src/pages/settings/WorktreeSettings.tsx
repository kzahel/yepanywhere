import { useCallback, useEffect, useState } from "react";
import { useToastContext } from "../../contexts/ToastContext";
import { useServerSettings } from "../../hooks/useServerSettings";
import { useI18n } from "../../i18n";

export function WorktreeSettings() {
  const { t } = useI18n();
  const { settings, isLoading, updateSettings } = useServerSettings();
  const { showToast } = useToastContext();

  const [copyFiles, setCopyFiles] = useState("");
  const [symlinkDirs, setSymlinkDirs] = useState("");
  const [postCreateCommand, setPostCreateCommand] = useState("");

  // Initialize local state from server settings once loaded
  useEffect(() => {
    if (settings && !isLoading) {
      setCopyFiles((settings.worktreeCopyFiles ?? []).join("\n"));
      setSymlinkDirs((settings.worktreeSymlinkDirectories ?? []).join("\n"));
      setPostCreateCommand(settings.worktreePostCreateCommand ?? "");
    }
  }, [settings, isLoading]);

  const handleToggleEnabled = useCallback(async () => {
    try {
      await updateSettings({ worktreeEnabled: !settings?.worktreeEnabled });
      showToast(t("worktreeSettingsSaved"), "success");
    } catch {
      showToast(t("worktreeSettingsSaveError"), "error");
    }
  }, [settings?.worktreeEnabled, updateSettings, showToast, t]);

  const handleSaveConfig = useCallback(async () => {
    try {
      const copyList = copyFiles
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      const symlinkList = symlinkDirs
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);

      await updateSettings({
        worktreeCopyFiles: copyList.length > 0 ? copyList : undefined,
        worktreeSymlinkDirectories:
          symlinkList.length > 0 ? symlinkList : undefined,
        worktreePostCreateCommand: postCreateCommand.trim() || undefined,
      });
      showToast(t("worktreeSettingsSaved"), "success");
    } catch {
      showToast(t("worktreeSettingsSaveError"), "error");
    }
  }, [copyFiles, symlinkDirs, postCreateCommand, updateSettings, showToast, t]);

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

        {/* Copy files */}
        <div className="settings-item settings-item-column">
          <div className="settings-item-info">
            <strong>{t("worktreeSettingsCopyFiles")}</strong>
            <p>{t("worktreeSettingsCopyFilesDescription")}</p>
          </div>
          <textarea
            className="settings-textarea"
            value={copyFiles}
            onChange={(e) => setCopyFiles(e.target.value)}
            placeholder={t("worktreeSettingsCopyFilesPlaceholder")}
            rows={3}
          />
        </div>

        {/* Symlink directories */}
        <div className="settings-item settings-item-column">
          <div className="settings-item-info">
            <strong>{t("worktreeSettingsSymlinkDirs")}</strong>
            <p>{t("worktreeSettingsSymlinkDirsDescription")}</p>
          </div>
          <textarea
            className="settings-textarea"
            value={symlinkDirs}
            onChange={(e) => setSymlinkDirs(e.target.value)}
            placeholder={t("worktreeSettingsSymlinkDirsPlaceholder")}
            rows={3}
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
