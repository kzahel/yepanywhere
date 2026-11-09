import { useCallback, useMemo, useState } from "react";
import { NativeNotificationStatus } from "../../components/NativeNotificationStatus";
import { PushNotificationToggle } from "../../components/PushNotificationToggle";
import { Button } from "../../components/ui/Button";
import { Select } from "../../components/ui/Field";
import { Switch } from "../../components/ui/Switch";
import { useConnectedDevices } from "../../hooks/useConnectedDevices";
import {
  type NotificationSettings,
  useNotificationSettings,
} from "../../hooks/useNotificationSettings";
import { usePushNotifications } from "../../hooks/usePushNotifications";
import {
  type PushDeliveryUrgency,
  type SubscribedDevice,
  type TestNotificationUrgency,
  useSubscribedDevices,
} from "../../hooks/useSubscribedDevices";
import { useI18n } from "../../i18n";
import { nativeHost } from "../../lib/nativeHost";
import { SettingsItem } from "./SettingsItem";
import { useSettingsPaneTitle } from "./SettingsPaneTitleContext";
import { HideInSettingsSearch } from "./SettingsSearchContext";
import { SettingsSection } from "./SettingsSection";
import { useSettingsUndoBaseline } from "./SettingsUndoContext";
import styles from "./NotificationsSettings.module.css";

/**
 * Unified device that merges subscribed device info with connection status.
 */
interface UnifiedDevice {
  browserProfileId: string;
  /** Device name from push subscription, or truncated UUID */
  displayName: string;
  /** Browser type suffix (e.g., "(Android/Chrome)") */
  browserType: string;
  /** True if device has push subscription */
  isSubscribed: boolean;
  /** Coarse device type inferred by the server */
  deviceType: SubscribedDevice["deviceType"];
  /** True if device is currently connected */
  isConnected: boolean;
  /** Number of connected tabs (0 if not connected) */
  tabCount: number;
  /** Subscription date (if subscribed) */
  subscribedAt?: string;
  /** True if this is the current device */
  isCurrentDevice: boolean;
}

/**
 * Format a device name with its domain for display.
 * Returns the display name and browser type separately.
 */
function formatDeviceName(
  deviceName: string | undefined,
  endpointDomain: string | undefined,
  deviceType: SubscribedDevice["deviceType"],
): { displayName: string; browserType: string } {
  const name = deviceName || "Unknown device";

  // Push-service domains identify the browser family, not the operating
  // system. Chrome on macOS and Windows uses Google's service too.
  if (endpointDomain?.includes("google")) {
    return {
      displayName: name,
      browserType: deviceType === "android" ? "(Android/Chrome)" : "(Chrome)",
    };
  }
  if (
    endpointDomain?.includes("apple") ||
    endpointDomain?.includes("push.apple")
  ) {
    return {
      displayName: name,
      browserType: deviceType === "ios" ? "(iOS/Safari)" : "(Safari)",
    };
  }
  if (
    endpointDomain?.includes("mozilla") ||
    endpointDomain?.includes("push.services.mozilla")
  ) {
    return { displayName: name, browserType: "(Firefox)" };
  }
  return { displayName: name, browserType: "" };
}

/**
 * Format a date string to a relative or absolute format.
 */
function formatDate(
  dateString: string,
  t: (key: never, vars?: Record<string, string | number>) => string,
): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) {
    return new Date().toLocaleDateString();
  }
  if (diffDays === 1) {
    return new Date(Date.now() - 86400000).toLocaleDateString();
  }
  if (diffDays < 7) {
    return t("hostPickerLastConnectedDays" as never, { count: diffDays });
  }
  return date.toLocaleDateString();
}

/**
 * Merge subscribed devices with connected devices into a unified list.
 * Sorts: current device first, then connected devices, then offline subscribed.
 */
