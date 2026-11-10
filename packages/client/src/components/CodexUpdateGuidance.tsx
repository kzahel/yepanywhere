import rowsStyles from "../pages/settings/SettingsRows.module.css";
import type {
  CodexInstallSource,
  CodexUpdateStatus,
} from "../api/codexUpdateStatus";
import { type MessageKey, useI18n } from "../i18n";

const INSTALL_SOURCE_LABELS: Record<CodexInstallSource, MessageKey> = {
  npm: "codexInstallSourceNpm",
  standalone: "codexInstallSourceStandalone",
  homebrew: "codexInstallSourceHomebrew",
  cargo: "codexInstallSourceCargo",
  "desktop-app": "codexInstallSourceDesktopApp",
  unknown: "codexInstallSourceUnknown",
};

/** Names the executable the server uses and what installed it. */
export function CodexDetectedInstall({
  status,
  className = rowsStyles.hint,
}: {
  status: CodexUpdateStatus;
  className?: string;
}) {
  const { t } = useI18n();
  if (!status.installedPath || !status.installSource) return null;
  return (
    <p className={className}>
      {t("codexUpdateDetectedInstall", {
        path: status.installedPath,
        source: t(INSTALL_SOURCE_LABELS[status.installSource]),
      })}
    </p>
  );
}

/**
 * Explains how to update an installation the server cannot update itself
 * when there is no command to show: an app bundle updates with its app, and
 * an unrecognized install updates with whatever installed it.
 */
export function codexManualUpdateHint(
  status: CodexUpdateStatus,
): MessageKey | null {
  if (status.updateMethod !== "manual") return null;
  if (status.installSource === "desktop-app") {
    return "codexUpdateDesktopAppHint";
  }
  return status.manualInstallCommand ? null : "codexUpdateUnknownSourceHint";
}
