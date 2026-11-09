import {
  DEVICE_BRIDGE_CAPABILITY,
  DEVICE_BRIDGE_DOWNLOAD_CAPABILITY,
  type DeviceInfo,
  serverHasCapability,
} from "@yep-anywhere/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/client";
import { EmulatorNavButtons } from "../components/EmulatorNavButtons";
import { EmulatorStream } from "../components/EmulatorStream";
import { PageHeader } from "../components/PageHeader";
import { Button } from "../components/ui/Button";
import { useEmulatorSettings } from "../hooks/useEmulatorSettings";
import { useEmulatorStream } from "../hooks/useEmulatorStream";
import { useEmulators } from "../hooks/useEmulators";
import { useVersion } from "../hooks/useVersion";
import { useI18n } from "../i18n";
import { MainContent, useNavigationLayout } from "../layouts";
import styles from "./EmulatorPage.module.css";

const DEVICE_TYPE_ORDER: DeviceInfo["type"][] = [
  "emulator",
  "android",
  "chromeos",
  "ios-simulator",
];

function deviceLabel(device: DeviceInfo): string {
  return device.label || device.avd || device.id;
}

function deviceTypeLabel(type: DeviceInfo["type"]): string {
  switch (type) {
    case "emulator":
      return "Android Emulators";
    case "android":
      return "Android Devices";
    case "chromeos":
      return "ChromeOS Devices";
    case "ios-simulator":
      return "iOS Simulators";
    default:
      return "Devices";
  }
}

function hasAction(device: DeviceInfo, action: "stream" | "start" | "stop") {
  if (device.actions?.length) {
    return device.actions.includes(action);
  }

  if (action === "stream") {
    return device.state !== "stopped";
  }
  if (action === "start") {
    return device.type === "emulator" && device.state === "stopped";
  }
  if (action === "stop") {
    return device.type === "emulator" && device.state !== "stopped";
  }
  return false;
}

type NavigatorKeyboard = {
  lock?: (keyCodes?: string[]) => Promise<void>;
  unlock?: () => void;
};

function getNavigatorKeyboard(): NavigatorKeyboard | undefined {
  return (navigator as Navigator & { keyboard?: NavigatorKeyboard }).keyboard;
}

function EmulatorListItem({
  device,
  onConnect,
  onStart,
  onStop,
}: {
  device: DeviceInfo;
  onConnect: (device: DeviceInfo) => void;
  onStart: (id: string) => void;
  onStop: (id: string) => void;
}) {
  const canConnect = hasAction(device, "stream");
  const canStart = hasAction(device, "start");
  const canStop = hasAction(device, "stop");

  return (
    <div className={styles.item} data-testid="device-row">
      <div className={styles.itemInfo}>
        <span className={styles.itemName}>{deviceLabel(device)}</span>
        <span
          className={`${styles.itemStatus} ${device.state === "stopped" ? styles.stopped : styles.running}`}
        >
          {device.state}
        </span>
      </div>
      <div className={styles.itemActions}>
        {canConnect && (
          <Button variant="primary" onClick={() => onConnect(device)}>
            Connect
          </Button>
        )}
        {canStop && <Button onClick={() => onStop(device.id)}>Stop</Button>}
        {!canStop && canStart && (
          <Button onClick={() => onStart(device.id)}>Start</Button>
        )}
        {!canConnect && !canStop && !canStart && (
          <span className={styles.itemStatus}>No actions</span>
        )}
      </div>
    </div>
  );
}

function DeviceList({
  devices,
  onConnect,
  onStart,
  onStop,
}: {
  devices: DeviceInfo[];
  onConnect: (device: DeviceInfo) => void;
  onStart: (id: string) => void;
  onStop: (id: string) => void;
}) {
  const grouped = useMemo(() => {
    const groups = new Map<DeviceInfo["type"], DeviceInfo[]>();
    for (const type of DEVICE_TYPE_ORDER) {
      groups.set(type, []);
    }
    for (const device of devices) {
      const bucket = groups.get(device.type);
      if (bucket) {
        bucket.push(device);
      } else {
        groups.set(device.type, [device]);
      }
    }
    return groups;
  }, [devices]);

  return (
    <div className={styles.list}>
      {Array.from(grouped.entries()).map(([type, entries]) => {
        if (entries.length === 0) return null;
        return (
          <section
            key={type}
            className={styles.group}
            data-testid="device-group"
          >
            <h3 className={styles.groupTitle} data-testid="device-group-title">
              {deviceTypeLabel(type)}
            </h3>
            {entries.map((device) => (
              <EmulatorListItem
                key={device.id}
                device={device}
                onConnect={onConnect}
                onStart={onStart}
                onStop={onStop}
              />
            ))}
          </section>
        );
      })}
    </div>
  );
}

