// @vitest-environment jsdom
import { createPortal } from "react-dom";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../contexts/ToastContext";
import { I18nProvider } from "../../i18n";
import { FileDropZone } from "../FileDropZone";

afterEach(cleanup);

function fixture(enabled = true, ownerKey = "source:draft", onFiles = vi.fn()) {
  return {
    onFiles,
    element: (
      <I18nProvider>
        <ToastProvider>
          <FileDropZone enabled={enabled} ownerKey={ownerKey} onFiles={onFiles}>
            <textarea aria-label="Draft" />
            {createPortal(
              <textarea aria-label="Other dialog" />,
              document.body,
            )}
          </FileDropZone>
        </ToastProvider>
      </I18nProvider>
    ),
  };
}

const file = new File(["reference"], "notes.txt", { type: "text/plain" });
const transfer = { types: ["Files"], files: [file], items: [] };

describe("file drop ownership", () => {
  it("rejects an entire mixed folder drop and preserves ordinary file intake", () => {
    const view = fixture();
    render(view.element);
    const input = screen.getByRole("textbox", { name: "Draft" });
    fireEvent.drop(input, {
      dataTransfer: {
        ...transfer,
        items: [
          { kind: "file", webkitGetAsEntry: () => ({ isDirectory: false }) },
          { kind: "file", webkitGetAsEntry: () => ({ isDirectory: true }) },
        ],
      },
    });
    expect(view.onFiles).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain(
      "Folders cannot be attached",
    );
    fireEvent.drop(input, { dataTransfer: transfer });
    expect(view.onFiles).toHaveBeenCalledWith([file]);
  });

  it("does not attach files dropped into a portaled dialog", () => {
    const view = fixture();
    render(view.element);
    const dialog = screen.getByRole("textbox", { name: "Other dialog" });
    fireEvent.dragEnter(dialog, { dataTransfer: transfer });
    expect(screen.queryByText("Drop files to attach")).toBeNull();
    fireEvent.drop(dialog, { dataTransfer: transfer });
    expect(view.onFiles).not.toHaveBeenCalled();
  });

  it("retires nested drags on owner changes, disable, blur and Escape", () => {
    const view = fixture();
    const mounted = render(view.element);
    const input = screen.getByRole("textbox", { name: "Draft" });
    const surface = input.parentElement!;
    fireEvent.dragEnter(surface, { dataTransfer: transfer });
    fireEvent.dragEnter(input, { dataTransfer: transfer });
    fireEvent.dragLeave(surface, { dataTransfer: transfer });
    expect(screen.getByText("Drop files to attach")).toBeTruthy();
    mounted.rerender(fixture(true, "another:draft", view.onFiles).element);
    expect(screen.queryByText("Drop files to attach")).toBeNull();
    fireEvent.dragEnter(input, { dataTransfer: transfer });
    fireEvent.blur(window);
    expect(screen.queryByText("Drop files to attach")).toBeNull();
    fireEvent.dragEnter(input, { dataTransfer: transfer });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByText("Drop files to attach")).toBeNull();
    fireEvent.dragEnter(input, { dataTransfer: transfer });
    mounted.rerender(fixture(false, "another:draft", view.onFiles).element);
    expect(screen.queryByText("Drop files to attach")).toBeNull();
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: transfer });
    fireEvent(input, drop);
    expect(drop.defaultPrevented).toBe(true);
    expect(view.onFiles).not.toHaveBeenCalled();
    mounted.rerender(fixture(true, "another:draft", view.onFiles).element);
    expect(screen.queryByText("Drop files to attach")).toBeNull();
  });
});
