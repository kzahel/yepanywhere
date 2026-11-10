import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ThinkingText } from "../ThinkingText";

describe("ThinkingText", () => {
  afterEach(() => {
    cleanup();
  });

  it("keeps existing outline sections mounted while streaming new headings", () => {
    const firstText = ["**First step**", "", "Read `AGENTS.md`."].join("\n");
    const { container, rerender } = render(
      <ThinkingText text={firstText} isStreaming={true} />,
    );
    const firstSection = container.querySelector(
      "[data-thinking-outline-section]",
    );

    rerender(
      <ThinkingText
        text={[
          firstText,
          "",
          "**Second step**",
          "",
          "Measure the append path.",
        ].join("\n")}
        isStreaming={true}
      />,
    );

    expect(screen.getByText("Second step")).toBeDefined();
    expect(
      container.querySelector("[data-thinking-inline-code]")?.textContent,
    ).toBe("AGENTS.md");
    expect(container.querySelector("[data-thinking-outline-section]")).toBe(
      firstSection,
    );
  });

  it("omits comment-only placeholder lines from outline bodies", () => {
    const text = [
      "**Planning full-corpus review**",
      "",
      "<!-- -->",
      "**Evaluating chunking strategy**",
      "",
      "<!-- -->",
    ].join("\n");

    const { container } = render(<ThinkingText text={text} />);

    expect(screen.getByText("Planning full-corpus review")).toBeDefined();
    expect(screen.getByText("Evaluating chunking strategy")).toBeDefined();
    expect(
      container.querySelectorAll("[data-thinking-outline-section]"),
    ).toHaveLength(2);
    expect(container.querySelector("[data-thinking-outline-body]")).toBeNull();
    expect(container.textContent).not.toContain("<!-- -->");
  });

  it("omits comment-only placeholder lines from plain thinking text", () => {
    const { container } = render(
      <ThinkingText
        text={["Checking policy", "<!-- -->", "Done"].join("\n")}
      />,
    );

    expect(container.textContent).toBe("Checking policy\nDone");
  });

  it("preserves comment-like lines inside thinking code blocks", () => {
    const text = [
      "**Inspecting markup**",
      "",
      "```html",
      "<!-- real comment -->",
      "```",
    ].join("\n");

    const { container } = render(<ThinkingText text={text} />);

    expect(
      container.querySelector("[data-thinking-code-block]")?.textContent,
    ).toBe("<!-- real comment -->");
  });
});
