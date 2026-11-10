import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UI_KEYS } from "../../../../lib/storageKeys";
import { recordFromLegacyArgs } from "../prepareDisplay";
import { writeRenderer } from "../WriteRenderer";

vi.mock("../../../../contexts/SchemaValidationContext", () => ({
  useSchemaValidationContext: () => ({
    enabled: false,
    reportValidationError: vi.fn(),
    isToolIgnored: vi.fn(() => false),
  }),
}));

const renderContext = {
  isStreaming: false,
  theme: "dark" as const,
};

describe("WriteRenderer", () => {
  beforeEach(() => {
    window.localStorage.setItem(UI_KEYS.tooltipMode, "themed");
  });

  afterEach(() => {
    cleanup();
    window.localStorage.removeItem(UI_KEYS.tooltipMode);
  });

  it("reveals the omitted tail from a faded Write preview", () => {
    const content = ["line 1", "line 2", "line 3", "line 4", "line 5"].join(
      "\n",
    );
    const { container } = render(
      <div>
        {writeRenderer
          .prepare(
            recordFromLegacyArgs(
              { file_path: "notes.txt", content },
              undefined,
              false,
            ),
          )
          .renderCollapsedPreview(renderContext)}
      </div>,
    );

    const fadedPreview = container.querySelector(
      "[data-write-preview-content]",
    );
    expect(fadedPreview?.getAttribute("data-tooltip")).toBe(
      "...\nline 3\nline 4\nline 5",
    );
    expect(fadedPreview?.getAttribute("title")).toBeNull();
  });

  it("shows full unfaded file content when its preview is off-screen", () => {
    const content = "one short line";
    const { container } = render(
      <div>
        {writeRenderer
          .prepare(
            recordFromLegacyArgs(
              { file_path: "notes.txt", content },
              undefined,
              false,
            ),
          )
          .renderCollapsedPreview(renderContext)}
      </div>,
    );

    const preview = container.querySelector<HTMLElement>(
      "[data-write-preview-content]",
    );
    expect(preview).toBeTruthy();
    expect(preview?.hasAttribute("data-write-preview-truncated")).toBe(false);
    Object.defineProperties(preview, {
      clientWidth: { configurable: true, value: 300 },
      clientHeight: { configurable: true, value: 20 },
      scrollWidth: { configurable: true, value: 300 },
      scrollHeight: { configurable: true, value: 20 },
      getBoundingClientRect: {
        configurable: true,
        value: () => ({
          x: 0,
          y: window.innerHeight - 10,
          left: 0,
          top: window.innerHeight - 10,
          right: 300,
          bottom: window.innerHeight + 10,
          width: 300,
          height: 20,
          toJSON: () => ({}),
        }),
      },
    });

    fireEvent.pointerEnter(preview as HTMLElement);

    expect(preview?.getAttribute("data-tooltip")).toBe(content);
    expect(preview?.getAttribute("title")).toBeNull();
  });

  it("shows a rejected Write's own message in its collapsed row", () => {
    const { container } = render(
      <div>
        {writeRenderer
          .prepare(
            recordFromLegacyArgs(
              { file_path: "notes.txt", content: "text" },
              "EACCES: permission denied",
              true,
              "error",
            ),
          )
          .renderCollapsedPreview(renderContext)}
      </div>,
    );

    expect(
      container.querySelector("[data-write-preview-error]")?.textContent,
    ).toBe("EACCES: permission denied");
  });

  it("names a failed Write generically when no rejection arrived", () => {
    const { container } = render(
      <div>
        {writeRenderer
          .prepare(
            recordFromLegacyArgs(
              { file_path: "notes.txt", content: "text" },
              undefined,
              true,
              "error",
            ),
          )
          .renderCollapsedPreview(renderContext)}
      </div>,
    );

    expect(
      container.querySelector("[data-write-preview-error]")?.textContent,
    ).toBe("Failed to write file");
  });
});
