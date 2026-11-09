import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { toUrlProjectId, type FileContentResponse } from "@yep-anywhere/shared";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import { QuoteReplyProvider } from "../../contexts/QuoteReplyContext";
import { SessionMetadataProvider } from "../../contexts/SessionMetadataContext";
import { SessionViewerCommentProvider } from "../../contexts/SessionViewerCommentContext";
import { ToastProvider } from "../../contexts/ToastContext";
import { setQuoteReplyButtonModePreference } from "../../hooks/useQuoteReplyButtonMode";
import { I18nProvider } from "../../i18n";
import { LOCAL_CLIENT_SUMMARY_SOURCE_KEY } from "../../lib/clientSummaryStore";
import { invalidateLocalStorageValues } from "../../lib/localStorageValue";
import { extractMarkdownSnippetsFromSelection } from "../../lib/markdownSelectionCopy";
import { getNewSessionPrefill } from "../../lib/newSessionPrefill";
import type { YaSourceRuntime } from "../../lib/sourceRuntime";
import { SourceRuntimeProvider } from "../../lib/sourceRuntimeReact";
import { UI_KEYS } from "../../lib/storageKeys";
import { FakeSourceTransport } from "../../lib/transport";
import { FileViewer, type FileViewerSource } from "../FileViewer";
import { FileViewerModal } from "../FilePathLink";

const mocks = vi.hoisted(() => ({
  useFileVersionControl: vi.fn(),
}));

vi.mock("../../hooks/useFileVersionControl", () => ({
  useFileVersionControl: mocks.useFileVersionControl,
}));
vi.mock("../../pages/GitStatusDiffPreview", () => ({
  GitDiffBody: ({ source }: { source: unknown }) => (
    <div data-testid="file-diff-body">{JSON.stringify(source)}</div>
  ),
}));

const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
const originalGetBoundingClientRect =
  HTMLElement.prototype.getBoundingClientRect;
const originalClientHeightDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "clientHeight",
);
const originalScrollHeightDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "scrollHeight",
);
const originalScrollTopDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "scrollTop",
);
const originalCreateObjectUrlDescriptor = Object.getOwnPropertyDescriptor(
  URL,
  "createObjectURL",
);
const originalRevokeObjectUrlDescriptor = Object.getOwnPropertyDescriptor(
  URL,
  "revokeObjectURL",
);
const originalWindowOpenDescriptor = Object.getOwnPropertyDescriptor(
  window,
  "open",
);

function restorePrototypeProperty(
  name: keyof HTMLElement,
  descriptor: PropertyDescriptor | undefined,
) {
  if (descriptor) {
    Object.defineProperty(HTMLElement.prototype, name, descriptor);
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, name);
  }
}

function restoreObjectProperty(
  target: object,
  name: PropertyKey,
  descriptor: PropertyDescriptor | undefined,
) {
  if (descriptor) {
    Object.defineProperty(target, name, descriptor);
  } else {
    Reflect.deleteProperty(target, name);
  }
}

