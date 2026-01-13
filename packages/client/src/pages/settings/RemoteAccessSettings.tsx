import { useState } from "react";
import { useRemoteAccess } from "../../hooks/useRemoteAccess";

export function RemoteAccessSettings() {
  const {
    config: remoteAccessConfig,
    relayConfig,
    loading: remoteAccessLoading,
    enable: enableRemoteAccess,
    disable: disableRemoteAccess,
    updateRelayConfig,
    clearRelayConfig,
  } = useRemoteAccess();

  // Remote access password setup
  const [showRemoteAccessSetup, setShowRemoteAccessSetup] = useState(false);
  const [remoteAccessPassword, setRemoteAccessPassword] = useState("");
  const [remoteAccessConfirm, setRemoteAccessConfirm] = useState("");
  const [remoteAccessError, setRemoteAccessError] = useState<string | null>(
    null,
  );
  const [isEnablingRemoteAccess, setIsEnablingRemoteAccess] = useState(false);
  const [showRemoteAccessDisable, setShowRemoteAccessDisable] = useState(false);
  const [isDisablingRemoteAccess, setIsDisablingRemoteAccess] = useState(false);

  // Relay settings
  const [showRelaySetup, setShowRelaySetup] = useState(false);
  const [relayUrl, setRelayUrl] = useState("");
  const [relayUsername, setRelayUsername] = useState("");
  const [relayError, setRelayError] = useState<string | null>(null);
  const [isSavingRelay, setIsSavingRelay] = useState(false);
  const [showRelayDisable, setShowRelayDisable] = useState(false);
  const [isDisablingRelay, setIsDisablingRelay] = useState(false);

  return (
    <section className="settings-section">
      <h2>Remote Access</h2>
      <p className="settings-section-description">
        Access your yepanywhere server from anywhere through an encrypted relay
        connection.
      </p>
      <div className="settings-group">
        {remoteAccessLoading ? (
          <div className="settings-item">
            <div className="settings-item-info">
              <strong>Loading...</strong>
            </div>
          </div>
        ) : !relayConfig ? (
          /* Step 1: Configure relay first */
          <>
            <div className="settings-item">
              <div className="settings-item-info">
                <strong>Configure Relay Server</strong>
                <p>
                  Set up a relay server connection first. Your relay username
                  will be used to identify your server and for login.
                </p>
              </div>
              {!showRelaySetup ? (
                <button
                  type="button"
                  className="settings-button"
                  onClick={() => setShowRelaySetup(true)}
                >
                  Configure
                </button>
              ) : (
                <button
                  type="button"
                  className="settings-button settings-button-secondary"
                  onClick={() => {
                    setShowRelaySetup(false);
                    setRelayUrl("");
                    setRelayUsername("");
                    setRelayError(null);
                  }}
                >
                  Cancel
                </button>
              )}
            </div>

            {showRelaySetup && (
              <div className="settings-item settings-item-form">
                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    setRelayError(null);

                    if (!relayUrl.trim()) {
                      setRelayError("Relay URL is required");
                      return;
                    }

                    if (!relayUsername.trim()) {
                      setRelayError("Username is required");
                      return;
                    }

                    if (relayUsername.length < 3) {
                      setRelayError("Username must be at least 3 characters");
                      return;
                    }

                    setIsSavingRelay(true);
                    try {
                      await updateRelayConfig({
                        url: relayUrl,
                        username: relayUsername,
                      });
                      setShowRelaySetup(false);
                      setRelayUrl("");
                      setRelayUsername("");
                    } catch (err) {
                      setRelayError(
                        err instanceof Error
                          ? err.message
                          : "Failed to save relay configuration",
                      );
                    } finally {
                      setIsSavingRelay(false);
                    }
                  }}
                >
                  <div className="form-field">
                    <label htmlFor="relay-url">Relay URL</label>
                    <input
                      id="relay-url"
                      type="text"
                      value={relayUrl}
                      onChange={(e) => setRelayUrl(e.target.value)}
                      placeholder="wss://relay.yepanywhere.com/ws"
                      required
                    />
                  </div>
                  <div className="form-field">
                    <label htmlFor="relay-username">Username</label>
                    <input
                      id="relay-username"
                      type="text"
                      value={relayUsername}
                      onChange={(e) =>
                        setRelayUsername(e.target.value.toLowerCase())
                      }
                      placeholder="my-server"
                      minLength={3}
                      maxLength={32}
                      pattern="[a-z0-9][a-z0-9-]*[a-z0-9]|[a-z0-9]{1,2}"
                      title="Lowercase letters, numbers, and hyphens only"
                      required
                    />
                  </div>
                  {relayError && <p className="form-error">{relayError}</p>}
                  <p className="form-hint">
                    This username identifies your server on the relay and is
                    used for login. Use something memorable like your name or
                    machine name.
                  </p>
                  <button
                    type="submit"
                    className="settings-button"
                    disabled={isSavingRelay}
                  >
                    {isSavingRelay ? "Saving..." : "Save"}
                  </button>
                </form>
              </div>
            )}
          </>
        ) : !remoteAccessConfig?.enabled ? (
          /* Step 2: Set password (relay is configured) */
          <>
            <div className="settings-item">
              <div className="settings-item-info">
                <strong>Relay Server</strong>
                <p>
                  Connected as <code>{relayConfig.username}</code> to{" "}
                  <code>{relayConfig.url}</code>
                </p>
              </div>
              <span className="settings-status-badge settings-status-detected">
                Configured
              </span>
            </div>

            <div className="settings-item">
              <div className="settings-item-info">
                <strong>Set Password</strong>
                <p>
                  Set a password to enable remote access. You'll use your
                  username <code>{relayConfig.username}</code> and this password
                  to log in.
                </p>
              </div>
              {!showRemoteAccessSetup ? (
                <button
                  type="button"
                  className="settings-button"
                  onClick={() => setShowRemoteAccessSetup(true)}
                >
                  Set Password
                </button>
              ) : (
                <button
                  type="button"
                  className="settings-button settings-button-secondary"
                  onClick={() => {
                    setShowRemoteAccessSetup(false);
                    setRemoteAccessPassword("");
                    setRemoteAccessConfirm("");
                    setRemoteAccessError(null);
                  }}
                >
                  Cancel
                </button>
              )}
            </div>

            {showRemoteAccessSetup && (
              <div className="settings-item settings-item-form">
                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    setRemoteAccessError(null);

                    if (remoteAccessPassword !== remoteAccessConfirm) {
                      setRemoteAccessError("Passwords do not match");
                      return;
                    }

                    if (remoteAccessPassword.length < 8) {
                      setRemoteAccessError(
                        "Password must be at least 8 characters",
                      );
                      return;
                    }

                    setIsEnablingRemoteAccess(true);
                    try {
                      await enableRemoteAccess(remoteAccessPassword);
                      setShowRemoteAccessSetup(false);
                      setRemoteAccessPassword("");
                      setRemoteAccessConfirm("");
                    } catch (err) {
                      setRemoteAccessError(
                        err instanceof Error
                          ? err.message
                          : "Failed to enable remote access",
                      );
                    } finally {
                      setIsEnablingRemoteAccess(false);
                    }
                  }}
                >
                  <div className="form-field">
                    <label htmlFor="remote-access-password">Password</label>
                    <input
                      id="remote-access-password"
                      type="password"
                      value={remoteAccessPassword}
                      onChange={(e) => setRemoteAccessPassword(e.target.value)}
                      autoComplete="new-password"
                      minLength={8}
                      required
                    />
                  </div>
                  <div className="form-field">
                    <label htmlFor="remote-access-confirm">
                      Confirm Password
                    </label>
                    <input
                      id="remote-access-confirm"
                      type="password"
                      value={remoteAccessConfirm}
                      onChange={(e) => setRemoteAccessConfirm(e.target.value)}
                      autoComplete="new-password"
                      minLength={8}
                      required
                    />
                  </div>
                  {remoteAccessError && (
                    <p className="form-error">{remoteAccessError}</p>
                  )}
                  <p className="form-hint">
                    Your password is never stored. Only a secure verifier is
                    kept on the server.
                  </p>
                  <button
                    type="submit"
                    className="settings-button"
                    disabled={isEnablingRemoteAccess}
                  >
                    {isEnablingRemoteAccess
                      ? "Enabling..."
                      : "Enable Remote Access"}
                  </button>
                </form>
              </div>
            )}

            <div className="settings-item">
              <div className="settings-item-info">
                <strong>Remove Relay</strong>
                <p>Remove the relay configuration.</p>
              </div>
              {!showRelayDisable ? (
                <button
                  type="button"
                  className="settings-button settings-button-danger"
                  onClick={() => setShowRelayDisable(true)}
                >
                  Remove
                </button>
              ) : (
                <div className="settings-confirm-buttons">
                  <button
                    type="button"
                    className="settings-button settings-button-danger"
                    onClick={async () => {
                      setIsDisablingRelay(true);
                      try {
                        await clearRelayConfig();
                        setShowRelayDisable(false);
                      } finally {
                        setIsDisablingRelay(false);
                      }
                    }}
                    disabled={isDisablingRelay}
                  >
                    {isDisablingRelay ? "Removing..." : "Confirm"}
                  </button>
                  <button
                    type="button"
                    className="settings-button settings-button-secondary"
                    onClick={() => setShowRelayDisable(false)}
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>
          </>
        ) : (
          /* Fully configured - show status */
          <>
            <div className="settings-item">
              <div className="settings-item-info">
                <strong>Status</strong>
                <p>
                  Remote access is enabled. Log in with username{" "}
                  <code>{relayConfig.username}</code>.
                </p>
              </div>
              <span className="settings-status-badge settings-status-detected">
                Enabled
              </span>
            </div>

            <div className="settings-item">
              <div className="settings-item-info">
                <strong>Relay Server</strong>
                <p>
                  Connected to <code>{relayConfig.url}</code>
                </p>
              </div>
              <span className="settings-status-badge settings-status-detected">
                Connected
              </span>
            </div>

            <div className="settings-item">
              <div className="settings-item-info">
                <strong>Disable Remote Access</strong>
                <p>Remove remote access credentials from this server.</p>
              </div>
              {!showRemoteAccessDisable ? (
                <button
                  type="button"
                  className="settings-button settings-button-danger"
                  onClick={() => setShowRemoteAccessDisable(true)}
                >
                  Disable
                </button>
              ) : (
                <div className="settings-confirm-buttons">
                  <button
                    type="button"
                    className="settings-button settings-button-danger"
                    onClick={async () => {
                      setIsDisablingRemoteAccess(true);
                      try {
                        await disableRemoteAccess();
                        setShowRemoteAccessDisable(false);
                      } finally {
                        setIsDisablingRemoteAccess(false);
                      }
                    }}
                    disabled={isDisablingRemoteAccess}
                  >
                    {isDisablingRemoteAccess
                      ? "Disabling..."
                      : "Confirm Disable"}
                  </button>
                  <button
                    type="button"
                    className="settings-button settings-button-secondary"
                    onClick={() => setShowRemoteAccessDisable(false)}
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>

            <div className="settings-item">
              <div className="settings-item-info">
                <strong>Remove Relay</strong>
                <p>
                  Disconnect from the relay server. This will also disable
                  remote access.
                </p>
              </div>
              {!showRelayDisable ? (
                <button
                  type="button"
                  className="settings-button settings-button-danger"
                  onClick={() => setShowRelayDisable(true)}
                >
                  Remove
                </button>
              ) : (
                <div className="settings-confirm-buttons">
                  <button
                    type="button"
                    className="settings-button settings-button-danger"
                    onClick={async () => {
                      setIsDisablingRelay(true);
                      try {
                        await clearRelayConfig();
                        setShowRelayDisable(false);
                      } finally {
                        setIsDisablingRelay(false);
                      }
                    }}
                    disabled={isDisablingRelay}
                  >
                    {isDisablingRelay ? "Removing..." : "Confirm"}
                  </button>
                  <button
                    type="button"
                    className="settings-button settings-button-secondary"
                    onClick={() => setShowRelayDisable(false)}
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
