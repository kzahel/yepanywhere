import rowsStyles from "./SettingsRows.module.css";
import {
  AGENT_SERVER_ACCESS_CAPABILITY,
  SERVER_CAPABILITIES,
  agentApiBootstrapInstructions,
  serverHasCapability,
} from "@yep-anywhere/shared";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  api,
  DEFAULT_FILE_ACCESS,
  type FileAccessInfo,
  type FileAccessSettings,
} from "../../api/client";
import { FilterDropdown } from "../../components/FilterDropdown";
import { Badge } from "../../components/ui/Badge";
import { Banner } from "../../components/ui/Banner";
import { Button } from "../../components/ui/Button";
import { Textarea, TextInput } from "../../components/ui/Field";
import { Switch } from "../../components/ui/Switch";
import { isConnectionImpactDeclined } from "../../api/connectionImpact";
import { useOptionalAuth } from "../../contexts/AuthContext";
import { useOptionalRemoteConnection } from "../../contexts/RemoteConnectionContext";
import { useConnectionImpactConfirmation } from "../../hooks/useConnectionImpactConfirmation";
import { useLocalAuthControls } from "../../hooks/useLocalAuthControls";
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
  const wholeDiskWarningId = useId();
  // Direct (cookie) and Remote Access clients see the same controls; only the
  // session's own logout differs (topics/connection-safe-settings.md).
  const auth = useOptionalAuth();
  const remoteConnection = useOptionalRemoteConnection();
  const localAuth = useLocalAuthControls();
  const confirmImpact = useConnectionImpactConfirmation();
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
  // An older server can exit on a failed rebind, and a Remote Access client
  // could not reach it again; its listeners stay read-only from here.
  const canChangeListeners =
    !remoteConnection ||
    serverHasCapability(
      versionInfo,
      SERVER_CAPABILITIES.connectionSafeSettings,
    );
  // Network binding form state
  const [localhostPort, setLocalhostPort] = useState<string>("");
  const [networkEnabled, setNetworkEnabled] = useState(false);
  const [selectedInterface, setSelectedInterface] = useState<string>("");
  const [customIp, setCustomIp] = useState("");

  // Password changes have their own explicit action, independent of listeners.
  const [requirePassword, setRequirePassword] = useState(false);
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
  const [portError, setPortError] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const [passwordApplying, setPasswordApplying] = useState(false);
  const [localhostSaving, setLocalhostSaving] = useState(false);
  const [localhostError, setLocalhostError] = useState<string | null>(null);

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

  // Initialize form from binding, auth, and settings state when it loads. A
  // server whose listeners cannot be read still offers its other settings.
  const [formInitialized, setFormInitialized] = useState(false);
  useEffect(() => {
    if (
      bindingLoading ||
      !localAuth.ready ||
      !serverSettings ||
      formInitialized
    ) {
      return;
    }

    if (binding) {
      setLocalhostPort(String(binding.localhost.port));
      setNetworkEnabled(binding.network.enabled);
      setSelectedInterface(binding.network.host ?? "");
    }
    setRequirePassword(localAuth.authEnabled);
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
  }, [
    binding,
    bindingLoading,
    formInitialized,
    localAuth.authEnabled,
    localAuth.ready,
    serverSettings,
  ]);

  // When the listeners change after the form loaded (this apply or another
  // client's), follow them in every field the user has not edited.
  const shownBindingRef = useRef(binding);
  useEffect(() => {
    const previous = shownBindingRef.current;
    shownBindingRef.current = binding;
    if (!formInitialized || !binding || previous === binding) return;
    const follow = <T,>(value: T, before: T | undefined, after: T) =>
      previous === null || value === before ? after : value;
    setLocalhostPort((value) =>
      follow(
        value,
        previous ? String(previous.localhost.port) : undefined,
        String(binding.localhost.port),
      ),
    );
    setNetworkEnabled((value) =>
      follow(value, previous?.network.enabled, binding.network.enabled),
    );
    setSelectedInterface((value) =>
      follow(
        value,
        previous ? (previous.network.host ?? "") : undefined,
        binding.network.host ?? "",
      ),
    );
  }, [binding, formInitialized]);

  const shownHostsRef = useRef(serverSettings?.allowedHosts);
  useEffect(() => {
    const previous = shownHostsRef.current;
    const current = serverSettings?.allowedHosts;
    shownHostsRef.current = current;
    if (!formInitialized || current === previous) return;
    setAllowAllHostsToggle((value) =>
      value === (previous === "*") ? current === "*" : value,
    );
    setAllowedHostsText((value) =>
      value === (previous === "*" ? "" : (previous ?? ""))
        ? current === "*"
          ? ""
          : (current ?? "")
        : value,
    );
  }, [formInitialized, serverSettings?.allowedHosts]);

  useEffect(() => {
    if (!serverSettings) return;
    fileAccessSavedRef.current = cloneFileAccessSettings(
      serverSettings.fileAccess ?? DEFAULT_FILE_ACCESS,
    );
  }, [serverSettings]);

  const allowedHostsValue = allowAllHostsToggle ? "*" : allowedHostsText.trim();

  // Derive pending changes from the same effective values that Apply sends.
  // Hidden or command-line-owned listener fields cannot create phantom edits.
  const effectiveInterface =
    selectedInterface === "custom" ? customIp.trim() : selectedInterface;
  const portChanged =
    !!binding &&
    canChangeListeners &&
    !binding.localhost.overriddenByCli &&
    Number(localhostPort) !== binding.localhost.port;
  const networkChanged =
    !!binding &&
    canChangeListeners &&
    !binding.network.overriddenByCli &&
    networkEnabled !== binding.network.enabled;
  const interfaceChanged =
    !!binding &&
    canChangeListeners &&
    !binding.network.overriddenByCli &&
    networkEnabled &&
    effectiveInterface !== (binding.network.host ?? "");
  const allowedHostsChanged =
    !!serverSettings &&
    allowedHostsValue !== (serverSettings.allowedHosts ?? "");
  const connectionChanges = [
    portChanged && t("localAccessListeningPortTitle"),
    networkChanged && t("localAccessNetworkTitle"),
    interfaceChanged && t("localAccessInterfaceTitle"),
    allowedHostsChanged && t("localAccessAllowedHostsTitle"),
  ]
    .filter(Boolean)
    .join(", ");
  const connectionChanged = !!connectionChanges;
  const passwordChanged =
    localAuth.canManage &&
    !localAuth.authDisabledByEnv &&
    (requirePassword !== localAuth.authEnabled ||
      authPassword.length > 0 ||
      authPasswordConfirm.length > 0);

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

  // Discard only this form's unapplied connection edits. Never reverse a
  // successful rebind or touch independently saved settings/password drafts.
  const resetConnectionFromServer = useCallback(() => {
    if (binding) {
      setLocalhostPort(String(binding.localhost.port));
      setNetworkEnabled(binding.network.enabled);
      setSelectedInterface(binding.network.host ?? "");
    }
    setCustomIp("");
    setAllowAllHostsToggle(serverSettings?.allowedHosts === "*");
    setAllowedHostsText(
      serverSettings?.allowedHosts === "*"
        ? ""
        : (serverSettings?.allowedHosts ?? ""),
    );
    setFormError(null);
    setPortError(false);
  }, [binding, serverSettings?.allowedHosts]);

  const resetPasswordFromServer = useCallback(() => {
    setRequirePassword(localAuth.authEnabled);
    setAuthPassword("");
    setAuthPasswordConfirm("");
    setPasswordError(null);
  }, [localAuth.authEnabled]);

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
    resetConnectionFromServer();
    resetPasswordFromServer();
  }, [
    fileAccessBaselineChanged,
    fileAccessDraftChanged,
    fileAccessInfo?.envPinned,
    resetConnectionFromServer,
    resetPasswordFromServer,
    saveFileAccess,
  ]);
  useSettingsUndo(
    connectionChanged ||
      passwordChanged ||
      fileAccessDraftChanged ||
      fileAccessBaselineChanged,
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
        className={styles.panel}
        containerProps={{
          role: "group",
          "aria-labelledby": "file-access-settings-title",
          "aria-describedby": "file-access-settings-description",
        }}
      >
        <div className={styles.header}>
          <strong id="file-access-settings-title">
            {t("fileAccessTitle")}
          </strong>
          <p id="file-access-settings-description">
            {t("fileAccessDescription")}
          </p>
        </div>

        {fileAccessInfo?.envPinned ? (
          <div className={styles.list}>
            <div
              className={`${styles.fileAccessSettingRow} ${styles.fileAccessSettingRowReadonly}`}
            >
              <div className={rowsStyles.itemInfo} data-settings-info>
                <strong>{t("fileAccessAllowedFoldersTitle")}</strong>
                <p>{t("fileAccessEnvPinnedHint")}</p>
              </div>
              <span>
                {fileAccessInfo.envPaths.length > 0
                  ? fileAccessInfo.envPaths.join(", ")
                  : t("fileAccessNone")}{" "}
                <span className={rowsStyles.hint}>
                  {t("fileAccessSetViaEnv")}
                </span>
              </span>
            </div>
          </div>
        ) : (
          <>
            <div className={styles.list}>
              <div className={styles.fileAccessSettingRow}>
                <div className={rowsStyles.itemInfo} data-settings-info>
                  <strong>{t("fileAccessProjects")}</strong>
                  <p>{t("fileAccessProjectsDescription")}</p>
                </div>
                <Switch
                  aria-label={t("fileAccessProjects")}
                  checked={fileAccess.projects}
                  onCheckedChange={(checked) =>
                    patchAndSaveFileAccess({ projects: checked })
                  }
                />
              </div>
              <div className={styles.fileAccessSettingRow}>
                <div className={rowsStyles.itemInfo} data-settings-info>
                  <strong>{t("fileAccessUploads")}</strong>
                </div>
                <Switch
                  aria-label={t("fileAccessUploads")}
                  checked={fileAccess.uploads}
                  onCheckedChange={(checked) =>
                    patchAndSaveFileAccess({ uploads: checked })
                  }
                />
              </div>
              <div className={styles.fileAccessSettingRow}>
                <div className={rowsStyles.itemInfo} data-settings-info>
                  <strong>{t("fileAccessTemp")}</strong>
                  {fileAccessInfo && fileAccessInfo.tempPaths.length > 0 && (
                    <p className={rowsStyles.hint}>
                      {fileAccessInfo.tempPaths.join(", ")}
                    </p>
                  )}
                </div>
                <Switch
                  aria-label={t("fileAccessTemp")}
                  checked={fileAccess.temp}
                  onCheckedChange={(checked) =>
                    patchAndSaveFileAccess({ temp: checked })
                  }
                />
              </div>
              <div className={styles.fileAccessSettingRow}>
                <div className={rowsStyles.itemInfo} data-settings-info>
                  <strong>{t("fileAccessHome")}</strong>
                  <p>{t("fileAccessHomeDescription")}</p>
                </div>
                {fileAccess.home && (
                  <Badge tone="warning">{t("fileAccessHomeCaution")}</Badge>
                )}
                <Switch
                  aria-label={t("fileAccessHome")}
                  checked={fileAccess.home}
                  onCheckedChange={(checked) =>
                    patchAndSaveFileAccess({ home: checked })
                  }
                />
              </div>
              <div
                className={`${styles.fileAccessSettingRow} ${styles.fileAccessSettingRowField}`}
              >
                <div className={rowsStyles.itemInfo} data-settings-info>
                  <strong>{t("fileAccessCustomTitle")}</strong>
                  <p>{t("fileAccessCustomDescription")}</p>
                </div>
                <div className={styles.customFoldersControls}>
                  <Textarea
                    className={styles.customFoldersInput}
                    rows={3}
                    aria-label={t("fileAccessCustomTitle")}
                    aria-describedby={
                      hasWholeDiskCustomPath ? wholeDiskWarningId : undefined
                    }
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
                  <Button
                    variant="primary"
                    className={styles.customFoldersButton}
                    disabled={!customFoldersChanged || fileAccessSaving}
                    onClick={() => void saveFileAccess(fileAccess)}
                  >
                    {fileAccessSaving && customFoldersChanged
                      ? t("fileAccessCustomSaving")
                      : customFoldersChanged
                        ? t("fileAccessCustomSave")
                        : t("fileAccessCustomSaved")}
                  </Button>
                </div>
              </div>
            </div>
            {fileAccessError && <Banner tone="error">{fileAccessError}</Banner>}
            {hasWholeDiskCustomPath && (
              <Banner
                id={wholeDiskWarningId}
                tone="warning"
                role="none"
                compact
              >
                {t("fileAccessWholeDiskWarning")}
              </Banner>
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
      <Switch
        checked={approvalAuditLogEnabled}
        disabled={!serverSettings}
        onCheckedChange={(checked) =>
          updateServerSetting("approvalAuditLogEnabled", checked)
        }
        aria-label={t("localAccessApprovalAuditTitle")}
      />
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
          <Switch
            checked={serverSettings?.agentApiEnabled ?? false}
            disabled={!serverSettings}
            onCheckedChange={(checked) =>
              updateServerSetting("agentApiEnabled", checked)
            }
            aria-label={t("localAccessAgentApiTitle")}
          />
        </SettingsItem>
      )}

      {supportsAgentApiManagement && (
        <SettingsItem
          label={t("localAccessAgentApiManagementTitle")}
          description={t("localAccessAgentApiManagementDescription")}
          doc="topics/http-api-v0.md#session-command-authority"
        >
          <Switch
            checked={serverSettings?.agentApiManagementEnabled ?? false}
            disabled={!serverSettings}
            onCheckedChange={(checked) =>
              updateServerSetting("agentApiManagementEnabled", checked)
            }
            aria-label={t("localAccessAgentApiManagementTitle")}
          />
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
      <Switch
        checked={serverSettings?.agentServerAccessEnabled ?? false}
        disabled={!serverSettings}
        onCheckedChange={(checked) =>
          updateServerSetting("agentServerAccessEnabled", checked)
        }
        aria-label={t("localAccessAgentServerAccessTitle")}
      />
    </SettingsItem>
  );

  // Only the password form may apply the staged password choice.
  const enablingAuth =
    localAuth.canManage && requirePassword && !localAuth.authEnabled;
  const changingPassword =
    localAuth.canManage &&
    requirePassword &&
    localAuth.authEnabled &&
    authPassword.length > 0;
  const disablingAuth =
    localAuth.canManage && !requirePassword && localAuth.authEnabled;
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
  const handleApplyPasswordChoice = async () => {
    setPasswordError(null);
    const error = passwordChoiceError();
    if (error) {
      setPasswordError(error);
      return;
    }
    if (passwordApplying || isApplying || applying || !passwordChanged) return;
    setPasswordApplying(true);
    try {
      if (enablingAuth) await localAuth.enableAuth(authPassword);
      else if (changingPassword) await localAuth.changePassword(authPassword);
      else if (disablingAuth) await localAuth.disableAuth();
      setAuthPassword("");
      setAuthPasswordConfirm("");
    } catch (err) {
      setPasswordError(
        err instanceof Error ? err.message : t("localAccessErrorApplyFailed"),
      );
    } finally {
      setPasswordApplying(false);
    }
  };

  const handleApplyChanges = async () => {
    if (!connectionChanged || isApplying || applying || passwordApplying)
      return;
    setFormError(null);
    setPortError(false);

    // Validate port
    const portNum = Number(localhostPort);
    if (
      binding &&
      canChangeListeners &&
      !binding.localhost.overriddenByCli &&
      (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535)
    ) {
      setPortError(true);
      return;
    }

    setIsApplying(true);
    // Listening and allowed-host changes can disconnect this client; one
    // confirmation covers both requests of this apply. The listener change
    // goes last: it can move this page's own server, so nothing is sent after
    // it, and declining it leaves only that change pending.
    const impactScope = { confirmed: false };
    try {
      if (allowedHostsValue !== (serverSettings?.allowedHosts ?? "")) {
        await confirmImpact(
          (confirmedConnectionImpact) =>
            updateServerSettings(
              { allowedHosts: allowedHostsValue },
              { confirmedConnectionImpact },
            ),
          { mayDisconnect: true, scope: impactScope },
        );
      }

      // Send only edited fields, and none that the command line overrides.
      const bindingUpdate: Parameters<typeof updateBinding>[0] = {};
      if (
        binding &&
        !binding.localhost.overriddenByCli &&
        portNum !== binding.localhost.port
      ) {
        bindingUpdate.localhostPort = portNum;
      }
      if (
        binding &&
        !binding.network.overriddenByCli &&
        (networkEnabled !== binding.network.enabled ||
          (networkEnabled &&
            effectiveInterface !== (binding.network.host ?? "")))
      ) {
        bindingUpdate.network = {
          enabled: networkEnabled,
          host: networkEnabled ? effectiveInterface : undefined,
        };
      }
      const result =
        canChangeListeners && Object.keys(bindingUpdate).length > 0
          ? await confirmImpact(
              (confirmed) => updateBinding(bindingUpdate, confirmed),
              { mayDisconnect: true, scope: impactScope },
            )
          : {};

      // A tunneled (Remote Access) request never gets a redirect.
      if (result.redirectUrl && !remoteConnection) {
        // Server changed port, redirect to new URL preserving current path
        const newUrl = new URL(result.redirectUrl);
        newUrl.pathname = window.location.pathname;
        newUrl.search = window.location.search;
        window.location.href = newUrl.toString();
      }
    } catch (err) {
      if (!isConnectionImpactDeclined(err)) {
        setFormError(
          err instanceof Error ? err.message : t("localAccessErrorApplyFailed"),
        );
      }
    } finally {
      setIsApplying(false);
    }
  };

  // Show loading state until data is ready
  const isLoading =
    serverInfoLoading ||
    bindingLoading ||
    settingsLoading ||
    !localAuth.ready ||
    !formInitialized;

  if (isLoading) {
    return (
      <SettingsSection description={settingsError ?? t("localAccessLoading")} />
    );
  }

  const feedback = passwordFeedback(authPassword, authPasswordConfirm);

  return (
    <SettingsSection description={t("localAccessDescription")}>
      {/* Current status */}
      <HideInSettingsSearch>
        <div className={rowsStyles.group} data-settings-group>
          <div className={rowsStyles.item}>
            <div className={rowsStyles.itemInfo} data-settings-info>
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
              <Badge tone="success">{t("localAccessBadgeLocalOnly")}</Badge>
            )}
            {(serverInfo?.boundToAllInterfaces || binding?.network.enabled) &&
              !localAuth.authEnabled && (
                <Badge tone="warning">
                  {t("localAccessBadgeNetworkExposed")}
                </Badge>
              )}
          </div>
        </div>
      </HideInSettingsSearch>

      <SettingsSection
        title={t("localAccessConnectionTitle")}
        description={t("localAccessConnectionDescription")}
        keywords={[
          t("localAccessListeningPortTitle"),
          t("localAccessNetworkTitle"),
          t("localAccessInterfaceTitle"),
          t("localAccessCustomIpTitle"),
          t("localAccessAllowAllHostsTitle"),
          t("localAccessAllowedHostsTitle"),
        ]}
        doc="topics/connection-safe-settings.md"
        className={styles.connectionSection}
        onSubmit={(e) => {
          e.preventDefault();
          handleApplyChanges();
        }}
      >
        <fieldset
          className={`${rowsStyles.group} ${styles.connectionFields}`}
          disabled={isApplying || applying}
        >
          {binding && (
            <>
              <SettingsItem
                label={t("localAccessListeningPortTitle")}
                description={
                  canChangeListeners
                    ? t("localAccessListeningPortDescription")
                    : t("localAccessListenersRemoteUpdateRequired")
                }
                after={
                  portError && (
                    <Banner id="local-access-port-error" tone="error">
                      {t("localAccessErrorPortRange")}
                    </Banner>
                  )
                }
              >
                {binding?.localhost.overriddenByCli ? (
                  <span>
                    {binding.localhost.port}{" "}
                    <span className={rowsStyles.hint}>
                      {t("localAccessSetViaPort")}
                    </span>
                  </span>
                ) : (
                  <TextInput
                    type="number"
                    className={styles.port}
                    disabled={!canChangeListeners || isApplying || applying}
                    invalid={portError}
                    aria-describedby={
                      portError ? "local-access-port-error" : undefined
                    }
                    value={localhostPort}
                    onChange={(e) => {
                      setLocalhostPort(e.target.value);
                      setPortError(false);
                    }}
                    min={1}
                    max={65535}
                    autoComplete="off"
                    aria-label={t("localAccessListeningPortTitle")}
                  />
                )}
              </SettingsItem>

              <SettingsItem
                label={t("localAccessNetworkTitle")}
                description={t("localAccessNetworkDescription")}
              >
                {binding?.network.overriddenByCli ? (
                  <span>
                    {binding.network.host}:{binding.network.port}{" "}
                    <span className={rowsStyles.hint}>
                      {t("localAccessSetViaHost")}
                    </span>
                  </span>
                ) : (
                  <Switch
                    aria-label={t("localAccessNetworkTitle")}
                    checked={networkEnabled}
                    disabled={!canChangeListeners || isApplying || applying}
                    onCheckedChange={(checked) => {
                      setNetworkEnabled(checked);
                    }}
                  />
                )}
              </SettingsItem>
            </>
          )}

          {networkEnabled &&
            canChangeListeners &&
            !binding?.network.overriddenByCli &&
            binding && (
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
                  }}
                />
              </SettingsItem>
            )}

          {networkEnabled &&
            canChangeListeners &&
            !binding?.network.overriddenByCli &&
            selectedInterface === "custom" && (
              <SettingsItem
                label={t("localAccessCustomIpTitle")}
                description={t("localAccessCustomIpDescription")}
                className={rowsStyles.itemInlineField}
              >
                <TextInput
                  className={styles.inlineField}
                  placeholder="192.168.1.100"
                  aria-label={t("localAccessCustomIpTitle")}
                  value={customIp}
                  disabled={isApplying || applying}
                  onChange={(e) => setCustomIp(e.target.value)}
                />
              </SettingsItem>
            )}

          {/* Allowed Hosts — applies even on localhost (reverse proxy may use different hostname) */}
          <SettingsItem
            label={t("localAccessAllowAllHostsTitle")}
            description={t("localAccessAllowAllHostsDescription")}
          >
            <Switch
              aria-label={t("localAccessAllowAllHostsTitle")}
              checked={allowAllHostsToggle}
              disabled={isApplying || applying}
              onCheckedChange={(checked) => {
                setAllowAllHostsToggle(checked);
              }}
            />
          </SettingsItem>
          {!allowAllHostsToggle && (
            <SettingsItem
              label={t("localAccessAllowedHostsTitle")}
              description={t("localAccessAllowedHostsDescription")}
              className={rowsStyles.itemInlineField}
            >
              <TextInput
                className={styles.inlineField}
                placeholder={t("localAccessAllowedHostsPlaceholder")}
                aria-label={t("localAccessAllowedHostsTitle")}
                value={allowedHostsText}
                disabled={isApplying || applying}
                onChange={(e) => {
                  setAllowedHostsText(e.target.value);
                }}
              />
            </SettingsItem>
          )}
          <HideInSettingsSearch>
            <p>{t("localAccessAllowedHostsHint")}</p>
          </HideInSettingsSearch>
        </fieldset>
        {(connectionChanged || isApplying || applying) && (
          <div className={styles.connectionActions}>
            <p role="status">
              {t("localAccessConnectionPending", {
                settings: connectionChanges,
              })}
            </p>
            {formError && <Banner tone="error">{formError}</Banner>}
            <div className={styles.actionButtons}>
              <Button
                disabled={isApplying || applying}
                onClick={resetConnectionFromServer}
              >
                {t("localAccessDiscard")}
              </Button>
              <Button
                variant="primary"
                type="submit"
                busy={isApplying || applying}
                disabled={passwordApplying}
              >
                {isApplying || applying
                  ? t("localAccessApplying")
                  : t("localAccessConnectionApply")}
              </Button>
            </div>
          </div>
        )}
      </SettingsSection>

      <SettingsSection
        title={t("localAccessAuthenticationTitle")}
        description={t("localAccessAuthenticationDescription")}
        keywords={[
          t("localAccessRequirePasswordTitle"),
          t("localAccessPasswordTitle"),
          t("localAccessPasswordNewTitle"),
          t("localAccessConfirmPasswordTitle"),
        ]}
        onSubmit={(event) => {
          event.preventDefault();
          void handleApplyPasswordChoice();
        }}
      >
        <div className={rowsStyles.group} data-settings-group>
          {/* Require Password toggle */}
          {!localAuth.authDisabledByEnv && (
            <SettingsItem
              label={t("localAccessRequirePasswordTitle")}
              description={
                localAuth.canManage
                  ? t("localAccessRequirePasswordDescription")
                  : t("localAccessPasswordRemoteUpdateRequired")
              }
              doc="site/src/content/docs/local-access.md"
            >
              <Switch
                aria-label={t("localAccessRequirePasswordTitle")}
                checked={requirePassword}
                disabled={!localAuth.canManage || passwordApplying}
                onCheckedChange={(checked) => {
                  setRequirePassword(checked);
                }}
              />
            </SettingsItem>
          )}

          {/* The password choice, nested under the toggle that gates it and
            applied from its own button beside the fields. */}
          {localAuth.canManage &&
            !localAuth.authDisabledByEnv &&
            (requirePassword || localAuth.authEnabled) && (
              <div
                className={`${rowsStyles.subsection} ${styles.passwordBlock}`}
                data-local-access-password-block="true"
              >
                <Banner
                  tone={
                    requirePassword && localAuth.authEnabled
                      ? "success"
                      : "warning"
                  }
                  compact
                  className={styles.passwordState}
                >
                  {!requirePassword
                    ? t("localAccessPasswordDisableWarning")
                    : localAuth.authEnabled
                      ? t("localAccessPasswordActive")
                      : t("localAccessPasswordPending")}
                </Banner>
                {requirePassword && (
                  <>
                    {/* Hidden username field to prevent Chrome from using port as username */}
                    <HideInSettingsSearch>
                      <TextInput
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
                        localAuth.authEnabled
                          ? t("localAccessPasswordNewTitle")
                          : t("localAccessPasswordTitle")
                      }
                      description={
                        localAuth.authEnabled
                          ? t("localAccessPasswordKeepCurrent")
                          : t("localAccessPasswordMinLength")
                      }
                      className={rowsStyles.itemInlineField}
                    >
                      <TextInput
                        type="password"
                        className={styles.inlineField}
                        aria-label={
                          localAuth.authEnabled
                            ? t("localAccessPasswordNewTitle")
                            : t("localAccessPasswordTitle")
                        }
                        value={authPassword}
                        disabled={passwordApplying}
                        onChange={(e) => {
                          setAuthPassword(e.target.value);
                          setPasswordError(null);
                        }}
                        autoComplete="new-password"
                        placeholder={
                          localAuth.authEnabled
                            ? t("localAccessPasswordNewPlaceholder")
                            : t("localAccessPasswordPlaceholder")
                        }
                      />
                    </SettingsItem>
                    {(enablingAuth || changingPassword) && (
                      <SettingsItem
                        label={t("localAccessConfirmPasswordTitle")}
                        className={rowsStyles.itemInlineField}
                      >
                        <TextInput
                          type="password"
                          className={styles.inlineField}
                          invalid={feedback?.kind === "mismatch"}
                          aria-label={t("localAccessConfirmPasswordTitle")}
                          aria-describedby="local-access-password-feedback"
                          value={authPasswordConfirm}
                          disabled={passwordApplying}
                          onChange={(e) => {
                            setAuthPasswordConfirm(e.target.value);
                            setPasswordError(null);
                          }}
                          autoComplete="new-password"
                          placeholder={t(
                            "localAccessConfirmPasswordPlaceholder",
                          )}
                        />
                      </SettingsItem>
                    )}
                  </>
                )}
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
                  {passwordChanged && (
                    <Button
                      disabled={passwordApplying}
                      onClick={resetPasswordFromServer}
                    >
                      {t("localAccessDiscard")}
                    </Button>
                  )}
                  {(enablingAuth || changingPassword || disablingAuth) && (
                    <Button
                      type="submit"
                      busy={passwordApplying}
                      variant={disablingAuth ? "danger" : "primary"}
                      className={
                        disablingAuth ? undefined : styles.passwordApply
                      }
                      disabled={
                        passwordApplying ||
                        isApplying ||
                        applying ||
                        (!disablingAuth && passwordChoiceError() !== null)
                      }
                    >
                      {disablingAuth
                        ? t("localAccessPasswordDisableAction")
                        : enablingAuth
                          ? t("localAccessPasswordEnableAction")
                          : t("localAccessPasswordChangeAction")}
                    </Button>
                  )}
                </div>
                {!localAuth.authEnabled && requirePassword && (
                  <p className={styles.passwordHint}>
                    {t("localAccessPasswordResetHint")}
                  </p>
                )}
              </div>
            )}

          {/* Allow Localhost Access - shown in desktop mode when password auth is off */}
          {localAuth.hasDesktopToken &&
            !requirePassword &&
            !localAuth.authDisabledByEnv && (
              <SettingsItem
                label={t("localAccessLocalhostOpenTitle")}
                description={t("localAccessLocalhostOpenDescription")}
                doc="site/src/content/docs/local-access.md#desktop-app-allow-localhost-access"
                after={
                  localhostError && (
                    <Banner tone="error">{localhostError}</Banner>
                  )
                }
              >
                <Switch
                  aria-label={t("localAccessLocalhostOpenTitle")}
                  checked={localAuth.localhostOpen}
                  disabled={!localAuth.canManage || localhostSaving}
                  onCheckedChange={async (checked) => {
                    setLocalhostError(null);
                    setLocalhostSaving(true);
                    try {
                      await localAuth.setLocalhostOpen(checked);
                    } catch (error) {
                      setLocalhostError(
                        error instanceof Error
                          ? error.message
                          : t("localAccessErrorApplyFailed"),
                      );
                    } finally {
                      setLocalhostSaving(false);
                    }
                  }}
                />
              </SettingsItem>
            )}

          {localAuth.authDisabledByEnv && (
            <HideInSettingsSearch>
              <Banner tone="warning" role="none">
                {t("localAccessAuthDisabled")}
              </Banner>
            </HideInSettingsSearch>
          )}
        </div>
      </SettingsSection>

      <div className={rowsStyles.group} data-settings-group>
        {renderFileAccessSettings()}
      </div>

      {(supportsAgentApi ||
        supportsAgentApiManagement ||
        (supportsAgentServerAccess && localAuth.authEnabled)) && (
        <SettingsSection
          title={t("localAccessAgentAccessTitle")}
          description={t("localAccessImmediateDescription")}
        >
          <div className={rowsStyles.group} data-settings-group>
            {supportsAgentServerAccess &&
              localAuth.authEnabled &&
              renderAgentServerAccessSetting()}

            {renderAgentApiSettings()}
          </div>
        </SettingsSection>
      )}

      <div className={rowsStyles.group} data-settings-group>
        {renderApprovalAuditSettings()}
      </div>

      {/* The session's own logout: a cookie login or this Remote Access link. */}
      {auth?.authEnabled && auth.isAuthenticated && (
        <div className={rowsStyles.group} data-settings-group>
          <SettingsItem
            id="local-access-logout"
            label={t("remoteAccessLogoutTitle")}
            description={t("localAccessLogoutDescription")}
          >
            <Button variant="danger" onClick={auth.logout}>
              {t("remoteAccessLogout")}
            </Button>
          </SettingsItem>
        </div>
      )}
      {remoteConnection && (
        <div className={rowsStyles.group} data-settings-group>
          <SettingsItem
            id="local-access-remote-logout"
            label={t("remoteAccessLogoutTitle")}
            description={t("localAccessRemoteLogoutDescription")}
          >
            <Button
              variant="danger"
              onClick={() => remoteConnection.disconnect()}
            >
              {t("remoteAccessLogout")}
            </Button>
          </SettingsItem>
        </div>
      )}
    </SettingsSection>
  );
}
