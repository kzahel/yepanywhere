// @vitest-environment jsdom

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

const getGitBlame = vi.fn();
const getFile = vi.fn();
const listReviewComments = vi.fn();
const addReviewComment = vi.fn();
const getGlobalSessions = vi.fn();
const writeClipboardText = vi.fn();
vi.mock("../api/client", () => ({
  api: {
    getFile: (...args: unknown[]) => getFile(...args),
    getGitBlame: (...args: unknown[]) => getGitBlame(...args),
    listReviewComments: (...args: unknown[]) => listReviewComments(...args),
    addReviewComment: (...args: unknown[]) => addReviewComment(...args),
    getGlobalSessions: (...args: unknown[]) => getGlobalSessions(...args),
  },
}));
vi.mock("../lib/clipboard", () => ({
  writeClipboardText: (...args: unknown[]) => writeClipboardText(...args),
}));

import { BlameView } from "./BlameView";

const COMMITTED_SHA = "b".repeat(40);
const t = (key: string) => key;

function primeBlame() {
  getGlobalSessions.mockResolvedValue({ sessions: [], hasMore: false });
  getFile.mockResolvedValue({
    metadata: {
      path: "src/x.ts",
      size: 25,
      mimeType: "text/typescript",
      isText: true,
    },
    content: "const a = 1;\nconst b = 2;\n",
    rawUrl: "/raw/src/x.ts",
  });
  const blame = {
    path: "src/x.ts",
    rev: "HEAD",
    truncated: false,
    highlightedHtml:
      `<pre class="shiki"><code>` +
      `<span class="line">const a = 1;</span>\n` +
      `<span class="line">const b = 2;</span>` +
      `</code></pre>`,
    lines: [
      {
        line: 1,
        sha: COMMITTED_SHA,
        shortSha: "bbbbbbb",
        author: "Dev",
        authorTime: "2026-07-26T00:00:00Z",
        summary: "init",
        content: "const a = 1;",
        uncommitted: false,
      },
      {
        line: 2,
        sha: "0".repeat(40),
        shortSha: "0000000",
        author: "Not Committed Yet",
        authorTime: "",
        summary: "",
        content: "const b = 2;",
        uncommitted: true,
      },
    ],
  };
  getGitBlame.mockResolvedValue(blame);
  listReviewComments.mockResolvedValue({
    comments: [],
    batches: [],
    pendingCount: 0,
  });
  addReviewComment.mockResolvedValue({
    comment: { id: "c1", status: "pending", anchor: {}, text: "x" },
  });
  return blame;
}

async function commentOnRow(rowIndex: number, text: string) {
  await waitFor(() =>
    expect(document.querySelectorAll("[data-blame-row]").length).toBe(2),
  );
  fireEvent.click(document.querySelectorAll("[data-blame-code]")[rowIndex]!);
  fireEvent.change(await screen.findByRole("textbox"), {
    target: { value: text },
  });
  fireEvent.click(screen.getByText("sourceReviewAddToReview"));
  await waitFor(() => expect(addReviewComment).toHaveBeenCalledTimes(1));
  return addReviewComment.mock.calls[0]?.[1] as {
    revision: { kind: string; sha?: string };
    side: string;
    oldLine: number | null;
    newLine: number | null;
    projection?: {
      kind: string;
      revision?: string;
      path: string;
      side: string;
    };
  };
}

