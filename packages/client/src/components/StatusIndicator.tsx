import type { ProcessState } from "../hooks/useSession";
import type { SessionStatus } from "../types";

interface Props {
  status: SessionStatus;
  connected: boolean;
  processState?: ProcessState;
}

export function StatusIndicator({
  status,
  connected,
  processState = "idle",
}: Props) {
  // Hide when session is idle (no active subprocess from UX perspective)
  if (status.state === "idle") {
    return null;
  }

  // Determine status text for tooltip/accessibility
  const getStatusText = () => {
    if (!connected && status.state === "owned") return "Reconnecting...";
    if (status.state === "external") return "External process";
    if (processState === "running") return "Processing";
    if (processState === "waiting-input") return "Waiting for input";
    return "Ready";
  };

  const statusText = getStatusText();

  return (
    <div
      className="status-indicator"
      title={statusText}
      aria-label={statusText}
    >
      <span
        className={`status-dot status-${status.state} process-${processState}${!connected ? " disconnected" : ""}`}
        role="status"
      />
    </div>
  );
}
