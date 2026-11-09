import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { getCurrentClientSummarySourceKey } from "../../lib/clientSummaryStore";
import { getNewSessionPrefill } from "../../lib/newSessionPrefill";
import {
  FilePathContextMenu,
  ResourceContextMenu,
  useStartNewSessionFromFileAction,
  useStartNewSessionWithPrefillAction,
} from "../FileResourceActions";
import { api } from "../../api/client";

const versionState = vi.hoisted(() => ({
  capabilities: [] as string[],
}));
vi.mock("../../hooks/useVersion", () => ({
  useRetainedVersionInfo: () => ({
    current: "0.0.0-dev",
    capabilities: versionState.capabilities,
  }),
  useVersion: () => ({
    version: {
      current: "0.0.0-dev",
      capabilities: versionState.capabilities,
    },
    loading: false,
    error: null,
  }),
}));

function renderMenu(
  props: Partial<Parameters<typeof FilePathContextMenu>[0]> = {},
) {
  const onClose = vi.fn();
  const handlers = {
    onCopyAbsolutePath: vi.fn(),
    onCopyContents: vi.fn(),
    onCopyRenderedContents: vi.fn(),
    onCopyProjectRelativePath: vi.fn(),
    onCopyViewerLink: vi.fn(),
    onOpen: vi.fn(),
    onOpenPreview: vi.fn(),
    onOpenSource: vi.fn(),
    onStartNewSession: vi.fn(),
  };
  render(
    <I18nProvider>
      <FilePathContextMenu
        x={10}
        y={10}
        onClose={onClose}
        {...handlers}
        {...props}
      />
    </I18nProvider>,
  );
  return { onClose, ...handlers };
}

/** A hover-capable fine pointer, which gets the Open flyout. */
function stubFinePointer() {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(
      () =>
        ({
          matches: true,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        }) as unknown as MediaQueryList,
    ),
  );
}

