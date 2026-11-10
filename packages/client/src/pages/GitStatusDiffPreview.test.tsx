// @vitest-environment jsdom

import {
  type GitDiffResult,
  type GitFileChange,
  MARKDOWN_LIKE_FILE_EXTENSIONS,
} from "@yep-anywhere/shared";
import {
  act,
  cleanup,
  fireEvent,
  render as renderComponent,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getGitDiff = vi.fn();
const getGitFileProjectionDiff = vi.fn();
const listReviewComments = vi.fn();
const copiedValues: string[] = [];
const writeClipboardTextLater = vi.fn(async (value: Promise<string>) => {
  copiedValues.push(await value);
  return true;
});
const originalScrollIntoView = Element.prototype.scrollIntoView;
vi.mock("../api/client", () => ({
  api: {
    getGitDiff: (...args: unknown[]) => getGitDiff(...args),
    getGitFileProjectionDiff: (...args: unknown[]) =>
      getGitFileProjectionDiff(...args),
    listReviewComments: (...args: unknown[]) => listReviewComments(...args),
  },
}));
vi.mock("../hooks/useRemoteBasePath", () => ({
  useRemoteBasePath: () => "",
}));
vi.mock("../lib/clipboard", () => ({
  writeClipboardText: vi.fn(async () => true),
  writeClipboardTextLater: (value: Promise<string>) =>
    writeClipboardTextLater(value),
}));

import { GitDiffBody } from "./GitStatusDiffPreview";
import { I18nProvider } from "../i18n";

const t = (key: string) => key;
const FILE: GitFileChange = {
  path: "src/live.ts",
  status: "M",
  staged: false,
  linesAdded: 1,
  linesDeleted: 0,
};

function rect(top: number): DOMRect {
  return {
    bottom: top + 10,
    height: 10,
    left: 0,
    right: 10,
    top,
    width: 10,
    x: 0,
    y: top,
    toJSON: () => ({}),
  };
}

function result(line: string): GitDiffResult {
  return {
    diffHtml: "",
    structuredPatch: [
      {
        oldStart: 1,
        oldLines: 0,
        newStart: 1,
        newLines: 1,
        lines: [`+${line}`],
      },
    ],
  };
}

const render = (
  ui: Parameters<typeof renderComponent>[0],
  options?: Parameters<typeof renderComponent>[1],
) => renderComponent(ui, { wrapper: I18nProvider, ...options });

describe("GitDiffBody", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    copiedValues.length = 0;
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => {
    if (originalScrollIntoView) {
      Object.defineProperty(Element.prototype, "scrollIntoView", {
        configurable: true,
        value: originalScrollIntoView,
      });
    } else {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("reloads open full context when the live diff result changes", async () => {
    const normalResults = [result("diff-a"), result("diff-b")];
    const fullResults = [result("full-a"), result("full-b")];
    getGitDiff.mockImplementation(
      (
        _projectId: string,
        options: {
          fullContext?: boolean;
        },
      ) =>
        Promise.resolve(
          options.fullContext ? fullResults.shift() : normalResults.shift(),
        ),
    );
    listReviewComments.mockResolvedValue({
      comments: [],
      batches: [],
      pendingCount: 0,
    });

    const rendered = render(
      <MemoryRouter>
        <div className="modal-content">
          <GitDiffBody
            file={FILE}
            fileKey="src/live.ts:false"
            projectId="p1"
            t={t}
          />
        </div>
      </MemoryRouter>,
    );
    await screen.findByText("diff-a");
    const scrollRoot = document.querySelector<HTMLElement>(".modal-content");
    if (!scrollRoot) throw new Error("Expected diff scroll root");
    scrollRoot.scrollTop = 40;
    const rectSpy = vi
      .spyOn(Element.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: Element) {
        if (this === scrollRoot) return rect(20);
        if (
          this instanceof Element &&
          this.classList.contains("line-inserted")
        ) {
          return rect(this.textContent?.includes("full-a") ? 140 : 80);
        }
        return rect(0);
      });

    fireEvent.click(
      screen.getByRole("button", { name: "gitStatusFullContext" }),
    );
    await screen.findByText("full-a");
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
    expect(scrollRoot.scrollTop).toBe(100);
    rectSpy.mockRestore();

    rendered.rerender(
      <MemoryRouter>
        <div className="modal-content">
          <GitDiffBody
            file={{ ...FILE }}
            fileKey="src/live.ts:false"
            projectId="p1"
            t={t}
          />
        </div>
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(
        getGitDiff.mock.calls.filter(([, options]) => options.fullContext),
      ).toHaveLength(2),
    );
    expect(await screen.findByText("full-b")).toBeTruthy();
  });

  it("shows complete after-side text without removed lines", async () => {
    const normal: GitDiffResult = {
      diffHtml: "",
      structuredPatch: [
        {
          oldStart: 2,
          oldLines: 1,
          newStart: 2,
          newLines: 1,
          lines: ["-old", "+new"],
        },
      ],
    };
    const full: GitDiffResult = {
      diffHtml: "",
      structuredPatch: [
        {
          oldStart: 1,
          oldLines: 3,
          newStart: 1,
          newLines: 3,
          lines: [" before", "-old", "+new", " after"],
        },
      ],
    };
    getGitDiff.mockImplementation(
      (
        _projectId: string,
        options: {
          fullContext?: boolean;
        },
      ) => Promise.resolve(options.fullContext ? full : normal),
    );
    listReviewComments.mockResolvedValue({
      comments: [],
      batches: [],
      pendingCount: 0,
    });

    render(
      <MemoryRouter>
        <GitDiffBody
          file={FILE}
          fileKey="src/live.ts:false"
          projectId="p1"
          t={t}
        />
      </MemoryRouter>,
    );

    await screen.findByText("old", { exact: false });
    fireEvent.click(
      screen.getByRole("button", { name: "gitStatusHideRemovedLines" }),
    );

    const showRemovedLinesButton = await screen.findByRole("button", {
      name: "gitStatusShowRemovedLines",
    });
    expect(
      getGitDiff.mock.calls.some(([, options]) => options.fullContext),
    ).toBe(true);
    const rendered = document.querySelector(".highlighted-diff");
    expect(rendered?.textContent).toContain("before");
    expect(rendered?.textContent).toContain("new");
    expect(rendered?.textContent).toContain("after");
    expect(rendered?.textContent).not.toContain("-old");
    expect(rendered?.textContent).not.toContain("+new");
    expect(rendered?.querySelector(".line-hunk")).toBeNull();

    fireEvent.click(showRemovedLinesButton);
    const restoredDiff = document.querySelector("[data-diff-hunk]");
    expect(restoredDiff?.textContent).toContain("-old");
    expect(restoredDiff?.querySelector(".line-hunk")).not.toBeNull();
  });

  it("keeps the requested rendered diff through a source-only refresh", async () => {
    const markdownFile: GitFileChange = {
      ...FILE,
      path: "notes/live.md",
    };
    const results: GitDiffResult[] = [
      {
        ...result("first diff"),
        markdownHtml: "<p>first preview</p>",
      },
      result("temporary source only"),
      {
        ...result("third diff"),
        markdownHtml: "<p>third preview</p>",
      },
    ];
    getGitDiff.mockImplementation(() => Promise.resolve(results.shift()));

    const view = (file: GitFileChange) => (
      <MemoryRouter>
        <GitDiffBody file={file} fileKey="notes/live.md" projectId="p1" t={t} />
      </MemoryRouter>
    );
    const rendered = render(view(markdownFile));
    fireEvent.click(
      await screen.findByRole("button", { name: "gitStatusPreview" }),
    );
    expect(await screen.findByText("first diff")).toBeTruthy();

    rendered.rerender(view({ ...markdownFile, linesAdded: 2 }));
    expect(await screen.findByText("temporary source only")).toBeTruthy();

    rendered.rerender(view({ ...markdownFile, linesAdded: 3 }));
    expect(await screen.findByText("third diff")).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "gitStatusDiff" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("keeps a later Preview choice through a delayed projection reset", async () => {
    const markdownFile: GitFileChange = {
      ...FILE,
      path: "notes/report.qmd",
    };
    let resolveProjectedDiff: (value: GitDiffResult) => void = () => {};
    const projectedDiff = new Promise<GitDiffResult>((resolve) => {
      resolveProjectedDiff = resolve;
    });
    getGitDiff
      .mockResolvedValueOnce(result("# Initial report"))
      .mockReturnValueOnce(projectedDiff);

    const view = (ignoreWhitespace: boolean) => (
      <MemoryRouter>
        <GitDiffBody
          file={markdownFile}
          fileKey="notes/report.qmd"
          projectId="p1"
          ignoreWhitespace={ignoreWhitespace}
          t={t}
        />
      </MemoryRouter>
    );
    const rendered = render(view(false));
    fireEvent.click(
      await screen.findByRole("button", { name: "gitStatusPreview" }),
    );
    expect(
      screen
        .getByRole("button", { name: "gitStatusDiff" })
        .getAttribute("aria-pressed"),
    ).toBe("true");

    rendered.rerender(view(true));
    await screen.findByText("gitStatusLoadingDiff");
    await act(async () => {
      resolveProjectedDiff(result("# Projected report"));
      await projectedDiff;
    });

    expect(await screen.findByText("Projected report")).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "gitStatusDiff" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("keeps rendered scope and copied contents aligned", async () => {
    const normal: GitDiffResult = {
      diffHtml: "",
      structuredPatch: [
        {
          oldStart: 2,
          oldLines: 2,
          newStart: 2,
          newLines: 2,
          lines: [" # Heading", "-old", "+new"],
        },
      ],
      markdownHtml: "<h1>Obsolete whole preview</h1>",
    };
    const full: GitDiffResult = {
      diffHtml: "",
      structuredPatch: [
        {
          oldStart: 1,
          oldLines: 4,
          newStart: 1,
          newLines: 4,
          lines: [" before", " # Heading", "-old", "+new", " after"],
        },
      ],
      markdownHtml: "<p>before</p><h1>Heading</h1><p>new</p><p>after</p>",
    };
    getGitDiff.mockImplementation(
      (
        _projectId: string,
        options: {
          fullContext?: boolean;
        },
      ) => Promise.resolve(options.fullContext ? full : normal),
    );
    listReviewComments.mockResolvedValue({
      comments: [],
      batches: [],
      pendingCount: 0,
    });

    render(
      <MemoryRouter>
        <GitDiffBody
          file={{ ...FILE, path: "notes/live.md" }}
          fileKey="notes/live.md:false"
          projectId="p1"
          t={t}
        />
      </MemoryRouter>,
    );

    const copy = await screen.findByRole("button", {
      name: "fileViewerCopyContent",
    });
    fireEvent.click(copy);
    await waitFor(() => expect(copiedValues).toEqual(["# Heading\nnew"]));

    fireEvent.click(screen.getByRole("button", { name: "gitStatusPreview" }));
    expect(await screen.findByText("Heading")).toBeTruthy();
    expect(screen.queryByText("Obsolete whole preview")).toBeNull();
    expect(
      screen.getByRole("button", { name: "gitStatusFullContext" }),
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "gitStatusFullContext" }),
    );
    expect(await screen.findByText("before")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "gitStatusDiffOnly" }),
    ).toBeTruthy();

    fireEvent.click(copy);
    await waitFor(() =>
      expect(copiedValues).toEqual([
        "# Heading\nnew",
        "before\n# Heading\nnew\nafter",
      ]),
    );
  });

  it.each([...MARKDOWN_LIKE_FILE_EXTENSIONS])(
    "offers Markdown preview for .%s Source Control diffs",
    async (extension) => {
      getGitDiff.mockResolvedValue({
        ...result("source"),
        markdownHtml: "<p>rendered document</p>",
      });
      listReviewComments.mockResolvedValue({
        comments: [],
        batches: [],
        pendingCount: 0,
      });

      render(
        <MemoryRouter>
          <GitDiffBody
            file={{ ...FILE, path: `notes/live.${extension}` }}
            fileKey={`notes/live.${extension}`}
            projectId="p1"
            t={t}
          />
        </MemoryRouter>,
      );

      expect(
        await screen.findByRole("button", { name: "gitStatusPreview" }),
      ).toBeTruthy();
    },
  );

  it("keeps file identity readable beside compact glyph controls", async () => {
    getGitDiff.mockResolvedValue(result("compact"));
    listReviewComments.mockResolvedValue({
      comments: [],
      batches: [],
      pendingCount: 0,
    });

    render(
      <MemoryRouter>
        <GitDiffBody
          file={{
            ...FILE,
            path: "packages/client/src/very-long-file-name.ts",
          }}
          fileKey="packages/client/src/very-long-file-name.ts:false"
          projectId="p1"
          paneHeader={{
            title: "very-long-file-name.ts",
            path: "packages/client/src/very-long-file-name.ts",
          }}
          onToggleIgnoreWhitespace={() => {}}
          t={t}
        />
      </MemoryRouter>,
    );

    await screen.findByText("compact");
    expect(document.querySelector("[data-source-diff-path]")?.textContent).toBe(
      "packages/client/src",
    );
    expect(
      document.querySelector("[data-source-preview-title]")?.textContent,
    ).toBe("very-long-file-name.ts");
    expect(
      screen.getByRole("button", { name: "gitStatusIgnoreWhitespace" })
        .textContent,
    ).toBe("_+");
    expect(
      screen.getByRole("button", { name: "gitStatusFullContext" }).textContent,
    ).toBe("");
    expect(
      screen.getByRole("button", {
        name: "diffViewModeTitle: diffViewModeAuto",
      }).textContent,
    ).toBe("");
    await waitFor(() =>
      expect(
        document.querySelector("[data-source-hunk-position]")?.textContent,
      ).toBe("1/1"),
    );
  });

  it("describes the active whitespace projection", async () => {
    getGitDiff.mockResolvedValue(result("compact"));
    listReviewComments.mockResolvedValue({
      comments: [],
      batches: [],
      pendingCount: 0,
    });

    render(
      <MemoryRouter>
        <GitDiffBody
          file={FILE}
          fileKey="src/example.ts:false"
          projectId="p1"
          ignoreWhitespace
          onToggleIgnoreWhitespace={() => {}}
          t={t}
        />
      </MemoryRouter>,
    );

    await screen.findByText("compact");
    const toggle = screen.getByRole("button", {
      name: "gitStatusIgnoreWhitespaceActive",
    });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
  });

  it("downgrades oversized highlighted HTML to the plain projection", async () => {
    getGitDiff.mockResolvedValue({
      ...result("large line"),
      diffHtml: "x".repeat(20_000_001),
    });

    render(
      <MemoryRouter>
        <GitDiffBody
          file={FILE}
          fileKey="src/example.ts:false"
          projectId="p1"
          t={t}
        />
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(
        document.querySelector('[data-diff-rendering="plain"]')?.textContent,
      ).toContain("+large line"),
    );
    expect(screen.getByText("gitStatusDiffPlainMode")).toBeTruthy();
    expect(document.querySelectorAll(".line-hunk")).toHaveLength(1);
    await waitFor(() =>
      expect(
        document.querySelector("[data-source-hunk-position]")?.textContent,
      ).toBe("1/1"),
    );
    expect(
      screen.getByRole("button", { name: "sourcePreviousHunkShortcut" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "sourceNextHunkShortcut" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", {
        name: "diffViewModeTitle: diffViewModeAuto",
      }),
    ).toBeNull();
    expect(screen.queryByText("gitStatusDiffPreviewSkipped")).toBeNull();
  });

  it("renders the server binary-file omission state", async () => {
    getGitDiff.mockResolvedValue({
      diffHtml: "",
      structuredPatch: [],
      previewSkipped: {
        reason: "binary",
        totalBytes: 2048,
      },
    } satisfies GitDiffResult);

    render(
      <MemoryRouter>
        <GitDiffBody
          file={{ ...FILE, path: "assets/icon.png" }}
          fileKey="assets/icon.png:false"
          projectId="p1"
          t={t}
        />
      </MemoryRouter>,
    );

    expect(
      await screen.findByText("gitStatusDiffPreviewSkippedBinary"),
    ).toBeTruthy();
    expect(screen.getByText("2.0 KB")).toBeTruthy();
    expect(screen.getAllByText("assets/icon.png")).toHaveLength(2);
  });

  it("loads cumulative file-viewer projections through their own route", async () => {
    getGitFileProjectionDiff.mockResolvedValue(result("cumulative"));

    render(
      <MemoryRouter>
        <GitDiffBody
          file={FILE}
          fileKey="file-viewer:cumulative:src/live.ts"
          projectId="p1"
          source={{ kind: "file-projection", mode: "cumulative" }}
          t={t}
        />
      </MemoryRouter>,
    );

    await screen.findByText("cumulative");
    expect(getGitFileProjectionDiff).toHaveBeenCalledWith("p1", {
      path: "src/live.ts",
      mode: "cumulative",
      fullContext: undefined,
    });
    expect(getGitDiff).not.toHaveBeenCalled();
  });

  it("suppresses binary-looking patch text returned by an older server", async () => {
    getGitDiff.mockResolvedValue(result("\u0000PNG\ufffd\u0001\u0002"));

    render(
      <MemoryRouter>
        <GitDiffBody
          file={{ ...FILE, path: "assets/icon.png" }}
          fileKey="assets/icon.png:false"
          projectId="p1"
          t={t}
        />
      </MemoryRouter>,
    );

    expect(
      await screen.findByText("gitStatusDiffPreviewSkippedBinary"),
    ).toBeTruthy();
    expect(document.querySelector(".code-highlighter-plain")).toBeNull();
  });
});
