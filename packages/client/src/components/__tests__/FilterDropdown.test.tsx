// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FilterDropdown } from "../FilterDropdown";
import styles from "../FilterDropdown.module.css";

vi.mock("../../i18n", () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}));

const originalMatchMedia = window.matchMedia;

/** Phones match the shared Popover's bottom-sheet query. */
function matchPhoneViewport() {
  window.matchMedia = ((media: string) => ({
    ...originalMatchMedia(media),
    matches: media === "(max-width: 768px)",
  })) as typeof window.matchMedia;
}

function openTrigger() {
  fireEvent.click(screen.getByRole("button", { name: "filterByLabel" }));
}

describe("FilterDropdown", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    window.matchMedia = originalMatchMedia;
    document.body.style.overflow = "";
  });

  it("renders a named boundary before additional model options", () => {
    render(
      <FilterDropdown
        label="Models"
        options={[
          { value: "latest", label: "Latest" },
          {
            value: "previous",
            label: "Previous",
            groupLabelBefore: "Previous models",
          },
        ]}
        selected={["latest"]}
        onChange={vi.fn()}
        multiSelect={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "filterByLabel" }));

    const group = screen.getByRole("group", { name: "Previous models" });
    expect(
      within(group).getByRole("menuitemradio", { name: "Previous" }),
    ).toBeTruthy();
    expect(
      within(group).queryByRole("menuitemradio", { name: "Latest" }),
    ).toBeNull();
    expect(
      screen
        .getByRole("menuitemradio", { name: "Latest" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("renders trailing option metadata", () => {
    render(
      <FilterDropdown
        label="Models"
        options={[
          {
            value: "fable",
            label: "Fable",
            meta: <span>100% used</span>,
          },
        ]}
        selected={[]}
        onChange={vi.fn()}
        multiSelect={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "filterByLabel" }));

    expect(screen.getByText("100% used")).toBeTruthy();
  });

  it("toggles open and closed from the trigger", () => {
    render(
      <FilterDropdown
        label="Status"
        options={[{ value: "unread", label: "Unread" }]}
        selected={[]}
        onChange={vi.fn()}
      />,
    );

    expect(screen.queryByRole("menu")).toBeNull();
    openTrigger();
    expect(screen.getByRole("menu")).toBeTruthy();
    openTrigger();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes on Escape", () => {
    render(
      <FilterDropdown
        label="Status"
        options={[{ value: "unread", label: "Unread" }]}
        selected={[]}
        onChange={vi.fn()}
      />,
    );

    openTrigger();
    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes on a click outside the desktop dropdown", () => {
    render(
      <FilterDropdown
        label="Status"
        options={[{ value: "unread", label: "Unread" }]}
        selected={[]}
        onChange={vi.fn()}
      />,
    );

    openTrigger();
    fireEvent.mouseDown(document.body);

    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("selects a single value and closes", () => {
    const onChange = vi.fn();
    render(
      <FilterDropdown
        label="Models"
        options={[
          { value: "fable", label: "Fable" },
          { value: "opus", label: "Opus" },
        ]}
        selected={[]}
        onChange={onChange}
        multiSelect={false}
      />,
    );

    openTrigger();
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Opus" }));

    expect(onChange).toHaveBeenCalledWith(["opus"]);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("accumulates multi-select values and stays open", () => {
    const onChange = vi.fn();
    render(
      <FilterDropdown
        label="Status"
        options={[
          { value: "unread", label: "Unread" },
          { value: "starred", label: "Starred" },
        ]}
        selected={["unread"]}
        onChange={onChange}
      />,
    );

    openTrigger();
    expect(
      screen
        .getByRole("menuitemcheckbox", { name: "Unread" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Starred" }));

    expect(onChange).toHaveBeenCalledWith(["unread", "starred"]);
    expect(screen.getByRole("menu")).toBeTruthy();

    fireEvent.click(screen.getByRole("menuitem", { name: "filterClearAll" }));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it("renders the narrow-viewport sheet through a portal", () => {
    matchPhoneViewport();
    const { container } = render(
      <FilterDropdown
        label="Status"
        options={[{ value: "unread", label: "Unread" }]}
        selected={[]}
        onChange={vi.fn()}
      />,
    );

    openTrigger();

    const sheet = screen.getByRole("menu");
    // The sheet mounts on document.body, not inside the component's container.
    expect(container.contains(sheet)).toBe(false);
    expect(document.body.contains(sheet)).toBe(true);
    expect(document.body.style.overflow).toBe("hidden");
  });

  it("applies the full-width variant to the container and trigger", () => {
    const { container } = render(
      <FilterDropdown
        label="Model"
        options={[{ value: "fable", label: "Fable" }]}
        selected={[]}
        onChange={vi.fn()}
        fullWidth
      />,
    );

    const root = container.firstElementChild;
    const trigger = screen.getByRole("button", { name: "filterByLabel" });

    expect(root?.className).toContain(styles.fullWidth);
    expect(trigger.className).toContain(styles.fullWidth);
  });

  it("applies caller trigger classes without exposing internals", () => {
    render(
      <FilterDropdown
        label="Status"
        options={[{ value: "unread", label: "Unread" }]}
        selected={[]}
        onChange={vi.fn()}
        triggerClassName="filter-dropdown-trigger--status"
      />,
    );

    expect(
      screen.getByRole("button", { name: "filterByLabel" }).className,
    ).toContain("filter-dropdown-trigger--status");
  });
});
