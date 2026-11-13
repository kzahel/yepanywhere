import {
  PUBLIC_FILE_SHARES_CAPABILITY,
  SERVER_CAPABILITIES,
} from "@yep-anywhere/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { useLocalResourceClick } from "../LocalMediaModal";

const state = vi.hoisted(() => ({
  version: {} as Record<string, unknown>,
  shareStatus: null as { canCreate: boolean } | null,
  getPublicFileShares: vi.fn(),
  createPublicFileShare: vi.fn(),
}));
const runtime = {
  sourceKey: "localhost",
  transport: { fetch: vi.fn(), capabilities: { sameOriginUrls: true } },
  // An absolute path resolves against the registered projects.
  summary: { getSnapshot: () => ({ projects: { entities: new Map() } }) },
};
vi.mock("../../contexts/SourceRuntimeContext", () => ({
  useCurrentSourceRuntime: () => runtime,
}));
vi.mock("../../hooks/useVersion", () => ({
  useRetainedVersionInfo: () => state.version,
}));
vi.mock("../../hooks/usePublicShareStatus", () => ({
  usePublicShareStatus: () => ({ status: state.shareStatus }),
}));
vi.mock("../../hooks/useRemoteBasePath", () => ({
  useRemoteBasePath: () => "",
}));
vi.mock("../../api/client", () => ({
  api: {
    getPublicFileShares: state.getPublicFileShares,
    createPublicFileShare: state.createPublicFileShare,
  },
}));

const PROJECT_ID = "cHJvamVjdA";
const FILE_PATH = "research/_build/paper-canvas.html";
const VIEWER_HREF = `http://localhost:3400/projects/${PROJECT_ID}/file?path=${encodeURIComponent(FILE_PATH)}`;

function Harness() {
  const { handleContextMenu, contextMenuElement } = useLocalResourceClick();
  return (
    <div role="group" onContextMenu={handleContextMenu}>
      <a href={VIEWER_HREF}>{FILE_PATH}</a>
      {contextMenuElement}
    </div>
  );
}

function openMenu() {
  render(
    <I18nProvider>
      <Harness />
    </I18nProvider>,
  );
  fireEvent.contextMenu(screen.getByText(FILE_PATH));
  expect(screen.getByText("Copy viewer link")).toBeTruthy();
}

function version(capabilities: string[]) {
  return {
    // Below 0.7.2, so public file shares are not version-implied.
    current: "0.7.1",
    capabilities,
    artifactViewer: { port: 4402, available: true, locked: false },
  };
}

beforeEach(() => {
  state.version = version([PUBLIC_FILE_SHARES_CAPABILITY]);
  state.shareStatus = { canCreate: true };
  state.getPublicFileShares.mockReset();
  state.createPublicFileShare.mockReset();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});
afterEach(() => {
  cleanup();
});

it("hides Copy public URL from servers without public file shares", () => {
  state.version = version([]);
  openMenu();
  expect(screen.queryByText("Copy public URL")).toBeNull();
});

it("hides Copy public URL when public shares cannot be created", () => {
  state.shareStatus = { canCreate: false };
  openMenu();
  expect(screen.queryByText("Copy public URL")).toBeNull();
});

it("reuses an existing live file share for Copy public URL", async () => {
  state.getPublicFileShares.mockResolvedValue({
    items: [{ shareId: "s1", url: "https://ya.example/share/abc/files" }],
  });
  openMenu();
  fireEvent.click(screen.getByText("Copy public URL"));
  await vi.waitFor(() =>
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      "https://ya.example/share/abc/files",
    ),
  );
  expect(state.getPublicFileShares).toHaveBeenCalledWith(PROJECT_ID, FILE_PATH);
  expect(state.createPublicFileShare).not.toHaveBeenCalled();
});

it("mints a public file share when none exists", async () => {
  state.getPublicFileShares.mockResolvedValue({ items: [] });
  state.createPublicFileShare.mockResolvedValue({
    url: "https://ya.example/share/new/files",
  });
  openMenu();
  fireEvent.click(screen.getByText("Copy public URL"));
  await vi.waitFor(() =>
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      "https://ya.example/share/new/files",
    ),
  );
  expect(state.createPublicFileShare).toHaveBeenCalledWith({
    projectId: PROJECT_ID,
    path: FILE_PATH,
  });
});

it("prefers the project app's public file link over a YA file share", async () => {
  state.version = version([
    PUBLIC_FILE_SHARES_CAPABILITY,
    SERVER_CAPABILITIES.projectService.name,
  ]);
  runtime.transport.fetch.mockResolvedValue({
    fileLinks: {
      pathTemplate: "/{path}",
      baseUrl: "https://app.example/?ya_access=tok",
    },
  });
  openMenu();
  await vi.waitFor(() =>
    expect(runtime.transport.fetch).toHaveBeenCalledWith(
      `/projects/${PROJECT_ID}/app`,
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  fireEvent.click(screen.getByText("Copy public URL"));
  await vi.waitFor(() =>
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      `https://app.example/${FILE_PATH}?ya_access=tok`,
    ),
  );
  expect(state.getPublicFileShares).not.toHaveBeenCalled();
  expect(state.createPublicFileShare).not.toHaveBeenCalled();
  runtime.transport.fetch.mockReset();
});

it("offers Copy public URL for an absolute project-file path", async () => {
  const absolutePath = "/home/user/other-project/report.html";
  state.getPublicFileShares.mockResolvedValue({ items: [] });
  state.createPublicFileShare.mockResolvedValue({
    url: "https://ya.example/share/abs/files",
  });
  function AbsoluteHarness() {
    const { handleContextMenu, contextMenuElement } = useLocalResourceClick();
    return (
      <div role="group" onContextMenu={handleContextMenu}>
        <a
          href={`http://localhost:3400/projects/${PROJECT_ID}/file?path=${encodeURIComponent(absolutePath)}`}
        >
          {absolutePath}
        </a>
        {contextMenuElement}
      </div>
    );
  }
  render(
    <I18nProvider>
      <AbsoluteHarness />
    </I18nProvider>,
  );
  fireEvent.contextMenu(screen.getByText(absolutePath));
  fireEvent.click(screen.getByText("Copy public URL"));
  await vi.waitFor(() =>
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      "https://ya.example/share/abs/files",
    ),
  );
  expect(state.createPublicFileShare).toHaveBeenCalledWith({
    projectId: PROJECT_ID,
    path: absolutePath,
  });
});
