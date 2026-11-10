// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearTooltipWarmth,
  DEFAULT_TOOLTIP_DELAY_MS,
  TOOLTIP_CLOSE_DELAY_MULTIPLIER,
} from "../../hooks/useTooltipAppearance";
import { I18nProvider } from "../../i18n";
import { UI_KEYS } from "../../lib/storageKeys";
import "../../../test/pointerEventShim";
import { RiskAffordance } from "../RiskAffordance";
import styles from "../RiskAffordance.module.css";

/** CSS Module keys are typed optional; a missing one is a broken contract. */
function cls(name: string | undefined): string {
  if (!name) throw new Error("RiskAffordance.module.css class missing");
  return name;
}

/** The root span the component wraps around the button. */
function hoverRegionOf(button: HTMLElement): HTMLElement {
  const region = button.parentElement;
  if (!(region instanceof HTMLElement)) {
    throw new Error("expected the affordance root around the button");
  }
  return region;
}

describe("RiskAffordance tooltip timing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    localStorage.setItem(UI_KEYS.tooltipMode, "themed");
    clearTooltipWarmth();
  });

  afterEach(() => {
    cleanup();
    clearTooltipWarmth();
    localStorage.clear();
    vi.useRealTimers();
  });

  it("persists through motion and closes after deliberate departure", () => {
    render(
      <RiskAffordance
        label="what is the risk?"
        modalTitle="Risk"
        explanation="Risk explanation"
      />,
    );
    const target = screen.getByRole("button", {
      name: "what is the risk?",
    });

    const hoverRegion = hoverRegionOf(target);
    expect(hoverRegion.classList).toContain(cls(styles.root));

    fireEvent.pointerEnter(hoverRegion, {
      pointerType: "mouse",
      clientX: 10,
      clientY: 10,
    });
    fireEvent.pointerMove(hoverRegion, {
      pointerType: "mouse",
      clientX: 11,
      clientY: 10,
    });
    act(() => vi.advanceTimersByTime(DEFAULT_TOOLTIP_DELAY_MS));
    expect(screen.getByRole("tooltip").textContent).toBe("Risk explanation");
    expect(hoverRegion.classList).toContain(cls(styles.tooltipVisible));

    const tooltip = screen.getByRole("tooltip");
    expect(tooltip.classList).toContain(cls(styles.tooltip));
    fireEvent.pointerMove(tooltip, {
      pointerType: "mouse",
      clientX: 12,
      clientY: 10,
    });
    expect(screen.getByRole("tooltip").textContent).toBe("Risk explanation");

    fireEvent.pointerLeave(hoverRegion, {
      pointerType: "mouse",
      clientX: 12,
      clientY: 10,
      relatedTarget: document.body,
    });
    expect(screen.getByRole("tooltip").textContent).toBe("Risk explanation");

    fireEvent.pointerMove(document.body, {
      pointerType: "mouse",
      clientX: 14,
      clientY: 10,
    });
    act(() =>
      vi.advanceTimersByTime(
        DEFAULT_TOOLTIP_DELAY_MS * TOOLTIP_CLOSE_DELAY_MULTIPLIER,
      ),
    );
    expect(screen.getByRole("tooltip").textContent).toBe("Risk explanation");

    fireEvent.pointerMove(document.body, {
      pointerType: "mouse",
      clientX: 20,
      clientY: 10,
    });
    act(() =>
      vi.advanceTimersByTime(
        DEFAULT_TOOLTIP_DELAY_MS * TOOLTIP_CLOSE_DELAY_MULTIPLIER - 1,
      ),
    );
    expect(screen.getByRole("tooltip").textContent).toBe("Risk explanation");
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(hoverRegion.classList).not.toContain(cls(styles.tooltipVisible));
  });

  it("opens after keyboard-visible focus", () => {
    render(
      <RiskAffordance
        label="what is the risk?"
        modalTitle="Risk"
        explanation="Risk explanation"
      />,
    );
    const target = screen.getByRole("button", {
      name: "what is the risk?",
    });
    vi.spyOn(target, "matches").mockImplementation(
      (selector) => selector === ":focus-visible",
    );

    fireEvent.focus(target);
    act(() => vi.advanceTimersByTime(DEFAULT_TOOLTIP_DELAY_MS));

    expect(screen.getByRole("tooltip").textContent).toBe("Risk explanation");
  });

  it("keeps touch focus on the click-to-modal path", () => {
    render(
      <I18nProvider>
        <RiskAffordance
          label="what is the risk?"
          modalTitle="Risk"
          explanation="Risk explanation"
        />
      </I18nProvider>,
    );
    const target = screen.getByRole("button", {
      name: "what is the risk?",
    });
    const hoverRegion = hoverRegionOf(target);
    vi.spyOn(target, "matches").mockImplementation(
      (selector) => selector !== ":focus-visible",
    );

    fireEvent.pointerEnter(hoverRegion, { pointerType: "touch" });
    fireEvent.pointerMove(hoverRegion, { pointerType: "touch" });
    fireEvent.focus(target);
    act(() => vi.advanceTimersByTime(DEFAULT_TOOLTIP_DELAY_MS));

    expect(screen.queryByRole("tooltip")).toBeNull();

    fireEvent.click(target);

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("Risk")).toBeTruthy();
    expect(screen.getByText("Risk explanation")).toBeTruthy();
  });
});
