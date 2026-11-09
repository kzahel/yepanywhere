// @vitest-environment jsdom

import type {
  ProjectQueueItemSummary,
  ProjectQueueRecoveredSessionQueueSummary,
} from "@yep-anywhere/shared";
import { SERVER_CAPABILITIES } from "@yep-anywhere/shared";
import { PROJECT_CODE_NAMES_CAPABILITY } from "@yep-anywhere/shared";
import { PROJECT_NAMES_CAPABILITY } from "@yep-anywhere/shared";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import queueStyles from "../../components/ProjectQueueSection.module.css";
import { I18nProvider } from "../../i18n";
import { invalidateLocalStorageValues } from "../../lib/localStorageValue";
import { UI_KEYS } from "../../lib/storageKeys";
import { PROJECT_QUEUE_CAPABILITY } from "@yep-anywhere/shared";
import { ProjectsPage } from "../ProjectsPage";

const state = vi.hoisted(() => ({
  projects: [
    {
      id: "project-1",
      name: "Alpha",
      codeName: "alp",
      path: "/tmp/alpha",
      sessionCount: 2,
      activeOwnedCount: 0,
      activeExternalCount: 0,
      lastActivity: null,
    },
  ],
  queueItems: [] as ProjectQueueItemSummary[],
  recoveredSessionQueues: [] as ProjectQueueRecoveredSessionQueueSummary[],
  projectStatusesByProject: {},
  dispatchState: { status: "running" as const },
  resumeRecoveredItem: vi.fn(),
  deleteRecoveredItem: vi.fn(),
  inboxCountsByProject: new Map<
    string,
    { needsAttention: number; active: number; total: number }
  >(),
  version: { capabilities: [] as string[] } as {
    capabilities?: string[];
    remoteCompatibilityLevel?: number;
  },
  isRemoteClient: false,
  loading: false,
  error: null as Error | null,
  mockUseProjectQueues: vi.fn(),
  refetch: vi.fn(),
  updateProjectCodeName: vi.fn(),
  addProject: vi.fn(),
  navigate: vi.fn(),
  username: null as string | null,
}));

vi.mock("../../api/client", () => ({
  api: {
    addProject: state.addProject,
    deleteProject: vi.fn(),
    updateProjectCodeName: state.updateProjectCodeName,
  },
}));

vi.mock("react-router-dom", async () => {
  const actual =
    await vi.importActual<typeof import("react-router-dom")>(
      "react-router-dom",
    );
  return { ...actual, useNavigate: () => state.navigate };
});

vi.mock("../../lib/clientSummaryStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/clientSummaryStore")>()),
  useInboxCountsByProject: () => state.inboxCountsByProject,
}));

vi.mock("../../contexts/SourceRuntimeContext", () => ({
  useCurrentSourceRuntime: () => ({
    transport: {
      capabilities: { sameOriginUrls: true },
      fetch: vi.fn(),
    },
  }),
}));

vi.mock("../../hooks/useProjects", () => ({
  useProjects: () => ({
    projects: state.projects,
    loading: state.loading,
    error: state.error,
    refetch: state.refetch,
  }),
}));

vi.mock("../../hooks/useProjectQueues", () => ({
  useProjectQueues: (projectIds: readonly string[]) => {
    state.mockUseProjectQueues(projectIds);
    return {
      queuesByProject: { "project-1": state.queueItems },
      items: state.queueItems,
      projectStatusesByProject: state.projectStatusesByProject,
      recoveredSessionQueues: state.recoveredSessionQueues,
      loading: false,
      error: null,
      mutatingItemId: null,
      mutatingRecoveredQueueId: null,
      mutatingDispatchState: false,
      mutatingPromoteItemId: null,
      dispatchState: state.dispatchState,
      refetch: vi.fn(),
      pauseDispatch: vi.fn(),
      resumeDispatch: vi.fn(),
      promoteNow: vi.fn(),
      updateItem: vi.fn(),
      deleteItem: vi.fn(),
      resumeRecoveredItem: state.resumeRecoveredItem,
      deleteRecoveredItem: state.deleteRecoveredItem,
      retryItem: vi.fn(),
      moveItemToTop: vi.fn(),
    };
  },
}));

vi.mock("../../hooks/useVersion", () => ({
  useVersion: () => ({ version: state.version }),
}));

vi.mock("../../hooks/useActingPrincipal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useActingPrincipal")>()),
  useActingPrincipal: () => ({
    principal: { username: state.username, superuser: state.username === null },
    resolved: true,
  }),
}));

vi.mock("../../lib/connection", () => ({
  isRemoteClient: () => state.isRemoteClient,
}));

vi.mock("../../hooks/useRemoteBasePath", () => ({
  useRemoteBasePath: () => "",
}));

