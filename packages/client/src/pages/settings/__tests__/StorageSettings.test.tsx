// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerSettings } from "../../../api/client";
import { StorageSettings } from "../StorageSettings";

const { state, updateSettings } = vi.hoisted(() => ({
  state: {
    settings: {
      serviceWorkerEnabled: true,
      persistRemoteSessionsToDisk: false,
      projectDirectoryStorage: "app-data",
      toolResultMediaPreservation: "on-demand",
    } as ServerSettings,
  },
  updateSettings: vi.fn(),
}));

vi.mock("../../../hooks/useServerSettings", () => ({
  useServerSettings: () => ({
    settings: state.settings,
    isLoading: false,
    error: null,
    updateSettings,
  }),
}));

vi.mock("../../../i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock("../SettingsPaneTitleContext", () => ({
  useSettingsPaneTitle: vi.fn(),
}));

vi.mock("../SettingsUndoContext", () => ({
  useSettingsUndoBaseline: vi.fn(),
}));

describe("StorageSettings", () => {
  beforeEach(() => {
    state.settings = {
      serviceWorkerEnabled: true,
      persistRemoteSessionsToDisk: false,
      projectDirectoryStorage: "app-data",
      toolResultMediaPreservation: "on-demand",
    };
    updateSettings.mockReset();
    updateSettings.mockResolvedValue(undefined);
  });

  afterEach(cleanup);

  it("shows the non-project, on-demand defaults and saves explicit opt-ins", () => {
    render(<StorageSettings />);

    const appDataChoice = screen.getByRole("radio", {
      name: "projectDataLocationAppData",
    });
    const onDemandChoice = screen.getByRole("radio", {
      name: "toolResultImagesOnDemand",
    });
    expect(appDataChoice.getAttribute("aria-checked")).toBe("true");
    expect(onDemandChoice.getAttribute("aria-checked")).toBe("true");
    expect(appDataChoice.textContent).toContain(
      "projectDataLocationAppDataDescription",
    );
    expect(onDemandChoice.textContent).toContain(
      "toolResultImagesOnDemandDescription",
    );

    fireEvent.click(
      screen.getByRole("radio", { name: "projectDataLocationProject" }),
    );
    fireEvent.click(
      screen.getByRole("radio", { name: "toolResultImagesPreserve" }),
    );

    expect(updateSettings).toHaveBeenNthCalledWith(1, {
      projectDirectoryStorage: "project",
    });
    expect(updateSettings).toHaveBeenNthCalledWith(2, {
      toolResultMediaPreservation: "preserve",
    });
  });
});
