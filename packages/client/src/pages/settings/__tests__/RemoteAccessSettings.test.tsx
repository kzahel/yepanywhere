// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render as renderWithoutRouter,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostAwakeStatus } from "@yep-anywhere/shared";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import type { ServerSettings } from "../../../api/client";
import { RemoteAccessSettings } from "../RemoteAccessSettings";

function render(ui: ReactElement) {
  return renderWithoutRouter(ui, { wrapper: MemoryRouter });
}

const {
  hostAwakeState,
  hostIdentityState,
  hookState,
  mockHostAwakeRefetch,
  mockUpdateSetting,
  mockUpdateSettings,
  publicShareState,
  remoteConnectionState,
} = vi.hoisted(() => ({
  hostAwakeState: {
    supported: false,
    status: null as HostAwakeStatus | null,
    error: null as Error | null,
  },
  hostIdentityState: { supported: true },
  hookState: {
    settings: {
      serviceWorkerEnabled: true,
      persistRemoteSessionsToDisk: false,
    } as ServerSettings,
    isLoading: false,
    error: null as string | null,
  },
  mockHostAwakeRefetch: vi.fn(),
  mockUpdateSetting: vi.fn(),
  mockUpdateSettings: vi.fn(),
  publicShareState: {
    managementSupported: false,
    status: null as null | { totalValidLinks: number },
  },
  remoteConnectionState: {
    value: null as null | {
      currentHostId: string | null;
      disconnect: () => void;
      storedUsername: string;
    },
  },
}));

vi.mock("react-router-dom", async () => {
  const actual =
    await vi.importActual<typeof import("react-router-dom")>(
      "react-router-dom",
    );
  return { ...actual, useNavigate: () => vi.fn() };
});

vi.mock("../../../components/RemoteAccessSetup", () => ({
  RemoteAccessSetup: () => <div>remoteAccessSetup</div>,
}));

vi.mock("../../../components/PublicShareManagerModal", () => ({
  PublicShareManagerModal: () => <div>publicShareManager</div>,
}));

vi.mock("../../../contexts/HostIdentityContext", () => ({
  useHostIdentity: () => ({
    supported: hostIdentityState.supported,
    icon: hookState.settings.hostIdentity?.icon ?? null,
  }),
}));

vi.mock("../../../contexts/RemoteConnectionContext", () => ({
  useOptionalRemoteConnection: () => remoteConnectionState.value,
}));

vi.mock("../../../hooks/usePublicShareStatus", () => ({
  usePublicShareStatus: () => ({ status: publicShareState.status }),
}));

vi.mock("../../../hooks/useHostAwakeStatus", () => ({
  useHostAwakeStatus: () => ({
    status: hostAwakeState.status,
    isLoading: false,
    error: hostAwakeState.error,
    refetch: mockHostAwakeRefetch,
  }),
}));

vi.mock("../../../hooks/useServerSettings", () => ({
  useServerSettings: () => ({
    ...hookState,
    updateSetting: mockUpdateSetting,
    updateSettings: mockUpdateSettings,
  }),
}));

vi.mock("../../../hooks/useVersion", () => ({
  useVersion: () => ({
    version: {
      capabilities: [
        ...(hostAwakeState.supported ? ["host-awake-control"] : []),
        ...(publicShareState.managementSupported
          ? ["public-share-management"]
          : []),
      ],
    },
  }),
}));

vi.mock("../../../i18n", () => ({
  useI18n: () => ({
    t: (key: string, values?: { icon?: string; reason?: string }) => {
      if (values?.icon) return `${key}:${values.icon}`;
      if (values?.reason) return `${key}:${values.reason}`;
      return key;
    },
  }),
}));

vi.mock("../SettingsPaneTitleContext", () => ({
  useSettingsPaneTitle: vi.fn(),
}));