vi.mock("../../layouts", () => ({
  MainContent: ({ children }: { children: ReactNode }) => (
    <main>{children}</main>
  ),
  useNavigationLayout: () => ({
    openSidebar: vi.fn(),
    isWideScreen: true,
    toggleSidebar: vi.fn(),
    isSidebarCollapsed: false,
  }),
}));

vi.mock("../../components/PageHeader", () => ({
  PageHeader: ({ title }: { title: string }) => <header>{title}</header>,
}));

vi.mock("../../components/ProjectSessionDefaultsModal", () => ({
  ProjectSessionDefaultsModal: () => <div>Project defaults modal</div>,
}));

function makeItem(status: ProjectQueueItemSummary["status"]) {
  return {
    id: "queue-1",
    projectId: "project-1" as ProjectQueueItemSummary["projectId"],
    target: { type: "existing-session", sessionId: "session-abcdef" },
    messagePreview: "Queued project work",
    message: { text: "Queued project work" },
    createdAt: "2026-06-27T00:00:00.000Z",
    updatedAt: "2026-06-27T00:00:00.000Z",
    status,
    attachmentCount: 0,
  } satisfies ProjectQueueItemSummary;
}

function makeRecoveredItem(): ProjectQueueRecoveredSessionQueueSummary {
  return {
    id: "recovered-1",
    sessionId: "session-recovered",
    projectId:
      "project-1" as ProjectQueueRecoveredSessionQueueSummary["projectId"],
    content: "Recovered project work",
    timestamp: "2026-06-30T00:00:00.000Z",
    queuedAt: "2026-06-30T00:00:00.000Z",
    createdAt: "2026-06-30T00:00:00.000Z",
    updatedAt: "2026-06-30T00:00:00.000Z",
    kind: "patient",
    status: "paused-after-restart",
  };
}

