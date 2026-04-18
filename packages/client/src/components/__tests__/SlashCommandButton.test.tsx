import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SlashCommandButton } from "../SlashCommandButton";

const ORIGINAL_INNER_WIDTH = window.innerWidth;

function setViewportWidth(width: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: width,
  });
  window.dispatchEvent(new Event("resize"));
}

describe("SlashCommandButton", () => {
  beforeEach(() => {
    setViewportWidth(1024);
    document.body.style.overflow = "";
  });

  afterEach(() => {
    cleanup();
    setViewportWidth(ORIGINAL_INNER_WIDTH);
    document.body.style.overflow = "";
    vi.restoreAllMocks();
  });

  it("opens an inline desktop menu and inserts the selected command", () => {
    const onSelectCommand = vi.fn();

    render(
      <SlashCommandButton
        commands={["docs", "defuddle"]}
        onSelectCommand={onSelectCommand}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Show slash commands" }));

    const menu = screen.getByRole("menu", { name: "Slash commands" });
    expect(menu.className).toContain("slash-command-menu");

    fireEvent.click(screen.getByRole("menuitem", { name: "/docs" }));

    expect(onSelectCommand).toHaveBeenCalledWith("/docs");
    expect(screen.queryByRole("menu", { name: "Slash commands" })).toBeNull();
  });

  it("renders a mobile bottom sheet and restores body scroll after selection", () => {
    const onSelectCommand = vi.fn();
    setViewportWidth(390);

    render(
      <SlashCommandButton
        commands={["docs", "defuddle"]}
        onSelectCommand={onSelectCommand}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Show slash commands" }));

    const menu = screen.getByRole("menu", { name: "Slash commands" });
    expect(menu.className).toContain("slash-command-sheet");
    expect(document.body.style.overflow).toBe("hidden");

    fireEvent.click(screen.getByRole("menuitem", { name: "/defuddle" }));

    expect(onSelectCommand).toHaveBeenCalledWith("/defuddle");
    expect(document.body.style.overflow).toBe("");
  });

  it("closes the desktop menu when clicking outside", () => {
    render(
      <SlashCommandButton
        commands={["docs", "defuddle"]}
        onSelectCommand={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Show slash commands" }));
    expect(screen.getByRole("menu", { name: "Slash commands" })).not.toBeNull();

    fireEvent.mouseDown(document.body);

    expect(screen.queryByRole("menu", { name: "Slash commands" })).toBeNull();
  });
});