function mergeDevices(
  subscribedDevices: SubscribedDevice[],
  connectedDevices: Map<
    string,
    { connectionCount: number; deviceName?: string }
  >,
  currentBrowserProfileId: string | null,
): UnifiedDevice[] {
  const deviceMap = new Map<string, UnifiedDevice>();

  // Add subscribed devices first
  for (const device of subscribedDevices) {
    const { displayName, browserType } = formatDeviceName(
      device.deviceName,
      device.endpointDomain,
      device.deviceType,
    );
    const connection = connectedDevices.get(device.browserProfileId);

    deviceMap.set(device.browserProfileId, {
      browserProfileId: device.browserProfileId,
      displayName,
      browserType,
      isSubscribed: true,
      deviceType: device.deviceType,
      isConnected: !!connection,
      tabCount: connection?.connectionCount ?? 0,
      subscribedAt: device.createdAt,
      isCurrentDevice: device.browserProfileId === currentBrowserProfileId,
    });
  }

  // Add connected-but-not-subscribed devices
  for (const [browserProfileId, connection] of connectedDevices) {
    if (!deviceMap.has(browserProfileId)) {
      // Not subscribed, show truncated UUID
      const truncatedId = browserProfileId.slice(0, 8);
      deviceMap.set(browserProfileId, {
        browserProfileId,
        displayName: truncatedId,
        browserType: "",
        isSubscribed: false,
        deviceType: "unknown",
        isConnected: true,
        tabCount: connection.connectionCount,
        isCurrentDevice: browserProfileId === currentBrowserProfileId,
      });
    }
  }

  // Convert to array and sort
  const devices = Array.from(deviceMap.values());

  devices.sort((a, b) => {
    // Current device first
    if (a.isCurrentDevice && !b.isCurrentDevice) return -1;
    if (!a.isCurrentDevice && b.isCurrentDevice) return 1;

    // Then connected devices (sorted by tab count descending)
    if (a.isConnected && !b.isConnected) return -1;
    if (!a.isConnected && b.isConnected) return 1;
    if (a.isConnected && b.isConnected) {
      return b.tabCount - a.tabCount;
    }

    // Then offline subscribed (sorted by subscription date, newest first)
    if (a.subscribedAt && b.subscribedAt) {
      return (
        new Date(b.subscribedAt).getTime() - new Date(a.subscribedAt).getTime()
      );
    }

    return 0;
  });

  return devices;
}

function isMobilePushDevice(device: UnifiedDevice): boolean {
  return (
    device.isSubscribed &&
    (device.deviceType === "android" ||
      device.deviceType === "ios" ||
      device.deviceType === "mobile")
  );
}

/**
 * The server-side notification-type toggles, gated on having at least one
 * push-subscribed device (without one, no notification could be delivered).
 */
const SERVER_NOTIFICATION_ROWS: ReadonlyArray<{
  key: keyof NotificationSettings;
  /** Stable search/jump id (row labels are locale-dependent). */
  id: string;
  titleKey:
    | "notificationsToolApprovalsTitle"
    | "notificationsQuestionsTitle"
    | "notificationsSessionHaltedTitle"
    | "notificationsProjectInactiveTitle"
    | "notificationsYaInactiveTitle";
  descriptionKey:
    | "notificationsToolApprovalsDescription"
    | "notificationsQuestionsDescription"
    | "notificationsSessionHaltedDescription"
    | "notificationsProjectInactiveDescription"
    | "notificationsYaInactiveDescription";
  defaultValue: boolean;
}> = [
  {
    key: "toolApproval",
    id: "notifications-tool-approvals",
    titleKey: "notificationsToolApprovalsTitle",
    descriptionKey: "notificationsToolApprovalsDescription",
    defaultValue: true,
  },
  {
    key: "userQuestion",
    id: "notifications-questions",
    titleKey: "notificationsQuestionsTitle",
    descriptionKey: "notificationsQuestionsDescription",
    defaultValue: true,
  },
  {
    key: "sessionHalted",
    id: "notifications-session-halted",
    titleKey: "notificationsSessionHaltedTitle",
    descriptionKey: "notificationsSessionHaltedDescription",
    defaultValue: false,
  },
  {
    key: "projectInactive",
    id: "notifications-project-inactive",
    titleKey: "notificationsProjectInactiveTitle",
    descriptionKey: "notificationsProjectInactiveDescription",
    defaultValue: false,
  },
  {
    key: "yaInactive",
    id: "notifications-ya-inactive",
    titleKey: "notificationsYaInactiveTitle",
    descriptionKey: "notificationsYaInactiveDescription",
    defaultValue: false,
  },
];

