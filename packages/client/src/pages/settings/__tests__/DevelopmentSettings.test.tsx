// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetDeveloperModeForTest,
  getRelayDebugEnabled,
} from "../../../hooks/useDeveloperMode";
import { saveHost } from "../../../lib/hostStorage";
import { UI_KEYS } from "../../../lib/storageKeys";
import { DevelopmentSettings } from "../DevelopmentSettings";
import { SettingsSearchScopeProvider } from "../SettingsSearchContext";

let isManualReloadMode = true;
let interruptibleSessionCount = 0;
let queuedSessionMessageCount = 0;
const { remoteConnectionState } = vi.hoisted(() => ({
  remoteConnectionState: {
    value: null as null | {
      connection: object | null;
      currentHostId: string | null;
      currentRelayUsername: string | null;
    },
  },
}));

vi.mock("../../../contexts/RemoteConnectionContext", () => ({
  useOptionalRemoteConnection: () => remoteConnectionState.value,
}));

vi.mock("../../../contexts/SchemaValidationContext", () => ({
  useSchemaValidationContext: () => ({
    ignoredTools: [],
    clearIgnoredTools: vi.fn(),
  }),
}));

vi.mock("../../../hooks/useReloadNotifications", () => ({
  useReloadNotifications: () => ({
    isManualReloadMode,
    pendingReloads: { backend: false },
    connected: true,
    reloadBackend: vi.fn(),
    unsafeToRestart:
      interruptibleSessionCount > 0 || queuedSessionMessageCount > 0,
    interruptibleSessionCount,
    queuedSessionMessageCount,
  }),
}));

vi.mock("../../../hooks/useSchemaValidation", () => ({
  useSchemaValidation: () => ({
    settings: { enabled: false },
    setEnabled: vi.fn(),
  }),
}));

vi.mock("../../../hooks/useServerSettings", () => ({
  useServerSettings: () => ({
    settings: { serviceWorkerEnabled: true },
    updateSetting: vi.fn(),
  }),
}));

vi.mock("../../../i18n", () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string | number>) =>
      (
        ({
          developmentSectionTitle: "Development",
          developmentSchemaTitle: "Schema Validation",
          developmentSchemaDescription: "Validate tool results",
          developmentRelayMonitorTitle: "Relay Monitor",
          developmentRelayMonitorDescription: "Open relay telemetry",
          developmentRelayMonitorOpen: "Open Relay Monitor",
          developmentRelayDebugTitle: "Relay Debug Logging",
          developmentRelayDebugDescription: "Capture relay traffic",
          developmentDiagnosticsTitle: "Browser Diagnostics",
          developmentDiagnosticsDescription: "Capture browser logs",
          developmentServiceWorkerTitle: "Service Worker",
          developmentServiceWorkerDescription: "Enable service worker",
          developmentSessionScrollMemoryTitle: "Session Scroll Memory",
          developmentSessionScrollMemoryControlTitle: "Restore mode",
          developmentSessionScrollMemoryDescription: "Debug restore mode",
          developmentSessionScrollMemoryKeywords:
            "return to tab previously read position follow mode last viewed row reopen scroll restore",
          developmentSessionScrollMemoryModeLiveTail: "Live tail (default)",
          developmentSessionScrollMemoryModeLiveTailDescription:
            "Reopen at latest output",
          developmentSessionScrollMemoryModeRememberPlace: "Remember place",
          developmentSessionScrollMemoryModeRememberPlaceDescription:
            "Reopen at furthest seen position",
          developmentSessionScrollMemoryModeManualFollow: "Manual follow",
          developmentSessionScrollMemoryModeManualFollowDescription:
            "Manual follow experiment",
          developmentSessionScrollMemoryModeNoMemory: "No memory",
          developmentSessionScrollMemoryModeNoMemoryDescription:
            "Do not retain scroll snapshots",
          developmentRestartTitle: "Restart Server",
          developmentRestartDescription: "Restart the backend server",
          developmentInterruptedWarning:
            "{count} active session{suffix}will be interrupted",
          developmentInterruptedWarningActiveAndQueued:
            "{activeCount} active session{activeSuffix} and {queuedCount} queued message{queuedSuffix} will be interrupted",
          developmentInterruptedWarningQueued:
            "{count} queued message{suffix} will be interrupted",
          developmentRestart: "Restart Server",
        }) as Record<string, string>
      )[key]?.replaceAll(/\{(\w+)\}/gu, (_match, name: string) =>
        String(params?.[name] ?? ""),
      ) ?? key,
  }),
}));

