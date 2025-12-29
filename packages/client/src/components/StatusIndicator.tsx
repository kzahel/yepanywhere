import type { SessionStatus } from "../types";

interface Props {
  status: SessionStatus;
  connected: boolean;
  onAbort: () => void;
}

export function StatusIndicator({ status, connected, onAbort }: Props) {
  return (
    <div className="status-indicator">
      <span className={`status-dot status-${status.state}`} />
      <span className="status-text">
        {status.state === "idle" && "Idle"}
        {status.state === "owned" && "Running"}
        {status.state === "external" && "External process"}
      </span>
      {!connected && status.state !== "idle" && (
        <span className="status-disconnected">Reconnecting...</span>
      )}
      {status.state === "owned" && (
        <button type="button" onClick={onAbort} className="abort-button">
          Stop
        </button>
      )}
    </div>
  );
}