function deliveryPriorityLabelKey(
  urgency: PushDeliveryUrgency,
):
  | "pushDeliveryHigh"
  | "pushDeliveryNormal"
  | "pushDeliveryLow"
  | "pushDeliveryVeryLow" {
  if (urgency === "high") return "pushDeliveryHigh";
  if (urgency === "low") return "pushDeliveryLow";
  if (urgency === "very-low") return "pushDeliveryVeryLow";
  return "pushDeliveryNormal";
}

export function NotificationsSettings() {
  const { t } = useI18n();
  useSettingsPaneTitle(t("settingsNotificationsTitle"));
  const { browserProfileId, unsubscribe } = usePushNotifications();
  const {
    devices: subscribedDevices,
    isLoading: devicesLoading,
    removeDevice,
    sendTest,
  } = useSubscribedDevices();
  const { connections, isLoading: connectionsLoading } = useConnectedDevices();
  const {
    settings,
    isLoading: settingsLoading,
    updateSetting,
  } = useNotificationSettings();

  // The app's WebView has no Web Push; it enrolls per server natively.
  const inApp = nativeHost.isAvailable();
  const hasSubscriptions = subscribedDevices.length > 0;
  const isLoading = devicesLoading || connectionsLoading;
  const [testDisplayUrgency, setTestDisplayUrgency] =
    useState<TestNotificationUrgency>("normal");
  const [testDeliveryUrgency, setTestDeliveryUrgency] =
    useState<PushDeliveryUrgency>("high");
  const [testingDeviceIds, setTestingDeviceIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [testStatus, setTestStatus] = useState<{
    kind: "success" | "error";
    message: string;
  } | null>(null);

  // Header undo for the server-side notification toggles. Push/browser
  // subscription state is device-permission-bound and not snapshot-undoable.
  const undoState = useMemo(
    () =>
      settings
        ? {
            toolApproval: settings.toolApproval,
            userQuestion: settings.userQuestion,
            sessionHalted: settings.sessionHalted,
            projectInactive: settings.projectInactive,
            yaInactive: settings.yaInactive,
          }
        : null,
    [settings],
  );
  const restoreUndoState = useCallback(
    (snapshot: NonNullable<typeof undoState>) => {
      void updateSetting("toolApproval", snapshot.toolApproval);
      void updateSetting("userQuestion", snapshot.userQuestion);
      void updateSetting("sessionHalted", snapshot.sessionHalted);
      void updateSetting("projectInactive", snapshot.projectInactive);
      void updateSetting("yaInactive", snapshot.yaInactive);
    },
    [updateSetting],
  );
  useSettingsUndoBaseline(undoState, restoreUndoState);

  // Merge subscribed and connected devices
  const unifiedDevices = mergeDevices(
    subscribedDevices,
    connections,
    browserProfileId,
  );
  const mobilePushDevices = useMemo(
    () => unifiedDevices.filter(isMobilePushDevice),
    [unifiedDevices],
  );
  const isTestingMobileDevices = mobilePushDevices.some((device) =>
    testingDeviceIds.has(device.browserProfileId),
  );

  const buildTestMessage = useCallback(
    () =>
      t("pushTestMessage", {
        priority: t(deliveryPriorityLabelKey(testDeliveryUrgency)),
      }),
    [t, testDeliveryUrgency],
  );

  const markTesting = useCallback(
    (browserProfileIds: string[], testing: boolean) => {
      setTestingDeviceIds((current) => {
        const next = new Set(current);
        for (const browserProfileId of browserProfileIds) {
          if (testing) {
            next.add(browserProfileId);
          } else {
            next.delete(browserProfileId);
          }
        }
        return next;
      });
    },
    [],
  );

  const sendTestToDevice = useCallback(
    async (device: UnifiedDevice) => {
      markTesting([device.browserProfileId], true);
      setTestStatus(null);
      try {
        await sendTest(device.browserProfileId, {
          displayUrgency: testDisplayUrgency,
          deliveryUrgency: testDeliveryUrgency,
          message: buildTestMessage(),
        });
        setTestStatus({
          kind: "success",
          message: t("notificationsTestSentToDevice", {
            device: device.displayName,
          }),
        });
      } catch (err) {
        setTestStatus({
          kind: "error",
          message:
            err instanceof Error ? err.message : t("notificationsTestFailed"),
        });
      } finally {
        markTesting([device.browserProfileId], false);
      }
    },
    [
      buildTestMessage,
      markTesting,
      sendTest,
      t,
      testDeliveryUrgency,
      testDisplayUrgency,
    ],
  );

  const sendTestToMobileDevices = useCallback(async () => {
    const targetIds = mobilePushDevices.map(
      (device) => device.browserProfileId,
    );
    if (targetIds.length === 0) return;

    markTesting(targetIds, true);
    setTestStatus(null);
    try {
      const results = await Promise.allSettled(
        mobilePushDevices.map((device) =>
          sendTest(device.browserProfileId, {
            displayUrgency: testDisplayUrgency,
            deliveryUrgency: testDeliveryUrgency,
            message: buildTestMessage(),
          }),
        ),
      );
      const failed = results.filter((result) => result.status === "rejected");
      if (failed.length > 0) {
        setTestStatus({
          kind: "error",
          message: t("notificationsTestPartialFailure", {
            failed: failed.length,
            total: results.length,
          }),
        });
      } else {
        setTestStatus({
          kind: "success",
          message: t("notificationsTestSentToMobile", {
            count: results.length,
          }),
        });
      }
    } finally {
      markTesting(targetIds, false);
    }
  }, [
    buildTestMessage,
    markTesting,
    mobilePushDevices,
    sendTest,
    t,
    testDeliveryUrgency,
    testDisplayUrgency,
  ]);

  const removeSubscribedDevice = useCallback(
    async (device: UnifiedDevice) => {
      if (device.isCurrentDevice) {
        await unsubscribe();
        return;
      }
      await removeDevice(device.browserProfileId);
    },
    [removeDevice, unsubscribe],
  );

  // Native app subscriptions are not listed here but honor these toggles.
  const serverTogglesGated = !hasSubscriptions && !inApp;
  const gatedTooltip = serverTogglesGated
    ? t("notificationsNoSubscribedDevices")
    : undefined;

  return (
    <>
      <SettingsSection
        title={
          inApp
            ? t("notificationsThisAppTitle")
            : t("notificationsThisBrowserTitle")
        }
        description={
          inApp
            ? t("notificationsThisAppDescription")
            : t("notificationsThisBrowserDescription")
        }
      >
        <div className="settings-group">
          {inApp ? <NativeNotificationStatus /> : <PushNotificationToggle />}
        </div>
      </SettingsSection>

      <SettingsSection
        title={t("notificationsEventsTitle")}
        description={t("notificationsEventsDescription")}
      >
        <HideInSettingsSearch>
          {serverTogglesGated && !devicesLoading && (
            <div className="settings-info-box settings-subsection-hint">
              <p>{t("notificationsNoSubscribedDevices")}</p>
            </div>
          )}
        </HideInSettingsSearch>
        <div className="settings-group">
          {SERVER_NOTIFICATION_ROWS.map((row) => (
            <SettingsItem
              key={row.key}
              id={row.id}
              title={gatedTooltip}
              label={t(row.titleKey)}
              description={t(row.descriptionKey)}
            >
              <Switch
                aria-label={t(row.titleKey)}
                title={gatedTooltip}
                checked={settings?.[row.key] ?? row.defaultValue}
                onCheckedChange={(checked) => updateSetting(row.key, checked)}
                disabled={settingsLoading || serverTogglesGated}
              />
            </SettingsItem>
          ))}
        </div>
      </SettingsSection>

      <SettingsSection
        title={t("notificationsDevicesTitle")}
        description={t("notificationsDevicesDescription")}
      >
        <HideInSettingsSearch>
          <div className="settings-group">
            {isLoading ? (
              <p className="settings-hint">
                {t("notificationsLoadingDevices")}
              </p>
            ) : unifiedDevices.length === 0 ? (
              <p className="settings-hint">{t("notificationsNoDevices")}</p>
            ) : (
              <div className="device-list">
                {unifiedDevices.map((device) => (
                  <div
                    key={device.browserProfileId}
                    className="device-list-item"
                  >
                    <div className="device-list-info">
                      <strong>
                        {device.displayName}
                        {device.browserType && ` ${device.browserType}`}
                        {device.isCurrentDevice && (
                          <span className="device-current-badge">
                            {t("notificationsThisDevice")}
                          </span>
                        )}
                      </strong>
                      <p>
                        {/* Status indicator */}
                        {device.isConnected ? (
                          <span className="device-status device-status-online">
                            {device.tabCount === 1
                              ? t("notificationsOneTab")
                              : t("notificationsTabs", {
                                  count: device.tabCount,
                                })}
                          </span>
                        ) : (
                          <span className="device-status device-status-offline">
                            {t("notificationsOffline")}
                          </span>
                        )}
                        {/* No push indicator for connected-only devices */}
                        {!device.isSubscribed && (
                          <span className="device-no-push">
                            {t("notificationsNoPush")}
                          </span>
                        )}
                        {/* Subscription date for subscribed devices */}
                        {device.subscribedAt && (
                          <span className="device-subscribed-date">
                            {t("notificationsSubscribed", {
                              date: formatDate(device.subscribedAt, t),
                            })}
                          </span>
                        )}
                      </p>
                    </div>
                    {/* Only show remove button for subscribed devices */}
                    {device.isSubscribed && (
                      <div className="device-list-actions">
                        <Button
                          onClick={() => sendTestToDevice(device)}
                          disabled={testingDeviceIds.has(
                            device.browserProfileId,
                          )}
                          title={t("notificationsTestDevice")}
                        >
                          {t("notificationsTest")}
                        </Button>
                        <Button
                          variant="danger-outline"
                          onClick={() => removeSubscribedDevice(device)}
                          title={
                            device.isCurrentDevice
                              ? t("notificationsRemoveThisDevice")
                              : t("notificationsRemoveDevice")
                          }
                        >
                          {t("notificationsRemove")}
                        </Button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {hasSubscriptions && (
            <details className={styles.diagnostics}>
              <summary className={styles.diagnosticsSummary}>
                <span>
                  <strong>{t("notificationsDiagnosticsTitle")}</strong>
                  <span>{t("notificationsDiagnosticsDescription")}</span>
                </span>
              </summary>
              <div className={styles.diagnosticsBody}>
                <div className="settings-group">
                  <div
                    className={`settings-item push-test-controls ${styles.testRow}`}
                  >
                    <div className="settings-item-info">
                      <strong>{t("notificationsTestPushTitle")}</strong>
                      <p>{t("notificationsTestPushDescription")}</p>
                      <p
                        className={`push-test-status ${
                          testStatus?.kind === "error"
                            ? "settings-error"
                            : "settings-hint"
                        }`}
                        aria-live="polite"
                      >
                        {testStatus?.message ?? "\u00a0"}
                      </p>
                    </div>
                    <div
                      className={`settings-item-actions ${styles.testActions}`}
                    >
                      <Select
                        aria-label={t("pushToggleDisplayBehavior")}
                        value={testDisplayUrgency}
                        onChange={(e) =>
                          setTestDisplayUrgency(
                            e.target.value as TestNotificationUrgency,
                          )
                        }
                        disabled={isTestingMobileDevices}
                      >
                        <option value="normal">
                          {t("pushToggleUrgencyNormal")}
                        </option>
                        <option value="persistent">
                          {t("pushToggleUrgencyPersistent")}
                        </option>
                        <option value="silent">
                          {t("pushToggleUrgencySilent")}
                        </option>
                      </Select>
                      <Select
                        aria-label={t("pushTestDeliveryPriority")}
                        value={testDeliveryUrgency}
                        onChange={(e) =>
                          setTestDeliveryUrgency(
                            e.target.value as PushDeliveryUrgency,
                          )
                        }
                        disabled={isTestingMobileDevices}
                      >
                        <option value="high">{t("pushDeliveryHigh")}</option>
                        <option value="normal">
                          {t("pushDeliveryNormal")}
                        </option>
                        <option value="low">{t("pushDeliveryLow")}</option>
                        <option value="very-low">
                          {t("pushDeliveryVeryLow")}
                        </option>
                      </Select>
                      <Button
                        onClick={sendTestToMobileDevices}
                        disabled={
                          mobilePushDevices.length === 0 ||
                          isTestingMobileDevices
                        }
                        title={
                          mobilePushDevices.length === 0
                            ? t("notificationsNoMobilePushDevices")
                            : t("notificationsSendToMobileDevices", {
                                count: mobilePushDevices.length,
                              })
                        }
                      >
                        {t("notificationsSendToMobileDevices", {
                          count: mobilePushDevices.length,
                        })}
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            </details>
          )}
        </HideInSettingsSearch>
      </SettingsSection>
    </>
  );
}
