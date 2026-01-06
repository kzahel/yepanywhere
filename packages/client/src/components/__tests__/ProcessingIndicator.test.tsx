import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProcessingIndicator } from "../ProcessingIndicator";

describe("ProcessingIndicator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Mock localStorage for useFunPhrases hook - disable fun phrases for predictable tests
    vi.stubGlobal("localStorage", {
      getItem: vi.fn().mockReturnValue("false"),
      setItem: vi.fn(),
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("renders nothing when not processing", () => {
    const { container } = render(<ProcessingIndicator isProcessing={false} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders dot and cursor when processing", () => {
    render(<ProcessingIndicator isProcessing={true} />);

    const cursor = document.querySelector(".processing-cursor");
    expect(cursor).not.toBeNull();
    expect(cursor?.textContent).toBe("|");

    // ThinkingIndicator uses .thinking-indicator-dot class
    const dot = document.querySelector(".thinking-indicator-dot");
    expect(dot).not.toBeNull();
  });

  it("types text progressively over time", async () => {
    render(<ProcessingIndicator isProcessing={true} />);

    const textElement = document.querySelector(".processing-text");

    // Initially just cursor
    expect(textElement?.textContent).toBe("|");

    // Advance enough time to type several characters (500ms = 20 chars worth)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    // Should have typed some text (starts with T from "Thinking...")
    const content = textElement?.textContent ?? "";
    expect(content).toMatch(/^T/); // Starts with T
    expect(content.length).toBeGreaterThan(1); // Has typed something
  });

  it("has processing indicator container", () => {
    render(<ProcessingIndicator isProcessing={true} />);

    const container = document.querySelector(".processing-indicator");
    expect(container).not.toBeNull();

    const dotContainer = document.querySelector(".processing-dot-container");
    expect(dotContainer).not.toBeNull();
  });

  it("hides when processing stops", async () => {
    const { rerender } = render(<ProcessingIndicator isProcessing={true} />);

    // Verify it's visible
    expect(document.querySelector(".processing-indicator")).not.toBeNull();

    // Stop processing
    rerender(<ProcessingIndicator isProcessing={false} />);

    // Should render nothing
    expect(document.querySelector(".processing-indicator")).toBeNull();
  });

  it("restarts when re-enabled after stopping", async () => {
    const { rerender } = render(<ProcessingIndicator isProcessing={true} />);

    // Advance some time
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    // Stop processing
    rerender(<ProcessingIndicator isProcessing={false} />);
    expect(document.querySelector(".processing-indicator")).toBeNull();

    // Start processing again
    rerender(<ProcessingIndicator isProcessing={true} />);

    // Should be visible again with cursor
    expect(document.querySelector(".processing-indicator")).not.toBeNull();
    expect(document.querySelector(".processing-cursor")).not.toBeNull();
  });
});