describe("BlameView", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("anchors a committed blame line to its origin sha", async () => {
    primeBlame();
    render(
      <MemoryRouter>
        <BlameView projectId="p1" path="src/x.ts" t={t} />
      </MemoryRouter>,
    );

    const anchor = await commentOnRow(0, "why const a?");
    expect(anchor.revision).toEqual({ kind: "sha", sha: COMMITTED_SHA });
    expect(anchor.side).toBe("new");
    expect(anchor.oldLine).toBeNull();
    expect(anchor.newLine).toBe(1);
  });

  it("captures the rendered worktree separately from blame provenance", async () => {
    primeBlame();
    render(
      <MemoryRouter>
        <BlameView
          projectId="p1"
          path="src/x.ts"
          captureReviewProjections
          t={t}
        />
      </MemoryRouter>,
    );

    const anchor = await commentOnRow(0, "review the rendered line");
    expect(anchor.revision).toEqual({ kind: "sha", sha: COMMITTED_SHA });
    expect(anchor.projection).toEqual({
      kind: "worktree",
      path: "src/x.ts",
      side: "new",
    });
  });

  it("blames an explicit revision without reading working-tree content", async () => {
    const blame = primeBlame();
    getGitBlame.mockResolvedValue({
      ...blame,
      rev: COMMITTED_SHA,
    });
    render(
      <MemoryRouter>
        <BlameView
          projectId="p1"
          path="src/x.ts"
          rev={COMMITTED_SHA}
          captureReviewProjections
          t={t}
        />
      </MemoryRouter>,
    );

    const anchor = await commentOnRow(0, "review the committed line");
    expect(getGitBlame).toHaveBeenCalledWith("p1", "src/x.ts", COMMITTED_SHA);
    expect(getFile).not.toHaveBeenCalled();
    expect(anchor.projection).toEqual({
      kind: "revision",
      revision: COMMITTED_SHA,
      path: "src/x.ts",
      side: "new",
    });
  });

  it("splits blame after the selected row", async () => {
    primeBlame();
    render(
      <MemoryRouter>
        <BlameView projectId="p1" path="src/x.ts" t={t} />
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(document.querySelectorAll("[data-blame-row]").length).toBe(2),
    );
    fireEvent.click(document.querySelectorAll("[data-blame-code]")[0]!);
    await screen.findByRole("textbox");

    const before = document.querySelector("[data-review-comment-before]");
    const after = document.querySelector("[data-review-comment-after]");
    expect(before?.querySelectorAll("[data-blame-row]")).toHaveLength(1);
    expect(after?.querySelectorAll("[data-blame-row]")).toHaveLength(1);
    expect(before?.textContent).toContain("const a = 1;");
    expect(after?.textContent).toContain("const b = 2;");
  });

  it("anchors a not-yet-committed blame line as uncommitted", async () => {
    primeBlame();
    render(
      <MemoryRouter>
        <BlameView projectId="p1" path="src/x.ts" t={t} />
      </MemoryRouter>,
    );

    const anchor = await commentOnRow(1, "wip line");
    expect(anchor.revision.kind).toBe("uncommitted");
    expect(anchor.newLine).toBe(2);
  });

  it("does not tint a line for a pending comment on another revision", async () => {
    primeBlame();
    listReviewComments.mockResolvedValue({
      comments: [
        {
          id: "stale",
          status: "pending",
          text: "from an older commit",
          createdAt: "2026-07-26T00:00:00Z",
          anchor: {
            path: "src/x.ts",
            revision: { kind: "sha", sha: "d".repeat(40) },
            side: "new",
            oldLine: null,
            newLine: 1,
            snippet: "const a = 1;",
          },
        },
      ],
      batches: [],
      pendingCount: 1,
    });

    render(
      <MemoryRouter>
        <BlameView projectId="p1" path="src/x.ts" t={t} />
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(document.querySelectorAll("[data-blame-row]").length).toBe(2),
    );
    expect(
      document
        .querySelector("[data-blame-row]")
        ?.hasAttribute("data-has-review-comment"),
    ).toBe(false);
  });

  it("shows file content before blame, then enriches hash actions", async () => {
    let resolveBlame!: (value: ReturnType<typeof blameResult>) => void;
    const pendingBlame = new Promise<ReturnType<typeof blameResult>>(
      (resolve) => {
        resolveBlame = resolve;
      },
    );
    getFile.mockResolvedValue({
      metadata: {
        path: "src/x.ts",
        size: 13,
        mimeType: "text/typescript",
        isText: true,
      },
      content: "const fast = 1;\n",
      rawUrl: "/raw/src/x.ts",
    });
    getGitBlame.mockReturnValue(pendingBlame);
    listReviewComments.mockResolvedValue({
      comments: [],
      batches: [],
      pendingCount: 0,
    });
    const onOpenCommit = vi.fn();
    const onContentWidthChange = vi.fn();

    render(
      <MemoryRouter>
        <BlameView
          projectId="p1"
          path="src/x.ts"
          onOpenCommit={onOpenCommit}
          onContentWidthChange={onContentWidthChange}
          t={t}
        />
      </MemoryRouter>,
    );

    expect(await screen.findByText("const fast = 1;")).toBeTruthy();
    expect(getFile).toHaveBeenCalledWith("p1", "src/x.ts", false);
    expect(onContentWidthChange).toHaveBeenCalledWith("src/x.ts", 320);
    expect(
      document.querySelector('[data-blame-gutter="loading"]'),
    ).toBeTruthy();
    expect(document.querySelector('[data-blame-gutter="commit"]')).toBeNull();

    await act(async () => {
      resolveBlame(blameResult("const fast = 1;"));
      await pendingBlame;
    });
    await waitFor(() => expect(onContentWidthChange).toHaveBeenCalledTimes(2));

    const hash = await screen.findByRole("button", { name: "bbbbb" });
    expect(hash.getAttribute("title")).toContain("init");
    fireEvent.click(hash);
    expect(onOpenCommit).toHaveBeenCalledWith(COMMITTED_SHA);

    fireEvent.contextMenu(hash, { clientX: 20, clientY: 20 });
    expect(
      await screen.findByRole("menuitem", { name: "sourceCopyCommitHash" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("menuitem", { name: "sourceOpenCommit" }),
    ).toBeTruthy();
  });

  it("uses distinct path and raw-content actions beside their targets", async () => {
    primeBlame();
    writeClipboardText.mockResolvedValue(true);
    render(
      <MemoryRouter>
        <BlameView projectId="p1" path="src/x.ts" t={t} />
      </MemoryRouter>,
    );

    const pathCopy = await screen.findByRole("button", {
      name: "sourceCopyPath",
    });
    const contentCopy = screen.getByRole("button", {
      name: "sourceCopyRawContent",
    });
    const pathGroup = pathCopy.closest("[data-blame-path-group]");
    expect(pathGroup).toBeTruthy();
    // The raw-content action is a header sibling of the path group, not a
    // second control inside it.
    expect(contentCopy.closest("[data-blame-path-group]")).toBeNull();
    expect(contentCopy.parentElement).toBe(pathGroup?.parentElement);

    fireEvent.click(pathCopy);
    fireEvent.click(contentCopy);
    await waitFor(() =>
      expect(writeClipboardText.mock.calls).toEqual([
        ["src/x.ts"],
        ["const a = 1;\nconst b = 2;\n"],
      ]),
    );
  });

  it("keeps commit, line number, and selectable content as separate columns", async () => {
    primeBlame();
    render(
      <MemoryRouter>
        <BlameView projectId="p1" path="src/x.ts" t={t} />
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(document.querySelectorAll("[data-blame-row]").length).toBe(2),
    );
    const row = document.querySelector("[data-blame-row]")!;
    expect(row.children[0]?.hasAttribute("data-blame-gutter")).toBe(true);
    expect(row.children[1]?.hasAttribute("data-blame-lineno")).toBe(true);
    expect(row.children[2]?.hasAttribute("data-blame-code")).toBe(true);

    const selection = vi.spyOn(window, "getSelection").mockReturnValue({
      isCollapsed: false,
      toString: () => "const a",
      containsNode: () => true,
    } as unknown as Selection);
    fireEvent.click(row.children[2]!);
    expect(screen.queryByRole("textbox")).toBeNull();

    selection.mockReturnValue({
      isCollapsed: false,
      toString: () => "selected elsewhere",
      containsNode: () => false,
    } as unknown as Selection);
    fireEvent.click(row.children[2]!);
    expect(await screen.findByRole("textbox")).toBeTruthy();

    selection.mockRestore();
  });
});

function blameResult(content: string) {
  return {
    path: "src/x.ts",
    rev: "HEAD",
    truncated: false,
    lines: [
      {
        line: 1,
        sha: COMMITTED_SHA,
        shortSha: "bbbbbbb",
        author: "Dev",
        authorTime: "2026-07-26T00:00:00Z",
        summary: "init",
        content,
        uncommitted: false,
      },
    ],
  };
}