describe("FileViewer", () => {
  beforeEach(() => {
    mocks.useFileVersionControl.mockReset();
    mocks.useFileVersionControl.mockReturnValue({
      cumulativeFile: null,
      loading: false,
      relativePath: null,
      supported: false,
      worktreeFile: null,
    });
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe = vi.fn();
        disconnect = vi.fn();
      },
    );
    setQuoteReplyButtonModePreference("paragraph-hover");
  });

  it("makes cumulative diff override source line ranges", async () => {
    const cumulativeFile = {
      path: "src/App.ts",
      status: "M",
      staged: false,
      linesAdded: 3,
      linesDeleted: 1,
    };
    mocks.useFileVersionControl.mockReturnValue({
      cumulativeFile,
      loading: false,
      relativePath: "src/App.ts",
      supported: true,
      worktreeFile: null,
    });
    const source: FileViewerSource = {
      loadFile: vi.fn(async () => ({
        metadata: {
          path: "src/App.ts",
          size: 12,
          mimeType: "text/typescript",
          isText: true,
        },
        rawUrl: "",
        content: "source\n",
      })),
    };

    render(
      <I18nProvider>
        <FileViewer
          projectId="project-id"
          filePath="src/App.ts"
          lineNumber={12}
          lineEnd={16}
          viewMode="range"
          diffMode="cumulative"
          source={source}
        />
      </I18nProvider>,
    );

    expect((await screen.findByTestId("file-diff-body")).textContent).toContain(
      '"mode":"cumulative"',
    );
    expect(source.loadFile).not.toHaveBeenCalled();
    const cumulative = screen.getByRole("link", {
      name: "View cumulative HEAD^1 to working tree diff for src/App.ts",
    });
    expect(cumulative.getAttribute("href")).toBe(
      "/projects/project-id/file?path=src%2FApp.ts&diff=cumulative",
    );
    expect(cumulative.getAttribute("aria-current")).toBe("page");

    expect(screen.queryByRole("link", { name: "Source" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Raw source" }));
    await waitFor(() =>
      expect(source.loadFile).toHaveBeenCalledWith(
        "project-id",
        "src/App.ts",
        true,
        12,
        16,
        "range",
      ),
    );
  });

  it("reloads from disk on demand and reports freshness on hover", async () => {
    const file = (content: string, modifiedAt: number) => ({
      metadata: {
        path: "notes.md",
        size: content.length,
        mimeType: "text/markdown",
        isText: true,
        modifiedAt,
      },
      rawUrl: "",
      content,
      renderedMarkdownHtml: `<h1>${content.slice(2).trim()}</h1>`,
    });
    const source: FileViewerSource = {
      loadFile: vi
        .fn()
        .mockResolvedValueOnce(file("# First\n", 1000))
        .mockResolvedValueOnce(file("# Second\n", 2000)),
      statFile: vi.fn().mockResolvedValue(file("# Second\n", 2000)),
    };
    render(
      <I18nProvider>
        <FileViewer
          projectId="project-id"
          filePath="notes.md"
          source={source}
        />
      </I18nProvider>,
    );
    expect(await screen.findByRole("heading", { name: "First" })).toBeTruthy();
    const reload = screen.getByRole("button", { name: "Reload from disk" });
    expect(reload.getAttribute("data-tooltip")).toBe("Reload from disk");
    fireEvent.mouseEnter(reload);
    await waitFor(() =>
      expect(reload.getAttribute("data-tooltip")).toMatch(
        /^Changed on disk at /,
      ),
    );
    expect(source.statFile).toHaveBeenCalledWith("project-id", "notes.md");
    fireEvent.click(reload);
    expect(await screen.findByRole("heading", { name: "Second" })).toBeTruthy();
    expect(source.loadFile).toHaveBeenCalledTimes(2);
    fireEvent.mouseEnter(reload);
    await waitFor(() =>
      expect(reload.getAttribute("data-tooltip")).toMatch(/^Unchanged on disk/),
    );
  });

  it("keeps the file in view and toasts when its download fails", async () => {
    const source: FileViewerSource = {
      loadFile: vi.fn().mockResolvedValue({
        metadata: {
          path: "software.tgz",
          size: 17_772_579,
          mimeType: "application/octet-stream",
          isText: false,
        },
        rawUrl: "",
      }),
      fetchRawFileBlob: vi
        .fn()
        .mockRejectedValue(new TypeError("Failed to fetch")),
    };
    render(
      <I18nProvider>
        <ToastProvider>
          <FileViewer
            projectId="project-id"
            filePath="software.tgz"
            source={source}
            onClose={vi.fn()}
          />
        </ToastProvider>
      </I18nProvider>,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Download File" }),
    );

    expect(
      await screen.findByText(
        "Could not download software.tgz: Failed to fetch",
      ),
    ).toBeTruthy();
    expect(source.fetchRawFileBlob).toHaveBeenCalledWith(
      expect.objectContaining({ rawUrl: "" }),
      "software.tgz",
      true,
    );
    expect(screen.getByRole("button", { name: "Download File" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Back" })).toBeTruthy();
  });

  it("hands a direct download to the browser without fetching the bytes", async () => {
    const clicked: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this);
    });
    const source: FileViewerSource = {
      loadFile: vi.fn().mockResolvedValue({
        metadata: {
          path: "software.tgz",
          size: 17_772_579,
          mimeType: "application/octet-stream",
          isText: false,
        },
        rawUrl: "",
      }),
      getRawFileUrl: (projectId, filePath, download) =>
        `/api/projects/${projectId}/files/raw?path=${filePath}&download=${download}`,
      fetchRawFileBlob: vi.fn(),
    };
    render(
      <I18nProvider>
        <FileViewer
          projectId="project-id"
          filePath="software.tgz"
          source={source}
        />
      </I18nProvider>,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Download File" }),
    );

    expect(clicked).toHaveLength(1);
    expect(clicked[0]?.getAttribute("href")).toBe(
      "/api/projects/project-id/files/raw?path=software.tgz&download=true",
    );
    expect(clicked[0]?.download).toBe("software.tgz");
    expect(source.fetchRawFileBlob).not.toHaveBeenCalled();
  });

  it("keeps the header and reload when the file cannot be loaded", async () => {
    const onClose = vi.fn();
    const source: FileViewerSource = {
      loadFile: vi
        .fn()
        .mockRejectedValueOnce(new Error("File not found"))
        .mockResolvedValueOnce({
          metadata: {
            path: "notes.md",
            size: 9,
            mimeType: "text/markdown",
            isText: true,
          },
          rawUrl: "",
          content: "# Back\n",
          renderedMarkdownHtml: "<h1>Back again</h1>",
        }),
    };
    render(
      <I18nProvider>
        <FileViewer
          projectId="project-id"
          filePath="notes.md"
          source={source}
          onClose={onClose}
        />
      </I18nProvider>,
    );

    expect(await screen.findByText("File not found")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reload from disk" }));
    expect(
      await screen.findByRole("heading", { name: "Back again" }),
    ).toBeTruthy();
    expect(source.loadFile).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("drops a reload that answers after the viewer moved to another file", async () => {
    const file = (path: string, title: string) => ({
      metadata: {
        path,
        size: title.length + 3,
        mimeType: "text/markdown",
        isText: true,
      },
      rawUrl: "",
      content: `# ${title}\n`,
      renderedMarkdownHtml: `<h1>${title}</h1>`,
    });
    let answerReload: (data: FileContentResponse) => void = () => {};
    const source: FileViewerSource = {
      loadFile: vi
        .fn()
        .mockResolvedValueOnce(file("a.md", "A before"))
        .mockReturnValueOnce(
          new Promise<FileContentResponse>((resolve) => {
            answerReload = resolve;
          }),
        )
        .mockResolvedValueOnce(file("b.md", "B")),
    };
    const viewer = (filePath: string) => (
      <I18nProvider>
        <FileViewer
          projectId="project-id"
          filePath={filePath}
          source={source}
        />
      </I18nProvider>
    );
    const { rerender } = render(viewer("a.md"));
    expect(
      await screen.findByRole("heading", { name: "A before" }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Reload from disk" }));
    // The copy on screen stays while the fresh one is fetched.
    expect(screen.getByRole("heading", { name: "A before" })).toBeTruthy();
    expect(screen.queryByText("Loading a.md...")).toBeNull();

    rerender(viewer("b.md"));
    expect(await screen.findByRole("heading", { name: "B" })).toBeTruthy();
    await act(async () => {
      answerReload(file("a.md", "A after"));
    });

    expect(screen.getByRole("heading", { name: "B" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "A after" })).toBeNull();
    expect(source.loadFile).toHaveBeenCalledTimes(3);
  });

  it("returns from a diff to the retained raw source without loading", async () => {
    mocks.useFileVersionControl.mockReturnValue({
      cumulativeFile: null,
      loading: false,
      relativePath: "notes.md",
      supported: true,
      worktreeFile: {
        path: "notes.md",
        status: "M",
        staged: false,
        linesAdded: 1,
        linesDeleted: 0,
      },
    });
    const source: FileViewerSource = {
      loadFile: vi
        .fn()
        .mockResolvedValueOnce({
          metadata: {
            path: "notes.md",
            size: 8,
            mimeType: "text/markdown",
            isText: true,
          },
          rawUrl: "",
          content: "# Notes\n",
          highlightedHtml:
            '<pre class="shiki"><code><span class="line"># Notes</span></code></pre>',
          renderedMarkdownHtml: "<h1>Notes</h1>",
        })
        .mockReturnValueOnce(new Promise(() => {})),
    };

    const { container } = render(
      <I18nProvider>
        <FileViewer
          projectId="project-id"
          filePath="notes.md"
          source={source}
        />
      </I18nProvider>,
    );

    expect(await screen.findByRole("heading", { name: "Notes" })).toBeTruthy();
    fireEvent.click(
      screen.getByRole("link", {
        name: "View HEAD to working tree diff for notes.md",
      }),
    );
    expect(await screen.findByTestId("file-diff-body")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Raw source" }));

    expect(container.querySelector(".shiki-container")).toBeTruthy();
    expect(screen.queryByText("Loading notes.md...")).toBeNull();
    expect(source.loadFile).toHaveBeenCalledTimes(1);
  });

  it("offers a Back control that closes a modal viewer", async () => {
    const onClose = vi.fn();
    const source: FileViewerSource = {
      loadFile: vi.fn(async () => ({
        metadata: {
          path: "notes.txt",
          size: 5,
          mimeType: "text/plain",
          isText: true,
        },
        rawUrl: "",
        content: "notes",
      })),
    };

    render(
      <I18nProvider>
        <FileViewer
          projectId="project-id"
          filePath="notes.txt"
          source={source}
          onClose={onClose}
        />
      </I18nProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Back" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("backs out of an in-file viewer before closing its parent", async () => {
    const childResponse: FileContentResponse = {
      metadata: {
        path: "child.yml",
        size: 5,
        mimeType: "text/yaml",
        isText: true,
      },
      rawUrl: "",
      content: "child",
    };
    const getFile = vi.spyOn(api, "getFile").mockResolvedValue(childResponse);
    const onClose = vi.fn();
    const source: FileViewerSource = {
      loadFile: vi.fn(async () => ({
        metadata: {
          path: "parent.yml",
          size: 9,
          mimeType: "text/yaml",
          isText: true,
        },
        rawUrl: "",
        content: "child.yml",
        highlightedHtml:
          '<a href="/projects/project-id/file?path=child.yml" ' +
          'data-ya-resource="project-file" data-ya-project-id="project-id" ' +
          'data-ya-path="child.yml">child.yml</a>',
      })),
    };

    try {
      render(
        <I18nProvider>
          <FileViewerModal
            projectId="project-id"
            filePath="parent.yml"
            source={source}
            onClose={onClose}
          />
        </I18nProvider>,
      );

      fireEvent.click(await screen.findByRole("link", { name: "child.yml" }));
      await waitFor(() =>
        expect(screen.getAllByRole("dialog")).toHaveLength(2),
      );
      expect(document.body.style.overflow).toBe("hidden");
      const backButtons = screen.getAllByRole("button", { name: "Back" });
      const childBack = backButtons.at(-1);
      if (!childBack) throw new Error("Nested file viewer has no Back control");
      fireEvent.click(childBack);
      await waitFor(() =>
        expect(screen.getAllByRole("dialog")).toHaveLength(1),
      );
      expect(onClose).not.toHaveBeenCalled();
      expect(document.body.style.overflow).toBe("hidden");

      fireEvent.click(screen.getByRole("link", { name: "child.yml" }));
      await waitFor(() =>
        expect(screen.getAllByRole("dialog")).toHaveLength(2),
      );
      fireEvent.keyDown(document, { key: "Escape" });
      await waitFor(() =>
        expect(screen.getAllByRole("dialog")).toHaveLength(1),
      );
      expect(onClose).not.toHaveBeenCalled();
      expect(document.body.style.overflow).toBe("hidden");

      fireEvent.click(screen.getByRole("link", { name: "child.yml" }));
      await waitFor(() =>
        expect(screen.getAllByRole("dialog")).toHaveLength(2),
      );
      fireEvent.keyDown(document, { key: "Backspace" });
      await waitFor(() =>
        expect(screen.getAllByRole("dialog")).toHaveLength(1),
      );
      expect(onClose).not.toHaveBeenCalled();

      fireEvent.keyDown(document, { key: "Backspace" });
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(getFile).toHaveBeenCalledWith(
        "project-id",
        "child.yml",
        true,
        undefined,
        undefined,
        "full",
      );
    } finally {
      getFile.mockRestore();
    }
  });

  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    window.history.replaceState({}, "", "/");
    vi.unstubAllGlobals();
    if (originalScrollIntoView) {
      Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
        configurable: true,
        value: originalScrollIntoView,
      });
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
    }
    Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
      configurable: true,
      value: originalGetBoundingClientRect,
    });
    restorePrototypeProperty("clientHeight", originalClientHeightDescriptor);
    restorePrototypeProperty("scrollHeight", originalScrollHeightDescriptor);
    restorePrototypeProperty("scrollTop", originalScrollTopDescriptor);
    restoreObjectProperty(
      URL,
      "createObjectURL",
      originalCreateObjectUrlDescriptor,
    );
    restoreObjectProperty(
      URL,
      "revokeObjectURL",
      originalRevokeObjectUrlDescriptor,
    );
    restoreObjectProperty(window, "open", originalWindowOpenDescriptor);
  });

  it("shows project-relative headers for Windows absolute project paths", async () => {
    const projectRoot = "C:\\Users\\user\\Documents\\code\\playbox";
    const rawPath = `${projectRoot}\\docs\\guide.md`;
    const projectId = toUrlProjectId(projectRoot);
    const fileResponse: FileContentResponse = {
      metadata: {
        path: rawPath,
        size: 12,
        mimeType: "text/markdown",
        isText: true,
      },
      rawUrl: "",
      content: "# Guide\n",
    };
    const source: FileViewerSource = {
      loadFile: vi.fn(async () => fileResponse),
    };

    const { container } = render(
      <I18nProvider>
        <FileViewer projectId={projectId} filePath={rawPath} source={source} />
      </I18nProvider>,
    );

    await waitFor(() => {
      expect(container.querySelector(".file-viewer-path")?.textContent).toBe(
        "docs/guide.md",
      );
    });

    expect(
      container.querySelector(".file-viewer-path")?.getAttribute("title"),
    ).toBe(rawPath);
    expect(source.loadFile).toHaveBeenCalledWith(
      projectId,
      rawPath,
      true,
      undefined,
      undefined,
      "full",
    );
  });

  it("prefills a new session from the file viewer path", async () => {
    const fileResponse: FileContentResponse = {
      metadata: {
        path: "src/App.ts",
        size: 20,
        mimeType: "text/typescript",
        isText: true,
      },
      rawUrl: "",
      content: "export {};\n",
    };
    const source: FileViewerSource = {
      loadFile: vi.fn(async () => fileResponse),
    };

    render(
      <I18nProvider>
        <FileViewer
          projectId="project-id"
          filePath="src/App.ts"
          source={source}
        />
      </I18nProvider>,
    );

    const button = await screen.findByRole("button", {
      name: "New session from path",
    });
    fireEvent.click(button);

    expect(getNewSessionPrefill(LOCAL_CLIENT_SUMMARY_SOURCE_KEY)).toBe(
      "src/App.ts",
    );
    expect(window.location.pathname).toBe("/new-session");
    expect(window.location.search).toBe("?projectId=project-id");
  });

  it("prefills a new session from a selected standalone file line", async () => {
    const projectRoot = "/work/project";
    const projectId = toUrlProjectId(projectRoot);
    const filePath = `${projectRoot}/src/App.ts`;
    const fileResponse: FileContentResponse = {
      metadata: {
        path: filePath,
        size: 30,
        mimeType: "text/typescript",
        isText: true,
      },
      rawUrl: "",
      content: "first line\nselected line\nthird line",
    };
    const source: FileViewerSource = {
      loadFile: vi.fn(async () => fileResponse),
    };

    render(
      <I18nProvider>
        <FileViewer
          projectId={projectId}
          filePath={filePath}
          source={source}
          standalone
        />
      </I18nProvider>,
    );

    const selectedLine = await screen.findByText("selected line");
    const range = document.createRange();
    range.selectNodeContents(selectedLine);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    fireEvent.contextMenu(
      screen.getByText("src/App.ts", { selector: ".file-viewer-path" }),
    );
    expect(screen.getByRole("menuitem", { name: "New session" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Copy text" })).toBeNull();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    // jsdom drops the selection when the menu focuses its first item.
    selection?.removeAllRanges();
    selection?.addRange(range);

    fireEvent.contextMenu(selectedLine, { clientX: 0, clientY: 0 });
    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual(["Copy text", "New session"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "New session" }));

    expect(getNewSessionPrefill(LOCAL_CLIENT_SUMMARY_SOURCE_KEY)).toBe(
      "src/App.ts:2\n\n> selected line",
    );
    expect(window.location.pathname).toBe("/new-session");
    expect(window.location.search).toBe(`?projectId=${projectId}`);
  });

  it("marks and scrolls a line range 10% below the viewer top", async () => {
    let scrollTop = 0;
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get() {
        return this.classList.contains("file-viewer-body") ? 100 : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return this.classList.contains("file-viewer-body") ? 1000 : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "scrollTop", {
      configurable: true,
      get() {
        return this.classList.contains("file-viewer-body") ? scrollTop : 0;
      },
      set(value) {
        if (this.classList.contains("file-viewer-body")) {
          scrollTop = Number(value);
        }
      },
    });
    Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
      configurable: true,
      value(this: HTMLElement) {
        const top = this.classList.contains("highlighted-line-start") ? 200 : 0;
        return {
          bottom: top,
          height: 0,
          left: 0,
          right: 0,
          toJSON: () => ({}),
          top,
          width: 0,
          x: 0,
          y: top,
        };
      },
    });
    const fileResponse: FileContentResponse = {
      metadata: {
        path: "src/App.ts",
        size: 64,
        mimeType: "text/typescript",
        isText: true,
      },
      rawUrl: "",
      content: "one\ntwo\nthree\nfour\n",
      highlightedHtml:
        '<pre class="shiki"><code><span class="line">one</span>\n<span class="line">two</span>\n<span class="line">three</span>\n<span class="line">four</span></code></pre>',
      highlightedLanguage: "typescript",
    };
    const source: FileViewerSource = {
      loadFile: vi.fn(async () => fileResponse),
    };

    const { container } = render(
      <I18nProvider>
        <FileViewer
          projectId="project-id"
          filePath="src/App.ts"
          lineNumber={2}
          lineEnd={3}
          source={source}
        />
      </I18nProvider>,
    );

    await waitFor(() => {
      expect(container.querySelector(".highlighted-line-start")).not.toBeNull();
    });

    expect(
      container
        .querySelector(".highlighted-line-start")
        ?.getAttribute("data-line"),
    ).toBe("2");
    expect(
      container
        .querySelector(".highlighted-line-end")
        ?.getAttribute("data-line"),
    ).toBe("3");
    const code = container.querySelector(".shiki-container code");
    expect(
      Array.from(code?.childNodes ?? []).some(
        (node) => node.nodeType === Node.TEXT_NODE && node.textContent === "\n",
      ),
    ).toBe(false);
    expect(container.querySelector(".highlighted-line")).toBeNull();
    const sourceLines = container.querySelectorAll<HTMLElement>(
      ".shiki-container .line",
    );
    expect(sourceLines[1]?.dataset.yaSourceStart).toBe("4");
    expect(sourceLines[1]?.dataset.yaSourceEnd).toBe("7");
    const viewerBody =
      container.querySelector<HTMLElement>(".file-viewer-body");
    await waitFor(() =>
      expect(viewerBody?.getAttribute("data-markdown-copy-source")).toBe(
        "true",
      ),
    );
    const selectedRange = document.createRange();
    selectedRange.setStart(sourceLines[1]?.firstChild as Node, 0);
    selectedRange.setEnd(sourceLines[2]?.firstChild as Node, "three".length);
    const sourceSelection = document.getSelection();
    sourceSelection?.removeAllRanges();
    sourceSelection?.addRange(selectedRange);
    expect(extractMarkdownSnippetsFromSelection(viewerBody!)).toMatchObject([
      {
        markdown: "two\nthree",
        selectedText: "two\nthree",
        sourceStart: 4,
        sourceEnd: 13,
      },
    ]);
    sourceSelection?.removeAllRanges();
    expect(HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(
        container.querySelector<HTMLElement>(".file-viewer-body")?.scrollTop,
      ).toBe(190);
    });
  });

  it("paints a single highlighted line", async () => {
    const fileResponse: FileContentResponse = {
      metadata: {
        path: "src/App.ts",
        size: 64,
        mimeType: "text/typescript",
        isText: true,
      },
      rawUrl: "",
      content: "one\ntwo\nthree\n",
      contentStartLine: 40,
      highlightedHtml:
        '<pre class="shiki"><code><span class="line">one</span>\n<span class="line">two</span>\n<span class="line">three</span></code></pre>',
      highlightedLanguage: "typescript",
    };
    const source: FileViewerSource = {
      loadFile: vi.fn(async () => fileResponse),
    };

    const { container } = render(
      <I18nProvider>
        <FileViewer
          projectId="project-id"
          filePath="src/App.ts"
          lineNumber={41}
          source={source}
        />
      </I18nProvider>,
    );

    await waitFor(() => {
      expect(container.querySelector(".highlighted-line")).not.toBeNull();
    });

    expect(
      container.querySelector(".highlighted-line")?.getAttribute("data-line"),
    ).toBe("41");
    expect(container.querySelector(".highlighted-line-start")).not.toBeNull();
    expect(container.querySelector(".highlighted-line-end")).not.toBeNull();
  });

  it("shows actual file line numbers in plain range windows", async () => {
    const fileResponse: FileContentResponse = {
      metadata: {
        path: "logs/session.txt",
        size: 64,
        mimeType: "text/plain",
        isText: true,
      },
      rawUrl: "",
      content: "alpha\nbeta\ngamma",
      contentStartLine: 40,
      contentEndLine: 42,
    };
    const source: FileViewerSource = {
      loadFile: vi.fn(async () => fileResponse),
    };

    const { container } = render(
      <I18nProvider>
        <FileViewer
          projectId="project-id"
          filePath="logs/session.txt"
          lineNumber={41}
          lineEnd={42}
          viewMode="range"
          source={source}
        />
      </I18nProvider>,
    );

    await waitFor(() => {
      expect(container.querySelector(".code-highlighter-plain")).not.toBeNull();
    });

    const gutter = Array.from(
      container.querySelectorAll(".code-line-numbers > div"),
    ).map((node) => node.textContent);
    expect(gutter).toEqual(["40", "41", "42"]);
    expect(
      container
        .querySelector(".highlighted-line-start")
        ?.getAttribute("data-line"),
    ).toBe("41");
    expect(
      container
        .querySelector(".highlighted-line-end")
        ?.getAttribute("data-line"),
    ).toBe("42");

    const viewerBody =
      container.querySelector<HTMLElement>(".file-viewer-body");
    expect(viewerBody?.getAttribute("data-markdown-copy-source")).toBe("true");
    const betaText = viewerBody?.querySelector('[data-line="41"]')?.firstChild;
    expect(betaText).toBeTruthy();
    const range = document.createRange();
    range.setStart(betaText as Node, 0);
    range.setEnd(betaText as Node, "beta".length);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    expect(extractMarkdownSnippetsFromSelection(viewerBody!)).toMatchObject([
      {
        markdown: "beta",
        selectedText: "beta",
      },
    ]);
  });

  it("opens Markdown range views rendered and keeps source toggleable", async () => {
    const fileResponse: FileContentResponse = {
      metadata: {
        path: "notes.md",
        size: 64,
        mimeType: "text/markdown",
        isText: true,
      },
      rawUrl: "",
      content: "# Title\n\nSelected text",
      contentStartLine: 10,
      contentEndLine: 12,
      highlightedHtml:
        '<pre class="shiki"><code><span class="line"># Title</span>\n<span class="line"></span>\n<span class="line">Selected text</span></code></pre>',
      renderedMarkdownHtml:
        '<div class="markdown-preview-line-boundary markdown-preview-line-boundary-start" data-line="10"></div><div class="markdown-preview-span markdown-preview-span-start" data-line-start="10" data-line-end="12"><h1>Title</h1><p>Selected text</p></div><div class="markdown-preview-line-boundary markdown-preview-line-boundary-end" data-line="12"></div>',
    };
    const source: FileViewerSource = {
      loadFile: vi.fn(async () => fileResponse),
    };

    const { container } = render(
      <I18nProvider>
        <FileViewer
          projectId="project-id"
          filePath="notes.md"
          lineNumber={10}
          lineEnd={12}
          viewMode="range"
          source={source}
        />
      </I18nProvider>,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Raw source" })).toBeTruthy();
    });

    expect(await screen.findByRole("heading", { name: "Title" })).toBeTruthy();
    expect(
      container.querySelector(".markdown-preview-span-start"),
    ).toBeTruthy();
    const selectAll = screen.getByRole("button", { name: "Select all" });
    expect(selectAll.closest(".file-viewer-actions")).not.toBeNull();
    fireEvent.click(selectAll);
    expect(document.getSelection()?.toString()).toContain("Title");
    expect(document.getSelection()?.toString()).toContain("Selected text");
    document.getSelection()?.removeAllRanges();

    const rawSource = screen.getByRole("button", { name: "Raw source" });
    expect(rawSource.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(rawSource);
    expect(container.querySelector(".shiki-container")).toBeTruthy();
    expect(rawSource.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(rawSource);
    expect(rawSource.getAttribute("aria-pressed")).toBe("false");

    const heading = await screen.findByRole("heading", { name: "Title" });
    const headingText = heading.firstChild;
    expect(headingText).toBeTruthy();
    const range = document.createRange();
    range.selectNodeContents(headingText as Node);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    const viewerBody =
      container.querySelector<HTMLElement>(".file-viewer-body");
    expect(extractMarkdownSnippetsFromSelection(viewerBody!)).toMatchObject([
      {
        markdown: "# Title",
        selectedText: "Title",
      },
    ]);
  });

  it("follows in-page Markdown links by scrolling the viewer body", async () => {
    const source: FileViewerSource = {
      loadFile: vi.fn(async () => ({
        metadata: {
          path: "notes.md",
          size: 64,
          mimeType: "text/markdown",
          isText: true,
        },
        rawUrl: "",
        content: "[jump](#target)\n\n## Target",
        renderedMarkdownHtml:
          '<p><a href="#user-content-target">jump</a> <a href="#user-content-missing">gone</a></p><h2 id="user-content-target">Target</h2>',
      })),
    };
    const startHash = window.location.hash;

    const { container } = render(
      <I18nProvider>
        <FileViewer
          projectId="project-id"
          filePath="notes.md"
          source={source}
        />
      </I18nProvider>,
    );
    const heading = await screen.findByRole("heading", { name: "Target" });
    const viewerBody =
      container.querySelector<HTMLElement>(".file-viewer-body");
    expect(viewerBody).toBeTruthy();
    Object.defineProperty(viewerBody, "scrollHeight", { value: 2000 });
    Object.defineProperty(viewerBody, "clientHeight", { value: 500 });
    Object.defineProperty(viewerBody, "getBoundingClientRect", {
      value: () => ({ top: 100 }),
    });
    Object.defineProperty(heading, "getBoundingClientRect", {
      value: () => ({ top: 900 }),
    });

    const jump = screen.getByRole("link", { name: "jump" });
    expect(fireEvent.click(jump)).toBe(false);
    expect(viewerBody!.scrollTop).toBe(750);

    expect(fireEvent.click(screen.getByRole("link", { name: "gone" }))).toBe(
      false,
    );
    expect(viewerBody!.scrollTop).toBe(750);
    expect(window.location.hash).toBe(startHash);
  });

  it("keeps select-all active while standalone selection actions mount", async () => {
    const originalRangeRect = Object.getOwnPropertyDescriptor(
      Range.prototype,
      "getBoundingClientRect",
    );
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        top: 100,
        right: 300,
        bottom: 120,
        left: 100,
        width: 200,
        height: 20,
        x: 100,
        y: 100,
        toJSON: () => ({}),
      }),
    });
    localStorage.setItem(UI_KEYS.selectionTextCopyActionEnabled, "true");
    invalidateLocalStorageValues(UI_KEYS.selectionTextCopyActionEnabled);
    const source: FileViewerSource = {
      loadFile: vi.fn(async () => ({
        metadata: {
          path: "notes.md",
          size: 21,
          mimeType: "text/markdown",
          isText: true,
        },
        rawUrl: "",
        content: "# Title\n\nSelected text",
        renderedMarkdownHtml: "<h1>Title</h1><p>Selected text</p>",
      })),
    };

    try {
      render(
        <I18nProvider>
          <FileViewer
            projectId="project-id"
            filePath="notes.md"
            initialPresentation="preview"
            source={source}
            standalone
          />
        </I18nProvider>,
      );

      await screen.findByRole("heading", { name: "Title" });
      const selectAll = screen.getByRole("button", { name: "Select all" });
      expect(fireEvent.pointerDown(selectAll)).toBe(false);
      await act(async () => {
        fireEvent.click(selectAll);
      });

      const copyText = await screen.findByRole("button", {
        name: "Copy text",
      });
      fireEvent.mouseMove(copyText);
      expect(document.getSelection()?.toString()).toContain("Title");
      expect(document.getSelection()?.toString()).toContain("Selected text");
    } finally {
      await act(async () => {
        localStorage.removeItem(UI_KEYS.selectionTextCopyActionEnabled);
        invalidateLocalStorageValues(UI_KEYS.selectionTextCopyActionEnabled);
        document.getSelection()?.removeAllRanges();
      });
      if (originalRangeRect) {
        Object.defineProperty(
          Range.prototype,
          "getBoundingClientRect",
          originalRangeRect,
        );
      } else {
        Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
      }
    }
  });

  it("keeps primary Markdown clicks in the viewer and quotes from circles", async () => {
    const onQuoteTextBlock = vi.fn();
    const source: FileViewerSource = {
      loadFile: vi.fn(async () => ({
        metadata: {
          path: "notes.md",
          size: 21,
          mimeType: "text/markdown",
          isText: true,
        },
        rawUrl: "",
        content: "# Title\n\nSelected text",
        renderedMarkdownHtml: "<h1>Title</h1><p>Selected text</p>",
      })),
    };

    render(
      <I18nProvider>
        <QuoteReplyProvider onQuoteTextBlock={onQuoteTextBlock}>
          <FileViewer
            projectId="project-id"
            filePath="notes.md"
            initialPresentation="preview"
            source={source}
          />
        </QuoteReplyProvider>
      </I18nProvider>,
    );

    const paragraph = await screen.findByText("Selected text");
    const viewerBody = paragraph.closest<HTMLElement>(".file-viewer-body");
    expect(viewerBody?.tabIndex).toBe(-1);

    document.getSelection()?.removeAllRanges();
    fireEvent.pointerDown(paragraph, { button: 0 });
    fireEvent.click(paragraph);

    expect(document.activeElement).toBe(viewerBody);
    expect(onQuoteTextBlock).not.toHaveBeenCalled();
    const pageDown = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "PageDown",
    });
    viewerBody?.dispatchEvent(pageDown);
    expect(pageDown.defaultPrevented).toBe(false);

    await waitFor(() =>
      expect(
        screen.getAllByRole("button", { name: /Quote this paragraph/ }),
      ).toHaveLength(2),
    );
    const quoteButtons = screen.getAllByRole("button", {
      name: /Quote this paragraph/,
    });
    fireEvent.click(quoteButtons[1]!);

    expect(onQuoteTextBlock).toHaveBeenCalledTimes(1);
    expect(onQuoteTextBlock.mock.calls[0]?.[0]).toMatchObject({
      quotedText: "> Selected text",
      selectedText: "Selected text",
    });
  });

  it("uses one whole-document quote circle in block-only mode", async () => {
    setQuoteReplyButtonModePreference("block");
    const onQuoteTextBlock = vi.fn();
    const source: FileViewerSource = {
      loadFile: vi.fn(async () => ({
        metadata: {
          path: "notes.md",
          size: 21,
          mimeType: "text/markdown",
          isText: true,
        },
        rawUrl: "",
        content: "# Title\n\nSelected text",
        renderedMarkdownHtml: "<h1>Title</h1><p>Selected text</p>",
      })),
    };

    render(
      <I18nProvider>
        <QuoteReplyProvider onQuoteTextBlock={onQuoteTextBlock}>
          <FileViewer
            projectId="project-id"
            filePath="notes.md"
            initialPresentation="preview"
            source={source}
          />
        </QuoteReplyProvider>
      </I18nProvider>,
    );

    const selectedText = await screen.findByText("Selected text");
    const viewerBody = selectedText.closest<HTMLElement>(".file-viewer-body");
    await waitFor(() =>
      expect(viewerBody?.getAttribute("data-markdown-copy-source")).toBe(
        "true",
      ),
    );
    const quoteButtons = screen.getAllByRole("button", {
      name: /Quote this paragraph/,
    });
    expect(quoteButtons).toHaveLength(1);
    expect(quoteButtons[0]?.classList).toContain("text-block-quote-fallback");
    fireEvent.click(quoteButtons[0]!);
    expect(onQuoteTextBlock).toHaveBeenCalledTimes(1);
    const anchor = onQuoteTextBlock.mock.calls[0]?.[0];
    expect(anchor?.quotedText).toContain("# Title");
    expect(anchor?.quotedText).toContain("Selected text");
    expect(anchor?.selectedText).not.toContain(">");
  });

  it("opens Quarto files rendered and maps include selections to source", async () => {
    const sourceMarkdown = "{{< include _introduction.qmd >}}";
    const fileResponse: FileContentResponse = {
      metadata: {
        path: "report.qmd",
        size: sourceMarkdown.length,
        mimeType: "text/markdown",
        isText: true,
      },
      rawUrl: "",
      content: sourceMarkdown,
      highlightedHtml:
        '<pre class="shiki"><code><span class="line">{{&lt; include _introduction.qmd &gt;}}</span></code></pre>',
      renderedMarkdownHtml:
        '<p>Include: <a href="/projects/project-id/file?path=_introduction.qmd" data-ya-resource="project-file" data-ya-project-id="project-id" data-ya-path="_introduction.qmd"><code>_introduction.qmd</code></a></p>',
    };
    const source: FileViewerSource = {
      loadFile: vi.fn(async () => fileResponse),
    };

    const { container } = render(
      <I18nProvider>
        <FileViewer
          projectId="project-id"
          filePath="report.qmd"
          source={source}
        />
      </I18nProvider>,
    );

    const includePath = await screen.findByText("_introduction.qmd");
    const viewerBody =
      container.querySelector<HTMLElement>(".file-viewer-body");
    await waitFor(() =>
      expect(viewerBody?.getAttribute("data-markdown-copy-source")).toBe(
        "true",
      ),
    );
    const range = document.createRange();
    range.selectNodeContents(includePath);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    expect(extractMarkdownSnippetsFromSelection(viewerBody!)).toMatchObject([
      {
        markdown: "_introduction.qmd",
        selectedText: "_introduction.qmd",
      },
    ]);

    range.selectNodeContents(includePath.closest("p")!);
    selection?.removeAllRanges();
    selection?.addRange(range);
    expect(extractMarkdownSnippetsFromSelection(viewerBody!)).toMatchObject([
      {
        markdown: sourceMarkdown,
        selectedText: "Include: _introduction.qmd",
      },
    ]);
  });

  it("defaults HTML to a confined static preview and offers raw source", async () => {
    const fileResponse: FileContentResponse = {
      metadata: {
        path: "reports/demo.html",
        size: 96,
        mimeType: "text/html",
        isText: true,
      },
      rawUrl: "",
      content:
        '<h1>Preview heading</h1><script>parent.document.body.dataset.pwned="1"</script>',
    };
    const source: FileViewerSource = {
      loadFile: vi.fn(async () => fileResponse),
    };

    const { container } = render(
      <I18nProvider>
        <FileViewer
          projectId="project-id"
          filePath="reports/demo.html"
          source={source}
        />
      </I18nProvider>,
    );

    const rawSource = await screen.findByRole("button", {
      name: "Raw source",
    });
    const frame = container.querySelector<HTMLIFrameElement>("iframe");
    expect(frame).toBeTruthy();
    expect(rawSource.getAttribute("aria-pressed")).toBe("false");
    // Same-origin so the viewer's find can search it; never with scripts.
    expect(frame?.getAttribute("sandbox")).toBe("allow-same-origin");
    expect(frame?.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame?.srcdoc).toContain("Content-Security-Policy");
    expect(frame?.srcdoc).toContain("default-src 'none'");
    expect(document.body.dataset.pwned).toBeUndefined();

    fireEvent.click(rawSource);
    expect(container.querySelector("iframe")).toBeNull();
    expect(rawSource.getAttribute("aria-pressed")).toBe("true");
  });

  it("honors an HTML preview selected before the project viewer opens", async () => {
    const fileResponse: FileContentResponse = {
      metadata: {
        path: "reports/demo.html",
        size: 32,
        mimeType: "text/html",
        isText: true,
      },
      rawUrl: "",
      content: "<p>Chosen preview</p>",
    };
    const source: FileViewerSource = {
      loadFile: vi.fn(async () => fileResponse),
    };

    const { container } = render(
      <I18nProvider>
        <FileViewer
          projectId="project-id"
          filePath="reports/demo.html"
          initialPresentation="preview"
          source={source}
        />
      </I18nProvider>,
    );

    await waitFor(() => expect(container.querySelector("iframe")).toBeTruthy());
    expect(
      screen
        .getByRole("button", { name: "Raw source" })
        .getAttribute("aria-pressed"),
    ).toBe("false");
  });

  it("frames a same-origin PDF's own response, not a CSP-inheriting blob", async () => {
    const fileResponse: FileContentResponse = {
      metadata: {
        path: "docs/report.pdf",
        size: 39_000,
        mimeType: "application/pdf",
        isText: false,
      },
      rawUrl: "/api/projects/project-id/files/raw?path=docs%2Freport.pdf",
    };
    const source: FileViewerSource = {
      loadFile: vi.fn(async () => fileResponse),
      fetchRawFileBlob: vi.fn(async () => new Blob(["%PDF-1.7"])),
    };

    render(
      <I18nProvider>
        <FileViewer
          projectId="project-id"
          filePath="docs/report.pdf"
          source={source}
        />
      </I18nProvider>,
    );

    const frame = await screen.findByTitle("report.pdf");
    expect(frame.tagName).toBe("IFRAME");
    expect(frame.getAttribute("src")).toBe(fileResponse.rawUrl);
    expect(source.fetchRawFileBlob).not.toHaveBeenCalled();
    expect(screen.queryByText("This file cannot be displayed inline.")).toBe(
      null,
    );
  });

  function stubObjectUrls(url: string) {
    const createObjectURL = vi.fn((_blob: Blob) => url);
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: createObjectURL,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    return createObjectURL;
  }

  /** Render where `/api` URLs are not addressable, as over relay. */
  function renderRelayed(ui: ReactElement) {
    const runtime: YaSourceRuntime = {
      sourceKey: LOCAL_CLIENT_SUMMARY_SOURCE_KEY,
      transport: new FakeSourceTransport({
        kind: "secure",
        capabilities: { sameOriginUrls: false },
      }),
      api: {} as YaSourceRuntime["api"],
      summary: {} as YaSourceRuntime["summary"],
      sessionDetails: {} as YaSourceRuntime["sessionDetails"],
    };
    return render(
      <SourceRuntimeProvider runtime={runtime}>{ui}</SourceRuntimeProvider>,
    );
  }

  it("plays a direct-transport video from its versioned raw URL, not a blob", async () => {
    const source: FileViewerSource = {
      loadFile: vi.fn(async () => ({
        metadata: {
          path: "clips/demo.mp4",
          size: 2048,
          mimeType: "video/mp4",
          isText: false,
          modifiedAt: 1_759_500_000_000,
        },
        rawUrl: "/api/projects/project-id/files/raw?path=clips%2Fdemo.mp4",
      })),
      fetchRawFileBlob: vi.fn(async () => new Blob(["media"])),
    };
    const { container } = render(
      <I18nProvider>
        <FileViewer
          projectId="project-id"
          filePath="clips/demo.mp4"
          source={source}
        />
      </I18nProvider>,
    );

    await waitFor(() => expect(container.querySelector("video")).toBeTruthy());
    expect(container.querySelector("video")!.getAttribute("src")).toBe(
      "/api/projects/project-id/files/raw?path=clips%2Fdemo.mp4&v=1759500000000-2048",
    );
    expect(source.fetchRawFileBlob).not.toHaveBeenCalled();
  });

  function binarySource(path: string, mimeType: string): FileViewerSource {
    return {
      loadFile: vi.fn(async () => ({
        metadata: { path, size: 2048, mimeType, isText: false },
        rawUrl: `/api/projects/project-id/files/raw?path=${path}`,
      })),
      fetchRawFileBlob: vi.fn(async () => new Blob(["media"])),
    };
  }

  it("plays audio inline and falls back when the browser cannot decode it", async () => {
    const createObjectURL = stubObjectUrls("blob:file-viewer-audio");
    const { container } = renderRelayed(
      <I18nProvider>
        <FileViewer
          projectId="project-id"
          filePath="clips/take.m4a"
          source={binarySource("clips/take.m4a", "audio/mp4")}
        />
      </I18nProvider>,
    );

    await waitFor(() => expect(container.querySelector("audio")).toBeTruthy());
    const audio = container.querySelector("audio")!;
    expect(audio.getAttribute("src")).toBe("blob:file-viewer-audio");
    expect(audio.hasAttribute("controls")).toBe(true);
    // The relayed blob arrived untyped; the player needs the file's type.
    expect(createObjectURL.mock.calls[0]?.[0].type).toBe("audio/mp4");

    fireEvent.error(audio);
    expect(
      await screen.findByText("This file cannot be displayed inline."),
    ).toBeTruthy();
  });

  it("plays video inline", async () => {
    stubObjectUrls("blob:file-viewer-video");
    const { container } = renderRelayed(
      <I18nProvider>
        <FileViewer
          projectId="project-id"
          filePath="clips/demo.mp4"
          source={binarySource("clips/demo.mp4", "video/mp4")}
        />
      </I18nProvider>,
    );

    await waitFor(() => expect(container.querySelector("video")).toBeTruthy());
    expect(container.querySelector("video")!.getAttribute("src")).toBe(
      "blob:file-viewer-video",
    );
  });

  it("shows a font specimen from the loaded face", async () => {
    stubObjectUrls("blob:file-viewer-font");
    const added: unknown[] = [];
    class FakeFontFace {
      constructor(
        readonly family: string,
        readonly source: string,
      ) {}
      load() {
        return Promise.resolve(this);
      }
    }
    vi.stubGlobal("FontFace", FakeFontFace);
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: { add: (face: unknown) => added.push(face), delete: vi.fn() },
    });
    try {
      const { container } = renderRelayed(
        <I18nProvider>
          <FileViewer
            projectId="project-id"
            filePath="fonts/Brand.woff2"
            source={binarySource("fonts/Brand.woff2", "font/woff2")}
          />
        </I18nProvider>,
      );

      await screen.findAllByText("The quick brown fox jumps over the lazy dog");
      const specimen = container.querySelector<HTMLElement>(
        "[data-font-specimen]",
      )!;
      const face = added[0] as FakeFontFace;
      expect(face.source).toBe('url("blob:file-viewer-font")');
      expect(specimen.style.fontFamily).toContain(face.family);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("renders only the leading lines of large unhighlighted text", async () => {
    const content = Array.from(
      { length: 10_005 },
      (_, i) => `row ${i + 1}`,
    ).join("\n");
    const source: FileViewerSource = {
      loadFile: vi.fn(async () => ({
        metadata: {
          path: "data/big.log",
          size: content.length,
          mimeType: "application/octet-stream",
          isText: true,
        },
        content,
        rawUrl: "/api/projects/project-id/files/raw?path=data/big.log",
      })),
    };

    const { container } = render(
      <I18nProvider>
        <FileViewer
          projectId="project-id"
          filePath="data/big.log"
          source={source}
        />
      </I18nProvider>,
    );

    expect(
      await screen.findByText("Showing the first 10000 of 10005 lines"),
    ).toBeTruthy();
    expect(
      container.querySelectorAll(".code-content [data-line]"),
    ).toHaveLength(10_000);
    // Rendering the full 10,000-line cap in jsdom takes ~1s locally but has
    // exceeded the 5s default on a loaded upstream CI runner.
  }, 20_000);

  it("finds within its own content after a click there", async () => {
    // jsdom has no layout; a real browser reports an empty box off-screen.
    Range.prototype.getBoundingClientRect ??= () => new DOMRect();
    const source: FileViewerSource = {
      loadFile: vi.fn(async () => ({
        metadata: {
          path: "notes.txt",
          size: 22,
          mimeType: "text/plain",
          isText: true,
        },
        content: "alpha beta\nbeta gamma",
        rawUrl: "/api/projects/project-id/files/raw?path=notes.txt",
      })),
    };
    const { container } = render(
      <I18nProvider>
        <FileViewer
          projectId="project-id"
          filePath="notes.txt"
          source={source}
        />
      </I18nProvider>,
    );
    await screen.findByText("alpha beta");
    const findBox = () =>
      screen.queryByRole("searchbox", { name: "Find in this view" });
    // Until the reader has clicked into the viewer, Ctrl+F stays the browser's.
    expect(fireEvent.keyDown(document.body, { key: "f", ctrlKey: true })).toBe(
      true,
    );
    expect(findBox()).toBeNull();

    const body = container.querySelector<HTMLElement>(".file-viewer-body")!;
    fireEvent.pointerDown(body);
    expect(fireEvent.keyDown(body, { key: "f", ctrlKey: true })).toBe(false);
    const input = findBox()!;
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: "beta" } });
    expect(await screen.findByText("1/2")).toBeTruthy();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByText("2/2")).toBeTruthy();
    fireEvent.keyDown(input, { key: "r", ctrlKey: true });
    expect(await screen.findByText("1/2")).toBeTruthy();
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(findBox()).toBeNull());
    expect(document.activeElement).toBe(body);
  });

  it("keeps raw image links and moves the viewer through its stable URL", async () => {
    const fileResponse: FileContentResponse = {
      metadata: {
        path: "screenshots/result.png",
        size: 128,
        mimeType: "image/png",
        isText: false,
      },
      rawUrl:
        "/api/projects/project-id/files/raw?path=screenshots%2Fresult.png",
    };
    const source: FileViewerSource = {
      loadFile: vi.fn(async () => fileResponse),
      fetchRawFileBlob: vi.fn(
        async () => new Blob(["png"], { type: "image/png" }),
      ),
    };
    const openMock = vi.fn();
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:file-viewer-image"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(window, "open", {
      configurable: true,
      value: openMock,
    });

    const { container } = render(
      <I18nProvider>
        <FileViewer
          projectId="project-id"
          filePath="screenshots/result.png"
          source={source}
        />
      </I18nProvider>,
    );

    const imageLink = await screen.findByRole("link", {
      name: "Open image in new tab",
    });
    expect(imageLink.getAttribute("href")).toBe(
      "/api/projects/project-id/files/raw?path=screenshots%2Fresult.png",
    );
    expect(imageLink.getAttribute("target")).toBe("_blank");
    expect(imageLink.getAttribute("rel")).toBe("noopener noreferrer");
    const image = await screen.findByRole("img", { name: "result.png" });
    // A direct transport shows the raw response rather than a blob copy.
    expect(image.getAttribute("src")).toBe(
      "/api/projects/project-id/files/raw?path=screenshots%2Fresult.png",
    );
    expect(source.fetchRawFileBlob).not.toHaveBeenCalled();
    fireEvent.contextMenu(image);
    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual([
      "Open",
      "Download",
      "Copy image",
      "Copy project-relative path",
      "Copy absolute file path",
      "Copy viewer link",
    ]);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

    const openLink = container.querySelector<HTMLAnchorElement>(
      '.file-viewer-actions a[aria-label="Move viewer to new tab"]',
    );
    expect(new URL(openLink!.href).pathname).toBe("/projects/project-id/file");
    expect(new URL(openLink!.href).searchParams.get("path")).toBe(
      "screenshots/result.png",
    );
    expect(openLink?.getAttribute("target")).toBe("_blank");
    expect(openLink?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(openMock).not.toHaveBeenCalled();
  });

  it("sends source-line comments without using the paragraph quote rail", async () => {
    const onSendComment = vi.fn(async () => true);
    const source: FileViewerSource = {
      loadFile: vi.fn(async () => ({
        metadata: {
          path: "src/example.ts",
          size: 34,
          mimeType: "text/typescript",
          isText: true,
        },
        rawUrl: "",
        content: "const first = 1;\nconst second = 2;\nreturn first;",
        highlightedHtml:
          '<pre class="shiki"><code><span class="line">const first = 1;</span>\n<span class="line">const second = 2;</span>\n<span class="line">return first;</span></code></pre>',
      })),
    };
    const projectId = toUrlProjectId("/workspace");
    const { container } = render(
      <I18nProvider>
        <SessionMetadataProvider
          projectId={projectId}
          projectPath="/workspace"
          sessionId="session-id"
        >
          <SessionViewerCommentProvider onSendComment={onSendComment}>
            <QuoteReplyProvider onQuoteTextBlock={vi.fn()}>
              <FileViewer
                projectId={projectId}
                filePath="src/example.ts"
                source={source}
                onClose={vi.fn()}
              />
            </QuoteReplyProvider>
          </SessionViewerCommentProvider>
        </SessionMetadataProvider>
      </I18nProvider>,
    );

    const toggle = await screen.findByRole("button", { name: "Comment" });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(
      screen.queryByRole("button", { name: /Quote this paragraph/ }),
    ).toBeNull();

    const secondLine = container.querySelector<HTMLElement>('[data-line="2"]');
    expect(secondLine).toBeTruthy();
    fireEvent.click(secondLine!);
    const editor = await screen.findByPlaceholderText(
      "Comment or ask a question…",
    );
    expect(screen.getByText("src/example.ts:2")).toBeTruthy();
    fireEvent.change(editor, {
      target: { value: "Should these share a name?" },
    });
    fireEvent.keyDown(editor, { key: "Enter", shiftKey: true });
    expect(onSendComment).not.toHaveBeenCalled();
    fireEvent.keyDown(editor, { key: "Enter" });

    await waitFor(() =>
      expect(onSendComment).toHaveBeenCalledWith(
        "src/example.ts:2\n\n> const first = 1;\n> const second = 2;\n> return first;\n\nShould these share a name?",
      ),
    );
    await waitFor(() => expect(editor.isConnected).toBe(false));
  });

  it("flushes unsent source comments as one grouped session turn", async () => {
    const onSendComment = vi.fn(async () => true);
    const onClose = vi.fn();
    const source: FileViewerSource = {
      loadFile: vi.fn(async () => ({
        metadata: {
          path: "src/example.ts",
          size: 13,
          mimeType: "text/typescript",
          isText: true,
        },
        rawUrl: "",
        content: "one\ntwo\nthree",
        highlightedHtml:
          '<pre class="shiki"><code><span class="line">one</span>\n<span class="line">two</span>\n<span class="line">three</span></code></pre>',
      })),
    };
    const projectId = toUrlProjectId("/workspace");
    const { container } = render(
      <I18nProvider>
        <SessionMetadataProvider
          projectId={projectId}
          projectPath="/workspace"
          sessionId="session-id"
        >
          <SessionViewerCommentProvider onSendComment={onSendComment}>
            <FileViewer
              projectId={projectId}
              filePath="src/example.ts"
              source={source}
              onClose={onClose}
            />
          </SessionViewerCommentProvider>
        </SessionMetadataProvider>
      </I18nProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Comment" }));
    fireEvent.click(container.querySelector<HTMLElement>('[data-line="1"]')!);
    fireEvent.change(
      await screen.findByPlaceholderText("Comment or ask a question…"),
      { target: { value: "First comment" } },
    );
    fireEvent.click(container.querySelector<HTMLElement>('[data-line="3"]')!);
    fireEvent.change(
      await screen.findByPlaceholderText("Comment or ask a question…"),
      { target: { value: "Second comment" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(onClose).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(onSendComment).toHaveBeenCalledTimes(1));
    expect(onSendComment).toHaveBeenCalledWith(
      "src/example.ts:1\n\n> one\n> two\n> three\n\nFirst comment\n\n---\n\nsrc/example.ts:3\n\n> one\n> two\n> three\n\nSecond comment",
    );
  });

  it("opens the comment composer from a rendered-text selection", async () => {
    const onSendComment = vi.fn(async () => true);
    const source: FileViewerSource = {
      loadFile: vi.fn(async () => ({
        metadata: {
          path: "notes.md",
          size: 22,
          mimeType: "text/markdown",
          isText: true,
        },
        rawUrl: "",
        content: "# Title\n\nSelected words",
        renderedMarkdownHtml: "<h1>Title</h1><p>Selected words</p>",
      })),
    };
    const projectId = toUrlProjectId("/workspace");
    render(
      <I18nProvider>
        <SessionMetadataProvider
          projectId={projectId}
          projectPath="/workspace"
          sessionId="session-id"
        >
          <SessionViewerCommentProvider onSendComment={onSendComment}>
            <QuoteReplyProvider onQuoteTextBlock={vi.fn()}>
              <FileViewer
                projectId={projectId}
                filePath="notes.md"
                initialPresentation="preview"
                source={source}
                onClose={vi.fn()}
              />
            </QuoteReplyProvider>
          </SessionViewerCommentProvider>
        </SessionMetadataProvider>
      </I18nProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Comment" }));
    const selectedText = screen.getByText("Selected words");
    const range = document.createRange();
    range.selectNodeContents(selectedText);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    act(() => document.dispatchEvent(new Event("selectionchange")));

    const editor = await screen.findByPlaceholderText(
      "Comment or ask a question…",
    );
    expect(editor).toBeTruthy();
    expect(screen.getByText("notes.md:3")).toBeTruthy();
    const selectedCopies = screen.getAllByText("Selected words");
    expect(selectedCopies.length).toBeGreaterThan(1);
    const renderedSelection = selectedCopies.find(
      (element) => element.tagName === "P",
    );
    expect(renderedSelection?.nextElementSibling?.contains(editor)).toBe(true);
    expect(editor.closest("[data-review-comment-inline]")).toBeTruthy();
    expect(document.activeElement).not.toBe(editor);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(editor.isConnected).toBe(false));
    expect(onSendComment).not.toHaveBeenCalled();
  });
});
