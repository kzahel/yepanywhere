import {
  AGENT_SERVER_ACCESS_CAPABILITY,
  SERVER_CAPABILITIES,
  agentApiBootstrapInstructions,
  serverHasCapability,
} from "@yep-anywhere/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  DEFAULT_FILE_ACCESS,
  type FileAccessInfo,
  type FileAccessSettings,
} from "../../api/client";
import { FilterDropdown } from "../../components/FilterDropdown";
import { useOptionalAuth } from "../../contexts/AuthContext";
import { useOptionalRemoteConnection } from "../../contexts/RemoteConnectionContext";
import { useNetworkBinding } from "../../hooks/useNetworkBinding";
import { useServerInfo } from "../../hooks/useServerInfo";
import { useServerSettings } from "../../hooks/useServerSettings";
import { useVersion } from "../../hooks/useVersion";
import { useI18n } from "../../i18n";
import { SettingsItem } from "./SettingsItem";
import { useSettingsPaneTitle } from "./SettingsPaneTitleContext";
import { HideInSettingsSearch } from "./SettingsSearchContext";
import { SettingsSection } from "./SettingsSection";
import { useSettingsUndo } from "./SettingsUndoContext";
import styles from "./LocalAccessSettings.module.css";
import { AppsSettingsLink } from "./AppsSettings";

/** File-access form state — `custom` is edited as newline-separated text. */
interface FileAccessForm {
  projects: boolean;
  uploads: boolean;
  temp: boolean;
  home: boolean;
  customText: string;
}

function settingsToFileAccessForm(fa: FileAccessSettings): FileAccessForm {
  return {
    projects: fa.projects,
    uploads: fa.uploads,
    temp: fa.temp,
    home: fa.home,
    customText: fa.custom.join("\n"),
  };
}

function fileAccessFormToSettings(form: FileAccessForm): FileAccessSettings {
  return {
    projects: form.projects,
    uploads: form.uploads,
    temp: form.temp,
    home: form.home,
    custom: form.customText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  };
}

function fileAccessEquals(
  a: FileAccessSettings,
  b: FileAccessSettings,
): boolean {
  return (
    a.projects === b.projects &&
    a.uploads === b.uploads &&
    a.temp === b.temp &&
    a.home === b.home &&
    a.custom.length === b.custom.length &&
    a.custom.every((value, index) => value === b.custom[index])
  );
}

function cloneFileAccessSettings(
  settings: FileAccessSettings,
): FileAccessSettings {
  return { ...settings, custom: [...settings.custom] };
}

/** Matches the server's `/api/auth/enable` and `/change-password` minimum. */
const LOCAL_PASSWORD_MIN_LENGTH = 6;

type PasswordFeedback =
  | { kind: "short"; length: number }
  | { kind: "mismatch" }
  | { kind: "match" }
  | null;

/** Live feedback while a new password and its confirmation are typed. */
function passwordFeedback(password: string, confirm: string): PasswordFeedback {
  if (!password) return null;
  if (password.length < LOCAL_PASSWORD_MIN_LENGTH) {
    return { kind: "short", length: password.length };
  }
  if (!confirm) return null;
  if (confirm === password) return { kind: "match" };
  // A confirmation still being typed toward the password is not a mismatch yet.
  if (confirm.length < password.length && password.startsWith(confirm)) {
    return null;
  }
  return { kind: "mismatch" };
}

/** A custom line that grants whole-disk read, so the UI can flag it. */
function isWholeDiskPath(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === "/" || /^[A-Za-z]:[\\/]?$/.test(trimmed);
}

