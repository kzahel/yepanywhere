// @vitest-environment jsdom

import type { GitStatusInfo } from "@yep-anywhere/shared";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const stableT = vi.hoisted(() => (key: string) => key);

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
// The nested diff renderer now reads translations from context as well.
vi.mock("../i18n", async (orig) => ({
  ...(await orig<typeof import("../i18n")>()),
  useI18n: () => ({ t: stableT }),
}));

const getGitCommits = vi.fn();
const getGitCommit = vi.fn();
const getGitCommitDiff = vi.fn();
const getGitComparison = vi.fn();
const getGitComparisonDiff = vi.fn();
const getGitInclusiveComparison = vi.fn();
const getGitInclusiveComparisonDiff = vi.fn();
const getGitBlame = vi.fn();
const getGitDiff = vi.fn();
const getGitUntrackedFolder = vi.fn();
const getGitCommitSearchManifest = vi.fn();
const getGitCommitSearchRecords = vi.fn();
const listReviewComments = vi.fn();
const addReviewComment = vi.fn();
vi.mock("../api/client", () => ({
  api: {
    getGitCommits: (...args: unknown[]) => getGitCommits(...args),
    getGitCommit: (...args: unknown[]) => getGitCommit(...args),
    getGitCommitDiff: (...args: unknown[]) => getGitCommitDiff(...args),
    getGitComparison: (...args: unknown[]) => getGitComparison(...args),
    getGitComparisonDiff: (...args: unknown[]) => getGitComparisonDiff(...args),
    getGitInclusiveComparison: (...args: unknown[]) =>
      getGitInclusiveComparison(...args),
    getGitInclusiveComparisonDiff: (...args: unknown[]) =>
      getGitInclusiveComparisonDiff(...args),
    getGitBlame: (...args: unknown[]) => getGitBlame(...args),
    getGitDiff: (...args: unknown[]) => getGitDiff(...args),
    getGitUntrackedFolder: (...args: unknown[]) =>
      getGitUntrackedFolder(...args),
    getGitCommitSearchManifest: (...args: unknown[]) =>
      getGitCommitSearchManifest(...args),
    getGitCommitSearchRecords: (...args: unknown[]) =>
      getGitCommitSearchRecords(...args),
    listReviewComments: (...args: unknown[]) => listReviewComments(...args),
    addReviewComment: (...args: unknown[]) => addReviewComment(...args),
  },
}));

import { CommitBrowser } from "./CommitBrowser";

const SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);
const DIRECT_SHA = "c".repeat(40);
const t = stableT;

function dirtyStatus(): GitStatusInfo {
  return {
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
        linesAdded: 1,
        linesDeleted: 0,
      },
    ],
    recentCommits: [],
  };
}

function cleanStatus(): GitStatusInfo {
  return {
    ...dirtyStatus(),
    isClean: true,
    files: [],
  };
}

function installScrollIntoViewMock() {
  const original = Element.prototype.scrollIntoView;
  const mock = vi.fn();
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: mock,
  });
  return {
    fn: mock,
    restore() {
      if (original) {
        Object.defineProperty(Element.prototype, "scrollIntoView", {
          configurable: true,
          value: original,
        });
      } else {
        delete (Element.prototype as { scrollIntoView?: unknown })
          .scrollIntoView;
      }
    },
  };
}

function sourcePath(path: string): Element | undefined {
  return Array.from(document.querySelectorAll("[data-source-path]")).find(
    (element) => element.getAttribute("data-source-path") === path,
  );
}

async function findSourcePath(path: string): Promise<Element> {
  await waitFor(() => expect(sourcePath(path)).toBeDefined());
  return sourcePath(path)!;
}

function primeApis() {
  const firstCommit = {
    hash: SHA,
    shortHash: "aaaaaaa",
    subject: "first commit",
    authorName: "Dev",
    authorDate: "2026-07-26T00:00:00Z",
  };
  getGitCommits.mockResolvedValue({
    commits: [firstCommit],
    hasMore: false,
  });
  getGitCommit.mockResolvedValue({
    hash: SHA,
    shortHash: "aaaaaaa",
    subject: "first commit",
    authorName: "Dev",
    authorDate: "2026-07-26T00:00:00Z",
    body: "",
    files: [
      {
        path: "src/x.ts",
        status: "M",
        staged: false,
        linesAdded: 1,
        linesDeleted: 0,
      },
    ],
  });
  getGitCommitDiff.mockResolvedValue({
    diffHtml:
      `<pre class="shiki"><code>` +
      `<span class="line line-inserted" data-diff-line="0">+hi</span>` +
      `</code></pre>`,
    structuredPatch: [
      { oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: ["+hi"] },
    ],
  });
  getGitComparison.mockResolvedValue({
    baseSha: SHA,
    headSha: HEAD_SHA,
    files: [
      {
        path: "src/x.ts",
        status: "M",
        staged: false,
        linesAdded: 2,
        linesDeleted: 1,
      },
    ],
  });
  getGitInclusiveComparison.mockResolvedValue({
    selectedSha: SHA,
    baseSha: DIRECT_SHA,
    headSha: HEAD_SHA,
    files: [
      {
        path: "src/cumulative.ts",
        status: "M",
        staged: false,
        linesAdded: 2,
        linesDeleted: 1,
      },
    ],
  });
  getGitInclusiveComparisonDiff.mockResolvedValue({
    diffHtml:
      `<pre class="shiki"><code>` +
      `<span class="line line-inserted" data-diff-line="0">+inclusive</span>` +
      `</code></pre>`,
    structuredPatch: [
      {
        oldStart: 1,
        oldLines: 0,
        newStart: 1,
        newLines: 1,
        lines: ["+inclusive"],
      },
    ],
  });
  getGitComparisonDiff.mockResolvedValue({
    diffHtml:
      `<pre class="shiki"><code>` +
      `<span class="line line-inserted" data-diff-line="0">+cumulative</span>` +
      `</code></pre>`,
    structuredPatch: [
      {
        oldStart: 1,
        oldLines: 0,
        newStart: 1,
        newLines: 1,
        lines: ["+cumulative"],
      },
    ],
  });
  getGitBlame.mockResolvedValue({
    path: "src/x.ts",
    rev: SHA,
    lines: [
      {
        line: 1,
        sha: DIRECT_SHA,
        shortSha: DIRECT_SHA.slice(0, 7),
        author: "Dev",
        authorTime: "2026-07-25T00:00:00Z",
        summary: "origin",
        content: "const x = 1;",
        uncommitted: false,
      },
    ],
    truncated: false,
  });
  listReviewComments.mockResolvedValue({
    comments: [],
    batches: [],
    pendingCount: 0,
  });
}

