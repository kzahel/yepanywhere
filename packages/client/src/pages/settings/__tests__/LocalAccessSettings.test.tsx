// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render as renderWithoutRouter,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  AGENT_SERVER_ACCESS_CAPABILITY,
  APPROVAL_AUDIT_LOG_CAPABILITY,
  SERVER_CAPABILITIES,
  agentApiBootstrapInstructions,
} from "@yep-anywhere/shared";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  FileAccessInfo,
  FileAccessSettings,
  ServerSettings,
} from "../../../api/client";
import { LocalAccessSettings } from "../LocalAccessSettings";
import {
  type SettingsUndoRegistration,
  SettingsUndoProvider,
} from "../SettingsUndoContext";

const {
  authState,
  bindingState,
  hookState,
  mockDisconnect,
  mockGetAuthStatus,
  mockGetFileAccessInfo,
  mockUpdateBinding,
  mockUpdateSetting,
  mockUpdateSettings,
  remoteState,
  versionState,
} = vi.hoisted(() => ({
  authState: { value: null as unknown },
  bindingState: { value: null as unknown },
  hookState: {
    settings: null as ServerSettings | null,
    isLoading: false,
    error: null as string | null,
  },
  mockDisconnect: vi.fn(),
  mockGetAuthStatus: vi.fn(),
  mockGetFileAccessInfo: vi.fn(),
  mockUpdateBinding: vi.fn(),
  mockUpdateSetting: vi.fn(),
  mockUpdateSettings: vi.fn(),
  remoteState: {
    connection: null as null | { disconnect: () => void },
  },
  versionState: {
    capabilities: [] as string[],
  },
}));

vi.mock("../../../api/client", async () => {
  const actual = await vi.importActual<typeof import("../../../api/client")>(
    "../../../api/client",
  );
  return {
    ...actual,
    api: {
      ...actual.api,
      getAuthStatus: mockGetAuthStatus,
      getFileAccessInfo: mockGetFileAccessInfo,
    },
  };
});

vi.mock("../../../contexts/AuthContext", () => ({
  useOptionalAuth: () => authState.value,
}));

vi.mock("../../../contexts/RemoteConnectionContext", () => ({
  useOptionalRemoteConnection: () => remoteState.connection,
}));

vi.mock("../../../hooks/useNetworkBinding", () => ({
  useNetworkBinding: () => ({
    binding: bindingState.value,
    loading: false,
    applying: false,
    updateBinding: mockUpdateBinding,
  }),
}));

vi.mock("../../../hooks/useServerInfo", () => ({
  useServerInfo: () => ({
    serverInfo: null,
    loading: false,
  }),
}));

vi.mock("../../../hooks/useServerSettings", () => ({
  useServerSettings: () => ({
    ...hookState,
    updateSetting: mockUpdateSetting,
    updateSettings: mockUpdateSettings,
    refetch: vi.fn(),
  }),
}));

vi.mock("../../../hooks/useVersion", () => ({
  useVersion: () => ({
    version: {
      capabilities: versionState.capabilities,
    },
  }),
}));

vi.mock("../../../i18n", () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}));

const fileAccessInfo: FileAccessInfo = {
  envPinned: false,
  envPaths: [],
  tempPaths: ["/tmp"],
  uploadsDir: "/uploads",
  homeDir: "/home/alice",
};

const baseFileAccess: FileAccessSettings = {
  projects: true,
  uploads: true,
  temp: true,
  home: false,
  custom: [],
};

/** /api/auth/status as a Remote Access client reads it. */
const remoteAuthStatus = {
  enabled: true,
  authenticated: false,
  setupRequired: false,
  disabledByEnv: false,
  authFilePath: "",
  hasDesktopToken: false,
  localhostOpen: false,
};

const baseBinding = {
  localhost: { port: 3400, overriddenByCli: false },
  network: { enabled: false, host: null, port: 3400, overriddenByCli: false },
  interfaces: [],
};

const baseSettings: ServerSettings = {
  serviceWorkerEnabled: true,
  persistRemoteSessionsToDisk: false,
  fileAccess: baseFileAccess,
};

function render(ui: ReactElement) {
  return renderWithoutRouter(<MemoryRouter>{ui}</MemoryRouter>);
}

