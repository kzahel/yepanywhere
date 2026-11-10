// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type {
  GitStatusInfo,
  GitWorkingTreeFile,
  GitWorktreeDirectory,
} from "@yep-anywhere/shared";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectWorktreePauseContext } from "../hooks/useProjectWorktree";
import { asClientSummarySourceKey } from "../lib/clientSummaryStore";
import type { YaSourceRuntime } from "../lib/sourceRuntime";
import { SourceRuntimeProvider } from "../lib/sourceRuntimeReact";
import { FakeSourceTransport } from "../lib/transport";

vi.mock("../components/FileRevisionLink", () => ({
  FileRevisionLink: () => null,
}));
vi.mock("react-router-dom", async (orig) => ({
  ...(await orig<typeof import("react-router-dom")>()),
  useNavigate: () => vi.fn(),
}));
vi.mock("../hooks/useRemoteBasePath", () => ({
  useRemoteBasePath: () => "",
}));
vi.mock("../hooks/useServerSettings", () => ({
  useServerSettings: () => ({ settings: {}, isLoading: false, error: null }),
}));
vi.mock("../i18n", async (orig) => ({
  ...(await orig<typeof import("../i18n")>()),
  useI18n: () => ({ t: (key: string) => key }),
}));

const listGitWorkingTreeFiles = vi.fn();
const getGitBlame = vi.fn();
const getFile = vi.fn();
const listReviewComments = vi.fn();
vi.mock("../api/client", () => ({
  api: {
    listGitWorkingTreeFiles: (...args: unknown[]) =>
      listGitWorkingTreeFiles(...args),
    getFile: (...args: unknown[]) => getFile(...args),
    getFileRawUrl: () => "/raw/file",
    getGitBlame: (...args: unknown[]) => getGitBlame(...args),
    listReviewComments: (...args: unknown[]) => listReviewComments(...args),
  },
}));

import { BlameBrowser } from "./BlameBrowser";

const t = (key: string) => key;

function createRuntime(
  transport: FakeSourceTransport,
  sourceKey: string,
): YaSourceRuntime {
  return {
    sourceKey: asClientSummarySourceKey(sourceKey),
    transport,
    api: {} as YaSourceRuntime["api"],
    summary: {} as YaSourceRuntime["summary"],
    sessionDetails: {} as YaSourceRuntime["sessionDetails"],
  };
}

function withRuntime(runtime: YaSourceRuntime, children: ReactNode): ReactNode {
  return (
    <SourceRuntimeProvider runtime={runtime}>
      <MemoryRouter>{children}</MemoryRouter>
    </SourceRuntimeProvider>
  );
}

async function emitWorktreeSnapshot(
  transport: FakeSourceTransport,
  files: GitWorkingTreeFile[],
  directories?: GitWorktreeDirectory[],
  inventory?: { truncated?: boolean; totalFiles?: number },
): Promise<void> {
  await waitFor(() =>
    expect(transport.getSubscriptions("worktree").length).toBeGreaterThan(0),
  );
  const subscription = transport.getSubscriptions("worktree").at(-1);
  if (!subscription) throw new Error("Expected worktree subscription");
  act(() => {
    transport.emitSubscriptionEvent(subscription.id, "git-worktree-snapshot", {
      type: "git-worktree-snapshot",
      generation: {
        epoch: "test-epoch",
        sequence: transport.getSubscriptions("worktree").length - 1,
      },
      coverage: subscription.coverage,
      headSha: "head-a",
      baseSha: "base-a",
      files,
      ...(directories ? { directories } : {}),
      truncated: inventory?.truncated ?? false,
      ...(inventory?.totalFiles === undefined
        ? {}
        : { totalFiles: inventory.totalFiles }),
      timestamp: "2026-08-19T00:00:00.000Z",
    });
  });
}