describe("RemoteAccessSettings host identity", () => {
  beforeEach(() => {
    hostIdentityState.supported = true;
    hookState.settings = {
      serviceWorkerEnabled: true,
      persistRemoteSessionsToDisk: false,
    };
    hookState.isLoading = false;
    hookState.error = null;
    hostAwakeState.supported = false;
    hostAwakeState.status = null;
    hostAwakeState.error = null;
    publicShareState.managementSupported = false;
    publicShareState.status = null;
    remoteConnectionState.value = null;
    mockHostAwakeRefetch.mockResolvedValue(undefined);
    mockUpdateSetting.mockResolvedValue(undefined);
    mockUpdateSettings.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("offers the same settings to Remote Access clients as to direct ones", () => {
    // This link's host, relay and logout are connection info, not settings.
    const settingIds = () =>
      [...document.querySelectorAll("[data-settings-item]")]
        .map((item) => item.getAttribute("data-settings-item"))
        .filter((id) => !id?.startsWith("remote-access-session-"))
        .sort();

    const direct = render(<RemoteAccessSettings />);
    const directIds = settingIds();
    expect(screen.getByText("remoteAccessSetup")).toBeTruthy();
    direct.unmount();

    remoteConnectionState.value = {
      currentHostId: null,
      disconnect: vi.fn(),
      storedUsername: "alice",
    };
    render(<RemoteAccessSettings />);

    expect(settingIds()).toEqual(directIds);
    expect(screen.getByText("remoteAccessSetup")).toBeTruthy();
    expect(
      document.querySelector(
        '[data-settings-item="remote-access-session-logout"]',
      ),
    ).not.toBeNull();
  });

  it("persists a selected preset through server settings", async () => {
    render(<RemoteAccessSettings />);

    fireEvent.click(
      screen.getByRole("radio", { name: "hostIdentityUsePreset:❤️" }),
    );

    await waitFor(() =>
      expect(mockUpdateSetting).toHaveBeenCalledWith("hostIdentity", {
        icon: "❤️",
      }),
    );
  });

  it("validates and saves a custom marker", async () => {
    render(<RemoteAccessSettings />);
    const input = screen.getByRole("textbox", {
      name: "hostIdentityCustomLabel",
    });

    fireEvent.change(input, { target: { value: "two" } });
    const error = screen.getByText("hostIdentityInvalid");
    // A field's error is described by the input, not announced per keystroke.
    expect(input.getAttribute("aria-describedby")).toBe(
      error.closest("[id]")?.id,
    );
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.blur(input);
    expect(mockUpdateSetting).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "🧡" } });
    fireEvent.blur(input);

    await waitFor(() =>
      expect(mockUpdateSetting).toHaveBeenCalledWith("hostIdentity", {
        icon: "🧡",
      }),
    );
    expect(
      screen.queryByRole("button", { name: "hostIdentitySave" }),
    ).toBeNull();
  });

  it("clears the server-owned marker", async () => {
    hookState.settings = {
      ...hookState.settings,
      hostIdentity: { icon: "💻" },
    };
    render(<RemoteAccessSettings />);

    fireEvent.click(screen.getByRole("button", { name: "hostIdentityClear" }));

    await waitFor(() =>
      expect(mockUpdateSetting).toHaveBeenCalledWith("hostIdentity", undefined),
    );
  });

  it("enables host-awake through server settings and refreshes status", async () => {
    hostAwakeState.supported = true;
    hostAwakeState.status = {
      requestedMode: "off",
      state: "disabled",
      platform: "win32",
      support: {
        idleSleepPrevention: true,
        batteryFloor: true,
        closedLidOnExternalPower: false,
      },
      hasInternalBattery: false,
      powerSource: "external",
      powerObservedAt: 123,
      batteryFloorPercent: 10,
    };
    render(<RemoteAccessSettings />);
    const item = screen
      .getByText("hostAwakeTitle")
      .closest("[data-settings-item]");
    expect(item).not.toBeNull();

    fireEvent.click(within(item as HTMLElement).getByRole("switch"));

    await waitFor(() =>
      expect(mockUpdateSettings).toHaveBeenCalledWith({
        hostAwakeMode: "idle",
      }),
    );
    expect(mockHostAwakeRefetch).toHaveBeenCalledWith(true);
  });

  it("offers manual status refresh only while host-awake is disabled", () => {
    hostAwakeState.supported = true;
    hostAwakeState.status = {
      requestedMode: "off",
      state: "disabled",
      platform: "darwin",
      support: {
        idleSleepPrevention: true,
        batteryFloor: true,
        closedLidOnExternalPower: false,
      },
      hasInternalBattery: true,
      powerSource: "battery",
      batteryPercent: 75,
      powerObservedAt: 123,
      batteryFloorPercent: 10,
    };
    const view = render(<RemoteAccessSettings />);

    expect(
      screen.getByRole("button", { name: "hostAwakeRefresh" }),
    ).toBeDefined();

    hookState.settings = {
      ...hookState.settings,
      hostAwakeMode: "idle",
    };
    view.rerender(<RemoteAccessSettings />);

    expect(
      screen.queryByRole("button", { name: "hostAwakeRefresh" }),
    ).toBeNull();
  });

  it("shows the bounded backend reason when host-awake is unsupported", () => {
    hostAwakeState.supported = true;
    hostAwakeState.status = {
      requestedMode: "off",
      state: "unsupported",
      platform: "win32",
      support: {
        idleSleepPrevention: false,
        batteryFloor: false,
        closedLidOnExternalPower: false,
      },
      hasInternalBattery: "unknown",
      powerSource: "unknown",
      powerObservedAt: 123,
      batteryFloorPercent: 10,
      reason: "Windows application policy blocked the required power APIs",
    };

    render(<RemoteAccessSettings />);

    expect(
      screen.getByText(
        "hostAwakeStatusUnavailableReason:Windows application policy blocked the required power APIs",
      ),
    ).toBeTruthy();
  });

  it("shows and saves the battery floor only for a detected battery", async () => {
    hostAwakeState.supported = true;
    hostAwakeState.status = {
      requestedMode: "idle",
      state: "active",
      platform: "darwin",
      support: {
        idleSleepPrevention: true,
        batteryFloor: true,
        closedLidOnExternalPower: false,
      },
      hasInternalBattery: true,
      powerSource: "battery",
      batteryPercent: 75,
      powerObservedAt: 123,
      batteryFloorPercent: 10,
    };
    hookState.settings = {
      ...hookState.settings,
      hostAwakeMode: "idle",
      hostAwakeBatteryFloorPercent: 10,
    };
    render(<RemoteAccessSettings />);

    const input = screen.getByRole("spinbutton", {
      name: "hostAwakeBatteryFloorInput",
    });
    fireEvent.change(input, { target: { value: "15" } });
    fireEvent.click(
      screen.getByRole("button", { name: "hostAwakeBatteryFloorSave" }),
    );

    await waitFor(() =>
      expect(mockUpdateSettings).toHaveBeenCalledWith({
        hostAwakeBatteryFloorPercent: 15,
      }),
    );
  });

  it("gates the public-share manager on the server capability", () => {
    const view = render(<RemoteAccessSettings />);
    expect(
      screen.queryByRole("button", { name: "advancedPublicShareManageButton" }),
    ).toBeNull();

    publicShareState.managementSupported = true;
    view.rerender(<RemoteAccessSettings />);
    fireEvent.click(
      screen.getByRole("button", { name: "advancedPublicShareManageButton" }),
    );
    expect(screen.getByText("publicShareManager")).toBeTruthy();

    publicShareState.managementSupported = false;
    view.rerender(<RemoteAccessSettings />);
    expect(screen.queryByText("publicShareManager")).toBeNull();

    publicShareState.managementSupported = true;
    view.rerender(<RemoteAccessSettings />);
    expect(screen.queryByText("publicShareManager")).toBeNull();
  });

  it("confirms destructive disable with the valid-link count", async () => {
    publicShareState.managementSupported = true;
    publicShareState.status = { totalValidLinks: 3 };
    hookState.settings = {
      ...hookState.settings,
      publicSharesEnabled: true,
    };
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<RemoteAccessSettings />);

    fireEvent.click(
      screen.getByRole("switch", { name: "advancedPublicShareTitle" }),
    );

    expect(confirm).toHaveBeenCalledWith("advancedPublicShareDisableConfirm");
    expect(mockUpdateSetting).not.toHaveBeenCalledWith(
      "publicSharesEnabled",
      false,
    );
  });
});
