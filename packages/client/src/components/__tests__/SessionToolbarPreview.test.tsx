// @vitest-environment jsdom

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { ToolbarControlPreview } from "../SessionToolbarPreview";

function renderControl(
  controlKey: Parameters<typeof ToolbarControlPreview>[0]["controlKey"],
) {
  return render(
    <I18nProvider>
      <ToolbarControlPreview controlKey={controlKey} />
    </I18nProvider>,
  );
}

describe("ToolbarControlPreview", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders the Project Queue specimen without the primary send button", () => {
    const { container } = renderControl("projectQueue");

    expect(container.querySelector("[data-project-queue-button]")).toBeTruthy();
    expect(
      container.querySelector("[data-project-queue-new-session-button]"),
    ).toBeNull();
    expect(container.querySelector(".send-button-with-help")).toBeNull();
  });

  it("renders the new-session Project Queue shortcut as its own specimen", () => {
    const { container } = renderControl("projectQueueNewSessionShortcut");

    expect(
      container.querySelector("[data-project-queue-new-session-button]"),
    ).toBeTruthy();
    expect(container.textContent).toContain("+");
    expect(container.querySelector(".send-button-with-help")).toBeNull();
  });

  it("renders the Now specimen without the primary send button", () => {
    const { container } = renderControl("steerNow");

    expect(container.querySelector("[data-steer-now-toggle]")).toBeTruthy();
    expect(container.querySelector(".send-button-with-help")).toBeNull();
  });

  it("renders the Conversation view specimen as active", () => {
    const { container } = renderControl("conversationView");

    const button = container.querySelector(
      "[data-conversation-view-toolbar-button]",
    );
    expect(button).toBeTruthy();
    expect(button?.getAttribute("aria-pressed")).toBe("true");
  });

  it("shows a static waveform and its default button opacity", () => {
    const context = {
      beginPath: vi.fn(),
      clearRect: vi.fn(),
      closePath: vi.fn(),
      fill: vi.fn(),
      fillStyle: "",
      lineTo: vi.fn(),
      moveTo: vi.fn(),
      setTransform: vi.fn(),
    } as unknown as CanvasRenderingContext2D;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      context,
    );

    const { container } = renderControl("waveform");

    expect(
      container.querySelector(".composer-speech-waveform canvas"),
    ).toBeTruthy();
    expect(
      container
        .querySelector("[data-message-input-toolbar]")
        ?.getAttribute("data-waveform-button-background-opacity"),
    ).toBe("70");
  });

  it("activates an editable specimen by pointer and keyboard", () => {
    const onActivate = vi.fn();
    const { getByRole } = render(
      <I18nProvider>
        <ToolbarControlPreview
          activationLabel="Edit Mode Selector"
          controlKey="modeSelector"
          onActivate={onActivate}
        />
      </I18nProvider>,
    );

    const specimen = getByRole("button", { name: "Edit Mode Selector" });
    fireEvent.click(specimen);
    fireEvent.keyDown(specimen, { key: "Enter" });
    fireEvent.keyDown(specimen, { key: " " });
    fireEvent.keyDown(specimen, { key: "Escape" });

    expect(onActivate).toHaveBeenCalledTimes(3);
  });
});