function firstStreamableDevice(devices: DeviceInfo[]): DeviceInfo | undefined {
  for (const type of DEVICE_TYPE_ORDER) {
    const device = devices.find(
      (candidate) => candidate.type === type && hasAction(candidate, "stream"),
    );
    if (device) return device;
  }
  return devices.find((device) => hasAction(device, "stream"));
}

function StreamView({
  device,
  onBack,
}: {
  device: DeviceInfo;
  onBack: () => void;
}) {
  const {
    remoteStream,
    dataChannel,
    peerConnection,
    connectionState,
    error,
    latestProfileEvent,
    profileEventHistory,
    connect,
    disconnect,
  } = useEmulatorStream();
  const { adaptiveFps, maxFps } = useEmulatorSettings();
  const streamViewRef = useRef<HTMLDivElement>(null);
  const [immersiveKeyboardActive, setImmersiveKeyboardActive] = useState(false);
  const [immersiveKeyboardBusy, setImmersiveKeyboardBusy] = useState(false);
  const [immersiveKeyboardError, setImmersiveKeyboardError] = useState<
    string | null
  >(null);
  const keyboardDevice =
    device.type === "emulator" || device.type === "android";
  const supportsImmersiveKeyboard =
    keyboardDevice &&
    document.fullscreenEnabled &&
    typeof getNavigatorKeyboard()?.lock === "function";

  // Auto-connect when entering stream view
  useEffect(() => {
    connect({ id: device.id, type: device.type });
    return () => disconnect();
  }, [device.id, device.type, connect, disconnect]);

  useEffect(() => {
    const handleFullscreenChange = () => {
      const active = document.fullscreenElement === streamViewRef.current;
      setImmersiveKeyboardActive(active);
      if (!active) {
        getNavigatorKeyboard()?.unlock?.();
      }
    };

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
      getNavigatorKeyboard()?.unlock?.();
    };
  }, []);

  const exitImmersiveKeyboard = useCallback(async () => {
    setImmersiveKeyboardBusy(true);
    setImmersiveKeyboardError(null);
    try {
      getNavigatorKeyboard()?.unlock?.();
      if (document.fullscreenElement === streamViewRef.current) {
        await document.exitFullscreen();
      }
      setImmersiveKeyboardActive(false);
    } catch (err) {
      setImmersiveKeyboardError(
        `Failed to exit immersive keyboard: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setImmersiveKeyboardBusy(false);
    }
  }, []);

  const enterImmersiveKeyboard = useCallback(async () => {
    if (!supportsImmersiveKeyboard || !streamViewRef.current) return;

    setImmersiveKeyboardBusy(true);
    setImmersiveKeyboardError(null);
    try {
      if (document.fullscreenElement !== streamViewRef.current) {
        await streamViewRef.current.requestFullscreen();
      }
      await getNavigatorKeyboard()?.lock?.();
      setImmersiveKeyboardActive(true);
    } catch (err) {
      getNavigatorKeyboard()?.unlock?.();
      setImmersiveKeyboardActive(false);
      setImmersiveKeyboardError(
        `Immersive keyboard failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setImmersiveKeyboardBusy(false);
    }
  }, [supportsImmersiveKeyboard]);

  const handleBack = () => {
    void exitImmersiveKeyboard();
    disconnect();
    onBack();
  };

  return (
    <div className={styles.streamView} ref={streamViewRef}>
      <div className={styles.streamHeader}>
        <Button onClick={handleBack}>Back</Button>
        <span
          className={styles.connectionState}
          data-testid="device-connection-state"
        >
          {deviceLabel(device)} - {connectionState}
        </span>
        <div className={styles.streamHeaderActions}>
          {supportsImmersiveKeyboard && (
            <Button
              onClick={() => {
                if (immersiveKeyboardActive) {
                  void exitImmersiveKeyboard();
                } else {
                  void enterImmersiveKeyboard();
                }
              }}
              disabled={immersiveKeyboardBusy}
              title="Request fullscreen and keyboard lock"
            >
              {immersiveKeyboardBusy
                ? "Working..."
                : immersiveKeyboardActive
                  ? "Exit Immersive Keyboard"
                  : "Immersive Keyboard"}
            </Button>
          )}
        </div>
      </div>

      {supportsImmersiveKeyboard && (
        <div className={styles.keyboardState}>
          Keyboard mode:{" "}
          {immersiveKeyboardActive ? "immersive (fullscreen)" : "standard"}
        </div>
      )}

      {immersiveKeyboardError && (
        <div className={styles.error}>{immersiveKeyboardError}</div>
      )}

      {latestProfileEvent && (
        <div className={styles.profileState}>
          Profile {latestProfileEvent.direction}: tier {latestProfileEvent.tier}
          /{latestProfileEvent.totalTiers} ({latestProfileEvent.width}x
          {latestProfileEvent.height}@{latestProfileEvent.fps}fps,{" "}
          {Math.round(latestProfileEvent.bitrate / 1000)} kbps)
        </div>
      )}

      {profileEventHistory.length > 0 && (
        <div className={styles.profileTimeline} data-testid="profile-timeline">
          {profileEventHistory.map((event, idx) => (
            <div
              key={`${event.receivedAt}-${event.direction}-${event.tier}-${idx}`}
              className={`${styles.profileTimelineItem} ${idx === 0 ? styles.latest : ""}`}
            >
              <span className={styles.profileTimelineTime}>
                {new Date(event.receivedAt).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit",
                })}
              </span>
              <span className={styles.profileTimelineDetail}>
                {event.direction} tier {event.tier}/{event.totalTiers} (
                {event.width}x{event.height}@{event.fps})
              </span>
            </div>
          ))}
        </div>
      )}

      {error && <div className={styles.error}>{error}</div>}

      {connectionState === "connecting" && (
        <div className={styles.connecting}>Connecting...</div>
      )}

      <div className={styles.streamContainer}>
        <EmulatorStream
          stream={remoteStream}
          dataChannel={dataChannel}
          deviceType={device.type}
          peerConnection={peerConnection}
          adaptiveFps={adaptiveFps}
          configuredFps={maxFps}
        />
      </div>

      <EmulatorNavButtons dataChannel={dataChannel} deviceType={device.type} />
    </div>
  );
}

