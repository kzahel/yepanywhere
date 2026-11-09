// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invalidateLocalStorageValues } from "../../../lib/localStorageValue";
import { UI_KEYS } from "../../../lib/storageKeys";
import { PerformanceSettings } from "../PerformanceSettings";

vi.mock("../../../i18n", () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("../SettingsPaneTitleContext", () => ({
  useSettingsPaneTitle: vi.fn(),
}));

const undoMocks = vi.hoisted(() => ({
  useSettingsUndoBaseline: vi.fn(),
}));

vi.mock("../SettingsUndoContext", () => undoMocks);

const serverMocks = vi.hoisted(() => ({
  settings: { hostProcessObservabilityEnabled: true },
  updateSetting: vi.fn(async () => undefined),
}));

vi.mock("../../../hooks/useVersion", () => ({
  useVersion: () => ({
    version: { capabilities: ["host-agent-process-observability"] },
  }),
}));

vi.mock("../../../hooks/useServerSettings", () => ({
  useServerSettings: () => ({
    settings: serverMocks.settings,
    isLoading: false,
    updateSetting: serverMocks.updateSetting,
  }),
}));

describe("PerformanceSettings", () => {
  beforeEach(() => {
    window.localStorage.clear();
    invalidateLocalStorageValues();
    undoMocks.useSettingsUndoBaseline.mockClear();
    serverMocks.settings.hostProcessObservabilityEnabled = true;
    serverMocks.updateSetting.mockClear();
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("defaults active-window trimming on and persists an explicit opt-out", () => {
    render(<PerformanceSettings />);

    const toggle = screen.getByRole("switch", {
      name: "performanceActiveWindowTrimTitle",
    }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);

    fireEvent.click(toggle);

    expect(toggle.checked).toBe(false);
    expect(window.localStorage.getItem(UI_KEYS.sessionActiveWindowTrim)).toBe(
      "false",
    );
  });

  it("persists bounded and unlimited initial history values", () => {
    render(<PerformanceSettings />);

    const slider = screen.getByRole<HTMLInputElement>("slider", {
      name: "performanceInitialHistoryTitle",
    });
    expect(slider.value).toBe("1");

    fireEvent.change(slider, { target: { value: "11" } });
    fireEvent.pointerUp(slider);
    expect(
      window.localStorage.getItem(UI_KEYS.sessionInitialHistoryCompactions),
    ).toBe("12");

    fireEvent.change(slider, { target: { value: "20" } });
    fireEvent.pointerUp(slider);
    expect(
      window.localStorage.getItem(UI_KEYS.sessionInitialHistoryCompactions),
    ).toBe("unlimited");
  });

  it("explains and persists the reverse-search page limit", () => {
    render(<PerformanceSettings />);

    const input = screen.getByRole<HTMLInputElement>("spinbutton", {
      name: "performanceReverseSearchPageLimitTitle",
    });
    expect(input.value).toBe("100");
    expect(
      screen.getByText("performanceReverseSearchPageLimitDescription"),
    ).toBeTruthy();
    expect(
      input
        .closest("[data-settings-item]")
        ?.getAttribute("data-description-layout"),
    ).toBe("full-width-on-narrow");

    fireEvent.change(input, { target: { value: "12" } });
    fireEvent.blur(input);

    expect(
      window.localStorage.getItem(
        UI_KEYS.sessionReverseSearchMaxPagesPerAttempt,
      ),
    ).toBe("12");
  });

  it("includes initial history in the pane undo baseline", () => {
    render(<PerformanceSettings />);
    const initialCall = undoMocks.useSettingsUndoBaseline.mock.calls[0];
    const initialState = initialCall?.[0];
    expect(initialState?.sessionInitialHistoryCompactions).toBe(2);

    const slider = screen.getByRole<HTMLInputElement>("slider", {
      name: "performanceInitialHistoryTitle",
    });
    fireEvent.change(slider, { target: { value: "20" } });
    fireEvent.pointerUp(slider);
    expect(
      window.localStorage.getItem(UI_KEYS.sessionInitialHistoryCompactions),
    ).toBe("unlimited");

    const latestCall = undoMocks.useSettingsUndoBaseline.mock.calls.at(-1);
    const restore = latestCall?.[1];
    act(() => {
      restore?.(initialState);
    });

    expect(
      window.localStorage.getItem(UI_KEYS.sessionInitialHistoryCompactions),
    ).toBe("2");
    expect(slider.value).toBe("1");
  });

  it("includes active-window trimming in the pane undo baseline", () => {
    render(<PerformanceSettings />);
    const initialCall = undoMocks.useSettingsUndoBaseline.mock.calls[0];
    const initialState = initialCall?.[0];
    expect(initialState?.sessionActiveWindowTrimEnabled).toBe(true);

    fireEvent.click(
      screen.getByRole("switch", {
        name: "performanceActiveWindowTrimTitle",
      }),
    );
    expect(window.localStorage.getItem(UI_KEYS.sessionActiveWindowTrim)).toBe(
      "false",
    );

    const latestCall = undoMocks.useSettingsUndoBaseline.mock.calls.at(-1);
    const restore = latestCall?.[1];
    act(() => {
      restore?.(initialState);
    });

    expect(window.localStorage.getItem(UI_KEYS.sessionActiveWindowTrim)).toBe(
      "true",
    );
    expect(
      (
        screen.getByRole("switch", {
          name: "performanceActiveWindowTrimTitle",
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
  });

  it("defaults host process metrics on and persists an opt-out", async () => {
    render(<PerformanceSettings />);

    const toggle = screen.getByRole("switch", {
      name: "performanceHostProcessObservabilityTitle",
    }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);

    await act(async () => {
      fireEvent.click(toggle);
    });

    expect(serverMocks.updateSetting).toHaveBeenCalledWith(
      "hostProcessObservabilityEnabled",
      false,
    );
  });
});
