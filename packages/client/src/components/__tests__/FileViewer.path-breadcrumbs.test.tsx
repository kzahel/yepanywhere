// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { FolderListingResponse } from "@yep-anywhere/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clickLink } from "../../../test/linkNavigation";
import { I18nProvider } from "../../i18n";
import { FileViewer, type FileViewerSource } from "../FileViewer";

vi.mock("../../hooks/useFileVersionControl", () => ({
  useFileVersionControl: () => ({ loading: false, relativePath: null }),
}));

vi.mock("../../hooks/useVersion", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useVersion")>()),
  useVersion: () => ({
    version: { capabilities: ["file-folder-listing"] },
    loading: false,
  }),
}));

const sections: FolderListingResponse = {
  path: "paper/sections",
  truncated: false,
  entries: [
    { name: "_30-results.qmd", kind: "file", size: 9, modifiedAt: 0 },
    { name: "_10-intro.qmd", kind: "file", size: 4, modifiedAt: 0 },
    { name: "figures", kind: "folder", modifiedAt: 0 },
    { name: "_20-method.qmd", kind: "file", size: 6, modifiedAt: 0 },
  ],
};

function renderViewer(
  onNavigateFile: (path: string) => void,
  initialFolder?: string,
) {
  const listFolder = vi.fn(async () => sections);
  const source: FileViewerSource = {
    loadFile: async () => ({
      metadata: {
        path: "paper/sections/_20-method.qmd",
        size: 6,
        mimeType: "text/markdown",
        isText: true,
      },
      rawUrl: "",
      content: "method\n",
    }),
    listFolder,
  };
  render(
    <I18nProvider>
      <FileViewer
        projectId="project-id"
        filePath="paper/sections/_20-method.qmd"
        source={source}
        onNavigateFile={onNavigateFile}
        initialFolder={initialFolder}
      />
    </I18nProvider>,
  );
  return listFolder;
}

describe("FileViewer path segments", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("lists a folder segment and opens a sibling in place", async () => {
    const onNavigateFile = vi.fn();
    const listFolder = renderViewer(onNavigateFile);

    fireEvent.click(await screen.findByRole("link", { name: "sections" }));
    expect(listFolder).toHaveBeenCalledWith("project-id", "paper/sections");
    const dialog = await screen.findByRole("dialog", {
      name: "Folder sections/",
    });
    // Folders first, then names; the open file is marked.
    const rows = [...dialog.querySelectorAll("li > *")].map(
      (row) => row.textContent,
    );
    expect(rows.map((text) => text?.split(/\d/)[0])).toEqual([
      "../",
      "figures/",
      "_",
      "_",
      "_",
    ]);
    expect(
      dialog.querySelector('[aria-current="page"]')?.textContent,
    ).toContain("_20-method.qmd");

    fireEvent.click(
      screen.getByRole("button", { name: "Next file: _30-results.qmd" }),
    );
    expect(onNavigateFile).toHaveBeenCalledWith(
      "paper/sections/_30-results.qmd",
    );
  });

  it("gives a folder segment folder actions, not file ones", async () => {
    renderViewer(vi.fn());

    fireEvent.contextMenu(await screen.findByRole("link", { name: "paper" }));
    expect(
      await screen.findByRole("menuitem", { name: "Copy listing" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("menuitem", { name: "Copy project-relative path" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("menuitem", { name: "Copy contents" }),
    ).toBeNull();
    expect(
      screen.queryByRole("menuitem", { name: "Copy viewer link" }),
    ).toBeNull();

    const open = vi.spyOn(window, "open").mockReturnValue(null);
    fireEvent.click(screen.getByRole("menuitem", { name: "Open in new tab" }));
    expect(open).toHaveBeenCalledWith(
      expect.stringMatching(/[?&]folder=paper$/),
      "_blank",
      "noopener",
    );
  });

  it("links segments and rows so non-plain clicks open new tabs", async () => {
    const onNavigateFile = vi.fn();
    renderViewer(onNavigateFile);

    const segment = await screen.findByRole("link", { name: "sections" });
    const segmentUrl = new URL(segment.getAttribute("href") ?? "", "http://x");
    expect(segmentUrl.pathname).toBe("/projects/project-id/file");
    expect(segmentUrl.searchParams.get("path")).toBe(
      "paper/sections/_20-method.qmd",
    );
    expect(segmentUrl.searchParams.get("folder")).toBe("paper/sections");

    // A modified click is the browser's: no list opens in this tab.
    expect(clickLink(segment, { ctrlKey: true })).toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();

    expect(clickLink(segment)).toBe(false);
    const dialog = await screen.findByRole("dialog");
    const results = [...dialog.querySelectorAll("a")].find((row) =>
      row.textContent?.includes("_30-results.qmd"),
    );
    expect(
      new URL(results?.getAttribute("href") ?? "", "http://x").searchParams.get(
        "path",
      ),
    ).toBe("paper/sections/_30-results.qmd");
    expect(clickLink(results!, { metaKey: true })).toBe(true);
    expect(onNavigateFile).not.toHaveBeenCalled();
    expect(clickLink(results!)).toBe(false);
    expect(onNavigateFile).toHaveBeenCalledWith(
      "paper/sections/_30-results.qmd",
    );
  });

  it("opens the folder named by a new-tab URL on arrival", async () => {
    const listFolder = renderViewer(vi.fn(), "paper/sections");

    expect(
      await screen.findByRole("dialog", { name: "Folder sections/" }),
    ).toBeTruthy();
    expect(listFolder).toHaveBeenCalledWith("project-id", "paper/sections");
  });
});