export function BridgeRuntimePrompt({
  mode,
  installedVersion,
  latestVersion,
  onDownloaded,
}: {
  mode: "download" | "update";
  installedVersion?: string | null;
  latestVersion?: string | null;
  onDownloaded: () => void;
}) {
  const { t } = useI18n();
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleDownload = async () => {
    setDownloading(true);
    setError(null);
    try {
      const result = await api.downloadDeviceBridge();
      if (result.ok) {
        onDownloaded();
      } else {
        setError(result.error ?? "Download failed");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className={styles.downloadPrompt}>
      <p>
        {mode === "update" ? (
          <>
            {t("emulatorBridgeUpdateRequired")}
            {installedVersion && latestVersion
              ? ` Installed: v${installedVersion}. Latest: v${latestVersion}.`
              : null}
          </>
        ) : (
          t("emulatorBridgeDownloadRequired")
        )}
      </p>
      {error && <div className={styles.error}>{error}</div>}
      <Button variant="primary" onClick={handleDownload} disabled={downloading}>
        {downloading
          ? mode === "update"
            ? "Updating..."
            : "Downloading..."
          : mode === "update"
            ? "Update Bridge"
            : "Download Bridge"}
      </Button>
    </div>
  );
}

export function EmulatorPage() {
  const { t } = useI18n();
  const { isWideScreen } = useNavigationLayout();
  const { version: versionInfo, refetch: refetchVersion } = useVersion();
  const bridgeRuntimeMode =
    versionInfo?.deviceBridgeState === "update-available"
      ? "update"
      : serverHasCapability(versionInfo, DEVICE_BRIDGE_DOWNLOAD_CAPABILITY) &&
          !serverHasCapability(versionInfo, DEVICE_BRIDGE_CAPABILITY)
        ? "download"
        : null;
  const needsDownload = bridgeRuntimeMode !== null;

  const { emulators, loading, error, startEmulator, stopEmulator } =
    useEmulators({ enabled: !needsDownload });
  const [activeDevice, setActiveDevice] = useState<DeviceInfo | null>(null);

  // ?auto — auto-connect to the first streamable running device in UI order.
  useEffect(() => {
    if (activeDevice || loading || needsDownload) return;
    const params = new URLSearchParams(window.location.search);
    if (!params.has("auto")) return;
    const streamable = firstStreamableDevice(emulators);
    if (streamable) setActiveDevice(streamable);
  }, [emulators, loading, activeDevice, needsDownload]);

  if (activeDevice) {
    return (
      <MainContent isWideScreen={isWideScreen}>
        <StreamView
          device={activeDevice}
          onBack={() => setActiveDevice(null)}
        />
      </MainContent>
    );
  }

  return (
    <MainContent isWideScreen={isWideScreen}>
      <PageHeader title="Devices" />
      <main className="page-scroll-container">
        <div className="page-content-inner">
          {bridgeRuntimeMode ? (
            <BridgeRuntimePrompt
              mode={bridgeRuntimeMode}
              installedVersion={versionInfo?.deviceBridgeVersion}
              latestVersion={versionInfo?.latestDeviceBridgeVersion}
              onDownloaded={refetchVersion}
            />
          ) : (
            <>
              {loading && <div className={styles.loading}>Loading...</div>}
              {error && <div className={styles.error}>{error}</div>}
              {!loading && emulators.length === 0 && (
                <div className={styles.empty}>{t("emulatorPageNoDevices")}</div>
              )}
              {emulators.length > 0 && (
                <DeviceList
                  devices={emulators}
                  onConnect={setActiveDevice}
                  onStart={startEmulator}
                  onStop={stopEmulator}
                />
              )}
            </>
          )}
        </div>
      </main>
    </MainContent>
  );
}
