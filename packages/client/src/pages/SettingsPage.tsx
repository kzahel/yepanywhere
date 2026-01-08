import { useEffect, useState } from "react";
import { PageHeader } from "../components/PageHeader";
import { PushNotificationToggle } from "../components/PushNotificationToggle";
import { useAuth } from "../contexts/AuthContext";
import { useSchemaValidationContext } from "../contexts/SchemaValidationContext";
import {
  FONT_SIZES,
  getFontSizeLabel,
  useFontSize,
} from "../hooks/useFontSize";
import { useFunPhrases } from "../hooks/useFunPhrases";
import {
  MODEL_OPTIONS,
  THINKING_LEVEL_OPTIONS,
  useModelSettings,
} from "../hooks/useModelSettings";
import { useProviders } from "../hooks/useProviders";
import { usePwaInstall } from "../hooks/usePwaInstall";
import { useReloadNotifications } from "../hooks/useReloadNotifications";
import { useSchemaValidation } from "../hooks/useSchemaValidation";
import { useStreamingEnabled } from "../hooks/useStreamingEnabled";
import { THEMES, getThemeLabel, useTheme } from "../hooks/useTheme";
import { useNavigationLayout } from "../layouts";
import { getAllProviders } from "../providers/registry";

export function SettingsPage() {
  const {
    isManualReloadMode,
    pendingReloads,
    connected,
    reloadBackend,
    reloadFrontend,
    unsafeToRestart,
    workerActivity,
  } = useReloadNotifications();
  const { fontSize, setFontSize } = useFontSize();
  const { theme, setTheme } = useTheme();
  const { streamingEnabled, setStreamingEnabled } = useStreamingEnabled();
  const { funPhrasesEnabled, setFunPhrasesEnabled } = useFunPhrases();
  const {
    model,
    setModel,
    thinkingLevel,
    setThinkingLevel,
    thinkingEnabled,
    setThinkingEnabled,
  } = useModelSettings();
  const { canInstall, isInstalled, install } = usePwaInstall();
  const { settings: validationSettings, setEnabled: setValidationEnabled } =
    useSchemaValidation();
  const { ignoredTools, clearIgnoredTools } = useSchemaValidationContext();
  const { isAuthenticated, authDisabled, logout, changePassword } = useAuth();
  const { providers: serverProviders, loading: providersLoading } =
    useProviders();

  // Merge server detection status with client-side metadata
  const registeredProviders = getAllProviders();
  const providerDisplayList = registeredProviders.map((clientProvider) => {
    const serverInfo = serverProviders.find(
      (p) => p.name === clientProvider.id,
    );
    return {
      ...clientProvider,
      installed: serverInfo?.installed ?? false,
      authenticated: serverInfo?.authenticated ?? false,
    };
  });
  const [restarting, setRestarting] = useState(false);
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordSuccess, setPasswordSuccess] = useState(false);
  const [isChangingPassword, setIsChangingPassword] = useState(false);

  const { openSidebar, isWideScreen } = useNavigationLayout();

  // When SSE reconnects after restart, re-enable the button
  useEffect(() => {
    if (restarting && connected) {
      setRestarting(false);
    }
  }, [restarting, connected]);

  const handleRestartServer = async () => {
    setRestarting(true);
    await reloadBackend();
  };

  const handleReloadFrontend = () => {
    reloadFrontend();
  };

  return (
    <div
      className={isWideScreen ? "main-content-wrapper" : "main-content-mobile"}
    >
      <div
        className={
          isWideScreen
            ? "main-content-constrained"
            : "main-content-mobile-inner"
        }
      >
        <PageHeader title="Settings" onOpenSidebar={openSidebar} />

        <main className="page-scroll-container">
          <div className="page-content-inner">
            {/* Only show App section if install is possible or already installed */}
            {(canInstall || isInstalled) && (
              <section className="settings-section">
                <h2>App</h2>
                <div className="settings-group">
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
                </div>
              </section>
            )}

            <section className="settings-section">
              <h2>Appearance</h2>
              <div className="settings-group">
                <div className="settings-item">
                  <div className="settings-item-info">
                    <strong>Theme</strong>
                    <p>Choose your preferred color scheme.</p>
                  </div>
                  <div className="font-size-selector">
                    {THEMES.map((t) => (
                      <button
                        key={t}
                        type="button"
                        className={`font-size-option ${theme === t ? "active" : ""}`}
                        onClick={() => setTheme(t)}
                      >
                        {getThemeLabel(t)}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="settings-item">
                  <div className="settings-item-info">
                    <strong>Font Size</strong>
                    <p>Adjust the text size throughout the application.</p>
                  </div>
                  <div className="font-size-selector">
                    {FONT_SIZES.map((size) => (
                      <button
                        key={size}
                        type="button"
                        className={`font-size-option ${fontSize === size ? "active" : ""}`}
                        onClick={() => setFontSize(size)}
                      >
                        {getFontSizeLabel(size)}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="settings-item">
                  <div className="settings-item-info">
                    <strong>Response Streaming</strong>
                    <p>
                      Show responses as they are generated, token by token.
                      Disable for better performance on slower devices.
                    </p>
                  </div>
                  <label className="toggle-switch">
                    <input
                      type="checkbox"
                      checked={streamingEnabled}
                      onChange={(e) => setStreamingEnabled(e.target.checked)}
                    />
                    <span className="toggle-slider" />
                  </label>
                </div>
                <div className="settings-item">
                  <div className="settings-item-info">
                    <strong>Fun Phrases</strong>
                    <p>
                      Show playful status messages while waiting for responses.
                      Disable to show only "Thinking..."
                    </p>
                  </div>
                  <label className="toggle-switch">
                    <input
                      type="checkbox"
                      checked={funPhrasesEnabled}
                      onChange={(e) => setFunPhrasesEnabled(e.target.checked)}
                    />
                    <span className="toggle-slider" />
                  </label>
                </div>
              </div>
            </section>

            <section className="settings-section">
              <h2>Model</h2>
              <div className="settings-group">
                <div className="settings-item">
                  <div className="settings-item-info">
                    <strong>Model</strong>
                    <p>Select which Claude model to use for new sessions.</p>
                  </div>
                  <div className="font-size-selector">
                    {MODEL_OPTIONS.map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        className={`font-size-option ${model === opt.value ? "active" : ""}`}
                        onClick={() => setModel(opt.value)}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="settings-item">
                  <div className="settings-item-info">
                    <strong>Extended Thinking</strong>
                    <p>
                      Allow the model to "think" before responding. Toggle on to
                      enable deeper reasoning.
                    </p>
                  </div>
                  <label className="toggle-switch">
                    <input
                      type="checkbox"
                      checked={thinkingEnabled}
                      onChange={(e) => setThinkingEnabled(e.target.checked)}
                    />
                    <span className="toggle-slider" />
                  </label>
                </div>
                <div className="settings-item">
                  <div className="settings-item-info">
                    <strong>Thinking Level</strong>
                    <p>
                      Token budget for thinking. Higher levels enable deeper
                      reasoning but use more tokens.
                    </p>
                  </div>
                  <div className="font-size-selector">
                    {THINKING_LEVEL_OPTIONS.map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        className={`font-size-option ${thinkingLevel === opt.value ? "active" : ""}`}
                        onClick={() => setThinkingLevel(opt.value)}
                        title={opt.description}
                      >
                        {opt.label} ({opt.description})
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </section>

            <section className="settings-section">
              <h2>Providers</h2>
              <p className="settings-section-description">
                AI providers are auto-detected when their CLI is installed.
              </p>
              <div className="settings-group">
                {providerDisplayList.map((provider) => (
                  <div key={provider.id} className="settings-item">
                    <div className="settings-item-info">
                      <div className="settings-item-header">
                        <strong>{provider.displayName}</strong>
                        {provider.installed ? (
                          <span className="settings-status-badge settings-status-detected">
                            Detected
                          </span>
                        ) : (
                          <span className="settings-status-badge settings-status-not-detected">
                            Not Detected
                          </span>
                        )}
                      </div>
                      <p>{provider.metadata.description}</p>
                      {provider.metadata.limitations.length > 0 && (
                        <ul className="settings-limitations">
                          {provider.metadata.limitations.map((limitation) => (
                            <li key={limitation}>{limitation}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                    {provider.metadata.website && (
                      <a
                        href={provider.metadata.website}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="settings-link"
                      >
                        Website
                      </a>
                    )}
                  </div>
                ))}
              </div>
            </section>

            <section className="settings-section">
              <h2>Notifications</h2>
              <div className="settings-group">
                <PushNotificationToggle />
              </div>
            </section>

            {!authDisabled && isAuthenticated && (
              <section className="settings-section">
                <h2>Security</h2>
                <div className="settings-group">
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
                            await changePassword(currentPassword, newPassword);
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
                          <label htmlFor="current-password">
                            Current Password
                          </label>
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
                          {isChangingPassword
                            ? "Changing..."
                            : "Update Password"}
                        </button>
                      </form>
                    </div>
                  )}

                  <div className="settings-item">
                    <div className="settings-item-info">
                      <strong>Logout</strong>
                      <p>Sign out of your account on this device.</p>
                    </div>
                    <button
                      type="button"
                      className="settings-button settings-button-danger"
                      onClick={logout}
                    >
                      Logout
                    </button>
                  </div>
                </div>
              </section>
            )}

            <section className="settings-section">
              <h2>Development</h2>

              <div className="settings-group">
                <div className="settings-item">
                  <div className="settings-item-info">
                    <strong>Schema Validation</strong>
                    <p>
                      Validate tool results against expected schemas. Shows
                      toast notifications and logs errors to console.
                    </p>
                  </div>
                  <label className="toggle-switch">
                    <input
                      type="checkbox"
                      checked={validationSettings.enabled}
                      onChange={(e) => setValidationEnabled(e.target.checked)}
                    />
                    <span className="toggle-slider" />
                  </label>
                </div>
                {ignoredTools.length > 0 && (
                  <div className="settings-item">
                    <div className="settings-item-info">
                      <strong>Ignored Tools</strong>
                      <p>
                        Tools with validation errors you chose to ignore. They
                        will not show toast notifications.
                      </p>
                      <div className="ignored-tools-list">
                        {ignoredTools.map((tool) => (
                          <span key={tool} className="ignored-tool-badge">
                            {tool}
                          </span>
                        ))}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="settings-button settings-button-secondary"
                      onClick={clearIgnoredTools}
                    >
                      Clear Ignored
                    </button>
                  </div>
                )}
              </div>

              {isManualReloadMode ? (
                <div className="settings-group">
                  <div className="settings-item">
                    <div className="settings-item-info">
                      <strong>Restart Server</strong>
                      <p>
                        Restart the backend server to pick up code changes.
                        {pendingReloads.backend && (
                          <span className="settings-pending">
                            {" "}
                            (changes pending)
                          </span>
                        )}
                      </p>
                      {unsafeToRestart && (
                        <p className="settings-warning">
                          {workerActivity.activeWorkers} active session
                          {workerActivity.activeWorkers !== 1 ? "s" : ""} will
                          be interrupted
                        </p>
                      )}
                    </div>
                    <button
                      type="button"
                      className={`settings-button ${unsafeToRestart ? "settings-button-danger" : ""}`}
                      onClick={handleRestartServer}
                      disabled={restarting}
                    >
                      {restarting
                        ? "Restarting..."
                        : unsafeToRestart
                          ? "Restart Anyway"
                          : "Restart Server"}
                    </button>
                  </div>

                  <div className="settings-item">
                    <div className="settings-item-info">
                      <strong>Reload Frontend</strong>
                      <p>
                        Refresh the browser to pick up frontend changes.
                        {pendingReloads.frontend && (
                          <span className="settings-pending">
                            {" "}
                            (changes pending)
                          </span>
                        )}
                      </p>
                    </div>
                    <button
                      type="button"
                      className="settings-button"
                      onClick={handleReloadFrontend}
                    >
                      Reload Frontend
                    </button>
                  </div>
                </div>
              ) : (
                <p className="settings-info">
                  Manual reload mode is not enabled. The server automatically
                  restarts when code changes.
                </p>
              )}
            </section>
          </div>
        </main>
      </div>
    </div>
  );
}
