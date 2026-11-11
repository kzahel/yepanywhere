// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { useI18n } from "../../i18n";
import {
  ThinkingControlsPanel,
  ThinkingEffortSelector,
  ThinkingIcon,
} from "../ThinkingControls";
import type { EffortLevelOption } from "../../lib/effortLevels";

const effortOptions: EffortLevelOption[] = [
  { value: "low", label: "Low", description: "Fast responses" },
  { value: "medium", label: "Medium", description: "Balanced reasoning" },
  { value: "high", label: "High", description: "Deep reasoning" },
  { value: "xhigh", label: "Extra High", description: "Extra reasoning" },
];
const t = ((key: string) =>
  (
    ({
      modelSettingsThinkingTitle: "Thinking",
      modelSettingsThinkingOffLabel: "Off",
      modelSettingsThinkingAutoLabel: "Auto",
      modelSettingsThinkingOnLabel: "On",
      modelSettingsEffortTitle: "Effort level",
      showThinkingTitle: "Show thinking",
      showThinkingHint: "Show thinking hint",
      showThinkingOn: "On",
      showThinkingOff: "Off",
      showThinkingDefault: "Default",
      showThinkingDefaultShown: "Shown",
      showThinkingDefaultHidden: "Hidden",
    }) as Record<string, string>
  )[key] ?? key) as ReturnType<typeof useI18n>["t"];

describe("ThinkingControls", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders effort options with shared selected state and click behavior", () => {
    const onChange = vi.fn();

    render(
      <ThinkingEffortSelector
        options={effortOptions}
        value="high"
        onChange={onChange}
        ariaLabel="Thinking amount"
        variant="settings"
      />,
    );

    expect(
      screen
        .getByRole("group", { name: "Thinking amount" })
        .getAttribute("data-thinking-effort-variant"),
    ).toBe("settings");
    expect(
      screen
        .getByRole("button", { name: "Thinking amount: High" })
        .getAttribute("aria-pressed"),
    ).toBe("true");

    fireEvent.click(
      screen.getByRole("button", { name: "Thinking amount: Extra High" }),
    );

    expect(onChange).toHaveBeenCalledWith("xhigh");
  });

  it("marks the auto thinking icon with an A badge", () => {
    const { container } = render(<ThinkingIcon mode="auto" />);

    expect(container.querySelector("text")?.textContent).toBe("A");
  });

  it("orders show thinking immediately after thinking in the inline panel", () => {
    const { container } = render(
      <ThinkingControlsPanel
        mode="auto"
        onSetMode={vi.fn()}
        level="high"
        effortOptions={effortOptions}
        onSetEffort={vi.fn()}
        showThinking="default"
        onSetShowThinking={vi.fn()}
        provider="codex"
        t={t}
        className="thinking-controls-panel--inline"
      />,
    );

    const sections = Array.from(
      container.querySelectorAll("[data-thinking-controls-section]"),
    );

    expect(sections[0]?.getAttribute("data-thinking-section") === "mode").toBe(
      true,
    );
    expect(
      sections[1]?.hasAttribute(
        "data-thinking-controls-section--show-thinking",
      ),
    ).toBe(true);
    expect(
      sections[2]?.hasAttribute("data-thinking-controls-section--effort"),
    ).toBe(true);
  });

  it("can omit the show thinking display preference", () => {
    const { container } = render(
      <ThinkingControlsPanel
        mode="auto"
        onSetMode={vi.fn()}
        level="high"
        effortOptions={effortOptions}
        onSetEffort={vi.fn()}
        showThinkingControl={false}
        t={t}
      />,
    );

    expect(screen.queryByText("Show thinking")).toBeNull();
    expect(
      container.querySelector(
        "[data-thinking-controls-section--show-thinking]",
      ),
    ).toBeNull();
  });

  it("hides unsupported thinking modes and effort controls", () => {
    const onSetMode = vi.fn();
    const { container } = render(
      <ThinkingControlsPanel
        mode="auto"
        modeOptions={["off", "auto"]}
        onSetMode={onSetMode}
        level="high"
        effortOptions={effortOptions}
        onSetEffort={vi.fn()}
        showThinking="default"
        onSetShowThinking={vi.fn()}
        provider="claude"
        t={t}
      />,
    );

    expect(
      container.querySelector(
        '[data-thinking-section="mode"] button[aria-label="On"]',
      ),
    ).toBeNull();
    expect(
      container.querySelector("[data-thinking-controls-section--effort]"),
    ).toBeNull();

    const offModeButton = container
      .querySelector('[data-thinking-section="mode"] button')
      ?.closest("button");
    expect(offModeButton).not.toBeNull();

    fireEvent.click(offModeButton as HTMLButtonElement);

    expect(onSetMode).toHaveBeenCalledWith("off");
  });
});
