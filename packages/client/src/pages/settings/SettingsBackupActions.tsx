import {
  BROWSER_SETTINGS_BACKUP_VERSION,
  type BrowserSettingsBackup,
} from "@yep-anywhere/shared";
import { useEffect, useState } from "react";
import { api } from "../../api/client";
import { Banner } from "../../components/ui/Banner";
import { Button } from "../../components/ui/Button";
import { confirmDialog } from "../../components/ui/ConfirmDialog";
import { useI18n } from "../../i18n";
import {
  applyBrowserSettingsBackup,
  captureBrowserSettings,
} from "../../lib/browserSettingsBackup";
import styles from "./SettingsTransfer.module.css";

type Operation = "fetching" | "saving" | "loading" | null;

function formatSavedAt(savedAt: string): string {
  const date = new Date(savedAt);
  return Number.isNaN(date.getTime()) ? savedAt : date.toLocaleString();
}

export function SettingsBackupActions() {
  const { t } = useI18n();
  const [backup, setBackup] = useState<BrowserSettingsBackup | null>(null);
  const [operation, setOperation] = useState<Operation>("fetching");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api
      .getBrowserSettingsBackup()
      .then((response) => {
        if (!cancelled) setBackup(response.backup);
      })
      .catch(() => {
        if (!cancelled) setError(t("settingsBackupUnavailable"));
      })
      .finally(() => {
        if (!cancelled) setOperation(null);
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  const handleSave = async () => {
    setOperation("saving");
    setError(null);
    try {
      const response = await api.saveBrowserSettingsBackup({
        version: BROWSER_SETTINGS_BACKUP_VERSION,
        values: captureBrowserSettings(),
      });
      setBackup(response.backup);
    } catch {
      setError(t("settingsBackupSaveFailed"));
    } finally {
      setOperation(null);
    }
  };

  const handleLoad = async () => {
    if (
      !backup ||
      !(await confirmDialog({
        title: t("settingsBackupLoadConfirmTitle"),
        message: t("settingsBackupLoadConfirm"),
        confirmLabel: t("settingsBackupLoad"),
      }))
    )
      return;
    setOperation("loading");
    setError(null);
    try {
      applyBrowserSettingsBackup(backup);
      window.location.reload();
    } catch {
      setError(t("settingsBackupLoadFailed"));
      setOperation(null);
    }
  };

  const status = error
    ? null
    : operation === "fetching"
      ? t("settingsBackupChecking")
      : backup
        ? t("settingsBackupSavedAt", { time: formatSavedAt(backup.savedAt) })
        : t("settingsBackupEmpty");

  return (
    <section className={styles.section} aria-label={t("settingsBackupTitle")}>
      <span className={styles.title}>{t("settingsBackupTitle")}</span>
      <span className={styles.status}>{t("settingsBackupDescription")}</span>
      <div className={styles.buttons}>
        <Button
          onClick={() => void handleSave()}
          disabled={operation !== null}
          title={t("settingsBackupSaveTooltip")}
        >
          {operation === "saving"
            ? t("settingsBackupSaving")
            : t("settingsBackupSave")}
        </Button>
        <Button
          onClick={handleLoad}
          disabled={operation !== null || !backup}
          title={t("settingsBackupLoadTooltip")}
        >
          {operation === "loading"
            ? t("settingsBackupLoading")
            : t("settingsBackupLoad")}
        </Button>
      </div>
      {/* Always mounted, so a result after a failed try is announced. */}
      <span className={styles.status} role="status">
        {status}
      </span>
      {error && (
        <Banner tone="error" compact>
          {error}
        </Banner>
      )}
    </section>
  );
}
