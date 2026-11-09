import { useEffect, useState } from "react";
import { canServerUpdateCodex } from "../api/codexUpdateStatus";
import { useCanAdministerHost } from "../hooks/useActingPrincipal";
import { useCodexUpdateStatus } from "../hooks/useCodexUpdateStatus";
import { useProviders } from "../hooks/useProviders";
import { useServerSettings } from "../hooks/useServerSettings";
import { useI18n } from "../i18n";
import styles from "./CodexUpdatePrompt.module.css";
import {
  CodexDetectedInstall,
  codexManualUpdateHint,
} from "./CodexUpdateGuidance";
import { Button } from "./ui/Button";
import { Checkbox } from "./ui/Checkbox";
import { Modal } from "./ui/Modal";

/**
 * Interrupts only for a known incompatibility: the installed Codex CLI is
 * older than the server's declared minimum. Ordinary newer releases are
 * reported passively in Settings → Providers. Dismissal is stored on the
 * server per minimum version, so it holds on every device.
 */
export function CodexUpdatePrompt() {
  const { t } = useI18n();
  const { settings, updateSetting } = useServerSettings();
  // A limited user can neither install an update nor change the policy.
  const canAdministerHost = useCanAdministerHost();
  const policy = canAdministerHost ? settings?.codexUpdatePolicy : undefined;
  const { status, isInstalling, error, installOutput, install } =
    useCodexUpdateStatus({ enabled: policy === "notify" || policy === "auto" });
  const { refetch: refetchProviders } = useProviders();
  const [activeMinimum, setActiveMinimum] = useState<string | null>(null);
  const [closedMinimum, setClosedMinimum] = useState<string | null>(null);
  const [autoUpdate, setAutoUpdate] = useState(false);
  const [installAttempted, setInstallAttempted] = useState(false);
  const [installSucceeded, setInstallSucceeded] = useState<boolean | null>(
    null,
  );
  const [policyError, setPolicyError] = useState<string | null>(null);

  const requiredMinimum =
    status?.belowMinimum === true ? (status.minimumSupported ?? null) : null;
  const shouldPrompt =
    (policy === "notify" || policy === "auto") &&
    !!requiredMinimum &&
    requiredMinimum !== settings?.codexRequiredUpdateDismissed &&
    requiredMinimum !== closedMinimum;

  useEffect(() => {
    if (
      !shouldPrompt ||
      !requiredMinimum ||
      activeMinimum === requiredMinimum
    ) {
      return;
    }
    setActiveMinimum(requiredMinimum);
    setAutoUpdate(false);
    setInstallAttempted(false);
    setInstallSucceeded(null);
    setPolicyError(null);
  }, [activeMinimum, requiredMinimum, shouldPrompt]);

  useEffect(() => {
    if (policy !== "notify" && policy !== "auto" && activeMinimum) {
      setActiveMinimum(null);
    }
  }, [activeMinimum, policy]);

  if (!activeMinimum || !status) {
    return null;
  }

  const canInstall = canServerUpdateCodex(status);
  const manualHint = codexManualUpdateHint(status);

  const close = () => {
    setClosedMinimum(activeMinimum);
    // A failed attempt stays unresolved, so it may prompt again next load.
    if (installSucceeded === null) {
      void updateSetting("codexRequiredUpdateDismissed", activeMinimum).catch(
        () => {
          // Still dismissed for this page; the next load may ask again.
        },
      );
    }
    setActiveMinimum(null);
  };

  const handleModalClose = () => {
    if (!isInstalling) close();
  };

  const handleUpdate = async () => {
    setInstallAttempted(false);
    setInstallSucceeded(null);
    setPolicyError(null);

    if (autoUpdate) {
      try {
        await updateSetting("codexUpdatePolicy", "auto");
      } catch {
        setPolicyError(
          "The auto-update preference could not be saved; future releases may still need manual confirmation.",
        );
      }
    }
    const ok = await install();
    if (ok) {
      await refetchProviders();
    }
    setInstallAttempted(true);
    setInstallSucceeded(ok);
  };

  const installCommand =
    status.manualInstallCommand ??
    (status.installedPackage
      ? `npm install -g ${status.installedPackage}@latest`
      : null);
  const rawOutput =
    installOutput?.trim() ||
    (isInstalling
      ? "Running the Codex CLI update. Raw output will appear here when the command finishes."
      : installAttempted
        ? "(The update command did not produce stdout or stderr.)"
        : null);

  return (
    <Modal title={t("codexUpdateRequiredTitle")} onClose={handleModalClose}>
      <div className={`settings-group ${styles.root}`}>
        <p className={styles.summary}>
          {installSucceeded
            ? t("codexUpdateInstalledSummary", {
                version: status.installed ?? activeMinimum,
              })
            : t("codexUpdateBelowMinimum", {
                installed: status.installed ?? "unknown",
                minimum: activeMinimum,
              })}
        </p>

        <CodexDetectedInstall status={status} />

        {status.releaseUrl && (
          <a
            href={status.releaseUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={`settings-link ${styles.releaseLink}`}
          >
            {t("providersCodexUpdateReleaseNotes")}
          </a>
        )}

        {installCommand && (
          <div className={styles.commandBlock}>
            <span className="settings-hint">
              {canInstall
                ? t("codexUpdateWillRunCommand")
                : t("providersCodexUpdateWithInstaller")}
            </span>
            <code className={styles.command}>{installCommand}</code>
          </div>
        )}

        {manualHint && <p className="settings-hint">{t(manualHint)}</p>}

        {canInstall && (
          <Checkbox
            label={t("codexUpdateAutoFutureVersions")}
            checked={autoUpdate}
            onCheckedChange={setAutoUpdate}
            disabled={isInstalling || installSucceeded === true}
          />
        )}

        {isInstalling && (
          <p className={`settings-hint ${styles.progress}`}>
            {t("codexUpdateProgress")}
          </p>
        )}

        {installAttempted && installSucceeded === true && (
          <p className="form-success">{t("codexUpdateSucceeded")}</p>
        )}

        {installAttempted && installSucceeded === false && error && (
          <p className="settings-warning">{error}</p>
        )}

        {policyError && <p className="settings-warning">{policyError}</p>}

        {(isInstalling || installAttempted) && rawOutput && (
          <div className={styles.outputBlock}>
            <div className={styles.outputHeader}>
              <strong className={styles.outputTitle}>
                {t("codexUpdateRawOutput")}
              </strong>
              {installCommand && (
                <code className={styles.outputCommand}>{installCommand}</code>
              )}
            </div>
            <pre className={styles.output}>{rawOutput}</pre>
          </div>
        )}

        {installSucceeded === null && !isInstalling && (
          <p className="settings-hint">{t("codexUpdateDismissHint")}</p>
        )}

        <div className={styles.actions}>
          {installSucceeded === true ? (
            <Button onClick={close}>{t("codexUpdateDone")}</Button>
          ) : (
            <>
              <Button onClick={close} disabled={isInstalling}>
                {t("codexUpdateDismiss")}
              </Button>
              {canInstall && (
                <Button
                  variant="primary"
                  onClick={() => void handleUpdate()}
                  disabled={isInstalling}
                >
                  {isInstalling
                    ? t("providersCodexUpdateInstalling")
                    : installAttempted
                      ? t("codexUpdateRetry")
                      : t("providersCodexUpdateNow")}
                </Button>
              )}
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
