// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  GIT_LIVE_WORKTREE_SETTING_CAPABILITY,
  GIT_SOURCE_REVIEW_SUBMISSIONS_CAPABILITY,
} from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerSettings } from "../../../api/client";
import { setSourceControlCleanLandingPreference } from "../../../hooks/useSourceControlCleanLanding";
import { UI_KEYS } from "../../../lib/storageKeys";
import { SourceControlSettings } from "../SourceControlSettings";

const { refetchVersion, state, updateSettings } = vi.hoisted(() => ({
  state: {
    settings: {
      serviceWorkerEnabled: true,
      persistRemoteSessionsToDisk: false,
      liveWorktreeMonitoringEnabled: false,
      sourceReviewSubmissionsEnabled: false,
      sourceReviewResponseTurns: 8,
    } as ServerSettings,
    capabilities: [
      "git-source-review-submissions",
      "git-live-worktree-setting",
    ] as string[],
  },
  refetchVersion: vi.fn(),
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

vi.mock("../../../hooks/useVersion", () => ({
  useVersion: () => ({
    version: { capabilities: state.capabilities },
    refetch: refetchVersion,
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

describe("SourceControlSettings", () => {
  beforeEach(() => {
    localStorage.clear();
    setSourceControlCleanLandingPreference("working-tree");
    state.settings = {
      serviceWorkerEnabled: true,
      persistRemoteSessionsToDisk: false,
      liveWorktreeMonitoringEnabled: false,
      sourceReviewSubmissionsEnabled: false,
      sourceReviewResponseTurns: 8,
    };
    state.capabilities = [
      GIT_SOURCE_REVIEW_SUBMISSIONS_CAPABILITY,
      GIT_LIVE_WORKTREE_SETTING_CAPABILITY,
    ];
    refetchVersion.mockReset();
    refetchVersion.mockResolvedValue(undefined);
    updateSettings.mockReset();
    updateSettings.mockResolvedValue(undefined);
  });

  afterEach(cleanup);

  it("defaults the clean Changes landing to Working tree status", () => {
    render(<SourceControlSettings />);
    const select = screen.getByRole("combobox", {
      name: "sourceControlCleanLandingTitle",
    }) as HTMLSelectElement;

    expect(select.value).toBe("working-tree");
    fireEvent.change(select, { target: { value: "latest-commit" } });

    expect(select.value).toBe("latest-commit");
    expect(localStorage.getItem(UI_KEYS.sourceControlCleanLanding)).toBe(
      "latest-commit",
    );
  });

  it("keeps a missing submission setting off and saves an explicit opt-in", () => {
    render(<SourceControlSettings />);
    const toggle = screen.getByRole("switch", {
      name: "sourceReviewSubmissionsSettingTitle",
    });
    expect((toggle as HTMLInputElement).checked).toBe(false);
    fireEvent.click(toggle);
    expect(updateSettings).toHaveBeenCalledWith({
      sourceReviewSubmissionsEnabled: true,
    });
  });

  it("keeps live monitoring default-off and refreshes capabilities after opt-in", async () => {
    render(<SourceControlSettings />);
    const toggle = screen.getByRole("switch", {
      name: "liveWorktreeMonitoringSettingTitle",
    });

    expect((toggle as HTMLInputElement).checked).toBe(false);
    fireEvent.click(toggle);

    expect(updateSettings).toHaveBeenCalledWith({
      liveWorktreeMonitoringEnabled: true,
    });
    await waitFor(() => expect(refetchVersion).toHaveBeenCalledOnce());
  });

  it("keeps the response observation bound out of the user-facing pane", () => {
    render(<SourceControlSettings />);
    expect(screen.queryByRole("spinbutton")).toBeNull();
  });
});
