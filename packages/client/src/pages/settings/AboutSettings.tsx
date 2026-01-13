import { usePwaInstall } from "../../hooks/usePwaInstall";
import { useVersion } from "../../hooks/useVersion";

export function AboutSettings() {
  const { canInstall, isInstalled, install } = usePwaInstall();
  const { version: versionInfo } = useVersion();

  return (
    <section className="settings-section">
      <h2>About</h2>
      <div className="settings-group">
        {/* Only show Install option if install is possible or already installed */}
        {(canInstall || isInstalled) && (
          <div className="settings-item">
            <div className="settings-item-info">
              <strong>Install App</strong>
              <p>
                {isInstalled
                  ? "Yep Anywhere is installed on your device."
                  : "Add Yep Anywhere to your home screen for quick access."}
              </p>
            </div>
            {isInstalled ? (
              <span className="settings-status-badge">Installed</span>
            ) : (
              <button
                type="button"
                className="settings-button"
                onClick={install}
              >
                Install
              </button>
            )}
          </div>
        )}
        <div className="settings-item">
          <div className="settings-item-info">
            <strong>Version</strong>
            <p>
              {versionInfo ? (
                <>
                  v{versionInfo.current}
                  {versionInfo.updateAvailable && versionInfo.latest ? (
                    <span className="settings-update-available">
                      {" "}
                      (v{versionInfo.latest} available)
                    </span>
                  ) : versionInfo.latest ? (
                    <span className="settings-up-to-date"> (up to date)</span>
                  ) : null}
                </>
              ) : (
                "Loading..."
              )}
            </p>
            {versionInfo?.updateAvailable && (
              <p className="settings-update-hint">
                Run <code>npm i -g yepanywhere</code> to update
              </p>
            )}
          </div>
        </div>
        <div className="settings-item">
          <div className="settings-item-info">
            <strong>Report a Bug</strong>
            <p>
              Found an issue? Report it on GitHub to help improve Yep Anywhere.
            </p>
          </div>
          <a
            href="https://github.com/kzahel/yepanywhere/issues"
            target="_blank"
            rel="noopener noreferrer"
            className="settings-button"
          >
            Report Bug
          </a>
        </div>
      </div>
    </section>
  );
}
