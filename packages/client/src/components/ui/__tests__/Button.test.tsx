// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UI_KEYS } from "../../../lib/storageKeys";
import { Button, IconButton } from "../Button";

afterEach(() => {
  cleanup();
  localStorage.removeItem(UI_KEYS.tooltipMode);
});

describe("Button", () => {
  it("never submits its form unless asked to", () => {
    const onSubmit = vi.fn((event: SubmitEvent) => event.preventDefault());
    render(
      <form onSubmit={(event) => onSubmit(event.nativeEvent as SubmitEvent)}>
        <Button>Cancel</Button>
        <Button type="submit">Save</Button>
      </form>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("ignores clicks and submission while busy but stays focusable", () => {
    const onClick = vi.fn();
    const onSubmit = vi.fn((event: SubmitEvent) => event.preventDefault());
    render(
      <form onSubmit={(event) => onSubmit(event.nativeEvent as SubmitEvent)}>
        <Button type="submit" busy onClick={onClick} data-testid="save">
          Save
        </Button>
      </form>,
    );
    const button = screen.getByTestId("save");
    button.focus();
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(button).toHaveProperty("disabled", false);
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute("aria-busy")).toBe("true");
  });
});

describe("IconButton", () => {
  it("names itself and its themed tooltip from the label", () => {
    render(
      <IconButton label="Remove server" onClick={() => {}}>
        <svg aria-hidden="true" />
      </IconButton>,
    );
    const button = screen.getByRole("button", { name: "Remove server" });
    expect(button.getAttribute("data-tooltip")).toBe("Remove server");
    expect(button.hasAttribute("title")).toBe(false);
  });

  it("gives the browser a title in native tooltip mode", () => {
    localStorage.setItem(UI_KEYS.tooltipMode, "native");
    render(
      <IconButton label="Remove server" onClick={() => {}}>
        <svg aria-hidden="true" />
      </IconButton>,
    );
    const button = screen.getByRole("button", { name: "Remove server" });
    expect(button.getAttribute("title")).toBe("Remove server");
    expect(button.hasAttribute("data-tooltip")).toBe(false);
  });
});
