// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationsSettings } from "../NotificationsSettings";

vi.mock("../../../i18n", () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("../../../components/PushNotificationToggle", () => ({
  PushNotificationToggle: () => <div>browser-subscription-control</div>,
}));

vi.mock("../SettingsPaneTitleContext", () => ({
  useSettingsPaneTitle: vi.fn(),
}));

vi.mock("../SettingsUndoContext", () => ({
  useSettingsUndoBaseline: vi.fn(),
}));

const hookState = vi.hoisted(() => ({
  subscribed: true,
  deviceType: "desktop" as "android" | "ios" | "mobile" | "desktop" | "unknown",
  currentBrowserProfileId: "profile-1",
  unsubscribe: vi.fn(),
  removeDevice: vi.fn(),
}));

vi.mock("../../../hooks/usePushNotifications", () => ({
  usePushNotifications: () => ({
    browserProfileId: hookState.currentBrowserProfileId,
    unsubscribe: hookState.unsubscribe,
  }),
}));

vi.mock("../../../hooks/useSubscribedDevices", () => ({
  useSubscribedDevices: () => ({
    devices: hookState.subscribed
      ? [
          {
            browserProfileId: "profile-1",
            createdAt: "2026-07-31T12:00:00.000Z",
            deviceName: "Work laptop",
            endpointDomain: "fcm.googleapis.com",
            deviceType: hookState.deviceType,
          },
        ]
      : [],
    isLoading: false,
    removeDevice: hookState.removeDevice,
    sendTest: vi.fn(),
  }),
}));

vi.mock("../../../hooks/useConnectedDevices", () => ({
  useConnectedDevices: () => ({
    connections: new Map([
      ["profile-1", { connectionCount: 1, deviceName: "Work laptop" }],
    ]),
    isLoading: false,
  }),
}));

vi.mock("../../../hooks/useNotificationSettings", () => ({
  useNotificationSettings: () => ({
    settings: {
      toolApproval: true,
      userQuestion: true,
      sessionHalted: false,
      projectInactive: false,
      yaInactive: false,
    },
    isLoading: false,
    updateSetting: vi.fn(),
  }),
}));

describe("NotificationsSettings", () => {
  beforeEach(() => {
    hookState.subscribed = true;
    hookState.deviceType = "desktop";
    hookState.currentBrowserProfileId = "profile-1";
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("presents one browser delivery path with event and device sections", () => {
    render(<NotificationsSettings />);

    expect(
      screen
        .getAllByRole("heading", { level: 2 })
        .map((heading) => heading.textContent),
    ).toEqual([
      "notificationsThisBrowserTitle",
      "notificationsEventsTitle",
      "notificationsDevicesTitle",
    ]);
    expect(screen.getByText("browser-subscription-control")).toBeTruthy();
    expect(screen.queryByText("notificationsDesktopTitle")).toBeNull();
    expect(screen.queryByText("notificationsPushTitle")).toBeNull();
  });

  it("keeps test-only delivery controls collapsed by default", () => {
    render(<NotificationsSettings />);

    const summary = screen.getByText("notificationsDiagnosticsTitle");
    const details = summary.closest("details");
    expect(details).not.toBeNull();
    expect(details?.open).toBe(false);
  });

  it("does not infer Android from Chrome's push service", () => {
    render(<NotificationsSettings />);

    expect(screen.getByText(/Work laptop \(Chrome\)/)).toBeTruthy();
    expect(screen.queryByText(/Android\/Chrome/)).toBeNull();
  });

  it("keeps the Android label when the device evidence is Android", () => {
    hookState.deviceType = "android";
    render(<NotificationsSettings />);

    expect(screen.getByText(/Work laptop \(Android\/Chrome\)/)).toBeTruthy();
  });

  it("removes the current device through the browser-local unsubscribe path", () => {
    render(<NotificationsSettings />);

    fireEvent.click(
      screen.getByRole("button", { name: "notificationsRemove" }),
    );

    expect(hookState.unsubscribe).toHaveBeenCalledTimes(1);
    expect(hookState.removeDevice).not.toHaveBeenCalled();
  });

  it("removes another device through the server inventory path", () => {
    hookState.currentBrowserProfileId = "profile-2";
    render(<NotificationsSettings />);

    fireEvent.click(
      screen.getByRole("button", { name: "notificationsRemove" }),
    );

    expect(hookState.removeDevice).toHaveBeenCalledWith("profile-1");
    expect(hookState.unsubscribe).not.toHaveBeenCalled();
  });

  it("gates server event controls when no browser is subscribed", () => {
    hookState.subscribed = false;
    render(<NotificationsSettings />);

    expect(screen.getAllByRole("switch")).toHaveLength(5);
    for (const toggle of screen.getAllByRole("switch")) {
      expect((toggle as HTMLInputElement).disabled).toBe(true);
    }
    expect(screen.queryByText("notificationsDiagnosticsTitle")).toBeNull();
  });
});
