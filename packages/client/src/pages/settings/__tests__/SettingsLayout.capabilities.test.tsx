// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import type { ActingPrincipal } from "@yep-anywhere/shared";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSettingsCategories } from "../../../i18n-settings";
import { SettingsLayout } from "../SettingsLayout";

/** Contract: topics/settings-ui-placement.md § Categories. */

const SUPERUSER: ActingPrincipal = {
  superuser: true,
  username: null,
  switched: false,
  locked: false,
  enabled: false,
  hasLimitedUsers: false,
  logoutRedirect: "stay",
};

const { versionState } = vi.hoisted(() => ({
  versionState: {
    version: { capabilities: [] } as { capabilities?: string[] } | null,
    loading: false,
  },
}));

vi.mock("../../../hooks/useActingPrincipal", () => ({
  useActingPrincipal: () => ({
    principal: SUPERUSER,
    loading: false,
    resolved: true,
    refresh: vi.fn(),
  }),
}));

vi.mock("../../../hooks/useVersion", () => ({
  useVersion: () => ({
    version: versionState.version,
    loading: versionState.loading,
  }),
}));

vi.mock("../../../hooks/useRemoteBasePath", () => ({
  useRemoteBasePath: () => "",
}));

vi.mock("../../../layouts", () => ({
  MainContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  useNavigationLayout: () => ({ openSidebar: vi.fn(), isWideScreen: true }),
}));

vi.mock("../../../i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock("../EmulatorSettings", () => ({
  EmulatorSettings: () => <p>emulator pane</p>,
}));

vi.mock("../ProjectTemplatesSettings", () => ({
  ProjectTemplatesSettings: () => <p>project templates pane</p>,
}));

const gatedCategories = getSettingsCategories((key) => key).filter(
  (category) => category.requires,
);

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/settings/:category" element={<SettingsLayout />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  versionState.version = { capabilities: [] };
  versionState.loading = false;
});

afterEach(() => {
  cleanup();
});

describe("SettingsLayout capability gating", () => {
  it("covers the categories whose panes an older server cannot serve", () => {
    expect(gatedCategories.map((category) => category.id).sort()).toEqual([
      "emulator",
      "issues",
      "project-templates",
      "server-connections",
      "users",
    ]);
  });

  it.each(gatedCategories.map((category) => [category.id, category] as const))(
    "answers a typed %s URL on an older server with its unsupported message",
    async (id, category) => {
      renderAt(`/settings/${id}`);
      await act(async () => {});

      expect(
        screen.getByText(category.requires?.unsupportedMessage ?? ""),
      ).toBeTruthy();
      // The category is off the list: its only entry point was the typed URL.
      expect(
        screen.queryByRole("button", { name: new RegExp(category.label) }),
      ).toBeNull();
    },
  );

  it("mounts no pane for a category the server cannot serve", async () => {
    renderAt("/settings/emulator");
    await act(async () => {});
    expect(screen.queryByText("emulator pane")).toBeNull();
    cleanup();

    renderAt("/settings/project-templates");
    await act(async () => {});
    expect(screen.queryByText("project templates pane")).toBeNull();
  });

  it("mounts the pane once the server has the capability", async () => {
    versionState.version = { capabilities: ["deviceBridge"] };
    renderAt("/settings/emulator");

    expect(await screen.findByText("emulator pane")).toBeTruthy();
    expect(screen.queryByText("settingsEmulatorUnsupportedServer")).toBeNull();
  });

  it("waits for the server version before calling a server unsupported", async () => {
    versionState.version = null;
    versionState.loading = true;
    renderAt("/settings/emulator");
    await act(async () => {});

    expect(screen.queryByText("settingsEmulatorUnsupportedServer")).toBeNull();
    expect(screen.queryByText("emulator pane")).toBeNull();
    expect(screen.getByText("loading")).toBeTruthy();
  });
});