describe("FilePathContextMenu", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    versionState.capabilities = [];
  });

  it("opens an outside path's Source Control browser in a new tab", () => {
    versionState.capabilities = ["local-source-browse"];
    const open = vi.fn();
    vi.stubGlobal("open", open);
    const { onClose } = renderMenu({
      localSource: { projectId: "cHJvag", path: "/tmp/demo/a b.ts" },
    });

    fireEvent.click(
      screen.getByRole("menuitem", { name: "Open in Source Control" }),
    );

    expect(open).toHaveBeenCalledWith(
      "/projects/cHJvag/browse?path=%2Ftmp%2Fdemo%2Fa+b.ts",
      "_blank",
      "noopener",
    );
    expect(onClose).toHaveBeenCalled();
  });

  it("omits Open in Source Control on a server without the capability", () => {
    versionState.capabilities = [];
    renderMenu({ localSource: { projectId: "cHJvag", path: "/tmp/a.ts" } });

    expect(
      screen.queryByRole("menuitem", { name: "Open in Source Control" }),
    ).toBeNull();
  });

  it("portals the menu directly into the body", () => {
    renderMenu();

    expect(screen.getByRole("menu").parentElement).toBe(document.body);
  });

  it("keeps copy actions flat while open uses a touch-selectable panel", () => {
    renderMenu();

    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual([
      "Open›",
      "New session",
      "Copy project-relative path",
      "Copy absolute file path",
      "Copy viewer link",
      "Copy contents",
      "Copy rendered contents",
    ]);

    fireEvent.click(screen.getByRole("menuitem", { name: "Open" }));
    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual(["‹Back", "Source", "Preview"]);
    expect(document.activeElement).toBe(
      screen.getByRole("menuitem", { name: "Back" }),
    );

    fireEvent.click(screen.getByRole("menuitem", { name: "Back" }));
    expect(document.activeElement).toBe(
      screen.getByRole("menuitem", { name: "Open" }),
    );
    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual([
      "Open›",
      "New session",
      "Copy project-relative path",
      "Copy absolute file path",
      "Copy viewer link",
      "Copy contents",
      "Copy rendered contents",
    ]);
  });

  it("adds capability-shaped image actions without file-only entries", () => {
    const onCopyImage = vi.fn();
    render(
      <I18nProvider>
        <ResourceContextMenu
          x={10}
          y={10}
          canStartNewSession={false}
          onClose={vi.fn()}
          onCopyImage={onCopyImage}
          download={{ fileName: "plot.png", loadBlob: vi.fn() }}
          onOpen={vi.fn()}
        />
      </I18nProvider>,
    );

    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual(["Open", "Download", "Copy image"]);

    fireEvent.click(screen.getByRole("menuitem", { name: "Copy image" }));
    expect(onCopyImage).toHaveBeenCalledTimes(1);
  });

  it("offers a public URL copy action when the caller resolves one", () => {
    const onCopyPublicUrl = vi.fn();
    render(
      <I18nProvider>
        <ResourceContextMenu
          x={10}
          y={10}
          canStartNewSession={false}
          onClose={vi.fn()}
          onCopyPublicUrl={onCopyPublicUrl}
          onOpen={vi.fn()}
        />
      </I18nProvider>,
    );

    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual(["Open", "Copy public URL"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy public URL" }));
    expect(onCopyPublicUrl).toHaveBeenCalledTimes(1);
  });

  it("copies the committed GitHub URL and keeps dirty guidance at the bottom", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { language: "en", clipboard: { writeText } });
    const url = "https://github.com/me/repo/blob/1234/file.txt";
    versionState.capabilities = ["git-file-revision"];
    vi.spyOn(api, "getGitFileRevision").mockResolvedValue({
      path: "file.txt",
      isGitRepo: true,
      commit: null,
      dirty: true,
      githubLink: { url, pushed: true },
    });
    const { onClose } = renderMenu({
      fileTarget: { projectId: "project", path: "file.txt" },
    });
    await waitFor(() =>
      expect(
        screen.queryByRole("menuitem", { name: /Copy GitHub link/ }),
      ).not.toBeNull(),
    );
    const item = screen.getByRole("menuitem", { name: /Copy GitHub link/ });
    expect(screen.getAllByRole("menuitem").at(-1)).toBe(item);
    expect(item.textContent).toContain("Local edits won’t be included");
    fireEvent.click(item);
    expect(writeText).toHaveBeenCalledWith(url);
    expect(onClose).toHaveBeenCalled();
  });

  it("disables an unpushed GitHub revision even when the file is dirty", async () => {
    versionState.capabilities = ["git-file-revision"];
    vi.spyOn(api, "getGitFileRevision").mockResolvedValue({
      path: "file.txt",
      isGitRepo: true,
      commit: null,
      dirty: true,
      githubLink: {
        url: "https://github.com/me/repo/blob/1234/file.txt",
        pushed: false,
      },
    });
    const { onClose } = renderMenu({
      fileTarget: { projectId: "project", path: "file.txt" },
    });
    const item = await screen.findByRole("menuitem", {
      name: /Copy GitHub link/,
    });
    expect(item.getAttribute("aria-disabled")).toBe("true");
    expect(item.textContent).toContain("Revision not pushed to GitHub");
    expect(item.textContent).not.toContain("Local edits");
    fireEvent.click(item);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("opens adjacent submenus on hover-capable pointers", () => {
    stubFinePointer();
    renderMenu();

    const rootMenu = screen.getByRole("menu");
    const openItem = within(rootMenu).getByRole("menuitem", { name: "Open" });
    fireEvent.mouseEnter(openItem);

    expect(document.body.contains(rootMenu)).toBe(true);
    expect(openItem.getAttribute("aria-expanded")).toBe("true");
    expect(
      within(screen.getByRole("menu", { name: "Open" }))
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["Source", "Preview"]);
    expect(screen.queryByRole("menuitem", { name: "Back" })).toBeNull();

    fireEvent.mouseEnter(
      within(rootMenu).getByRole("menuitem", {
        name: "Copy project-relative path",
      }),
    );
    expect(screen.queryByRole("menu", { name: "Open" })).toBeNull();
    expect(document.body.contains(rootMenu)).toBe(true);
  });

  it("enters the flyout by key and closes only it on Escape", () => {
    stubFinePointer();
    const { onClose, onOpenSource } = renderMenu();

    const openItem = screen.getByRole("menuitem", { name: "Open" });
    expect(document.activeElement).toBe(openItem);
    fireEvent.keyDown(openItem, { key: "ArrowRight" });
    const source = screen.getByRole("menuitem", { name: "Source" });
    expect(document.activeElement).toBe(source);

    fireEvent.keyDown(source, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "Open" })).toBeNull();
    expect(document.activeElement).toBe(openItem);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(openItem, { key: "ArrowRight" });
    fireEvent.click(screen.getByRole("menuitem", { name: "Source" }));
    expect(onOpenSource).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("omits the conditional items when their actions are unavailable", () => {
    renderMenu({
      canStartNewSession: false,
      onCopyAbsolutePath: undefined,
      onCopyContents: undefined,
      onCopyRenderedContents: undefined,
      onCopyProjectRelativePath: undefined,
      onCopyViewerLink: undefined,
      onOpenPreview: undefined,
      onOpenSource: undefined,
    });

    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual(["Open"]);
  });

  it("uses an unclassified file-path label when no stronger path is known", () => {
    renderMenu({
      onCopyAbsolutePath: undefined,
      onCopyContents: undefined,
      onCopyRenderedContents: undefined,
      onCopyFilePath: vi.fn(),
      onCopyProjectRelativePath: undefined,
      onCopyViewerLink: undefined,
      onStartNewSession: undefined,
    });

    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual(["Open›", "Copy file path"]);
  });

  it("runs the selected action and then closes", () => {
    // The array records both order and count: exactly one of each, action first.
    const sequence: string[] = [];
    renderMenu({
      onClose: () => sequence.push("close"),
      onCopyProjectRelativePath: () => sequence.push("copyPath"),
    });

    fireEvent.click(
      screen.getByRole("menuitem", { name: "Copy project-relative path" }),
    );

    expect(sequence).toEqual(["copyPath", "close"]);
  });

  it("closes on Escape and on a press outside", () => {
    const { onClose } = renderMenu();

    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

const TOKEN_KEY_PREFIX = "new-session-prefill-token:";

function tokenKeys(): string[] {
  const keys: string[] = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (key?.startsWith(TOKEN_KEY_PREFIX)) keys.push(key);
  }
  return keys;
}

function startNewTabSession(): void {
  const { result } = renderHook(() => useStartNewSessionWithPrefillAction());
  act(() => {
    result.current("project-1", "handoff text", { newTab: true });
  });
}

describe("useStartNewSessionWithPrefillAction", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    versionState.capabilities = [];
    localStorage.clear();
    sessionStorage.clear();
  });

  it("stashes the prefill once the new tab exists", () => {
    vi.stubGlobal(
      "open",
      vi.fn(() => ({ opener: window }) as unknown as Window),
    );

    startNewTabSession();

    expect(tokenKeys()).toHaveLength(1);
  });

  it("opens a host file's session in the project that owns it", async () => {
    versionState.capabilities = ["file-owner-project"];
    const lookup = vi.spyOn(api, "getFileOwner").mockResolvedValue({
      owner: {
        projectId: "project-b" as never,
        projectPath: "/work/b",
        relativePath: "gaps/example.md",
      },
    });
    const { result } = renderHook(() => useStartNewSessionFromFileAction());
    await act(async () => {
      result.current("project-a", "~/b/gaps/example.md");
    });
    expect(lookup).toHaveBeenCalledWith("project-a", "~/b/gaps/example.md");
    expect(new URLSearchParams(window.location.search).get("projectId")).toBe(
      "project-b",
    );
    expect(getNewSessionPrefill(getCurrentClientSummarySourceKey())).toBe(
      "gaps/example.md",
    );
  });

  it("keeps the linking project for unowned files and older servers", async () => {
    const lookup = vi
      .spyOn(api, "getFileOwner")
      .mockResolvedValue({ owner: null });
    const { result } = renderHook(() => useStartNewSessionFromFileAction());
    versionState.capabilities = ["file-owner-project"];
    const withOwner = renderHook(() => useStartNewSessionFromFileAction());
    await act(async () => {
      withOwner.result.current("project-a", "/tmp/report.md");
    });
    expect(new URLSearchParams(window.location.search).get("projectId")).toBe(
      "project-a",
    );
    expect(getNewSessionPrefill(getCurrentClientSummarySourceKey())).toBe(
      "/tmp/report.md",
    );
    versionState.capabilities = [];
    lookup.mockClear();
    const older = renderHook(() => useStartNewSessionFromFileAction());
    await act(async () => {
      older.result.current("project-a", "/tmp/other.md");
      result.current("project-a", "src/local.ts");
    });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("leaves no token behind when the browser blocks the new tab", () => {
    vi.stubGlobal(
      "open",
      vi.fn(() => null),
    );

    startNewTabSession();

    expect(tokenKeys()).toEqual([]);
    expect(getNewSessionPrefill(getCurrentClientSummarySourceKey())).toBe(
      "handoff text",
    );
  });
});
