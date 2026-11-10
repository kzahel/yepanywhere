// @vitest-environment jsdom

import { act, fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
// The support module installs the i18n mock, so it loads before MessageList.
import {
  assistantMessage,
  installMessageListTestEnvironment,
  userMessage,
} from "./MessageList.test-support";
import { transcriptMarginNavigationSetting } from "../../hooks/useTranscriptMarginNavigation";
import { MessageList } from "../MessageList";

installMessageListTestEnvironment();

const messages = [
  userMessage("user-1", "First prompt"),
  assistantMessage("assistant-1", "First reply"),
  userMessage("user-2", "Second prompt"),
  assistantMessage("assistant-2", "Second reply"),
];

function renderTranscript() {
  const { container } = render(<MessageList messages={messages} />);
  const rows = Array.from(
    container.querySelectorAll<HTMLElement>("[data-message-render-row]"),
  );
  expect(rows.length).toBeGreaterThanOrEqual(3);
  const scrollContainer = rows[0]?.closest(
    "[data-message-list]",
  )?.parentElement;
  if (!scrollContainer) throw new Error("missing transcript scroll container");
  Object.defineProperty(scrollContainer, "scrollTop", {
    configurable: true,
    value: 500,
    writable: true,
  });
  const nextRow = rows[1] as HTMLElement;
  vi.spyOn(nextRow, "getBoundingClientRect").mockReturnValue({
    top: 300,
  } as DOMRect);
  return { rows, scrollContainer };
}

describe("MessageList margin navigation", () => {
  it("leaves row-margin clicks and the browser menu alone by default", () => {
    const { rows, scrollContainer } = renderTranscript();
    const row = rows[0] as HTMLElement;

    expect(fireEvent.click(row, { clientY: 100 })).toBe(true);
    expect(fireEvent.contextMenu(rows[1] as HTMLElement)).toBe(true);
    expect(scrollContainer.scrollTop).toBe(500);
  });

  it("steps to the next row at the same level when opted in", () => {
    act(() => transcriptMarginNavigationSetting.set(true));
    const { rows, scrollContainer } = renderTranscript();

    expect(fireEvent.click(rows[0] as HTMLElement, { clientY: 100 })).toBe(
      false,
    );
    // The next row's top lands 12px above the pointer.
    expect(scrollContainer.scrollTop).toBe(500 + 300 - (100 - 12));
    expect(fireEvent.contextMenu(rows[2] as HTMLElement)).toBe(false);
  });

  it("keeps modified clicks and selection-ending clicks when opted in", () => {
    act(() => transcriptMarginNavigationSetting.set(true));
    const { rows, scrollContainer } = renderTranscript();
    const row = rows[0] as HTMLElement;

    expect(fireEvent.click(row, { clientY: 100, ctrlKey: true })).toBe(true);
    expect(
      fireEvent.contextMenu(rows[1] as HTMLElement, { shiftKey: true }),
    ).toBe(true);

    vi.spyOn(window, "getSelection").mockReturnValue({
      isCollapsed: false,
    } as Selection);
    expect(fireEvent.click(row, { clientY: 100 })).toBe(true);
    expect(scrollContainer.scrollTop).toBe(500);
  });
});
