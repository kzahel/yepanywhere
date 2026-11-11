// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PROJECT_QUEUE_QUIET_SECONDS,
  DEFAULT_STEER_NOW_ENABLED,
  PROJECT_QUEUE_CAPABILITY,
} from "@yep-anywhere/shared";
import type { ServerSettings } from "../../../api/client";
import { invalidateLocalStorageValues } from "../../../lib/localStorageValue";
import { UI_KEYS } from "../../../lib/storageKeys";
import { MessageDeliverySettings } from "../MessageDeliverySettings";
import {
  SettingsUndoProvider,
  type SettingsUndoRegistration,
} from "../SettingsUndoContext";

const { mockUpdateSettings, hookState, versionState } = vi.hoisted(() => ({
  mockUpdateSettings: vi.fn(),
  hookState: {
    settings: null as ServerSettings | null,
    isLoading: false,
    error: null as string | null,
  },
  versionState: {
    version: { capabilities: [] as string[] } as {
      capabilities?: string[];
    },
  },
}));

vi.mock("../../../hooks/useServerSettings", () => ({
  useServerSettings: () => ({
    ...hookState,
    updateSetting: vi.fn(),
    updateSettings: mockUpdateSettings,
    refetch: vi.fn(),
  }),
}));

vi.mock("../../../hooks/useVersion", () => ({
  useVersion: () => ({ version: versionState.version }),
  useRetainedVersionInfo: () => versionState.version,
}));

vi.mock("../../../i18n", () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}));

const baseSettings: ServerSettings = {
  serviceWorkerEnabled: true,
  persistRemoteSessionsToDisk: false,
  deferredJoinWindowSeconds: 0,
  composeAnchorsEnabled: false,
};

