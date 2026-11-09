// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../../i18n";
import { Button } from "../Button";
import {
  ConfirmDialogHost,
  confirmDialog,
  promptDialog,
} from "../ConfirmDialog";
import { Dialog } from "../Dialog";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Opener() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Open</Button>
      {open ? (
        <Dialog
          title="Rename"
          description="Give the session a name."
          onClose={() => setOpen(false)}
          footer={
            <>
              <Button onClick={() => setOpen(false)}>Cancel</Button>
              <Button variant="primary">Save</Button>
            </>
          }
        >
          <p>Body</p>
        </Dialog>
      ) : null}
    </>
  );
}

describe("Dialog", () => {
  it("is named by its title, described, and keeps Tab inside", () => {
    render(
      <I18nProvider>
        <Opener />
      </I18nProvider>,
    );
    const opener = screen.getByRole("button", { name: "Open" });
    opener.focus();
    fireEvent.click(opener);

    const dialog = screen.getByRole("dialog", { name: "Rename" });
    expect(
      document.getElementById(dialog.getAttribute("aria-describedby") ?? ""),
    ).toHaveProperty("textContent", "Give the session a name.");
    // The footer sits outside the scrolling content.
    const save = screen.getByRole("button", { name: "Save" });
    expect(save.closest(".modal-content")).toBeNull();

    // Close (the first stop) has focus; Shift+Tab wraps to Save, Tab back.
    const close = screen.getByRole("button", { name: "Close" });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(save);
    fireEvent.keyDown(save, { key: "Tab" });
    expect(document.activeElement).toBe(close);

    // Closing returns focus to the opener.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});

describe("confirmDialog", () => {
  it("falls back to window.confirm without a host", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    await expect(
      confirmDialog({
        title: "Delete?",
        message: "Gone.",
        confirmLabel: "Delete",
      }),
    ).resolves.toBe(true);
    expect(confirm).toHaveBeenCalledWith("Gone.");
  });

  it("shows a styled alertdialog and resolves with the answer", async () => {
    const confirm = vi.spyOn(window, "confirm");
    render(
      <I18nProvider>
        <ConfirmDialogHost />
      </I18nProvider>,
    );

    let answer!: Promise<boolean>;
    act(() => {
      answer = confirmDialog({
        title: "Revoke this link?",
        message: "Anyone holding it loses access.",
        confirmLabel: "Revoke",
        tone: "danger",
      });
    });
    const dialog = screen.getByRole("alertdialog", {
      name: "Revoke this link?",
    });
    expect(dialog.textContent).toContain("Anyone holding it loses access.");
    // A destructive confirmation starts on Cancel.
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Cancel" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    await expect(answer).resolves.toBe(true);
    expect(screen.queryByRole("alertdialog")).toBeNull();

    act(() => {
      answer = confirmDialog({ title: "Restart?", confirmLabel: "Restart" });
    });
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Restart" }),
    );
    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
    await expect(answer).resolves.toBe(false);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("prompts for one line of text and submits on Enter", async () => {
    render(
      <I18nProvider>
        <ConfirmDialogHost />
      </I18nProvider>,
    );
    let answer!: Promise<string | null>;
    act(() => {
      answer = promptDialog({
        title: "Copy project",
        label: "New project name",
        defaultValue: "app-copy",
        confirmLabel: "Copy",
      });
    });
    const field = screen.getByRole("textbox", { name: "New project name" });
    expect(document.activeElement).toBe(field);
    fireEvent.change(field, { target: { value: "  app-two " } });
    fireEvent.submit(field.closest("form") as HTMLFormElement);
    await expect(answer).resolves.toBe("app-two");

    act(() => {
      answer = promptDialog({
        title: "Copy project",
        label: "New project name",
        confirmLabel: "Copy",
      });
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await expect(answer).resolves.toBeNull();
  });
});
