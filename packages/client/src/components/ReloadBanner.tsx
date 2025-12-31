interface Props {
  target: "backend" | "frontend";
  onReload: () => void;
  onDismiss: () => void;
  unsafeToRestart?: boolean;
  activeWorkers?: number;
}

export function ReloadBanner({
  target,
  onReload,
  onDismiss,
  unsafeToRestart,
  activeWorkers,
}: Props) {
  const label = target === "backend" ? "Server" : "Frontend";
  const showWarning = unsafeToRestart && target === "backend";

  return (
    <div
      className={`reload-banner ${showWarning ? "reload-banner-warning" : ""}`}
    >
      <span className="reload-banner-message">
        {label} code changed - reload to see changes
      </span>
      {showWarning && (
        <span className="reload-banner-warning-text">
          {activeWorkers} active session{activeWorkers !== 1 ? "s" : ""} will be
          interrupted
        </span>
      )}
      <button
        type="button"
        className={`reload-banner-button reload-banner-button-primary ${
          showWarning ? "reload-banner-button-danger" : ""
        }`}
        onClick={onReload}
      >
        {showWarning ? "Reload Anyway" : `Reload ${label}`}
      </button>
      <button
        type="button"
        className="reload-banner-button"
        onClick={onDismiss}
      >
        Dismiss
      </button>
      <span className="reload-banner-shortcut">Ctrl+Shift+R</span>
    </div>
  );
}
