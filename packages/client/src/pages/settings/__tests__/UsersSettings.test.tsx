// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ActingPrincipal, LimitedUserSummary } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import english from "../../../i18n/en.json";
import { UsersSettings } from "../UsersSettings";

/** Contract: topics/limited-users.md § Delivery v1 — Settings → Users. */

const {
  principalState,
  settingsState,
  mockListUsers,
  mockCreateUser,
  mockDeleteUser,
  mockUpdateUser,
  mockUpdateSetting,
  mockRefreshPrincipal,
} = vi.hoisted(() => ({
  principalState: {
    principal: {
      superuser: true,
      username: null,
      switched: false,
      locked: false,
      enabled: false,
      hasLimitedUsers: false,
      logoutRedirect: "stay",
    } as ActingPrincipal,
    resolved: true,
  },
  settingsState: { settings: {} as Record<string, unknown> },
  mockListUsers: vi.fn(),
  mockCreateUser: vi.fn(),
  mockDeleteUser: vi.fn(),
  mockUpdateUser: vi.fn(),
  mockUpdateSetting: vi.fn(),
  mockRefreshPrincipal: vi.fn(),
}));

vi.mock("../../../api/client", () => ({
  api: {
    listUsers: mockListUsers,
    createUser: mockCreateUser,
    updateUser: mockUpdateUser,
    deleteUser: mockDeleteUser,
    switchUser: vi.fn(),
    logoutUser: vi.fn(),
  },
}));

vi.mock("../../../hooks/useActingPrincipal", () => ({
  useActingPrincipal: () => ({
    principal: principalState.principal,
    loading: false,
    resolved: principalState.resolved,
    refresh: mockRefreshPrincipal,
  }),
}));

// No version by default: every optional capability reads as unsupported.
const versionState = vi.hoisted(() => ({
  version: undefined as { capabilities: string[] } | undefined,
}));
vi.mock("../../../hooks/useVersion", () => ({
  useVersion: () => ({ version: versionState.version }),
}));

vi.mock("../../../hooks/useProjects", () => ({
  useProjects: () => ({
    projects: [
      { id: "p1", name: "Alpha", path: "/tmp/alpha" },
      { id: "p2", name: "Beta", path: "/tmp/beta" },
    ],
  }),
}));

vi.mock("../../../hooks/useProviders", () => ({
  useProviders: () => ({
    providers: [
      {
        name: "claude",
        displayName: "Claude",
        models: [{ id: "opus", name: "Opus" }],
      },
    ],
  }),
}));

vi.mock("../../../hooks/useServerSettings", () => ({
  useServerSettings: () => ({
    settings: settingsState.settings,
    isLoading: false,
    error: null,
    updateSetting: mockUpdateSetting,
    updateSettings: vi.fn(),
    refetch: vi.fn(),
  }),
}));

vi.mock("../SettingsPaneTitleContext", () => ({
  useSettingsPaneTitle: () => {},
}));

vi.mock("../../../i18n", () => ({
  useI18n: () => ({
    t: (key: string, vars?: Record<string, string | number>) => {
      if (!vars) return key;
      let text = key;
      for (const [name, value] of Object.entries(vars)) {
        text = text.replaceAll(`{${name}}`, String(value));
      }
      return text;
    },
  }),
}));

function user(overrides: Partial<LimitedUserSummary> = {}): LimitedUserSummary {
  return {
    username: "alice",
    disabled: false,
    createdAt: "2026-09-20T00:00:00.000Z",
    newSessionProjects: ["p1"],
    joinProjects: [],
    viewProjects: [],
    joinStaleOffsetMinutes: 0,
    lock: {},
    ...overrides,
  };
}

