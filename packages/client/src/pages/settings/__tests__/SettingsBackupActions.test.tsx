// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BROWSER_SETTINGS_BACKUP_VERSION } from "@yep-anywhere/shared";
import { I18nProvider } from "../../../i18n";
import { BROWSER_LOCAL_KEYS, UI_KEYS } from "../../../lib/storageKeys";
import { SettingsBackupActions } from "../SettingsBackupActions";

const { getBrowserSettingsBackup, saveBrowserSettingsBackup } = vi.hoisted(
  () => ({
    getBrowserSettingsBackup: vi.fn(),
    saveBrowserSettingsBackup: vi.fn(),
  }),
);

vi.mock("../../../api/client", () => ({
  api: {
    getBrowserSettingsBackup,
    saveBrowserSettingsBackup,
  },
}));

function renderActions() {
  return render(
    <I18nProvider>
      <SettingsBackupActions />
    </I18nProvider>,
  );
}

describe("SettingsBackupActions", () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
    vi.clearAllMocks();
  });

  it("shows the empty server slot with Restore disabled", async () => {
    getBrowserSettingsBackup.mockResolvedValue({ backup: null });

    renderActions();

    expect(
      await screen.findByText("The server settings slot is empty"),
    ).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: "Save from this browser",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
    expect(
      (
        screen.getByRole("button", {
          name: "Apply to this browser",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("saves only portable browser preferences", async () => {
    getBrowserSettingsBackup.mockResolvedValue({ backup: null });
    const savedAt = "2026-07-19T12:00:00.000Z";
    saveBrowserSettingsBackup.mockResolvedValue({
      backup: {
        version: BROWSER_SETTINGS_BACKUP_VERSION,
        savedAt,
        values: { [UI_KEYS.theme]: "verydark" },
      },
    });
    localStorage.setItem(UI_KEYS.theme, "verydark");
    localStorage.setItem(BROWSER_LOCAL_KEYS.xaiSttApiKey, "secret");
    renderActions();
    await screen.findByText("The server settings slot is empty");

    fireEvent.click(
      screen.getByRole("button", { name: "Save from this browser" }),
    );

    await waitFor(() =>
      expect(saveBrowserSettingsBackup).toHaveBeenCalledWith({
        version: BROWSER_SETTINGS_BACKUP_VERSION,
        values: {
          [UI_KEYS.locale]: "en",
          [UI_KEYS.theme]: "verydark",
        },
      }),
    );
    expect(
      await screen.findByText(/Settings saved to the server slot /),
    ).toBeTruthy();
  });

  it("announces a retry's result in the status region mounted before it", async () => {
    getBrowserSettingsBackup.mockResolvedValue({ backup: null });
    saveBrowserSettingsBackup
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({
        backup: {
          version: BROWSER_SETTINGS_BACKUP_VERSION,
          savedAt: "2026-07-19T12:00:00.000Z",
          values: {},
        },
      });
    renderActions();
    await screen.findByText("The server settings slot is empty");
    const status = screen.getByRole("status");
    const save = screen.getByRole("button", { name: "Save from this browser" });

    fireEvent.click(save);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("status")).toBe(status);

    fireEvent.click(save);
    await waitFor(() =>
      expect(status.textContent).toMatch(/Settings saved to the server slot /),
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