describe("BlameBrowser", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("opens the first visible file in the wide master-detail view", async () => {
    listGitWorkingTreeFiles.mockResolvedValue({
      files: ["src/first.ts", "src/second.ts"].map((path) => ({
        path,
        tracked: true,
      })),
      truncated: false,
    });
    getGitBlame.mockResolvedValue({
      path: "src/first.ts",
      rev: "HEAD",
      lines: [],
      truncated: false,
    });
    getFile.mockResolvedValue({
      metadata: {
        path: "src/first.ts",
        size: 0,
        mimeType: "text/plain",
        isText: true,
      },
      content: "",
      rawUrl: "/raw/src/first.ts",
    });
    listReviewComments.mockResolvedValue({
      comments: [],
      batches: [],
      pendingCount: 0,
    });

    render(
      <MemoryRouter>
        <BlameBrowser projectId="p1" isWideScreen={true} t={t} />
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(getFile.mock.calls[0]?.slice(0, 2)).toEqual([
        "p1",
        "src/first.ts",
      ]),
    );
    const row = document.querySelector<HTMLButtonElement>(
      "[data-source-blame-item][data-source-selected]",
    );
    expect(row).not.toBeNull();
    if (!row) throw new Error("Expected selected file row");
    fireEvent.contextMenu(row, { clientX: 32, clientY: 40 });
    expect(await screen.findByRole("menu")).toBeDefined();
    expect(
      screen.getByRole("menuitem", { name: "sourceOpenFile" }),
    ).toBeDefined();
    expect(
      screen.getByRole("menuitem", { name: "sourceCopyPath" }),
    ).toBeDefined();
    expect(
      screen.getAllByRole("separator", {
        name: "sourceResizeFilePane",
      }),
    ).toHaveLength(2);
  });

  it("finds a tracked file beyond the old 500-row rendering limit", async () => {
    const files = Array.from(
      { length: 650 },
      (_, index) => `src/file-${index.toString().padStart(3, "0")}.ts`,
    );
    const tail = "src/file-649.ts";
    listGitWorkingTreeFiles.mockResolvedValue({
      files: files.map((path) => ({ path, tracked: true })),
      truncated: false,
    });
    getGitBlame.mockResolvedValue({
      path: files[0],
      rev: "HEAD",
      lines: [],
      truncated: false,
    });
    getFile.mockResolvedValue({
      metadata: {
        path: files[0],
        size: 0,
        mimeType: "text/plain",
        isText: true,
      },
      content: "",
      rawUrl: `/raw/${files[0]}`,
    });
    listReviewComments.mockResolvedValue({
      comments: [],
      batches: [],
      pendingCount: 0,
    });

    render(
      <MemoryRouter>
        <BlameBrowser projectId="p1" isWideScreen={false} t={t} />
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByPlaceholderText("sourceFilterFiles"), {
      target: { value: "file-649" },
    });

    await waitFor(() =>
      expect(
        document.querySelector(`[data-source-path="${tail}"]`),
      ).not.toBeNull(),
    );
    expect(screen.queryByText("sourceFilesTruncated")).toBeNull();
  });

  it("browses current dirty and unchanged content through optional live sections", async () => {
    const transport = new FakeSourceTransport();
    const runtime = createRuntime(transport, "test:blame-browser-live");
    const groupedCleanFiles = Array.from(
      { length: 12 },
      (_, index) =>
        `packages/client/file-${index.toString().padStart(3, "0")}.ts`,
    );
    const currentFiles: GitWorkingTreeFile[] = [
      { path: "README.md", tracked: true, kind: "tracked" },
      { path: "notes/new.txt", tracked: false, kind: "untracked" },
      ...groupedCleanFiles.map((path) => ({
        path,
        tracked: true,
        kind: "tracked" as const,
      })),
      {
        path: "src/live.ts",
        tracked: true,
        kind: "tracked",
        worktreeChanges: [
          {
            status: "M",
            staged: false,
            linesAdded: 1,
            linesDeleted: 0,
          },
        ],
      },
    ];
    getFile.mockImplementation((_projectId: string, path: string) =>
      Promise.resolve({
        metadata: {
          path,
          size: path.length,
          mimeType: "text/plain",
          isText: true,
        },
        content: `contents:${path}`,
        rawUrl: `/raw/${path}`,
      }),
    );
    getGitBlame.mockResolvedValue({
      path: "README.md",
      rev: "HEAD",
      lines: [],
      truncated: false,
    });
    listReviewComments.mockResolvedValue({
      comments: [],
      batches: [],
      pendingCount: 0,
    });
    const status: GitStatusInfo = {
      isGitRepo: true,
      branch: "main",
      upstream: "origin/main",
      ahead: 0,
      behind: 0,
      isClean: false,
      files: [
        {
          path: "src/live.ts",
          status: "M",
          staged: false,
          linesAdded: 1,
          linesDeleted: 0,
        },
      ],
    };

    render(
      withRuntime(
        runtime,
        <BlameBrowser
          projectId="p1"
          isWideScreen={false}
          status={status}
          supportsWorktreeSections
          t={t}
        />,
      ),
    );

    await emitWorktreeSnapshot(transport, currentFiles);
    expect(transport.getSubscriptions("worktree")).toHaveLength(1);
    expect(transport.getSubscriptions("worktree")[0]).toMatchObject({
      projectId: "p1",
      coverage: { tracked: true, untracked: true, ignored: true },
    });
    expect(listGitWorkingTreeFiles).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: /sourceTrackedFiles/, pressed: true }),
    ).toBeDefined();
    // Locally excluded content (this clone's .git/info/exclude paths) is
    // browsable without asking; .gitignore content never reaches the client.
    expect(
      screen.getByRole("button", {
        name: /sourceIgnoredFiles/,
        pressed: true,
      }),
    ).toBeDefined();
    const packageGroup = (await screen.findByText("packages/client/")).closest(
      "button",
    );
    expect(packageGroup).not.toBeNull();
    if (!packageGroup) throw new Error("Expected packages/client group");
    fireEvent.click(packageGroup);
    expect(
      document.querySelector(
        '[data-source-path="packages/client/file-000.ts"]',
      ),
    ).not.toBeNull();

    const search = screen.getByPlaceholderText("sourceFilterFiles");
    fireEvent.change(search, { target: { value: "output" } });
    expect(screen.queryByText("build/output.txt")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", {
        name: "sourceIgnoredFiles",
        expanded: true,
      }),
    );
    await waitFor(() =>
      expect(transport.getSubscriptions("worktree")).toHaveLength(2),
    );
    expect(transport.getSubscriptions("worktree")[1]).toMatchObject({
      projectId: "p1",
      coverage: { tracked: true, untracked: true, ignored: false },
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: "sourceIgnoredFiles",
        expanded: false,
      }),
    );
    await waitFor(() =>
      expect(transport.getSubscriptions("worktree")).toHaveLength(3),
    );
    expect(transport.getSubscriptions("worktree")[2]).toMatchObject({
      projectId: "p1",
      coverage: { tracked: true, untracked: true, ignored: true },
    });
    await emitWorktreeSnapshot(transport, [
      ...currentFiles,
      {
        path: "build/output.txt",
        tracked: false,
        kind: "ignored",
      },
    ]);
    await waitFor(() =>
      expect(
        document.querySelector('[data-source-path="build/output.txt"]'),
      ).not.toBeNull(),
    );
    fireEvent.change(search, { target: { value: "" } });

    fireEvent.click(packageGroup);
    expect(
      document.querySelector(
        '[data-source-path="packages/client/file-000.ts"]',
      ),
    ).toBeNull();
    fireEvent.click(packageGroup);

    fireEvent.click(screen.getByText("README.md"));
    await waitFor(() =>
      expect(
        getFile.mock.calls.some(
          ([projectId, path]) => projectId === "p1" && path === "README.md",
        ),
      ).toBe(true),
    );
    expect(await screen.findByText("contents:README.md")).toBeDefined();
    expect(getGitBlame).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("radio", { name: "sourceViewBlame" }));
    await waitFor(() =>
      expect(getGitBlame).toHaveBeenCalledWith("p1", "README.md"),
    );
  });

  it("opens and releases filesystem directory prefixes without selecting directory rows", async () => {
    const transport = new FakeSourceTransport();
    const runtime = createRuntime(transport, "test:blame-browser-prefixes");
    listReviewComments.mockResolvedValue({
      comments: [],
      batches: [],
      pendingCount: 0,
    });
    const status: GitStatusInfo = {
      isGitRepo: false,
      branch: null,
      upstream: null,
      ahead: 0,
      behind: 0,
      isClean: true,
      files: [],
    };

    render(
      withRuntime(
        runtime,
        <BlameBrowser
          projectId="p1"
          isWideScreen={false}
          status={status}
          supportsWorktreeSections
          t={t}
        />,
      ),
    );

    await emitWorktreeSnapshot(
      transport,
      [],
      [{ path: "src", pending: true, truncated: false }],
    );
    expect(transport.getSubscriptions("worktree")[0]?.coverage).toEqual({
      tracked: true,
      untracked: true,
      ignored: true,
      expandedPrefixes: [],
    });
    const pendingSrc = screen.getByRole("button", {
      name: "sourceExpandDirectory",
    });
    expect(pendingSrc.querySelector("[class*='groupCount']")).toBeNull();

    const search = screen.getByPlaceholderText("sourceFilterFiles");
    fireEvent.change(search, { target: { value: "src" } });
    expect(
      screen.queryByRole("button", { name: "sourceExpandDirectory" }),
    ).toBeNull();
    fireEvent.change(search, { target: { value: "" } });

    fireEvent.click(
      screen.getByRole("button", { name: "sourceExpandDirectory" }),
    );
    await waitFor(() =>
      expect(transport.getSubscriptions("worktree")).toHaveLength(2),
    );
    expect(transport.getSubscriptions("worktree")[1]?.coverage).toEqual({
      tracked: true,
      untracked: true,
      ignored: true,
      expandedPrefixes: ["src"],
    });
    expect(getFile).not.toHaveBeenCalled();

    await emitWorktreeSnapshot(
      transport,
      [{ path: "src/a.ts", tracked: false, kind: "untracked" }],
      [
        { path: "src", pending: false, truncated: true },
        { path: "src/nested", pending: true, truncated: false },
      ],
    );
    expect(await screen.findByText("a.ts")).toBeDefined();
    const openedSrc = screen.getByRole("button", {
      name: "sourceCollapseDirectory",
    });
    expect(openedSrc.textContent).toContain("1+");
    expect(getFile).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: "sourceExpandDirectory" }),
    );
    await waitFor(() =>
      expect(transport.getSubscriptions("worktree")).toHaveLength(3),
    );
    expect(transport.getSubscriptions("worktree")[2]?.coverage).toEqual({
      tracked: true,
      untracked: true,
      ignored: true,
      expandedPrefixes: ["src", "src/nested"],
    });

    const srcDisclosure = screen
      .getAllByRole("button", { name: "sourceCollapseDirectory" })
      .find((button) => button.textContent?.includes("src/"));
    expect(srcDisclosure).toBeDefined();
    if (!srcDisclosure) throw new Error("Expected open src directory");
    fireEvent.click(srcDisclosure);
    await waitFor(() =>
      expect(transport.getSubscriptions("worktree")).toHaveLength(4),
    );
    expect(transport.getSubscriptions("worktree")[3]?.coverage).toEqual({
      tracked: true,
      untracked: true,
      ignored: true,
      expandedPrefixes: [],
    });
  });

  it("requests the complete opened-directory inventory from a total-count row", async () => {
    const transport = new FakeSourceTransport();
    const runtime = createRuntime(
      transport,
      "test:blame-browser-complete-scan",
    );
    const status: GitStatusInfo = {
      isGitRepo: false,
      branch: null,
      upstream: null,
      ahead: 0,
      behind: 0,
      isClean: true,
      files: [],
    };

    render(
      withRuntime(
        runtime,
        <BlameBrowser
          projectId="p1"
          isWideScreen={false}
          status={status}
          supportsWorktreeSections
          supportsCompleteFilesystemScan
          t={(key, variables) =>
            key === "sourceWorkingTreeShowAll"
              ? `Show all ${variables?.count}`
              : key
          }
        />,
      ),
    );

    await emitWorktreeSnapshot(
      transport,
      [
        { path: "a.txt", tracked: false, kind: "untracked" },
        { path: "b.txt", tracked: false, kind: "untracked" },
      ],
      [],
      { truncated: true, totalFiles: 3 },
    );
    expect(transport.getSubscriptions("worktree")[0]?.coverage).toEqual({
      tracked: true,
      untracked: true,
      ignored: true,
      expandedPrefixes: [],
    });
    expect(screen.getByRole("button", { name: "Show all 3" })).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Show all 3" }));
    await waitFor(() =>
      expect(transport.getSubscriptions("worktree")).toHaveLength(2),
    );
    expect(transport.getSubscriptions("worktree")[1]?.coverage).toEqual({
      tracked: true,
      untracked: true,
      ignored: true,
      expandedPrefixes: [],
      filesystemScan: "complete",
    });
    expect(screen.getByText("sourceWorkingTreeFilesIncomplete")).toBeDefined();

    await emitWorktreeSnapshot(
      transport,
      [
        { path: "a.txt", tracked: false, kind: "untracked" },
        { path: "b.txt", tracked: false, kind: "untracked" },
        { path: "c.txt", tracked: false, kind: "untracked" },
      ],
      [],
      { totalFiles: 3 },
    );
    expect(await screen.findByText("c.txt")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Show all 3" })).toBeNull();
  });

  it("freezes the inventory and releases the live lease while paused", async () => {
    const transport = new FakeSourceTransport();
    const runtime = createRuntime(transport, "test:blame-browser-paused");
    listReviewComments.mockResolvedValue({
      comments: [],
      batches: [],
      pendingCount: 0,
    });
    const renderBrowser = (paused: boolean) =>
      withRuntime(
        runtime,
        <ProjectWorktreePauseContext.Provider value={paused}>
          <BlameBrowser
            projectId="p1"
            isWideScreen={false}
            supportsWorktreeSections
            t={t}
          />
        </ProjectWorktreePauseContext.Provider>,
      );
    const view = render(renderBrowser(false));

    await emitWorktreeSnapshot(transport, [
      { path: "README.md", tracked: true, kind: "tracked" },
    ]);
    expect(await screen.findByText("README.md")).toBeDefined();
    const subscription = transport.getSubscriptions("worktree").at(-1);
    if (!subscription) throw new Error("Expected worktree subscription");
    view.rerender(renderBrowser(true));
    expect(transport.getSubscriptions("worktree")[0]?.closed).toBe(true);

    act(() => {
      transport.emitSubscriptionEvent(
        subscription.id,
        "git-worktree-delta",
        {
          type: "git-worktree-delta",
          generation: { epoch: "test-epoch", sequence: 1 },
          headSha: "head-a",
          baseSha: "base-a",
          changes: [
            {
              changeType: "create",
              path: "notes.txt",
              file: {
                path: "notes.txt",
                tracked: false,
                kind: "untracked",
              },
            },
          ],
          timestamp: "2026-08-19T00:00:01.000Z",
        },
        undefined,
        { allowClosed: true },
      );
    });
    expect(screen.queryByText("notes.txt")).toBeNull();
    expect(transport.getSubscriptions("worktree")).toHaveLength(1);

    view.rerender(renderBrowser(false));
    await waitFor(() =>
      expect(transport.getSubscriptions("worktree")).toHaveLength(2),
    );
    await emitWorktreeSnapshot(transport, [
      { path: "README.md", tracked: true, kind: "tracked" },
      { path: "notes.txt", tracked: false, kind: "untracked" },
    ]);
    expect(await screen.findByText("notes.txt")).toBeDefined();
    expect(transport.getSubscriptions("worktree")[1]?.closed).toBe(false);
  });

  it("keeps the inventory when the translation function identity changes", async () => {
    const transport = new FakeSourceTransport();
    const runtime = createRuntime(transport, "test:blame-browser-translation");
    listReviewComments.mockResolvedValue({
      comments: [],
      batches: [],
      pendingCount: 0,
    });
    const initialT = (key: string) => key;
    const replacementT = (key: string) => key;
    const view = render(
      withRuntime(
        runtime,
        <BlameBrowser
          projectId="p1"
          isWideScreen={false}
          supportsWorktreeSections
          t={initialT}
        />,
      ),
    );

    await emitWorktreeSnapshot(transport, [
      { path: "README.md", tracked: true, kind: "tracked" },
    ]);
    expect(await screen.findByText("README.md")).toBeDefined();
    expect(transport.getSubscriptions("worktree")).toHaveLength(1);
    expect(listGitWorkingTreeFiles).not.toHaveBeenCalled();

    view.rerender(
      withRuntime(
        runtime,
        <BlameBrowser
          projectId="p1"
          isWideScreen={false}
          supportsWorktreeSections
          t={replacementT}
        />,
      ),
    );

    await waitFor(() =>
      expect(transport.getSubscriptions("worktree")).toHaveLength(1),
    );
    expect(screen.getByText("README.md")).toBeDefined();
  });
});
