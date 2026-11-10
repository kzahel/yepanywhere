import styles from "./StatusIndicator.module.css";
import type { ProcessState } from "../hooks/useSession";
import { useI18n } from "../i18n";
import type { SessionStatus } from "../types";

interface Props {
  status: SessionStatus;
  connected: boolean;
  processState?: ProcessState;
}

function getStatusClass(status: SessionStatus): "idle" | "owned" | "external" {
  if (status.owner === "self") return "owned";
  if (status.owner === "external") return "external";
  return "idle";
}

function getProcessClass(processState: ProcessState): string {
  return processState === "in-turn" ? "running" : processState;
}

export function StatusIndicator({
  status,
  connected,
  processState = "idle",
}: Props) {
  const { t } = useI18n();
  // Hide when session has no owner (no active subprocess from UX perspective)
  if (status.owner === "none") {
    return null;
  }

  // Hide in-turn state - now shown in ProviderBadge's thinking indicator
  if (processState === "in-turn" && connected && status.owner === "self") {
    return null;
  }

  // Determine status text for tooltip/accessibility
  const getStatusText = () => {
    if (!connected && status.owner === "self")
      return t("statusReconnecting" as never);
    if (status.owner === "external") return t("statusExternalProcess" as never);
    if (processState === "in-turn") return t("statusProcessing" as never);
    if (processState === "waiting-input")
      return t("statusWaitingForInput" as never);
    return t("statusReady" as never);
  };

  const statusText = getStatusText();

  return (
    <div
      className={styles["status-indicator"]}
      data-status-indicator
      title={statusText}
      role="status"
      aria-label={statusText}
    >
      <span
        className={[
          styles["status-dot"],
          {
            idle: styles["status-idle"],
            owned: styles["status-owned"],
            external: styles["status-external"],
          }[getStatusClass(status)],
          processState === "in-turn"
            ? styles["process-running"]
            : processState === "waiting-input"
              ? styles["process-waiting-input"]
              : "",
          !connected ? styles.disconnected : "",
        ].join(" ")}
        data-status-dot
        data-status-owner={getStatusClass(status)}
        data-process-state={getProcessClass(processState)}
        data-disconnected={!connected || undefined}
      />
    </div>
  );
}
