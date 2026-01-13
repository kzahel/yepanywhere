import { useState } from "react";
import { useOptionalAuth } from "../../contexts/AuthContext";
import { useOptionalRemoteConnection } from "../../contexts/RemoteConnectionContext";
import { useDeveloperMode } from "../../hooks/useDeveloperMode";
import { useServerInfo } from "../../hooks/useServerInfo";

export function LocalAccessSettings() {
  const auth = useOptionalAuth();
  const remoteConnection = useOptionalRemoteConnection();
  const { relayDebugEnabled, setRelayDebugEnabled } = useDeveloperMode();
  const { serverInfo, loading: serverInfoLoading } = useServerInfo();

  // Change password state
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordSuccess, setPasswordSuccess] = useState(false);
  const [isChangingPassword, setIsChangingPassword] = useState(false);

  // Enable auth state
  const [showEnableAuth, setShowEnableAuth] = useState(false);
  const [enableAuthPassword, setEnableAuthPassword] = useState("");
  const [enableAuthConfirm, setEnableAuthConfirm] = useState("");
  const [enableAuthError, setEnableAuthError] = useState<string | null>(null);
  const [isEnablingAuth, setIsEnablingAuth] = useState(false);

  // Disable auth state
  const [showDisableConfirm, setShowDisableConfirm] = useState(false);
  const [isDisablingAuth, setIsDisablingAuth] = useState(false);

  // Non-remote mode (cookie-based auth)
  if (auth) {
    return (
      <section className="settings-section">
        <h2>Local Access</h2>
        <p className="settings-section-description">
          Control how this server is accessed on your local network.
        </p>

        {/* Server binding info */}
        <div className="settings-group">
          <div className="settings-item">
            <div className="settings-item-info">
              <strong>Server Binding</strong>
              {serverInfoLoading ? (
                <p>Loading...</p>
              ) : serverInfo ? (
                <>
                  <p>
                    Listening on{" "}
                    <code>
                      {serverInfo.host}:{serverInfo.port}
                    </code>
                    {serverInfo.localhostOnly && (
                      <span className="settings-hint">
                        {" "}
                        (localhost only - not accessible from other devices)
                      </span>
                    )}
                    {serverInfo.boundToAllInterfaces && (
                      <span className="settings-hint">
                        {" "}
                        (all interfaces - accessible from other devices on your
                        network)
                      </span>
                    )}
                  </p>
                  <p className="form-hint">
                    Change at startup:{" "}
                    <code>yepanywhere --host 0.0.0.0 --port 3400</code>
                  </p>
                </>
              ) : (
                <p>Unable to fetch server info</p>
              )}
            </div>
            {serverInfo?.localhostOnly && (
              <span className="settings-status-badge settings-status-detected">
                Local Only
              </span>
            )}
            {serverInfo?.boundToAllInterfaces && (
              <span className="settings-status-badge settings-status-warning">
                Network Exposed
              </span>
            )}
          </div>
        </div>

        {/* Warning when network-exposed without auth */}
        {serverInfo &&
          !serverInfo.localhostOnly &&
          !auth.authEnabled &&
          !auth.authDisabledByEnv && (
            <div className="settings-warning-box">
              <strong>No authentication enabled</strong>
              <p>
                Your server is accessible from other devices on your network
                without any authentication. Anyone on your network can access
                your sessions.
              </p>
              <p>
                Enable authentication below, or use{" "}
                <a href="/settings/remote">Remote Access</a> for secure
                encrypted access from anywhere.
              </p>
            </div>
          )}

        {auth.authDisabledByEnv && (
          <p className="settings-section-description settings-warning">
            Authentication is currently bypassed by --auth-disable flag. Remove
            the flag to enforce authentication.
          </p>
        )}
        <div className="settings-group">
          {/* Enable Auth - shown when auth is not enabled */}
          {!auth.authEnabled && !auth.authDisabledByEnv && (
            <>
              <div className="settings-item">
                <div className="settings-item-info">
                  <strong>Enable Authentication</strong>
                  <p>
                    Require a password to access this server. Recommended when
                    exposing to the network.
                  </p>
                </div>
                {!showEnableAuth ? (
                  <button
                    type="button"
                    className="settings-button"
                    onClick={() => setShowEnableAuth(true)}
                  >
                    Setup
                  </button>
                ) : (
                  <button
                    type="button"
                    className="settings-button settings-button-secondary"
                    onClick={() => {
                      setShowEnableAuth(false);
                      setEnableAuthPassword("");
                      setEnableAuthConfirm("");
                      setEnableAuthError(null);
                    }}
                  >
                    Cancel
                  </button>
                )}
              </div>

              {showEnableAuth && (
                <div className="settings-item settings-item-form">
                  <form
                    onSubmit={async (e) => {
                      e.preventDefault();
                      setEnableAuthError(null);

                      if (enableAuthPassword !== enableAuthConfirm) {
                        setEnableAuthError("Passwords do not match");
                        return;
                      }

                      if (enableAuthPassword.length < 8) {
                        setEnableAuthError(
                          "Password must be at least 8 characters",
                        );
                        return;
                      }

                      setIsEnablingAuth(true);
                      try {
                        await auth.enableAuth(enableAuthPassword);
                        setShowEnableAuth(false);
                        setEnableAuthPassword("");
                        setEnableAuthConfirm("");
                      } catch (err) {
                        setEnableAuthError(
                          err instanceof Error
                            ? err.message
                            : "Failed to enable auth",
                        );
                      } finally {
                        setIsEnablingAuth(false);
                      }
                    }}
                  >
                    <div className="form-field">
                      <label htmlFor="enable-auth-password">Password</label>
                      <input
                        id="enable-auth-password"
                        type="password"
                        value={enableAuthPassword}
                        onChange={(e) => setEnableAuthPassword(e.target.value)}
                        autoComplete="new-password"
                        minLength={8}
                        required
                      />
                    </div>
                    <div className="form-field">
                      <label htmlFor="enable-auth-confirm">
                        Confirm Password
                      </label>
                      <input
                        id="enable-auth-confirm"
                        type="password"
                        value={enableAuthConfirm}
                        onChange={(e) => setEnableAuthConfirm(e.target.value)}
                        autoComplete="new-password"
                        minLength={8}
                        required
                      />
                    </div>
                    {enableAuthError && (
                      <p className="form-error">{enableAuthError}</p>
                    )}
                    <p className="form-hint">
                      If you forget your password, restart with{" "}
                      <code>--auth-disable</code> to bypass auth.
                    </p>
                    {serverInfo && !serverInfo.localhostOnly && (
                      <p className="form-warning">
                        Your server is network-exposed. The password will be
                        sent in cleartext unless you're using HTTPS or
                        Tailscale.
                      </p>
                    )}
                    <button
                      type="submit"
                      className="settings-button"
                      disabled={isEnablingAuth}
                    >
                      {isEnablingAuth ? "Enabling..." : "Enable Authentication"}
                    </button>
                  </form>
                </div>
              )}
            </>
          )}

          {/* Auth enabled - show change password, disable, logout */}
          {auth.authEnabled && auth.isAuthenticated && (
            <>
              <div className="settings-item">
                <div className="settings-item-info">
                  <strong>Change Password</strong>
                  <p>Update your account password.</p>
                </div>
                {!showChangePassword ? (
                  <button
                    type="button"
                    className="settings-button"
                    onClick={() => setShowChangePassword(true)}
                  >
                    Change Password
                  </button>
                ) : (
                  <button
                    type="button"
                    className="settings-button settings-button-secondary"
                    onClick={() => {
                      setShowChangePassword(false);
                      setCurrentPassword("");
                      setNewPassword("");
                      setConfirmPassword("");
                      setPasswordError(null);
                      setPasswordSuccess(false);
                    }}
                  >
                    Cancel
                  </button>
                )}
              </div>

              {showChangePassword && (
                <div className="settings-item settings-item-form">
                  <form
                    onSubmit={async (e) => {
                      e.preventDefault();
                      setPasswordError(null);
                      setPasswordSuccess(false);

                      if (newPassword !== confirmPassword) {
                        setPasswordError("Passwords do not match");
                        return;
                      }

                      if (newPassword.length < 8) {
                        setPasswordError(
                          "Password must be at least 8 characters",
                        );
                        return;
                      }

                      setIsChangingPassword(true);
                      try {
                        await auth.changePassword(currentPassword, newPassword);
                        setPasswordSuccess(true);
                        setCurrentPassword("");
                        setNewPassword("");
                        setConfirmPassword("");
                        setTimeout(() => {
                          setShowChangePassword(false);
                          setPasswordSuccess(false);
                        }, 2000);
                      } catch (err) {
                        setPasswordError(
                          err instanceof Error
                            ? err.message
                            : "Failed to change password",
                        );
                      } finally {
                        setIsChangingPassword(false);
                      }
                    }}
                  >
                    <div className="form-field">
                      <label htmlFor="current-password">Current Password</label>
                      <input
                        id="current-password"
                        type="password"
                        value={currentPassword}
                        onChange={(e) => setCurrentPassword(e.target.value)}
                        autoComplete="current-password"
                        required
                      />
                    </div>
                    <div className="form-field">
                      <label htmlFor="new-password">New Password</label>
                      <input
                        id="new-password"
                        type="password"
                        value={newPassword}
                        onChange={(e) => setNewPassword(e.target.value)}
                        autoComplete="new-password"
                        minLength={8}
                        required
                      />
                    </div>
                    <div className="form-field">
                      <label htmlFor="confirm-password">
                        Confirm New Password
                      </label>
                      <input
                        id="confirm-password"
                        type="password"
                        value={confirmPassword}
                        onChange={(e) => setConfirmPassword(e.target.value)}
                        autoComplete="new-password"
                        minLength={8}
                        required
                      />
                    </div>
                    {passwordError && (
                      <p className="form-error">{passwordError}</p>
                    )}
                    {passwordSuccess && (
                      <p className="form-success">Password changed!</p>
                    )}
                    <button
                      type="submit"
                      className="settings-button"
                      disabled={isChangingPassword}
                    >
                      {isChangingPassword ? "Changing..." : "Update Password"}
                    </button>
                  </form>
                </div>
              )}

              <div className="settings-item">
                <div className="settings-item-info">
                  <strong>Disable Authentication</strong>
                  <p>Remove password protection from this server.</p>
                </div>
                {!showDisableConfirm ? (
                  <button
                    type="button"
                    className="settings-button settings-button-danger"
                    onClick={() => setShowDisableConfirm(true)}
                  >
                    Disable Auth
                  </button>
                ) : (
                  <div className="settings-confirm-buttons">
                    <button
                      type="button"
                      className="settings-button settings-button-danger"
                      onClick={async () => {
                        setIsDisablingAuth(true);
                        try {
                          await auth.disableAuth();
                          setShowDisableConfirm(false);
                        } finally {
                          setIsDisablingAuth(false);
                        }
                      }}
                      disabled={isDisablingAuth}
                    >
                      {isDisablingAuth ? "Disabling..." : "Confirm Disable"}
                    </button>
                    <button
                      type="button"
                      className="settings-button settings-button-secondary"
                      onClick={() => setShowDisableConfirm(false)}
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </div>

              <div className="settings-item">
                <div className="settings-item-info">
                  <strong>Logout</strong>
                  <p>Sign out of your account on this device.</p>
                </div>
                <button
                  type="button"
                  className="settings-button settings-button-danger"
                  onClick={auth.logout}
                >
                  Logout
                </button>
              </div>
            </>
          )}
        </div>
      </section>
    );
  }

  // Remote mode (SRP auth)
  if (remoteConnection) {
    return (
      <section className="settings-section">
        <h2>Local Access</h2>
        <p className="settings-section-description">
          You are connected to a remote server via relay.
        </p>
        <div className="settings-group">
          <div className="settings-item">
            <div className="settings-item-info">
              <strong>Logout</strong>
              <p>Disconnect from the remote server.</p>
            </div>
            <button
              type="button"
              className="settings-button settings-button-danger"
              onClick={remoteConnection.disconnect}
            >
              Logout
            </button>
          </div>
          <div className="settings-item">
            <div className="settings-item-info">
              <strong>Relay Debug Logging</strong>
              <p>
                Log relay requests and responses to the browser console. Useful
                for debugging connection timeouts.
              </p>
            </div>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={relayDebugEnabled}
                onChange={(e) => setRelayDebugEnabled(e.target.checked)}
              />
              <span className="toggle-slider" />
            </label>
          </div>
        </div>
      </section>
    );
  }

  // No auth context available
  return null;
}
