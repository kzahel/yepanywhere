// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_USER_TURN_FONT_SIZE_OFFSET_PX } from "../../../hooks/useOutputAppearance";
import { I18nProvider } from "../../../i18n";
import { invalidateLocalStorageValues } from "../../../lib/localStorageValue";
import { UI_KEYS } from "../../../lib/storageKeys";
import { AppearanceSettings } from "../AppearanceSettings";

vi.mock("../../../hooks/useVersion", () => ({
  useVersion: () => ({ version: null }),
}));

function renderAppearanceSettings() {
  return render(
    <I18nProvider>
      <MemoryRouter>
        <AppearanceSettings />
      </MemoryRouter>
    </I18nProvider>,
  );
}

describe("AppearanceSettings", () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
    invalidateLocalStorageValues();
  });

  it("keeps style and delay in one row and valid delay edits select themed", () => {
    const { container } = renderAppearanceSettings();
    const row = container.querySelector(".tooltip-settings-actions");
    expect(row).toBeTruthy();
    expect(row?.querySelector(".tooltip-mode-selector")).toBeTruthy();
    expect(row?.querySelector('input[type="range"]')).toBeTruthy();
    expect(row?.querySelector('input[type="number"]')).toBeTruthy();

    const themedButton = screen.getByRole("button", { name: "Themed" });
    expect(themedButton.classList.contains("active")).toBe(true);
    const nativeButton = screen.getByRole("button", { name: "Native" });
    act(() => fireEvent.click(nativeButton));
    expect(localStorage.getItem(UI_KEYS.tooltipMode)).toBe("native");

    const number = screen.getByRole<HTMLInputElement>("spinbutton", {
      name: "Tooltip Style and Delay",
    });
    act(() => fireEvent.change(number, { target: { value: "" } }));
    expect(localStorage.getItem(UI_KEYS.tooltipMode)).toBe("native");

    act(() => fireEvent.change(number, { target: { value: "80" } }));
    expect(localStorage.getItem(UI_KEYS.tooltipMode)).toBe("themed");
    act(() => fireEvent.blur(number));
    expect(localStorage.getItem(UI_KEYS.tooltipDelayMs)).toBe("80");
  });

  it("controls free UI size entry and sidebar density", () => {
    const { container } = renderAppearanceSettings();

    const slider = container.querySelector<HTMLInputElement>("#ui-font-scale");
    const number = container.querySelector<HTMLInputElement>(
      "#ui-font-scale-number",
    );
    expect(slider).toBeTruthy();
    expect(number).toBeTruthy();
    if (!slider || !number) throw new Error("UI size controls are missing");
    expect(slider.getAttribute("aria-label")).toBe("UI size");
    expect(number.getAttribute("aria-label")).toBe("UI size");
    expect(slider.min).toBe("85");
    expect(slider.max).toBe("130");
    expect(slider.step).toBe("5");
    expect(number.min).toBe("50");
    expect(number.max).toBe("300");
    expect(number.step).toBe("any");
    expect(
      Array.from(
        container.querySelectorAll<HTMLOptionElement>(
          "#ui-font-scale-presets option",
        ),
        (option) => option.value,
      ),
    ).toEqual(["85", "100", "115", "130"]);

    act(() => {
      fireEvent.change(number, { target: { value: "93.5" } });
      fireEvent.blur(number);
    });
    expect(localStorage.getItem(UI_KEYS.fontSize)).toBe("93.5");
    expect(document.documentElement.style.fontSize).toBe("93.5%");

    act(() => {
      fireEvent.change(number, { target: { value: "25" } });
      fireEvent.blur(number);
    });
    expect(localStorage.getItem(UI_KEYS.fontSize)).toBe("50");
    expect(number.value).toBe("50");
    expect(slider.value).toBe("85");

    act(() => {
      fireEvent.change(number, { target: { value: "350" } });
      fireEvent.blur(number);
    });
    expect(localStorage.getItem(UI_KEYS.fontSize)).toBe("300");
    expect(number.value).toBe("300");
    expect(slider.value).toBe("130");

    const densityLabel = screen.getByText("Sidebar density");
    const densityRow = densityLabel.closest("[data-settings-item]");
    expect(densityRow).toBeTruthy();
    expect(densityRow?.querySelector("p")?.textContent).toContain(
      "spacing for sidebar rows and sections",
    );
    expect(densityRow?.closest(".output-appearance-settings")).toBeNull();

    const comfortable = densityRow?.querySelector<HTMLButtonElement>(
      'button[role="radio"][aria-checked="true"]',
    );
    expect(comfortable).toBeTruthy();
    if (!comfortable) throw new Error("Comfortable spacing control is missing");
    expect(comfortable.classList.contains("active")).toBe(true);
    const compact = screen.getByText("Compact").closest("button");
    expect(compact).toBeTruthy();
    if (!compact) throw new Error("Compact spacing control is missing");
    act(() => fireEvent.click(compact));
    expect(localStorage.getItem(UI_KEYS.sidebarSpacing)).toBe("compact");
    expect(
      document.documentElement.style.getPropertyValue(
        "--sidebar-row-min-height",
      ),
    ).toBe("calc(1.5rem + 1px)");
  });

  it("applies an independent user-turn font size offset", () => {
    const { container } = renderAppearanceSettings();
    const slider = container.querySelector<HTMLInputElement>(
      "#user-turn-font-size-offset",
    );
    const number = screen.getByRole<HTMLInputElement>("spinbutton", {
      name: "User turn size offset",
    });

    expect(slider).toBeTruthy();
    expect(number.value).toBe(String(DEFAULT_USER_TURN_FONT_SIZE_OFFSET_PX));
    act(() => {
      fireEvent.change(number, { target: { value: "2.5" } });
      fireEvent.blur(number);
    });

    expect(localStorage.getItem(UI_KEYS.userTurnFontSizeOffset)).toBe("2.5");
    expect(
      document.documentElement.style.getPropertyValue(
        "--user-turn-font-size-offset",
      ),
    ).toBe("2.5px");
    expect(
      screen.getByText("User turn: paths and terms stay readable."),
    ).toBeDefined();
  });

  it("persists the tooltip offset, restores it on mount, and resets typography", () => {
    const view = renderAppearanceSettings();
    const number = screen.getByRole<HTMLInputElement>("spinbutton", {
      name: "Tooltip size offset",
    });
    expect(number.value).toBe("0");
    expect(
      screen.getByRole("slider", { name: "Tooltip size offset" }),
    ).toBeTruthy();
    expect(
      view.container.querySelector("[data-tooltip-specimen]")?.textContent,
    ).toContain("Themed tooltip");

    fireEvent.change(number, { target: { value: "2.5" } });
    fireEvent.blur(number);
    expect(localStorage.getItem(UI_KEYS.tooltipFontSizeOffset)).toBe("2.5");
    expect(
      document.documentElement.style.getPropertyValue(
        "--tooltip-font-size-offset",
      ),
    ).toBe("2.5px");
    view.unmount();
    renderAppearanceSettings();
    expect(
      screen.getByRole<HTMLInputElement>("spinbutton", {
        name: "Tooltip size offset",
      }).value,
    ).toBe("2.5");

    fireEvent.click(screen.getByRole("button", { name: "Reset typography" }));
    expect(localStorage.getItem(UI_KEYS.tooltipFontSizeOffset)).toBeNull();
    expect(
      document.documentElement.style.getPropertyValue(
        "--tooltip-font-size-offset",
      ),
    ).toBe("0px");
  });

  it("places compact image galleries beside inline media and defaults them on", () => {
    const { container } = renderAppearanceSettings();
    const galleryToggle = screen.getByRole<HTMLInputElement>("checkbox", {
      name: "Compact Multi-Image Galleries",
    });
    const galleryRow = galleryToggle.closest("[data-settings-item]");

    expect(galleryToggle.checked).toBe(true);
    expect(
      galleryRow?.previousElementSibling?.getAttribute("data-settings-item"),
    ).toBe("expand-inline-media-by-default");

    fireEvent.click(galleryToggle);
    expect(galleryToggle.checked).toBe(false);
    expect(localStorage.getItem(UI_KEYS.compactMultiImageGalleries)).toBe(
      "false",
    );
    expect(container.textContent).toContain(
      "It opens automatically when inline media starts expanded",
    );
  });

  it("keeps wider Conversation activity previews default-off in Appearance", () => {
    renderAppearanceSettings();
    const toggle = screen.getByRole<HTMLInputElement>("checkbox", {
      name: "Wider activity previews",
    });

    expect(toggle.checked).toBe(false);
    expect(
      screen.getByText(
        "In Conversation view, move thinking to the right to make room for longer activity previews.",
      ),
    ).toBeTruthy();

    fireEvent.click(toggle);
    expect(toggle.checked).toBe(true);
    expect(
      localStorage.getItem(UI_KEYS.widerConversationActivityPreviews),
    ).toBe("true");
  });

  it("keeps recent basename file links default-off in Appearance", () => {
    renderAppearanceSettings();
    const toggle = screen.getByRole<HTMLInputElement>("checkbox", {
      name: "Link Recent File Basenames",
    });

    expect(toggle.checked).toBe(false);
    expect(
      screen.getByText(
        "Turn a bare filename into a file link when an earlier loaded transcript item linked a full path with the same basename.",
      ),
    ).toBeTruthy();

    fireEvent.click(toggle);
    expect(toggle.checked).toBe(true);
    expect(localStorage.getItem(UI_KEYS.recentProjectPathLinks)).toBe("true");
  });

  it("defaults project code names and their activity pulse off", () => {
    const { container } = renderAppearanceSettings();
    const codeNameRow = screen
      .getByText("Short Project Code Names")
      .closest("[data-settings-item]");
    const activityRow = screen
      .getByText("Show Session Activity in Tab Title")
      .closest("[data-settings-item]");
    const pulseRow = screen
      .getByText("Pulse Project Code for Tab Activity")
      .closest("[data-settings-item]");
    const codeNameToggle = codeNameRow?.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    const activityToggle = activityRow?.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    const pulseToggle = pulseRow?.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    );

    expect(codeNameToggle?.checked).toBe(false);
    expect(activityToggle?.checked).toBe(false);
    expect(pulseToggle?.checked).toBe(false);
    expect(pulseToggle?.disabled).toBe(true);
    expect(container.textContent).toContain(
      "Full project names with ordinary ellipsis are used when this is off.",
    );

    if (!codeNameToggle || !activityToggle || !pulseToggle) {
      throw new Error("Project tab-title preference controls are missing");
    }
    fireEvent.click(codeNameToggle);
    fireEvent.click(activityToggle);
    expect(pulseToggle.disabled).toBe(false);
    fireEvent.click(pulseToggle);

    expect(localStorage.getItem(UI_KEYS.projectCodeNamesEnabled)).toBe("true");
    expect(localStorage.getItem(UI_KEYS.tabTitleActivityEnabled)).toBe("true");
    expect(
      localStorage.getItem(UI_KEYS.projectCodeNameActivityPulseEnabled),
    ).toBe("true");
  });

  it("shows independent selection-action toggles with live specimens", () => {
    renderAppearanceSettings();

    const quoteToggle = screen.getByRole<HTMLInputElement>("checkbox", {
      name: "Quote selected text",
    });
    const textToggle = screen.getByRole<HTMLInputElement>("checkbox", {
      name: "Copy selected text button",
    });
    const sourceToggle = screen.getByRole<HTMLInputElement>("checkbox", {
      name: "Copy selected source",
    });
    const richToggle = screen.getByRole<HTMLInputElement>("checkbox", {
      name: "Copy selected rich text",
    });
    const newSessionToggle = screen.getByRole<HTMLInputElement>("checkbox", {
      name: "New session from selection button",
    });
    const quoteRow = quoteToggle.closest("[data-settings-item]");
    const textRow = textToggle.closest("[data-settings-item]");
    const sourceRow = sourceToggle.closest("[data-settings-item]");
    const richRow = richToggle.closest("[data-settings-item]");
    const newSessionRow = newSessionToggle.closest("[data-settings-item]");

    expect(quoteToggle.checked).toBe(true);
    expect(textToggle.checked).toBe(false);
    expect(sourceToggle.checked).toBe(false);
    expect(richToggle.checked).toBe(false);
    expect(newSessionToggle.checked).toBe(false);
    expect(quoteRow?.previousElementSibling?.textContent).toContain(
      "> Reply Buttons",
    );
    expect(textRow?.previousElementSibling).toBe(quoteRow);
    expect(sourceRow?.previousElementSibling).toBe(textRow);
    expect(richRow?.previousElementSibling).toBe(sourceRow);
    expect(newSessionRow?.previousElementSibling).toBe(richRow);
    expect(
      quoteRow?.querySelector('[data-selection-action-specimen="quote"]')
        ?.textContent,
    ).toBe(">");
    expect(
      textRow
        ?.querySelector('[data-selection-action-specimen="text"]')
        ?.querySelector("svg"),
    ).toBeTruthy();
    expect(
      sourceRow?.querySelector('[data-selection-action-specimen="source"]')
        ?.textContent,
    ).toBe("</>");
    expect(
      richRow?.querySelector('[data-selection-action-specimen="rich"]')
        ?.textContent,
    ).toBe("Aa");
    expect(
      newSessionRow?.querySelector(
        '[data-selection-action-specimen="newSession"]',
      )?.textContent,
    ).toBe("+");

    fireEvent.click(quoteToggle);
    fireEvent.click(textToggle);
    fireEvent.click(sourceToggle);
    fireEvent.click(richToggle);
    fireEvent.click(newSessionToggle);

    expect(localStorage.getItem(UI_KEYS.selectionQuoteActionEnabled)).toBe(
      "false",
    );
    expect(localStorage.getItem(UI_KEYS.selectionTextCopyActionEnabled)).toBe(
      "true",
    );
    expect(localStorage.getItem(UI_KEYS.selectionSourceCopyActionEnabled)).toBe(
      "true",
    );
    expect(localStorage.getItem(UI_KEYS.selectionRichCopyActionEnabled)).toBe(
      "true",
    );
    expect(localStorage.getItem(UI_KEYS.selectionNewSessionActionEnabled)).toBe(
      "true",
    );
  });
});
