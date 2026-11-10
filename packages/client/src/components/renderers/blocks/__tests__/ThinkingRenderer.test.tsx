import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ContentBlockRenderer } from "../../ContentBlockRenderer";

describe("ThinkingRenderer", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders provider reasoning blocks as toggleable thinking", () => {
    const { container } = render(
      <ContentBlockRenderer
        block={{
          type: "reasoning",
          summary: [
            {
              type: "summary_text",
              text: "Checking the provider reasoning alias",
            },
          ],
        }}
        context={{ isStreaming: false, theme: "dark" }}
      />,
    );

    expect(screen.getByRole("button", { name: /Thinking/i })).toBeDefined();
    expect(container.querySelector("[data-fallback-block]")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Thinking/i }));

    expect(
      screen.getByText("Checking the provider reasoning alias"),
    ).toBeDefined();
  });

  it("uses the thinking outline for standalone bold heading lines", () => {
    const { container } = render(
      <ContentBlockRenderer
        block={{
          type: "reasoning",
          summary: [
            {
              type: "summary_text",
              text: [
                "**Checking instructions**",
                "",
                "Reading `AGENTS.md` before editing.",
              ].join("\n"),
            },
          ],
        }}
        context={{ isStreaming: false, theme: "dark" }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Thinking/i }));

    expect(screen.getByText("Checking instructions")).toBeDefined();
    expect(
      container.querySelector("[data-thinking-inline-code]")?.textContent,
    ).toBe("AGENTS.md");
    expect(screen.queryByText(/\*\*Checking instructions/)).toBeNull();
  });
});
