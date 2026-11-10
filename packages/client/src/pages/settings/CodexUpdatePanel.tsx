import rowsStyles from "./SettingsRows.module.css";
import { useCallback } from "react";
import { canServerUpdateCodex } from "../../api/codexUpdateStatus";
import {
  CodexDetectedInstall,
  codexManualUpdateHint,
} from "../../components/CodexUpdateGuidance";
import { Banner } from "../../components/ui/Banner";
import { Button } from "../../components/ui/Button";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { useToastContext } from "../../contexts/ToastContext";
import { useCodexUpdateStatus } from "../../hooks/useCodexUpdateStatus";
import { useServerSettings } from "../../hooks/useServerSettings";
import { useI18n } from "../../i18n";
import styles from "./CodexUpdatePanel.module.css";

/**
 * The passive Codex update surface: which executable the server uses, whether
 * a newer release exists, and how to update it. Newer releases never open a
 * dialog; only a known incompatibility does (see CodexUpdatePrompt).
 */
export function CodexUpdatePanel() {
  const { t } = useI18n();
  const { showToast } = useToastContext();
  const { settings, updateSetting } = useServerSettings();
  const {
    status,
    isChecking,
    isInstalling,
    error,
    installOutput,
    refresh,
    install,
  } = useCodexUpdateStatus();

  const policy = settings?.codexUpdatePolicy ?? "notify";
  const canInstall = status ? canServerUpdateCodex(status) : false;

  const copy = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
        showToast(t("providersCodexUpdateCommandCopied"), "success");
      } catch {
        showToast(t("providersCodexUpdateCopyFailed"), "error");
      }
    },
    [showToast, t],
  );

  if (!status?.installed || !status.latest) {
    return null;
  }

  const updateAvailable = status.updateAvailable;
  const manualHint = codexManualUpdateHint(status);

  return (
    <div className={styles.panel}>
      <div className={styles.row}>
        {updateAvailable ? (
          <span>
            <strong>{t("providersCodexUpdateAvailable")}</strong>{" "}
            {status.installed} → {status.latest}
          </span>
        ) : (
          <span className={rowsStyles.hint}>
            {t("providersCodexUpdateUpToDate", {
              version: status.installed,
            })}
          </span>
        )}
        <Button onClick={() => void refresh(true)} disabled={isChecking}>
          {isChecking
            ? t("providersCodexUpdateChecking")
            : t("providersCodexUpdateCheckNow")}
        </Button>
        {status.releaseUrl && updateAvailable && (
          <a
            href={status.releaseUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={rowsStyles.link}
          >
            {t("providersCodexUpdateReleaseNotes")}
          </a>
        )}
        <div className={styles.policy}>
          <span className={rowsStyles.hint}>
            {t("providersCodexUpdatePolicyTitle")}
          </span>
          <SegmentedControl
            size="small"
            activation="manual"
            aria-label={t("providersCodexUpdatePolicyTitle")}
            value={policy}
            onChange={(value) => void updateSetting("codexUpdatePolicy", value)}
            options={[
              {
                value: "auto",
                label: t("commonAuto"),
                disabled: !canInstall,
                tooltip: canInstall
                  ? undefined
                  : t("providersCodexUpdatePolicyAutoNeedsUpdater"),
              },
              { value: "notify", label: t("providersCodexUpdatePolicyNotify") },
              { value: "off", label: t("commonOff") },
            ]}
          />
        </div>
      </div>

      <CodexDetectedInstall
        status={status}
        className={`${rowsStyles.hint} ${styles.detected}`}
      />

      {status.belowMinimum && status.minimumSupported && (
        <Banner tone="warning" compact className={styles.message}>
          {t("codexUpdateBelowMinimum", {
            installed: status.installed,
            minimum: status.minimumSupported,
          })}
        </Banner>
      )}

      {updateAvailable && (
        <div className={`${styles.row} ${styles.actionRow}`}>
          {canInstall ? (
            <Button onClick={() => void install()} disabled={isInstalling}>
              {isInstalling
                ? t("providersCodexUpdateInstalling")
                : t("providersCodexUpdateNow")}
            </Button>
          ) : status.manualInstallCommand ? (
            <span className={rowsStyles.hint}>
              {t("providersCodexUpdateWithInstaller")}
            </span>
          ) : null}
          {status.manualInstallCommand && (
            <>
              <code className={styles.command}>
                {status.manualInstallCommand}
              </code>
              <Button
                variant="ghost"
                size="small"
                onClick={() => void copy(status.manualInstallCommand ?? "")}
              >
                {t("remoteSetupCopy")}
              </Button>
            </>
          )}
          {manualHint && (
            <span className={rowsStyles.hint}>{t(manualHint)}</span>
          )}
        </div>
      )}

      {error && (
        <Banner tone="error" compact className={styles.message}>
          {error}
        </Banner>
      )}
      {installOutput && (
        <details className={styles.output}>
          <summary className={rowsStyles.hint}>
            {t("providersCodexUpdateInstallOutput")}
          </summary>
          <pre className={styles.outputText}>{installOutput}</pre>
        </details>
      )}
    </div>
  );
}