function switchFor(labelKey: string): HTMLInputElement {
  return screen.getByRole("switch", {
    name: labelKey,
  }) as HTMLInputElement;
}

describe("LocalAccessSettings", () => {
  beforeEach(() => {
    hookState.settings = {
      ...baseSettings,
      fileAccess: {
        ...baseFileAccess,
        custom: [...baseFileAccess.custom],
      },
    };
    hookState.isLoading = false;
    hookState.error = null;
    remoteState.connection = { disconnect: mockDisconnect };
    mockGetFileAccessInfo.mockResolvedValue(fileAccessInfo);
    mockGetAuthStatus.mockResolvedValue(remoteAuthStatus);
    mockUpdateSetting.mockResolvedValue(undefined);
    mockUpdateSettings.mockImplementation(
      async (updates: Partial<ServerSettings>) => {
        if (!hookState.settings) throw new Error("settings not initialized");
        hookState.settings = { ...hookState.settings, ...updates };
      },
    );
    versionState.capabilities = [APPROVAL_AUDIT_LOG_CAPABILITY];
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    remoteState.connection = null;
    authState.value = null;
    bindingState.value = null;
  });

  describe("password block", () => {
    const enableAuth = vi.fn();
    const changePassword = vi.fn();
    const disableAuth = vi.fn();

    function useDirectAccess(authEnabled: boolean) {
      remoteState.connection = null;
      authState.value = {
        authEnabled,
        isAuthenticated: true,
        isLoading: false,
        localhostOpen: false,
        hasDesktopToken: false,
        authDisabledByEnv: false,
        enableAuth,
        changePassword,
        disableAuth,
        setLocalhostOpen: vi.fn(),
        logout: vi.fn(),
      };
      bindingState.value = baseBinding;
    }

    function feedback(): string | null | undefined {
      return document
        .querySelector("[data-local-access-password-feedback]")
        ?.getAttribute("data-local-access-password-feedback");
    }

    it("gates API discovery separately from the legacy operator token and previews the exact bootstrap", async () => {
      useDirectAccess(false);
      const first = render(<LocalAccessSettings />);
      expect(
        screen.queryByRole("switch", { name: "localAccessAgentApiTitle" }),
      ).toBeNull();
      first.unmount();
      versionState.capabilities = [SERVER_CAPABILITIES.agentApiBootstrap.name];
      render(<LocalAccessSettings />);
      const toggle = screen.getByRole("switch", {
        name: "localAccessAgentApiTitle",
      });
      expect(toggle).toHaveProperty("checked", false);
      await act(async () => {
        fireEvent.click(toggle);
      });
      expect(mockUpdateSetting).toHaveBeenCalledWith("agentApiEnabled", true);
      expect(
        screen.queryByRole("switch", {
          name: "localAccessAgentServerAccessTitle",
        }),
      ).toBeNull();
      const preview = screen
        .getByText("localAccessAgentApiPreview")
        .closest("details")!;
      expect(preview.textContent).toContain(
        agentApiBootstrapInstructions(false),
      );
      expect(preview.textContent).toContain(
        agentApiBootstrapInstructions(true),
      );
    });

    it("keeps command authority behind its distinct capability and setting", async () => {
      useDirectAccess(false);
      versionState.capabilities = [SERVER_CAPABILITIES.agentApiBootstrap.name];
      const first = render(<LocalAccessSettings />);
      expect(
        screen.queryByRole("switch", {
          name: "localAccessAgentApiManagementTitle",
        }),
      ).toBeNull();
      first.unmount();
      versionState.capabilities.push(
        SERVER_CAPABILITIES.agentApiManagement.name,
      );
      render(<LocalAccessSettings />);
      const management = screen.getByRole("switch", {
        name: "localAccessAgentApiManagementTitle",
      });
      expect(management).toHaveProperty("checked", false);
      await act(async () => {
        fireEvent.click(management);
      });
      expect(mockUpdateSetting).toHaveBeenCalledWith(
        "agentApiManagementEnabled",
        true,
      );
    });

    it("offers session API access only once a password is required", async () => {
      versionState.capabilities = [
        APPROVAL_AUDIT_LOG_CAPABILITY,
        AGENT_SERVER_ACCESS_CAPABILITY,
      ];
      useDirectAccess(false);
      const { unmount } = render(<LocalAccessSettings />);
      expect(
        screen.queryByRole("switch", {
          name: "localAccessAgentServerAccessTitle",
        }),
      ).toBeNull();
      unmount();

      useDirectAccess(true);
      render(<LocalAccessSettings />);
      const toggle = screen.getByRole("switch", {
        name: "localAccessAgentServerAccessTitle",
      });
      expect(toggle).toHaveProperty("checked", false);
      fireEvent.click(toggle);
      expect(mockUpdateSetting).toHaveBeenCalledWith(
        "agentServerAccessEnabled",
        true,
      );
    });

    it("nests the fields under the toggle with live match feedback", async () => {
      useDirectAccess(false);
      render(<LocalAccessSettings />);

      expect(
        document.querySelector("[data-local-access-password-block]"),
      ).toBeNull();
      fireEvent.click(switchFor("localAccessRequirePasswordTitle"));

      const block = document.querySelector(
        "[data-local-access-password-block]",
      ) as HTMLElement;
      expect(block.textContent).toContain("localAccessPasswordPending");
      const password = screen.getByPlaceholderText(
        "localAccessPasswordPlaceholder",
      );
      const confirm = screen.getByPlaceholderText(
        "localAccessConfirmPasswordPlaceholder",
      );
      const apply = screen.getByRole("button", {
        name: "localAccessPasswordEnableAction",
      });
      expect(block.contains(confirm)).toBe(true);
      expect(block.contains(apply)).toBe(true);

      fireEvent.change(password, { target: { value: "abc" } });
      expect(feedback()).toBe("short");
      fireEvent.change(password, { target: { value: "secret1" } });
      fireEvent.change(confirm, { target: { value: "sec" } });
      expect(feedback()).toBe("none");
      fireEvent.change(confirm, { target: { value: "secret2" } });
      expect(feedback()).toBe("mismatch");
      expect(confirm.getAttribute("aria-invalid")).toBe("true");
      expect((apply as HTMLButtonElement).disabled).toBe(true);

      fireEvent.change(confirm, { target: { value: "secret1" } });
      expect(feedback()).toBe("match");
      expect((apply as HTMLButtonElement).disabled).toBe(false);
      fireEvent.click(apply);
      await waitFor(() => expect(enableAuth).toHaveBeenCalledWith("secret1"));
    });

    it("offers removal in place when the toggle turns an active password off", async () => {
      useDirectAccess(true);
      render(<LocalAccessSettings />);

      const block = document.querySelector(
        "[data-local-access-password-block]",
      ) as HTMLElement;
      expect(block.textContent).toContain("localAccessPasswordActive");
      fireEvent.click(switchFor("localAccessRequirePasswordTitle"));
      expect(block.textContent).toContain("localAccessPasswordDisableWarning");
      fireEvent.click(
        screen.getByRole("button", {
          name: "localAccessPasswordDisableAction",
        }),
      );
      await waitFor(() => expect(disableAuth).toHaveBeenCalledTimes(1));
    });

    it("keeps connection apply/discard independent of password and saved file access", async () => {
      useDirectAccess(false);
      versionState.capabilities = [
        SERVER_CAPABILITIES.connectionSafeSettings.name,
      ];
      const { rerender } = render(<LocalAccessSettings />);
      expect(
        screen.queryByRole("button", { name: "localAccessConnectionApply" }),
      ).toBeNull();
      fireEvent.click(switchFor("localAccessRequirePasswordTitle"));
      const password = screen.getByLabelText("localAccessPasswordTitle");
      fireEvent.change(password, { target: { value: "unfinished" } });
      expect(
        screen.queryByRole("button", { name: "localAccessConnectionApply" }),
      ).toBeNull();
      fireEvent.change(screen.getByLabelText("localAccessAllowedHostsTitle"), {
        target: { value: "new.example" },
      });
      const form = screen
        .getByRole("button", { name: "localAccessConnectionApply" })
        .closest("form")!;
      await act(async () => {
        fireEvent.submit(form);
      });
      expect(mockUpdateSettings).toHaveBeenLastCalledWith(
        { allowedHosts: "new.example" },
        { confirmedConnectionImpact: false },
      );
      expect(enableAuth).not.toHaveBeenCalled();
      expect(password).toHaveProperty("value", "unfinished");
      expect(
        screen.queryByRole("button", { name: "localAccessConnectionApply" }),
      ).toBeNull();

      fireEvent.click(switchFor("fileAccessHome"));
      await waitFor(() =>
        expect(hookState.settings?.fileAccess?.home).toBe(true),
      );
      rerender(
        <MemoryRouter>
          <LocalAccessSettings />
        </MemoryRouter>,
      );
      fireEvent.change(screen.getByRole("spinbutton"), {
        target: { value: "3401" },
      });
      fireEvent.click(
        within(form).getByRole("button", { name: "localAccessDiscard" }),
      );
      expect(screen.getByRole("spinbutton")).toHaveProperty("value", "3400");
      expect(password).toHaveProperty("value", "unfinished");
      expect(switchFor("fileAccessHome")).toHaveProperty("checked", true);
      fireEvent.click(
        within(password.closest("form")!).getByRole("button", {
          name: "localAccessDiscard",
        }),
      );
      expect(switchFor("localAccessRequirePasswordTitle")).toHaveProperty(
        "checked",
        false,
      );
    });

    it("asks once when an apply would disconnect this client", async () => {
      versionState.capabilities = [
        APPROVAL_AUDIT_LOG_CAPABILITY,
        SERVER_CAPABILITIES.connectionSafeSettings.name,
      ];
      useDirectAccess(false);
      mockUpdateSettings.mockRejectedValueOnce(
        Object.assign(new Error("would disconnect"), {
          reason: "connection-impact",
          connectionImpact: [{ kind: "host-not-allowed", host: "yep.example" }],
        }),
      );
      mockUpdateBinding.mockResolvedValue({});
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
      render(<LocalAccessSettings />);

      fireEvent.change(await screen.findByRole("spinbutton"), {
        target: { value: "3401" },
      });
      fireEvent.change(
        screen.getByPlaceholderText("localAccessAllowedHostsPlaceholder"),
        { target: { value: "other.example" } },
      );
      fireEvent.click(
        screen.getByRole("button", { name: "localAccessConnectionApply" }),
      );

      await waitFor(() =>
        expect(mockUpdateBinding).toHaveBeenCalledWith(
          { localhostPort: 3401 },
          true,
        ),
      );
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(mockUpdateSettings).toHaveBeenLastCalledWith(
        { allowedHosts: "other.example" },
        { confirmedConnectionImpact: true },
      );
      confirm.mockRestore();
    });

    it("leaves a declined disconnecting change pending without an error", async () => {
      versionState.capabilities = [
        APPROVAL_AUDIT_LOG_CAPABILITY,
        SERVER_CAPABILITIES.connectionSafeSettings.name,
      ];
      useDirectAccess(false);
      mockUpdateBinding.mockRejectedValueOnce(
        Object.assign(new Error("would disconnect"), {
          reason: "connection-impact",
          connectionImpact: [
            { kind: "listener-closed", listener: "127.0.0.1:3400" },
          ],
        }),
      );
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
      render(<LocalAccessSettings />);

      fireEvent.change(await screen.findByRole("spinbutton"), {
        target: { value: "3401" },
      });
      const apply = screen.getByRole("button", {
        name: "localAccessConnectionApply",
      });
      fireEvent.click(apply);

      await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(apply).toHaveProperty("disabled", false));
      expect(mockUpdateBinding).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("alert")).toBeNull();
      confirm.mockRestore();
    });

    it("offers the same settings over Remote Access as over a direct connection", async () => {
      versionState.capabilities = [
        APPROVAL_AUDIT_LOG_CAPABILITY,
        AGENT_SERVER_ACCESS_CAPABILITY,
        SERVER_CAPABILITIES.agentApiBootstrap.name,
        SERVER_CAPABILITIES.connectionSafeSettings.name,
      ];
      // Each connection's own logout is a session action, not a setting.
      const settingIds = () =>
        [...document.querySelectorAll("[data-settings-item]")]
          .map((item) => item.getAttribute("data-settings-item"))
          .filter(
            (id) =>
              id !== "local-access-logout" &&
              id !== "local-access-remote-logout",
          )
          .sort();

      useDirectAccess(true);
      const direct = render(<LocalAccessSettings />);
      await screen.findByRole("group", { name: "fileAccessTitle" });
      const directIds = settingIds();
      expect(screen.getByRole("spinbutton")).toBeTruthy();
      direct.unmount();

      authState.value = null;
      remoteState.connection = { disconnect: mockDisconnect };
      render(<LocalAccessSettings />);
      await screen.findByRole("group", { name: "fileAccessTitle" });

      expect(settingIds()).toEqual(directIds);
      expect(switchFor("localAccessRequirePasswordTitle").disabled).toBe(false);
      expect(
        document.querySelector(
          '[data-settings-item="local-access-remote-logout"]',
        ),
      ).not.toBeNull();
    });
  });

  it("keeps the local password read-only over Remote Access until the server accepts the owner login", async () => {
    bindingState.value = baseBinding;
    render(<LocalAccessSettings />);

    const toggle = await screen.findByRole("switch", {
      name: "localAccessRequirePasswordTitle",
    });
    expect(toggle).toHaveProperty("disabled", true);
    expect(
      screen.getByText("localAccessPasswordRemoteUpdateRequired"),
    ).toBeTruthy();
    expect(
      document.querySelector("[data-local-access-password-block]"),
    ).toBeNull();
  });

  it("saves relay-mode file access toggles immediately", async () => {
    render(<LocalAccessSettings />);

    fireEvent.click(
      await screen.findByRole("switch", { name: "fileAccessHome" }),
    );

    await waitFor(() =>
      expect(mockUpdateSettings).toHaveBeenCalledWith({
        fileAccess: {
          projects: true,
          uploads: true,
          temp: true,
          home: true,
          custom: [],
        },
      }),
    );
  });

  it("saves custom folders on blur or explicit save", async () => {
    render(<LocalAccessSettings />);

    const customFolders = await screen.findByRole("textbox", {
      name: "fileAccessCustomTitle",
    });
    fireEvent.change(customFolders, {
      target: { value: " /srv/first \n/srv/second" },
    });
    fireEvent.blur(customFolders);

    await waitFor(() =>
      expect(mockUpdateSettings).toHaveBeenLastCalledWith({
        fileAccess: {
          projects: true,
          uploads: true,
          temp: true,
          home: false,
          custom: ["/srv/first", "/srv/second"],
        },
      }),
    );

    fireEvent.change(customFolders, {
      target: { value: "/srv/clicked" },
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "fileAccessCustomSave" }),
    );

    await waitFor(() =>
      expect(mockUpdateSettings).toHaveBeenLastCalledWith({
        fileAccess: {
          projects: true,
          uploads: true,
          temp: true,
          home: false,
          custom: ["/srv/clicked"],
        },
      }),
    );
  });

  it("undoes an immediately saved custom folder edit", async () => {
    let undoRegistration: SettingsUndoRegistration | null = null;
    render(
      <SettingsUndoProvider
        value={(registration) => {
          undoRegistration = registration;
        }}
      >
        <LocalAccessSettings />
      </SettingsUndoProvider>,
    );

    const customFolders = await screen.findByRole("textbox", {
      name: "fileAccessCustomTitle",
    });
    fireEvent.change(customFolders, {
      target: { value: "/srv/undo-me" },
    });
    fireEvent.blur(customFolders);

    await waitFor(() => expect(undoRegistration?.canUndo).toBe(true));
    const undo = (undoRegistration as SettingsUndoRegistration | null)?.undo;
    expect(undo).toBeTypeOf("function");
    await act(async () => {
      await undo?.();
    });

    await waitFor(() =>
      expect(mockUpdateSettings).toHaveBeenLastCalledWith({
        fileAccess: baseFileAccess,
      }),
    );
  });

  it("updates approval audit logging when the server supports it", async () => {
    hookState.settings = {
      ...baseSettings,
      approvalAuditLogEnabled: false,
    };

    render(<LocalAccessSettings />);

    const auditToggle = await screen.findByRole("switch", {
      name: "localAccessApprovalAuditTitle",
    });
    expect(auditToggle).toHaveProperty("disabled", false);
    expect(auditToggle).toHaveProperty("checked", false);

    fireEvent.click(auditToggle);

    expect(mockUpdateSetting).toHaveBeenCalledWith(
      "approvalAuditLogEnabled",
      true,
    );
  });
});
