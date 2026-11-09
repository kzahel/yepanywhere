// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexUpdateStatus } from "../../api/codexUpdateStatus";
import { CodexUpdatePrompt } from "../CodexUpdatePrompt";

const {
  mockInstall,
  mockRefetchProviders,
  mockUpdateSetting,
  mockUseCodexUpdateStatus,
  mockUseServerSettings,
} = vi.hoisted(() => ({
  mockInstall: vi.fn(),
  mockRefetchProviders: vi.fn(),
  mockUpdateSetting: vi.fn(),
  mockUseCodexUpdateStatus: vi.fn(),
  mockUseServerSettings: vi.fn(),
}));

vi.mock("../../hooks/useCodexUpdateStatus", () => ({
  useCodexUpdateStatus: (...args: unknown[]) =>
    mockUseCodexUpdateStatus(...args),
}));

vi.mock("../../hooks/useServerSettings", () => ({
  useServerSettings: () => mockUseServerSettings(),
}));

vi.mock("../../hooks/useProviders", () => ({
  useProviders: () => ({ refetch: mockRefetchProviders }),
}));

vi.mock("../../i18n", () => ({
  useI18n: () => ({
    t: (key: string) =>
      ({
        codexUpdateAutoFutureVersions: "Update next versions too",
        codexUpdateDesktopAppHint: "Updates with its desktop app.",
        codexUpdateDismiss: "Dismiss",
        codexUpdateDone: "Done",
        codexUpdateRawOutput: "Raw output",
        modalClose: "Close dialog",
        providersCodexUpdateNow: "Update now",
      })[key] ?? key,
  }),
}));

type TestCodexUpdateStatus = CodexUpdateStatus;

const baseStatus: TestCodexUpdateStatus = {
  installed: "0.3.9",
  installedPath: "/usr/local/bin/codex",
  installedPackage: "@openai/codex",
  installSource: "npm",
  updateMethod: "npm",
  manualInstallCommand: "npm install -g @openai/codex@latest",
  latest: "0.4.3",
  releaseUrl: "https://example.test/release",
  updateAvailable: true,
  minimumSupported: "0.4.0",
  belowMinimum: true,
  lastCheckedAt: 1,
  error: null,
};

describe("CodexUpdatePrompt", () => {
  let hookState: {
    status: TestCodexUpdateStatus;
    isChecking: boolean;
    isInstalling: boolean;
    error: string | null;
    installOutput: string | null;
    refresh: ReturnType<typeof vi.fn>;
    install: typeof mockInstall;
  };

  function useSettings(settings: Record<string, unknown>) {
    mockUseServerSettings.mockImplementation(() => ({
      settings: { codexUpdatePolicy: "notify" as const, ...settings },
      updateSetting: mockUpdateSetting,
    }));
  }

  beforeEach(() => {
    mockInstall.mockReset();
    mockRefetchProviders.mockReset();
    mockRefetchProviders.mockResolvedValue(undefined);
    mockUpdateSetting.mockReset();
    mockUpdateSetting.mockResolvedValue(undefined);

    hookState = {
      status: baseStatus,
      isChecking: false,
      isInstalling: false,
      error: null,
      installOutput: null,
      refresh: vi.fn(),
      install: mockInstall,
    };

    mockUseCodexUpdateStatus.mockImplementation(() => hookState);
    useSettings({});
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("stays out of the way when a newer release is merely available", () => {
    hookState = {
      ...hookState,
      status: {
        ...baseStatus,
        installed: "0.4.2",
        belowMinimum: false,
      },
    };

    render(<CodexUpdatePrompt />);

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("stays silent against a server that declares no minimum", () => {
    const { minimumSupported, belowMinimum, ...olderServerStatus } = baseStatus;
    hookState = { ...hookState, status: olderServerStatus };

    render(<CodexUpdatePrompt />);

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("updates below the minimum without opting into future auto-updates", async () => {
    mockInstall.mockImplementation(async () => {
      hookState = {
        ...hookState,
        status: {
          ...baseStatus,
          installed: "0.4.3",
          updateAvailable: false,
          belowMinimum: false,
        },
        installOutput: "added 1 package in 2s",
      };
      return true;
    });

    const view = render(<CodexUpdatePrompt />);

    const checkbox = screen.getByRole("checkbox", {
      name: /update next versions too/i,
    }) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Update now" }));

    await waitFor(() => expect(mockInstall).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockRefetchProviders).toHaveBeenCalledTimes(1));
    expect(mockUpdateSetting).not.toHaveBeenCalledWith(
      "codexUpdatePolicy",
      "auto",
    );

    view.rerender(<CodexUpdatePrompt />);

    expect(screen.queryByText(/added 1 package in 2s/i)).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("remembers a dismissal on the server for that minimum version", () => {
    const view = render(<CodexUpdatePrompt />);

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(mockUpdateSetting).toHaveBeenCalledWith(
      "codexRequiredUpdateDismissed",
      "0.4.0",
    );
    expect(screen.queryByRole("dialog")).toBeNull();

    view.unmount();
    useSettings({ codexRequiredUpdateDismissed: "0.4.0" });
    render(<CodexUpdatePrompt />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps a failed update unresolved when dismissed", async () => {
    mockInstall.mockImplementation(async () => {
      hookState = {
        ...hookState,
        error: "permission denied",
        installOutput: "EACCES",
      };
      return false;
    });

    const view = render(<CodexUpdatePrompt />);

    fireEvent.click(screen.getByRole("button", { name: "Update now" }));

    await waitFor(() => expect(mockInstall).toHaveBeenCalledTimes(1));
    expect(mockRefetchProviders).not.toHaveBeenCalled();

    view.rerender(<CodexUpdatePrompt />);

    expect(screen.queryByText(/permission denied/i)).not.toBeNull();
    expect(screen.queryByText(/EACCES/i)).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(mockUpdateSetting).not.toHaveBeenCalledWith(
      "codexRequiredUpdateDismissed",
      expect.anything(),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("explains that a desktop app's bundled Codex updates with the app", () => {
    hookState = {
      ...hookState,
      status: {
        ...baseStatus,
        installedPath:
          "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
        installedPackage: null,
        installSource: "desktop-app",
        updateMethod: "manual",
        manualInstallCommand: null,
      },
    };

    render(<CodexUpdatePrompt />);

    expect(screen.queryByText("Updates with its desktop app.")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Update now" })).toBeNull();
    expect(
      screen.queryByRole("checkbox", { name: /update next versions too/i }),
    ).toBeNull();
  });

  it("does not check or prompt when update policy is off", () => {
    useSettings({ codexUpdatePolicy: "off" });

    render(<CodexUpdatePrompt />);

    expect(mockUseCodexUpdateStatus).toHaveBeenCalledWith({ enabled: false });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
