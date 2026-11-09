// @vitest-environment jsdom

import type { GitStatusInfo } from "@yep-anywhere/shared";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const stableT = vi.hoisted(() => (key: string) => key);
const sessionRecords = vi.hoisted(
  () =>
    new Map<
      string,
      { title?: string | null; fullTitle?: string | null; customTitle?: string }
    >(),
);

vi.mock("react-router-dom", async (orig) => ({
  ...(await orig<typeof import("react-router-dom")>()),
  useNavigate: () => vi.fn(),
}));
// Provenance is covered at its own component boundary and in browser tests.
vi.mock("../components/FileRevisionLink", () => ({
  FileRevisionLink: () => null,
}));
vi.mock("../hooks/useRemoteBasePath", () => ({
  useRemoteBasePath: () => "",
}));
vi.mock("../i18n", async (orig) => ({
  ...(await orig<typeof import("../i18n")>()),
  useI18n: () => ({ t: stableT }),
}));
vi.mock("../lib/clientSummaryStore", async (orig) => ({
  ...(await orig<typeof import("../lib/clientSummaryStore")>()),
  useClientSummarySourceKey: () => "local",
  getClientSummarySnapshotForSource: () => ({
    sessions: { entities: sessionRecords },
  }),
  reportSessionCollectionTitleSnapshot: (
    _sourceKey: string,
    session: {
      id: string;
      title: string | null;
      fullTitle: string | null;
      customTitle?: string;
    },
  ) => {
    sessionRecords.set(session.id, {
      title: session.title,
      fullTitle: session.fullTitle,
      customTitle: session.customTitle,
    });
  },
}));

const getFile = vi.fn();
const getSessionMetadata = vi.fn();
const getGitDiff = vi.fn();
const getGitUntrackedFolder = vi.fn();
const listGitUntrackedFiles = vi.fn();
const listReviewComments = vi.fn();
const addReviewComment = vi.fn();
vi.mock("../api/client", () => ({
  api: {
    getFile: (...args: unknown[]) => getFile(...args),
    getFileRawUrl: () => "/raw/file",
    getSessionMetadata: (...args: unknown[]) => getSessionMetadata(...args),
    getGitDiff: (...args: unknown[]) => getGitDiff(...args),
    getGitUntrackedFolder: (...args: unknown[]) =>
      getGitUntrackedFolder(...args),
    listGitUntrackedFiles: (...args: unknown[]) =>
      listGitUntrackedFiles(...args),
    listReviewComments: (...args: unknown[]) => listReviewComments(...args),
    addReviewComment: (...args: unknown[]) => addReviewComment(...args),
  },
}));

import { WorkingTreeBrowser } from "./WorkingTreeBrowser";

const t = stableT;