vi.mock("../SettingsPaneTitleContext", () => ({
  useSettingsPaneTitle: vi.fn(),
}));

vi.mock("../SettingsUndoContext", () => ({
  useSettingsUndoBaseline: vi.fn(),
}));

describe("DevelopmentSettings", () => {
  const renderSettings = () =>
    render(
      <MemoryRouter>
        <DevelopmentSettings />
      </MemoryRouter>,
    );

  beforeEach(() => {
    isManualReloadMode = true;
    interruptibleSessionCount = 0;
    queuedSessionMessageCount = 0;
    remoteConnectionState.value = null;
    window.localStorage.clear();
    __resetDeveloperModeForTest();
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    __resetDeveloperModeForTest();
  });

  it("shows the remaining development settings", () => {
    renderSettings();

    expect(screen.getByText("Schema Validation")).toBeTruthy();
    expect(screen.queryByText("Relay Monitor")).toBeNull();
    expect(screen.getByText("Relay Debug Logging")).toBeTruthy();
    expect(screen.getByText("Browser Diagnostics")).toBeTruthy();
    expect(screen.getByText("Service Worker")).toBeTruthy();
    expect(screen.getByText("Session Scroll Memory")).toBeTruthy();
    expect(screen.queryByText("Store-Backed Session Detail")).toBeNull();
  });

  it("keeps development settings visible when server restart is unavailable", () => {
    isManualReloadMode = false;

    renderSettings();

    expect(screen.getByText("Schema Validation")).toBeTruthy();
    expect(screen.getByText("Browser Diagnostics")).toBeTruthy();
    expect(screen.queryByText("Restart Server")).toBeNull();
  });

  it("warns about the work the restart would actually interrupt", () => {
    interruptibleSessionCount = 1;
    queuedSessionMessageCount = 2;

    renderSettings();

    expect(
      screen.getByText(
        "1 active session and 2 queued messages will be interrupted",
      ),
    ).toBeTruthy();
  });

  it("exposes the session cursor behavior debug setting", () => {
    renderSettings();

    expect(
      screen.getByText("Session Scroll Memory").closest("[data-settings-item]"),
    ).not.toBeNull();
    const select = screen.getByLabelText("Restore mode") as HTMLSelectElement;
    expect(select.value).toBe("live-tail");
    expect(Array.from(select.options, (option) => option.text)).toEqual([
      "Live tail (default)",
      "Remember place",
      "No memory",
    ]);

    fireEvent.change(select, { target: { value: "remember-place" } });

    expect(select.value).toBe("remember-place");
    expect(localStorage.getItem(UI_KEYS.sessionScrollBehavior)).toBe(
      "remember-place",
    );
    expect(screen.getByText("Reopen at furthest seen position")).toBeTruthy();
  });

  it("finds session scroll memory from remembered behavior", () => {
    render(
      <MemoryRouter>
        <SettingsSearchScopeProvider
          value={{
            query: "previously read position",
            matchValues: false,
            rowMatched: false,
            categoryLabel: "Development",
            jumpToItem: vi.fn(),
          }}
        >
          <DevelopmentSettings />
        </SettingsSearchScopeProvider>
      </MemoryRouter>,
    );

    expect(screen.getByLabelText("Restore mode")).toBeTruthy();
  });

  it("toggles relay debug logging from development settings", () => {
    renderSettings();

    const toggle = screen.getByRole("switch", {
      name: "Relay Debug Logging",
    }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect(getRelayDebugEnabled()).toBe(false);

    fireEvent.click(toggle);

    expect(toggle.checked).toBe(true);
    expect(getRelayDebugEnabled()).toBe(true);
    expect(
      JSON.parse(localStorage.getItem(UI_KEYS.developerMode) ?? "{}"),
    ).toMatchObject({
      relayDebugEnabled: true,
    });
  });

  it("links directly to the configured relay monitor", () => {
    saveHost({
      id: "relay-host",
      displayName: "Relay host",
      mode: "relay",
      relayUrl: "wss://relay.example.test/team/ws",
      relayUsername: "alice",
      srpUsername: "alice",
      createdAt: "2026-08-20T00:00:00.000Z",
    });
    remoteConnectionState.value = {
      connection: {},
      currentHostId: null,
      currentRelayUsername: "alice",
    };
    renderSettings();

    const link = screen.getByRole("link", { name: "Open Relay Monitor" });
    expect(link.getAttribute("href")).toBe(
      "https://relay.example.test/team/stats",
    );
    expect(link.getAttribute("target")).toBe("_blank");
  });
});
