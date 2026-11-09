// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ForkTurnMenu } from "../ForkTurnMenu";

vi.mock("../../../i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ForkTurnMenu", () => {
  it("opens below its trigger, aligned to the trigger's end", () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1000,
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 800,
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      bottom: 100,
      height: 20,
      left: 880,
      right: 900,
      top: 80,
      width: 20,
      x: 880,
      y: 80,
      toJSON: () => ({}),
    });

    render(<ForkTurnMenu onForkAfter={vi.fn()} onForkAfterSummary={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "forkTurnMenuLabel" }));

    const menu = screen.getByRole("menu");
    expect(menu.style.top).toBe("104px");
    expect(menu.style.left).toBe("900px");
  });

  it("opens visible update guidance instead of a fork action", () => {
    render(
      <ForkTurnMenu unavailableMessage="Update the server for Codex forks." />,
    );

    const trigger = screen.getByRole("button", { name: "forkTurnMenuLabel" });
    expect((trigger as HTMLButtonElement).disabled).toBe(false);
    expect(trigger.getAttribute("title")).toBe(
      "Update the server for Codex forks.",
    );
    fireEvent.click(trigger);
    const unavailable = screen.getByRole("menuitem", {
      name: "Update the server for Codex forks.",
    });
    expect(unavailable.getAttribute("aria-disabled")).toBe("true");
  });
});
