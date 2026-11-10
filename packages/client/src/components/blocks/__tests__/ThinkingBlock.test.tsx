import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractMarkdownSnippetsFromSelection } from "../../../lib/markdownSelectionCopy";
import { ThinkingBlock } from "../ThinkingBlock";

function selectElementText(element: Element) {
  const textNode = document
    .createTreeWalker(element, NodeFilter.SHOW_TEXT)
    .nextNode();
  expect(textNode).toBeTruthy();
  const range = document.createRange();
  range.selectNodeContents(textNode as Node);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

describe("ThinkingBlock", () => {
  afterEach(() => {
    cleanup();
    window.getSelection()?.removeAllRanges();
  });

  it("shows a rounded thinking duration", () => {
    render(
      <ThinkingBlock
        thinking="Working through the plan"
        status="complete"
        isExpanded={false}
        onToggle={vi.fn()}
        durationMs={1345.3298}
      />,
    );

    expect(screen.getByText("for 1.3 sec")).toBeDefined();
  });

  it("toggles from the timeline dot button", () => {
    const onToggle = vi.fn();
    render(
      <ThinkingBlock
        thinking="Working through the plan"
        status="complete"
        isExpanded={false}
        onToggle={onToggle}
      />,
    );

    const details = screen
      .getByLabelText("Expand thinking")
      .closest("details") as HTMLDetailsElement | null;
    expect(details).toBeTruthy();
    details!.open = true;
    fireEvent(details!, new Event("toggle"));

    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("keeps the summary toggle visible when collapsed", () => {
    render(
      <ThinkingBlock
        thinking="Working through the plan"
        status="complete"
        isExpanded={false}
        onToggle={vi.fn()}
      />,
    );

    expect(screen.getByText("Thinking")).toBeDefined();
    expect(screen.getByLabelText("Expand thinking")).toBeDefined();
  });

  it("renders heading-style thinking as a collapsible outline", () => {
    const { container } = render(
      <ThinkingBlock
        thinking={[
          "**Considering spacing adjustments**",
          "",
          "Spacing should relate to `font-size`.",
          "```",
          "line-height = 1.5em - delta",
          "```",
          "**Considering implementation**",
          "",
          "Use a line-level transform.",
        ].join("\n")}
        status="complete"
        isExpanded={true}
        onToggle={vi.fn()}
      />,
    );

    expect(screen.getByText("Considering spacing adjustments")).toBeDefined();
    expect(screen.getByText("Considering implementation")).toBeDefined();
    expect(screen.queryByText(/\*\*Considering spacing/)).toBeNull();
    expect(
      container.querySelectorAll("[data-thinking-outline-section]"),
    ).toHaveLength(2);
    expect(
      container.querySelector("[data-thinking-inline-code]")?.textContent,
    ).toBe("font-size");
    expect(
      container.querySelector("[data-thinking-code-block]")?.textContent,
    ).toBe("line-height = 1.5em - delta");
  });

  it("registers expanded thinking text as a quoteable selection source", () => {
    const { container } = render(
      <ThinkingBlock
        thinking={[
          "**Checking instructions**",
          "",
          "Reading `AGENTS.md` before editing.",
        ].join("\n")}
        status="complete"
        isExpanded={true}
        onToggle={vi.fn()}
      />,
    );

    selectElementText(screen.getByText("Checking instructions"));

    expect(extractMarkdownSnippetsFromSelection(container)).toMatchObject([
      {
        markdown: "**Checking instructions**",
        selectedText: "Checking instructions",
      },
    ]);
  });
});