export function LocalAccessSettings() {
  const { t } = useI18n();
  useSettingsPaneTitle(t("settingsLocalAccessTitle"));
  const auth = useOptionalAuth();
  const remoteConnection = useOptionalRemoteConnection();
  const { serverInfo, loading: serverInfoLoading } = useServerInfo();
  const { version: versionInfo } = useVersion();
  const {
    binding,
    loading: bindingLoading,
    applying,
    updateBinding,
  } = useNetworkBinding();
  const {
    settings: serverSettings,
    isLoading: settingsLoading,
    error: settingsError,
    updateSettings: updateServerSettings,
    updateSetting: updateServerSetting,
  } = useServerSettings();

  const approvalAuditLogEnabled =
    serverSettings?.approvalAuditLogEnabled ?? false;
  const supportsAgentServerAccess = serverHasCapability(
    versionInfo,
    AGENT_SERVER_ACCESS_CAPABILITY,
  );
  const supportsAgentApi = serverHasCapability(
    versionInfo,
    SERVER_CAPABILITIES.agentApiBootstrap,
  );

  const supportsAgentApiManagement = serverHasCapability(
    versionInfo,
    SERVER_CAPABILITIES.agentApiManagement,
  );
  // Network binding form state
  const [localhostPort, setLocalhostPort] = useState<string>("");
  const [networkEnabled, setNetworkEnabled] = useState(false);
  const [selectedInterface, setSelectedInterface] = useState<string>("");
  const [customIp, setCustomIp] = useState("");

  // Auth form state (merged into same form)
  const [requirePassword, setRequirePassword] = useState(false);
  const [localhostOpenToggle, setLocalhostOpenToggle] = useState(false);
  const [authPassword, setAuthPassword] = useState("");
  const [authPasswordConfirm, setAuthPasswordConfirm] = useState("");

  // Allowed hosts form state
  const [allowAllHostsToggle, setAllowAllHostsToggle] = useState(false);
  const [allowedHostsText, setAllowedHostsText] = useState("");

  // File access form state + read-only server info (env-pin + hint paths)
  const [fileAccess, setFileAccess] = useState<FileAccessForm>(
    settingsToFileAccessForm(DEFAULT_FILE_ACCESS),
  );
  const [fileAccessInfo, setFileAccessInfo] = useState<FileAccessInfo | null>(
    null,
  );
  const [fileAccessError, setFileAccessError] = useState<string | null>(null);
  const [fileAccessSaving, setFileAccessSaving] = useState(false);
  const fileAccessBaselineRef = useRef<FileAccessSettings | null>(null);
  const fileAccessSavedRef = useRef<FileAccessSettings | null>(null);
  const fileAccessSaveChainRef = useRef<Promise<void>>(Promise.resolve());
  const fileAccessSaveSequenceRef = useRef(0);

  // Form state
  const [formError, setFormError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [hasChanges, setHasChanges] = useState(false);
  const [isApplying, setIsApplying] = useState(false);

  // Fetch read-only file-access info (env-pin state + resolved hint paths).
  // Supported by both direct/cookie clients and relayed SecureConnection fetches.
  useEffect(() => {
    if (!auth && !remoteConnection) return;
    let cancelled = false;
    api
      .getFileAccessInfo()
      .then((info) => {
        if (!cancelled) setFileAccessInfo(info);
      })
      .catch(() => {
        /* remote/unsupported — leave defaults */
      });
    return () => {
      cancelled = true;
    };
  }, [auth, remoteConnection]);

  // Initialize form from binding, auth, and settings state when it loads
  const [formInitialized, setFormInitialized] = useState(false);
  useEffect(() => {
    if (!binding || !auth || !serverSettings || formInitialized) {
      return;
    }

    setLocalhostPort(String(binding.localhost.port));
    setNetworkEnabled(binding.network.enabled);
    setSelectedInterface(binding.network.host ?? "");
    setRequirePassword(auth.authEnabled);
    setLocalhostOpenToggle(auth.localhostOpen);
    // Initialize allowed hosts from server settings
    const ah = serverSettings.allowedHosts;
    if (ah === "*") {
      setAllowAllHostsToggle(true);
      setAllowedHostsText("");
    } else {
      setAllowAllHostsToggle(false);
      setAllowedHostsText(ah ?? "");
    }
    const loadedFileAccess = cloneFileAccessSettings(
      serverSettings.fileAccess ?? DEFAULT_FILE_ACCESS,
    );
    fileAccessBaselineRef.current ??= loadedFileAccess;
    fileAccessSavedRef.current = loadedFileAccess;
    setFileAccess(settingsToFileAccessForm(loadedFileAccess));
    setFormInitialized(true);
  }, [auth, binding, formInitialized, serverSettings]);

  // Relay mode has no cookie-auth or network-binding context, but it can still
  // edit file access through the encrypted API connection.
  useEffect(() => {
    if (!remoteConnection || auth || !serverSettings || formInitialized) {
      return;
    }

    const loadedFileAccess = cloneFileAccessSettings(
      serverSettings.fileAccess ?? DEFAULT_FILE_ACCESS,
    );
    fileAccessBaselineRef.current ??= loadedFileAccess;
    fileAccessSavedRef.current = loadedFileAccess;
    setFileAccess(settingsToFileAccessForm(loadedFileAccess));
    setFormInitialized(true);
  }, [auth, formInitialized, remoteConnection, serverSettings]);

  useEffect(() => {
    if (!serverSettings) return;
    fileAccessSavedRef.current = cloneFileAccessSettings(
      serverSettings.fileAccess ?? DEFAULT_FILE_ACCESS,
    );
  }, [serverSettings]);

  // Compute the effective allowedHosts value for comparison/saving
  const getAllowedHostsValue = (
    toggle: boolean,
    text: string,
  ): string | undefined => {
    if (toggle) return "*";
    const trimmed = text.trim();
    return trimmed || undefined;
  };

  // Track changes - includes auth and allowed hosts changes
  const checkForChanges = (
    newPort: string,
    newNetworkEnabled: boolean,
    newInterface: string,
    newRequirePassword: boolean,
    newPassword: string,
    newAllowAllHosts: boolean,
    newAllowedHostsText: string,
    newLocalhostOpen: boolean,
    authEnabledNow: boolean,
  ) => {
    if (!serverSettings) return false;

    if (!binding || !auth) return false;

    const portChanged = newPort !== String(binding.localhost.port);
    const networkEnabledChanged = newNetworkEnabled !== binding.network.enabled;
    const interfaceChanged = newInterface !== (binding.network.host ?? "");
    const authChanged = newRequirePassword !== authEnabledNow;
    const passwordEntered = newPassword.length > 0;
    const localhostOpenChanged = newLocalhostOpen !== auth.localhostOpen;
    const newValue = getAllowedHostsValue(
      newAllowAllHosts,
      newAllowedHostsText,
    );
    const oldValue = serverSettings.allowedHosts;
    const allowedHostsChanged = (newValue ?? "") !== (oldValue ?? "");
    return (
      portChanged ||
      networkEnabledChanged ||
      interfaceChanged ||
      authChanged ||
      passwordEntered ||
      localhostOpenChanged ||
      allowedHostsChanged
    );
  };

  // Helper for onChange handlers
  const updateHasChanges = (overrides: {
    port?: string;
    networkEnabled?: boolean;
    iface?: string;
    requirePw?: boolean;
    password?: string;
    allowAll?: boolean;
    hostsText?: string;
    localhostOpen?: boolean;
    /** The server's auth state when this render's context has not caught up. */
    authEnabled?: boolean;
  }) => {
    setHasChanges(
      checkForChanges(
        overrides.port ?? localhostPort,
        overrides.networkEnabled ?? networkEnabled,
        overrides.iface ?? selectedInterface,
        overrides.requirePw ?? requirePassword,
        overrides.password ?? authPassword,
        overrides.allowAll ?? allowAllHostsToggle,
        overrides.hostsText ?? allowedHostsText,
        overrides.localhostOpen ?? localhostOpenToggle,
        overrides.authEnabled ?? auth?.authEnabled ?? false,
      ),
    );
  };

  const saveFileAccess = useCallback(
    (nextForm: FileAccessForm): Promise<void> => {
      if (!serverSettings || fileAccessInfo?.envPinned) {
        return Promise.resolve();
      }

      const nextSettings = fileAccessFormToSettings(nextForm);
      const sequence = ++fileAccessSaveSequenceRef.current;
      setFileAccessError(null);
      setFileAccessSaving(true);

      const pending = fileAccessSaveChainRef.current
        .catch(() => undefined)
        .then(async () => {
          if (
            fileAccessSavedRef.current &&
            fileAccessEquals(fileAccessSavedRef.current, nextSettings)
          ) {
            return;
          }
          await updateServerSettings({ fileAccess: nextSettings });
          fileAccessSavedRef.current = cloneFileAccessSettings(nextSettings);
        })
        .catch((err) => {
          setFileAccessError(
            err instanceof Error
              ? err.message
              : t("localAccessErrorApplyFailed"),
          );
        })
        .finally(() => {
          if (fileAccessSaveSequenceRef.current === sequence) {
            setFileAccessSaving(false);
          }
        });

      fileAccessSaveChainRef.current = pending;
      return pending;
    },
    [fileAccessInfo?.envPinned, serverSettings, t, updateServerSettings],
  );

  const patchAndSaveFileAccess = (patch: Partial<FileAccessForm>) => {
    const next = { ...fileAccess, ...patch };
    setFileAccess(next);
    void saveFileAccess(next);
  };

  const serverFileAccess = serverSettings
    ? (serverSettings.fileAccess ?? DEFAULT_FILE_ACCESS)
    : null;
  const draftFileAccess = fileAccessFormToSettings(fileAccess);
  const baselineFileAccess = fileAccessBaselineRef.current;
  const fileAccessDraftChanged =
    serverFileAccess !== null &&
    !fileAccessEquals(draftFileAccess, serverFileAccess);
  const fileAccessBaselineChanged =
    serverFileAccess !== null &&
    baselineFileAccess !== null &&
    !fileAccessEquals(serverFileAccess, baselineFileAccess);
  const customFoldersChanged =
    serverFileAccess !== null &&
    (draftFileAccess.custom.length !== serverFileAccess.custom.length ||
      draftFileAccess.custom.some(
        (value, index) => value !== serverFileAccess.custom[index],
      ));

  // Network/auth edits remain staged because applying them can rebind or
  // redirect the server. File-access edits save immediately and Undo restores
  // their pane-open snapshot through the same server setting.
  const resetFormFromServer = useCallback(() => {
    if (!serverSettings) return;

    if (!binding || !auth) {
      setFormError(null);
      setHasChanges(false);
      return;
    }

    setLocalhostPort(String(binding.localhost.port));
    setNetworkEnabled(binding.network.enabled);
    setSelectedInterface(binding.network.host ?? "");
    setCustomIp("");
    setRequirePassword(auth.authEnabled);
    setLocalhostOpenToggle(auth.localhostOpen);
    setAuthPassword("");
    setAuthPasswordConfirm("");
    const ah = serverSettings.allowedHosts;
    if (ah === "*") {
      setAllowAllHostsToggle(true);
      setAllowedHostsText("");
    } else {
      setAllowAllHostsToggle(false);
      setAllowedHostsText(ah ?? "");
    }
    setFormError(null);
    setPasswordError(null);
    setHasChanges(false);
  }, [auth, binding, serverSettings]);

  const undoLocalAccessChanges = useCallback(async () => {
    await fileAccessSaveChainRef.current;
    const baseline = fileAccessBaselineRef.current;
    setFileAccessError(null);
    if (
      baseline &&
      !fileAccessInfo?.envPinned &&
      (fileAccessDraftChanged || fileAccessBaselineChanged)
    ) {
      const baselineForm = settingsToFileAccessForm(baseline);
      setFileAccess(baselineForm);
      await saveFileAccess(baselineForm);
    }
    resetFormFromServer();
  }, [
    fileAccessBaselineChanged,
    fileAccessDraftChanged,
    fileAccessInfo?.envPinned,
    resetFormFromServer,
    saveFileAccess,
  ]);
  useSettingsUndo(
    hasChanges || fileAccessDraftChanged || fileAccessBaselineChanged,
    undoLocalAccessChanges,
  );

  const renderFileAccessSettings = () => {
    const hasWholeDiskCustomPath = fileAccess.customText
      .split("\n")
      .some((line) => isWholeDiskPath(line));

    return (
      <SettingsItem
        label={t("fileAccessTitle")}
        description={t("fileAccessDescription")}
        keywords={[
          t("fileAccessAllowedFoldersTitle"),
          t("fileAccessProjects"),
          t("fileAccessProjectsDescription"),
          t("fileAccessUploads"),
          t("fileAccessTemp"),
          t("fileAccessHome"),
          t("fileAccessHomeDescription"),
          t("fileAccessCustomTitle"),
          t("fileAccessCustomDescription"),
        ]}
        layout="custom"
        className="file-access-settings-panel"
        containerProps={{
          role: "group",
          "aria-labelledby": "file-access-settings-title",
          "aria-describedby": "file-access-settings-description",
        }}
      >
        <div className="file-access-settings-header">
          <strong id="file-access-settings-title">
            {t("fileAccessTitle")}
          </strong>
          <p id="file-access-settings-description">
            {t("fileAccessDescription")}
          </p>
        </div>

        {fileAccessInfo?.envPinned ? (
          <div className="file-access-settings-list">
            <div className="file-access-setting-row file-access-setting-row--readonly">
              <div className="settings-item-info">
                <strong>{t("fileAccessAllowedFoldersTitle")}</strong>
                <p>{t("fileAccessEnvPinnedHint")}</p>
              </div>
              <span className="settings-value-readonly">
                {fileAccessInfo.envPaths.length > 0
                  ? fileAccessInfo.envPaths.join(", ")
                  : t("fileAccessNone")}{" "}
                <span className="settings-hint">
                  {t("fileAccessSetViaEnv")}
                </span>
              </span>
            </div>
          </div>
        ) : (
          <>
            <div className="file-access-settings-list">
              <div className="file-access-setting-row">
                <div className="settings-item-info">
                  <strong>{t("fileAccessProjects")}</strong>
                  <p>{t("fileAccessProjectsDescription")}</p>
                </div>
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    aria-label={t("fileAccessProjects")}
                    checked={fileAccess.projects}
                    onChange={(e) =>
                      patchAndSaveFileAccess({ projects: e.target.checked })
                    }
                  />
                  <span className="toggle-slider" />
                </label>
              </div>
              <div className="file-access-setting-row">
                <div className="settings-item-info">
                  <strong>{t("fileAccessUploads")}</strong>
                </div>
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    aria-label={t("fileAccessUploads")}
                    checked={fileAccess.uploads}
                    onChange={(e) =>
                      patchAndSaveFileAccess({ uploads: e.target.checked })
                    }
                  />
                  <span className="toggle-slider" />
                </label>
              </div>
              <div className="file-access-setting-row">
                <div className="settings-item-info">
                  <strong>{t("fileAccessTemp")}</strong>
                  {fileAccessInfo && fileAccessInfo.tempPaths.length > 0 && (
                    <p className="settings-hint">
                      {fileAccessInfo.tempPaths.join(", ")}
                    </p>
                  )}
                </div>
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    aria-label={t("fileAccessTemp")}
                    checked={fileAccess.temp}
                    onChange={(e) =>
                      patchAndSaveFileAccess({ temp: e.target.checked })
                    }
                  />
                  <span className="toggle-slider" />
                </label>
              </div>
              <div className="file-access-setting-row">
                <div className="settings-item-info">
                  <strong>{t("fileAccessHome")}</strong>
                  <p>{t("fileAccessHomeDescription")}</p>
                </div>
                {fileAccess.home && (
                  <span className="settings-status-badge settings-status-warning">
                    {t("fileAccessHomeCaution")}
                  </span>
                )}
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    aria-label={t("fileAccessHome")}
                    checked={fileAccess.home}
                    onChange={(e) =>
                      patchAndSaveFileAccess({ home: e.target.checked })
                    }
                  />
                  <span className="toggle-slider" />
                </label>
              </div>
              <div className="file-access-setting-row file-access-setting-row--field">
                <div className="settings-item-info">
                  <strong>{t("fileAccessCustomTitle")}</strong>
                  <p>{t("fileAccessCustomDescription")}</p>
                </div>
                <div className={styles.customFoldersControls}>
                  <textarea
                    className={`${styles.customFoldersInput} settings-input`}
                    rows={3}
                    aria-label={t("fileAccessCustomTitle")}
                    value={fileAccess.customText}
                    placeholder={t("fileAccessCustomPlaceholder")}
                    onChange={(e) =>
                      setFileAccess((previous) => ({
                        ...previous,
                        customText: e.target.value,
                      }))
                    }
                    onBlur={() => {
                      if (customFoldersChanged) void saveFileAccess(fileAccess);
                    }}
                  />
                  <button
                    type="button"
                    className={`${styles.customFoldersButton} settings-button`}
                    disabled={!customFoldersChanged || fileAccessSaving}
                    onClick={() => void saveFileAccess(fileAccess)}
                  >
                    {fileAccessSaving && customFoldersChanged
                      ? t("fileAccessCustomSaving")
                      : customFoldersChanged
                        ? t("fileAccessCustomSave")
                        : t("fileAccessCustomSaved")}
                  </button>
                </div>
              </div>
            </div>
            {fileAccessError && (
              <p className="form-error file-access-settings-warning">
                {fileAccessError}
              </p>
            )}
            {hasWholeDiskCustomPath && (
              <p className="form-warning file-access-settings-warning">
                {t("fileAccessWholeDiskWarning")}
              </p>
            )}
          </>
        )}
      </SettingsItem>
    );
  };

  const renderApprovalAuditSettings = () => (
    <SettingsItem
      label={t("localAccessApprovalAuditTitle")}
      description={t("localAccessApprovalAuditDescription")}
    >
      <label className="toggle-switch">
        <input
          type="checkbox"
          checked={approvalAuditLogEnabled}
          disabled={!serverSettings}
          onChange={(e) =>
            updateServerSetting("approvalAuditLogEnabled", e.target.checked)
          }
          aria-label={t("localAccessApprovalAuditTitle")}
        />
        <span className="toggle-slider" />
      </label>
    </SettingsItem>
  );

  // Shared by direct and remote (SRP) clients; the settings route accepts
  // these fields over either transport.
  const renderAgentApiSettings = () => (
    <>
      {supportsAgentApi && (
        <SettingsItem
          label={t("localAccessAgentApiTitle")}
          description={t("localAccessAgentApiDescription")}
          doc="topics/http-api-v0.md#local-agent-bootstrap"
          after={
            <details className={styles.agentApiPreview}>
              <summary>{t("localAccessAgentApiPreview")}</summary>
              <p>{t("localAccessAgentApiUnix")}</p>
              <pre>
                {agentApiBootstrapInstructions(
                  false,
                  supportsAgentApiManagement &&
                    serverSettings?.agentApiManagementEnabled === true,
                )}
              </pre>
              <p>{t("localAccessAgentApiWindows")}</p>
              <pre>
                {agentApiBootstrapInstructions(
                  true,
                  supportsAgentApiManagement &&
                    serverSettings?.agentApiManagementEnabled === true,
                )}
              </pre>
            </details>
          }
        >
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={serverSettings?.agentApiEnabled ?? false}
              disabled={!serverSettings}
              onChange={(e) =>
                updateServerSetting("agentApiEnabled", e.target.checked)
              }
              aria-label={t("localAccessAgentApiTitle")}
            />
            <span className="toggle-slider" />
          </label>
        </SettingsItem>
      )}

      {supportsAgentApiManagement && (
        <SettingsItem
          label={t("localAccessAgentApiManagementTitle")}
          description={t("localAccessAgentApiManagementDescription")}
          doc="topics/http-api-v0.md#session-command-authority"
        >
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={serverSettings?.agentApiManagementEnabled ?? false}
              disabled={!serverSettings}
              onChange={(event) =>
                updateServerSetting(
                  "agentApiManagementEnabled",
                  event.target.checked,
                )
              }
              aria-label={t("localAccessAgentApiManagementTitle")}
            />
            <span className="toggle-slider" />
          </label>
        </SettingsItem>
      )}
    </>
  );

  // Only meaningful once local requests need a password: without one, any
  // local process can already call the API.
  const renderAgentServerAccessSetting = () => (
    <SettingsItem
      label={t("localAccessAgentServerAccessTitle")}
      description={t("localAccessAgentServerAccessDescription")}
      doc="topics/agent-session-access.md#operator-api-token"
    >
      <label className="toggle-switch">
        <input
          type="checkbox"
          checked={serverSettings?.agentServerAccessEnabled ?? false}
          disabled={!serverSettings}
          onChange={(e) =>
            updateServerSetting("agentServerAccessEnabled", e.target.checked)
          }
          aria-label={t("localAccessAgentServerAccessTitle")}
        />
        <span className="toggle-slider" />
      </label>
    </SettingsItem>
  );

  // The password choice staged by Require Password and its fields. Both the
  // nested password block and Apply Changes validate and apply it here.
  const enablingAuth = Boolean(auth && requirePassword && !auth.authEnabled);
  const changingPassword = Boolean(
    auth && requirePassword && auth.authEnabled && authPassword.length > 0,
  );
  const disablingAuth = Boolean(auth && !requirePassword && auth.authEnabled);
  const passwordChoiceError = (): string | null => {
    if (!enablingAuth && !changingPassword) return null;
    if (authPassword.length < LOCAL_PASSWORD_MIN_LENGTH) {
      return t("localAccessErrorPasswordLength");
    }
    if (authPassword !== authPasswordConfirm) {
      return t("localAccessErrorPasswordMismatch");
    }
    return null;
  };
  const applyPasswordChoice = async (): Promise<void> => {
    if (!auth) return;
    if (enablingAuth) {
      await auth.enableAuth(authPassword);
    } else if (changingPassword) {
      await auth.changePassword(authPassword);
    } else if (disablingAuth) {
      await auth.disableAuth();
      return;
    } else {
      return;
    }
    setAuthPassword("");
    setAuthPasswordConfirm("");
  };

  const handleApplyPasswordChoice = async () => {
    setPasswordError(null);
    const error = passwordChoiceError();
    if (error) {
      setPasswordError(error);
      return;
    }
    setIsApplying(true);
    try {
      await applyPasswordChoice();
      // Enabling redirects to login; the other two leave the pane open.
      updateHasChanges({ password: "", authEnabled: requirePassword });
    } catch (err) {
      setPasswordError(
        err instanceof Error ? err.message : t("localAccessErrorApplyFailed"),
      );
    } finally {
      setIsApplying(false);
    }
  };

  const handleApplyChanges = async () => {
    if (!auth) return;
    setFormError(null);

    // Validate port
    const portNum = Number.parseInt(localhostPort, 10);
    if (Number.isNaN(portNum) || portNum < 1 || portNum > 65535) {
      setFormError(t("localAccessErrorPortRange"));
      return;
    }

    const passwordProblem = passwordChoiceError();
    if (passwordProblem) {
      setFormError(passwordProblem);
      return;
    }

    const effectiveInterface =
      selectedInterface === "custom" ? customIp : selectedInterface;

    setIsApplying(true);
    try {
      // Apply network binding changes (skip overridden fields to avoid 400 errors)
      const bindingUpdate: Parameters<typeof updateBinding>[0] = {};
      if (!binding?.localhost.overriddenByCli) {
        bindingUpdate.localhostPort = portNum;
      }
      if (!binding?.network.overriddenByCli) {
        bindingUpdate.network = {
          enabled: networkEnabled,
          host: networkEnabled ? effectiveInterface : undefined,
        };
      }
      const result = await updateBinding(bindingUpdate);

      await applyPasswordChoice();

      // Apply localhost access changes (desktop token floor bypass)
      if (localhostOpenToggle !== auth.localhostOpen) {
        await auth.setLocalhostOpen(localhostOpenToggle);
      }

      // Apply allowed hosts changes
      const newAllowedHosts = getAllowedHostsValue(
        allowAllHostsToggle,
        allowedHostsText,
      );
      await updateServerSettings({
        allowedHosts: newAllowedHosts ?? "",
      });

      if (result.redirectUrl) {
        // Server changed port, redirect to new URL preserving current path
        const newUrl = new URL(result.redirectUrl);
        newUrl.pathname = window.location.pathname;
        newUrl.search = window.location.search;
        window.location.href = newUrl.toString();
      } else {
        setHasChanges(false);
      }
    } catch (err) {
      setFormError(
        err instanceof Error ? err.message : t("localAccessErrorApplyFailed"),
      );
    } finally {
      setIsApplying(false);
    }
  };

  // Non-remote mode (cookie-based auth)
  if (auth) {
    // Show loading state until data is ready
    const isLoading =
      serverInfoLoading ||
      bindingLoading ||
      settingsLoading ||
      auth.isLoading ||
      !formInitialized;

    if (isLoading) {
      return <SettingsSection description={t("localAccessLoading")} />;
    }

    const feedback = passwordFeedback(authPassword, authPasswordConfirm);

    return (
      <SettingsSection description={t("localAccessDescription")}>
        {/* Current status */}
        <HideInSettingsSearch>
          <div className="settings-group">
            <div className="settings-item">
              <div className="settings-item-info">
                <strong>{t("localAccessStatusTitle")}</strong>
                <p>
                  {serverInfo
                    ? (() => {
                        const networkHost = binding?.network.host;
                        const networkPort =
                          binding?.network.port ?? serverInfo.port;
                        const isAllInterfaces =
                          networkHost === "0.0.0.0" || networkHost === "::";
                        const samePort = networkPort === serverInfo.port;

                        // If bound to all interfaces on same port, just show that
                        if (
                          binding?.network.enabled &&
                          isAllInterfaces &&
                          samePort
                        ) {
                          return (
                            <>
                              {t("localAccessListeningOn")}{" "}
                              <code>
                                {networkHost}:{networkPort}
                              </code>
                            </>
                          );
                        }

                        // Otherwise show localhost, and optionally network
                        return (
                          <>
                            {t("localAccessListeningOn")}{" "}
                            <code>
                              {serverInfo.host}:{serverInfo.port}
                            </code>
                            {binding?.network.enabled && networkHost && (
                              <>
                                {" "}
                                {t("localAccessListeningAnd")}{" "}
                                <code>
                                  {networkHost}:{networkPort}
                                </code>
                              </>
                            )}
                          </>
                        );
                      })()
                    : t("localAccessUnableToFetch")}
                </p>
              </div>
              {serverInfo?.localhostOnly && !binding?.network.enabled && (
                <span className="settings-status-badge settings-status-detected">
                  {t("localAccessBadgeLocalOnly")}
                </span>
              )}
              {(serverInfo?.boundToAllInterfaces || binding?.network.enabled) &&
                !auth.authEnabled && (
                  <span className="settings-status-badge settings-status-warning">
                    {t("localAccessBadgeNetworkExposed")}
                  </span>
                )}
            </div>
          </div>
        </HideInSettingsSearch>

        {/* Network Configuration */}
        <form
          className="settings-group"
          onSubmit={(e) => {
            e.preventDefault();
            handleApplyChanges();
          }}
        >
          <SettingsItem
            label={t("localAccessListeningPortTitle")}
            description={t("localAccessListeningPortDescription")}
          >
            {binding?.localhost.overriddenByCli ? (
              <span className="settings-value-readonly">
                {binding.localhost.port}{" "}
                <span className="settings-hint">
                  {t("localAccessSetViaPort")}
                </span>
              </span>
            ) : (
              <input
                type="number"
                className="settings-input-small"
                value={localhostPort}
                onChange={(e) => {
                  setLocalhostPort(e.target.value);
                  updateHasChanges({ port: e.target.value });
                }}
                min={1}
                max={65535}
                autoComplete="off"
              />
            )}
          </SettingsItem>

          <SettingsItem
            label={t("localAccessNetworkTitle")}
            description={t("localAccessNetworkDescription")}
          >
            {binding?.network.overriddenByCli ? (
              <span className="settings-value-readonly">
                {binding.network.host}:{binding.network.port}{" "}
                <span className="settings-hint">
                  {t("localAccessSetViaHost")}
                </span>
              </span>
            ) : (
              <label className="toggle-switch">
                <input
                  type="checkbox"
                  checked={networkEnabled}
                  onChange={(e) => {
                    setNetworkEnabled(e.target.checked);
                    updateHasChanges({ networkEnabled: e.target.checked });
                  }}
                />
                <span className="toggle-slider" />
              </label>
            )}
          </SettingsItem>

          {networkEnabled && !binding?.network.overriddenByCli && binding && (
            <SettingsItem
              label={t("localAccessInterfaceTitle")}
              description={t("localAccessInterfaceDescription")}
            >
              <FilterDropdown
                label={t("localAccessInterfaceTitle")}
                placeholder={t("localAccessInterfacePlaceholder")}
                multiSelect={false}
                align="right"
                options={[
                  ...binding.interfaces.map((iface) => ({
                    value: iface.address,
                    label: iface.displayName,
                  })),
                  {
                    value: "0.0.0.0",
                    label: t("localAccessInterfaceAll"),
                  },
                  { value: "custom", label: t("localAccessInterfaceCustom") },
                ]}
                selected={selectedInterface ? [selectedInterface] : []}
                onChange={(values) => {
                  const newInterface = values[0] ?? "";
                  setSelectedInterface(newInterface);
                  updateHasChanges({ iface: newInterface });
                }}
              />
            </SettingsItem>
          )}

          {networkEnabled &&
            !binding?.network.overriddenByCli &&
            selectedInterface === "custom" && (
              <SettingsItem
                label={t("localAccessCustomIpTitle")}
                description={t("localAccessCustomIpDescription")}
                className="settings-item-inline-field"
              >
                <input
                  type="text"
                  className="settings-input"
                  placeholder="192.168.1.100"
                  value={customIp}
                  onChange={(e) => setCustomIp(e.target.value)}
                />
              </SettingsItem>
            )}

          {/* Allowed Hosts — applies even on localhost (reverse proxy may use different hostname) */}
          <SettingsItem
            label={t("localAccessAllowAllHostsTitle")}
            description={t("localAccessAllowAllHostsDescription")}
          >
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={allowAllHostsToggle}
                onChange={(e) => {
                  setAllowAllHostsToggle(e.target.checked);
                  updateHasChanges({ allowAll: e.target.checked });
                }}
              />
              <span className="toggle-slider" />
            </label>
          </SettingsItem>
          {!allowAllHostsToggle && (
            <SettingsItem
              label={t("localAccessAllowedHostsTitle")}
              description={t("localAccessAllowedHostsDescription")}
              className="settings-item-inline-field"
            >
              <input
                type="text"
                className="settings-input"
                placeholder={t("localAccessAllowedHostsPlaceholder")}
                value={allowedHostsText}
                onChange={(e) => {
                  setAllowedHostsText(e.target.value);
                  updateHasChanges({ hostsText: e.target.value });
                }}
              />
            </SettingsItem>
          )}
          <HideInSettingsSearch>
            <p className="form-hint">{t("localAccessAllowedHostsHint")}</p>
          </HideInSettingsSearch>

          {renderFileAccessSettings()}

          {/* Require Password toggle */}
          {!auth.authDisabledByEnv && (
            <SettingsItem
              label={t("localAccessRequirePasswordTitle")}
              description={t("localAccessRequirePasswordDescription")}
              doc="site/src/content/docs/local-access.md"
            >
              <label className="toggle-switch">
                <input
                  type="checkbox"
                  aria-label={t("localAccessRequirePasswordTitle")}
                  checked={requirePassword}
                  onChange={(e) => {
                    setRequirePassword(e.target.checked);
                    updateHasChanges({ requirePw: e.target.checked });
                  }}
                />
                <span className="toggle-slider" />
              </label>
            </SettingsItem>
          )}

          {/* The password choice, nested under the toggle that gates it and
              applied from its own button beside the fields. */}
          {!auth.authDisabledByEnv && (requirePassword || auth.authEnabled) && (
            <div
              className={`settings-subsection ${styles.passwordBlock}`}
              data-local-access-password-block="true"
            >
              <HideInSettingsSearch>
                <p
                  className={`${styles.passwordState} ${
                    !requirePassword
                      ? styles.passwordStateWarning
                      : auth.authEnabled
                        ? styles.passwordStateActive
                        : styles.passwordStatePending
                  }`}
                  role="status"
                >
                  {!requirePassword
                    ? t("localAccessPasswordDisableWarning")
                    : auth.authEnabled
                      ? t("localAccessPasswordActive")
                      : t("localAccessPasswordPending")}
                </p>
              </HideInSettingsSearch>
              {requirePassword && (
                <>
                  {/* Hidden username field to prevent Chrome from using port as username */}
                  <HideInSettingsSearch>
                    <input
                      type="text"
                      name="username"
                      autoComplete="username"
                      style={{
                        position: "absolute",
                        visibility: "hidden",
                        pointerEvents: "none",
                      }}
                      tabIndex={-1}
                    />
                  </HideInSettingsSearch>
                  <SettingsItem
                    label={
                      auth.authEnabled
                        ? t("localAccessPasswordNewTitle")
                        : t("localAccessPasswordTitle")
                    }
                    description={
                      auth.authEnabled
                        ? t("localAccessPasswordKeepCurrent")
                        : t("localAccessPasswordMinLength")
                    }
                    className="settings-item-inline-field"
                  >
                    <input
                      type="password"
                      className="settings-input"
                      value={authPassword}
                      onChange={(e) => {
                        setAuthPassword(e.target.value);
                        setPasswordError(null);
                        updateHasChanges({ password: e.target.value });
                      }}
                      autoComplete="new-password"
                      placeholder={
                        auth.authEnabled
                          ? t("localAccessPasswordNewPlaceholder")
                          : t("localAccessPasswordPlaceholder")
                      }
                    />
                  </SettingsItem>
                  {(enablingAuth || changingPassword) && (
                    <SettingsItem
                      label={t("localAccessConfirmPasswordTitle")}
                      className="settings-item-inline-field"
                    >
                      <input
                        type="password"
                        className={`settings-input ${
                          feedback?.kind === "mismatch"
                            ? styles.inputInvalid
                            : feedback?.kind === "match"
                              ? styles.inputValid
                              : ""
                        }`}
                        aria-invalid={feedback?.kind === "mismatch"}
                        aria-describedby="local-access-password-feedback"
                        value={authPasswordConfirm}
                        onChange={(e) => {
                          setAuthPasswordConfirm(e.target.value);
                          setPasswordError(null);
                        }}
                        autoComplete="new-password"
                        placeholder={t("localAccessConfirmPasswordPlaceholder")}
                      />
                    </SettingsItem>
                  )}
                </>
              )}
              <HideInSettingsSearch>
                <div className={styles.passwordActions}>
                  <p
                    id="local-access-password-feedback"
                    className={`${styles.passwordFeedback} ${
                      passwordError || feedback?.kind === "mismatch"
                        ? styles.passwordFeedbackBad
                        : feedback?.kind === "match"
                          ? styles.passwordFeedbackGood
                          : ""
                    }`}
                    aria-live="polite"
                    data-local-access-password-feedback={
                      passwordError ? "error" : (feedback?.kind ?? "none")
                    }
                  >
                    {passwordError ??
                      (feedback?.kind === "short"
                        ? t("localAccessPasswordTooShortCount", {
                            count: feedback.length,
                            min: LOCAL_PASSWORD_MIN_LENGTH,
                          })
                        : feedback?.kind === "mismatch"
                          ? t("localAccessErrorPasswordMismatch")
                          : feedback?.kind === "match"
                            ? t("localAccessPasswordMatch")
                            : "")}
                  </p>
                  {(enablingAuth || changingPassword || disablingAuth) && (
                    <button
                      type="button"
                      className={`settings-button ${
                        disablingAuth
                          ? "settings-button-danger"
                          : styles.passwordApply
                      }`}
                      disabled={
                        isApplying ||
                        applying ||
                        (!disablingAuth && passwordChoiceError() !== null)
                      }
                      onClick={() => void handleApplyPasswordChoice()}
                    >
                      {disablingAuth
                        ? t("localAccessPasswordDisableAction")
                        : enablingAuth
                          ? t("localAccessPasswordEnableAction")
                          : t("localAccessPasswordChangeAction")}
                    </button>
                  )}
                </div>
                {!auth.authEnabled && requirePassword && (
                  <p className={styles.passwordHint}>
                    {t("localAccessPasswordResetHint")}
                  </p>
                )}
              </HideInSettingsSearch>
            </div>
          )}

          {supportsAgentServerAccess &&
            auth.authEnabled &&
            renderAgentServerAccessSetting()}

          {renderAgentApiSettings()}

          {/* Allow Localhost Access - shown in desktop mode when password auth is off */}
          {auth.hasDesktopToken &&
            !requirePassword &&
            !auth.authDisabledByEnv && (
              <SettingsItem
                label={t("localAccessLocalhostOpenTitle")}
                description={t("localAccessLocalhostOpenDescription")}
                doc="site/src/content/docs/local-access.md#desktop-app-allow-localhost-access"
              >
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={localhostOpenToggle}
                    onChange={(e) => {
                      setLocalhostOpenToggle(e.target.checked);
                      updateHasChanges({ localhostOpen: e.target.checked });
                    }}
                  />
                  <span className="toggle-slider" />
                </label>
              </SettingsItem>
            )}

          {auth.authDisabledByEnv && (
            <HideInSettingsSearch>
              <p className="form-warning">{t("localAccessAuthDisabled")}</p>
            </HideInSettingsSearch>
          )}

          {/* Apply button - always visible */}
          <HideInSettingsSearch>
            <div className="settings-item">
              {formError && <p className="form-error">{formError}</p>}
              <button
                type="submit"
                className="settings-button"
                disabled={!hasChanges || isApplying || applying}
              >
                {isApplying || applying
                  ? t("localAccessApplying")
                  : t("localAccessApply")}
              </button>
            </div>
          </HideInSettingsSearch>
        </form>

        <div className="settings-group">{renderApprovalAuditSettings()}</div>

        {/* Logout - shown when auth is enabled */}
        {auth.authEnabled && auth.isAuthenticated && (
          <div className="settings-group">
            <SettingsItem
              id="local-access-logout"
              label={t("remoteAccessLogoutTitle")}
              description={t("localAccessLogoutDescription")}
            >
              <button
                type="button"
                className="settings-button settings-button-danger"
                onClick={auth.logout}
              >
                {t("remoteAccessLogout")}
              </button>
            </SettingsItem>
          </div>
        )}
        <AppsSettingsLink />
      </SettingsSection>
    );
  }

  // Remote mode (SRP auth)
  if (remoteConnection) {
    const remoteFileAccessReady = !!serverSettings && formInitialized;

    return (
      <SettingsSection description={t("localAccessRemoteDescription")}>
        {remoteFileAccessReady ? (
          <div className="settings-group">{renderFileAccessSettings()}</div>
        ) : (
          <HideInSettingsSearch>
            <div className="settings-group">
              <div className="settings-item">
                <div className="settings-item-info">
                  <strong>{t("fileAccessTitle")}</strong>
                  <p>{settingsError ?? t("localAccessLoading")}</p>
                </div>
              </div>
            </div>
          </HideInSettingsSearch>
        )}

        <div className="settings-group">{renderApprovalAuditSettings()}</div>

        {(supportsAgentApi || supportsAgentApiManagement) && (
          <div className="settings-group">{renderAgentApiSettings()}</div>
        )}

        <div className="settings-group">
          <SettingsItem
            id="local-access-remote-logout"
            label={t("remoteAccessLogoutTitle")}
            description={t("localAccessRemoteLogoutDescription")}
          >
            <button
              type="button"
              className="settings-button settings-button-danger"
              onClick={() => remoteConnection.disconnect()}
            >
              {t("remoteAccessLogout")}
            </button>
          </SettingsItem>
        </div>
        <AppsSettingsLink />
      </SettingsSection>
    );
  }

  // No auth context available
  return null;
}