describe("MessageDeliverySettings", () => {
  beforeEach(() => {
    hookState.settings = { ...baseSettings };
    hookState.isLoading = false;
    hookState.error = null;
    versionState.version = { capabilities: [PROJECT_QUEUE_CAPABILITY] };
    mockUpdateSettings.mockReset();
    mockUpdateSettings.mockResolvedValue(undefined);
    window.localStorage.clear();
    invalidateLocalStorageValues(UI_KEYS.keepMobileKeyboardOpenAfterDelivery);
    invalidateLocalStorageValues(UI_KEYS.backgroundSessionCreation);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("applies the anchors toggle immediately, with no Save button", () => {
    render(<MessageDeliverySettings />);

    expect(screen.queryByText("providersSave")).toBeNull();

    fireEvent.click(
      screen.getByLabelText("messageDeliveryComposeAnchorsTitle"),
    );
    expect(mockUpdateSettings).toHaveBeenCalledWith({
      composeAnchorsEnabled: true,
    });
  });

  it("keeps mobile keyboard retention browser-local and default-off", () => {
    render(<MessageDeliverySettings />);

    const toggle = screen.getByLabelText<HTMLInputElement>(
      "messageDeliveryKeepMobileKeyboardOpenTitle",
    );
    expect(toggle.checked).toBe(false);

    fireEvent.click(toggle);

    expect(toggle.checked).toBe(true);
    expect(
      window.localStorage.getItem(UI_KEYS.keepMobileKeyboardOpenAfterDelivery),
    ).toBe("true");
    expect(mockUpdateSettings).not.toHaveBeenCalled();
  });

  it("debounce-saves the join window from the numeric input", () => {
    vi.useFakeTimers();
    render(<MessageDeliverySettings />);

    fireEvent.change(
      screen.getByRole("spinbutton", {
        name: "messageDeliveryJoinWindowTitle",
      }),
      {
        target: { value: "30" },
      },
    );
    expect(mockUpdateSettings).not.toHaveBeenCalled();

    vi.advanceTimersByTime(500);
    expect(mockUpdateSettings).toHaveBeenCalledWith({
      deferredJoinWindowSeconds: 30,
    });
  });

  it("debounce-saves the Project Queue quiet window from the numeric input", () => {
    vi.useFakeTimers();
    render(<MessageDeliverySettings />);

    fireEvent.change(
      screen.getByRole("spinbutton", {
        name: "messageDeliveryProjectQueueQuietTitle",
      }),
      {
        target: { value: "60" },
      },
    );
    expect(mockUpdateSettings).not.toHaveBeenCalled();

    vi.advanceTimersByTime(500);
    expect(mockUpdateSettings).toHaveBeenCalledWith({
      projectQueueQuietSeconds: 60,
    });
  });

  it("does not save the join-window slider until release", () => {
    vi.useFakeTimers();
    render(<MessageDeliverySettings />);

    const slider = screen.getByRole<HTMLInputElement>("slider", {
      name: "messageDeliveryJoinWindowTitle",
    });
    fireEvent.change(slider, { target: { value: "45" } });

    vi.advanceTimersByTime(500);
    expect(mockUpdateSettings).not.toHaveBeenCalled();

    fireEvent.pointerUp(slider);
    vi.advanceTimersByTime(500);

    expect(mockUpdateSettings).toHaveBeenCalledWith({
      deferredJoinWindowSeconds: 45,
    });
  });

  it("saves the busy-composer default action immediately", () => {
    render(<MessageDeliverySettings />);

    fireEvent.change(
      screen.getByLabelText("appearanceToolbarDefaultActionTitle"),
      { target: { value: "queue" } },
    );

    expect(mockUpdateSettings).toHaveBeenCalledWith({
      clientDefaults: { busyComposerDefaultAction: "queue" },
    });
  });

  it("defaults urgent steering on when no preference is stored", () => {
    render(<MessageDeliverySettings />);

    expect(
      screen.getByLabelText<HTMLInputElement>(
        "messageDeliverySteerNowDefaultTitle",
      ).checked,
    ).toBe(DEFAULT_STEER_NOW_ENABLED);
  });

  it("saves the Project Queue Ctrl+Enter preference immediately", () => {
    render(<MessageDeliverySettings />);

    fireEvent.click(
      screen.getByLabelText("messageDeliveryProjectQueueShortcutTitle"),
    );

    expect(mockUpdateSettings).toHaveBeenCalledWith({
      clientDefaults: { projectQueueCtrlEnterEnabled: false },
    });
  });

  it("keeps bang history default-off while execution is baseline", () => {
    render(<MessageDeliverySettings />);

    const toggle = screen.getByLabelText("messageDeliveryBangCommandsTitle");
    expect((toggle as HTMLInputElement).checked).toBe(false);
    fireEvent.click(toggle);
    expect(mockUpdateSettings).toHaveBeenCalledWith({
      clientDefaults: { bangCommandsEnabled: true },
    });
  });

  it("hides the readiness setting on older Project Queue servers", () => {
    render(<MessageDeliverySettings />);
    expect(
      screen.queryByLabelText("projectQueueReadinessSettingTitle"),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "projectQueueReadinessSave" }),
    ).toBeNull();
  });

  it("includes the saved readiness command in header Undo on capable servers", async () => {
    versionState.version = {
      capabilities: [PROJECT_QUEUE_CAPABILITY, "project-queue-readiness-check"],
    };
    const holder: { registration: SettingsUndoRegistration | null } = {
      registration: null,
    };
    const pane = () => (
      <SettingsUndoProvider
        value={(next) => {
          holder.registration = next;
        }}
      >
        <MessageDeliverySettings />
      </SettingsUndoProvider>
    );
    const view = render(pane());
    expect(holder.registration).toBeNull();
    hookState.settings = {
      ...baseSettings,
      projectQueueReadinessCheck: {
        executable: "/tools/agentctl",
        args: ["others", "--text"],
      },
    };
    view.rerender(pane());
    await waitFor(() => expect(holder.registration?.canUndo).toBe(true));
    await act(async () => {
      await holder.registration?.undo();
    });
    expect(mockUpdateSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({
        projectQueueReadinessCheck: null,
      }),
    );
  });

  it("saves the external readiness executable explicitly on capable servers", async () => {
    versionState.version = {
      capabilities: [PROJECT_QUEUE_CAPABILITY, "project-queue-readiness-check"],
    };
    render(<MessageDeliverySettings />);
    fireEvent.click(screen.getByLabelText("projectQueueReadinessSettingTitle"));
    fireEvent.change(screen.getByLabelText("projectQueueReadinessExecutable"), {
      target: { value: "/tools/agentctl" },
    });
    fireEvent.change(screen.getByLabelText("projectQueueReadinessArguments"), {
      target: { value: "others\n--text" },
    });
    expect(mockUpdateSettings).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "projectQueueReadinessSave" }),
    );
    await waitFor(() =>
      expect(mockUpdateSettings).toHaveBeenCalledWith({
        projectQueueReadinessCheck: {
          executable: "/tools/agentctl",
          args: ["others", "--text"],
        },
      }),
    );
  });

  it("registers a header undo that reverts to the open-time snapshot", async () => {
    const holder: { registration: SettingsUndoRegistration | null } = {
      registration: null,
    };
    hookState.settings = {
      ...baseSettings,
      deferredJoinWindowSeconds: 20,
      composeAnchorsEnabled: true,
    };

    render(
      <SettingsUndoProvider
        value={(next) => {
          holder.registration = next;
        }}
      >
        <MessageDeliverySettings />
      </SettingsUndoProvider>,
    );

    // Untouched pane registers no undo.
    expect(holder.registration).toBeNull();
    const background = screen.getByLabelText(
      "sessionCreationBackgroundSettingTitle",
    );
    expect((background as HTMLInputElement).checked).toBe(false);
    fireEvent.click(background);
    expect(localStorage.getItem(UI_KEYS.backgroundSessionCreation)).toBe(
      "true",
    );

    fireEvent.click(
      screen.getByLabelText("messageDeliveryComposeAnchorsTitle"),
    );
    await waitFor(() => expect(holder.registration?.canUndo).toBe(true));

    // The undo callback sets component state; invoke it inside act.
    await act(async () => {
      await holder.registration?.undo();
    });
    expect((background as HTMLInputElement).checked).toBe(false);
    expect(localStorage.getItem(UI_KEYS.backgroundSessionCreation)).toBe(
      "false",
    );
    expect(mockUpdateSettings).toHaveBeenLastCalledWith({
      deferredJoinWindowSeconds: 20,
      projectQueueQuietSeconds: DEFAULT_PROJECT_QUEUE_QUIET_SECONDS,
      composeAnchorsEnabled: true,
      turnTimestamps: "off",
      clientDefaults: {
        bangCommandsEnabled: false,
        busyComposerDefaultAction: "steer",
        steerNowDefault: DEFAULT_STEER_NOW_ENABLED,
        patientQueueDefault: false,
        projectQueueCtrlEnterEnabled: true,
      },
    });
  });
});