describe("WorkingTreeBrowser", () => {
  beforeEach(() => {
    getSessionMetadata.mockReset();
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
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    sessionRecords.clear();
  });

  it("keeps a clean working tree as the Changes landing", async () => {
    const onBrowseHistory = vi.fn();
    listReviewComments.mockResolvedValue({
      comments: [],
      batches: [],
      pendingCount: 0,
    });

    render(
      <MemoryRouter>
        <WorkingTreeBrowser
          projectId="p1"
          status={{
            isGitRepo: true,
            branch: "main",
            upstream: "origin/main",
            ahead: 0,
            behind: 0,
            isClean: true,
            files: [],
            recentCommits: [
              {
                hash: "0123456789abcdef",
                shortHash: "0123456",
                subject: "Keep the quick check useful",
                authorName: "Kyle",
                authorDate: "2026-07-28T12:00:00.000Z",
              },
            ],
          }}
          isWideScreen={false}
          onBrowseHistory={onBrowseHistory}
          t={t}
        />
      </MemoryRouter>,
    );

    expect(await screen.findByText("gitStatusWorkingTreeClean")).toBeDefined();
    expect(screen.getByText("sourceWorkingTreeCleanDescription")).toBeDefined();
    expect(
      screen.getByRole("button", { name: "sourceCommitHistory" }),
    ).toBeDefined();
    expect(screen.queryByText("gitStatusRecentCommits")).toBeNull();
    expect(screen.queryByText("Keep the quick check useful")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "sourceCommitHistory" }),
    );
    expect(onBrowseHistory).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(listReviewComments).toHaveBeenCalledWith("p1"));
    expect(getGitDiff).not.toHaveBeenCalled();
  });

  it("keeps the workbench visible while untracked files load", async () => {
    listReviewComments.mockResolvedValue({
      comments: [],
      batches: [],
      pendingCount: 0,
    });

    render(
      <MemoryRouter>
        <WorkingTreeBrowser
          projectId="p1"
          status={{
            isGitRepo: true,
            branch: "main",
            upstream: "origin/main",
            ahead: 0,
            behind: 0,
            isClean: true,
            files: [],
            recentCommits: [],
          }}
          isWideScreen={false}
          supportsUntrackedCache
          untrackedFiles={null}
          untrackedLoading
          t={t}
        />
      </MemoryRouter>,
    );

    expect(screen.getByTestId("working-tree-browser")).toBeDefined();
    expect(await screen.findByText("gitStatusLoading")).toBeDefined();
    expect(screen.queryByText("gitStatusWorkingTreeClean")).toBeNull();
    expect(screen.queryByText("sourceNoMatches")).toBeNull();
  });

  it("keeps the workbench visible while live inventory waits for attention", async () => {
    listReviewComments.mockResolvedValue({
      comments: [],
      batches: [],
      pendingCount: 0,
    });

    render(
      <MemoryRouter>
        <WorkingTreeBrowser
          projectId="p1"
          status={{
            isGitRepo: true,
            branch: "main",
            upstream: "origin/main",
            ahead: 0,
            behind: 0,
            isClean: true,
            files: [],
            recentCommits: [],
          }}
          isWideScreen={false}
          inventoryPending
          inventoryLoading
          t={t}
        />
      </MemoryRouter>,
    );

    expect(screen.getByTestId("working-tree-browser")).toBeDefined();
    expect(await screen.findByText("gitStatusLoading")).toBeDefined();
    expect(screen.queryByText("gitStatusWorkingTreeClean")).toBeNull();
  });

  it("keeps the workbench visible when untracked loading fails", async () => {
    listReviewComments.mockResolvedValue({
      comments: [],
      batches: [],
      pendingCount: 0,
    });

    render(
      <MemoryRouter>
        <WorkingTreeBrowser
          projectId="p1"
          status={{
            isGitRepo: true,
            branch: "main",
            upstream: "origin/main",
            ahead: 0,
            behind: 0,
            isClean: true,
            files: [],
            recentCommits: [],
          }}
          isWideScreen={false}
          supportsUntrackedCache
          untrackedFiles={null}
          untrackedError={new Error("untracked inventory unavailable")}
          t={t}
        />
      </MemoryRouter>,
    );

    expect(screen.getByTestId("working-tree-browser")).toBeDefined();
    expect(
      await screen.findByText(
        "gitStatusErrorPrefix untracked inventory unavailable",
      ),
    ).toBeDefined();
    expect(screen.queryByText("gitStatusLoading")).toBeNull();
    expect(screen.queryByText("gitStatusWorkingTreeClean")).toBeNull();
  });

  it("merges staged and unstaged layers into one reviewable Changes row", async () => {
    getGitDiff.mockResolvedValue({
      diffHtml:
        `<pre class="shiki"><code>` +
        `<span class="line line-inserted" data-diff-line="0">+dirty</span>` +
        `</code></pre>`,
      structuredPatch: [
        {
          oldStart: 1,
          oldLines: 0,
          newStart: 1,
          newLines: 1,
          lines: ["+dirty"],
        },
      ],
    });
    listReviewComments.mockResolvedValue({
      comments: [],
      batches: [],
      pendingCount: 0,
    });
    addReviewComment.mockResolvedValue({
      comment: { id: "c1", status: "pending", anchor: {}, text: "x" },
    });

    render(
      <MemoryRouter>
        <WorkingTreeBrowser
          projectId="p1"
          status={{
            isGitRepo: true,
            branch: "main",
            upstream: "origin/main",
            ahead: 0,
            behind: 0,
            isClean: false,
            files: [
              {
                path: "src/dirty.ts",
                status: "M",
                staged: true,
                linesAdded: 1,
                linesDeleted: 0,
              },
              {
                path: "src/dirty.ts",
                status: "M",
                staged: false,
                linesAdded: 1,
                linesDeleted: 1,
              },
            ],
            recentCommits: [],
          }}
          isWideScreen={true}
          t={t}
        />
      </MemoryRouter>,
    );

    expect(await screen.findByText("sourceWorktreePartial")).toBeDefined();
    expect(
      screen.getByText("sourceWorktreePartial").getAttribute("data-tooltip"),
    ).toBe("sourceWorktreePartialDescription");
    expect(screen.queryByText("sourceWorktreeUnstaged")).toBeNull();
    expect(screen.queryByText("sourceWorktreeUntracked")).toBeNull();
    expect(document.querySelectorAll(".commit-file-item")).toHaveLength(1);
    const row = document.querySelector(".commit-file-item");
    expect(row?.getAttribute("data-tooltip")).toBe("src/dirty.ts");
    expect(
      row?.querySelector('[role="img"]')?.getAttribute("data-tooltip"),
    ).toBe("M — sourceFileStatusModified");
    await waitFor(() =>
      expect(getGitDiff).toHaveBeenCalledWith(
        "p1",
        expect.objectContaining({
          path: "src/dirty.ts",
          againstHead: true,
        }),
      ),
    );

    // The diff HTML and its delegated comment listener mount asynchronously.
    await waitFor(() =>
      expect(document.querySelector('[data-diff-line="0"]')).not.toBeNull(),
    );
    fireEvent.click(document.querySelector('[data-diff-line="0"]')!);
    fireEvent.change(await screen.findByRole("textbox"), {
      target: { value: "please revisit" },
    });
    fireEvent.click(screen.getByText("sourceReviewAddToReview"));

    await waitFor(() => expect(addReviewComment).toHaveBeenCalledTimes(1));
    const anchor = addReviewComment.mock.calls[0]?.[1] as {
      revision: { kind: string };
    };
    expect(anchor.revision).toMatchObject({ kind: "uncommitted" });
  });

  it("shows the last-editor session link only behind its capability", async () => {
    sessionRecords.set("session-1", { title: "Fix source navigation" });
    const namedT = (key: string, params?: Record<string, unknown>) =>
      key === "sourceOpenLastEditorSessionNamed"
        ? `Open session: ${String(params?.title)}`
        : key;
    getGitDiff.mockResolvedValue({ diffHtml: "", structuredPatch: [] });
    listReviewComments.mockResolvedValue({
      comments: [],
      batches: [],
      pendingCount: 0,
    });
    const status: GitStatusInfo = {
      isGitRepo: true,
      branch: "main",
      upstream: null,
      ahead: 0,
      behind: 0,
      isClean: false,
      files: [
        {
          path: "src/dirty.ts",
          status: "M",
          staged: false,
          linesAdded: 1,
          linesDeleted: 1,
          lastEditor: {
            sessionId: "session-1",
            observedAt: "2026-08-02T10:00:00.000Z",
          },
        },
      ],
    };

    const rendered = render(
      <MemoryRouter>
        <WorkingTreeBrowser
          projectId="p1"
          status={status}
          isWideScreen={true}
          t={namedT}
        />
      </MemoryRouter>,
    );

    await waitFor(() => expect(getGitDiff).toHaveBeenCalled());
    expect(
      screen.queryByRole("link", { name: "sourceOpenLastEditorSession" }),
    ).toBeNull();

    rendered.rerender(
      <MemoryRouter>
        <WorkingTreeBrowser
          projectId="p1"
          status={status}
          isWideScreen={true}
          t={namedT}
        />
      </MemoryRouter>,
    );

    const link = await screen.findByRole("link", {
      name: "Open session: Fix source navigation",
    });
    expect(link.getAttribute("href")).toBe("/projects/p1/sessions/session-1");

    const row = document.querySelector('[data-source-path="src/dirty.ts"]');
    fireEvent.contextMenu(row?.closest("button") as HTMLButtonElement, {
      clientX: 20,
      clientY: 20,
    });
    expect(
      await screen.findByRole("menuitem", {
        name: "Open session: Fix source navigation",
      }),
    ).toBeDefined();
    expect(getSessionMetadata).not.toHaveBeenCalled();
  });

  it("loads a missing last-editor title into the client catalog once", async () => {
    const namedT = (key: string, params?: Record<string, unknown>) =>
      key === "sourceOpenLastEditorSessionNamed"
        ? `Open session: ${String(params?.title)}`
        : key;
    getSessionMetadata.mockResolvedValue({
      session: {
        id: "session-missing",
        projectId: "p1",
        title: "Fetched editor title",
        fullTitle: "Fetched editor title",
        createdAt: "2026-08-02T09:00:00.000Z",
        updatedAt: "2026-08-02T10:00:00.000Z",
        messageCount: 2,
        provider: "claude",
      },
      ownership: { owner: "none" },
      processState: null,
    });
    getGitDiff.mockResolvedValue({ diffHtml: "", structuredPatch: [] });
    listReviewComments.mockResolvedValue({
      comments: [],
      batches: [],
      pendingCount: 0,
    });

    render(
      <MemoryRouter>
        <WorkingTreeBrowser
          projectId="p1"
          status={{
            isGitRepo: true,
            branch: "main",
            upstream: null,
            ahead: 0,
            behind: 0,
            isClean: false,
            files: [
              {
                path: "src/dirty.ts",
                status: "M",
                staged: false,
                linesAdded: 1,
                linesDeleted: 1,
                lastEditor: {
                  sessionId: "session-missing",
                  observedAt: "2026-08-02T10:00:00.000Z",
                },
              },
            ],
            recentCommits: [],
          }}
          isWideScreen={true}
          t={namedT}
        />
      </MemoryRouter>,
    );

    const row = document.querySelector('[data-source-path="src/dirty.ts"]');
    fireEvent.contextMenu(row?.closest("button") as HTMLButtonElement, {
      clientX: 20,
      clientY: 20,
    });
    expect(
      screen.getByRole("menuitem", { name: "Open session: session-" }),
    ).toBeDefined();
    await waitFor(() =>
      expect(getSessionMetadata).toHaveBeenCalledWith("p1", "session-missing"),
    );
    expect(
      await screen.findByRole("menuitem", {
        name: "Open session: Fetched editor title",
      }),
    ).toBeDefined();
    expect(
      screen.getByRole("link", {
        name: "Open session: Fetched editor title",
      }),
    ).toBeDefined();

    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    fireEvent.contextMenu(row?.closest("button") as HTMLButtonElement, {
      clientX: 20,
      clientY: 20,
    });
    expect(
      screen.getByRole("menuitem", {
        name: "Open session: Fetched editor title",
      }),
    ).toBeDefined();
    expect(getSessionMetadata).toHaveBeenCalledTimes(1);
  });

  it("keeps last-editor links when an untracked folder expands", async () => {
    getGitDiff.mockResolvedValue({ diffHtml: "", structuredPatch: [] });
    getGitUntrackedFolder.mockResolvedValue({
      path: "generated/",
      files: ["generated/a.ts"],
      lastEditors: {
        "generated/a.ts": {
          sessionId: "session-untracked",
          observedAt: "2026-08-02T10:00:00.000Z",
        },
      },
      truncated: false,
      limit: 500,
    });
    listReviewComments.mockResolvedValue({
      comments: [],
      batches: [],
      pendingCount: 0,
    });

    render(
      <MemoryRouter>
        <WorkingTreeBrowser
          projectId="p1"
          status={{
            isGitRepo: true,
            branch: "main",
            upstream: null,
            ahead: 0,
            behind: 0,
            isClean: false,
            files: [
              {
                path: "generated/",
                status: "?",
                staged: false,
                linesAdded: null,
                linesDeleted: null,
              },
            ],
          }}
          isWideScreen={true}
          t={t}
        />
      </MemoryRouter>,
    );

    const link = await screen.findByRole("link", {
      name: "sourceOpenLastEditorSessionNamed",
    });
    expect(link.getAttribute("href")).toBe(
      "/projects/p1/sessions/session-untracked",
    );
  });

  it("preserves an explicit folder disclosure when the status corpus changes", async () => {
    const folderFiles = (path: string) =>
      Array.from(
        { length: 11 },
        (_, index) => `${path}file-${String(index).padStart(2, "0")}.ts`,
      );
    getGitUntrackedFolder.mockImplementation(
      (_projectId: string, path: string) =>
        Promise.resolve({
          path,
          files: folderFiles(path),
          truncated: false,
          limit: 500,
        }),
    );
    listReviewComments.mockResolvedValue({
      comments: [],
      batches: [],
      pendingCount: 0,
    });
    const status = (folders: string[]): GitStatusInfo => ({
      isGitRepo: true,
      branch: "main",
      upstream: null,
      ahead: 0,
      behind: 0,
      isClean: false,
      files: folders.map((path) => ({
        path,
        status: "?",
        staged: false,
        linesAdded: null,
        linesDeleted: null,
      })),
    });
    const rendered = render(
      <MemoryRouter>
        <WorkingTreeBrowser
          projectId="p1"
          status={status(["generated/"])}
          isWideScreen={false}
          t={t}
        />
      </MemoryRouter>,
    );

    fireEvent.click(
      await screen.findByRole("button", {
        name: "sourceExpandUntrackedFolder",
      }),
    );
    expect(await screen.findByText("file-00.ts")).toBeDefined();

    rendered.rerender(
      <MemoryRouter>
        <WorkingTreeBrowser
          projectId="p1"
          status={status(["generated/", "other/"])}
          isWideScreen={false}
          t={t}
        />
      </MemoryRouter>,
    );

    expect(
      await screen.findByRole("button", {
        name: "sourceCollapseUntrackedFolder",
      }),
    ).toBeDefined();
    expect(screen.getByText("file-00.ts")).toBeDefined();
  });

  it("groups large untracked folders and reveals matching loaded children", async () => {
    const files = Array.from(
      { length: 11 },
      (_, index) => `generated/file-${String(index).padStart(2, "0")}.ts`,
    );
    files.push("generated/needle-bootstrap.json");
    getGitUntrackedFolder.mockResolvedValue({
      path: "generated/",
      files,
      truncated: false,
      limit: 500,
    });
    listReviewComments.mockResolvedValue({
      comments: [],
      batches: [],
      pendingCount: 0,
    });
    const detailedT = (key: string, vars?: Record<string, string | number>) =>
      vars ? `${key} ${JSON.stringify(vars)}` : key;

    render(
      <MemoryRouter>
        <WorkingTreeBrowser
          projectId="p1"
          status={{
            isGitRepo: true,
            branch: "main",
            upstream: null,
            ahead: 0,
            behind: 0,
            isClean: false,
            files: [
              {
                path: "generated/",
                status: "?",
                staged: false,
                linesAdded: null,
                linesDeleted: null,
              },
            ],
          }}
          isWideScreen={false}
          t={detailedT}
        />
      </MemoryRouter>,
    );

    const expand = await screen.findByRole("button", {
      name: 'sourceExpandUntrackedFolder {"path":"generated/"}',
    });
    expect(expand.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("file-00.ts")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe(
      'sourceUntrackedFolderScanProgress {"loaded":1,"total":1}',
    );

    fireEvent.click(expand);
    expect(await screen.findByText("file-00.ts")).toBeDefined();
    expect(
      document.querySelector('[data-tooltip="generated/file-00.ts"]'),
    ).not.toBeNull();
    fireEvent.click(
      screen.getByRole("button", {
        name: 'sourceCollapseUntrackedFolder {"path":"generated/"}',
      }),
    );
    expect(screen.queryByText("file-00.ts")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "sourceFilterFiles" }));
    const input = screen.getByPlaceholderText("sourceFilterFiles");
    fireEvent.change(input, { target: { value: "needle" } });

    await waitFor(() =>
      expect(
        document.querySelector(
          '[data-source-path="generated/needle-bootstrap.json"]',
        ),
      ).not.toBeNull(),
    );
    expect(
      screen
        .getByRole("button", {
          name: 'sourceCollapseUntrackedFolder {"path":"generated/"}',
        })
        .getAttribute("aria-expanded"),
    ).toBe("true");

    fireEvent.change(input, { target: { value: "" } });
    expect(screen.queryByText("needle-bootstrap.json")).toBeNull();
  });

  it("loads a cached large folder only when expanded", async () => {
    listGitUntrackedFiles.mockResolvedValue({
      files: Array.from(
        { length: 12 },
        (_, index) => `generated/file-${String(index).padStart(2, "0")}.ts`,
      ),
      folders: [],
      total: 12,
      refreshedAt: "2026-08-18T00:00:00.000Z",
      truncated: false,
      limit: 500,
    });
    listReviewComments.mockResolvedValue({
      comments: [],
      batches: [],
      pendingCount: 0,
    });
    const detailedT = (key: string, vars?: Record<string, string | number>) =>
      vars ? `${key} ${JSON.stringify(vars)}` : key;

    render(
      <MemoryRouter>
        <WorkingTreeBrowser
          projectId="p1"
          status={{
            isGitRepo: true,
            branch: "main",
            upstream: null,
            ahead: 0,
            behind: 0,
            isClean: false,
            files: [
              {
                path: "generated/",
                status: "?",
                staged: false,
                linesAdded: null,
                linesDeleted: null,
              },
            ],
          }}
          isWideScreen={false}
          supportsUntrackedCache
          untrackedFiles={{
            files: [],
            folders: [{ path: "generated/", count: 12 }],
            total: 12,
            refreshedAt: "2026-08-18T00:00:00.000Z",
            truncated: false,
            limit: 500,
          }}
          t={detailedT}
        />
      </MemoryRouter>,
    );

    const expand = await screen.findByRole("button", {
      name: 'sourceExpandUntrackedFolder {"path":"generated/"}',
    });
    expect(listGitUntrackedFiles).not.toHaveBeenCalled();
    expect(getGitUntrackedFolder).not.toHaveBeenCalled();

    fireEvent.click(expand);

    await waitFor(() =>
      expect(listGitUntrackedFiles).toHaveBeenCalledWith("p1", {
        path: "generated/",
      }),
    );
    expect(await screen.findByText("file-00.ts")).toBeDefined();
    expect(getGitUntrackedFolder).not.toHaveBeenCalled();
  });

  it("searches cached children without realizing their folder", async () => {
    listGitUntrackedFiles.mockResolvedValue({
      files: ["generated/needle-bootstrap.json"],
      folders: [],
      total: 20,
      refreshedAt: "2026-08-18T00:00:00.000Z",
      truncated: true,
      limit: 500,
    });
    listReviewComments.mockResolvedValue({
      comments: [],
      batches: [],
      pendingCount: 0,
    });

    render(
      <MemoryRouter>
        <WorkingTreeBrowser
          projectId="p1"
          status={{
            isGitRepo: true,
            branch: "main",
            upstream: null,
            ahead: 0,
            behind: 0,
            isClean: false,
            files: [
              {
                path: "generated/",
                status: "?",
                staged: false,
                linesAdded: null,
                linesDeleted: null,
              },
            ],
          }}
          isWideScreen={false}
          supportsUntrackedCache
          untrackedFiles={{
            files: [],
            folders: [{ path: "generated/", count: 20 }],
            total: 20,
            refreshedAt: "2026-08-18T00:00:00.000Z",
            truncated: false,
            limit: 500,
          }}
          t={t}
        />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "sourceFilterFiles" }));
    const input = screen.getByPlaceholderText("sourceFilterFiles");
    fireEvent.change(input, { target: { value: "needle" } });

    await waitFor(() =>
      expect(listGitUntrackedFiles).toHaveBeenCalledWith("p1", { q: "needle" }),
    );
    await waitFor(() =>
      expect(
        document.querySelector(
          '[data-source-path="generated/needle-bootstrap.json"]',
        ),
      ).not.toBeNull(),
    );
    expect(screen.getByText("sourceUntrackedSearchTruncated")).toBeDefined();
    expect(getGitUntrackedFolder).not.toHaveBeenCalled();
    expect(listGitUntrackedFiles).toHaveBeenCalledTimes(1);

    fireEvent.change(input, { target: { value: "" } });
    await waitFor(() =>
      expect(
        document.querySelector(
          '[data-source-path="generated/needle-bootstrap.json"]',
        ),
      ).toBeNull(),
    );
  });

  it("expands many untracked folders without refetching the open diff", async () => {
    const folders = Array.from({ length: 40 }, (_, i) => `gen${i}/`);
    getGitDiff.mockResolvedValue({ diffHtml: "", structuredPatch: [] });
    // Stagger arrivals across several coalescing windows, the way a real
    // repository's folder expansions land: the browser re-merges its rows once
    // per window while the corpus fills in.
    let arrival = 0;
    getGitUntrackedFolder.mockImplementation(
      (_projectId: string, path: string) =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                path,
                files: [`${path}child.ts`],
                truncated: false,
                limit: 500,
              }),
            (arrival++ % 4) * 60,
          ),
        ),
    );
    listReviewComments.mockResolvedValue({
      comments: [],
      batches: [],
      pendingCount: 0,
    });

    render(
      <MemoryRouter>
        <WorkingTreeBrowser
          projectId="p1"
          status={{
            isGitRepo: true,
            branch: "main",
            upstream: null,
            ahead: 0,
            behind: 0,
            isClean: false,
            files: [
              {
                path: "src/tracked.ts",
                status: "M",
                staged: false,
                linesAdded: 3,
                linesDeleted: 1,
              },
              ...folders.map((path) => ({
                path,
                status: "?",
                staged: false,
                linesAdded: null,
                linesDeleted: null,
              })),
            ],
            recentCommits: [],
          }}
          isWideScreen={true}
          t={t}
        />
      </MemoryRouter>,
    );

    await waitFor(
      () => expect(getGitUntrackedFolder).toHaveBeenCalledTimes(folders.length),
      { timeout: 5_000 },
    );
    await waitFor(() =>
      expect(
        document.querySelector('[data-tooltip="gen39/child.ts"]'),
      ).not.toBeNull(),
    );

    // The selected file never changed, so its diff was requested exactly once.
    expect(getGitDiff).toHaveBeenCalledTimes(1);
  });

  it("does not rerender unchanged rows when selection changes", async () => {
    getGitDiff.mockResolvedValue({ diffHtml: "", structuredPatch: [] });
    listReviewComments.mockResolvedValue({
      comments: [],
      batches: [],
      pendingCount: 0,
    });
    let translationCalls = 0;
    const countingT = (key: string) => {
      translationCalls += 1;
      return key;
    };
    const files = Array.from({ length: 400 }, (_, index) => ({
      path: `generated/file-${String(index).padStart(3, "0")}.ts`,
      status: "?",
      staged: false,
      linesAdded: null,
      linesDeleted: null,
    }));

    render(
      <MemoryRouter>
        <WorkingTreeBrowser
          projectId="p1"
          status={{
            isGitRepo: true,
            branch: "main",
            upstream: null,
            ahead: 0,
            behind: 0,
            isClean: false,
            files,
            recentCommits: [],
          }}
          isWideScreen={true}
          t={countingT}
        />
      </MemoryRouter>,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "sourceExpandPathGroup" }),
    );
    await waitFor(() => expect(getFile).toHaveBeenCalledTimes(1));
    const finalPath = document.querySelector(
      '[data-source-path="generated/file-399.ts"]',
    );
    const finalRow = finalPath?.closest(".commit-file-item");
    if (!finalRow) throw new Error("Final generated file row is missing");
    getFile.mockImplementation(() => new Promise(() => {}));
    translationCalls = 0;

    fireEvent.click(finalRow);

    expect(getFile).toHaveBeenCalledTimes(2);
    expect(translationCalls).toBeLessThan(50);
  });

  it("partitions untracked files below tracked changes and opens live contents", async () => {
    getGitDiff.mockResolvedValue({ diffHtml: "", structuredPatch: [] });
    listReviewComments.mockResolvedValue({
      comments: [],
      batches: [],
      pendingCount: 0,
    });

    render(
      <MemoryRouter>
        <WorkingTreeBrowser
          projectId="p1"
          status={{
            isGitRepo: true,
            branch: "main",
            upstream: null,
            ahead: 0,
            behind: 0,
            isClean: false,
            files: [
              {
                path: "src/tracked.ts",
                status: "M",
                staged: false,
                linesAdded: 1,
                linesDeleted: 0,
              },
              {
                path: "generated/untracked.ts",
                status: "?",
                staged: false,
                linesAdded: null,
                linesDeleted: null,
              },
            ],
          }}
          isWideScreen={true}
          t={t}
        />
      </MemoryRouter>,
    );

    const trackedPath = await waitFor(() => {
      const found = document.querySelector(
        '[data-source-path="src/tracked.ts"]',
      );
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    const divider = screen.getByText("sourceUntrackedFiles");
    const untrackedPath = document.querySelector(
      '[data-source-path="generated/untracked.ts"]',
    ) as HTMLElement | null;
    expect(untrackedPath).not.toBeNull();
    expect(
      trackedPath.compareDocumentPosition(divider) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      divider.compareDocumentPosition(untrackedPath as HTMLElement) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    fireEvent.click(untrackedPath as HTMLElement);
    await waitFor(() =>
      expect(getFile).toHaveBeenCalledWith(
        "p1",
        "generated/untracked.ts",
        true,
        undefined,
        undefined,
        "full",
      ),
    );
    expect(
      await screen.findByText("contents:generated/untracked.ts"),
    ).toBeDefined();
    expect(getGitDiff).toHaveBeenCalledTimes(1);
  });

  it("uses only compact staged and untracked state markers", async () => {
    listReviewComments.mockResolvedValue({
      comments: [],
      batches: [],
      pendingCount: 0,
    });

    render(
      <MemoryRouter>
        <WorkingTreeBrowser
          projectId="p1"
          status={{
            isGitRepo: true,
            branch: "main",
            upstream: "origin/main",
            ahead: 0,
            behind: 0,
            isClean: false,
            files: [
              {
                path: "src/staged.ts",
                status: "M",
                staged: true,
                linesAdded: 1,
                linesDeleted: 0,
              },
              {
                path: "src/unstaged.ts",
                status: "M",
                staged: false,
                linesAdded: 1,
                linesDeleted: 0,
              },
              {
                path: "src/untracked.ts",
                status: "?",
                staged: false,
                linesAdded: null,
                linesDeleted: null,
              },
            ],
            recentCommits: [],
          }}
          isWideScreen={false}
          t={t}
        />
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(
        document.querySelector('[data-source-path="src/staged.ts"]'),
      ).not.toBeNull(),
    );
    const stagedRow = document
      .querySelector('[data-source-path="src/staged.ts"]')
      ?.closest(".commit-file-item");
    if (!stagedRow) throw new Error("Staged file row is missing");
    expect(stagedRow.querySelector(".worktree-file-state")?.textContent).toBe(
      "✓",
    );
    expect(
      stagedRow
        .querySelector(".worktree-file-state")
        ?.getAttribute("data-tooltip"),
    ).toBe("sourceWorktreeStaged");
    expect(
      document
        .querySelector('[data-source-path="src/unstaged.ts"]')
        ?.closest(".commit-file-item")
        ?.querySelector(".worktree-file-state"),
    ).toBeNull();
    const untrackedRow = document
      .querySelector('[data-source-path="src/untracked.ts"]')
      ?.closest(".commit-file-item");
    if (!untrackedRow) throw new Error("Untracked file row is missing");
    expect(untrackedRow.querySelector(".worktree-file-state")).toBeNull();
    expect(
      untrackedRow.querySelector('[role="img"]')?.getAttribute("data-tooltip"),
    ).toBe("? — sourceFileStatusUntracked");
  });

  it("filters dirty and expanded untracked files by path", async () => {
    listReviewComments.mockResolvedValue({
      comments: [],
      batches: [],
      pendingCount: 0,
    });

    render(
      <MemoryRouter>
        <WorkingTreeBrowser
          projectId="p1"
          status={{
            isGitRepo: true,
            branch: "main",
            upstream: "origin/main",
            ahead: 0,
            behind: 0,
            isClean: false,
            files: [
              {
                path: "src/keep.ts",
                status: "M",
                staged: false,
                linesAdded: 1,
                linesDeleted: 0,
              },
              {
                path: "scratch/drop.txt",
                status: "?",
                staged: false,
                linesAdded: null,
                linesDeleted: null,
              },
            ],
            recentCommits: [],
          }}
          isWideScreen={false}
          t={t}
        />
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(
        document.querySelector('[data-source-path="src/keep.ts"]'),
      ).not.toBeNull(),
    );
    await waitFor(() => expect(listReviewComments).toHaveBeenCalledWith("p1"));
    fireEvent.click(screen.getByRole("button", { name: "sourceFilterFiles" }));
    const input = screen.getByPlaceholderText("sourceFilterFiles");
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: "keep" } });

    expect(
      document.querySelector('[data-source-path="src/keep.ts"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-source-path="scratch/drop.txt"]'),
    ).toBeNull();
    fireEvent.change(input, { target: { value: "missing" } });
    expect(screen.getByText("sourceNoMatches")).toBeDefined();
  });

  it("explains an empty ignore-whitespace projection", async () => {
    getGitDiff.mockResolvedValue({
      diffHtml: '<pre class="shiki"><code class="language-ts"></code></pre>',
      structuredPatch: [],
    });
    listReviewComments.mockResolvedValue({
      comments: [],
      batches: [],
      pendingCount: 0,
    });

    render(
      <MemoryRouter>
        <WorkingTreeBrowser
          projectId="p1"
          status={{
            isGitRepo: true,
            branch: "main",
            upstream: "origin/main",
            ahead: 0,
            behind: 0,
            isClean: false,
            files: [
              {
                path: "src/spaces.ts",
                status: "M",
                staged: false,
                linesAdded: 1,
                linesDeleted: 1,
              },
            ],
            recentCommits: [],
          }}
          isWideScreen={true}
          ignoreWhitespace
          t={t}
        />
      </MemoryRouter>,
    );

    expect(
      await screen.findByText("gitStatusWhitespaceChangesHidden"),
    ).toBeDefined();
  });

  it("opens a selected phone change in the full-screen diff viewer", async () => {
    getGitDiff.mockResolvedValue({
      diffHtml: "<pre><code>+dirty</code></pre>",
      structuredPatch: [],
    });
    listReviewComments.mockResolvedValue({
      comments: [],
      batches: [],
      pendingCount: 0,
    });

    render(
      <MemoryRouter>
        <WorkingTreeBrowser
          projectId="p1"
          status={{
            isGitRepo: true,
            branch: "main",
            upstream: "origin/main",
            ahead: 0,
            behind: 0,
            isClean: false,
            files: [
              {
                path: "src/mobile.ts",
                status: "M",
                staged: false,
                linesAdded: 1,
                linesDeleted: 0,
              },
            ],
            recentCommits: [],
          }}
          isWideScreen={false}
          t={t}
        />
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(
        document.querySelector('[data-source-path="src/mobile.ts"]'),
      ).not.toBeNull(),
    );
    fireEvent.click(
      document
        .querySelector('[data-source-path="src/mobile.ts"]')!
        .closest("button")!,
    );

    expect(await screen.findByRole("dialog")).toBeDefined();
    expect(screen.queryByText("sourceWorktreeUnstaged")).toBeNull();
  });

  it("preserves an open comment draft while status refreshes the diff", async () => {
    addReviewComment.mockResolvedValue({
      comment: { id: "c1", status: "pending", anchor: {}, text: "test" },
    });
    listReviewComments.mockResolvedValue({
      comments: [],
      batches: [],
      pendingCount: 0,
    });
    getGitDiff.mockResolvedValue({
      diffHtml:
        `<pre class="shiki"><code>` +
        `<span class="line line-inserted" data-diff-line="0">+dirty</span>` +
        `</code></pre>`,
      structuredPatch: [
        {
          oldStart: 1,
          oldLines: 0,
          newStart: 1,
          newLines: 1,
          lines: ["+dirty"],
        },
      ],
    });
    const status = (linesAdded: number): GitStatusInfo => ({
      isGitRepo: true,
      branch: "main",
      upstream: "origin/main",
      ahead: 0,
      behind: 0,
      isClean: false,
      files: [
        {
          path: "src/dirty.ts",
          status: "M",
          staged: false,
          linesAdded,
          linesDeleted: 0,
        },
      ],
      recentCommits: [],
    });
    const view = (nextStatus: ReturnType<typeof status>) => (
      <MemoryRouter>
        <WorkingTreeBrowser
          projectId="p1"
          status={nextStatus}
          isWideScreen={true}
          t={t}
        />
      </MemoryRouter>
    );
    const { rerender } = render(view(status(1)));

    await waitFor(() =>
      expect(document.querySelector('[data-diff-line="0"]')).not.toBeNull(),
    );
    fireEvent.click(document.querySelector('[data-diff-line="0"]')!);
    fireEvent.change(await screen.findByRole("textbox"), {
      target: { value: "test" },
    });
    getGitDiff.mockClear();
    getGitDiff.mockResolvedValueOnce({
      diffHtml:
        `<pre class="shiki"><code>` +
        `<span class="line line-inserted" data-diff-line="0">+dirty changed</span>` +
        `</code></pre>`,
      structuredPatch: [
        {
          oldStart: 1,
          oldLines: 0,
          newStart: 1,
          newLines: 1,
          lines: ["+dirty changed"],
        },
      ],
    });

    rerender(view(status(2)));

    expect(getGitDiff).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
      "test",
    );
    await waitFor(() =>
      expect(
        document.querySelector('[data-diff-line="0"]')?.textContent,
      ).toContain("dirty changed"),
    );

    getGitDiff.mockClear();
    rerender(
      view({
        ...status(0),
        isClean: true,
        files: [],
      }),
    );

    expect(getGitDiff).not.toHaveBeenCalled();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
      "test",
    );
    fireEvent.click(screen.getByText("sourceReviewAddToReview"));
    await waitFor(() => expect(addReviewComment).toHaveBeenCalledTimes(1));
    const capturedAnchor = addReviewComment.mock.calls[0]?.[1] as {
      snippet: string;
      revision: { kind: string; savedAt?: string };
    };
    expect(capturedAnchor.snippet).toBe("dirty");
    expect(capturedAnchor.revision).toMatchObject({
      kind: "uncommitted",
      savedAt: expect.any(String),
    });
  });

  it.each([true, false])(
    "keeps Markdown preview and relative scroll through dirty refreshes (wide=%s)",
    async (isWideScreen) => {
      getGitDiff
        .mockResolvedValueOnce({
          diffHtml: "<pre><code>+dirty</code></pre>",
          structuredPatch: [
            {
              oldStart: 1,
              oldLines: 0,
              newStart: 1,
              newLines: 1,
              lines: ["+first rendered dirty file"],
            },
          ],
          markdownHtml: "<p>first rendered dirty file</p>",
        })
        .mockResolvedValueOnce({
          diffHtml: "<pre><code>+dirty again</code></pre>",
          structuredPatch: [
            {
              oldStart: 1,
              oldLines: 0,
              newStart: 1,
              newLines: 1,
              lines: ["+second rendered dirty file"],
            },
          ],
          markdownHtml: "<p>second rendered dirty file</p>",
        })
        .mockResolvedValueOnce({
          diffHtml: "<pre><code>+dirty once more</code></pre>",
          structuredPatch: [
            {
              oldStart: 1,
              oldLines: 0,
              newStart: 1,
              newLines: 1,
              lines: ["+third rendered dirty file"],
            },
          ],
          markdownHtml: "<p>third rendered dirty file</p>",
        });
      listReviewComments.mockResolvedValue({
        comments: [],
        batches: [],
        pendingCount: 0,
      });
      const dirtyStatus = (linesAdded: number): GitStatusInfo => ({
        isGitRepo: true,
        branch: "main",
        upstream: "origin/main",
        ahead: 0,
        behind: 0,
        isClean: false,
        files: [
          {
            path: "notes/live.md",
            status: "M",
            staged: false,
            linesAdded,
            linesDeleted: 0,
          },
        ],
        recentCommits: [],
      });
      const cleanStatus: GitStatusInfo = {
        ...dirtyStatus(0),
        isClean: true,
        files: [],
      };
      const view = (status: GitStatusInfo) => (
        <MemoryRouter>
          <WorkingTreeBrowser
            projectId="p1"
            status={status}
            isWideScreen={isWideScreen}
            t={t}
          />
        </MemoryRouter>
      );
      const scrollHeightDescriptor = Object.getOwnPropertyDescriptor(
        Element.prototype,
        "scrollHeight",
      );
      const clientHeightDescriptor = Object.getOwnPropertyDescriptor(
        Element.prototype,
        "clientHeight",
      );
      Object.defineProperty(Element.prototype, "scrollHeight", {
        configurable: true,
        get() {
          const text = this.textContent ?? "";
          if (text.includes("third rendered")) return 2_600;
          if (text.includes("second rendered")) return 1_800;
          return 1_000;
        },
      });
      Object.defineProperty(Element.prototype, "clientHeight", {
        configurable: true,
        get: () => 200,
      });

      try {
        const rendered = render(view(dirtyStatus(1)));
        if (!isWideScreen) {
          fireEvent.click(
            document
              .querySelector('[data-source-path="notes/live.md"]')!
              .closest("button")!,
          );
        }
        fireEvent.click(
          await screen.findByRole("button", { name: "gitStatusPreview" }),
        );
        expect(
          screen
            .getByRole("button", { name: "gitStatusDiff" })
            .getAttribute("aria-pressed"),
        ).toBe("true");
        const scrollRootSelector = isWideScreen
          ? ".git-diff-preview-body"
          : ".modal-content";
        const firstScrollRoot =
          document.querySelector<HTMLElement>(scrollRootSelector);
        if (!firstScrollRoot) throw new Error("Diff scroll root is missing");
        firstScrollRoot.scrollTop = 400;

        rendered.rerender(view(dirtyStatus(2)));
        await waitFor(() =>
          expect(
            document.querySelector<HTMLElement>(scrollRootSelector)?.scrollTop,
          ).toBe(800),
        );

        rendered.rerender(view(cleanStatus));
        await screen.findByText("gitStatusWorkingTreeClean");
        rendered.rerender(view(dirtyStatus(3)));
        if (!isWideScreen) {
          fireEvent.click(
            document
              .querySelector('[data-source-path="notes/live.md"]')!
              .closest("button")!,
          );
        }

        expect(
          await screen.findByRole("button", { name: "gitStatusDiff" }),
        ).toBeDefined();
        await waitFor(() =>
          expect(
            document.querySelector<HTMLElement>(scrollRootSelector)?.scrollTop,
          ).toBe(1_200),
        );
      } finally {
        if (scrollHeightDescriptor) {
          Object.defineProperty(
            Element.prototype,
            "scrollHeight",
            scrollHeightDescriptor,
          );
        } else {
          delete (Element.prototype as { scrollHeight?: number }).scrollHeight;
        }
        if (clientHeightDescriptor) {
          Object.defineProperty(
            Element.prototype,
            "clientHeight",
            clientHeightDescriptor,
          );
        } else {
          delete (Element.prototype as { clientHeight?: number }).clientHeight;
        }
      }
    },
  );

  it.each([false, true])(
    "opens the exact Edit-linked dirty file (wide=%s)",
    async (isWideScreen) => {
      getGitDiff.mockResolvedValue({
        diffHtml:
          `<pre class="shiki"><code>` +
          `<span class="line line-inserted" data-diff-line="0">+target</span>` +
          `</code></pre>`,
        structuredPatch: [
          {
            oldStart: 1,
            oldLines: 0,
            newStart: 1,
            newLines: 1,
            lines: ["+target"],
          },
        ],
      });
      listReviewComments.mockResolvedValue({
        comments: [],
        batches: [],
        pendingCount: 0,
      });

      render(
        <MemoryRouter>
          <WorkingTreeBrowser
            projectId="p1"
            status={{
              isGitRepo: true,
              branch: "main",
              upstream: "origin/main",
              ahead: 0,
              behind: 0,
              isClean: false,
              files: [
                {
                  path: "src/other.ts",
                  status: "M",
                  staged: false,
                  linesAdded: 1,
                  linesDeleted: 0,
                },
                {
                  path: "src/target.ts",
                  status: "M",
                  staged: false,
                  linesAdded: 1,
                  linesDeleted: 0,
                },
              ],
              recentCommits: [],
            }}
            isWideScreen={isWideScreen}
            initialWorkingTreePath="src/target.ts"
            t={t}
          />
        </MemoryRouter>,
      );

      await waitFor(() =>
        expect(getGitDiff).toHaveBeenCalledWith(
          "p1",
          expect.objectContaining({
            path: "src/target.ts",
            againstHead: true,
          }),
        ),
      );
      expect(document.querySelector(".modal") !== null).toBe(!isWideScreen);
    },
  );
});