describe("CommitBrowser", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("lists commits, opens a commit's files, and fetches the file diff", async () => {
    primeApis();
    render(
      <MemoryRouter>
        <CommitBrowser projectId="p1" isWideScreen={true} t={t} />
      </MemoryRouter>,
    );

    await screen.findByText("first commit");
    // Wide screen auto-selects the newest commit → its files load.
    await findSourcePath("src/x.ts");
    // …and auto-selects the first file → the commit diff is fetched.
    await waitFor(() =>
      expect(getGitCommitDiff).toHaveBeenCalledWith(
        "p1",
        expect.objectContaining({ sha: SHA, path: "src/x.ts", status: "M" }),
      ),
    );
  });

  it("opens a directly linked file within the selected commit", async () => {
    primeApis();
    getGitCommit.mockResolvedValue({
      hash: SHA,
      shortHash: "aaaaaaa",
      subject: "first commit",
      authorName: "Dev",
      authorDate: "2026-07-26T00:00:00Z",
      body: "",
      files: [
        {
          path: "src/first.ts",
          status: "M",
          staged: false,
          linesAdded: 1,
          linesDeleted: 0,
        },
        {
          path: "src/linked.ts",
          status: "M",
          staged: false,
          linesAdded: 1,
          linesDeleted: 0,
        },
      ],
    });

    render(
      <MemoryRouter>
        <CommitBrowser
          projectId="p1"
          isWideScreen={true}
          initialSha={SHA}
          initialPath="src/linked.ts"
          t={t}
        />
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(
        document.querySelector('[data-source-path="src/linked.ts"]'),
      ).not.toBeNull(),
    );
    expect(
      document
        .querySelector(".commit-file-item.selected")
        ?.querySelector("[data-source-path]")
        ?.getAttribute("data-source-path"),
    ).toBe("src/linked.ts");
    await waitFor(() =>
      expect(getGitCommitDiff).toHaveBeenCalledWith(
        "p1",
        expect.objectContaining({ path: "src/linked.ts" }),
      ),
    );
  });

  it("keeps a direct blame-hash revision selected beyond the recent page", async () => {
    primeApis();
    getGitCommit.mockResolvedValue({
      hash: DIRECT_SHA,
      shortHash: "ccccccc",
      subject: "older blamed commit",
      authorName: "Older Dev",
      authorDate: "2025-01-01T00:00:00Z",
      body: "",
      files: [],
    });

    render(
      <MemoryRouter>
        <CommitBrowser
          projectId="p1"
          isWideScreen={true}
          initialSha={DIRECT_SHA}
          t={t}
        />
      </MemoryRouter>,
    );

    expect(await screen.findAllByText("older blamed commit")).toHaveLength(2);
    expect(getGitCommit).toHaveBeenCalledWith("p1", DIRECT_SHA);
    expect(
      document.querySelector(".commit-list-item.selected")?.textContent,
    ).toContain("ccccccc");
  });

  it("toggles an inclusive selected-commit-through-HEAD comparison", async () => {
    primeApis();
    render(
      <MemoryRouter>
        <CommitBrowser projectId="p1" isWideScreen={true} t={t} />
      </MemoryRouter>,
    );

    await findSourcePath("src/x.ts");
    fireEvent.click(
      screen.getByRole("button", { name: "sourceCompareToHead" }),
    );

    expect(await findSourcePath("src/cumulative.ts")).toBeDefined();
    expect(getGitInclusiveComparison).toHaveBeenCalledWith("p1", SHA);
    await waitFor(() =>
      expect(getGitInclusiveComparisonDiff).toHaveBeenCalledWith(
        "p1",
        expect.objectContaining({
          baseSha: DIRECT_SHA,
          headSha: HEAD_SHA,
          path: "src/cumulative.ts",
          status: "M",
        }),
      ),
    );
    expect(
      screen
        .getByRole("button", { name: "sourceCompareToHead" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("keeps the selected file when switching to the inclusive comparison", async () => {
    primeApis();
    getGitInclusiveComparison.mockResolvedValue({
      selectedSha: SHA,
      baseSha: DIRECT_SHA,
      headSha: HEAD_SHA,
      files: [
        {
          path: "src/other.ts",
          status: "M",
          staged: false,
          linesAdded: 1,
          linesDeleted: 0,
        },
        {
          path: "src/x.ts",
          status: "M",
          staged: false,
          linesAdded: 2,
          linesDeleted: 1,
        },
      ],
    });
    render(
      <MemoryRouter>
        <CommitBrowser projectId="p1" isWideScreen={true} t={t} />
      </MemoryRouter>,
    );

    await findSourcePath("src/x.ts");
    fireEvent.click(
      screen.getByRole("button", { name: "sourceCompareToHead" }),
    );

    await waitFor(() =>
      expect(getGitInclusiveComparisonDiff).toHaveBeenCalledWith(
        "p1",
        expect.objectContaining({ path: "src/x.ts" }),
      ),
    );
    expect(
      document
        .querySelector(".commit-file-item.selected")
        ?.querySelector("[data-source-path]")
        ?.getAttribute("data-source-path"),
    ).toBe("src/x.ts");
  });

  it("keeps direct selected-tree comparison as a labelled per-file action", async () => {
    primeApis();
    render(
      <MemoryRouter>
        <CommitBrowser projectId="p1" isWideScreen={true} t={t} />
      </MemoryRouter>,
    );

    await findSourcePath("src/x.ts");
    const filePath = document.querySelector('[data-source-path="src/x.ts"]');
    const fileButton = filePath?.closest("button");
    expect(fileButton).not.toBeNull();
    fireEvent.contextMenu(fileButton as HTMLButtonElement, {
      clientX: 20,
      clientY: 20,
    });
    fireEvent.click(
      await screen.findByRole("menuitem", {
        name: "sourceCompareFileTreeToHead",
      }),
    );

    expect(getGitComparison).toHaveBeenCalledWith("p1", SHA);
    await waitFor(() =>
      expect(getGitComparisonDiff).toHaveBeenCalledWith(
        "p1",
        expect.objectContaining({
          baseSha: SHA,
          headSha: HEAD_SHA,
          path: "src/x.ts",
        }),
      ),
    );
    expect(getGitInclusiveComparison).not.toHaveBeenCalled();
  });

  it("returns to the ordinary commit diff when a projection request fails", async () => {
    primeApis();
    getGitInclusiveComparison.mockRejectedValueOnce(
      new Error("server is stale"),
    );

    const onProjectionRequestFailure = vi.fn();
    render(
      <MemoryRouter>
        <CommitBrowser
          projectId="p1"
          isWideScreen={true}
          onProjectionRequestFailure={onProjectionRequestFailure}
          t={t}
        />
      </MemoryRouter>,
    );

    await findSourcePath("src/x.ts");
    fireEvent.click(
      screen.getByRole("button", { name: "sourceCompareToHead" }),
    );

    await waitFor(() =>
      expect(onProjectionRequestFailure).toHaveBeenCalledWith(
        expect.objectContaining({ message: "server is stale" }),
      ),
    );

    expect(sourcePath("src/x.ts")).toBeDefined();
    expect(
      screen
        .getByRole("button", { name: "sourceCompareToHead" })
        .getAttribute("aria-pressed"),
    ).toBe("false");
  });

  it("returns to the commit diff when a direct per-file projection fails", async () => {
    primeApis();
    getGitComparisonDiff.mockRejectedValueOnce(new Error("server is stale"));

    const onProjectionRequestFailure = vi.fn();
    render(
      <MemoryRouter>
        <CommitBrowser
          projectId="p1"
          isWideScreen={true}
          onProjectionRequestFailure={onProjectionRequestFailure}
          t={t}
        />
      </MemoryRouter>,
    );

    await findSourcePath("src/x.ts");
    await waitFor(() => expect(getGitCommitDiff).toHaveBeenCalled());
    getGitCommitDiff.mockClear();
    const filePath = document.querySelector('[data-source-path="src/x.ts"]');
    const fileButton = filePath?.closest("button");
    expect(fileButton).not.toBeNull();
    fireEvent.contextMenu(fileButton as HTMLButtonElement, {
      clientX: 20,
      clientY: 20,
    });
    fireEvent.click(
      await screen.findByRole("menuitem", {
        name: "sourceCompareFileTreeToHead",
      }),
    );

    await waitFor(() =>
      expect(onProjectionRequestFailure).toHaveBeenCalledWith(
        expect.objectContaining({ message: "server is stale" }),
      ),
    );

    await waitFor(() => expect(getGitCommitDiff).toHaveBeenCalled());
    expect(getGitInclusiveComparison).not.toHaveBeenCalled();
  });

  it("requests the whitespace projection for the active commit diff", async () => {
    primeApis();
    render(
      <MemoryRouter>
        <CommitBrowser
          projectId="p1"
          isWideScreen={true}
          ignoreWhitespace
          t={t}
        />
      </MemoryRouter>,
    );

    await findSourcePath("src/x.ts");
    await waitFor(() =>
      expect(getGitCommitDiff).toHaveBeenCalledWith(
        "p1",
        expect.objectContaining({
          sha: SHA,
          path: "src/x.ts",
          ignoreWhitespace: true,
        }),
      ),
    );
  });

  it("filters the selected commit's files from an expandable search", async () => {
    primeApis();
    getGitCommit.mockResolvedValue({
      hash: SHA,
      shortHash: "aaaaaaa",
      subject: "first commit",
      authorName: "Dev",
      authorDate: "2026-07-26T00:00:00Z",
      body: "",
      files: [
        {
          path: "test/drop.test.ts",
          status: "M",
          staged: false,
          linesAdded: 1,
          linesDeleted: 0,
        },
        {
          origPath: "legacy/original.ts",
          path: "src/keep.ts",
          status: "R",
          staged: false,
          linesAdded: 1,
          linesDeleted: 0,
        },
      ],
    });

    render(
      <MemoryRouter>
        <CommitBrowser projectId="p1" isWideScreen={true} t={t} />
      </MemoryRouter>,
    );

    await findSourcePath("test/drop.test.ts");
    await waitFor(() =>
      expect(document.querySelector('[data-diff-line="0"]')).not.toBeNull(),
    );
    getGitCommitDiff.mockResolvedValueOnce({
      diffHtml:
        `<pre class="shiki"><code>` +
        `<span class="line line-inserted" data-diff-line="0">+keep</span>` +
        `</code></pre>`,
      structuredPatch: [
        {
          oldStart: 1,
          oldLines: 0,
          newStart: 1,
          newLines: 1,
          lines: ["+keep"],
        },
      ],
    });
    fireEvent.click(screen.getByRole("button", { name: "sourceFilterFiles" }));
    fireEvent.change(screen.getByPlaceholderText("sourceFilterFiles"), {
      target: { value: "legacy" },
    });

    expect(
      document.querySelector(
        '[data-source-path="legacy/original.ts → src/keep.ts"]',
      ),
    ).not.toBeNull();
    expect(screen.queryByText("test/drop.test.ts")).toBeNull();
    await waitFor(() =>
      expect(getGitCommitDiff).toHaveBeenCalledWith(
        "p1",
        expect.objectContaining({ path: "src/keep.ts" }),
      ),
    );
    await waitFor(() =>
      expect(document.querySelector('[data-diff-line="0"]')?.textContent).toBe(
        "+keep",
      ),
    );
  });

  it("pins the shared Working tree browser above commit history", async () => {
    primeApis();
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

    render(
      <MemoryRouter>
        <CommitBrowser
          projectId="p1"
          status={dirtyStatus()}
          isWideScreen={true}
          t={t}
        />
      </MemoryRouter>,
    );

    expect(await screen.findByTestId("working-tree-browser")).toBeDefined();
    const workingTreeRow = document.querySelector(".commit-list-working-tree");
    expect(workingTreeRow?.textContent).toContain("sourceUncommitted");
    expect(workingTreeRow?.textContent).toContain("sourceChangedFileCount");
    const workingTreeLink = workingTreeRow?.querySelector("a");
    await waitFor(() => expect(document.activeElement).toBe(workingTreeLink));
    fireEvent.keyDown(workingTreeLink!, { key: "Enter" });
    const workingTreeFile = await findSourcePath("src/dirty.ts");
    await waitFor(() =>
      expect(document.activeElement).toBe(workingTreeFile.closest("button")),
    );
    await waitFor(() =>
      expect(getGitDiff).toHaveBeenCalledWith(
        "p1",
        expect.objectContaining({
          path: "src/dirty.ts",
          againstHead: true,
        }),
      ),
    );
    expect(getGitCommit).not.toHaveBeenCalled();

    fireEvent.click(await screen.findByText("first commit"));
    await waitFor(() => expect(getGitCommit).toHaveBeenCalledWith("p1", SHA));
  });

  it("opens the newest commit for a clean tree and keeps Working tree selectable", async () => {
    primeApis();

    render(
      <MemoryRouter>
        <CommitBrowser
          projectId="p1"
          status={cleanStatus()}
          isWideScreen={true}
          t={t}
        />
      </MemoryRouter>,
    );

    await waitFor(() => expect(getGitCommit).toHaveBeenCalledWith("p1", SHA));
    const workingTreeRow = document.querySelector(
      ".commit-list-working-tree .commit-list-item",
    ) as HTMLButtonElement;
    const commitRow = document.querySelector(
      ".commit-list-row:not(.commit-list-working-tree) .commit-list-item",
    ) as HTMLButtonElement;
    expect(workingTreeRow.classList.contains("selected")).toBe(false);
    expect(commitRow.classList.contains("selected")).toBe(true);
    expect(screen.getByText("gitStatusClean")).toBeDefined();
    expect(screen.getByText("sourceWorkingTreeCleanDescription")).toBeDefined();
    expect(screen.queryByText("sourceUncommitted")).toBeNull();
    expect(screen.queryByText("gitStatusWorkingTreeClean")).toBeNull();

    fireEvent.click(workingTreeRow);
    expect(workingTreeRow.classList.contains("selected")).toBe(true);
    expect(await screen.findByTestId("working-tree-browser")).toBeDefined();
    expect(await screen.findByText("gitStatusWorkingTreeClean")).toBeDefined();
    expect(screen.getByText("first commit")).toBeDefined();
  });

  it("opens the newest commit for a clean tree on phone", async () => {
    primeApis();

    render(
      <MemoryRouter>
        <CommitBrowser
          projectId="p1"
          status={cleanStatus()}
          isWideScreen={false}
          t={t}
        />
      </MemoryRouter>,
    );

    await waitFor(() => expect(getGitCommit).toHaveBeenCalledWith("p1", SHA));
    expect(screen.queryByText("gitStatusWorkingTreeClean")).toBeNull();
    expect(document.querySelector(".commit-revisions-column")).toBeNull();
  });

  it("keeps clean mobile commit search in the revision list", async () => {
    primeApis();
    getGitCommitSearchManifest.mockResolvedValue({
      head: SHA,
      commits: [
        {
          hash: SHA,
          shortHash: "aaaaaaa",
          subject: "first commit",
          authorName: "Dev",
          authorDate: "2026-07-26T00:00:00Z",
        },
      ],
    });
    getGitCommitSearchRecords.mockResolvedValue({
      records: [{ hash: SHA, deltaText: "" }],
    });
    const historyBack = vi
      .spyOn(window.history, "back")
      .mockImplementation(() => {});

    try {
      render(
        <MemoryRouter>
          <CommitBrowser
            projectId="p1"
            status={cleanStatus()}
            isWideScreen={false}
            t={t}
          />
        </MemoryRouter>,
      );

      await waitFor(() => expect(getGitCommit).toHaveBeenCalledWith("p1", SHA));
      fireEvent.click(
        screen.getByRole("button", { name: "sourceCommitHistory" }),
      );
      expect(historyBack).toHaveBeenCalled();
      act(() => {
        window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
      });

      const search = await screen.findByPlaceholderText("sourceSearchCommits");
      fireEvent.change(search, { target: { value: "f" } });

      const highlighted = await screen.findByText("f", { exact: true });
      expect(highlighted.tagName).toBe("MARK");
      expect(screen.getByPlaceholderText("sourceSearchCommits")).toBeDefined();
      expect(screen.queryByTestId("working-tree-browser")).toBeNull();
    } finally {
      historyBack.mockRestore();
      window.history.replaceState(null, "");
    }
  });

  it("falls back to Working tree when a clean repository has no commits", async () => {
    primeApis();
    getGitCommits.mockResolvedValue({ commits: [], hasMore: false });

    render(
      <MemoryRouter>
        <CommitBrowser
          projectId="p1"
          status={cleanStatus()}
          isWideScreen={true}
          t={t}
        />
      </MemoryRouter>,
    );

    expect(await screen.findByTestId("working-tree-browser")).toBeDefined();
    expect(getGitCommit).not.toHaveBeenCalled();
  });

  it("uses arrow keys to move the focused revision selection", async () => {
    const older = "b".repeat(40);
    primeApis();
    getGitCommits.mockResolvedValue({
      commits: [
        {
          hash: SHA,
          shortHash: "aaaaaaa",
          subject: "first commit",
          authorName: "Dev",
          authorDate: "2026-07-26T00:00:00Z",
        },
        {
          hash: older,
          shortHash: "bbbbbbb",
          subject: "older commit",
          authorName: "Dev",
          authorDate: "2026-07-25T00:00:00Z",
        },
      ],
      hasMore: false,
    });
    getGitCommit.mockImplementation((_projectId: string, sha: string) =>
      Promise.resolve({
        hash: sha,
        shortHash: sha.slice(0, 7),
        subject: sha === SHA ? "first commit" : "older commit",
        authorName: "Dev",
        authorDate: "2026-07-26T00:00:00Z",
        body: "",
        files: [],
      }),
    );

    render(
      <MemoryRouter>
        <CommitBrowser projectId="p1" isWideScreen={true} t={t} />
      </MemoryRouter>,
    );

    const first = (await screen.findByText("first commit")).closest("a");
    const second = screen.getByText("older commit").closest("a");
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    act(() => {
      first?.focus();
    });
    getGitCommit.mockClear();
    act(() => {
      fireEvent.keyDown(first!, { key: "ArrowDown" });
    });

    expect(document.activeElement).toBe(second);
    await waitFor(() => expect(getGitCommit).toHaveBeenCalledWith("p1", older));
  });

  it("gives revision rows focused URLs while selecting plain clicks in place", async () => {
    primeApis();
    const onSelectRevision = vi.fn();
    render(
      <MemoryRouter>
        <CommitBrowser
          projectId="p1"
          status={dirtyStatus()}
          isWideScreen={true}
          revisionHref={(sha) =>
            sha ? `/git-status?rev=${sha}` : "/git-status"
          }
          onSelectRevision={onSelectRevision}
          t={t}
        />
      </MemoryRouter>,
    );

    const row = (await screen.findByText("first commit")).closest("a")!;
    expect(row.getAttribute("href")).toBe(`/git-status?rev=${SHA}`);
    expect(
      document
        .querySelector(".commit-list-working-tree .commit-list-item")
        ?.getAttribute("href"),
    ).toBe("/git-status");

    fireEvent(row, new MouseEvent("auxclick", { bubbles: true, button: 1 }));
    expect(onSelectRevision).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(row);
    });
    expect(onSelectRevision).toHaveBeenCalledWith(SHA);
    await waitFor(() => expect(getGitCommitDiff).toHaveBeenCalled());
  });

  it("opens revision actions by context key or right-click", async () => {
    primeApis();
    render(
      <MemoryRouter>
        <CommitBrowser projectId="p1" isWideScreen={true} t={t} />
      </MemoryRouter>,
    );

    const row = (await screen.findByText("first commit")).closest("a")!;
    const shortcutHelp = screen.getByRole("button", {
      name: "sourceShortcutHelp",
    });
    fireEvent.click(shortcutHelp);
    expect((await screen.findByRole("tooltip")).textContent).toContain(
      "sourceShortcutSearch",
    );
    fireEvent.click(shortcutHelp);
    expect(screen.queryByRole("tooltip")).toBeNull();

    fireEvent.contextMenu(row, { clientX: 40, clientY: 50 });
    expect(await screen.findByRole("menu")).toBeDefined();
    expect(screen.getByText("sourceCopyCommitSubject")).toBeDefined();

    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(document.activeElement).toBe(row);

    fireEvent.keyDown(row, { key: "F10", shiftKey: true });
    expect(await screen.findByRole("menu")).toBeDefined();
    expect(
      screen.getByRole("menuitem", { name: "sourceMarkReadToHere" }),
    ).toBeDefined();
  });

  it("resizes the revision pane from either edge handle by keyboard", async () => {
    primeApis();
    render(
      <MemoryRouter>
        <CommitBrowser projectId="p1" isWideScreen={true} t={t} />
      </MemoryRouter>,
    );
    await screen.findByText("first commit");
    await findSourcePath("src/x.ts");

    const handles = screen.getAllByRole("separator", {
      name: "sourceResizeRevisionPane",
    });
    expect(handles).toHaveLength(2);
    expect(handles[0]?.getAttribute("aria-valuenow")).toBe("300");
    act(() => {
      fireEvent.keyDown(handles[0]!, { key: "ArrowRight" });
    });
    await waitFor(() => {
      expect(handles[0]?.getAttribute("aria-valuenow")).toBe("316");
      expect(handles[1]?.getAttribute("aria-valuenow")).toBe("316");
    });
  });

  it("focuses commit search with slash", async () => {
    primeApis();
    const focusHead = "f".repeat(40);
    getGitCommitSearchManifest.mockResolvedValue({
      head: focusHead,
      commits: [],
    });
    getGitCommitSearchRecords.mockResolvedValue({ records: [] });
    render(
      <MemoryRouter>
        <CommitBrowser projectId="p1" isWideScreen={false} t={t} />
      </MemoryRouter>,
    );

    const search = await screen.findByPlaceholderText("sourceSearchCommits");
    act(() => {
      fireEvent.keyDown(window, { key: "/" });
    });
    expect(document.activeElement).toBe(search);
    await waitFor(() =>
      expect(getGitCommitSearchManifest).toHaveBeenCalledWith("p1"),
    );
    await waitFor(() =>
      expect(document.querySelector(".source-search-index-status")).toBeNull(),
    );
  });

  it("anchors a commit-diff comment to the commit sha", async () => {
    primeApis();
    addReviewComment.mockResolvedValue({
      comment: { id: "c1", status: "pending", anchor: {}, text: "x" },
    });
    render(
      <MemoryRouter>
        <CommitBrowser projectId="p1" isWideScreen={true} t={t} />
      </MemoryRouter>,
    );

    // Wait for the diff to render, then click the inserted line.
    await waitFor(() =>
      expect(document.querySelector('[data-diff-line="0"]')).not.toBeNull(),
    );
    fireEvent.click(document.querySelector('[data-diff-line="0"]')!);

    fireEvent.change(await screen.findByRole("textbox"), {
      target: { value: "why this line?" },
    });
    fireEvent.click(screen.getByText("sourceReviewAddToReview"));

    await waitFor(() => expect(addReviewComment).toHaveBeenCalledTimes(1));
    const anchor = addReviewComment.mock.calls[0]?.[1] as {
      revision: { kind: string; sha?: string };
      side: string;
      newLine: number | null;
    };
    expect(anchor.revision).toEqual({ kind: "sha", sha: SHA });
    expect(anchor.side).toBe("new");
    expect(anchor.newLine).toBe(1);
  });

  it("keeps a focused commit free of the revision sidebar", async () => {
    primeApis();
    const onBrowseHistory = vi.fn();
    render(
      <MemoryRouter>
        <CommitBrowser
          projectId="p1"
          isWideScreen={true}
          initialSha={SHA}
          showRevisionPane={false}
          onBrowseHistory={onBrowseHistory}
          t={t}
        />
      </MemoryRouter>,
    );

    expect(await screen.findByText("first commit")).toBeDefined();
    expect(screen.queryByPlaceholderText("sourceSearchCommits")).toBeNull();
    expect(
      screen.queryAllByRole("separator", { name: "sourceResizeRevisionPane" }),
    ).toHaveLength(0);

    fireEvent.click(
      screen.getByRole("button", { name: "sourceCommitHistory" }),
    );
    expect(onBrowseHistory).toHaveBeenCalledOnce();
  });

  it("drills from any mobile commit into files and back to the list", async () => {
    const middleSha = "b".repeat(40);
    const oldestSha = "c".repeat(40);
    getGitCommits.mockResolvedValue({
      commits: [
        {
          hash: SHA,
          shortHash: "aaaaaaa",
          subject: "newest commit",
          authorName: "Dev",
          authorDate: "2026-07-26T00:00:00Z",
        },
        {
          hash: middleSha,
          shortHash: "bbbbbbb",
          subject: "middle commit",
          authorName: "Dev",
          authorDate: "2026-07-25T00:00:00Z",
        },
        {
          hash: oldestSha,
          shortHash: "ccccccc",
          subject: "oldest commit",
          authorName: "Dev",
          authorDate: "2026-07-24T00:00:00Z",
        },
      ],
      hasMore: false,
    });
    getGitCommit.mockImplementation((_projectId: string, sha: string) =>
      Promise.resolve({
        hash: sha,
        shortHash: sha.slice(0, 7),
        subject: "selected commit",
        authorName: "Dev",
        authorDate: "2026-07-25T00:00:00Z",
        body: "",
        files: [
          {
            path: "src/middle.ts",
            status: "M",
            staged: false,
            linesAdded: 2,
            linesDeleted: 1,
          },
        ],
      }),
    );
    listReviewComments.mockResolvedValue({
      comments: [],
      batches: [],
      pendingCount: 0,
    });
    const historyBack = vi
      .spyOn(window.history, "back")
      .mockImplementation(() => {});

    try {
      render(
        <MemoryRouter>
          <CommitBrowser projectId="p1" isWideScreen={false} t={t} />
        </MemoryRouter>,
      );

      fireEvent.click(await screen.findByText("middle commit"));

      expect(await findSourcePath("src/middle.ts")).toBeDefined();
      expect(screen.queryByText("newest commit")).toBeNull();
      expect(screen.queryByText("oldest commit")).toBeNull();
      expect(
        screen.getByRole("button", { name: "sourceCommitHistory" }),
      ).toBeDefined();

      fireEvent.click(
        screen.getByRole("button", { name: "sourceCommitHistory" }),
      );
      expect(historyBack).toHaveBeenCalled();
      act(() => {
        window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
      });

      expect(await screen.findByText("middle commit")).toBeDefined();
      expect(sourcePath("src/middle.ts")).toBeUndefined();
    } finally {
      historyBack.mockRestore();
      window.history.replaceState(null, "");
    }
  });

  it("searches the complete client index beyond the loaded commit page", async () => {
    primeApis();
    const OTHER = "c".repeat(40);
    const indexedCommits = [
      {
        hash: SHA,
        shortHash: "aaaaaaa",
        subject: "first commit",
        authorName: "Dev",
        authorDate: "2026-07-26T00:00:00Z",
      },
      ...Array.from({ length: 60 }, (_, index) => ({
        hash: `${(index + 1).toString(16).padStart(40, "0")}`,
        shortHash: (index + 1).toString(16).padStart(7, "0"),
        subject: `older ${index}`,
        authorName: "Dev",
        authorDate: "2026-07-20T00:00:00Z",
      })),
      {
        hash: OTHER,
        shortHash: "ccccccc",
        subject: "deep change",
        authorName: "Dev",
        authorDate: "2026-07-19T00:00:00Z",
      },
    ];
    getGitCommitSearchManifest.mockResolvedValue({
      head: SHA,
      commits: indexedCommits,
    });
    getGitCommitSearchRecords.mockImplementation(
      (_projectId: string, shas: string[]) => ({
        records: shas.map((hash) => ({
          hash,
          deltaText: hash === OTHER ? "src/deep.ts\nmatching Needle text" : "",
        })),
      }),
    );
    getGitCommits.mockResolvedValue({
      commits: indexedCommits.slice(0, 50),
      hasMore: true,
    });
    render(
      <MemoryRouter>
        <CommitBrowser projectId="p1" isWideScreen={false} t={t} />
      </MemoryRouter>,
    );

    await screen.findByText("first commit");
    fireEvent.change(screen.getByPlaceholderText("sourceSearchCommits"), {
      target: { value: "needle" },
    });

    await screen.findByText("deep change");
    const highlightedChange = screen.getByText("Needle");
    expect(highlightedChange.tagName).toBe("MARK");
    expect(highlightedChange.parentElement?.textContent).toBe(
      "matching Needle text",
    );
    expect(screen.queryByText("first commit")).toBeNull();
    expect(getGitCommitSearchManifest).toHaveBeenCalledWith("p1");
    expect(getGitCommitSearchRecords).toHaveBeenCalled();
    expect(screen.queryByText("sourceLoadMore")).toBeNull();
  });

  it("searches commit metadata before delta batches finish", async () => {
    primeApis();
    const OTHER = "c".repeat(40);
    getGitCommitSearchManifest.mockResolvedValue({
      head: OTHER,
      commits: [
        {
          hash: OTHER,
          shortHash: "ccccccc",
          subject: "touched needle",
          authorName: "Dev",
          authorDate: "2026-07-20T00:00:00Z",
        },
      ],
    });
    getGitCommitSearchRecords.mockResolvedValue({
      records: [{ hash: OTHER, deltaText: "" }],
    });
    render(
      <MemoryRouter>
        <CommitBrowser projectId="p1" isWideScreen={false} t={t} />
      </MemoryRouter>,
    );

    await screen.findByText("first commit");
    fireEvent.change(screen.getByPlaceholderText("sourceSearchCommits"), {
      target: { value: "needle" },
    });

    await screen.findByTitle("touched needle");
    expect(screen.getByText("needle").tagName).toBe("MARK");
  });

  it("jumps to the older commit via the commit-jump selector", async () => {
    const OLDER = "d".repeat(40);
    getGitCommits.mockResolvedValue({
      commits: [
        {
          hash: SHA,
          shortHash: "aaaaaaa",
          subject: "newest",
          authorName: "Dev",
          authorDate: "2026-07-26T00:00:00Z",
        },
        {
          hash: OLDER,
          shortHash: "ddddddd",
          subject: "older one",
          authorName: "Dev",
          authorDate: "2026-07-20T00:00:00Z",
        },
      ],
      hasMore: false,
    });
    getGitCommit.mockResolvedValue({
      hash: SHA,
      shortHash: "aaaaaaa",
      subject: "newest",
      authorName: "Dev",
      authorDate: "2026-07-26T00:00:00Z",
      body: "",
      files: [],
    });
    listReviewComments.mockResolvedValue({
      comments: [],
      batches: [],
      pendingCount: 0,
    });
    render(
      <MemoryRouter>
        <CommitBrowser projectId="p1" isWideScreen={true} t={t} />
      </MemoryRouter>,
    );

    // Wide screen auto-selects the newest → detail loads for it.
    await waitFor(() => expect(getGitCommit).toHaveBeenCalledWith("p1", SHA));
    getGitCommit.mockClear();

    // Newer/older jump is now a glyph button; the phrase is its title.
    fireEvent.click(await screen.findByTitle("sourceOlderCommit"));
    await waitFor(() => expect(getGitCommit).toHaveBeenCalledWith("p1", OLDER));
  });

  it("badges a commit with its pending review-comment count", async () => {
    getGitCommits.mockResolvedValue({
      commits: [
        {
          hash: SHA,
          shortHash: "aaaaaaa",
          subject: "first commit",
          authorName: "Dev",
          authorDate: "2026-07-26T00:00:00Z",
        },
      ],
      hasMore: false,
    });
    listReviewComments.mockResolvedValue({
      comments: [
        {
          id: "c1",
          status: "pending",
          text: "why?",
          createdAt: "2026-07-26T00:00:00Z",
          anchor: {
            path: "src/x.ts",
            revision: { kind: "sha", sha: SHA },
            side: "new",
            oldLine: null,
            newLine: 1,
            snippet: "",
          },
        },
      ],
      batches: [],
    });
    render(
      <MemoryRouter>
        <CommitBrowser projectId="p1" isWideScreen={false} t={t} />
      </MemoryRouter>,
    );

    await screen.findByText("first commit");
    const badges = await screen.findAllByTitle("sourceCommentCount");
    expect(badges.some((badge) => badge.textContent === "1")).toBe(true);
  });

  it("repeats the subject, soft-reflows the body, and opens the verbatim message", async () => {
    const first =
      "Rendered commit prose is commonly hard-wrapped for a readable terminal";
    const second =
      "but those stored breaks become jagged in the narrow source review pane.";
    primeApis();
    getGitCommit.mockResolvedValue({
      hash: SHA,
      shortHash: "aaaaaaa",
      subject: "first commit",
      authorName: "Dev",
      authorDate: "2026-07-26T00:00:00Z",
      body: `${first}\n${second}`,
      files: [
        {
          path: "src/x.ts",
          status: "M",
          staged: false,
          linesAdded: 1,
          linesDeleted: 0,
        },
      ],
    });
    render(
      <MemoryRouter>
        <CommitBrowser projectId="p1" isWideScreen={true} t={t} />
      </MemoryRouter>,
    );

    const compactBody = await screen.findByTitle("sourceShowFullMessage");
    expect(compactBody.textContent).toBe(`first commit\n\n${first} ${second}`);
    const getSelection = vi
      .spyOn(window, "getSelection")
      .mockReturnValue({ isCollapsed: false } as Selection);
    try {
      fireEvent.click(compactBody);
      expect(document.querySelector(".commit-message-full")).toBeNull();

      getSelection.mockReturnValue(null);
      fireEvent.click(compactBody);
      await waitFor(() =>
        expect(document.querySelector(".commit-message-full")).not.toBeNull(),
      );
      expect(document.querySelector(".commit-message-full")?.textContent).toBe(
        `first commit\n\n${first}\n${second}`,
      );
    } finally {
      getSelection.mockRestore();
    }
  });

  it.each(["Enter", " "])(
    "opens the commit message card with the %j key",
    async (key) => {
      primeApis();
      getGitCommit.mockResolvedValue({
        hash: SHA,
        shortHash: "aaaaaaa",
        subject: "first commit",
        authorName: "Dev",
        authorDate: "2026-07-26T00:00:00Z",
        body: "message body",
        files: [],
      });
      render(
        <MemoryRouter>
          <CommitBrowser projectId="p1" isWideScreen={true} t={t} />
        </MemoryRouter>,
      );

      fireEvent.keyDown(await screen.findByTitle("sourceShowFullMessage"), {
        key,
      });

      await waitFor(() =>
        expect(document.querySelector(".commit-message-full")).not.toBeNull(),
      );
    },
  );

  it("enters a commit at its first file", async () => {
    primeApis();
    render(
      <MemoryRouter>
        <CommitBrowser projectId="p1" isWideScreen={true} t={t} />
      </MemoryRouter>,
    );

    const commit = await screen.findByText("first commit");
    const commitRow = commit.closest("a")!;
    await waitFor(() => expect(document.activeElement).toBe(commitRow));
    fireEvent.keyDown(commitRow, { key: "Enter" });

    const firstFilePath = await findSourcePath("src/x.ts");
    await waitFor(() =>
      expect(document.activeElement).toBe(firstFilePath.closest("button")),
    );
  });

  it("abandons Enter when revision focus leaves before detail loads", async () => {
    const older = "b".repeat(40);
    const firstDetail = {
      hash: SHA,
      shortHash: "aaaaaaa",
      subject: "first commit",
      authorName: "Dev",
      authorDate: "2026-07-26T00:00:00Z",
      body: "",
      files: [
        {
          path: "src/x.ts",
          status: "M",
          staged: false,
          linesAdded: 1,
          linesDeleted: 0,
        },
      ],
    } as const;
    let resolveFirstDetail!: (detail: typeof firstDetail) => void;
    const firstDetailRequest = new Promise<typeof firstDetail>((resolve) => {
      resolveFirstDetail = resolve;
    });
    primeApis();
    getGitCommits.mockResolvedValue({
      commits: [
        {
          hash: SHA,
          shortHash: "aaaaaaa",
          subject: "first commit",
          authorName: "Dev",
          authorDate: "2026-07-26T00:00:00Z",
        },
        {
          hash: older,
          shortHash: "bbbbbbb",
          subject: "older commit",
          authorName: "Dev",
          authorDate: "2026-07-25T00:00:00Z",
        },
      ],
      hasMore: false,
    });
    getGitCommit.mockImplementation((_projectId: string, sha: string) =>
      sha === SHA
        ? firstDetailRequest
        : Promise.resolve({
            hash: older,
            shortHash: "bbbbbbb",
            subject: "older commit",
            authorName: "Dev",
            authorDate: "2026-07-25T00:00:00Z",
            body: "",
            files: [],
          }),
    );
    render(
      <MemoryRouter>
        <CommitBrowser projectId="p1" isWideScreen={true} t={t} />
      </MemoryRouter>,
    );

    const firstRow = (await screen.findByText("first commit")).closest("a")!;
    const olderRow = screen.getByText("older commit").closest("a")!;
    await waitFor(() => expect(document.activeElement).toBe(firstRow));
    fireEvent.keyDown(firstRow, { key: "Enter" });
    fireEvent.keyDown(firstRow, { key: "ArrowDown" });
    expect(document.activeElement).toBe(olderRow);
    fireEvent.keyDown(olderRow, { key: "ArrowUp" });
    expect(document.activeElement).toBe(firstRow);

    await act(async () => {
      resolveFirstDetail(firstDetail);
      await firstDetailRequest;
    });
    await findSourcePath("src/x.ts");
    expect(document.activeElement).toBe(firstRow);
  });

  it("reveals stepped commit files and pages the diff in place", async () => {
    primeApis();
    getGitCommit.mockResolvedValue({
      hash: SHA,
      shortHash: "aaaaaaa",
      subject: "first commit",
      authorName: "Dev",
      authorDate: "2026-07-26T00:00:00Z",
      body: "message body",
      files: [
        {
          path: "src/first.ts",
          status: "M",
          staged: false,
          linesAdded: 1,
          linesDeleted: 0,
        },
        {
          path: "src/second.ts",
          status: "M",
          staged: false,
          linesAdded: 1,
          linesDeleted: 0,
        },
      ],
    });
    render(
      <MemoryRouter>
        <CommitBrowser projectId="p1" isWideScreen={true} t={t} />
      </MemoryRouter>,
    );

    const message = await screen.findByTitle("sourceShowFullMessage");
    const first = (await findSourcePath("src/first.ts")).closest("button")!;
    const second = (await findSourcePath("src/second.ts")).closest("button")!;
    await waitFor(() =>
      expect(document.querySelector('[data-diff-line="0"]')).not.toBeNull(),
    );

    const group = screen.getByRole("button", {
      name: "sourceCollapsePathGroup",
    });
    group.focus();
    fireEvent.keyDown(group, { key: "ArrowRight" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(second, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(group);
    fireEvent.keyDown(group, { key: "ArrowLeft" });
    expect(sourcePath("src/first.ts")).toBeUndefined();
    expect(sourcePath("src/second.ts")).toBeUndefined();
    fireEvent.click(screen.getByRole("button", { name: "sourceFilterFiles" }));
    const fileFilter = screen.getByPlaceholderText("sourceFilterFiles");
    fireEvent.change(fileFilter, { target: { value: "second" } });
    expect(sourcePath("src/first.ts")).toBeUndefined();
    expect(sourcePath("src/second.ts")).toBeDefined();

    await act(async () => {
      fireEvent.click(message);
    });
    await waitFor(() =>
      expect(document.querySelector(".commit-message-view")).not.toBeNull(),
    );
    await act(async () => {
      fireEvent.keyDown(window, { key: "]" });
    });
    await waitFor(() =>
      expect(
        document
          .querySelector("[data-source-selected-path]")
          ?.getAttribute("data-source-selected-path"),
      ).toBe("src/first.ts"),
    );
    expect(document.querySelector(".commit-message-view")).toBeNull();
    const revealedFirst = await findSourcePath("src/first.ts");
    expect(document.activeElement).toBe(revealedFirst.closest("button"));
    expect(sourcePath("src/second.ts")).toBeDefined();
    expect((fileFilter as HTMLInputElement).value).toBe("");
    expect(
      document.querySelectorAll("[data-source-selected-path] wbr"),
    ).toHaveLength(1);

    const diffBody = document.querySelector<HTMLElement>(
      ".git-diff-preview-body",
    )!;
    Object.defineProperties(diffBody, {
      clientHeight: { configurable: true, value: 200 },
      scrollHeight: { configurable: true, value: 600 },
    });
    diffBody.scrollTop = 100;

    fireEvent.keyDown(diffBody, { key: "PageDown" });
    expect(diffBody.scrollTop).toBe(300);
    fireEvent.keyDown(diffBody, { key: "PageUp" });
    expect(diffBody.scrollTop).toBe(100);

    expect(fireEvent.keyDown(diffBody, { key: "ArrowDown" })).toBe(true);
    expect(
      document
        .querySelector("[data-source-selected-path]")
        ?.getAttribute("data-source-selected-path"),
    ).toBe("src/first.ts");

    fireEvent.keyDown(diffBody, { key: "]" });
    await waitFor(() =>
      expect(
        document
          .querySelector("[data-source-selected-path]")
          ?.getAttribute("data-source-selected-path"),
      ).toBe("src/second.ts"),
    );
    expect(document.activeElement).toBe(
      sourcePath("src/second.ts")?.closest("button"),
    );
    fireEvent.keyDown(diffBody, { key: "[" });
    await waitFor(() =>
      expect(
        document
          .querySelector("[data-source-selected-path]")
          ?.getAttribute("data-source-selected-path"),
      ).toBe("src/first.ts"),
    );
    expect(document.activeElement).toBe(
      sourcePath("src/first.ts")?.closest("button"),
    );
  });

  it("steps through files in rendered outline order", async () => {
    primeApis();
    const readmePath = "RegressionTests/resources/Privacy/Generic/README.md";
    const processorPath =
      "RegressionTests/resources/Privacy/name-postprocessor.json";
    getGitCommit.mockResolvedValue({
      hash: SHA,
      shortHash: "aaaaaaa",
      subject: "first commit",
      authorName: "Dev",
      authorDate: "2026-07-26T00:00:00Z",
      body: "message body",
      files: [
        {
          path: readmePath,
          status: "M",
          staged: false,
          linesAdded: 1,
          linesDeleted: 0,
        },
        {
          path: processorPath,
          status: "M",
          staged: false,
          linesAdded: 1,
          linesDeleted: 0,
        },
      ],
    });
    render(
      <MemoryRouter>
        <CommitBrowser projectId="p1" isWideScreen={true} t={t} />
      </MemoryRouter>,
    );

    const message = await screen.findByTitle("sourceShowFullMessage");
    await findSourcePath(processorPath);
    await waitFor(() =>
      expect(
        document
          .querySelector("[data-source-selected-path]")
          ?.getAttribute("data-source-selected-path"),
      ).toBe(processorPath),
    );

    fireEvent.click(message);
    fireEvent.keyDown(window, { key: "[" });
    await waitFor(() =>
      expect(document.activeElement).toBe(
        sourcePath(processorPath)?.closest("button"),
      ),
    );
    fireEvent.keyDown(window, { key: "]" });
    await waitFor(() =>
      expect(document.activeElement).toBe(
        sourcePath(readmePath)?.closest("button"),
      ),
    );
    fireEvent.keyDown(window, { key: "[" });
    await waitFor(() =>
      expect(document.activeElement).toBe(
        sourcePath(processorPath)?.closest("button"),
      ),
    );
  });

  it("toggles revision blame in place without losing the commit view", async () => {
    primeApis();
    render(
      <MemoryRouter>
        <CommitBrowser projectId="p1" isWideScreen={true} t={t} />
      </MemoryRouter>,
    );

    await findSourcePath("src/x.ts");
    await waitFor(() =>
      expect(document.querySelector('[data-diff-line="0"]')).not.toBeNull(),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "sourceToggleBlame" }),
    );

    await waitFor(() =>
      expect(getGitBlame).toHaveBeenCalledWith("p1", "src/x.ts", SHA),
    );
    await waitFor(() => {
      expect(document.querySelector("[data-blame-row]")).not.toBeNull();
      expect(document.querySelector(".commit-files-column")).not.toBeNull();
    });

    fireEvent.click(screen.getByRole("button", { name: "sourceToggleBlame" }));
    await waitFor(() =>
      expect(document.querySelector('[data-diff-line="0"]')).not.toBeNull(),
    );
  });

  it("opens a directly linked file in blame mode", async () => {
    primeApis();
    render(
      <MemoryRouter>
        <CommitBrowser
          projectId="p1"
          isWideScreen={true}
          initialSha={SHA}
          initialPath="src/x.ts"
          initialBlame
          t={t}
        />
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(getGitBlame).toHaveBeenCalledWith("p1", "src/x.ts", SHA),
    );
    await waitFor(() =>
      expect(document.querySelector("[data-blame-row]")).not.toBeNull(),
    );
  });

  it("re-clicks the selected file to advance to the next diff hunk", async () => {
    primeApis();
    getGitCommitDiff.mockResolvedValue({
      diffHtml:
        `<pre class="shiki"><code>` +
        `<span class="line line-hunk">@@ -1 +1 @@</span>` +
        `<span class="line line-inserted" data-diff-line="0">+first</span>` +
        `<span class="line line-hunk">@@ -10 +10 @@</span>` +
        `<span class="line line-inserted" data-diff-line="1">+second</span>` +
        `</code></pre>`,
      structuredPatch: [
        {
          oldStart: 1,
          oldLines: 0,
          newStart: 1,
          newLines: 1,
          lines: ["+first"],
        },
        {
          oldStart: 10,
          oldLines: 0,
          newStart: 10,
          newLines: 1,
          lines: ["+second"],
        },
      ],
    });
    const scrollIntoView = installScrollIntoViewMock();

    try {
      render(
        <MemoryRouter>
          <CommitBrowser projectId="p1" isWideScreen={true} t={t} />
        </MemoryRouter>,
      );

      await waitFor(() =>
        expect(document.querySelectorAll(".line-hunk")).toHaveLength(2),
      );
      fireEvent.click(document.querySelector(".commit-file-item")!);

      expect(scrollIntoView.fn).toHaveBeenCalledWith({
        block: "start",
        behavior: "smooth",
      });
      expect(scrollIntoView.fn.mock.instances[0]).toBe(
        document.querySelectorAll(".line-hunk")[1],
      );
    } finally {
      scrollIntoView.restore();
    }
  });

  it("uses n/p for symmetric hunk navigation except while typing", async () => {
    primeApis();
    getGitCommitDiff.mockResolvedValue({
      diffHtml:
        `<pre class="shiki"><code>` +
        `<span class="line line-hunk">@@ -1 +1 @@</span>` +
        `<span class="line line-inserted" data-diff-line="0">+first</span>` +
        `<span class="line line-hunk">@@ -10 +10 @@</span>` +
        `<span class="line line-inserted" data-diff-line="1">+second</span>` +
        `</code></pre>`,
      structuredPatch: [
        {
          oldStart: 1,
          oldLines: 0,
          newStart: 1,
          newLines: 1,
          lines: ["+first"],
        },
        {
          oldStart: 10,
          oldLines: 0,
          newStart: 10,
          newLines: 1,
          lines: ["+second"],
        },
      ],
    });
    const scrollIntoView = installScrollIntoViewMock();

    try {
      render(
        <MemoryRouter>
          <CommitBrowser projectId="p1" isWideScreen={true} t={t} />
        </MemoryRouter>,
      );

      await waitFor(() =>
        expect(document.querySelectorAll(".line-hunk")).toHaveLength(2),
      );
      const search = screen.getByPlaceholderText("sourceSearchCommits");
      fireEvent.keyDown(search, { key: "n" });
      expect(scrollIntoView.fn).not.toHaveBeenCalled();

      fireEvent.keyDown(window, { key: "n" });
      expect(scrollIntoView.fn).toHaveBeenCalledTimes(1);
      expect(scrollIntoView.fn.mock.instances[0]).toBe(
        document.querySelectorAll(".line-hunk")[1],
      );

      fireEvent.keyDown(window, { key: "p" });
      expect(scrollIntoView.fn).toHaveBeenCalledTimes(2);
      expect(scrollIntoView.fn.mock.instances[1]).toBe(
        document.querySelectorAll(".line-hunk")[0],
      );
    } finally {
      scrollIntoView.restore();
    }
  });
});
