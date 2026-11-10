import columnsStyles from "./SourceColumnLayout.module.css";
// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  ResizableSourceColumns,
  calculateSourceAutoFilesWidth,
  calculateSourceFilesMaxWidth,
} from "./ResizableSourceColumns";

describe("Source Control file-pane resize bound", () => {
  it("keeps the file splitter handle inside a two-column container", () => {
    const containerWidth = 1_000;
    const gapWidth = 12;
    const handleWidth = 26;
    const filesWidth = calculateSourceFilesMaxWidth({
      layout: "files",
      containerWidth,
      revisionWidth: 0,
      gapWidth,
      handleWidth,
    });

    expect(filesWidth).toBe(981);
    expect(filesWidth + gapWidth / 2 + handleWidth / 2).toBe(containerWidth);
  });

  it("accounts for the revision track before the file splitter", () => {
    const containerWidth = 1_000;
    const revisionWidth = 300;
    const gapWidth = 12;
    const handleWidth = 26;
    const filesWidth = calculateSourceFilesMaxWidth({
      layout: "history",
      containerWidth,
      revisionWidth,
      gapWidth,
      handleWidth,
    });

    expect(filesWidth).toBe(669);
    expect(
      revisionWidth + gapWidth + filesWidth + gapWidth / 2 + handleWidth / 2,
    ).toBe(containerWidth);
  });

  it("right-sizes detail and may reduce an oversized file list", () => {
    expect(
      calculateSourceAutoFilesWidth({
        containerWidth: 1_200,
        gapWidth: 12,
        naturalDetailWidth: 500,
        currentFilesWidth: 800,
        defaultFilesWidth: 340,
        filesMax: 1_181,
      }),
    ).toBe(688);
  });

  it("limits detail expansion by the default-width neighboring pane", () => {
    expect(
      calculateSourceAutoFilesWidth({
        containerWidth: 1_200,
        gapWidth: 12,
        naturalDetailWidth: 1_000,
        currentFilesWidth: 700,
        defaultFilesWidth: 340,
        filesMax: 1_181,
      }),
    ).toBe(340);
  });

  it("preserves a neighboring pane manually narrowed below default", () => {
    expect(
      calculateSourceAutoFilesWidth({
        containerWidth: 800,
        gapWidth: 12,
        naturalDetailWidth: 700,
        currentFilesWidth: 260,
        defaultFilesWidth: 340,
        filesMax: 781,
      }),
    ).toBe(260);
  });

  it("fully hides and restores the commit selector's previous width", () => {
    const rendered = render(
      <ResizableSourceColumns
        layout="history"
        className={columnsStyles.commitBrowserColumns!}
        t={(key) => key}
      >
        <div data-source-column="revisions">commits</div>
        <div>files</div>
        <div>detail</div>
      </ResizableSourceColumns>,
    );
    const root = rendered.container.querySelector<HTMLElement>(
      "[data-source-column-layout=history]",
    )!;
    const handle = screen.getAllByRole("separator", {
      name: "sourceResizeRevisionPane",
    })[0]!;

    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(root.style.getPropertyValue("--source-revision-column-width")).toBe(
      "316px",
    );

    fireEvent.click(handle);
    expect(root.style.getPropertyValue("--source-revision-column-width")).toBe(
      "0px",
    );
    expect(handle.getAttribute("title")).toBe("sourceShowRevisionPane");

    fireEvent.click(handle);
    expect(root.style.getPropertyValue("--source-revision-column-width")).toBe(
      "316px",
    );
    expect(handle.getAttribute("title")).toBe("sourceHideRevisionPane");
  });

  it("coalesces pointer moves to one animation-frame update", () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const rendered = render(
      <ResizableSourceColumns
        layout="history"
        className={columnsStyles.commitBrowserColumns!}
        t={(key) => key}
      >
        <div>pane contents</div>
      </ResizableSourceColumns>,
    );
    const root = rendered.container.querySelector<HTMLElement>(
      "[data-source-column-layout=history]",
    )!;
    const handle = screen.getAllByRole("separator", {
      name: "sourceResizeRevisionPane",
    })[0]!;

    fireEvent(
      handle,
      new MouseEvent("pointerdown", {
        bubbles: true,
        button: 0,
        clientX: 300,
      }),
    );
    fireEvent(
      window,
      new MouseEvent("pointermove", { bubbles: true, clientX: 316 }),
    );
    fireEvent(
      window,
      new MouseEvent("pointermove", { bubbles: true, clientX: 332 }),
    );

    expect(frames).toHaveLength(1);
    expect(root.style.getPropertyValue("--source-revision-column-width")).toBe(
      "300px",
    );
    frames[0]!(0);
    expect(root.style.getPropertyValue("--source-revision-column-width")).toBe(
      "332px",
    );
    fireEvent(
      window,
      new MouseEvent("pointerup", { bubbles: true, clientX: 332 }),
    );
    expect(root.style.getPropertyValue("--source-revision-column-width")).toBe(
      "332px",
    );
  });
});
