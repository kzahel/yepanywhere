import type { SessionStatus } from "../types";

interface Props {
  status: SessionStatus;
  connected: boolean;
}

export function StatusIndicator({ status, connected }: Props) {
  return (
    <div className="status-indicator">
      <span className={`status-dot status-${status.state}`} />
      <span className="status-text">
        {status.state === "idle" && "Idle"}
        {status.state === "owned" && "Running"}
        {status.state === "external" && "External process"}
      </span>
      {!connected && status.state === "owned" && (
        <span className="status-disconnected">Reconnecting...</span>
      )}
    </div>
  );
}
