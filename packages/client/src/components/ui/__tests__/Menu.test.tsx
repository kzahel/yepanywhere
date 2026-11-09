// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Menu, MenuItem, useMenuTrigger } from "../Menu";
import { I18nProvider } from "../../../i18n";
import { Modal } from "../Modal";
import { computePopoverPosition } from "../Popover";

afterEach(cleanup);

function Harness({
  onRename = () => {},
  onEscapeKeyDown,
}: {
  onRename?: () => void;
  onEscapeKeyDown?: (event: KeyboardEvent) => void;
}) {
  const menu = useMenuTrigger();
  const [captions, setCaptions] = useState(false);
  return (
    <>
      <button type="button" {...menu.triggerProps}>
        Actions
      </button>
      <button type="button">Elsewhere</button>
      <Menu
        open={menu.open}
        onClose={menu.close}
        anchorRef={menu.anchorRef}
        aria-label="Actions"
        onEscapeKeyDown={onEscapeKeyDown}
      >
        <MenuItem onSelect={onRename}>Rename</MenuItem>
        <MenuItem disabled tooltip="Needs a newer server">
          Clone
        </MenuItem>
        <MenuItem
          checked={captions}
          keepOpen
          onSelect={() => setCaptions((on) => !on)}
        >
          Captions
        </MenuItem>
        <MenuItem tone="danger">Terminate</MenuItem>
      </Menu>
    </>
  );
}

const trigger = () => screen.getByRole("button", { name: "Actions" });
const item = (name: string): HTMLElement => {
  for (const role of ["menuitem", "menuitemcheckbox"] as const) {
    const found = screen.queryByRole(role, { name });
    if (found) return found;
  }
  throw new Error(`no menu item named ${name}`);
};

function keyDown(key: string) {
  fireEvent.keyDown(document.activeElement ?? document.body, { key });
}

describe("Menu", () => {
  it("opens from its trigger, focuses the first item and roves with keys", () => {
    render(<Harness />);
    expect(trigger().getAttribute("aria-haspopup")).toBe("menu");
    fireEvent.click(trigger());
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("menu", { name: "Actions" })).toBeTruthy();
    expect(document.activeElement).toBe(item("Rename"));
    keyDown("ArrowDown");
    expect(document.activeElement).toBe(item("Clone"));
    keyDown("End");
    expect(document.activeElement).toBe(item("Terminate"));
    keyDown("ArrowDown");
    expect(document.activeElement).toBe(item("Rename"));
    keyDown("ArrowUp");
    expect(document.activeElement).toBe(item("Terminate"));
    keyDown("c");
    expect(document.activeElement).toBe(item("Clone"));
    keyDown("c");
    expect(document.activeElement).toBe(item("Captions"));
  });

  it("selects, closes and returns focus to the trigger", () => {
    const onRename = vi.fn();
    render(<Harness onRename={onRename} />);
    fireEvent.click(trigger());
    fireEvent.click(item("Rename"));
    expect(onRename).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("keeps a toggle open, and ignores a disabled item", () => {
    render(<Harness />);
    fireEvent.click(trigger());
    fireEvent.click(item("Captions"));
    expect(
      screen.getByRole("menuitemcheckbox", { name: "Captions" }),
    ).toHaveProperty("ariaChecked", "true");
    fireEvent.click(item("Clone"));
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(item("Clone").getAttribute("aria-disabled")).toBe("true");
  });

  it("closes on Escape and on a press outside, not on its trigger", () => {
    render(<Harness />);
    fireEvent.click(trigger());
    keyDown("Escape");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger());

    fireEvent.click(trigger());
    fireEvent.mouseDown(trigger());
    expect(screen.getByRole("menu")).toBeTruthy();
    fireEvent.mouseDown(screen.getByRole("button", { name: "Elsewhere" }));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("lets a field inside decline Escape", () => {
    render(<Harness onEscapeKeyDown={(event) => event.preventDefault()} />);
    fireEvent.click(trigger());
    keyDown("Escape");
    expect(screen.getByRole("menu")).toBeTruthy();
  });

  it("inside a Modal, Escape closes the menu before the Modal", () => {
    const onCloseModal = vi.fn();
    render(
      <I18nProvider>
        <Modal title="Dialog" onClose={onCloseModal}>
          <Harness />
        </Modal>
      </I18nProvider>,
    );
    fireEvent.click(trigger());
    keyDown("Escape");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(onCloseModal).not.toHaveBeenCalled();
    keyDown("Escape");
    expect(onCloseModal).toHaveBeenCalledTimes(1);
  });
});

function Nested() {
  const outer = useMenuTrigger();
  const inner = useMenuTrigger();
  return (
    <>
      <button type="button" {...outer.triggerProps}>
        File
      </button>
      <Menu
        open={outer.open}
        onClose={outer.close}
        anchorRef={outer.anchorRef}
        aria-label="File"
      >
        <MenuItem
          ref={inner.anchorRef}
          keepOpen
          onSelect={() => inner.setOpen(true)}
        >
          Open with
        </MenuItem>
        <Menu
          open={inner.open}
          onClose={inner.close}
          anchorRef={inner.anchorRef}
          placement="right-start"
          aria-label="Open with"
        >
          <MenuItem>Editor</MenuItem>
        </Menu>
      </Menu>
    </>
  );
}

describe("nested popovers", () => {
  it("a press inside a submenu is not outside its parent", () => {
    render(<Nested />);
    fireEvent.click(screen.getByRole("button", { name: "File" }));
    fireEvent.click(item("Open with"));
    const editor = item("Editor");
    fireEvent.mouseDown(editor);
    expect(screen.getByRole("menu", { name: "File" })).toBeTruthy();
    fireEvent.click(editor);
    expect(screen.queryByRole("menu", { name: "Open with" })).toBeNull();
    keyDown("Escape");
    expect(screen.queryByRole("menu", { name: "File" })).toBeNull();
  });
});

describe("computePopoverPosition", () => {
  const viewport = { width: 400, height: 600 };
  const anchor = (top: number, left = 100) => ({
    top,
    bottom: top + 30,
    left,
    right: left + 80,
    width: 80,
    height: 30,
  });

  it("opens below, aligned to the anchor's start", () => {
    expect(
      computePopoverPosition({
        anchor: anchor(100),
        size: { width: 200, height: 150 },
        viewport,
        placement: "bottom-start",
        offset: 4,
      }),
    ).toMatchObject({ side: "bottom", top: 134, left: 100 });
  });

  it("flips above when there is more room there, and shifts into view", () => {
    expect(
      computePopoverPosition({
        anchor: anchor(500, 300),
        size: { width: 200, height: 150 },
        viewport,
        placement: "bottom-start",
        offset: 4,
      }),
    ).toMatchObject({ side: "top", top: 346, left: 192, maxHeight: 488 });
  });

  it("aligns the end edge and keeps the margin", () => {
    expect(
      computePopoverPosition({
        anchor: anchor(100, 10),
        size: { width: 200, height: 100 },
        viewport,
        placement: "bottom-end",
        offset: 4,
      }),
    ).toMatchObject({ left: 8 });
  });
});