describe("Settings → Users", () => {
  beforeEach(() => {
    principalState.principal = {
      superuser: true,
      username: null,
      switched: false,
      locked: false,
      enabled: false,
      hasLimitedUsers: false,
      logoutRedirect: "stay",
    };
    principalState.resolved = true;
    versionState.version = undefined;
    settingsState.settings = {};
    mockListUsers.mockReset();
    mockCreateUser.mockReset();
    mockDeleteUser.mockReset();
    mockUpdateUser.mockReset();
    mockUpdateSetting.mockReset();
    mockRefreshPrincipal.mockReset();
    mockListUsers.mockResolvedValue({ users: [], enabled: false });
    mockCreateUser.mockResolvedValue({ user: user() });
    mockDeleteUser.mockResolvedValue({ success: true });
    mockUpdateUser.mockImplementation(async (username: string, draft) => ({
      user: user({ username, ...draft }),
    }));
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("gates the new session and app permissions and preserves their defaults", async () => {
    versionState.version = {
      capabilities: [
        "limited-user-no-project-sessions",
        "project-app-address-links",
      ],
    };
    mockListUsers.mockResolvedValue({ users: [user()], enabled: true });
    render(<UsersSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "alice" }));
    expect(
      (
        screen.getByRole("checkbox", {
          name: "usersAllowNoProject",
        }) as HTMLInputElement
      ).checked,
    ).toBe(false);
    expect(
      (
        screen.getByRole("checkbox", {
          name: "usersAllowPublicApps",
        }) as HTMLInputElement
      ).checked,
    ).toBe(false);
    expect(
      (
        screen.getByRole("checkbox", {
          name: "usersAllowPrivateAppLinks",
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
    fireEvent.click(
      screen.getByRole("checkbox", { name: "usersAllowNoProject" }),
    );
    await waitFor(() =>
      expect(mockUpdateUser).toHaveBeenCalledWith(
        "alice",
        expect.objectContaining({
          allowNoProjectSessions: true,
          allowPublicApps: false,
          allowPrivateAppLinks: true,
        }),
      ),
    );
  });

  it("omits unsupported permissions from older-server updates", async () => {
    mockListUsers.mockResolvedValue({ users: [user()], enabled: true });
    render(<UsersSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "alice" }));
    expect(
      screen.queryByRole("checkbox", { name: "usersAllowNoProject" }),
    ).toBeNull();
    expect(
      screen.queryByRole("checkbox", { name: "usersAllowPublicApps" }),
    ).toBeNull();
    expect(
      screen.queryByRole("checkbox", { name: "usersAllowPrivateAppLinks" }),
    ).toBeNull();
    fireEvent.change(screen.getByLabelText("Alpha"), {
      target: { value: "view" },
    });
    await waitFor(() => expect(mockUpdateUser).toHaveBeenCalled());
    const payload = mockUpdateUser.mock.calls[0]![1];
    for (const field of [
      "allowNoProjectSessions",
      "allowPublicApps",
      "allowPrivateAppLinks",
    ])
      expect(payload).not.toHaveProperty(field);
  });

  it("requires confirmation before deleting a user and keeps them on cancel", async () => {
    mockListUsers.mockResolvedValue({ users: [user()], enabled: true });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<UsersSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "alice" }));
    fireEvent.click(screen.getByRole("button", { name: "usersDelete" }));
    expect(confirm).toHaveBeenCalledWith("usersDeleteConfirm");
    expect(mockDeleteUser).not.toHaveBeenCalled();
    expect(screen.getByText("alice")).toBeTruthy();

    confirm.mockReturnValue(true);
    mockListUsers.mockResolvedValue({ users: [], enabled: true });
    fireEvent.click(screen.getByRole("button", { name: "usersDelete" }));
    await waitFor(() => expect(mockDeleteUser).toHaveBeenCalledTimes(1));
    expect(mockDeleteUser).toHaveBeenCalledWith("alice");
    await waitFor(() => expect(screen.queryByText("alice")).toBeNull());
  });

  it("lists only granted projects until the rest are expanded", async () => {
    mockListUsers.mockResolvedValue({ users: [user()], enabled: true });
    render(<UsersSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "alice" }));

    expect(screen.getByLabelText("Alpha")).toBeTruthy();
    expect(screen.queryByLabelText("Beta")).toBeNull();

    // Revoking a shown grant keeps its row, so the change stays visible.
    fireEvent.change(screen.getByLabelText("Alpha"), {
      target: { value: "none" },
    });
    expect(screen.getByLabelText("Alpha")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "usersProjectsShowNoAccess" }),
    );
    expect(screen.getByLabelText("Beta")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "usersProjectsHideNoAccess" }),
    );
    expect(screen.queryByLabelText("Beta")).toBeNull();
  });

  it("offers the toggle and adding the first user while the feature is off", async () => {
    render(<UsersSettings />);

    await waitFor(() => {
      expect(screen.getByText("usersEmpty")).toBeTruthy();
    });
    expect(screen.getByText("usersTrustWarning")).toBeTruthy();
    expect(english.settingsUsersDescription).toBe(
      "Preview accounts for trusted sharing",
    );
    expect(english.advancedLimitedUsersTitle).toBe("Limited users (preview)");
    expect(english.advancedLimitedUsersDescription).toContain(
      "not hardened isolation for hostile or untrusted users",
    );
    expect(english.usersTrustWarning).toContain("only with people you trust");
    // The toggle is present and off, and adding a user does not wait for it.
    const toggle = screen.getByRole("switch") as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "+ usersAddUser" }));
    expect(
      screen.getByPlaceholderText("usersUsernamePlaceholder"),
    ).toBeTruthy();
  });

  it("creates a user and re-reads the acting principal, which the server just enabled", async () => {
    render(<UsersSettings />);
    await waitFor(() => expect(mockListUsers).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "+ usersAddUser" }));
    fireEvent.change(screen.getByPlaceholderText("usersUsernamePlaceholder"), {
      target: { value: "alice" },
    });
    fireEvent.change(screen.getByPlaceholderText("usersPasswordPlaceholder"), {
      target: { value: "alice-password" },
    });
    const created = user({ newSessionProjects: [] });
    mockCreateUser.mockResolvedValue({ user: created });
    mockListUsers.mockResolvedValue({ users: [created], enabled: true });
    fireEvent.click(screen.getByRole("button", { name: "usersCreateUser" }));

    await waitFor(() => {
      expect(mockCreateUser).toHaveBeenCalledWith({
        username: "alice",
        password: "alice-password",
      });
    });
    // Creating the first user turns the feature on server-side.
    expect(mockRefreshPrincipal).toHaveBeenCalled();
    // The new user opens in the editor, where a new user's projects all
    // start behind the expander.
    await screen.findByText("usersEditUserTitle");
    expect(
      screen
        .getByRole("button", { name: "alice" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.queryByLabelText("Alpha")).toBeNull();
  });

  it("saves a choice at once and typed text on blur, without a Save button", async () => {
    mockListUsers.mockResolvedValue({ users: [user()], enabled: true });
    render(<UsersSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "alice" }));
    expect(screen.queryByRole("button", { name: "usersSaveUser" })).toBeNull();

    // An unchanged blur sends nothing.
    const offset = screen.getByRole("spinbutton");
    fireEvent.blur(offset);
    expect(mockUpdateUser).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Alpha"), {
      target: { value: "view" },
    });
    await waitFor(() => expect(mockUpdateUser).toHaveBeenCalledTimes(1));
    expect(mockUpdateUser.mock.calls[0]?.[1]).toMatchObject({
      newSessionProjects: [],
      viewProjects: ["p1"],
      disabled: false,
    });

    fireEvent.change(offset, { target: { value: "7" } });
    expect(mockUpdateUser).toHaveBeenCalledTimes(1);
    fireEvent.blur(offset);
    await waitFor(() => expect(mockUpdateUser).toHaveBeenCalledTimes(2));
    expect(mockUpdateUser.mock.calls[1]?.[1]).toMatchObject({
      joinStaleOffsetMinutes: 7,
    });
    expect(await screen.findByText(/usersAutosaveSaved/)).toBeTruthy();
    // Still editing the same user.
    expect(screen.getByText("usersEditUserTitle")).toBeTruthy();
  });

  it("grants a user's project directory, picked by username, at once", async () => {
    versionState.version = { capabilities: ["limited-user-path-grants"] };
    mockListUsers.mockResolvedValue({
      users: [user(), user({ username: "bobby", projectRoot: "~/bobby" })],
      enabled: true,
    });
    render(<UsersSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "alice" }));
    fireEvent.change(
      screen.getByRole("combobox", { name: "usersDirectoryFromUser" }),
      { target: { value: "~/bobby" } },
    );
    await waitFor(() => expect(mockUpdateUser).toHaveBeenCalledTimes(1));
    expect(mockUpdateUser.mock.calls[0]?.[1]).toMatchObject({
      pathGrants: [{ path: "~/bobby", level: "view" }],
    });
    // An added row saves nothing until it names a directory.
    fireEvent.click(screen.getByRole("button", { name: "usersDirectoryAdd" }));
    fireEvent.blur(
      screen.getAllByRole("textbox", { name: "usersDirectoryPath" })[1]!,
    );
    expect(mockUpdateUser).toHaveBeenCalledTimes(1);
  });

  it("sends no directory grants to a server that would ignore them", async () => {
    mockListUsers.mockResolvedValue({ users: [user()], enabled: true });
    render(<UsersSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "alice" }));
    expect(screen.queryByText("usersDirectoriesHeading")).toBeNull();
    fireEvent.change(screen.getByLabelText("Alpha"), {
      target: { value: "view" },
    });
    await waitFor(() => expect(mockUpdateUser).toHaveBeenCalledTimes(1));
    expect(mockUpdateUser.mock.calls[0]?.[1]).not.toHaveProperty("pathGrants");
  });

  it("disables a user without deleting or asking", async () => {
    mockListUsers.mockResolvedValue({ users: [user()], enabled: true });
    const confirm = vi.spyOn(window, "confirm");
    render(<UsersSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "alice" }));
    fireEvent.click(
      screen.getByRole("checkbox", { name: "usersEnabledLabel" }),
    );

    await waitFor(() => expect(mockUpdateUser).toHaveBeenCalledTimes(1));
    expect(mockUpdateUser.mock.calls[0]).toEqual([
      "alice",
      expect.objectContaining({ disabled: true }),
    ]);
    expect(confirm).not.toHaveBeenCalled();
    expect(mockDeleteUser).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "alice" }).className).toContain(
        "userChipDisabled",
      ),
    );
  });

  it("shows a limited user their own account instead of the directory", async () => {
    principalState.principal = {
      superuser: false,
      username: "alice",
      switched: false,
      locked: true,
      enabled: true,
      hasLimitedUsers: true,
      logoutRedirect: "direct-login",
      grants: {
        newSessionProjects: ["p1"],
        joinProjects: [],
        viewProjects: [],
        joinStaleOffsetMinutes: 0,
        lock: { provider: "claude" },
      },
    };
    render(<UsersSettings />);

    expect(screen.getByText("usersSignedInAs")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "usersAddUser" })).toBeNull();
    // They never ask for the directory: that call is refused for them anyway.
    expect(mockListUsers).not.toHaveBeenCalled();
  });

  it("does not call the directory before the server says who this client is", () => {
    principalState.resolved = false;
    render(<UsersSettings />);

    // The placeholder principal looks like the superuser, so asking now would
    // be one refused request per load for a switched or limited principal.
    expect(mockListUsers).not.toHaveBeenCalled();
    expect(screen.getByText("loading")).toBeTruthy();
  });

  it("keeps the directory for a refusal, which is not a missing surface", async () => {
    const refused = Object.assign(new Error("Not permitted"), { status: 403 });
    mockListUsers.mockRejectedValue(refused);
    render(<UsersSettings />);

    await waitFor(() => expect(mockListUsers).toHaveBeenCalled());
    expect(await screen.findByText("Not permitted")).toBeTruthy();
    expect(screen.getByRole("switch")).toBeTruthy();
  });
});
