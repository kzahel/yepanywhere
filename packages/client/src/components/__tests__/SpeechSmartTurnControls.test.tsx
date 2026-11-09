// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import type { SpeechSmartTurnSettings } from "../../lib/speechProviders/SpeechProvider";
import { SpeechSmartTurnControls } from "../SpeechSmartTurnControls";
import styles from "../SpeechSmartTurnControls.module.css";
import rowStyles from "../ui/RangeNumberRow.module.css";

afterEach(() => {
  cleanup();
});

function SmartTurnHarness() {
  const [settings, setSettings] = useState<SpeechSmartTurnSettings>({
    enabled: false,
    threshold: 0.95,
    timeoutMs: 3000,
    graceMs: 0,
  });

  return <SpeechSmartTurnControls settings={settings} onChange={setSettings} />;
}

function expectNoLegacyClasses(container: HTMLElement) {
  const legacyClassNodes = [...container.querySelectorAll("[class]")].filter(
    (node) =>
      node
        .getAttribute("class")
        ?.split(/\s+/)
        .some((className) => className.startsWith("speech-smart-turn")),
  );
  expect(legacyClassNodes).toHaveLength(0);
}

describe("SpeechSmartTurnControls", () => {
  it("uses module classes", () => {
    const settings = {
      enabled: true,
      threshold: 0.5,
      timeoutMs: 3000,
      graceMs: 0,
    };
    const onChange = vi.fn();
    const { container } = render(
      <I18nProvider>
        <SpeechSmartTurnControls settings={settings} onChange={onChange} />
      </I18nProvider>,
    );

    const fullRoot = container.firstElementChild;
    expect(fullRoot?.classList.contains(styles.root!)).toBe(true);
    expect(fullRoot?.querySelector(`.${styles.body}`)).not.toBeNull();
    expect(fullRoot?.querySelectorAll(`.${rowStyles.row}`)).toHaveLength(4);
    expectNoLegacyClasses(container);
  });

  it("preserves callback updates and disabled controls", () => {
    const onChange = vi.fn();
    const settings = {
      enabled: false,
      threshold: 0.5,
      timeoutMs: 3000,
      graceMs: 0,
    };
    const { rerender } = render(
      <I18nProvider>
        <SpeechSmartTurnControls settings={settings} onChange={onChange} />
      </I18nProvider>,
    );

    fireEvent.change(screen.getByLabelText("Smart Turn threshold"), {
      target: { value: "0.72" },
    });
    expect(onChange).toHaveBeenCalledWith({
      enabled: true,
      threshold: 0.72,
      timeoutMs: 3000,
      graceMs: 0,
    });

    onChange.mockClear();
    rerender(
      <I18nProvider>
        <SpeechSmartTurnControls
          disabled
          settings={settings}
          onChange={onChange}
        />
      </I18nProvider>,
    );

    expect(screen.getByRole("checkbox")).toHaveProperty("disabled", true);
    expect(screen.getByLabelText("Threshold")).toHaveProperty("disabled", true);
    expect(screen.getByLabelText("Smart Turn threshold")).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByLabelText("Timeout")).toHaveProperty("disabled", true);
    expect(screen.getByLabelText("Command grace")).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByLabelText("Follow-up listening")).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("enables Smart Turn when the threshold slider is adjusted", () => {
    render(
      <I18nProvider>
        <SmartTurnHarness />
      </I18nProvider>,
    );

    const checkbox = screen.getByRole<HTMLInputElement>("checkbox", {
      name: /Smart Turn/,
    });
    expect(checkbox.checked).toBe(false);

    const slider = screen.getByLabelText("Threshold");
    fireEvent.pointerDown(slider);
    fireEvent.change(slider, {
      target: { value: "0.82" },
    });
    fireEvent.pointerUp(slider);

    expect(checkbox.checked).toBe(true);
  });

  it("allows Smart Turn timeout up to 10 seconds", () => {
    render(
      <I18nProvider>
        <SmartTurnHarness />
      </I18nProvider>,
    );

    expect(screen.getByText("1 requires perfect confidence.")).toBeDefined();
    expect(screen.getByLabelText("Timeout").getAttribute("max")).toBe("10000");
    expect(
      screen
        .getByLabelText("Smart Turn timeout milliseconds")
        .getAttribute("max"),
    ).toBe("10000");
    fireEvent.click(screen.getByRole("checkbox", { name: /Smart Turn/ }));
    expect(
      screen.getByText(
        "Timeout is the max wait. At turn end, say send, cancel, or wait; no command means send.",
      ),
    ).toBeDefined();
  });

  it("caps the command grace window at 1500 ms", () => {
    render(
      <I18nProvider>
        <SmartTurnHarness />
      </I18nProvider>,
    );

    expect(screen.getByLabelText("Command grace").getAttribute("max")).toBe(
      "1500",
    );
    expect(
      screen
        .getByLabelText("Smart Turn command grace milliseconds")
        .getAttribute("max"),
    ).toBe("1500");
    expect(
      screen.getByLabelText("Follow-up listening").getAttribute("max"),
    ).toBe("30000");
    expect(screen.getAllByText("ms")).toHaveLength(3);
  });
});
