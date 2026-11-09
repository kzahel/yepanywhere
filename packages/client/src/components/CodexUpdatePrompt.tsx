import { useEffect, useState } from "react";
import { useCanAdministerHost } from "../hooks/useActingPrincipal";
import { useCodexUpdateStatus } from "../hooks/useCodexUpdateStatus";
import { useProviders } from "../hooks/useProviders";
import { useServerSettings } from "../hooks/useServerSettings";
import { useI18n } from "../i18n";
import { Button } from "./ui/Button";
import { Checkbox } from "./ui/Checkbox";
import { Modal } from "./ui/Modal";

const STORAGE_KEY = "codex-update-seen-tag";

function readSeenTag(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeSeenTag(tag: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, tag);
  } catch {
    // Storage denied / full: prompt will reappear next session.
  }
}

export function CodexUpdatePrompt() {
  const { t } = useI18n();
  const { settings, updateSetting } = useServerSettings();
  // A limited user can neither install an update nor change the policy.
  const canAdministerHost = useCanAdministerHost();
  const policy = canAdministerHost ? settings?.codexUpdatePolicy : undefined;
  const { status, isInstalling, error, installOutput, install } =
    useCodexUpdateStatus({ enabled: policy === "notify" });
  const { refetch: refetchProviders } = useProviders();
  const [seenTag, setSeenTag] = useState<string | null>(() => readSeenTag());
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [dismissedTag, setDismissedTag] = useState<string | null>(null);
  const [autoUpdate, setAutoUpdate] = useState(true);
  const [installAttempted, setInstallAttempted] = useState(false);
  const [installSucceeded, setInstallSucceeded] = useState<boolean | null>(
    null,
  );
  const [policyError, setPolicyError] = useState<string | null>(null);

  useEffect(() => {
    setSeenTag(readSeenTag());
  }, []);

  const latestTag = status?.latest ?? null;
  const shouldPrompt =
    policy === "notify" &&
    !!status &&
    status.updateAvailable &&
    !!latestTag &&
    latestTag !== seenTag &&
    latestTag !== dismissedTag;

  useEffect(() => {
    if (!shouldPrompt || !latestTag || activeTag === latestTag) {
      return;
    }
    setActiveTag(latestTag);
    setAutoUpdate(true);
    setInstallAttempted(false);
    setInstallSucceeded(null);
    setPolicyError(null);
  }, [activeTag, latestTag, shouldPrompt]);

  useEffect(() => {
    if (policy !== "notify" && activeTag) {
      setActiveTag(null);
      setInstallAttempted(false);
      setInstallSucceeded(null);
      setPolicyError(null);
    }
  }, [activeTag, policy]);

  if (!activeTag || !status || !latestTag) {
    return null;
  }

  const canInstall = status.updateMethod === "npm";

  const close = ({ markSeen = false }: { markSeen?: boolean } = {}) => {
    if (markSeen) {
      writeSeenTag(activeTag);
      setSeenTag(activeTag);
    }
    setDismissedTag(activeTag);
    setActiveTag(null);
    setInstallAttempted(false);
    setInstallSucceeded(null);
    setPolicyError(null);
  };

  const handleModalClose = () => {
    if (isInstalling) {
      return;
    }
    close({ markSeen: installSucceeded !== false });
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

  const handleNotNow = () => {
    close({ markSeen: true });
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
    <Modal title="Codex CLI update available" onClose={handleModalClose}>
      <div className="settings-group codex-update-prompt">
        <p className="codex-update-prompt__summary">
          {installSucceeded
            ? t("codexUpdateInstalledSummary", {
                version: status.installed ?? activeTag,
              })
            : t("codexUpdateReadySummary", {
                current: status.installed ?? "unknown",
                latest: latestTag,
              })}
        </p>

        {status.releaseUrl && (
          <a
            href={status.releaseUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="settings-link codex-update-prompt__release-link"
          >
            Release notes
          </a>
        )}

        {installCommand && (
          <div className="codex-update-prompt__command-block">
            <span className="settings-hint">
              {canInstall
                ? t("codexUpdateWillRunCommand")
                : t("providersCodexUpdateWithInstaller")}
            </span>
            <code className="codex-update-prompt__command">
              {installCommand}
            </code>
          </div>
        )}

        {!canInstall && (
          <p className="settings-hint">{t("codexUpdateManualInstallHint")}</p>
        )}

        {canInstall && (
          <Checkbox
            label={t("codexUpdateAutoFutureVersions")}
            checked={autoUpdate}
            onCheckedChange={setAutoUpdate}
            disabled={isInstalling || installSucceeded === true}
          />
        )}

        {isInstalling && (
          <p className="settings-hint codex-update-prompt__progress">
            {t("codexUpdateProgress")}
          </p>
        )}

        {installAttempted && installSucceeded === true && (
          <p className="form-success">
            Codex updated successfully. Review the raw output below, then close
            this dialog.
          </p>
        )}

        {installAttempted && installSucceeded === false && error && (
          <p className="settings-warning">{error}</p>
        )}

        {policyError && <p className="settings-warning">{policyError}</p>}

        {(isInstalling || installAttempted) && rawOutput && (
          <div className="codex-update-prompt__output-block">
            <div className="codex-update-prompt__output-header">
              <strong className="codex-update-prompt__output-title">
                Raw output
              </strong>
              {installCommand && (
                <code className="codex-update-prompt__output-command">
                  {installCommand}
                </code>
              )}
            </div>
            <pre className="codex-update-prompt__output">{rawOutput}</pre>
          </div>
        )}

        <div className="codex-update-prompt__actions">
          {installSucceeded === true || !canInstall ? (
            <Button onClick={() => close({ markSeen: true })}>
              {t("codexUpdateDone")}
            </Button>
          ) : (
            <>
              <Button
                onClick={installAttempted ? () => close() : handleNotNow}
                disabled={isInstalling}
              >
                {installAttempted ? "Dismiss" : "Not now"}
              </Button>
              <Button
                variant="primary"
                onClick={() => void handleUpdate()}
                disabled={isInstalling}
              >
                {isInstalling
                  ? "Installing…"
                  : installAttempted
                    ? "Retry update"
                    : "Update now"}
              </Button>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