describe("ProjectsPage", () => {
  beforeEach(() => {
    localStorage.clear();
    invalidateLocalStorageValues();
    state.queueItems = [makeItem("queued")];
    state.recoveredSessionQueues = [];
    state.projectStatusesByProject = {};
    state.dispatchState = { status: "running" };
    state.resumeRecoveredItem.mockReset();
    state.deleteRecoveredItem.mockReset();
    state.inboxCountsByProject = new Map();
    state.version = { capabilities: [PROJECT_QUEUE_CAPABILITY] };
    state.isRemoteClient = false;
    state.loading = false;
    state.error = null;
    state.mockUseProjectQueues.mockReset();
    state.refetch.mockReset();
    state.updateProjectCodeName.mockReset();
    state.updateProjectCodeName.mockResolvedValue({ assignments: [] });
    state.addProject.mockReset();
    state.navigate.mockReset();
    state.username = null;
  });

  function renderProjectsPage() {
    return render(
      <I18nProvider>
        <MemoryRouter>
          <ProjectsPage />
        </MemoryRouter>
      </I18nProvider>,
    );
  }

  it("retains the page header and cached projects through failed reads", () => {
    state.error = new Error("Connection unavailable");
    renderProjectsPage();
    expect(screen.getByText("Projects", { selector: "header" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Alpha/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(state.refetch).toHaveBeenCalledTimes(1);
  });

  it("mounts the page header during cold loading", () => {
    state.loading = true;
    renderProjectsPage();
    expect(screen.getByText("Projects", { selector: "header" })).toBeTruthy();
  });

  it("explains personal removal only when the connected server guarantees it", () => {
    state.username = "archer";
    state.version = { capabilities: ["personal-project-hiding"] };
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const rendered = renderProjectsPage();
    fireEvent.click(
      screen.getByRole("button", { name: "Remove from my projects" }),
    );
    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining("administrator retains"),
    );
    rendered.unmount();
    state.version = { capabilities: [] };
    renderProjectsPage();
    expect(
      screen.queryByRole("button", { name: "Remove from my projects" }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remove project" }));
    expect(confirm).toHaveBeenLastCalledWith(
      expect.stringContaining("YA's project list"),
    );
    confirm.mockRestore();
  });

  it("adds a project by path alone and opens a new session in it", async () => {
    state.addProject.mockResolvedValue({
      project: { id: "project-2", name: "beta-repo", path: "/tmp/beta-repo" },
    });
    renderProjectsPage();
    fireEvent.click(screen.getByRole("button", { name: "Add Project" }));
    // Without the server capability the form is path-only.
    expect(screen.queryByRole("textbox", { name: "Name" })).toBe(null);
    fireEvent.change(screen.getByRole("textbox", { name: "Project path" }), {
      target: { value: "/tmp/beta-repo" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => {
      expect(state.navigate).toHaveBeenCalledWith(
        "/new-session?projectId=project-2",
      );
    });
    expect(state.addProject).toHaveBeenCalledWith("/tmp/beta-repo", {
      name: undefined,
      codeName: undefined,
    });
  });

  it("lets the user choose a name and code that follow the path until edited", async () => {
    state.version = {
      capabilities: [
        PROJECT_QUEUE_CAPABILITY,
        PROJECT_CODE_NAMES_CAPABILITY,
        PROJECT_NAMES_CAPABILITY,
      ],
    };
    act(() => {
      localStorage.setItem(UI_KEYS.projectCodeNamesEnabled, "true");
      invalidateLocalStorageValues(UI_KEYS.projectCodeNamesEnabled);
    });
    state.addProject.mockResolvedValue({
      project: { id: "project-2", name: "Beta", path: "/tmp/beta-repo" },
    });
    renderProjectsPage();
    fireEvent.click(screen.getByRole("button", { name: "Add Project" }));

    const path = screen.getByRole("textbox", { name: "Project path" });
    const name = screen.getByRole("textbox", { name: "Name" });
    const code = screen.getByRole("textbox", { name: "Code" });
    fireEvent.change(path, { target: { value: "/tmp/beta-repo/" } });
    expect(name).toHaveProperty("value", "beta-repo");
    expect(code).toHaveProperty("value", "bet");

    // The chosen name feeds the default code; an edited code stands alone.
    fireEvent.change(name, { target: { value: "Gamma" } });
    expect(code).toHaveProperty("value", "gam");
    fireEvent.change(code, { target: { value: "gm" } });
    fireEvent.change(name, { target: { value: "Beta" } });
    expect(code).toHaveProperty("value", "gm");

    // A field left empty returns to its default once it loses focus.
    fireEvent.change(code, { target: { value: "" } });
    expect(code).toHaveProperty("value", "");
    fireEvent.blur(code);
    expect(code).toHaveProperty("value", "bet");
    fireEvent.change(code, { target: { value: "bta" } });

    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => {
      expect(state.navigate).toHaveBeenCalledWith(
        "/new-session?projectId=project-2",
      );
    });
    expect(state.addProject).toHaveBeenCalledWith("/tmp/beta-repo/", {
      name: "Beta",
      codeName: "bta",
    });
  });

  it("lets the user erase a default name and type a replacement key by key", async () => {
    state.version = {
      capabilities: [
        PROJECT_QUEUE_CAPABILITY,
        PROJECT_CODE_NAMES_CAPABILITY,
        PROJECT_NAMES_CAPABILITY,
      ],
    };
    act(() => {
      localStorage.setItem(UI_KEYS.projectCodeNamesEnabled, "true");
      invalidateLocalStorageValues(UI_KEYS.projectCodeNamesEnabled);
    });
    state.addProject.mockResolvedValue({
      project: { id: "project-2", name: "Sketch", path: "/tmp/my-project" },
    });
    renderProjectsPage();
    fireEvent.click(screen.getByRole("button", { name: "Add Project" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Project path" }), {
      target: { value: "/tmp/my-project" },
    });
    const name = screen.getByRole("textbox", {
      name: "Name",
    }) as HTMLInputElement;
    const code = screen.getByRole("textbox", { name: "Code" });
    fireEvent.focus(name);

    // Each keystroke edits whatever the field shows at that moment.
    for (const _ of "my-project") {
      fireEvent.change(name, { target: { value: name.value.slice(0, -1) } });
    }
    expect(name.value).toBe("");
    for (const key of "Sketch") {
      fireEvent.change(name, { target: { value: name.value + key } });
    }
    expect(name.value).toBe("Sketch");
    expect(code).toHaveProperty("value", "ske");

    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => {
      expect(state.addProject).toHaveBeenCalledWith("/tmp/my-project", {
        name: "Sketch",
        codeName: undefined,
      });
    });
  });

  it("submits an emptied name as the path's default", async () => {
    state.version = {
      capabilities: [PROJECT_QUEUE_CAPABILITY, PROJECT_NAMES_CAPABILITY],
    };
    state.addProject.mockResolvedValue({
      project: { id: "project-2", name: "beta-repo", path: "/tmp/beta-repo" },
    });
    renderProjectsPage();
    fireEvent.click(screen.getByRole("button", { name: "Add Project" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Project path" }), {
      target: { value: "/tmp/beta-repo" },
    });
    const name = screen.getByRole("textbox", { name: "Name" });
    fireEvent.change(name, { target: { value: "" } });
    expect(name).toHaveProperty("value", "");

    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => {
      expect(state.addProject).toHaveBeenCalledWith("/tmp/beta-repo", {
        name: undefined,
        codeName: undefined,
      });
    });
  });

  it("rejects an invalid code before sending anything", () => {
    state.version = {
      capabilities: [
        PROJECT_QUEUE_CAPABILITY,
        PROJECT_CODE_NAMES_CAPABILITY,
        PROJECT_NAMES_CAPABILITY,
      ],
    };
    act(() => {
      localStorage.setItem(UI_KEYS.projectCodeNamesEnabled, "true");
      invalidateLocalStorageValues(UI_KEYS.projectCodeNamesEnabled);
    });
    renderProjectsPage();
    fireEvent.click(screen.getByRole("button", { name: "Add Project" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Project path" }), {
      target: { value: "/tmp/beta-repo" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Code" }), {
      target: { value: "no spaces" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(state.addProject).not.toHaveBeenCalled();
    expect(
      screen
        .getByRole("textbox", { name: "Code" })
        .getAttribute("aria-invalid"),
    ).toBe("true");
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    invalidateLocalStorageValues();
  });

  it("renders project queue items and project card queue counts", () => {
    render(
      <I18nProvider>
        <MemoryRouter>
          <ProjectsPage />
        </MemoryRouter>
      </I18nProvider>,
    );

    expect(screen.getByRole("heading", { name: "Project Queue" })).toBeTruthy();
    expect(screen.getByText("Queued project work")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
    expect(
      screen.getByRole("img", { name: "Project Queue items: 1" }).textContent,
    ).toBe("1");
  });

  it("marks projects whose first queue item is paused", () => {
    state.queueItems = [makeItem("failed")];

    render(
      <I18nProvider>
        <MemoryRouter>
          <ProjectsPage />
        </MemoryRouter>
      </I18nProvider>,
    );

    expect(
      screen.getByRole("img", { name: "Project Queue items: 1" }).textContent,
    ).toBe("1");
    expect(
      screen.getByLabelText(
        "Project Queue item needs attention. Review or retry it in Project Queue.",
      ),
    ).toBeTruthy();
  });

  it("wires recovered queue actions through the Projects page", () => {
    state.queueItems = [];
    state.recoveredSessionQueues = [makeRecoveredItem()];

    render(
      <I18nProvider>
        <MemoryRouter>
          <ProjectsPage />
        </MemoryRouter>
      </I18nProvider>,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Resume recovered queued message",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Delete recovered queued message",
      }),
    );

    expect(state.resumeRecoveredItem).toHaveBeenCalledWith(
      "session-recovered",
      "recovered-1",
    );
    expect(state.deleteRecoveredItem).toHaveBeenCalledWith(
      "session-recovered",
      "recovered-1",
    );
  });

  it("highlights a queue item from the query string", () => {
    render(
      <I18nProvider>
        <MemoryRouter initialEntries={["/projects?queueItem=queue-1"]}>
          <ProjectsPage />
        </MemoryRouter>
      </I18nProvider>,
    );

    const highlighted = document.querySelector(
      '[data-project-queue-item-id="queue-1"]',
    );
    expect(highlighted?.className).toContain(queueStyles.itemHighlighted);
  });

  it("gates the project settings button on its server capability", () => {
    const { rerender } = render(
      <I18nProvider>
        <MemoryRouter>
          <ProjectsPage />
        </MemoryRouter>
      </I18nProvider>,
    );

    expect(
      screen.queryByRole("button", { name: "Open project settings" }),
    ).toBe(null);

    state.version = {
      capabilities: [
        PROJECT_QUEUE_CAPABILITY,
        SERVER_CAPABILITIES.projectService.name,
      ],
    };
    rerender(
      <I18nProvider>
        <MemoryRouter>
          <ProjectsPage />
        </MemoryRouter>
      </I18nProvider>,
    );
    expect(
      screen.getByRole("button", { name: "Open project settings" }),
    ).toBeTruthy();
  });

  it("keeps inline code-name editing opt-in and saves exact values", async () => {
    const { rerender } = render(
      <I18nProvider>
        <MemoryRouter>
          <ProjectsPage />
        </MemoryRouter>
      </I18nProvider>,
    );

    expect(screen.queryByRole("button", { name: "Edit code name" })).toBe(null);
    expect(screen.queryByText("alp")).toBe(null);

    act(() => {
      localStorage.setItem(UI_KEYS.projectCodeNamesEnabled, "true");
      invalidateLocalStorageValues(UI_KEYS.projectCodeNamesEnabled);
    });
    rerender(
      <I18nProvider>
        <MemoryRouter>
          <ProjectsPage />
        </MemoryRouter>
      </I18nProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit code name" }));
    const input = screen.getByRole("textbox", { name: "Project code name" });
    fireEvent.change(input, { target: { value: "alpha-code" } });
    fireEvent.blur(input);

    await waitFor(() => {
      expect(state.updateProjectCodeName).toHaveBeenCalledWith(
        "project-1",
        "alpha-code",
      );
    });
    expect(state.refetch).toHaveBeenCalledOnce();
  });
});
